#!/usr/bin/env python3
"""
豆包视频水印去除 - OpenCV inpainting方案
使用cv2.inpaint()进行智能像素重建，保留音频
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

    # 创建临时输出视频（无音频）- 使用唯一文件名
    temp_suffix = str(int(time.time() * 1000))
    temp_output = f"{os.path.dirname(input_path)}/temp_inpaint_{temp_suffix}.mp4"

    # 使用MPEG4编码确保浏览器兼容性
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
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # 使用inpainting修复水印区域
        result = cv2.inpaint(frame, mask, inpaintRadius=3, flags=cv2.INPAINT_TELEA)

        out.write(result)
        processed += 1

        # 每50帧或每10秒输出一次进度
        now = time.time()
        if processed % 50 == 0 or (now - last_log_time) >= 10:
            elapsed = now - start_time
            fps_process = processed / elapsed if elapsed > 0 else 0
            eta = (frame_count - processed) / fps_process if fps_process > 0 else 0
            log(f'已处理 {processed}/{frame_count} 帧 ({processed*100//frame_count}%), 速度:{fps_process:.1f}fps, 预计剩余:{eta:.0f}s')
            last_log_time = now

    # 释放资源
    cap.release()
    out.release()

    log(f'✓ 视频帧处理完成: {processed}帧')

    # 检查原始视频是否有音频
    ffmpeg = get_ffmpeg_path()
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
        log('无可用FFmpeg，跳过音频探测（按无音频分支走 H.264 转码）')

    if has_audio_stream:
        log('检测到音频流，正在合并音频...')
        # 提取音频 - 使用唯一文件名
        audio_temp = f"{os.path.dirname(input_path)}/temp_audio_{temp_suffix}.aac"
        subprocess.run(
            [ffmpeg, '-y', '-i', input_path, '-vn', '-acodec', 'copy', audio_temp],
            capture_output=True,
            timeout=30
        )

        # 合并视频和音频，并使用faststart将moov移到文件开头以支持流式播放
        log('合并视频和音频，优化moov位置...')
        result = subprocess.run(
            [ffmpeg, '-y', '-i', temp_output, '-i', audio_temp, 
             '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
             '-movflags', '+faststart', '-c:a', 'copy', output_path],
            capture_output=True,
            timeout=120
        )
        
        if result.returncode != 0:
            log(f'合并失败: {result.stderr[-300:] if result.stderr else "unknown error"}')
            # 清理临时文件
            for tmp_file in [temp_output, audio_temp]:
                try:
                    if os.path.exists(tmp_file):
                        os.unlink(tmp_file)
                except:
                    pass
            return False

        # 验证输出文件存在且足够大
        if not os.path.exists(output_path):
            log('错误: 输出文件不存在')
            # 清理临时文件
            for tmp_file in [temp_output, audio_temp]:
                try:
                    if os.path.exists(tmp_file):
                        os.unlink(tmp_file)
                except:
                    pass
            return False
        
        file_size = os.path.getsize(output_path)
        if file_size < 100000:
            log(f'警告: 输出文件过小 ({file_size} bytes)，可能合并失败')
            # 清理临时文件
            for tmp_file in [temp_output, audio_temp]:
                try:
                    if os.path.exists(tmp_file):
                        os.unlink(tmp_file)
                except:
                    pass
            return False
        
        log(f'  文件大小: {file_size} bytes')
        
        # 清理临时文件（最后清理）
        for tmp_file in [temp_output, audio_temp]:
            try:
                if os.path.exists(tmp_file):
                    os.unlink(tmp_file)
            except Exception as e:
                log(f'清理临时文件警告: {e}')

        log(f'✓ 处理完成（含音频）: {output_path}')
    else:
        # 无音频分支必须重新编码。
        # OpenCV 的 VideoWriter 用的是 mp4v（MPEG-4 Part 2），浏览器 canPlayType
        # 直接返回空——Chrome 播这类文件就是一片黑，没有任何报错，
        # 正是"处理完了却没画面"的典型来源。统一转成 H.264/yuv420p。
        log('未检测到音频流，OpenCV 原始输出为 mp4v 编码，转码为 H.264 以保证浏览器可播...')
        ffmpeg = get_ffmpeg_path()
        transcode_ok = False
        if ffmpeg:
            try:
                result = subprocess.run(
                    [ffmpeg, '-y', '-i', temp_output,
                     '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                     '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                     output_path],
                    capture_output=True, text=True, timeout=180
                )
                if result.returncode == 0 and os.path.exists(output_path):
                    transcode_ok = True
                else:
                    log(f'无音频分支转码失败: {(result.stderr or "")[-300:]}')
            except Exception as e:
                log(f'无音频分支转码异常: {e}')

        if not transcode_ok:
            # 兜底：ffmpeg 不可用时至少把 inpainted 帧交出去（本地播放器多半能看，浏览器可能黑屏）
            log('警告: 无法转码，将直接输出 mp4v 文件（浏览器可能无法播放）')
            for p in (output_path,):
                if os.path.exists(p):
                    os.unlink(p)
            if os.path.exists(temp_output):
                os.rename(temp_output, output_path)

        if not os.path.exists(output_path):
            log('错误: 输出文件不存在（无音频分支）')
            return False

        # 阈值按原始体积给，避免短视频（几秒）被 100KB 的固定阈值误杀
        try:
            input_size = os.path.getsize(input_path)
        except Exception:
            input_size = 0
        min_size = max(10000, min(100000, int(input_size * 0.05)))

        file_size = os.path.getsize(output_path)
        if file_size < min_size:
            log(f'错误: 输出文件过小 ({file_size} bytes < {min_size})，无音频分支处理失败')
            _cleanup_stale_temp(os.path.dirname(input_path))
            return False

        log(f'✓ 处理完成（无音频）: {output_path}')
        log(f'  文件大小: {file_size} bytes')

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
