// Version check: 1790857334112
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function log(msg) {
    console.log(`[水印处理] ${msg}`);
}

// ---------------- 跨平台「可执行文件」探测 ----------------
// Windows 上 fs.existsSync('python3') 永远为 false（被当相对路径），
// Linux/macOS 上 fs.existsSync 对裸命令名同样无效。这里统一处理：
// - 显式路径（含 / \\ 或盘符）用 fs.existsSync 判断
// - 裸命令名（python3 / ffmpeg / chromium）在 Windows 用 where、在 POSIX 用 command -v 查 PATH
function isExplicitPath(s) {
    return /[\\/]/.test(s) || /^[A-Za-z]:/.test(s);
}
function commandExists(name) {
    if (process.platform === 'win32') {
        try {
            const r = require('child_process').spawnSync('where', [name], { windowsHide: true, timeout: 5000 });
            return r.status === 0;
        } catch (e) { return false; }
    }
    try {
        const r = require('child_process').spawnSync('command', ['-v', name], { timeout: 5000 });
        return r.status === 0;
    } catch (e) { return false; }
}
// 按候选列表返回第一个「存在 / 可在 PATH 中找到」的可执行文件
function firstAvailable(candidates) {
    for (const c of candidates) {
        if (isExplicitPath(c)) {
            if (fs.existsSync(c)) return c;
        } else if (commandExists(c)) {
            return c;
        }
    }
    return null;
}

// ---------------- 子进程登记（供接口级总超时 kill） ----------------
// taskId -> Set<ChildProcess>。接口总超时时按 taskId 把该任务派生的
// python / ffmpeg 子进程连同进程树一起杀掉，否则会变孤儿进程继续吃 CPU。
const spawnRegistry = new Map();
const GLOBAL_KEY = ' global';

// 接口总超时后，本任务后续所有子进程都不该再启动（否则超时响应发了，
// 下游还在偷偷跑，临时文件越堆越多，CPU 也白烧）
const abortedTasks = new Set();
function markTaskAborted(taskId) { if (taskId) abortedTasks.add(taskId); }
function clearTaskAborted(taskId) { if (taskId) abortedTasks.delete(taskId); }

function registerSpawn(taskId, child) {
    if (!child || !child.pid) return;
    const key = taskId || GLOBAL_KEY;
    let set = spawnRegistry.get(key);
    if (!set) { set = new Set(); spawnRegistry.set(key, set); }
    set.add(child);
}

function unregisterSpawn(taskId, child) {
    const key = taskId || GLOBAL_KEY;
    const set = spawnRegistry.get(key);
    if (!set) return;
    set.delete(child);
    if (set.size === 0) spawnRegistry.delete(key);
}

// 杀掉某个任务派生的子进程（含 Windows 进程树），返回被杀的 pid 列表
function killTaskSpawns(taskId) {
    const key = taskId || GLOBAL_KEY;
    const set = spawnRegistry.get(key);
    if (!set || set.size === 0) return [];
    const pids = [];
    const { spawnSync } = require('child_process');
    for (const child of set) {
        pids.push(child.pid);
        try { child.kill('SIGKILL'); } catch (e) {}
        if (process.platform === 'win32') {
            // Windows：taskkill /T 递归杀整棵进程树
            try {
                spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
                    windowsHide: true, timeout: 5000
                });
            } catch (e) {}
        } else {
            // Linux/macOS：pkill -P 杀该进程的直接子进程（ffmpeg/python 多为单进程）
            try {
                spawnSync('pkill', ['-9', '-P', String(child.pid)], { timeout: 5000 });
            } catch (e) {}
        }
    }
    spawnRegistry.delete(key);
    return pids;
}

// 安全的文件重命名，带重试逻辑避免 EBUSY
async function safeRename(src, dest, retries = 3, delay = 500) {
    for (let i = 0; i < retries; i++) {
        try {
            fs.renameSync(src, dest);
            return true;
        } catch (e) {
            if (i < retries - 1 && e.code === 'EBUSY') {
                log(`重命名失败 (EBUSY)，${delay}ms 后重试 (${i+1}/${retries})...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw e;
            }
        }
    }
}

function isFfmpegAvailable(ffmpegPath) {
    if (!ffmpegPath) return false;
    if (fs.existsSync(ffmpegPath)) return true;
    if (!ffmpegPath.includes('/') && !ffmpegPath.includes('\\') && !ffmpegPath.includes('.')) {
        return true;
    }
    return false;
}

function spawnAsync(programPath, args, timeout = 600000, taskId) {
    if (taskId && abortedTasks.has(taskId)) {
        return Promise.reject(new Error('任务已终止（接口超时）'));
    }
    return new Promise((resolve, reject) => {
        let stderrData = '';
        let stdoutData = '';
        const MAX_BUFFER = 50000;

        const child = spawn(programPath, args, {
            windowsHide: true
        });
        registerSpawn(taskId, child);

        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) {}
            unregisterSpawn(taskId, child);
            reject(new Error('Timeout'));
        }, timeout);

        child.stdout.on('data', (data) => {
            stdoutData += data.toString('utf8');
            if (stdoutData.length > MAX_BUFFER) {
                stdoutData = stdoutData.substring(stdoutData.length - MAX_BUFFER);
            }
        });

        child.stderr.on('data', (data) => {
            stderrData += data.toString('utf8');
            if (stderrData.length > MAX_BUFFER) {
                stderrData = stderrData.substring(stderrData.length - MAX_BUFFER);
            }
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            unregisterSpawn(taskId, child);
            reject(err);
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            unregisterSpawn(taskId, child);
            const combined = stdoutData + stderrData;
            // ffmpeg查询信息时可能返回非零退出码，但数据已在buffer中
            resolve({ stdout: combined, stderr: stderrData });
        });
    });
}

// ---------------- 执行策略：OpenCV 优先，FFmpeg 兜底 ----------------
// 档位 1：OpenCV inpainting（cv2.inpaint）—— 像素级重建，质量最好，全平台/不限时长
// 档位 2：FFmpeg boxblur（多区域重建 + 模糊遮盖）
// 档位 3：FFmpeg boxblur（传统模糊遮盖），最后兜底
// 只有当上一档真的跑不起来/失败/超时，才启用下一档；绝不跳过 OpenCV 直接走 FFmpeg。

// 校验 ffmpeg 二进制「真的能跑」。
// 只查文件存在会被 Windows 应用控制策略(AppLocker/WDAC)骗过：
// 项目自带的 tools/ffmpeg.exe 曾被 WinError 4551 拦下，文件在、却执行不了。
// 必须用异步 spawn 探测：`spawnSync` 在本机启动这些大体积 exe（100~204MB）会稳定
// 返回 EBUSY（同步等待窗口 + CreateProcess 竞争），异步 spawn 则实测正常。
// 上一次因为这里误判「FFmpeg 不可用」，OpenCV 拿不到时长/帧数 → 输出 0 帧 →
// 文件被判异常 → 整条去水印链路静默失败，看上去只是「水印没去掉」。
function isFfmpegRunnable(ffmpegPath) {
    return new Promise((resolve) => {
        if (!ffmpegPath) return resolve(false);
        try {
            if (ffmpegPath.includes('/') || ffmpegPath.includes('\\') || ffmpegPath.includes('.')) {
                if (!fs.existsSync(ffmpegPath)) return resolve(false);
            }
        } catch (e) {
            return resolve(false);
        }

        let settled = false;
        let out = '';
        const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
        let child;
        try {
            child = require('child_process').spawn(ffmpegPath, ['-version'], { windowsHide: true });
        } catch (e) {
            return finish(false);
        }
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('error', () => finish(false));
        // 校验真实版本输出，不看这一行的话「文件在但被策略封禁」照样蒙混过关
        child.on('close', (code) => finish(code === 0 && /ffmpeg version/i.test(out)));
        setTimeout(() => {
            try { child.kill(); } catch (e) {}
            finish(false);
        }, 8000);
    });
}

// 返回第一个「可执行」的 ffmpeg；主二进制被策略封禁时自动切备选。
async function resolveFfmpeg(ffmpegPath) {
    if (await isFfmpegRunnable(ffmpegPath)) return ffmpegPath.replace(/^"|"$/g, '');
    const isWin = process.platform === 'win32';
    const candidates = isWin ? [
        path.join(__dirname, 'tools', 'ffmpeg_alt.exe'),
        'D:/app/Python313/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe'
    ] : [
        'ffmpeg',
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        path.join(__dirname, 'tools', 'ffmpeg')
    ];
    for (const c of candidates) {
        if (await isFfmpegRunnable(c)) {
            log(`[策略] 主FFmpeg不可用，改用备选: ${c}`);
            return c;
        }
    }
    return null;
}

// 清理 OpenCV 被中断时残留的临时文件，避免下次误判/占位
function cleanInpaintTemp(dirPath) {
    try {
        if (!dirPath || !fs.existsSync(dirPath)) return;
        for (const f of fs.readdirSync(dirPath)) {
            if (/^temp_(inpaint|audio)_/.test(f)) {
                try { fs.unlinkSync(path.join(dirPath, f)); } catch (e) {}
            }
        }
    } catch (e) {}
}

// 对外统一入口（server_fast.js 调的就是这个）
// 执行策略严格为：OpenCV inpainting → FFmpeg boxblur（多区域）→ FFmpeg boxblur（传统）
async function removeWatermarkAIPaint(inputPath, ffmpegPath, platform = 'general', taskId) {
    try {
        log(`[策略] 开始处理 (平台: ${platform})...`);

        // ============ 档位1：OpenCV inpainting，所有平台一律优先尝试 ============
        // 不再按「时长>60秒」跳过 OpenCV —— 实测 OpenCV 对长视频只是慢，不是不行。
        let cvReason = 'OpenCV不可用';
        try {
            const cvResult = await removeWatermarkInpainting(inputPath, platform, ffmpegPath, taskId);
            if (cvResult && cvResult.success && cvResult.removed) {
                log('[策略] ✓ 采用 OpenCV inpainting 完成去水印（未走 FFmpeg）');
                return { success: true, removed: true, method: 'opencv_inpaint', engine: 'opencv' };
            }
            // 必须透出 OpenCV 的真实失败原因。原来这个三元写错了（条件恒真），
            // cvReason 永远停在「OpenCV不可用」，「输出文件过小」「尺寸解析失败」
            // 这些真正原因全被吞掉，排查时只能看到一句废话。
            cvReason = (cvResult && (cvResult.error || cvResult.method)) || '未知原因';
        } catch (e) {
            cvReason = e.message;
        }
        // 只有 OpenCV 确实没做成，才启用 FFmpeg
        log(`[策略] OpenCV 未成功（${cvReason}）→ 启用 FFmpeg 方案`);
        cleanInpaintTemp(path.dirname(inputPath));
        ffmpegPath = await resolveFfmpeg(ffmpegPath);
        if (!ffmpegPath) {
            return { success: false, error: `OpenCV未成功（${cvReason}），且无可用FFmpeg兜底`, method: 'none' };
        }
        log(`[策略] 使用FFmpeg: ${ffmpegPath}`);

        // ============ 档位2/3：FFmpeg ============
        // 获取视频信息
        let videoInfo = '';
        try {
            const info = await spawnAsync(ffmpegPath, ['-i', inputPath, '-hide_banner', '-f', 'null', '-'], 300000, taskId);
            videoInfo = info.stdout;
        } catch (e) {
            videoInfo = (e.stdout || '') + (e.stderr || '');
        }

        const sizeMatch = videoInfo.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
        if (!sizeMatch) {
            // 拿不到尺寸就无法定位水印区域，此时返回的是带水印原文件
            log('[AI重建] ✗ 无法获取视频尺寸，无法定位水印区域');
            return { success: false, error: `无法解析视频尺寸（OpenCV原因: ${cvReason}）`, method: 'no_size' };
        }

        const width = parseInt(sizeMatch[1]);
        const height = parseInt(sizeMatch[2]);
        log(`[AI重建] 视频尺寸: ${width}x${height}`);

        // 计算logo位置（不裁剪，保持原始分辨率）
        let logoW, logoH, logoX, logoY;
        let aiFilter;

        if (platform === 'bilibili' || platform === 'B站') {
            // B站水印位置根据视频宽高比自动判断：
            // - 超宽屏(宽高比>2.0): 水印在右上角
            // - 标准宽高比(<=2.0): 水印在左上角
            // 为保险起见，始终同时处理两个可能的位置
            logoW = Math.min(Math.floor(width * 0.20), 180);
            logoH = Math.min(Math.floor(height * 0.08), 60);
            const logoX1 = 5;  // 左上角
            const logoY1 = 5;
            const logoX2 = width - logoW - 5;  // 右上角
            const logoY2 = 5;

            log(`[AI重建] B站: 同时处理左上(${logoX1},${logoY1})和右上(${logoX2},${logoY2})`);

            // 构建多水印filter（级联方式，因为overlay一次只能处理2个输入）
            aiFilter = `[0:v]split=3[v1][v2][v3];[v2]crop=${logoW}:${logoH}:${logoX1}:${logoY1},boxblur=8:2:4:1[blur1];[v3]crop=${logoW}:${logoH}:${logoX2}:${logoY2},boxblur=8:2:4:1[blur2];[v1][blur1]overlay=${logoX1}:${logoY1}[tmp];[tmp][blur2]overlay=${logoX2}:${logoY2}[out]`;
        } else if (platform === 'douyin' || platform === '抖音') {
            // 抖音水印在右侧和左上角
            logoW = Math.min(Math.floor(width * 0.12), 100);
            logoH = logoW;
            // 右侧水印
            logoX = width - logoW - 10;
            logoY = Math.floor(height * 0.55);
            // 左上角水印
            const logoX2 = 10;
            const logoY2 = 10;
            log(`[AI重建] 抖音: 右侧logo (${logoX},${logoY}) ${logoW}x${logoH}`);
            log(`[AI重建] 抖音: 左上角logo (${logoX2},${logoY2}) ${logoW}x${logoH}`);

            // 构建多水印filter（级联方式，因为overlay一次只能处理2个输入）
            // boxblur参数格式: luma_radius:luma_power:chroma_radius:chroma_power
            aiFilter = `[0:v]split=3[v1][v2][v3];[v2]crop=${logoW}:${logoH}:${logoX}:${logoY},boxblur=8:2:4:1[blur1];[v3]crop=${logoW}:${logoH}:${logoX2}:${logoY2},boxblur=8:2:4:1[blur2];[v1][blur1]overlay=${logoX}:${logoY}[tmp];[tmp][blur2]overlay=${logoX2}:${logoY2}[out]`;
        } else if (platform === 'doubao' || platform === '豆包') {
            // 豆包在档位1已经跑过 OpenCV 了，走到这里只能是 OpenCV 失败后的兜底，
            // 必须沿用 FFmpeg 的 boxblur，不能再回跳 OpenCV 造成重复执行。
            // 坐标与 inpaint_watermark.py 保持完全一致，避免兜底时漏掉一半水印区。
            logoW = Math.min(Math.floor(width * 0.30), 220);
            logoH = Math.min(Math.floor(height * 0.09), 120);
            logoX = Math.max(width - logoW - 10, 10);
            logoY = Math.max(height - logoH - 30, 30);
            // OpenCV 的掩膜是「右下 + 左上」两角，兜底也必须覆盖两角，
            // 否则一旦回退到 FFmpeg，左上角水印原样保留。
            const logoX2 = 10, logoY2 = 10;
            log(`[AI重建] 豆包(FFmpeg兜底): 右下 ${logoW}x${logoH}@(${logoX},${logoY}) + 左上 ${logoX2},${logoY2}`);
            aiFilter = `[0:v]split=3[v1][v2][v3];[v2]crop=${logoW}:${logoH}:${logoX}:${logoY},boxblur=8:2:4:1[blur1];[v3]crop=${logoW}:${logoH}:${logoX2}:${logoY2},boxblur=8:2:4:1[blur2];[v1][blur1]overlay=${logoX}:${logoY}[tmp];[tmp][blur2]overlay=${logoX2}:${logoY2}[out]`;
        } else {
            // 通用平台没有可靠的水印坐标，硬套 boxblur 只会糊掉画面 —— 如实上报失败
            log('[AI重建] ✗ 通用平台无可用水印坐标策略');
            return {
                success: false,
                error: `OpenCV未成功（${cvReason}），且通用平台无水印策略`,
                method: 'no_strategy'
            };
        }

        const outputPath = inputPath.replace(/\.mp4$/, '_ai_fix.mp4');
        const ffmpegThreads = parseInt(process.env.FFMPEG_THREADS || '1');

        // 方法1: boxblur模糊水印区域
        // 使用split/crop/boxblur/overlay方式，确保输出标签正确
        // boxblur参数格式: luma_radius:luma_power:chroma_radius:chroma_power
        const aiArgs = [
            '-i', inputPath,
            '-filter_complex', aiFilter,
            '-map', '[out]',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',  // 高质量，接近无损
            '-threads', String(ffmpegThreads),
            '-c:a', 'copy',
            '-y', outputPath
        ];

        log('[AI重建] 尝试 FFmpeg 重建法（boxblur 遮盖水印区）...');
        let aiResult = null;
        try {
            aiResult = await spawnAsync(ffmpegPath, aiArgs, 1800000, taskId); // 30分钟超时
            log('[AI重建] 像素重建完成');
        } catch (e) {
            log(`[AI重建] 像素重建失败: ${e.message}`);
        }

        // 验证AI重建结果质量
        if (aiResult && fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            const originalSize = fs.statSync(inputPath).size;

            // 检查文件大小合理性
            if (stats.size < 50000) {
                log('[AI重建] 输出文件过小，质量不达标');
                safeUnlink(outputPath);
                aiResult = null;
            } else {
                // 质量比检查：输出应该接近原始大小（±20%）
                const sizeRatio = stats.size / originalSize;
                log(`[AI重建] 文件大小: ${(stats.size/1024/1024).toFixed(2)}MB (原始: ${(originalSize/1024/1024).toFixed(2)}MB, 比率: ${(sizeRatio*100).toFixed(0)}%)`);

                if (sizeRatio < 0.5) {
                    log('[AI重建] 质量比过低，降级到传统方法');
                    safeUnlink(outputPath);
                    aiResult = null;
                }
            }
        }

        if (aiResult) {
            // 成功：替换原文件
            safeUnlink(inputPath);
            await safeRename(outputPath, inputPath);
            log('[AI重建] ✓ FFmpeg 重建去水印完成');
            // 注意：这里用的是 boxblur 遮盖，不是像素级重建，方法名要如实上报
            return { success: true, removed: true, method: 'ffmpeg_boxblur', engine: 'ffmpeg' };
        }

        // 方法2: 传统boxblur作为降级方案
        log('[AI重建] 降级到传统模糊处理...');
        return await removeWatermarkLegacy(inputPath, ffmpegPath, platform);

    } catch (e) {
        log(`[AI重建] 异常: ${e.message}`);
        return { success: false, error: e.message, method: 'error' };
    }
}

// 传统boxblur方法（作为降级方案）
async function removeWatermarkLegacy(inputPath, ffmpegPath, platform = 'general') {
    try {
        log(`[boxblur] 开始处理 (平台: ${platform})...`);

        ffmpegPath = ffmpegPath.replace(/^"|"$/g, '');

        if (!isFfmpegAvailable(ffmpegPath)) {
            log('[boxblur] FFmpeg不可用');
            return { success: false, error: 'FFmpeg不可用', method: 'boxblur_no_ffmpeg' };
        }

        let videoInfo = '';
        try {
            const info = await spawnAsync(ffmpegPath, ['-i', inputPath, '-hide_banner', '-f', 'null', '-'], 300000, taskId);
            videoInfo = info.stdout;
        } catch (e) {
            videoInfo = (e.stdout || '') + (e.stderr || '');
        }

        const sizeMatch = videoInfo.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
        if (!sizeMatch) {
            // 原文件仍带水印，不能伪装成成功
            return { success: false, error: '无法解析视频尺寸', method: 'boxblur_no_size' };
        }

        const width = parseInt(sizeMatch[1]);
        const height = parseInt(sizeMatch[2]);

        let logoW, logoH, logoX, logoY;

        if (platform === 'bilibili' || platform === 'B站') {
            // B站水印位置不固定，根据视频分辨率判断
            logoW = Math.min(Math.floor(width * 0.20), 180);
            logoH = Math.min(Math.floor(height * 0.08), 60);
            logoX = 5;
            logoY = 5;
        } else if (platform === 'douyin' || platform === '抖音') {
            logoW = Math.min(Math.floor(width * 0.12), 100);
            logoH = logoW;
            logoX = width - logoW - 10;
            logoY = Math.floor(height * 0.55);
        } else if (platform === 'doubao' || platform === '豆包') {
            logoW = Math.min(Math.floor(width * 0.15), 180);
            logoH = Math.min(Math.floor(height * 0.12), 100);
            logoX = width - logoW;
            logoY = height - logoH - 20;
        } else {
            // 没有该平台的坐标策略，硬套只会糊掉画面 —— 如实上报
            return { success: false, error: `无匹配的水印坐标策略 (${platform})`, method: 'boxblur_no_strategy' };
        }

        const outputPath = inputPath.replace(/\.mp4$/, '_legacy.mp4');
        // boxblur参数格式: luma_radius:luma_power:chroma_radius:chroma_power
        const filterComplex = `[0:v]split=2[v1][v2];[v2]crop=${logoW}:${logoH}:${logoX}:${logoY},boxblur=8:2:4:1[blur];[v1][blur]overlay=${logoX}:${logoY}[v]`;

        const ffmpegThreads = parseInt(process.env.FFMPEG_THREADS || '1');
        const args = [
            '-i', inputPath,
            '-filter_complex', filterComplex,
            '-map', '[v]',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '28',
            '-threads', String(ffmpegThreads),
            '-c:a', 'copy',
            '-y', outputPath
        ];

        log(`[boxblur] 执行传统模糊处理 (${logoW}x${logoH})...`);

        try {
            await spawnAsync(ffmpegPath, args, 1800000, taskId); // 30分钟超时

            if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100000) {
                safeUnlink(inputPath);
                await safeRename(outputPath, inputPath);
                log('[boxblur] ✓ 传统模糊处理完成');
                return { success: true, removed: true, method: 'boxblur' };
            } else {
                safeUnlink(outputPath);
                // 不要伪装成成功：原文件仍带水印，必须如实上报
                log('[boxblur] ✗ 处理失败，返回原始带水印文件');
                return { success: false, error: '输出文件无效', method: 'boxblur_fail' };
            }
        } catch (e) {
            safeUnlink(outputPath);
            log(`[boxblur] ✗ 模糊处理异常: ${e.message}`);
            return { success: false, error: e.message, method: 'boxblur_error' };
        }

    } catch (e) {
        return { success: false, error: e.message, method: 'error' };
    }
}

function safeUnlink(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
    } catch (e) {}
    return false;
}

// 查找Python可执行文件（优先E盘）
function findPython() {
    const isWin = process.platform === 'win32';
    const candidates = isWin ? [
        'E:/tools/python/Python313/python.exe',
        'E:/tools/python/Python312/python.exe',
        'python',
        'python3'
    ] : [
        'python3',
        'python',
        path.join(__dirname, 'venv', 'bin', 'python'),
        '/usr/bin/python3'
    ];
    return firstAvailable(candidates);
}

// 查找OpenCV虚拟环境
function findOpenCVPython() {
    const isWin = process.platform === 'win32';
    // 优先尝试有OpenCV的路径
    const candidates = isWin ? [
        'D:/app/Python313/python.exe',  // 已安装opencv-python
        'D:/app/Python312/python.exe',
        'C:/Users/PC/.workbuddy/binaries/python/versions/3.13.12/python.exe',
        'C:/Users/PC/.workbuddy/binaries/python/versions/3.13.7/python.exe',
        'E:/tools/python/opencv-env/Scripts/python.exe',
        'E:/tools/python/opencv-env/python.exe',
        'python',
        'python3'
    ] : [
        'python3',
        'python',
        path.join(__dirname, 'venv', 'bin', 'python'),
        '/usr/bin/python3'
    ];
    return firstAvailable(candidates);
}

// 使用OpenCV inpainting去除水印
async function removeWatermarkInpainting(inputPath, platform = 'doubao', ffmpegPath = null, taskId) {
    try {
        log(`[OpenCV] 开始处理 (平台: ${platform})...`);

        const pythonPath = findOpenCVPython();
        if (!pythonPath) {
            log('[OpenCV] Python不可用，返回null以触发FFmpeg回退');
            return null;
        }

        // 动态计算脚本路径
        const scriptPath = path.join(__dirname, 'inpaint_watermark.py');
        if (!fs.existsSync(scriptPath)) {
            log('[OpenCV] 脚本不存在: ' + scriptPath);
            return null;
        }

        const outputPath = inputPath.replace(/\.mp4$/, '_inpaint.mp4');

        // 清掉上一次可能残留的临时文件，避免旧的半成品被当成本次结果
        cleanInpaintTemp(path.dirname(inputPath));

        // 探测用的 ffmpeg 要与主流程保持一致：主二进制被策略封禁时，
        // 这里必须换成能跑的那个，否则时长/帧数全为 0，超时估算会失真。
        const probeFfmpeg = await resolveFfmpeg(ffmpegPath);
        if (!probeFfmpeg) {
            log('[OpenCV] 无法找到可用的FFmpeg，无法探测视频信息（仍按文件大小估算超时）');
        }

        // 获取视频时长和帧数
        let durationSec = 0;
        let frameCount = 0;
        let info;
        try {
            info = await spawnAsync(probeFfmpeg || ffmpegPath, ['-i', inputPath, '-hide_banner', '-f', 'null', '-'], 300000, taskId);
            // ffmpeg的Duration可能输出在stdout或stderr中
            const output = info.stdout || info.stderr || '';
            const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+)\.(\d+)/);
            if (durationMatch) {
                const hours = parseInt(durationMatch[1]);
                const minutes = parseInt(durationMatch[2]);
                const seconds = parseInt(durationMatch[3]);
                const millis = parseInt(durationMatch[4] || '0');
                durationSec = hours * 3600 + minutes * 60 + seconds + millis / 1000;
            }
            // 尝试从ffmpeg输出中获取帧率信息
            const fpsMatch = output.match(/(\d+)\s*fps/);
            if (!fpsMatch) {
                // 使用ffmpeg流处理获取准确帧数
                try {
                    log('[OpenCV] 使用ffmpeg获取帧数...');
                    const frameInfo = await spawnAsync(probeFfmpeg || ffmpegPath, [
                        '-i', inputPath,
                        '-vf', 'fps=25',
                        '-f', 'null',
                        '-'
                    ], 300000, taskId); // 5分钟超时
                    // 解析frame=N输出
                    const match = frameInfo.stderr?.match(/frame=\s*(\d+)/);
                    if (match) {
                        frameCount = parseInt(match[1]);
                    }
                } catch (e) {
                    log(`[OpenCV] 获取帧数失败: ${e.message}`);
                }
            }
        } catch (e) {
            log(`[OpenCV] 获取视频信息失败: ${e.message}`);
        }

        log(`[OpenCV] 使用Python: ${pythonPath}`);
        log(`[OpenCV] 处理视频: ${inputPath}`);
        log(`[OpenCV] 视频时长: ${durationSec}秒, 帧数: ${frameCount}`);

        // 根据帧数动态设置超时：每帧约500ms（实测1.8fps），预留3倍余量
        // 如果无法获取帧数，则基于时长估算（假设25fps）
        // OpenCV 是首选方案，超时要给足；但不能无限等（超长视频 inpainting 极慢，
        // 实测约 2.6fps，34 分钟长视频要跑 1 小时以上）。
        // 超过预算就由策略层回退到 FFmpeg，而不是让用户干等。
        const cvMaxBudget = parseInt(process.env.OPENCV_MAX_BUDGET || '1200'); // 秒
        let timeout;
        if (frameCount > 0) {
            timeout = Math.min(frameCount * 500 * 3, cvMaxBudget * 1000);
            log(`[OpenCV] 设置超时: ${timeout/1000}秒 (基于${frameCount}帧，预算上限 ${cvMaxBudget}秒)`);
        } else if (durationSec > 0) {
            // 使用视频时长估算（假设25fps）
            const estimatedFrames = Math.round(durationSec * 25);
            timeout = Math.min(estimatedFrames * 500 * 3, cvMaxBudget * 1000);
            log(`[OpenCV] 设置超时: ${timeout/1000}秒 (基于${durationSec}秒时长，预算上限 ${cvMaxBudget}秒)`);
        } else {
            // 无法获取信息时的兜底：按文件大小估算并给足余量。
            // 实测 OpenCV inpainting 约 2.6fps，之前用固定 30 秒会把任务直接掐断，
            // 导致最终把带水印的原文件返回给用户。
            try {
                const mb = fs.statSync(inputPath).size / (1024 * 1024);
                timeout = Math.min(Math.max(Math.round(mb * 8000), 180000), cvMaxBudget * 1000);
            } catch (e) {
                timeout = 180000;
            }
            log(`[OpenCV] 无法获取视频信息，按文件大小估算超时: ${timeout/1000}秒`);
        }

        if (timeout < 10000) {
            timeout = 10000; // 最小10秒超时
        }

        const result = await spawnAsync(pythonPath, [
            scriptPath,
            inputPath,
            outputPath,
            platform
        ], timeout, taskId);

        const origSize = (() => { try { return fs.statSync(inputPath).size; } catch (e) { return 0; } })();

        if (fs.existsSync(outputPath)) {
            const newSize = fs.statSync(outputPath).size;
            const ratio = origSize > 0 ? newSize / origSize : 1;
            log(`[OpenCV] 处理完成: ${(origSize/1024/1024).toFixed(2)}MB -> ${(newSize/1024/1024).toFixed(2)}MB (比率 ${(ratio*100).toFixed(0)}%)`);

            // 编码器异常可能产出远小于原文件的空壳，判定为不达标
            if (newSize < 20000 || ratio < 0.3) {
                log(`[OpenCV] ✗ 输出文件异常（过小/比率过低），判定为失败`);
                safeUnlink(outputPath);
                cleanInpaintTemp(path.dirname(inputPath));
                return { success: false, error: `OpenCV输出异常 (${newSize} bytes, 比率 ${(ratio*100).toFixed(0)}%)`, method: 'opencv_bad_output' };
            }

            // 替换原文件
            safeUnlink(inputPath);
            await safeRename(outputPath, inputPath);
            // Python 侧可能没删干净（脚本内异常退出时尤其如此），
            // 这里兜底扫一遍，避免 downloads 里堆满 temp_inpaint_*/temp_audio_*。
            cleanInpaintTemp(path.dirname(inputPath));
            log('[OpenCV] ✓ OpenCV inpainting去水印完成');
            return { success: true, removed: true, method: 'opencv_inpaint', engine: 'opencv' };
        } else {
            log('[OpenCV] 输出文件不存在（可能被超时中断）');
            cleanInpaintTemp(path.dirname(inputPath));
            return { success: false, error: 'OpenCV output not found' };
        }
    } catch (e) {
        log(`[OpenCV] 异常: ${e.message}`);
        // 超时或异常时如实返回失败，交由上层策略回退到 FFmpeg
        cleanInpaintTemp(path.dirname(inputPath));
        return { success: false, error: e.message, method: 'opencv_error' };
    }
}

module.exports = {
    removeWatermark: removeWatermarkAIPaint,
    // 供接口级总超时调用：杀掉该任务派生的 python/ffmpeg 进程树
    killTaskSpawns,
    // 通知本任务已被判死，后续 spawn 一律直接拒绝
    markTaskAborted
};
