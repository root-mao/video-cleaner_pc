# 视频去水印工具 - 部署指南

## 项目概述

本项目是一个纯 Web 端的视频去水印工具，用户通过浏览器直接访问即可使用，无需安装任何客户端。

包含：
1. **Node.js后端服务** (server_fast.js) - 提供视频解析API
2. **Web前端** (index.html) - 纯原生 HTML/CSS/JS，跨浏览器兼容
3. **Python视频处理** (inpaint_watermark.py) - OpenCV水印去除

---

## 一、后端部署

### 方案A：本地运行（开发测试）

```bash
# 1. 安装依赖
npm install

# 2. 确保FFmpeg可用
# 已将ffmpeg.exe放置在 tools/ 目录

# 3. 启动服务
node server_fast.js
# 服务地址: http://localhost:3000
```

### 方案B：Render.com部署（推荐）

#### 前置条件
- GitHub账号
- Render账号（免费注册）
- 项目已推送到GitHub仓库

#### 部署步骤

1. **准备Dockerfile**（已存在）
   - 自动安装Node.js、Chromium、基础依赖

2. **准备render.yaml**（已存在）
   - 配置环境变量和磁盘挂载

3. **推送代码到GitHub**
   ```bash
   git add .
   git commit -m "准备部署"
   git push origin main
   ```

4. **在Render创建服务**
   - 访问 https://render.com
   - 点击 "New +" → "Web Service"
   - 选择你的GitHub仓库
   - 配置：
     - Name: `video-cleaner`
     - Region: 选择最近的区域
     - Branch: `main`
     - Runtime: `Docker`
     - Build Command: `npm install`
     - Start Command: `node server_fast.js`

5. **设置环境变量**
   ```
   PORT=3000
   NODE_ENV=production
   MAX_PARALLEL=1
   FILE_EXPIRE_HOURS=2
   PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
   ```

6. **添加持久化磁盘**
   - 在Render仪表盘中找到你的服务
   - 进入 "Storage" 标签
   - 创建新卷，挂载路径 `/app/downloads`
   - 大小建议 5GB

7. **获取HTTPS域名**
   - Render会自动分配 `https://video-cleaner.onrender.com`
   - 记录这个域名，直接使用浏览器访问即可

---

### 方案C：腾讯云部署

1. **创建云服务器(CVM)**
   - 选择 Ubuntu 20.04 LTS
   - 配置：2核4GB以上
   - 系统盘：50GB SSD

2. **安装依赖**
   ```bash
   # 更新系统
   sudo apt update && sudo apt upgrade -y

   # 安装Node.js
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs

   # 安装Chromium
   sudo apt install -y chromium-browser

   # 安装FFmpeg
   sudo apt install -y ffmpeg

   # 安装PM2（进程管理）
   sudo npm install -g pm2
   ```

3. **部署项目**
   ```bash
   # 克隆代码
   git clone <your-repo-url>
   cd video-cleaner

   # 安装依赖
   npm install --production

   # 创建下载目录
   mkdir -p downloads

   # 启动服务
   pm2 start server_fast.js --name video-cleaner
   pm2 save
   pm2 startup
   ```

4. **配置Nginx反向代理（HTTPS）**
   ```bash
   # 安装Nginx
   sudo apt install -y nginx

   # 创建配置文件
   sudo nano /etc/nginx/sites-available/video-cleaner
   ```

   配置文件内容：
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;

       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

5. **申请SSL证书**
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d your-domain.com
   ```

6. **访问网站**
   - 打开浏览器访问 `https://your-domain.com`
   - 支持 Chrome、Edge、Firefox、Safari 等主流浏览器

---

## 二、Docker部署（通用）

适用于任何支持 Docker 的环境（云服务器、NAS、本地服务器等）。

### 构建并运行

```bash
# 构建镜像
docker build -t video-cleaner .

# 运行容器
docker run -d \
  --name video-cleaner \
  -p 3000:3000 \
  -v $(pwd)/downloads:/app/downloads \
  -e PORT=3000 \
  -e NODE_ENV=production \
  video-cleaner
```

### Docker Compose

创建 `docker-compose.yml`：
```yaml
version: '3.8'
services:
  video-cleaner:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./downloads:/app/downloads
    environment:
      - PORT=3000
      - NODE_ENV=production
      - MAX_PARALLEL=1
      - FILE_EXPIRE_HOURS=2
```

启动：
```bash
docker-compose up -d
```

---

## 六、生产环境必备清单（2026-10-05 按代码实际调用链核对）

代码里真实拉起的外部工具只有 4 个，缺任何一个都不会启动失败，而是**静默降级**，
所以上线后必须逐项实测（`node server_fast.js` 后跑一次真链接）。

| 类别 | 必装 | 作用 | 缺失后果 |
|---|---|---|---|
| 运行时 | Node.js 20+（`express` / `cors` / `axios` / `puppeteer`） | API、下载、页面解析 | 起不来 |
| 浏览器 | Chromium（系统包或 puppeteer 自带） | puppeteer 打开分享页抓视频直链 | 解析失败 |
| 视频处理 | FFmpeg（`apt install ffmpeg`，或自带静态包） | 拉流下载、HEVC→H.264 转码、去水印第二三档兜底 | 水印打不掉 |
| 图像处理 | Python 3 + `numpy` + `opencv-python-headless` | `cv2.inpaint` 去水印第一档（质量最好） | 静默降级成模糊覆盖 |
| 进程 | pm2 / systemd | 崩溃拉起、日志 | 服务挂了没人知道 |
| 网络 | Nginx 反代 + HTTPS | 对外域名 | 只有裸端口 |

### 跨平台坑（Windows 上好的，到 Linux 不一定）

- `watermark_remover.js` 的 `findOpenCVPython()` 用 `fs.existsSync()` 找
  `D:/app/Python313/python.exe` 这类**绝对路径 + 裸命令名**。Linux 上 `fs.existsSync('python3')`
  是 `false`（会被当成相对路径），结果返回 `null` → OpenCV 档被跳过。
  → 部署前要么改判定逻辑，要么直接跑 `python3 -c "import cv2"` 兜底验证。
- `watermark_remover.js` 的 `resolveFfmpeg()` 备选候选硬编码 `*.exe`：Linux 上自动忽略，
  但前提是系统已装 `ffmpeg`，否则兜底也拿不到。
- `server_fast.js` 的 Chrome 查找只认 `PUPPETEER_EXECUTABLE_PATH` 和一批 Windows 路径，
  Linux 必须显式设 `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`。
- `tools/ffmpeg.exe`(204MB) / `tools/ffmpeg_alt.exe`(87MB) 是 Windows 二进制，**不用传服务器**，
  用系统包管理的 ffmpeg 即可，能省 ~290MB 镜像体积。

### 环境变量（默认值）

```
PORT=3000            MAX_PARALLEL=2        单并发，低配机器建议设 1
PARSE_TIMEOUT=900000      接口级总超时 15 分钟（调大只影响单任务耐心）
FILE_EXPIRE_HOURS=2        下载文件 2 小时后自动清理
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
NODE_ENV=production
```

### 最小启动验证

```bash
python3 -c "import cv2, numpy; print(cv2.__version__)"   # 必须打印版本号
ffmpeg -version | head -1                                  # 必须打印版本号
chromium --version
npm ci --omit=dev && npm start
curl http://localhost:3000/api/status                      # status: running
```

## 三、常见问题

### Q1: 视频解析失败
- 查看服务器日志：`pm2 logs video-cleaner`
- 检查Puppeteer浏览器是否正常启动
- 确认FFmpeg可用

### Q2: 视频无法播放
- 检查视频文件是否完整
- 确认Content-Type头设置为 video/mp4
- 测试服务器直接访问视频URL

### Q3: Render服务无法启动
- 检查Dockerfile是否正确
- 确认环境变量配置
- 查看构建日志

### Q4: 浏览器中页面空白
- 确认服务器已正常启动
- 检查浏览器控制台是否有报错
- 尝试清除浏览器缓存或使用无痕模式

### Q5: 下载的视频无法在浏览器中播放
- 服务器会对HEVC编码视频自动转码为H.264
- 确保FFmpeg正常工作
- 部分老旧浏览器可能不支持某些编码格式

---

## 四、技术架构

```
用户浏览器
(Chrome / Edge / Firefox / Safari / 360浏览器 / 夸克浏览器)
       │
       │ HTTP/HTTPS
       ▼
┌─────────────────┐
│  Node.js后端    │
│  (server_fast)  │
└────────┬────────┘
         │
    ┌────┴────┬──────────┐
    ▼         ▼          ▼
┌───────┐ ┌───────┐ ┌──────────┐
│Puppeteer│ │ FFmpeg │ │OpenCV/Py │
│浏览器自动化│ │视频处理  │ │水印去除  │
└───────┘ └───────┘ └──────────┘
```

---

## 五、维护与监控

### 定期检查
- 服务器内存使用：`top` 或 `htop`
- 进程状态：`pm2 status`
- 日志查看：`pm2 logs`
- 磁盘空间：`df -h`

### 自动清理
- 每小时清理过期文件
- 每日备份重要数据
- 监控异常日志

---

*最后更新：2025-01-01*
