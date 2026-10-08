#!/usr/bin/env python3
"""
豆包视频水印去除 - OpenCV inpainting方案
使用cv2.inpaint()进行智能像素重建，保留音频。
画质策略：分辨率严格等于原视频（不缩放）；仅编码一次（OpenCV 逐帧 inpaint 后由
ffmpeg 管道单遍高质量编码 H.264，crf=18 近视觉无损），不再做二次压缩；合并音频时
视频以 -c:v copy 原样拷贝，最大限度保留原片清晰度。
"""

import sys
import os
import platform
import cv2
import numpy as np
import subprocess
import time

def log(msg):
    print(f"[inpainting] {msg}", flush=True)

FFMPEG_PROBE_TIMEOUT = 10  # 秒
# 主二进制 tools\ffmpeg.exe 曾被应用控制策略(AppLocker/WDAC)封禁(WinError 4551)，
# 所以必须逐个「真跑一遍」来判定，光看文件存在会被骗。
# 注意超时不能太短：Windows 上首次冷启动一个几十 MB 的 exe 可能要数秒，
# 旧代码用 2 秒，直接把所有候选都误判成不可用，进而一路走到"没有可用 FFmpeg"。
# 平台区分：Windows 优先项目内置/镜像里的 exe；Linux 优先系统 PATH 里的 ffmpeg。
if platform.system() == 'Windows':
    FFMPEG_CANDIDATES = [
        'ffmpeg',
        os.path.join(os.path.dirname(__file__), 'tools', 'ffmpeg.exe'),
        os.path.join(os.path.dirname(__file__), 'tools', 'ffmpeg_alt.exe'),
        r'D:/app/Python313/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe',
    ]
else:
    # Linux / macOS：系统包管理的 ffmpeg（Docker 镜像里已 apt install ffmpeg）
    FFMPEG_CANDIDATES = [
        'ffmpeg',
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        os.path.join(os.path.dirname(__file__), 'tools', 'ffmpeg'),
    ]


def get_ffmpeg_path():
    """查找真正可执行的ffmpeg路径"""
    for path in FFMPEG_CANDIDATES:
        try:
            result = subprocess.run(
                [path, '-version'],
                capture_output=True,
                timeout=FFMPEG_PROBE_TIMEOUT
            )
            if result.returncode == 0 and b'ffmpeg version' in (
                result.stdout or b''
            ) + (result.stderr or b''):
                log(f'使用FFmpeg: {path}')
                return path
        except Exception:
            continue
    log('警告: 没有可用的FFmpeg（所有候选均无法执行），将跳过音频合并/重编码')
    return None

def _cleanup_stale_temp(dir_path):
    """清理上一次被中断（超时 kill）残留的 temp_inpaint_*/temp_audio_*"""
    try:
        if not dir_path or not os.path.isdir(dir_path):
            return
        for name in os.listdir(dir_path):
            if name.startswith('temp_inpaint_') or name.startswith('temp_audio_'):
                try:
                    os.unlink(os.path.join(dir_path, name))
                    log(f'清理残留临时文件: {name}')
                except Exception:
                    pass
    except Exception:
        pass


def remove_watermark_inpaint(input_path, output_path, platform='doubao'):
    """
    使用OpenCV inpainting去除水印，保留音频
    """
    log(f'开始处理: {input_path}')
    log(f'平台: {platform}')

    # 清理上一次被中断留下的临时文件，避免旧半成品被误当成本次结果
    _cleanup_stale_temp(os.path.dirname(input_path))

    # 读取视频
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        log('错误: 无法打开视频文件')
        return False

    # 获取视频信息
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    log(f'视频信息: {width}x{height}, {fps:.1f}fps, {frame_count}帧')

    # 计算水印区域坐标（可能有多处）
    watermark_regions = calculate_watermark_coords(width, height, platform)
    log(f'水印区域: {watermark_regions}')

    # 创建掩码（水印区域为白色，其余为黑色）
    mask = np.zeros((height, width), dtype=np.uint8)
    for region in watermark_regions:
        logo_w, logo_h, logo_x, logo_y = region
        # 确保坐标在视频范围内
        logo_x = max(0, min(logo_x, width - logo_w))
        logo_y = max(0, min(logo_y, height - logo_h))
        mask[logo_y:logo_y+logo_h, logo_x:logo_x+logo_w] = 255
        log(f'  添加水印区域: ({logo_x},{logo_y}) {logo_w}x{logo_h}')

    # 临时文件名
    temp_suffix = str(int(time.time() * 1000))
    temp_output = f"{os.path.dirname(input_path)}/temp_inpaint_{temp_suffix}.mp4"
    audio_temp = f"{os.path.dirname(input_path)}/temp_audio_{temp_suffix}.aac"

    # 优先用 ffmpeg 管道做「单遍高质量编码」：OpenCV 只负责 inpaint，不负责编码，
    # 避免旧方案先写 mp4v 再用 H.264 二次重编码造成的画质折损。
    # 画质策略：分辨率严格等于原视频（不缩放）；crf=18 近视觉无损；仅编码一次。
    ffmpeg = get_ffmpeg_path()
    use_pipe = ffmpeg is not None
    ffmpeg_proc = None
    out = None

    if use_pipe:
        # rawvideo 管道 -> H.264（分辨率=原视频，crf 18 近视觉无损，单遍编码）
        cmd = [
            ffmpeg, '-y',
            '-f', 'rawvideo', '-pix_fmt', 'bgr24',
            '-s', f'{width}x{height}', '-r', f'{fps:.3f}',
            '-i', '-',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
            '-pix_fmt', 'yuv420p', '-threads', '0',
            '-movflags', '+faststart', temp_output
        ]
        log(f'FFmpeg 单遍编码: {" ".join(cmd)}')
        ffmpeg_proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    else:
        # 兜底：没有 ffmpeg 时退回 OpenCV 自带 mp4v 编码（保留原行为）
        log('警告: 没有可用FFmpeg，退回 OpenCV mp4v 编码（浏览器可能黑屏）')
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(temp_output, fourcc, fps, (width, height))
        if not out.isOpened():
            log('错误: 无法创建输出视频')
            cap.release()
            return False

    # 处理每一帧
    processed = 0
    last_log_time = time.time()
    start_time = time.time()  # 记录开始时间用于计算ETA
    pipe_broken = False
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # 使用inpainting修复水印区域（分辨率不变，仅重建水印像素）
        result = cv2.inpaint(frame, mask, inpaintRadius=3, flags=cv2.INPAINT_TELEA)

        if use_pipe:
            try:
                ffmpeg_proc.stdin.write(result.tobytes())
            except (BrokenPipeError, ValueError, OSError) as e:
                pipe_broken = True
                log(f'管道写入失败（ffmpeg 可能已崩溃）: {e}')
                break
        else:
            out.write(result)
        processed += 1

        # 每50帧或每10秒输出一次进度
        now = time.time()
        if processed % 50 == 0 or (now - last_log_time) >= 10:
            elapsed = now - start_time
            fps_process = processed / elapsed if elapsed > 0 else 0
            eta = (frame_count - processed) / fps_process if (fps_process > 0 and frame_count > 0) else 0
            pct = (processed * 100 // frame_count) if frame_count > 0 else 0
            log(f'已处理 {processed}/{frame_count} 帧 ({pct}%), 速度:{fps_process:.1f}fps, 预计剩余:{eta:.0f}s')
            last_log_time = now

    # 释放资源
    cap.release()
    if use_pipe:
        try:
            ffmpeg_proc.stdin.close()
        except Exception:
            pass
        try:
            rc = ffmpeg_proc.wait(timeout=180)
        except Exception as e:
            log(f'等待 ffmpeg 编码结束异常: {e}')
            rc = -1
        if rc != 0 or not os.path.exists(temp_output) or os.path.getsize(temp_output) < 1000:
            log(f'错误: ffmpeg 单遍编码失败 (returncode={rc})')
            if os.path.exists(temp_output):
                os.unlink(temp_output)
            return False
        log(f'✓ 视频帧处理+编码完成: {processed}帧')
    else:
        out.release()
        if not os.path.exists(temp_output):
            log('错误: 输出文件不存在')
            return False
        log(f'✓ 视频帧处理完成: {processed}帧')

    # 检查原始视频是否有音频（ffmpeg 已在前面取得，若没有则按无音频处理）
    has_audio_stream = False
    if ffmpeg:
        try:
            probe_result = subprocess.run(
                [ffmpeg, '-i', input_path],
                capture_output=True,
                text=True,
                timeout=15
            )
            has_audio_stream = 'Audio' in (probe_result.stderr or '')
        except Exception as e:
            log(f'探测音频流失败，按无音频处理: {e}')
    else:
        log('无可用FFmpeg，跳过音频探测（按无音频分支）')

    if has_audio_stream:
        log('检测到音频流，正在合并音频（视频不重编码，保留画质）...')
        try:
            ar = subprocess.run(
                [ffmpeg, '-y', '-i', input_path, '-vn', '-acodec', 'copy', audio_temp],
                capture_output=True, timeout=30
            )
            if ar.returncode != 0 or not os.path.exists(audio_temp):
                log('提取音频失败，将输出无音频版本')
                has_audio_stream = False
        except Exception as e:
            log(f'提取音频异常: {e}')
            has_audio_stream = False

    if has_audio_stream and os.path.exists(audio_temp):
        # 视频已在前面高质量编码好，这里 -c:v copy 不重编码，音频原样拷贝，最大限度保真
        result = subprocess.run(
            [ffmpeg, '-y', '-i', temp_output, '-i', audio_temp,
             '-c:v', 'copy', '-c:a', 'copy',
             '-movflags', '+faststart', output_path],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0 or not os.path.exists(output_path):
            log(f'合并失败: {result.stderr[-300:] if result.stderr else "unknown error"}')
            for tmp_file in [temp_output, audio_temp]:
                try:
                    if os.path.exists(tmp_file):
                        os.unlink(tmp_file)
                except Exception:
                    pass
            return False
        for tmp_file in [temp_output, audio_temp]:
            try:
                if os.path.exists(tmp_file):
                    os.unlink(tmp_file)
            except Exception as e:
                log(f'清理临时文件警告: {e}')
        log(f'✓ 处理完成（含音频，画质保留）: {output_path}')
    else:
        # 无音频：temp_output 已是 H.264，直接重命名即可；
        # 若走到 OpenCV mp4v 兜底（没有 ffmpeg），再补一次 H.264 转码保证浏览器可播。
        if os.path.exists(output_path):
            os.unlink(output_path)
        os.rename(temp_output, output_path)
        if not use_pipe:
            ffmpeg2 = get_ffmpeg_path()
            if ffmpeg2:
                try:
                    tr = subprocess.run(
                        [ffmpeg2, '-y', '-i', output_path,
                         '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
                         '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                         f'{output_path}.h264.mp4'],
                        capture_output=True, text=True, timeout=180
                    )
                    if tr.returncode == 0 and os.path.exists(f'{output_path}.h264.mp4'):
                        os.replace(f'{output_path}.h264.mp4', output_path)
                        log('已将 mp4v 兜底输出转码为 H.264')
                    else:
                        log(f'无音频兜底转码失败: {(tr.stderr or "")[-200:]}')
                except Exception as e:
                    log(f'无音频兜底转码异常: {e}')
        log(f'✓ 处理完成（无音频）: {output_path}')

    # 文件大小校验（阈值按原始体积给，避免短视频被固定阈值误杀）
    try:
        input_size = os.path.getsize(input_path)
    except Exception:
        input_size = 0
    min_size = max(10000, min(100000, int(input_size * 0.05)))
    if os.path.exists(output_path):
        file_size = os.path.getsize(output_path)
        log(f'  输出文件大小: {file_size} bytes（原视频: {input_size} bytes）')
        if file_size < min_size:
            log(f'错误: 输出文件过小 ({file_size} bytes < {min_size})，处理失败')
            return False
    else:
        log('错误: 输出文件不存在')
        return False

    return True

def calculate_watermark_coords(width, height, platform):
    """
    根据平台和视频尺寸计算水印区域坐标
    返回多个水印区域的列表
    """
    regions = []

    if platform == 'doubao' or platform == '豆包':
        # 豆包水印可能在右下角和左上角
        # 右下角水印
        logo_w = min(int(width * 0.30), 220)
        logo_h = min(int(height * 0.09), 120)
        logo_x = max(width - logo_w - 10, 10)
        logo_y = max(height - logo_h - 30, 30)
        regions.append((logo_w, logo_h, logo_x, logo_y))

        # 左上角水印（如果有）
        logo_x2 = 10
        logo_y2 = 10
        regions.append((logo_w, logo_h, logo_x2, logo_y2))

    elif platform == 'bilibili' or platform == 'B站':
        # B站水印位置根据视频宽高比自动判断：
        # - 超宽屏(宽高比>2.0): 水印在右上角
        # - 标准宽高比(<=2.0): 水印在左上角
        # 为保险起见，始终同时处理两个可能的位置
        logo_w = min(int(width * 0.20), 180)
        logo_h = min(int(height * 0.08), 60)

        # 左上角水印
        regions.append((logo_w, logo_h, 5, 5))

        # 右上角水印（始终处理，避免漏掉）
        regions.append((logo_w, logo_h, max(width - logo_w - 5, 5), 5))

    else:
        # 默认使用豆包坐标
        logo_w = min(int(width * 0.30), 220)
        logo_h = min(int(height * 0.09), 120)
        logo_x = max(width - logo_w - 10, 10)
        logo_y = max(height - logo_h - 30, 30)
        regions.append((logo_w, logo_h, logo_x, logo_y))

        # 左上角水印
        regions.append((logo_w, logo_h, 10, 10))

    return regions

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('用法: python inpaint_watermark.py <输入视频> <输出视频> [平台]')
        print('示例: python inpaint_watermark.py input.mp4 output.mp4 doubao')
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    platform = sys.argv[3] if len(sys.argv) > 3 else 'doubao'

    if not os.path.exists(input_path):
        log(f'错误: 文件不存在 {input_path}')
        sys.exit(1)

    success = remove_watermark_inpaint(input_path, output_path, platform)
    sys.exit(0 if success else 1)
