const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { exec, spawn, spawnSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const {
    removeWatermark,
    killTaskSpawns: killWatermarkSpawns,
    markTaskAborted
} = require('./watermark_remover');

// ---------------- 任务追踪：阶段进度 + 接口级总超时 ----------------
// 前端发起解析时带上 taskId；后端据此实时上报阶段，并在超过 PARSE_TIMEOUT
// 时主动 kill 该任务派生的全部子进程（含进程树），避免长视频把请求挂住、
// 子进程退化成孤儿继续吃 CPU。用户侧也能看到"卡在哪一步"而不是干等。
const PARSE_TIMEOUT = parseInt(process.env.PARSE_TIMEOUT || '900000');    // 15 分钟
const SLOW_HINT_MS = parseInt(process.env.SLOW_HINT_MS || '120000');     // 2 分钟给久待提示
const TIMEOUT_LABEL = PARSE_TIMEOUT >= 60000
    ? `${(PARSE_TIMEOUT / 60000).toFixed(PARSE_TIMEOUT % 60000 === 0 ? 0 : 1)} 分钟`
    : `${Math.round(PARSE_TIMEOUT / 1000)} 秒`;

// 阶段流：每个阶段结束时进度条推进到的百分比
const STAGE_FLOW = [
    { key: 'resolve',   label: '解析页面',   to: 20  },
    { key: 'download',  label: '下载视频',   to: 45  },
    { key: 'process',   label: '封装转码',   to: 60  },
    { key: 'watermark', label: '去除水印',   to: 90  },
    { key: 'final',     label: '整理输出',   to: 100 }
];

const taskStates = new Map();   // taskId -> { stage, label, progress, message, startTime, timedOut }
const taskChildren = new Map(); // taskId -> Set<ChildProcess>

function registerTaskChild(taskId, child) {
    if (!child || !child.pid) return;
    const key = taskId || 'global';
    let set = taskChildren.get(key);
    if (!set) { set = new Set(); taskChildren.set(key, set); }
    set.add(child);
}

function unregisterTaskChild(taskId, child) {
    const key = taskId || 'global';
    const set = taskChildren.get(key);
    if (!set) return;
    set.delete(child);
    if (set.size === 0) taskChildren.delete(key);
}

function isTaskAborted(taskId) {
    const st = taskStates.get(taskId);
    return !!(st && st.timedOut);
}

function createTask(taskId) {
    if (!taskId) taskId = `tk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!taskStates.has(taskId)) {
        taskStates.set(taskId, {
            stage: 'resolve', label: STAGE_FLOW[0].label, progress: 0,
            message: '准备解析', startTime: Date.now(), timedOut: false
        });
    }
    return taskId;
}

function setTaskStage(taskId, stage, message) {
    const st = taskStates.get(taskId);
    if (!st || st.timedOut) return;
    const meta = STAGE_FLOW.find(s => s.key === stage) || STAGE_FLOW[STAGE_FLOW.length - 1];
    st.stage = stage;
    st.label = meta.label;
    st.progress = meta.to;
    st.message = message || meta.label;
}

function finishTask(taskId, message) {
    const st = taskStates.get(taskId);
    if (!st || st.timedOut) return;
    st.stage = 'final';
    st.label = '完成';
    st.progress = 100;
    st.message = message || '完成';
}

function killTree(child) {
    if (!child || !child.pid) return;
    try { child.kill('SIGKILL'); } catch (e) {}
    if (process.platform === 'win32') {
        // Windows：taskkill /T 递归杀整棵进程树
        try {
            spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
                windowsHide: true, timeout: 5000
            });
        } catch (e) {}
    } else {
        // Linux/macOS：pkill -P 杀直接子进程
        try {
            spawnSync('pkill', ['-9', '-P', String(child.pid)], { timeout: 5000 });
        } catch (e) {}
    }
}

// 总超时终止：kill 进程树 + 清理临时文件 + 标记状态
function terminateTask(taskId, reason) {
    const st = taskStates.get(taskId);
    if (!st || st.timedOut) return { killed: [] };
    st.timedOut = true;
    st.stage = 'timeout';
    st.label = '已终止';
    st.progress = 100;
    st.message = `${reason}，任务已终止`;
    // 通知下游模块：本任务后续一律不许再 spawn 新进程
    try { markTaskAborted(taskId); } catch (e) {}

    const killed = [];
    const own = taskChildren.get(taskId);
    if (own) {
        for (const c of own) { killed.push(c.pid); killTree(c); }
        taskChildren.delete(taskId);
    }
    try {
        const pids = killWatermarkSpawns(taskId) || [];
        killed.push(...pids);
    } catch (e) {}

    const sweepTemp = () => {
        try {
            for (const name of fs.readdirSync(DOWNLOAD_DIR)) {
                if (name.startsWith('temp_')) safeUnlink(path.join(DOWNLOAD_DIR, name));
            }
        } catch (e) {}
    };
    sweepTemp();
    // 竞态：终止那一刻子进程可能刚被 spawn 或临文件刚落盘，
    // 3 秒后再扫一遍，把漏网的清掉，否则 downloads 会堆 temp_ 垃圾。
    setTimeout(sweepTemp, 3000).unref();

    log(`[任务 ${taskId}] 已终止：${reason}（kill ${killed.length} 个进程${killed.length ? ': ' + killed.join(',') : ''}）`);
    return { killed };
}

// 任务状态不回收会一直占内存，定期清理已结束的
setInterval(() => {
    const now = Date.now();
    for (const [id, st] of taskStates) {
        if (now - st.startTime > 3600000) taskStates.delete(id);
    }
}, 600000).unref();

const FFMPEG_TIMEOUT = parseInt(process.env.FFMPEG_TIMEOUT || '300000');
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '200');
const MEMORY_THRESHOLD_MB = parseInt(process.env.MEMORY_THRESHOLD_MB || '400');

function spawnFfmpeg(ffmpegPath, args, timeout = FFMPEG_TIMEOUT, taskId) {
    // 接口总超时后本任务已被判死，不能再启动任何新子进程，
    // 否则超时响应发出去了，下游还在偷偷下载/转码，临时文件越堆越多。
    if (taskId && isTaskAborted(taskId)) {
        return Promise.reject(new Error('任务已终止（接口超时）'));
    }
    return new Promise((resolve, reject) => {
        let stderr = '';
        const child = spawn(ffmpegPath, args, {
            windowsHide: true
        });
        registerTaskChild(taskId, child);

        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) {}
            unregisterTaskChild(taskId, child);
            reject(new Error('FFmpeg timeout'));
        }, timeout);

        child.stderr.on('data', (data) => {
            stderr += data.toString();
            if (stderr.length > 50000) {
                stderr = stderr.substring(stderr.length - 50000);
            }
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            unregisterTaskChild(taskId, child);
            reject(err);
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            unregisterTaskChild(taskId, child);
            if (code === 0) {
                resolve({ stderr });
            } else {
                const err = new Error(`FFmpeg exit code ${code}`);
                err.stderr = stderr;
                reject(err);
            }
        });
    });
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

// Import watermark removal module (using delogo filter, keep original size)

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// 下载目录：默认放在项目内 downloads/，Cloudflare 等环境可通过 DOWNLOAD_DIR 指向容器可写路径
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
    ? path.resolve(process.env.DOWNLOAD_DIR)
    : path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

let browserInstance = null;
let browserReady = false;
let browserIdleTimer = null;
let browserRefCount = 0;
const BROWSER_IDLE_TIMEOUT = parseInt(process.env.BROWSER_IDLE_TIMEOUT || 300000);

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function resetBrowserIdleTimer() {
    if (browserIdleTimer) {
        clearTimeout(browserIdleTimer);
        browserIdleTimer = null;
    }
    if (browserRefCount <= 0 && browserInstance) {
        browserIdleTimer = setTimeout(() => {
            log(`浏览器空闲 ${BROWSER_IDLE_TIMEOUT/1000}s，自动关闭以释放内存`);
            closeBrowser().catch(() => {});
        }, BROWSER_IDLE_TIMEOUT);
    }
}

function getPuppeteerLaunchOptions(extraArgs = []) {
    const defaultArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-images',
        '--blink-settings=imagesEnabled=false',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-software-rasterizer',
        '--mute-audio',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--enable-automation',
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-ipc-flooding-protection',
        '--no-zygote',
        '--disable-infobars',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-component-update',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
    ];
    const options = {
        headless: 'new',
        args: [...defaultArgs, ...extraArgs],
        timeout: 30000,
        protocolTimeout: 300000  // 增加到5分钟，避免evaluate超时
    };
    // 设置独立的 Chrome 用户数据目录，避免与已运行的浏览器冲突
    const userDataDir = path.join(__dirname, '.cache', 'chrome-profile');
    if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
    }
    options.args.push(`--user-data-dir=${userDataDir}`);
    // 忽略版本不匹配
    options.args.push('--ignore-certificate-errors');
    options.args.push('--ignore-certIFICATE-errors');
    log(`Chrome 用户目录: ${userDataDir}`);

    const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (chromePath && fs.existsSync(chromePath)) {
        options.executablePath = chromePath;
        log(`使用指定浏览器路径: ${chromePath}`);
    } else {
        // 尝试自动查找 Chrome 或 Edge
        const isWin = process.platform === 'win32';
        const searchPaths = isWin ? [
            // 项目内置 Chrome（puppeteer安装）
            path.join(__dirname, '.cache', 'chrome', 'chrome', 'win64-148.0.7778.167', 'chrome-win64', 'chrome.exe'),
            '/c/Program Files/Google/Chrome/Application/chrome.exe',
            '/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
        ] : [
            // Linux：系统包管理的 Chromium / Chrome
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/snap/bin/chromium'
        ];
        for (const p of searchPaths) {
            if (fs.existsSync(p)) {
                options.executablePath = p;
                log(`自动找到浏览器: ${p}`);
                break;
            }
        }
    }
    return options;
}

async function launchBrowser(extraArgs = []) {
    const options = getPuppeteerLaunchOptions(extraArgs);
    return await puppeteer.launch(options);
}

async function getBrowser() {
    browserRefCount++;
    if (browserIdleTimer) {
        clearTimeout(browserIdleTimer);
        browserIdleTimer = null;
    }
    // 检查浏览器连接是否有效
    if (browserInstance && browserReady) {
        try {
            await browserInstance.version();
            return browserInstance;
        } catch (e) {
            log(`浏览器连接已断开: ${e.message}，重新启动...`);
            browserInstance = null;
            browserReady = false;
        }
    }

    log('启动浏览器实例...');
    const memStart = process.memoryUsage();
    browserInstance = await launchBrowser();
    browserReady = true;
    const memEnd = process.memoryUsage();
    log(`浏览器实例就绪 (启动后内存: ${Math.round(memEnd.heapUsed/1024/1024)}MB)`);
    return browserInstance;
}

function releaseBrowser() {
    browserRefCount = Math.max(0, browserRefCount - 1);
    resetBrowserIdleTimer();
}

async function closeBrowser() {
    if (browserIdleTimer) {
        clearTimeout(browserIdleTimer);
        browserIdleTimer = null;
    }
    if (browserInstance) {
        try {
            await browserInstance.close();
        } catch (e) {
            log(`关闭浏览器异常: ${e.message}`);
        }
        browserInstance = null;
        browserReady = false;
        browserRefCount = 0;
        log('浏览器实例已关闭');
    }
}

async function resolveUrl(shortUrl) {
    try {
        const response = await axios.get(shortUrl, {
            maxRedirects: 3,
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15'
            }
        });
        return response.request.res.responseUrl;
    } catch (e) {
        return shortUrl;
    }
}

function parseApiResponse(data, apiName) {
    if (!data) return null;
    
    try {
        let videoUrl = null;
        let title = null;
        
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch {
                return null;
            }
        }
        
        const urlFields = ['url', 'videoUrl', 'video_url', 'download_url', 'downloadUrl', 
                          'nwm_video_url', 'no_watermark_video_url', 'play_addr', 'video'];
        
        for (const field of urlFields) {
            if (data[field]) {
                if (typeof data[field] === 'string' && data[field].includes('http')) {
                    videoUrl = data[field];
                    break;
                } else if (typeof data[field] === 'object' && data[field].url) {
                    videoUrl = data[field].url;
                    break;
                }
            }
        }
        
        if (!videoUrl && data.data) {
            for (const field of urlFields) {
                if (data.data[field]) {
                    if (typeof data.data[field] === 'string' && data.data[field].includes('http')) {
                        videoUrl = data.data[field];
                        break;
                    } else if (typeof data.data[field] === 'object' && data.data[field].url) {
                        videoUrl = data.data[field].url;
                        break;
                    }
                }
            }
        }
        
        if (!videoUrl && data.video) {
            if (data.video.url) videoUrl = data.video.url;
            else if (typeof data.video === 'string') videoUrl = data.video;
        }
        
        if (!videoUrl && data.result) {
            if (data.result.url) videoUrl = data.result.url;
            else if (data.result.video_url) videoUrl = data.result.video_url;
        }
        
        if (!videoUrl && data.urls) {
            for (const u of data.urls) {
                if (u.url && u.url.includes('.mp4')) {
                    videoUrl = u.url;
                    break;
                }
            }
        }
        
        if (!videoUrl && data.download) {
            videoUrl = data.download;
        }
        
        if (data.title) title = data.title;
        if (data.data && data.data.title) title = data.data.title;
        
        if (videoUrl && videoUrl.includes('http')) {
            return {
                success: true,
                title: title || '视频',
                videoUrl: videoUrl,
                source: apiName,
                thumbnail: null
            };
        }
    } catch (e) {
        log(`解析响应失败: ${e.message}`);
    }
    
    return null;
}

async function tryAPIsParallel(videoId, originalUrl, resolvedUrl) {
    const apis = [
        {
            name: 'Douyin WTF',
            url: `https://api.douyin.wtf/api?url=${encodeURIComponent(resolvedUrl || originalUrl)}`
        },
        {
            name: 'Douyin2Download',
            url: `https://api.douyin2download.com/api?url=${encodeURIComponent(originalUrl)}`
        },
        {
            name: 'DouyinTool',
            url: `https://douyin.1024api.com/api?url=${encodeURIComponent(originalUrl)}`
        }
    ];
    
    const promises = apis.map(async (api) => {
        try {
            log(`请求 ${api.name}...`);
            const response = await axios.get(api.url, {
                timeout: 12000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json, text/plain, */*',
                    'Connection': 'close'
                },
                maxRedirects: 3
            });
            
            const result = parseApiResponse(response.data, api.name);
            if (result) {
                log(`✅ ${api.name} 成功!`);
                return result;
            }
        } catch (e) {
            log(`${api.name} 失败: ${e.message}`);
        }
        return null;
    });
    
    const results = await Promise.allSettled(promises);
    
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
            return r.value;
        }
    }
    
    return null;
}

async function tryDirectPuppeteer(url) {
    log('尝试直接解析抖音页面...');

    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
        // 使用PC端UA以获得更好的解析效果
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const videoRequests = [];

        // 拦截网络响应中的视频URL
        page.on('response', (response) => {
            const responseUrl = response.url();
            if (responseUrl.includes('douyinvod.com') && responseUrl.includes('video')) {
                videoRequests.push(responseUrl);
                log(`  拦截到视频URL: ${responseUrl.substring(0, 100)}...`);
            }
        });

        const resolvedUrl = await resolveUrl(url);
        log(`访问: ${resolvedUrl}`);

        // 等待页面加载
        await page.goto(resolvedUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 45000
        });

        // 等待视频资源加载
        await new Promise(resolve => setTimeout(resolve, 12000));

        // 提取标题
        const title = await page.title();
        log(`页面标题: ${title}`);

        // 方法1: 检查已拦截的视频URL
        if (videoRequests.length > 0) {
            log(`检测到 ${videoRequests.length} 个视频请求`);
            // 使用最高优先级的视频URL
            const videoUrl = videoRequests[videoRequests.length - 1];
            log(`✅ 找到视频链接: ${videoUrl.substring(0, 100)}...`);

            return {
                success: true,
                title: title || '抖音视频',
                videoUrl: videoUrl,
                source: 'Puppeteer Network',
                thumbnail: null
            };
        }

        // 方法2: 搜索window对象中的数据
        const result = await page.evaluate(() => {
            const urls = [];

            // 搜索所有window对象中的视频URL
            for (const key of Object.keys(window)) {
                try {
                    const val = window[key];
                    if (val && typeof val === 'object') {
                        const str = JSON.stringify(val);
                        // 搜索 douyinvod.com URL
                        const videoMatches = str.match(/https?:\/\/[^"\\s]+douyinvod\.com[^"\\s]*/gi);
                        if (videoMatches) {
                            videoMatches.forEach(m => urls.push({ url: m, source: `window[${key}]` }));
                        }
                        // 搜索 mp4 URL
                        const mp4Matches = str.match(/https?:\/\/[^"\\s]+\.(mp4|m3u8)[^"\\s]*/gi);
                        if (mp4Matches) {
                            mp4Matches.forEach(m => urls.push({ url: m, source: `window[${key}]` }));
                        }
                    }
                } catch(e) {}
            }

            // 搜索 __INLINE_PLAYER_DATA__
            if (window.__INLINE_PLAYER_DATA__) {
                try {
                    const str = JSON.stringify(window.__INLINE_PLAYER_DATA__);
                    const matches = str.match(/https?:\/\/[^"\\s]+douyinvod\.com[^"\\s]*/gi);
                    if (matches) {
                        matches.forEach(m => urls.push({ url: m, source: '__INLINE_PLAYER_DATA__' }));
                    }
                } catch(e) {}
            }

            // 搜索 SSR_RENDER_DATA
            if (window.SSR_RENDER_DATA) {
                try {
                    const str = JSON.stringify(window.SSR_RENDER_DATA);
                    const matches = str.match(/https?:\/\/[^"\\s]+douyinvod\.com[^"\\s]*/gi);
                    if (matches) {
                        matches.forEach(m => urls.push({ url: m, source: 'SSR_RENDER_DATA' }));
                    }
                } catch(e) {}
            }

            return urls;
        });

        // 去重并评分
        const videoUrls = [];
        const seenUrls = new Set();

        result.forEach((item) => {
            const url = item.url;
            if (seenUrls.has(url)) return;
            seenUrls.add(url);

            let score = 0;
            if (url.includes('douyinvod.com')) score = 100;
            else if (url.includes('.mp4')) score = 60;
            else if (url.includes('.m3u8')) score = 50;
            else return;

            videoUrls.push({ url, score, source: item.source });
            log(`  找到候选: ${url.substring(0, 80)}... (分数: ${score})`);
        });

        log(`找到 ${videoUrls.length} 个有效视频链接`);

        if (videoUrls.length > 0) {
            videoUrls.sort((a, b) => b.score - a.score);
            const bestUrl = videoUrls[0];

            log(`✅ 选择最佳链接 (分数: ${bestUrl.score}): ${bestUrl.url.substring(0, 100)}...`);

            return {
                success: true,
                title: title || '抖音视频',
                videoUrl: bestUrl.url,
                source: 'Puppeteer Data',
                thumbnail: null
            };
        }

        // 如果没有找到，返回空结果
        log(`❌ 未找到有效视频链接`);

    } catch (e) {
        log(`Puppeteer解析失败: ${e.message}`);
    } finally {
        try { await page.close(); } catch (e) {}
        releaseBrowser();
    }

    return null;
}

async function tryBilibiliParser(url) {
    log('使用B站专用解析器...');
    let page = null;
    
    const videoQualityIds = ['64', '32', '16', '112', '116', '74', '80', '100022', '100023', '100024'];
    const audioQualityIds = ['30216', '30232', '30280', '30250', '30251'];
    
    try {
        const browser = await getBrowser();
        
        page = await browser.newPage();
        
        await page.setViewport({ width: 1280, height: 800 });
        await page.setExtraHTTPHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.bilibili.com/'
        });
        
        const videoUrls = [];
        const audioUrls = [];
        
        page.on('response', (response) => {
            const url = response.url();
            
            if (!url.includes('.m4s') || url.includes('/log/')) return;
            
            const match = url.match(/-1-(\d+)\.m4s/);
            if (match) {
                const qualityId = match[1];
                
                const isVideo = videoQualityIds.includes(qualityId) || 
                               parseInt(qualityId) < 200;
                
                const isAudio = audioQualityIds.includes(qualityId) ||
                               (parseInt(qualityId) >= 30200 && parseInt(qualityId) < 30300);
                
                if (isVideo || (videoQualityIds.includes(qualityId))) {
                    log(`发现视频流 (质量ID: ${qualityId}): ${url.substring(0, 120)}...`);
                    videoUrls.push(url);
                } else if (isAudio || audioQualityIds.includes(qualityId)) {
                    log(`发现音频流 (质量ID: ${qualityId}): ${url.substring(0, 120)}...`);
                    audioUrls.push(url);
                } else {
                    log(`发现未知类型流 (质量ID: ${qualityId}): ${url.substring(0, 120)}...`);
                    videoUrls.push(url);
                }
            }
        });
        
        log(`正在访问: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        
        await new Promise(resolve => setTimeout(resolve, 6000));
        
        const videoData = await page.evaluate(() => {
            const title = document.title.replace('- 哔哩哔哩 (゜-゜)つロ 乾杯~', '').trim() || 
                         document.querySelector('h1')?.textContent?.trim() || 
                         'B站视频';
            
            let playinfo = null;
            try {
                const scriptContent = document.documentElement.innerHTML;
                const match = scriptContent.match(/playinfo.{0,50}?(\{[\s\S]{0,10000}?\});/);
                if (match && match[1]) {
                    try {
                        const jsonStr = match[1];
                        const parsed = JSON.parse(jsonStr);
                        playinfo = parsed;
                    } catch (e) {}
                }
            } catch (e) {}
            
            return { title, playinfo };
        });
        
        let playinfoVideoUrl = null;
        let playinfoAudioUrl = null;
        
        if (videoData.playinfo && videoData.playinfo.data && videoData.playinfo.data.dash) {
            try {
                const dash = videoData.playinfo.data.dash;
                
                if (dash.video && dash.video.length > 0) {
                    const videoStream = dash.video[0];
                    if (videoStream.baseUrl) {
                        playinfoVideoUrl = videoStream.baseUrl;
                        log(`从playinfo提取视频URL: ${playinfoVideoUrl.substring(0, 120)}...`);
                    }
                }
                
                if (dash.audio && dash.audio.length > 0) {
                    const audioStream = dash.audio[0];
                    if (audioStream.baseUrl) {
                        playinfoAudioUrl = audioStream.baseUrl;
                        log(`从playinfo提取音频URL: ${playinfoAudioUrl.substring(0, 120)}...`);
                    }
                }
            } catch (e) {
                log(`从playinfo提取URL失败: ${e.message}`);
            }
        }
        
        log(`找到 ${videoUrls.length} 个视频地址, ${audioUrls.length} 个音频地址`);
        
        let finalVideoUrl = playinfoVideoUrl || (videoUrls.find(u => u.includes('.mp4')) || videoUrls[0]);
        let finalAudioUrl = playinfoAudioUrl || (audioUrls.length > 0 ? audioUrls[0] : null);
        
        if (finalVideoUrl) {
            log(`选择视频地址: ${finalVideoUrl.substring(0, 120)}...`);
            if (finalAudioUrl) {
                log(`选择音频地址: ${finalAudioUrl.substring(0, 120)}...`);
            } else {
                log(`警告: 未找到音频流，可能只有视频画面无声音`);
            }
            
            return {
                success: true,
                title: videoData.title,
                videoUrl: finalVideoUrl,
                audioUrl: finalAudioUrl,
                source: 'Bilibili Parser',
                thumbnail: null
            };
        }
        
        log(`未找到有效的视频地址`);
    } catch (e) {
        log(`B站解析失败: ${e.message}`);
    } finally {
        if (page) {
            try { await page.close(); } catch (e) {}
        }
        releaseBrowser();
    }

    return null;
}

// 豆包专用解析器 - 从链接层面获取无水印视频
async function tryDoubaoParser(url) {
    log('使用豆包专用解析器...');
    let page = null;

    try {
        const browser = await getBrowser();

        page = await browser.newPage();

        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15');
        await page.setExtraHTTPHeaders({
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Referer': 'https://www.doubao.com/'
        });

        const videoUrls = [];
        const seenUrls = new Set();

        page.on('response', async (response) => {
            const responseUrl = response.url();
            const contentType = response.headers()['content-type'] || '';
            const status = response.status();

            // 详细记录所有网络请求
            if (responseUrl.includes('doubao') || responseUrl.includes('bytegoofy') || responseUrl.includes('aweme') || responseUrl.includes('amemv')) {
                log(`[网络] ${status} ${responseUrl.substring(0, 120)} (type: ${contentType})`);
            }

            const isVideo = contentType.includes('video') ||
                           contentType.includes('mp4') ||
                           responseUrl.match(/\.(mp4|m3u8|ts)(\?|$)/i) ||
                           responseUrl.includes('aweme/v1/play') ||
                           responseUrl.includes('video/play') ||
                           responseUrl.includes('bytegoofy') ||
                           responseUrl.includes('tos-cn');

            if (isVideo) {
                if (seenUrls.has(responseUrl)) return;
                seenUrls.add(responseUrl);

                const lowerUrl = responseUrl.toLowerCase();

                let score = 30;
                // 注意：'wm'检查需要精确，避免误判videoweb等域名
                if (lowerUrl.includes('nwm') || lowerUrl.includes('no_watermark') || lowerUrl.includes('nowatermark')) {
                    score = 100;
                    log(`[豆包] 发现无水印链接: ${responseUrl.substring(0, 100)}...`);
                } else if (lowerUrl.includes('watermark') || lowerUrl.includes('playwm') || lowerUrl.match(/\/wm\//) || lowerUrl.match(/\?wm=/)) {
                    score = 15;
                    log(`[豆包] 发现带水印链接: ${responseUrl.substring(0, 100)}...`);
                } else if (lowerUrl.includes('.mp4') || lowerUrl.includes('aweme') || lowerUrl.includes('bytegoofy') || lowerUrl.includes('tos-cn')) {
                    score = 60;
                    log(`[豆包] 发现视频链接 (status:${status}, type:${contentType}): ${responseUrl.substring(0, 100)}...`);
                }

                videoUrls.push({ url: responseUrl, score });
            }
        });

        const resolvedUrl = await resolveUrl(url);
        log(`[豆包] 访问: ${resolvedUrl}`);

        // 等待页面加载完成，使用更稳健的方式
        let pageError = null;
        try {
            await page.goto(resolvedUrl, {
                waitUntil: ['domcontentloaded', 'networkidle2'],
                timeout: 30000
            });
        } catch (e) {
            pageError = e.message;
            log(`[豆包] 页面加载异常: ${pageError}`);
        }

        // 等待内容渲染
        await new Promise(resolve => setTimeout(resolve, 5000));

        // 检查页面状态
        const pageStatus = await page.evaluate(() => ({
            title: document.title,
            bodyText: document.body.innerText.substring(0, 200),
            url: window.location.href,
            hasVideo: document.querySelector('video') !== null,
            htmlLength: document.documentElement.innerHTML.length
        }));

        log(`[豆包] 页面状态: title="${pageStatus.title}", url="${pageStatus.url}", length=${pageStatus.htmlLength}`);

        // 检测404或错误页面
        const isErrorPage = pageStatus.bodyText.includes('404') ||
                           pageStatus.bodyText.includes('not found') ||
                           pageStatus.bodyText.includes('页面不存在') ||
                           pageStatus.title === '' ||
                           pageStatus.htmlLength < 500;

        if (isErrorPage) {
            log(`[豆包] 检测到错误页面，跳过解析`);
            throw new Error('页面无法访问或链接已失效');
        }

        // 简化：只检查页面状态，视频URL通过网络拦截获取
        log(`[豆包] 跳过复杂页面评估，使用网络拦截结果`);

        log(`[豆包] 网络拦截找到 ${videoUrls.length} 个视频链接`);

        if (videoUrls.length > 0) {
            videoUrls.sort((a, b) => b.score - a.score);
            const bestUrl = videoUrls[0];

            log(`[豆包] ✅ 找到最佳视频链接 (score: ${bestUrl.score}): ${bestUrl.url.substring(0, 80)}...`);

            let finalVideoUrl = bestUrl.url;

            return {
                success: true,
                title: pageStatus.title || '豆包视频',
                platform: '豆包',
                videoUrl: finalVideoUrl,
                source: 'doubao_network_intercept'
            };
        }

        log(`[豆包] ❌ 未找到视频链接`);
        throw new Error('未找到有效视频链接');
    } catch (e) {
        log(`[豆包] 解析失败: ${e.message}`);
        if (e.message.includes('页面无法访问') || e.message.includes('链接已失效')) {
            return { success: false, message: '豆包分享链接已失效或无法访问，请确认链接是否正确' };
        }
    } finally {
        if (page) {
            try { await page.close(); } catch (e) {}
        }
        releaseBrowser();
    }

    return null;
}

// B站快速解析器 - 使用官方API，秒级响应
async function tryBilibiliFastParser(url) {
    log('[B站] 尝试快速API解析...');

    try {
        // 1. 解析短链接（如果是 b23.tv）
        let finalUrl = url;
        if (url.includes('b23.tv')) {
            log(`[B站] 解析短链接: ${url}`);
            finalUrl = await resolveUrl(url);
            log(`[B站] 短链接已解析: ${finalUrl.substring(0, 80)}...`);
        }

        // 2. 提取BV号
        const bvMatch = finalUrl.match(/BV[a-zA-Z0-9]+/);
        if (!bvMatch) {
            log('[B站] 未找到BV号');
            return null;
        }
        const bvid = bvMatch[0];
        log(`[B站] 检测到BV号: ${bvid}`);

        // 3. 获取视频信息
        const infoUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
        log(`[B站] 请求视频信息...`);

        const infoRes = await axios.get(infoUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.bilibili.com/'
            },
            timeout: 10000
        });

        if (infoRes.data.code !== 0) {
            log(`[B站] 获取视频信息失败: ${infoRes.data.message}`);
            return null;
        }

        const videoInfo = infoRes.data.data;
        const title = videoInfo.title;
        const cid = videoInfo.pages[0].cid;
        const duration = videoInfo.duration;

        log(`[B站] 视频信息: ${title}, CID: ${cid}, 时长: ${duration}s`);

        // 4. 获取播放URL（使用 fnval=0 获取普通MP4直链，避免DASH格式URL时效问题）
        const playUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=0`;
        log(`[B站] 请求播放URL (fnval=0)...`);

        const playRes = await axios.get(playUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.bilibili.com/'
            },
            timeout: 10000
        });

        if (playRes.data.code !== 0) {
            log(`[B站] 获取播放URL失败: ${playRes.data.message}`);
            return null;
        }

        const durl = playRes.data.data.durl;
        if (!durl || !durl[0] || !durl[0].url) {
            log(`[B站] 未找到有效视频URL`);
            return null;
        }
        const videoUrl = durl[0].url;

        log(`[B站] API解析成功! 视频URL: ${videoUrl.substring(0, 80)}...`);

        return {
            success: true,
            title: title,
            videoUrl: videoUrl,
            audioUrl: null,
            source: 'bilibili_api',
            duration: duration,
            thumbnail: videoInfo.pic
        };

    } catch (e) {
        log(`[B站] API解析异常: ${e.message}`);
        return null;
    }
}

async function tryPuppeteer(url) {
    log('启动Puppeteer解析...');

    const isBilibili = url.includes('bilibili') || url.includes('b23.tv');
    const isDoubao = url.includes('doubao') || url.includes('v.doubao');

    // 对所有平台使用统一的通用解析器（豆包方法）
    // 豆包和抖音、B站都是字节跳动/Aweme技术，共享相似的链接结构
    if (isDoubao) {
        try {
            // 豆包先尝试API解析
            log(`[豆包] 开始解析，原始URL: ${url}`);
            const resolvedUrl = await resolveUrl(url);
            log(`[豆包] 解析后URL: ${resolvedUrl}`);

            const apiResult = await tryAPIsParallel(null, url, resolvedUrl);
            if (apiResult) {
                log(`[豆包] API解析成功! 视频URL: ${apiResult.videoUrl.substring(0, 80)}...`);
                return apiResult;
            }
            log(`[豆包] API解析失败，尝试专用解析器...`);

            // API失败后尝试专用解析器
            try {
                const doubaoResult = await tryDoubaoParser(url);
                if (doubaoResult && doubaoResult.success) {
                    log(`[豆包] 专用解析器成功! 视频URL: ${doubaoResult.videoUrl.substring(0, 80)}...`);
                    return doubaoResult;
                }
            } catch (e) {
                log(`[豆包] 专用解析器异常: ${e.message}`);
            }
            log(`[豆包] 所有解析方法均失败`);
        } catch (e) {
            log(`[豆包] 解析异常: ${e.message}`);
        }
    } else if (isBilibili) {
        // B站优先使用快速API解析（秒级响应）
        log(`[B站] 使用快速API解析器...`);
        try {
            const result = await tryBilibiliFastParser(url);
            if (result && result.success) {
                log(`[B站] API解析成功! 视频URL: ${result.videoUrl.substring(0, 80)}...`);
                return result;
            }
            log(`[B站] API解析失败，尝试浏览器解析...`);
        } catch (e) {
            log(`[B站] API解析异常: ${e.message}`);
        }
        
        // API失败后降级到浏览器解析
        log(`[B站] 使用通用解析器...`);
        try {
            const result = await tryDoubaoParser(url);
            if (result && result.success) {
                log(`[B站] 解析成功! 视频URL: ${result.videoUrl.substring(0, 80)}...`);
                return result;
            }
        } catch (e) {
            log(`[B站] 解析异常: ${e.message}`);
        }
    }

    const result = await tryDirectPuppeteer(url);
    if (result) return result;

    return null;
}

// 检查FFmpeg是否可用（异步）
// 探测必须用异步 spawn：Node 的 spawnSync 在本机启动这些大体积 exe（100~204MB）
// 会稳定返回 EBUSY，异步 spawn 则实测正常。曾经因此把所有候选误判成「不可用」，
// 结果是去水印整条链路静默降级（OpenCV 拿不到时长 → 输出 0 帧 → 判定异常）。
async function checkFfmpeg() {
    const isWin = process.platform === 'win32';
    const ffmpegPaths = isWin ? [
        path.join(__dirname, 'tools', 'ffmpeg.exe'),
        path.join(__dirname, 'ffmpeg.exe'),
        // 应用控制策略(AppLocker/WDAC)可能封禁上面的大体积二进制，
        // 这里是 pip imageio-ffmpeg 提供的备选版本（已实测可正常执行）
        path.join(__dirname, 'tools', 'ffmpeg_alt.exe'),
        'D:/app/Python313/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe',
        'ffmpeg'
    ] : [
        'ffmpeg',
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        path.join(__dirname, 'tools', 'ffmpeg')
    ];

    // 只判断存在是不够的：文件存在但被系统策略封锁时，
    // 后续所有调用都会失败，且错误会被吞掉，最终表现为"水印没去掉"。
        // 异步 spawn + 校验真实输出（只查文件存在会被 AppLocker/WDAC 骗过）
        const runnable = (ffmpegPath) => new Promise((resolve) => {
            let settled = false;
            let out = '';
            const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
            let child;
            try {
                child = spawn(ffmpegPath, ['-version'], { windowsHide: true });
            } catch (e) {
                log(`!! FFmpeg探测启动异常(${ffmpegPath}): ${e.message}`);
                return finish(false);
            }
            child.stdout.on('data', (d) => { out += d; });
            child.stderr.on('data', (d) => { out += d; });
            child.on('error', (err) => {
                // 探测自身出错（缺少二进制、权限等）绝不能悄悄当成"被策略封禁"，
                // 否则会一路兜到根本不存在的裸 ffmpeg，表现为 spawn ENOENT。
                log(`!! FFmpeg探测自身异常(${ffmpegPath}): ${err.message}`);
                finish(false);
            });
            child.on('close', (code) => finish(code === 0 && /ffmpeg version/i.test(out)));
            setTimeout(() => {
                try { child.kill(); } catch (e) {}
                finish(false);
            }, 20000);
        });

        // 该路径是否是可自证可靠的"系统级候选"：
        // 不能只用 path.sep 判断——Windows 路径常写成 'D:/xx/ffmpeg.exe'（斜杠），
        // 那样会被误判成系统命令而跳过可执行性校验。
        const isSystemCandidate = (ffmpegPath) => !/[\\/]/.test(ffmpegPath);

    for (const ffmpegPath of ffmpegPaths) {
        try {
            if (isSystemCandidate(ffmpegPath)) {
                // 裸命令名也要验一遍：PATH 里没有 ffmpeg 时会直接 spawn ENOENT
                if (await runnable(ffmpegPath)) {
                    log(`找到可用FFmpeg: ${ffmpegPath}`);
                    return ffmpegPath;
                }
                log(`⚠️ 系统FFmpeg不可用: ${ffmpegPath}`);
                continue;
            }

            if (fs.existsSync(ffmpegPath) && await runnable(ffmpegPath)) {
                log(`找到可用FFmpeg: ${ffmpegPath}`);
                return ffmpegPath;
            }
            if (fs.existsSync(ffmpegPath)) {
                // 打真实原因：只说"可能被封禁"会掩盖真正的问题（路径/权限/沙箱/超时）
                let reason = 'unknown';
                try {
                    // 同样走异步 spawn：同步 spawnSync 在这类 exe 上只会得到 EBUSY，
                    // 会把「其实能用」误报成「被策略封禁」，误导排查方向。
                    const diag = await new Promise((resolveDiag) => {
                        let o = '';
                        const c = spawn(ffmpegPath, ['-version'], { windowsHide: true });
                        c.stdout.on('data', (d) => { o += d; });
                        c.stderr.on('data', (d) => { o += d; });
                        c.on('error', (e) => resolveDiag({ error: e.code + ':' + e.message, out: o }));
                        c.on('close', () => resolveDiag({ error: 'none', out: o }));
                        setTimeout(() => {
                            try { c.kill(); } catch (e) {}
                            resolveDiag({ error: 'timeout', out: o });
                        }, 20000);
                    });
                    reason = `error=${diag.error} outLen=${(diag.out || '').length}`;
                } catch (e) {
                    reason = 'spawn threw: ' + e.message;
                }
                log(`⚠️ 发现FFmpeg但无法执行: ${ffmpegPath} | ${reason}`);
            }
        } catch (e) {
            log(`检查FFmpeg失败: ${e.message}`);
            continue;
        }
    }

    log('警告: 未找到可执行的FFmpeg，视频处理功能可能受限');
    return null;
}

// 下载单个文件的辅助函数
async function downloadSingleFile(url, referer, outputPath) {
    try {
        const response = await axios.get(url, {
            responseType: 'stream',
            timeout: 300000,
            maxRedirects: 5,
            headers: {
                'Referer': referer,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Accept-Encoding': 'identity',
                'Connection': 'keep-alive',
                'Range': 'bytes=0-'
            }
        });
        
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        return { success: true, path: outputPath };
    } catch (e) {
        log(`下载文件失败: ${e.message}`);
        return { success: false, error: e.message };
    }
}

// 使用FFmpeg合并视频和音频 (使用spawn方式)
async function mergeVideoAudio(videoPath, audioPath, outputPath, ffmpegPath) {
    try {
        log('正在合并音视频...');
        await spawnFfmpeg(ffmpegPath, [
            '-i', videoPath, '-i', audioPath,
            '-c:v', 'copy', '-c:a', 'copy', '-y', outputPath
        ], 180000);
        log('音视频合并成功');
        return { success: true };
    } catch (e) {
        log(`音视频合并失败: ${e.message}`);
        return { success: false, error: e.message };
    }
}

// [Old removeWatermark function removed - now using watermark_remover.js module]

// 优化moov头位置，确保视频支持流式播放
async function ensureFastStart(videoPath, ffmpegPath, taskId) {
    if (!ffmpegPath || !fs.existsSync(videoPath)) return;
    const tempPath = videoPath.replace('.mp4', '_temp.mp4');
    try {
        await spawnFfmpeg(ffmpegPath, [
            '-i', videoPath,
            '-c:v', 'copy',
            '-c:a', 'copy',
            '-movflags', '+faststart',
            '-y', tempPath
        ], 120000, taskId);
        // 替换原文件
        safeUnlink(videoPath);
        fs.renameSync(tempPath, videoPath);
        log(`已优化视频moov位置: ${videoPath}`);
    } catch (e) {
        // 把 ffmpeg 的 stderr 摘要打出来，否则 exit code 1 永远是黑盒
        const tail = (e.stderr || '').split('\n').filter(l => /Error|error|Failed|Invalid|unable|Invalid data/i.test(l)).slice(-3).join(' | ');
        log(`moov优化失败: ${e.message}${tail ? ' | ' + tail : ''}`);
        safeUnlink(tempPath);
    }
}

// 最终产物统一封装：downloadVideo 里有两条成功返回路径（「直接保留原文件」的早退分支
// 与「转码 + 去水印」的常规分支），以前各拼一份同样的字段，改一处漏一处。
// 现在统一走这里，保证前端拿到的文件信息 + 去水印结果字段永远一致。
function packFinalResult(finalFilePath, finalFilename, wmResult, wmMs = 0) {
    let fileSize = 0;
    try {
        fileSize = fs.statSync(finalFilePath).size;
    } catch (e) {
        log(`取最终文件大小失败: ${e.message}`);
    }
    const removed = !!(wmResult && wmResult.removed);
    return {
        success: true,
        filePath: finalFilePath,
        filename: finalFilename,
        fileSize,
        watermarkRemoved: removed,
        watermarkMethod: (wmResult && wmResult.method) || null,
        watermarkWarning: removed ? null : ((wmResult && wmResult.error) || '水印未去除'),
        // OpenCV inpaint 约 2.6fps，长视频可能跑十几分钟，耗时对前端展示很重要
        watermarkDurationMs: removed ? wmMs : 0
    };
}

async function downloadVideo(videoUrl, title, audioUrl = null, platform = 'general', taskId) {
    // 接口已经被总超时判死，别再启动下载这种长活
    if (taskId && isTaskAborted(taskId)) {
        log('[下载] 任务已终止，跳过下载');
        return { success: false, error: '任务已终止（接口超时）' };
    }
    try {
        setTaskStage(taskId, 'download', '正在下载视频');
        let referer = 'https://www.douyin.com/';
        if (videoUrl.includes('bilivideo') || videoUrl.includes('bilibili')) {
            referer = 'https://www.bilibili.com/';
        } else if (videoUrl.includes('doubao') || platform === '豆包') {
            // 豆包是字节跳动产品，尝试多个referer
            const doubaoReferers = [
                'https://www.doubao.com/',
                'https://doubao.com/',
                'https://www.douyin.com/',
                'https://v.doubao.com/'
            ];
            referer = doubaoReferers[0];
        }
        
        const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
        const timestamp = Date.now();
        const ffmpegPath = await checkFfmpeg();
        
        // 确定文件扩展名
        const isBilibili = videoUrl.includes('bilivideo') || videoUrl.includes('bilibili');
        const isM4s = videoUrl.includes('.m4s');
        
        // 根据原始URL重新判断平台（比videoUrl更准确）
        // platform参数已经在parse路由中根据原始URL判断，这里直接使用

        // 生成唯一文件名 - 使用URL哈希避免重复下载
        const urlHash = require('crypto').createHash('md5').update(videoUrl).digest('hex').substring(0, 8);
        let finalFilePath, finalFilename;
        finalFilename = `${safeTitle}_${urlHash}.mp4`;
        finalFilePath = path.join(DOWNLOAD_DIR, finalFilename);
        
        // 验证音频URL是否有效（排除明显的日志URL）
        let validAudioUrl = audioUrl;
        if (audioUrl && (audioUrl.includes('/log/') || !audioUrl.includes('.m4s'))) {
            log(`音频URL无效，忽略: ${audioUrl.substring(0, 80)}...`);
            validAudioUrl = null;
        }
        
        // 如果是B站.m4s文件且FFmpeg可用，下载并正确封装
        if (isBilibili && isM4s && ffmpegPath) {
            log('处理B站DASH格式视频...');
            
            // 下载视频
            const tempVideoPath = path.join(DOWNLOAD_DIR, `${safeTitle}_v_${timestamp}.m4s`);
            const videoResult = await downloadSingleFile(videoUrl, referer, tempVideoPath);
            if (!videoResult.success) {
                safeUnlink(tempVideoPath);
                return videoResult;
            }
            
            // 验证下载的视频文件是否有效
            const videoFileSize = fs.statSync(tempVideoPath).size;
            log(`视频文件大小: ${videoFileSize} bytes`);
            
            let tempAudioPath = null;
            let audioDownloadSuccess = false;
            
            // 下载音频（如果有有效URL）
            if (validAudioUrl) {
                tempAudioPath = path.join(DOWNLOAD_DIR, `${safeTitle}_a_${timestamp}.m4s`);
                const audioResult = await downloadSingleFile(validAudioUrl, referer, tempAudioPath);
                audioDownloadSuccess = audioResult.success;
                
                if (audioDownloadSuccess) {
                    const audioFileSize = fs.statSync(tempAudioPath).size;
                    log(`音频文件大小: ${audioFileSize} bytes`);
                    
                    // 检查音频文件是否有效（至少有内容）
                    if (audioFileSize < 1024) {
                        log(`音频文件太小，可能无效`);
                        audioDownloadSuccess = false;
                    }
                }
            }
            
            if (audioDownloadSuccess && tempAudioPath) {
                // 尝试使用FFmpeg合并音视频
                log('正在合并音视频...');
                try {
                    // 先尝试直接复制流（更快）
                    await spawnFfmpeg(ffmpegPath, [
                        '-i', tempVideoPath, '-i', tempAudioPath,
                        '-c:v', 'copy', '-c:a', 'copy', '-y', finalFilePath
                    ], 180000);
                    
                    // 验证输出文件
                    if (fs.existsSync(finalFilePath) && fs.statSync(finalFilePath).size > 0) {
                        // 清理临时文件
                        safeUnlink(tempVideoPath);
                        safeUnlink(tempAudioPath);
                        
                        const stats = fs.statSync(finalFilePath);
                        log(`音视频合并完成 (copy模式): ${stats.size} bytes`);
                    } else {
                        log('合并失败，文件不存在或为空');
                        audioDownloadSuccess = false;
                    }
                } catch (e) {
                    log(`音视频合并失败: ${e.message.substring(0, 100)}`);
                    audioDownloadSuccess = false;
                }
            } else {
                log('跳过音频合并或合并失败');
            }
            
            // 如果没有成功合并或没有音频，只处理视频流
            if (!audioDownloadSuccess || !fs.existsSync(finalFilePath)) {
                log('仅处理视频流...');
                try {
                    // 检查视频文件是否有视频轨道
                    let probeOutput = '';
                    try {
                        const probeResult = await spawnFfmpeg(ffmpegPath, ['-i', tempVideoPath, '-hide_banner'], 30000);
                        probeOutput = probeResult.stderr;
                    } catch (e) {
                        probeOutput = (e.stderr || '') + (e.message || '');
                    }
                    
                    // 判断是否有视频轨道
                    const hasVideoTrack = probeOutput.includes('Video:') || probeOutput.includes('视频:');
                    const hasAudioTrack = probeOutput.includes('Audio:') || probeOutput.includes('音频:');
                    
                    log(`文件分析: 视频=${hasVideoTrack}, 音频=${hasAudioTrack}`);
                    
                    if (hasVideoTrack) {
                        // 有视频轨道，尝试封装为MP4
                        const args = hasAudioTrack
                            ? ['-i', tempVideoPath, '-c:v', 'copy', '-c:a', 'copy', '-y', finalFilePath]
                            : ['-i', tempVideoPath, '-c:v', 'copy', '-y', finalFilePath];
                        
                        await spawnFfmpeg(ffmpegPath, args, 120000);
                        
                        if (fs.existsSync(finalFilePath) && fs.statSync(finalFilePath).size > 0) {
                            safeUnlink(tempVideoPath);
                            safeUnlink(tempAudioPath);
                            
                            const stats = fs.statSync(finalFilePath);
                            log(`视频封装完成: ${stats.size} bytes`);
                        }
                    } else {
                        log(`警告: 下载的文件没有视频轨道!`);
                        // 没有视频轨道，直接返回原始文件
                        try {
                            fs.renameSync(tempVideoPath, finalFilePath);
                        } catch (e2) {
                            safeUnlink(tempVideoPath);
                            log(`重命名失败: ${e2.message}`);
                        }
                        log(`已保留原始文件`);
                    }
                } catch (e) {
                    log(`视频处理失败: ${e.message.substring(0, 100)}`);
                    // 失败时返回原始文件
                    try {
                        fs.renameSync(tempVideoPath, finalFilePath);
                    } catch (e2) {
                        safeUnlink(tempVideoPath);
                        log(`重命名失败: ${e2.message}`);
                    }
                }
            }
            
            // 所有成功路径统一执行到这里 - 执行去水印处理
            if (fs.existsSync(finalFilePath) && fs.statSync(finalFilePath).size > 100000) {
                log(`视频处理完成，准备去水印 (平台: ${platform})...`);
                setTaskStage(taskId, 'process', '封装转码中');
                setTaskStage(taskId, 'watermark', '正在去除水印（长视频可能较慢）');

                // 执行去水印处理 - 使用传入的platform参数
                const wmStart = Date.now();
                const wmResult = await removeWatermark(finalFilePath, ffmpegPath, platform, taskId);
                const wmMs = Date.now() - wmStart;
                if (wmResult.removed) {
                    log(`水印去除完成 (${wmResult.method}, 耗时 ${Math.round(wmMs / 1000)}s)`);
                } else if (wmResult.skipped) {
                    log('已跳过去水印处理');
                } else {
                    // 水印没去掉，但要如实告知，避免用户拿到带水印文件还以为成功
                    log(`⚠️ 水印未去除: ${wmResult.error || '未知错误'}`);
                }

                // 优化moov位置支持流式播放
                await ensureFastStart(finalFilePath, ffmpegPath, taskId);
                return packFinalResult(finalFilePath, finalFilename, wmResult, wmMs);
            }
        } else if (!isM4s && !ffmpegPath) {
            // 普通MP4文件或没有FFmpeg，直接下载
            log('直接下载视频文件...');
            const downloadResult = await downloadSingleFile(videoUrl, referer, finalFilePath);
            if (!downloadResult.success) {
                return downloadResult;
            }
            // 添加faststart优化，将moov移到文件开头支持流式播放
            await ensureFastStart(finalFilePath, ffmpegPath, taskId);
        } else if (isM4s && ffmpegPath) {
            // 只有视频URL的.m4s文件
            log('处理单文件.m4s视频...');
            const tempPath = path.join(DOWNLOAD_DIR, `${safeTitle}_temp_${timestamp}.m4s`);
            const downloadResult = await downloadSingleFile(videoUrl, referer, tempPath);
            
            if (downloadResult.success) {
                try {
                    await spawnFfmpeg(ffmpegPath, ['-i', tempPath, '-c:v', 'copy', '-c:a', 'copy', '-y', finalFilePath], 120000);
                    safeUnlink(tempPath);
                    
                    const stats = fs.statSync(finalFilePath);
                    log(`视频封装完成: ${stats.size} bytes`);
                } catch (e) {
                    log(`转换失败，保留原始文件: ${e.message}`);
                    try {
                        fs.renameSync(tempPath, finalFilePath);
                    } catch (e2) {
                        safeUnlink(tempPath);
                    }
                }
            } else {
                safeUnlink(tempPath);
                return downloadResult;
            }
        } else {
            // 直接下载
            log(`开始下载视频 (URL: ${videoUrl.substring(0, 80)}...)`);
            const downloadResult = await downloadSingleFile(videoUrl, referer, finalFilePath);
            if (!downloadResult.success) {
                log(`首次下载失败，尝试更换referer重试...`);
                // 豆包视频可能需要特殊referer，尝试多个referer
                const fallbackReferers = [
                    'https://www.doubao.com/',
                    'https://doubao.com/',
                    'https://www.douyin.com/',
                    'https://v.doubao.com/',
                    '',
                ];
                
                let retrySuccess = false;
                for (const altReferer of fallbackReferers) {
                    log(`尝试referer: ${altReferer || '(空)'}`);
                    const retryResult = await downloadSingleFile(videoUrl, altReferer, finalFilePath);
                    if (retryResult.success) {
                        const fileSize = fs.statSync(finalFilePath).size;
                        if (fileSize > 100000) {
                            log(`使用referer "${altReferer || '(空)'}" 下载成功 (${fileSize} bytes)`);
                            retrySuccess = true;
                            break;
                        } else {
                            log(`文件过小 (${fileSize} bytes)，继续尝试...`);
                        }
                    }
                }
                
                if (!retrySuccess) {
                    log(`所有referer尝试失败，返回最后一次结果`);
                    return downloadResult;
                }
            } else {
                const fileSize = fs.statSync(finalFilePath).size;
                log(`下载成功: ${fileSize} bytes`);
            }
            // 添加faststart优化，将moov移到文件开头支持流式播放
            await ensureFastStart(finalFilePath, ffmpegPath, taskId);
        }
        
        // 执行去水印处理（所有路径统一执行）
        setTaskStage(taskId, 'process', '封装转码中');
        setTaskStage(taskId, 'watermark', '正在去除水印（长视频可能较慢）');
        // 注意：wmResult 必须在 if 块「外面」初始化。
        // 它原先声明在 if 块内的 const，却在函数末尾的 return 里访问，
        // 一旦 if 未执行（文件不存在）或块结束后就抛 ReferenceError，
        // 最终表现为接口返回 success:false、前端拿不到视频（"没有内容画面"）。
        let wmResult = { success: false, removed: false, skipped: false, method: null, error: '未执行去水印' };
        let wmStart = 0;
        if (fs.existsSync(finalFilePath)) {
            wmStart = Date.now();
            wmResult = await removeWatermark(finalFilePath, ffmpegPath, platform, taskId);
            if (wmResult.removed) {
                log(`水印去除完成 (${wmResult.method}, 耗时 ${Math.round((Date.now() - wmStart) / 1000)}s)`);
            } else if (wmResult.skipped) {
                log('已跳过去水印处理');
            } else if (!wmResult.success || wmResult.error) {
                // 水印处理失败，记录错误但不阻塞流程
                log(`水印处理失败: ${wmResult.error || '未知错误'}`);
            }

            // 清理OpenCV inpainting生成的临时文件
            try {
                const inpaintFile = finalFilePath.replace('.mp4', '_inpaint.mp4');
                if (fs.existsSync(inpaintFile)) {
                    fs.unlinkSync(inpaintFile);
                    log(`已清理临时文件: ${path.basename(inpaintFile)}`);
                }
            } catch (e) {
                log(`清理临时文件失败: ${e.message}`);
            }
            // 优化moov位置支持流式播放
            await ensureFastStart(finalFilePath, ffmpegPath, taskId);
        }

        const stats = fs.statSync(finalFilePath);
        log(`视频下载完成: ${stats.size} bytes`);
        
        // 检查视频编码，非浏览器友好编码（HEVC/hvc1、mp4v 等）统一转码为 H.264。
        // 这条是「解析出来的视频没有内容画面」的直接来源之一：
        // 部分浏览器/播放器解不了 HEVC 或 MPEG-4 Part2，表现为黑屏，而不是报错。
        if (ffmpegPath) {
            try {
                let probeOutput = '';
                try {
                    const probeResult = await spawnFfmpeg(ffmpegPath, ['-i', finalFilePath, '-hide_banner'], 30000);
                    probeOutput = probeResult.stderr;
                } catch (e) {
                    probeOutput = (e.stderr || '') + (e.message || '');
                }

                const isHEVC = probeOutput.includes('hevc') || probeOutput.includes('hvc1') || probeOutput.includes('hev1');
                const isMPEG4Part2 = probeOutput.includes('mpeg4') && !probeOutput.includes('mpeg4vue');
                const isH264 = /h264|avc1/i.test(probeOutput) && !isHEVC;
                const hasAudio = probeOutput.includes('Audio:') || probeOutput.includes('音频:');

                if (!isH264 || isHEVC || isMPEG4Part2) {
                    log(`视频编码非H.264（hevc=${isHEVC} mp4v=${isMPEG4Part2}），开始转码为H.264（兼容浏览器播放）...`);
                    const transcodedPath = finalFilePath.replace('.mp4', '_transcoded.mp4');
                    const ffmpegThreads = parseInt(process.env.FFMPEG_THREADS || '1');

                    // -pix_fmt yuv420p 是浏览器硬解的硬要求；+faststart 让 moov 落到文件头，支持边下边播
                    const args = ['-i', finalFilePath, '-y',
                        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
                        '-pix_fmt', 'yuv420p', '-threads', String(ffmpegThreads),
                        '-movflags', '+faststart',
                        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100'];
                    if (!hasAudio) args.push('-an', '-shortest');
                    args.push(transcodedPath);

                    try {
                        await spawnFfmpeg(ffmpegPath, args, FFMPEG_TIMEOUT);
                        
                        if (fs.existsSync(transcodedPath) && fs.statSync(transcodedPath).size > 100000) {
                            safeUnlink(finalFilePath);
                            fs.renameSync(transcodedPath, finalFilePath);
                            
                            const newStats = fs.statSync(finalFilePath);
                            log(`非H.264转H.264完成 (${newStats.size} bytes)`);
                        } else {
                            log(`转码失败，保留原始HEVC文件`);
                            safeUnlink(transcodedPath);
                        }
                    } catch (e) {
                        log(`HEVC转码失败: ${e.message}`);
                        safeUnlink(transcodedPath);
                    }
                }
            } catch (e) {
                log(`视频编码检查失败: ${e.message}`);
            }
        }
        
        const finalStats = fs.statSync(finalFilePath);
        log(`最终文件大小 (去水印后): ${finalStats.size} bytes`);
        const wmEnd = Date.now();
        const wmMs = wmStart ? wmEnd - wmStart : 0;
        log(`去水印阶段耗时: ${Math.round(wmMs / 1000)}s`);
        return packFinalResult(finalFilePath, finalFilename, wmResult, wmMs);
    } catch (e) {
        log(`下载失败: ${e.message}`);
        return { success: false, error: e.message };
    }
}

async function getVideoSize(videoUrl) {
    try {
        let referer = 'https://www.douyin.com/';
        if (videoUrl.includes('bilivideo') || videoUrl.includes('bilibili')) {
            referer = 'https://www.bilibili.com/';
        } else if (videoUrl.includes('doubao')) {
            referer = 'https://www.doubao.com/';
        }
        
        const response = await axios.head(videoUrl, {
            timeout: 10000,
            headers: {
                'Referer': referer,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        return parseInt(response.headers['content-length']) || null;
    } catch (e) {
        return null;
    }
}

async function checkFileSizeLimit(videoUrl) {
    const size = await getVideoSize(videoUrl);
    if (size && size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        return { exceeded: true, size, limit: MAX_FILE_SIZE_MB * 1024 * 1024 };
    }
    return { exceeded: false, size };
}

function detectPlatform(url) {
    if (url.includes('douyin') || url.includes('v.douyin')) return '抖音';
    if (url.includes('bilibili') || url.includes('b23.tv')) return 'B站';
    if (url.includes('doubao') || url.includes('v.doubao')) return '豆包';
    return '未知';
}

const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL || '2');
let activeTasks = 0;
const taskQueue = [];

async function runWithConcurrencyLimit(fn) {
    if (activeTasks >= MAX_PARALLEL) {
        await new Promise(resolve => taskQueue.push(resolve));
    }
    activeTasks++;
    try {
        return await fn();
    } finally {
        activeTasks--;
        if (taskQueue.length > 0) {
            const next = taskQueue.shift();
            next();
        }
    }
}

const FILE_EXPIRE_HOURS = parseInt(process.env.FILE_EXPIRE_HOURS || '2');

function cleanOldFiles() {
    try {
        const files = fs.readdirSync(DOWNLOAD_DIR);
        const now = Date.now();
        const expireMs = FILE_EXPIRE_HOURS * 60 * 60 * 1000;
        let deletedCount = 0;
        let freedBytes = 0;

        for (const file of files) {
            try {
                const filePath = path.join(DOWNLOAD_DIR, file);
                const stat = fs.statSync(filePath);
                const age = now - stat.mtime.getTime();

                // 清理临时文件（inpaint、transcoded、temp_*等）
                const isTempFile = file.startsWith('temp_') ||
                                   file.includes('_inpaint') ||
                                   file.includes('_transcoded') ||
                                   file.endsWith('.m4s');

                if (age > expireMs || isTempFile) {
                    freedBytes += stat.size;
                    fs.unlinkSync(filePath);
                    deletedCount++;
                    if (isTempFile) {
                        log(`清理临时文件: ${file}`);
                    }
                }
            } catch (e) {
                continue;
            }
        }

        if (deletedCount > 0) {
            log(`清理过期文件: 删除 ${deletedCount} 个, 释放 ${Math.round(freedBytes/1024/1024)}MB`);
        }
    } catch (e) {
        log(`清理文件异常: ${e.message}`);
    }
}

setInterval(cleanOldFiles, 15 * 60 * 1000);

function logMemoryUsage() {
    const mem = process.memoryUsage();
    log(`内存使用: RSS=${Math.round(mem.rss/1024/1024)}MB, Heap=${Math.round(mem.heapUsed/1024/1024)}/${Math.round(mem.heapTotal/1024/1024)}MB, 活跃任务=${activeTasks}`);
}

async function checkMemoryPressure() {
    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    
    if (rssMB > MEMORY_THRESHOLD_MB) {
        log(`⚠️ 内存压力警告: RSS=${rssMB}MB, 阈值=${MEMORY_THRESHOLD_MB}MB, 开始主动释放资源...`);
        
        if (browserInstance && browserRefCount <= 0) {
            log('主动关闭空闲浏览器...');
            await closeBrowser().catch(() => {});
        }
        
        log('主动清理旧文件...');
        cleanOldFiles();
        
        if (global.gc) {
            try {
                global.gc();
                log('已触发V8垃圾回收');
            } catch (e) {}
        }
        
        const memAfter = process.memoryUsage();
        log(`内存释放后: RSS=${Math.round(memAfter.rss/1024/1024)}MB`);
    }
}

setInterval(logMemoryUsage, 5 * 60 * 1000);
setInterval(checkMemoryPressure, 2 * 60 * 1000);

app.post('/api/parse', async (req, res) => {
    const { url, platform = 'auto' } = req.body;

    if (!url) {
        return res.json({ success: false, message: '请提供视频链接' });
    }

    // 前端先生成 taskId 带过来，用于阶段进度查询 + 总超时精确 kill 本任务的子进程
    const taskId = createTask(req.body.taskId);

    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    if (rssMB > MEMORY_THRESHOLD_MB * 1.2) {
        log(`⚠️ 内存过高 (${rssMB}MB)，拒绝新请求`);
        return res.json({
            success: false,
            message: '服务器内存压力较大，请稍后重试'
        });
    }

    log(`开始解析: ${url} (当前活跃: ${activeTasks}/${MAX_PARALLEL})`);

    // 直接处理，不通过runWithConcurrencyLimit包装（避免return丢失问题）
    const startTime = Date.now();
    let result = null;

    // 接口级总超时：到点强制终止本任务（kill 进程树 + 清临时文件），
    // 否则长视频会把请求无限挂住，用户侧只能干等着看进度条不动。
    let responded = false;
    const answer = (payload) => {
        if (responded) return;
        responded = true;
        res.json(payload);
    };
    const overallTimer = setTimeout(() => {
        terminateTask(taskId, `处理超过 ${TIMEOUT_LABEL} 上限`);
        answer({
            success: false,
            timedOut: true,
            message: `处理超时（上限 ${TIMEOUT_LABEL}），已终止当前任务并清理临时文件，请尝试更短的视频`
        });
    }, PARSE_TIMEOUT);

    try {
        activeTasks++;
        setTaskStage(taskId, 'resolve', '正在解析页面，获取视频地址');
        const resolvedUrl = await resolveUrl(url);

        // 抖音 / 自动识别：先用第三方 API（无浏览器依赖、更快），没命中再退回浏览器解析；
        // 其余平台（B站、快手、豆包）没有可用 API，直接走浏览器解析。
        if (platform === 'douyin' || platform === 'auto') {
            result = await tryAPIsParallel(null, url, resolvedUrl);
            setTaskStage(taskId, 'resolve', result ? '已获取视频地址（第三方接口）' : '第三方接口未命中，改用浏览器解析');
            if (!result) {
                try {
                    result = await tryPuppeteer(resolvedUrl);
                } catch (browserErr) {
                    log(`Puppeteer浏览器解析失败: ${browserErr.message}`);
                }
            }
        } else {
            try {
                result = await tryPuppeteer(resolvedUrl);
            } catch (browserErr) {
                log(`Puppeteer浏览器解析失败: ${browserErr.message}`);
            }
        }

        if (result) {
            setTaskStage(taskId, 'download', '正在下载视频');
            const platformType = detectPlatform(url);
            const downloadResult = await downloadVideo(result.videoUrl, result.title, result.audioUrl, platformType, taskId);
            if (downloadResult.success) {
                const parseDuration = Math.floor((Date.now() - startTime) / 1000);
                log(`解析完成! 解析耗时: ${parseDuration}s, 文件: ${downloadResult.filename}`);
                finishTask(taskId, `完成（${parseDuration}s）`);

                return answer({
                    success: true,
                    taskId,
                    title: result.title,
                    platform: platformType,
                    videoUrl: result.videoUrl,
                    // 下载不再自动触发：这个地址只在用户点「下载视频」时才落盘/触发浏览器下载
                    downloadUrl: `/download/${encodeURIComponent(downloadResult.filename)}`,
                    outputFilename: downloadResult.filename,
                    downloadPath: downloadResult.filePath,
                    fileSize: downloadResult.fileSize,
                    source: result.source,
                    parseDuration,
                    // 去水印结果如实透传：前端据此渲染「已去除 / 未去除」与所用方法
                    watermarkRemoved: !!downloadResult.watermarkRemoved,
                    watermarkMethod: downloadResult.watermarkMethod || null,
                    watermarkWarning: downloadResult.watermarkWarning || null,
                    watermarkDurationMs: downloadResult.watermarkDurationMs || 0
                });
            } else {
                log(`下载失败: ${downloadResult.error}`);
                finishTask(taskId, '下载失败');
                return answer({
                    success: true,
                    taskId,
                    title: result.title,
                    platform: platformType,
                    videoUrl: result.videoUrl,
                    downloadUrl: null,
                    message: '解析成功，但下载失败，请手动复制链接下载'
                });
            }
        } else {
            const duration = Math.floor((Date.now() - startTime) / 1000);
            log(`所有方法均失败，耗时: ${duration}s`);
            return answer({
                success: false,
                taskId,
                message: '无法获取视频地址 - 所有方法均失败，请尝试其他链接'
            });
        }
    } catch (e) {
        log(`解析异常: ${e.message}`);
        return answer({
            success: false,
            taskId,
            message: `解析失败: ${e.message}`
        });
    } finally {
        clearTimeout(overallTimer);
        unregisterTaskChild(taskId);
        activeTasks--;
    }
});

// 任务阶段进度查询：前端轮询这个接口更新进度条和文案
app.get('/api/progress', (req, res) => {
    const st = taskStates.get(req.query.task);
    if (!st) return res.json({ found: false });
    res.json({
        found: true,
        stage: st.stage,
        label: st.label,
        message: st.message,
        progress: st.progress,
        timedOut: !!st.timedOut,
        elapsed: Math.round((Date.now() - st.startTime) / 1000)
    });
});

// 文件地址同一条路由两种用法：
//   /download/xxx.mp4           → 内联，供结果区 <video> 在线预览（streaming）
//   /download/xxx.mp4?dl=1      → attachment，用户点「下载视频」时才真正存到本地
// 之前预览和下载共用内联响应，点下载时浏览器可能只是播放而不落盘。
app.get('/download/:filename', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = path.join(DOWNLOAD_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, message: '文件已过期或不存在（默认 2 小时自动清理）' });
    }

    if (req.query.dl === '1') {
        // filename*=UTF-8'' 是 RFC5987 写法，中文标题才不会变成乱码文件名
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.setHeader('Content-Type', 'application/octet-stream');
    } else {
        res.setHeader('Content-Type', 'video/mp4');
    }

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(filePath, (err) => {
        if (err) {
            log(`文件发送失败 ${filename}: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: '文件读取失败，请重试' });
            }
        }
    });
});

app.get('/api/status', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: 'running',
        download_dir: DOWNLOAD_DIR,
        browser_ready: browserReady,
        browser_ref_count: browserRefCount,
        active_tasks: activeTasks,
        max_parallel: MAX_PARALLEL,
        parse_timeout_sec: Math.round(PARSE_TIMEOUT / 1000),
        active_tasks_detail: [...taskStates.entries()]
            .filter(([, st]) => !st.timedOut && st.progress < 100)
            .map(([id, st]) => ({ task: id, stage: st.stage, label: st.label, progress: st.progress })),
        file_expire_hours: FILE_EXPIRE_HOURS,
        memory: {
            rss_mb: Math.round(mem.rss / 1024 / 1024),
            heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
            heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024)
        },
        timestamp: new Date().toISOString()
    });
});

process.on('SIGINT', async () => {
    log('收到停止信号，关闭浏览器...');
    await closeBrowser();
    process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('\n==========================================');
    console.log('  VideoCleaner - AI自动视频去水印工具');
    console.log('==========================================');
    console.log(`  服务端口: ${PORT}`);
    console.log(`  下载目录: ${DOWNLOAD_DIR}`);
    console.log(`  最大并发: ${MAX_PARALLEL}`);
    console.log(`  文件过期: ${FILE_EXPIRE_HOURS}小时`);
    console.log('==========================================\n');
    
    if (process.env.PRESTART_BROWSER === 'true') {
        getBrowser().then(() => {
            console.log(`\n✅ 服务启动完成! 浏览器已预热`);
            console.log(`  访问 http://localhost:${PORT}\n`);
        }).catch((e) => {
            console.log(`\n⚠️ 浏览器预热失败: ${e.message}`);
            console.log(`  服务仍可正常运行，首次请求时自动启动浏览器\n`);
        });
    } else {
        console.log(`\n✅ 服务启动完成!`);
        console.log(`  浏览器按需启动 (设置 PRESTART_BROWSER=true 可预热)`);
        console.log(`  访问 http://localhost:${PORT}\n`);
    }
}).on('error', (err) => {
    console.log(`\n❌ 服务启动失败: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
        console.log('  端口 3000 已被占用，请关闭其他程序\n');
    }
    process.exit(1);
});
