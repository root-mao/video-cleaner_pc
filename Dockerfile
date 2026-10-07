# Cloudflare Containers 要求镜像为 linux/amd64
FROM --platform=linux/amd64 node:20-slim

# 基础依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 安装 FFmpeg（视频拉流 / HEVC→H.264 转码 / 去水印兜底）
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/* || \
    (echo "FFmpeg install failed, trying snap..." && \
     apt-get update && apt-get install -y --no-install-recommends snapd || true)

# 安装 Chromium（Puppeteer 打开分享页抓视频直链）
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libxcomposite1 \
    libxrandr2 \
    libpango-1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/* || \
    (echo "Chromium install failed, trying alternative..." && \
     apt-get update && apt-get install -y --no-install-recommends \
     chromium-browser \
     libnss3 libxss1 libasound2 libatk-bridge2.0-0 libgtk-3-0 \
     && rm -rf /var/lib/apt/lists/* || true)

# 安装 Python3 + OpenCV（第一档去水印，质量最好；cv2.inpaint 逐帧重建）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/*
# Debian 12 为 externally-managed，需 --break-system-packages；
# opencv-python-headless 运行期还需上面的 libGL/libSM/libX* 等系统库
RUN pip3 install --no-cache-dir --break-system-packages numpy opencv-python-headless

WORKDIR /app

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
# V8 堆上限：Cloudflare standard-3 = 8GiB，留约 6.5G 给 Node；如改用更小实例请同步下调
ENV NODE_OPTIONS=--max-old-space-size=6144
ENV DEBIAN_FRONTEND=noninteractive

COPY package*.json ./

# 使用 npm ci 而不是 npm install，减少网络依赖；--ignore-scripts 跳过 puppeteer 自带 Chromium 下载
RUN npm ci --only=production --ignore-scripts || npm install --only=production --ignore-scripts || echo "npm install failed, continuing..."

COPY . .

EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/status', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# NODE_OPTIONS 已设置堆上限，这里不再重复传参
CMD ["node", "server_fast.js"]
