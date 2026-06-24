const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Import watermark removal module (using delogo filter, keep original size)
const { removeWatermark } = require('./watermark_remover');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

let browserInstance = null;
let browserReady = false;

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function getBrowser() {
    if (browserInstance && browserReady) {
        return browserInstance;
    }
    
    log('启动浏览器实例...');
    browserInstance = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-images',
            '--blink-settings=imagesEnabled=false'
        ],
        timeout: 30000,
        protocolTimeout: 120000
    });
    browserReady = true;
    log('浏览器实例就绪');
    return browserInstance;
}

async function closeBrowser() {
    if (browserInstance) {
        await browserInstance.close();
        browserInstance = null;
        browserReady = false;
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
            name: 'Douyin2Download',
            url: `https://api.douyin2download.com/api?url=${encodeURIComponent(originalUrl)}`
        },
        {
            name: 'Douyin WTF',
            url: `https://api.douyin.wtf/api?url=${encodeURIComponent(resolvedUrl || originalUrl)}`
        },
        {
            name: 'DouyinTool',
            url: `https://douyin.1024api.com/api?url=${encodeURIComponent(originalUrl)}`
        },
        {
            name: 'ParseVideo',
            url: `https://parse.ideaflow.top/api/video/parse?url=${encodeURIComponent(originalUrl)}`
        },
        {
            name: 'ParseKuaishou',
            url: `https://api.douyin.wtf/api?url=${encodeURIComponent(originalUrl)}`
        }
    ];
    
    const promises = apis.map(async (api) => {
        try {
            log(`并行请求 ${api.name}...`);
            const response = await axios.get(api.url, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json, text/plain, */*'
                }
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
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15');
        await page.setRequestInterception(true);
        
        const videoRequests = [];
        
        page.on('request', (request) => {
            const requestUrl = request.url();
            if (request.resourceType() === 'image') {
                request.abort();
            } else {
                request.continue();
            }
        });
        
        page.on('response', (response) => {
            const responseUrl = response.url();
            if (responseUrl.includes('.mp4') || responseUrl.includes('video') || 
                responseUrl.includes('play') || responseUrl.includes('aweme/v1')) {
                videoRequests.push(responseUrl);
            }
        });
        
        const resolvedUrl = await resolveUrl(url);
        log(`访问: ${resolvedUrl}`);
        
        await page.goto(resolvedUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        const result = await page.evaluate(() => {
            const urls = [];
            
            for (const key in window) {
                if (key.includes('RENDER_DATA') || key.includes('aweme') || key.includes('video')) {
                    try {
                        const data = window[key];
                        if (data && typeof data === 'object') {
                            const search = (obj, path) => {
                                if (!obj) return;
                                if (typeof obj === 'string') {
                                    if (obj.includes('.mp4') && obj.startsWith('http')) {
                                        urls.push({ url: obj, path });
                                    }
                                } else if (Array.isArray(obj)) {
                                    obj.forEach((item, i) => search(item, path + '[' + i + ']'));
                                } else if (typeof obj === 'object') {
                                    if (obj.nwm_video_url) urls.push({ url: obj.nwm_video_url, path: path + '.nwm_video_url' });
                                    if (obj.video_url) urls.push({ url: obj.video_url, path: path + '.video_url' });
                                    if (obj.url) urls.push({ url: obj.url, path: path + '.url' });
                                    for (const k in obj) search(obj[k], path + '.' + k);
                                }
                            };
                            search(data, key);
                        }
                    } catch(e) {}
                }
            }
            
            const video = document.querySelector('video');
            if (video && video.currentSrc) urls.push({ url: video.currentSrc, path: 'video.currentSrc' });
            
            const title = document.title || '抖音视频';
            
            return { urls, title };
        });
        
        const videoUrls = [];
        const seenUrls = new Set();
        
        result.urls.forEach((item) => {
            if (seenUrls.has(item.url)) return;
            seenUrls.add(item.url);
            
            const lowerUrl = item.url.toLowerCase();
            if (lowerUrl.includes('.css') || lowerUrl.includes('.js') || lowerUrl.includes('.png')) return;
            
            let score = 30;
            if (lowerUrl.includes('nwm') || lowerUrl.includes('no_watermark')) score = 100;
            else if (lowerUrl.includes('watermark') || lowerUrl.includes('wm') || lowerUrl.includes('playwm')) score = 15;
            else if (lowerUrl.includes('.mp4')) score = 55;
            
            videoUrls.push({ url: item.url, score, path: item.path });
            log(`  找到视频链接: ${item.url.substring(0, 80)}... (分数: ${score})`);
        });
        
        const title = result.title || '抖音视频';
        
        log(`找到 ${videoUrls.length} 个视频链接`);
        
        if (videoUrls.length > 0) {
            videoUrls.sort((a, b) => b.score - a.score);
            let bestUrl = videoUrls[0];
            
            log(`✅ 找到视频链接 (分数: ${bestUrl.score}): ${bestUrl.url.substring(0, 100)}...`);
            
            let finalUrl = bestUrl.url;
            if (finalUrl.includes('/playwm/')) {
                finalUrl = finalUrl.replace('/playwm/', '/play/');
                log(`尝试去除水印: 将 playwm 替换为 play`);
            }
            
            return {
                success: true,
                title: title,
                videoUrl: finalUrl,
                source: 'Direct Puppeteer',
                thumbnail: null
            };
        }
        
    } catch (e) {
        log(`Puppeteer解析失败: ${e.message}`);
    } finally {
        await page.close();
    }
    
    return null;
}

async function tryBilibiliParser(url) {
    log('使用B站专用解析器...');
    
    // 已知的视频和音频质量ID列表
    const videoQualityIds = ['64', '32', '16', '112', '116', '74', '80', '100022', '100023', '100024'];
    const audioQualityIds = ['30216', '30232', '30280', '30250', '30251'];
    
    try {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const page = await browser.newPage();
        
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
            
            // 根据质量ID判断是视频还是音频流
            const match = url.match(/-1-(\d+)\.m4s/);
            if (match) {
                const qualityId = match[1];
                
                // 判断是否是视频质量ID
                const isVideo = videoQualityIds.includes(qualityId) || 
                               parseInt(qualityId) < 200;  // 小于200的通常是视频
                
                // 判断是否是音频质量ID
                const isAudio = audioQualityIds.includes(qualityId) ||
                               (parseInt(qualityId) >= 30200 && parseInt(qualityId) < 30300);
                
                if (isVideo || (videoQualityIds.includes(qualityId))) {
                    log(`发现视频流 (质量ID: ${qualityId}): ${url.substring(0, 120)}...`);
                    videoUrls.push(url);
                } else if (isAudio || audioQualityIds.includes(qualityId)) {
                    log(`发现音频流 (质量ID: ${qualityId}): ${url.substring(0, 120)}...`);
                    audioUrls.push(url);
                } else {
                    // 不确定类型时，根据URL模式启发式判断
                    log(`发现未知类型流 (质量ID: ${qualityId}): ${url.substring(0, 120)}...`);
                    videoUrls.push(url);
                }
            }
        });
        
        log(`正在访问: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
        
        await new Promise(resolve => setTimeout(resolve, 8000));
        
        const videoData = await page.evaluate(() => {
            const title = document.title.replace('- 哔哩哔哩 (゜-゜)つロ 乾杯~', '').trim() || 
                         document.querySelector('h1')?.textContent?.trim() || 
                         'B站视频';
            
            // 从页面中提取 playinfo / playurl（如果存在）
            let playinfo = null;
            try {
                // 尝试从 window 对象提取
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
        
        // 从 playinfo 中提取音视频URL
        let playinfoVideoUrl = null;
        let playinfoAudioUrl = null;
        
        if (videoData.playinfo && videoData.playinfo.data && videoData.playinfo.data.dash) {
            try {
                const dash = videoData.playinfo.data.dash;
                
                // 提取视频流
                if (dash.video && dash.video.length > 0) {
                    const videoStream = dash.video[0];
                    if (videoStream.baseUrl) {
                        playinfoVideoUrl = videoStream.baseUrl;
                        log(`从playinfo提取视频URL: ${playinfoVideoUrl.substring(0, 120)}...`);
                    }
                }
                
                // 提取音频流
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
        
        await browser.close();
        
        log(`找到 ${videoUrls.length} 个视频地址, ${audioUrls.length} 个音频地址`);
        
        // 优先使用 playinfo 中的URL
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
    }

    return null;
}

// 豆包专用解析器 - 从链接层面获取无水印视频
async function tryDoubaoParser(url) {
    log('使用豆包专用解析器...');

    try {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15');
        await page.setExtraHTTPHeaders({
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Referer': 'https://www.doubao.com/'
        });

        const videoUrls = [];
        const seenUrls = new Set();

        // 拦截网络请求，寻找无水印视频URL
        page.on('response', async (response) => {
            const responseUrl = response.url();
            const contentType = response.headers()['content-type'] || '';

            // 更精确的视频URL识别
            const isVideo = contentType.includes('video') ||
                           contentType.includes('mp4') ||
                           responseUrl.match(/\.(mp4|m3u8|ts)(\?|$)/i) ||
                           responseUrl.includes('aweme/v1/play') ||
                           responseUrl.includes('video/play');

            if (isVideo) {
                if (seenUrls.has(responseUrl)) return;
                seenUrls.add(responseUrl);

                const lowerUrl = responseUrl.toLowerCase();

                // 计算分数，优先选择无水印链接
                let score = 30;
                if (lowerUrl.includes('nwm') || lowerUrl.includes('no_watermark') || lowerUrl.includes('nowatermark')) {
                    score = 100;
                    log(`[豆包] 发现无水印链接: ${responseUrl.substring(0, 100)}...`);
                } else if (lowerUrl.includes('watermark') || lowerUrl.includes('wm') || lowerUrl.includes('playwm')) {
                    score = 15;
                    log(`[豆包] 发现带水印链接: ${responseUrl.substring(0, 100)}...`);
                } else if (lowerUrl.includes('.mp4') || lowerUrl.includes('aweme')) {
                    score = 55;
                    log(`[豆包] 发现视频链接 (content-type: ${contentType}): ${responseUrl.substring(0, 100)}...`);
                }

                videoUrls.push({ url: responseUrl, score });
            }
        });

        // 解析短链接
        const resolvedUrl = await resolveUrl(url);
        log(`[豆包] 访问: ${resolvedUrl}`);

        await page.goto(resolvedUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        // 等待视频加载
        await new Promise(resolve => setTimeout(resolve, 8000));

        // 从页面中提取视频URL
        const pageResult = await page.evaluate(() => {
            const urls = [];
            const title = document.title || '豆包视频';

            // 1. 查找video标签
            const videos = document.querySelectorAll('video');
            videos.forEach(video => {
                if (video.currentSrc) {
                    urls.push({ url: video.currentSrc, source: 'video.currentSrc' });
                }
                if (video.src) {
                    urls.push({ url: video.src, source: 'video.src' });
                }
                // 查找source标签
                const sources = video.querySelectorAll('source');
                sources.forEach(source => {
                    if (source.src) {
                        urls.push({ url: source.src, source: 'source.src' });
                    }
                });
            });

            // 2. 从window对象中查找视频数据
            const searchObject = (obj, path = '', depth = 0) => {
                if (depth > 8 || !obj) return;
                if (typeof obj === 'string') {
                    // 匹配各种视频URL格式
                    if ((obj.includes('.mp4') || obj.includes('.m3u8') || obj.match(/aweme\/v\d+\//)) && obj.startsWith('http')) {
                        urls.push({ url: obj, source: path });
                    }
                } else if (Array.isArray(obj)) {
                    obj.forEach((item, i) => searchObject(item, `${path}[${i}]`, depth + 1));
                } else if (typeof obj === 'object') {
                    // 查找常见的视频URL字段（包括豆包特有格式）
                    const videoKeys = [
                        'video_url', 'play_addr', 'url', 'src', 'download_addr', 'nwm_video_url', 'video',
                        'play_url', 'download_url', 'video_uri', 'uri', 'real_url', 'hd_url', 'sd_url',
                        'mp4_url', 'h265_url', 'hev_url', 'hvc_url', 'main_url', 'backup_url'
                    ];
                    videoKeys.forEach(key => {
                        if (obj[key] && typeof obj[key] === 'string' && obj[key].includes('http')) {
                            urls.push({ url: obj[key], source: `${path}.${key}` });
                        }
                    });
                    for (const k in obj) {
                        if (k.length < 50) { // 避免遍历过长的key
                            searchObject(obj[k], `${path}.${k}`, depth + 1);
                        }
                    }
                }
            };

            // 搜索全局变量（包括豆包特有变量）
            const searchKeys = ['DATA', 'RENDER', 'video', 'aweme', 'state', 'videoInfo', 'player', 'config', 'global', 'store', '__INITIAL_STATE__'];
            for (const key of searchKeys) {
                if (window[key]) {
                    try {
                        searchObject(window[key], key);
                    } catch (e) {}
                }
            }
            // 遍历所有window属性
            for (const key in window) {
                try {
                    if (typeof window[key] === 'object' && window[key] !== null) {
                        searchObject(window[key], key, 1);
                    }
                } catch (e) {}
            }

            // 3. 查找页面中的视频URL
            const scripts = document.querySelectorAll('script');
            scripts.forEach(script => {
                const content = script.textContent || '';
                // 匹配视频URL（包括各种格式）
                const urlMatches = content.match(/https?:\/\/[^\s"']+\.(mp4|m3u8)[^\s"']*/g) || [];
                urlMatches.forEach(u => urls.push({ url: u, source: 'script' }));
            });

            // 4. 查找页面中的JSON数据
            const jsonMatches = document.body.innerHTML.match(/window\.__\w+__\s*=\s*(\{[\s\S]*?\});/g) || [];
            jsonMatches.forEach(jsonStr => {
                try {
                    const match = jsonStr.match(/window\.__\w+__\s*=\s*(\{[\s\S]*?\});/);
                    if (match) {
                        const jsonData = JSON.parse(match[1]);
                        searchObject(jsonData, 'inlineJSON');
                    }
                } catch (e) {}
            });

            return { urls, title };
        });

        log(`[豆包] 从页面提取到 ${pageResult.urls.length} 个URL`);

        // 合并找到的URL
        pageResult.urls.forEach(item => {
            if (seenUrls.has(item.url)) return;
            seenUrls.add(item.url);

            const lowerUrl = item.url.toLowerCase();
            let score = 40;
            if (lowerUrl.includes('nwm') || lowerUrl.includes('no_watermark')) score = 100;
            else if (lowerUrl.includes('watermark') || lowerUrl.includes('wm')) score = 15;

            log(`[豆包] 页面URL (分数: ${score}): ${item.url.substring(0, 80)}... 来源: ${item.source}`);
            videoUrls.push({ url: item.url, score });
        });

        await browser.close();

        log(`[豆包] 总共找到 ${videoUrls.length} 个视频链接`);

        if (videoUrls.length > 0) {
            // 按分数排序，优先选择无水印链接
            videoUrls.sort((a, b) => b.score - a.score);
            const bestUrl = videoUrls[0];

            log(`[豆包] ✅ 找到最佳视频链接 (分数: ${bestUrl.score}): ${bestUrl.url.substring(0, 100)}...`);

            // 尝试替换URL获取无水印版本
            let finalUrl = bestUrl.url;
            if (finalUrl.includes('/playwm/')) {
                finalUrl = finalUrl.replace('/playwm/', '/play/');
                log(`[豆包] 尝试去除水印: 将 playwm 替换为 play`);
            }
            // 尝试移除水印相关参数
            if (finalUrl.includes('watermark')) {
                finalUrl = finalUrl.replace(/watermark=[^&]*/gi, '').replace(/&&/g, '&');
                log(`[豆包] 尝试移除水印参数`);
            }

            return {
                success: true,
                title: pageResult.title,
                videoUrl: finalUrl,
                source: 'Doubao Parser',
                thumbnail: null
            };
        }

        log(`[豆包] 未找到视频链接`);
    } catch (e) {
        log(`[豆包] 解析失败: ${e.message}`);
    }

    return null;
}

async function tryPuppeteer(url) {
    log('启动Puppeteer解析...');

    const isBilibili = url.includes('bilibili') || url.includes('b23.tv');
    const isDoubao = url.includes('doubao') || url.includes('v.doubao');

    if (isBilibili) {
        const biliResult = await tryBilibiliParser(url);
        if (biliResult) return biliResult;
    }

    if (isDoubao) {
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
        const doubaoResult = await tryDoubaoParser(url);
        if (doubaoResult) {
            log(`[豆包] 专用解析器成功! 视频URL: ${doubaoResult.videoUrl.substring(0, 80)}...`);
            return doubaoResult;
        }
        log(`[豆包] 所有解析方法均失败`);
    }

    const result = await tryDirectPuppeteer(url);
    if (result) return result;
    
    return null;
}

// 检查FFmpeg是否可用
function checkFfmpeg() {
    // 首先尝试在常见位置查找FFmpeg
    const ffmpegPaths = [
        path.join(__dirname, 'tools', 'ffmpeg.exe'),
        path.join(__dirname, 'ffmpeg.exe'),
        'ffmpeg'
    ];
    
    for (const ffmpegPath of ffmpegPaths) {
        try {
            if (ffmpegPath === 'ffmpeg') {
                // 只在PATH中可能存在的通用名称
                // 不检查existsSync，直接尝试
                return ffmpegPath;
            }
            
            if (fs.existsSync(ffmpegPath)) {
                log(`找到FFmpeg: ${ffmpegPath}`);
                return ffmpegPath;
            }
        } catch (e) {
            log(`检查FFmpeg失败: ${e.message}`);
            continue;
        }
    }
    
    log('警告: 未找到FFmpeg，视频处理功能可能受限');
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

// 使用FFmpeg合并视频和音频
async function mergeVideoAudio(videoPath, audioPath, outputPath, ffmpegPath) {
    try {
        log('正在合并音视频...');
        const command = `"${ffmpegPath}" -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a copy -y "${outputPath}"`;
        await execAsync(command, { encoding: 'utf8' });
        log('音视频合并成功');
        return { success: true };
    } catch (e) {
        log(`音视频合并失败: ${e.message}`);
        return { success: false, error: e.message };
    }
}

// [Old removeWatermark function removed - now using watermark_remover.js module]

async function downloadVideo(videoUrl, title, audioUrl = null, platform = 'general') {
    try {
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
        const ffmpegPath = checkFfmpeg();
        
        // 确定文件扩展名
        const isBilibili = videoUrl.includes('bilivideo') || videoUrl.includes('bilibili');
        const isM4s = videoUrl.includes('.m4s');
        
        // 根据原始URL重新判断平台（比videoUrl更准确）
        // platform参数已经在parse路由中根据原始URL判断，这里直接使用
        
        let finalFilePath, finalFilename;
        finalFilename = `${safeTitle}_${timestamp}.mp4`;
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
                    let command = `"${ffmpegPath}" -i "${tempVideoPath}" -i "${tempAudioPath}" -c:v copy -c:a copy -y "${finalFilePath}"`;
                    await execAsync(command, { encoding: 'utf8' });
                    
                    // 验证输出文件
                    if (fs.existsSync(finalFilePath) && fs.statSync(finalFilePath).size > 0) {
                        // 清理临时文件
                        try {
                            fs.unlinkSync(tempVideoPath);
                            fs.unlinkSync(tempAudioPath);
                        } catch (e) {
                            log(`清理临时文件失败: ${e.message}`);
                        }
                        
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
                    const checkCmd = `"${ffmpegPath}" -i "${tempVideoPath}" -hide_banner 2>&1`;
                    const { stdout } = await execAsync(checkCmd, { encoding: 'utf8' });
                    
                    // 判断是否有视频轨道
                    const hasVideoTrack = stdout.includes('Video:') || stdout.includes('视频:');
                    const hasAudioTrack = stdout.includes('Audio:') || stdout.includes('音频:');
                    
                    log(`文件分析: 视频=${hasVideoTrack}, 音频=${hasAudioTrack}`);
                    
                    if (hasVideoTrack) {
                        // 有视频轨道，尝试封装为MP4
                        let command;
                        if (hasAudioTrack) {
                            // 已经有音视频，直接封装
                            command = `"${ffmpegPath}" -i "${tempVideoPath}" -c:v copy -c:a copy -y "${finalFilePath}"`;
                        } else {
                            // 只有视频，封装为MP4
                            command = `"${ffmpegPath}" -i "${tempVideoPath}" -c:v copy -y "${finalFilePath}"`;
                        }
                        
                        await execAsync(command, { encoding: 'utf8' });
                        
                        if (fs.existsSync(finalFilePath) && fs.statSync(finalFilePath).size > 0) {
                            try {
                                fs.unlinkSync(tempVideoPath);
                                if (tempAudioPath && fs.existsSync(tempAudioPath)) {
                                    fs.unlinkSync(tempAudioPath);
                                }
                            } catch (e) {
                                log(`清理临时文件失败: ${e.message}`);
                            }
                            
                            const stats = fs.statSync(finalFilePath);
                            log(`视频封装完成: ${stats.size} bytes`);
                        }
                    } else {
                        log(`警告: 下载的文件没有视频轨道!`);
                        // 没有视频轨道，直接返回原始文件
                        fs.renameSync(tempVideoPath, finalFilePath);
                        log(`已保留原始文件`);
                    }
                } catch (e) {
                    log(`视频处理失败: ${e.message.substring(0, 100)}`);
                    // 失败时返回原始文件
                    try {
                        fs.renameSync(tempVideoPath, finalFilePath);
                    } catch (e2) {
                        log(`重命名失败: ${e2.message}`);
                    }
                }
            }
            
            // 所有成功路径统一执行到这里 - 执行去水印处理
            if (fs.existsSync(finalFilePath) && fs.statSync(finalFilePath).size > 100000) {
                log(`视频处理完成，准备去水印 (平台: ${platform})...`);
                
                // 执行去水印处理 - 使用传入的platform参数
                const wmResult = await removeWatermark(finalFilePath, ffmpegPath, platform);
                if (wmResult.removed) {
                    log('水印去除完成');
                } else if (wmResult.skipped) {
                    log('已跳过去水印处理');
                }
                
                // 重新读取最终文件大小
                const finalStats = fs.statSync(finalFilePath);
                log(`最终文件大小: ${finalStats.size} bytes`);
                
                return {
                    success: true,
                    filePath: finalFilePath,
                    filename: finalFilename,
                    fileSize: finalStats.size
                };
            }
        } else if (!isM4s && !ffmpegPath) {
            // 普通MP4文件或没有FFmpeg，直接下载
            log('直接下载视频文件...');
            const downloadResult = await downloadSingleFile(videoUrl, referer, finalFilePath);
            if (!downloadResult.success) {
                return downloadResult;
            }
        } else if (isM4s && ffmpegPath) {
            // 只有视频URL的.m4s文件
            log('处理单文件.m4s视频...');
            const tempPath = path.join(DOWNLOAD_DIR, `${safeTitle}_temp_${timestamp}.m4s`);
            const downloadResult = await downloadSingleFile(videoUrl, referer, tempPath);
            
            if (downloadResult.success) {
                try {
                    const command = `"${ffmpegPath}" -i "${tempPath}" -c:v copy -c:a copy -y "${finalFilePath}"`;
                    await execAsync(command, { encoding: 'utf8' });
                    fs.unlinkSync(tempPath);
                    
                    const stats = fs.statSync(finalFilePath);
                    log(`视频封装完成: ${stats.size} bytes`);
                } catch (e) {
                    log(`转换失败，保留原始文件: ${e.message}`);
                    fs.renameSync(tempPath, finalFilePath);
                }
            } else {
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
        }
        
        // 执行去水印处理（所有路径统一执行）
        if (fs.existsSync(finalFilePath)) {
            const wmResult = await removeWatermark(finalFilePath, ffmpegPath, platform);
            if (wmResult.removed) {
                log('水印去除完成');
            } else if (wmResult.skipped) {
                log('已跳过去水印处理');
            }
        }
        
        const stats = fs.statSync(finalFilePath);
        log(`视频下载完成: ${stats.size} bytes`);
        
        // 检查视频编码，如果是HEVC且没有音频，需要转码
        if (ffmpegPath && platform === '豆包') {
            try {
                const checkCmd = `"${ffmpegPath}" -i "${finalFilePath}" -hide_banner 2>&1`;
                const { stdout } = await execAsync(checkCmd, { encoding: 'utf8' });
                
                const isHEVC = stdout.includes('hevc') || stdout.includes('hvc1') || stdout.includes('hev1');
                const hasAudio = stdout.includes('Audio:') || stdout.includes('音频:');
                
                if (isHEVC) {
                    log(`检测到HEVC编码视频，开始转码为H.264...`);
                    const transcodedPath = finalFilePath.replace('.mp4', '_transcoded.mp4');
                    
                    let transcodeCmd;
                    if (hasAudio) {
                        transcodeCmd = `"${ffmpegPath}" -i "${finalFilePath}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -y "${transcodedPath}"`;
                    } else {
                        // 如果原视频没有音频，只转码视频流
                        transcodeCmd = `"${ffmpegPath}" -i "${finalFilePath}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest -y "${transcodedPath}"`;
                    }
                    
                    await execAsync(transcodeCmd, { encoding: 'utf8' });
                    
                    if (fs.existsSync(transcodedPath) && fs.statSync(transcodedPath).size > 100000) {
                        // 备份原文件
                        const backupPath = finalFilePath.replace('.mp4', '_hevc_backup.mp4');
                        fs.renameSync(finalFilePath, backupPath);
                        fs.renameSync(transcodedPath, finalFilePath);
                        
                        const newStats = fs.statSync(finalFilePath);
                        log(`HEVC转H.264完成 (${newStats.size} bytes)`);
                    } else {
                        log(`转码失败，保留原始HEVC文件`);
                    }
                }
            } catch (e) {
                log(`视频编码检查/转码失败: ${e.message}`);
            }
        }
        
        return {
            success: true,
            filePath: finalFilePath,
            filename: finalFilename,
            fileSize: stats.size
        };
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

function detectPlatform(url) {
    if (url.includes('douyin') || url.includes('v.douyin')) return '抖音';
    if (url.includes('bilibili') || url.includes('b23.tv')) return 'B站';
    if (url.includes('kuaishou') || url.includes('v.kuaishou')) return '快手';
    if (url.includes('doubao') || url.includes('v.doubao')) return '豆包';
    return '未知';
}

app.post('/api/parse', async (req, res) => {
    const { url, platform = 'auto' } = req.body;
    
    if (!url) {
        return res.json({ success: false, message: '请提供视频链接' });
    }
    
    log(`开始解析: ${url}`);
    
    const startTime = Date.now();
    let result = null;
    
    try {
        const resolvedUrl = await resolveUrl(url);
        
        if (platform === 'douyin' || platform === 'auto') {
            result = await tryAPIsParallel(null, url, resolvedUrl);
            if (!result) {
                result = await tryPuppeteer(resolvedUrl);
            }
        } else if (platform === 'doubao') {
            result = await tryPuppeteer(resolvedUrl);
        } else {
            result = await tryPuppeteer(resolvedUrl);
        }
        
        if (result) {
            // 根据原始URL判断平台类型，确保去水印处理正确
            const platformType = detectPlatform(url);
            const downloadResult = await downloadVideo(result.videoUrl, result.title, result.audioUrl, platformType);
            if (downloadResult.success) {
                const parseDuration = Math.floor((Date.now() - startTime) / 1000);
                log(`解析完成! 解析耗时: ${parseDuration}s, 文件: ${downloadResult.filename}`);
                
                return res.json({
                    success: true,
                    title: result.title,
                    platform: platformType,
                    videoUrl: result.videoUrl,
                    downloadUrl: `/download/${encodeURIComponent(downloadResult.filename)}`,
                    downloadPath: downloadResult.filePath,
                    fileSize: downloadResult.fileSize,
                    source: result.source
                });
            } else {
                log(`下载失败: ${downloadResult.error}`);
                return res.json({
                    success: true,
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
            return res.json({
                success: false,
                message: '无法获取视频地址 - 所有方法均失败，请尝试其他链接'
            });
        }
    } catch (e) {
        log(`解析异常: ${e.message}`);
        return res.json({
            success: false,
            message: `解析失败: ${e.message}`
        });
    }
});

app.get('/download/:filename', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = path.join(DOWNLOAD_DIR, filename);
    res.download(filePath);
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        download_dir: DOWNLOAD_DIR,
        browser_ready: browserReady,
        timestamp: new Date().toISOString()
    });
});

process.on('SIGINT', async () => {
    log('收到停止信号，关闭浏览器...');
    await closeBrowser();
    process.exit(0);
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log('\n==========================================');
    console.log('  VideoCleaner - AI自动视频去水印工具');
    console.log('==========================================');
    console.log(`  服务端口: ${PORT}`);
    console.log(`  下载目录: ${DOWNLOAD_DIR}`);
    console.log('==========================================\n');
    
    try {
        await getBrowser();
        console.log(`\n✅ 服务启动完成! 访问 http://localhost:${PORT}`);
        console.log('  或访问: http://127.0.0.1:3000\n');
    } catch (e) {
        console.log(`\n⚠️ 浏览器启动失败: ${e.message}`);
        console.log('  但服务仍可正常工作（功能有限）\n');
    }
}).on('error', (err) => {
    console.log(`\n❌ 服务启动失败: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
        console.log('  端口 3000 已被占用，请关闭其他程序\n');
    }
    process.exit(1);
});
