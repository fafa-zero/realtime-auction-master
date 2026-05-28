# 稳定本地访问方案

如果 WSL 的 `localhost:5174` 转发不稳定，推荐使用单端口稳定模式：

1. 在 WSL 里进入项目目录：

```bash
cd /home/zyy/realtime-auction-master
```

2. 先构建 Web 前端：

```bash
npm --workspace apps/web run build
```

3. 启动后端服务。后端会同时托管 API、Socket.IO、静态图片和前端页面：

```bash
PORT=4300 CLIENT_URL=http://localhost:4300 npm --workspace apps/server run dev
```

4. Windows 浏览器只打开这两个地址：

- `http://localhost:4300/host`
- `http://localhost:4300/live/live-1`

这样页面、接口、图片和 WebSocket 都走同一个端口，不再依赖 `5174` 的 WSL 转发。

## 当前说明

- `/static/jewelry.jpg` 和 `/static/watch.jpg` 已改为本地静态图片。
- 当你需要最稳定的演示入口时，优先使用 `4300`，不要依赖 `5174`。
