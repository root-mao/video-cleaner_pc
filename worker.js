// Cloudflare Containers Worker
// 作用：把所有入站 HTTP 请求反向代理到容器里跑的 Express 服务（server_fast.js）。
// 重要：终端用户不能直接连容器，所有流量必须经这个 Worker 转发。
import { Container, getContainer } from "@cloudflare/containers";

export class VideoCleaner extends Container {
  // 容器里 Express 监听的端口（见 server_fast.js：PORT 默认 3000，绑定 0.0.0.0）
  defaultPort = 3000;

  // 空闲 10 分钟后休眠，停止计费；下次请求自动唤醒（首请求会慢几秒，可接受）。
  // 调大可减少冷启动，但空闲时持续计费。
  sleepAfter = "10m";

  // 传给容器的环境变量（与 wrangler 的容器配置合并；这里是容器专用值）
  envVars = {
    NODE_ENV: "production",
    PORT: "3000",
    PUPPETEER_EXECUTABLE_PATH: "/usr/bin/chromium",
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "true",
    NODE_OPTIONS: "--max-old-space-size=6144",
    MAX_PARALLEL: "1",
    FILE_EXPIRE_HOURS: "2",
    BROWSER_IDLE_TIMEOUT: "120000",
    FFMPEG_THREADS: "1",
  };

  onStart() {
    console.log("[container] started");
  }
  onStop() {
    console.log("[container] stopped");
  }
  onError(error) {
    console.error("[container] error:", error);
  }
}

export default {
  async fetch(request, env) {
    // 所有流量路由到同一个共享容器实例 "shared"：
    // 这样 downloads 目录、已预热的 Chromium、任务状态在所有请求间共享。
    // getContainer 是当前官方推荐的容器句柄获取方式（替代旧式 getByName）。
    const container = getContainer(env.VIDEO_CLEANER, "shared");
    return container.fetch(request);
  },
};
