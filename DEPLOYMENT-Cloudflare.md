# 部署到 Cloudflare Containers（视频去水印工具）

> 适用场景：把本项目（Node + Puppeteer/Chromium + FFmpeg + Python/OpenCV）真正跑在 Cloudflare 上。
> 注意：**Cloudflare Workers / Pages 跑不了本项目**（V8 隔离环境没有子进程、没有 ffmpeg/chromium/python、CPU 10ms~30s、内存 128MB）。
> 能跑的是 **Cloudflare Containers**（Docker 容器，最高 4 vCPU / 12 GiB）。

---

## 架构

```
浏览器 ──HTTPS──▶ Cloudflare Worker (worker.js)
                       │ 反向代理（所有流量必须经 Worker 转发，不能直接连容器）
                       ▼
              Cloudflare Container (Docker)
                  ├─ server_fast.js  (Express, 0.0.0.0:3000)
                  ├─ Chromium        (Puppeteer 解析分享页)
                  ├─ FFmpeg          (拉流 / 转码 / 去水印兜底)
                  └─ Python + OpenCV (第一档 inpaint 去水印)
```

- **Worker**：只做转发 + 容器生命周期控制，几乎零成本。
- **Container**：真正跑重活。所有请求路由到同一个共享实例 `"shared"`，共享 `downloads/` 与已预热的 Chromium。

---

## 前置条件

1. 已安装 **Docker**（本地构建镜像用，`wrangler deploy` 时会调用）。
   - 验证：`docker info`
2. 已安装 **Node 20+** 与 **Wrangler**：
   - `npm install -g wrangler`
   - `wrangler --version`
3. Cloudflare 账号处于 **Workers 付费计划**（Containers 仅在 Paid 计划可用）。
4. 登录：`wrangler login`
5. 安装 Worker 侧依赖（用于打包 worker.js）：
   - `npm install`  （会装 `@cloudflare/containers`，已加入 devDependencies）
   - ⚠️ 本机若有 puppeteer 的 postinstall 想下载 Chrome，请先设 `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` 再 install，避免下载几百 MB。

---

## 部署步骤

```bash
# 1. 安装依赖（含 @cloudflare/containers）
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm install

# 2. 登录 Cloudflare
wrangler login

# 3. 构建镜像 + 部署 Worker + 部署容器（首次构建/推送最久，约 2~5 分钟）
wrangler deploy

# 4. 等待几分钟让 Cloudflare 完成容器供给；然后查看状态
npx wrangler containers list
```

部署完成后访问：`https://video-cleaner.<你的Workers子域>.workers.dev`

> 首次部署后，**等几分钟再打 Worker URL**。供给期间调用容器可能报错（Worker 已响应但容器还没就绪）。

---

## 配置文件说明

### `wrangler.toml`
- `main = "worker.js"`：Worker 入口（反向代理）。
- `[[containers]]`：`image = "./Dockerfile"`（Cloudflare 会自动 build & push），`class_name` 对应 worker.js 里的 `VideoCleaner`。
- `instance_type = "standard-3"`：2 vCPU / 8 GiB / 16 GB。**这是硬门槛**——lite/basic/standard-1 跑 Chromium + ffmpeg + OpenCV 极易内存不足。
- `max_instances = 1`：配合 `getByName("shared")`，全站共用一个容器实例。

### `worker.js`
- `VideoCleaner extends Container`：`defaultPort = 3000` 必须与容器内 Express 监听端口一致；`sleepAfter = "10m"` 控制空闲后休眠（停止计费）。
- `envVars`：注入到容器的环境变量（Chromium 路径、并行数、内存上限等）。
- `env.VIDEO_CLEANER.getByName("shared").fetch(request)`：把请求完整转发给容器。

### `Dockerfile`
- 基于 `linux/amd64`（Cloudflare 强制要求）。
- 装齐四件套：Node 20 + Chromium + FFmpeg + Python3/OpenCV。
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`：用系统 Chromium，跳过 puppeteer 自带下载。
- `NODE_OPTIONS=--max-old-space-size=6144`：V8 堆上限，按实例内存留 headroom。

---

## 本次为 Cloudflare 所做的代码调整（必读）

原来代码大量写死了 Windows 路径，在 Linux 容器里会静默降级或报错。已修复：

| 文件 | 问题 | 修复 |
|---|---|---|
| `watermark_remover.js` | `findOpenCVPython`/`findPython` 用 `fs.existsSync('python3')` 在 Linux 恒为 false | 新增 `firstAvailable()`：裸命令名在 Windows 用 `where`、POSIX 用 `command -v` 查 PATH |
| `watermark_remover.js` | `resolveFfmpeg` 兜底候选是 Windows `.exe` | 按平台返回 Linux 候选（`/usr/bin/ffmpeg` 等） |
| `watermark_remover.js` / `server_fast.js` | `killTree` 只调 `taskkill`（Windows） | 增加 Linux 分支：`pkill -9 -P <pid>` 杀直接子进程 |
| `server_fast.js` | Chrome 查找只有 Windows 路径 | 增加 Linux 路径（`/usr/bin/chromium` 等） |
| `server_fast.js` | `DOWNLOAD_DIR` 写死项目内 | 支持 `DOWNLOAD_DIR` 环境变量覆盖 |
| `inpaint_watermark.py` | `FFMPEG_CANDIDATES` 写死 Windows `.exe` | 按平台返回，Linux 优先系统 `ffmpeg` |
| `Dockerfile` | 缺 Python/OpenCV；无 `linux/amd64`；堆上限锁死 256MB | 加平台声明、装 Python3+OpenCV、堆上限改为 6144MB（环境变量可配） |

> 前端 `index.html` 用的是相对路径 `/api/...`，无需改动即可经 Worker 转发。

---

## 上线后必做的实测清单

容器里真实拉起的外部工具只有 4 个，缺一个不会启动失败而是**静默降级**，必须逐项实测：

```bash
# 在容器里（或本地同等 Linux 环境）跑一次真链接验证
python3 -c "import cv2, numpy; print(cv2.__version__)"   # 必须打印版本号
ffmpeg -version | head -1                                  # 必须打印版本号
chromium --version                                        # 必须打印版本号
curl http://localhost:3000/api/status                     # status: running
```

---

## 重要限制与成本提醒

1. **无 GPU**：FFmpeg / OpenCV 都是 CPU 运算，长视频（数分钟）处理会很慢，且占用 1 个实例的 CPU。
2. **存储是临时的**：容器磁盘随实例休眠/重建可能丢失。本项目文件 2 小时自动过期，影响有限；但若要稳定长期保存结果，应接 **R2**（见下）。
3. **成本**：按容器**运行时长**计费，不是按请求。一个 standard-3 实例空闲也计费，直到 `sleepAfter` 触发休眠。建议：
   - `sleepAfter` 设短一点（如 `10m`）控制空闲成本；
   - 或在访问量低时把 `max_instances` 保持 1、实例规格不要过大。
4. **流量必须经 Worker**：用户拿不到容器的直连地址，所有请求都走 Worker → 容器这一跳。
5. **实例规格**：若日志出现 OOM / `Container memory exceeded`，把 `instance_type` 升到 `standard-4`。同时把 `NODE_OPTIONS` 的 `--max-old-space-size` 相应调大（standard-4=12GiB 可给到 ~10000）。

---

## 生产加固建议（可选）

- **持久化输出 → R2**：容器写文件不稳，生产建议把处理后的视频上传到 R2 bucket，Worker 直接回源 R2 或给预签名 URL。需在 `wrangler.toml` 加 `r2_buckets` 绑定，并在 `server_fast.js` 的下载路由改为读 R2。
- **更大并发**：若要多用户同时处理，把 `max_instances` 调大并用 `getRandom` 路由（注意每个实例各自的 `downloads/` 不共享）。
- **自定义域名 + HTTPS**：在 Cloudflare 仪表盘给这个 Worker 绑定你自己的域名（免费），自动 HTTPS。
