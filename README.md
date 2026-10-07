# 视频去水印工具

一个支持多平台的视频去水印 Web 工具，浏览器直接访问即可使用，无需安装任何客户端。

## 功能特性

- ✅ **B站** - 稳定解析，秒级响应
- ✅ **抖音** - 需要安装Chrome浏览器（已内置），支持分享链接解析
- ✅ OpenCV AI重建去除水印
- ✅ 保留原始音频
- ✅ MP4文件优化，支持流式播放
- ✅ 纯 Web 界面，支持 Chrome、Edge、Firefox、Safari 等主流浏览器

> ⚠️ **注意**: 抖音解析依赖Puppeteer浏览器自动化。视频URL有时效性，解析成功后需尽快下载。

## 项目结构

```
video-cleaner/
├── server_fast.js       # Node.js后端API服务
├── index.html           # Web前端页面
├── inpaint_watermark.py # OpenCV视频处理脚本
├── watermark_remover.js # 水印去除模块
├── package.json         # Node.js依赖配置
├── Dockerfile           # Docker部署配置
├── render.yaml          # Render部署配置
├── downloads/           # 处理后的视频存储
├── tools/               # FFmpeg工具
└── versions/            # 版本历史
```

## 快速开始

### 1. 本地运行

```bash
# 安装依赖
npm install

# 启动服务
node server_fast.js
# 服务地址: http://localhost:3000
```

然后在浏览器中打开 `http://localhost:3000` 即可使用。

### 2. Docker 运行

```bash
# 构建镜像
docker build -t video-cleaner .

# 运行容器
docker run -p 3000:3000 -v $(pwd)/downloads:/app/downloads video-cleaner
```

### 3. 测试API

```bash
# 解析豆包视频
curl -X POST http://localhost:3000/api/parse \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.doubao.com/video-sharing?share_id=xxx", "platform": "doubao"}'
```

## API接口

### 解析视频
```
POST /api/parse
Content-Type: application/json

{
  "url": "https://www.doubao.com/video-sharing?share_id=xxx",
  "platform": "auto"
}

Response:
{
  "success": true,
  "title": "视频标题",
  "platform": "豆包",
  "videoUrl": "原始视频URL",
  "downloadUrl": "/download/视频文件名.mp4",
  "fileSize": 2706272,
  "source": "Doubao Parser"
}
```

### 下载视频
```
GET /download/:filename
Content-Type: video/mp4
Accept-Ranges: bytes
```

### 状态检查
```
GET /api/status

Response:
{
  "status": "running",
  "browser_ready": true,
  "active_tasks": 0,
  "memory": {
    "rss_mb": 150,
    "heap_used_mb": 50
  }
}
```

## 部署

详细部署指南请参考 [DEPLOYMENT.md](DEPLOYMENT.md)

## 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| 前端 | 原生 HTML/CSS/JS | 跨浏览器兼容，无需框架 |
| 后端 | Node.js + Express | API服务 |
| 浏览器自动化 | Puppeteer | 视频链接解析 |
| 视频处理 | OpenCV + FFmpeg | 水印去除 |
| 部署 | Docker / Render / VPS | 灵活部署方案 |

## 浏览器兼容性

| 浏览器 | 最低版本 | 说明 |
|--------|---------|------|
| Chrome | 80+ | 完整支持 |
| Edge | 80+ | 完整支持 |
| Firefox | 75+ | 完整支持 |
| Safari | 13+ | 完整支持 |
| 360浏览器 | 极速模式 | 兼容支持 |
| 夸克浏览器 | 最新版 | 兼容支持 |

> **注意**：旧版 IE（≤11）不受支持，建议使用现代浏览器以获得最佳体验。

## 注意事项

1. **文件过期**: 处理后视频保留2小时（可配置），需及时下载
2. **FFmpeg依赖**: 视频处理需要 FFmpeg，请将 `ffmpeg.exe` 放入 `tools/` 目录或确保系统 PATH 中包含
3. **HTTPS**: 生产环境建议配置 HTTPS

## 许可证

MIT License

## 更新日志

### v1.1.0
- 移除小程序模块，专注 Web 端体验
- 增强跨浏览器兼容性（添加 vendor prefix、降级方案）
- 添加浏览器兼容性检测与提示
- 优化移动端响应式布局

### v1.0.0
- 初始版本发布
- 支持多平台视频解析
- OpenCV水印去除功能

---

*如有问题，请提交Issue*
