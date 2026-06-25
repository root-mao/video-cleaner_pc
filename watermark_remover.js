const fs = require('fs');
const { spawn } = require('child_process');

function log(msg) {
    console.log(`[水印处理] ${msg}`);
}

function isFfmpegAvailable(ffmpegPath) {
    if (!ffmpegPath) return false;
    if (fs.existsSync(ffmpegPath)) return true;
    if (!ffmpegPath.includes('/') && !ffmpegPath.includes('\\') && !ffmpegPath.includes('.')) {
        return true;
    }
    return false;
}

function spawnAsync(programPath, args, timeout = 600000) {
    return new Promise((resolve, reject) => {
        let stderrData = '';
        let stdoutData = '';

        const child = spawn(programPath, args, {
            windowsHide: true
        });

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('Timeout'));
        }, timeout);

        child.stdout.on('data', (data) => {
            stdoutData += data.toString('utf8');
        });

        child.stderr.on('data', (data) => {
            stderrData += data.toString('utf8');
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            const combined = stdoutData + stderrData;
            if (code === 0) {
                resolve({ stdout: combined, stderr: stderrData });
            } else {
                const err = new Error(`Exit code ${code}`);
                err.stderr = stderrData;
                err.stdout = combined;
                reject(err);
            }
        });
    });
}

async function removeWatermark(inputPath, ffmpegPath, platform = 'general') {
    try {
        log(`开始处理 (平台: ${platform})...`);

        ffmpegPath = ffmpegPath.replace(/^"|"$/g, '');

        if (!isFfmpegAvailable(ffmpegPath)) {
            log('FFmpeg不可用: ' + ffmpegPath);
            return { success: true, skipped: true };
        }

        // 获取视频信息
        let videoInfo = '';
        try {
            const info = await spawnAsync(ffmpegPath, ['-i', inputPath, '-hide_banner']);
            videoInfo = info.stdout;
        } catch (e) {
            videoInfo = (e.stdout || '') + (e.stderr || '');
        }

        const sizeMatch = videoInfo.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
        if (!sizeMatch) {
            log('无法获取视频尺寸');
            return { success: true, skipped: true };
        }

        const width = parseInt(sizeMatch[1]);
        const height = parseInt(sizeMatch[2]);
        log(`视频尺寸: ${width}x${height}`);

        // 计算logo位置（仅右上角，不再处理底部）
        let logoW, logoH, logoX, logoY;

        if (platform === 'bilibili' || platform === 'B站') {
            logoW = Math.min(Math.floor(width * 0.15), 200) + 37;
            logoH = Math.min(Math.floor(height * 0.12), 110);
            logoX = width - logoW;
            logoY = 0;
            log(`B站: 右上角logo位置 (${logoX},${logoY}) 尺寸 ${logoW}x${logoH} (向左扩展1cm)`);
        } else if (platform === 'douyin' || platform === '抖音') {
            logoW = Math.min(Math.floor(width * 0.12), 100);
            logoH = logoW;
            logoX = width - logoW - 10;
            logoY = Math.floor(height * 0.55);
            log(`抖音: 右侧logo位置 (${logoX},${logoY}) 尺寸 ${logoW}x${logoH}`);
        } else if (platform === 'kuaishou' || platform === '快手') {
            logoW = Math.min(Math.floor(width * 0.12), 100);
            logoH = logoW;
            logoX = width - logoW - 10;
            logoY = height - logoH - 60;
            log(`快手: 右下角logo位置 (${logoX},${logoY}) 尺寸 ${logoW}x${logoH}`);
        } else if (platform === 'doubao' || platform === '豆包') {
            // 豆包平台：水印通常在视频右下角，尝试去除
            logoW = Math.min(Math.floor(width * 0.15), 180);
            logoH = Math.min(Math.floor(height * 0.12), 100);
            logoX = width - logoW;
            logoY = height - logoH - 20;
            log(`豆包: 右下角logo位置 (${logoX},${logoY}) 尺寸 ${logoW}x${logoH}`);
        } else {
            log('通用平台: 无特殊水印处理');
            return { success: true, skipped: true };
        }

        const outputPath = inputPath.replace(/\.mp4$/, '_wm.mp4');

        // 使用 boxblur 模糊处理：
        // 1. split 分离视频流
        // 2. crop 切出右上角logo区域
        // 3. boxblur 对该区域做模糊
        // 4. overlay 把模糊后的区域覆盖回原位置
        const filterComplex = `[0:v]split=2[v1][v2];[v2]crop=${logoW}:${logoH}:${logoX}:${logoY},boxblur=10:1[blur];[v1][blur]overlay=${logoX}:${logoY}[v]`;
        log(`滤镜: split/crop/boxblur/overlay (模糊右上角 ${logoW}x${logoH})`);

        const args = [
            '-i', inputPath,
            '-filter_complex', filterComplex,
            '-map', '[v]',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'copy',
            '-y', outputPath
        ];

        log(`执行FFmpeg...`);

        try {
            await spawnAsync(ffmpegPath, args, 600000);

            if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100000) {
                fs.unlinkSync(inputPath);
                fs.renameSync(outputPath, inputPath);
                log(`✓ 处理完成（右上角模糊）`);
                return { success: true, removed: true };
            } else {
                log('✗ 输出文件无效');
                return { success: true, skipped: true };
            }
        } catch (e) {
            log(`✗ FFmpeg失败: ${e.message}`);
            if (e.stderr) {
                log(`stderr: ${e.stderr.substring(0, 400)}`);
            }
            return { success: true, skipped: true };
        }

    } catch (e) {
        log(`异常: ${e.message}`);
        return { success: true, skipped: true };
    }
}

module.exports = { removeWatermark };
