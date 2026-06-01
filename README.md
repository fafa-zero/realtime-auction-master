# 实时竞拍大师

面向直播电商场景的实时竞拍 MVP。项目用于课程设计、毕业设计和本地演示，重点展示“主播开播配置商品、买家实时竞拍、弹幕互动、成交生成订单、AI 辅助讲解”的完整闭环。

当前版本包含三端：

- Web 主播端：创建直播间、管理竞拍、商品队列、订单、弹幕治理和 AI 助手。
- Web 观众端：买家登录/注册、观看直播间、竞拍、发送弹幕、查看订单。
- 微信小程序买家端：复用 Web 买家账号，进入同一直播间竞拍和发弹幕。

> 说明：本项目是演示级原型。真实直播推流、真实微信登录、真实支付、生产数据库、Redis 高并发和完整风控属于后续工程化扩展。

## 功能亮点

- 多直播间独立状态，弹幕、竞拍、订单按 `liveRoomId` 隔离。
- Web 与小程序共用买家账号体系，小程序不再使用单独 mock openid 账号。
- 主播新账号首次登录后先创建直播间，再进入主播控制台。
- 主播端不能出价，买家出价统一从 Web 观众端或小程序端完成。
- 竞拍支持起拍价、最低加价、封顶价、倒计时、成交/流拍/取消。
- 达到封顶价自动成交，并生成模拟订单。
- Web Socket.IO 实时同步竞拍和弹幕；小程序通过 `/miniprogram-ws` 实时同步，REST 轮询与 HTTP 提交接口作为兜底。
- 弹幕支持发送、历史列表、飞屏展示、限频、敏感词过滤、主播撤回和屏蔽用户。
- AI 助手支持商品讲解词、竞拍复盘和异常出价提示；未配置模型时有本地兜底结果。
- 本地 JSON 持久化，重启后保留用户、会话、直播间、竞拍、订单和弹幕。

## 技术栈

- Web：React + TypeScript + Vite
- Server：Node.js + Express + Socket.IO + ws + Zod
- 小程序：微信小程序原生 WXML / WXSS / JS
- 数据：本地 JSON 文件持久化
- AI：兼容 OpenAI Chat Completions 风格的接口，可本地兜底

## 项目结构

```text
realtime-auction-master
├── apps
│   ├── server        后端 API、Socket.IO、数据持久化
│   ├── web           Web 主播端与观众端
│   └── miniprogram   微信小程序买家端
├── docs              需求、计划、测试和功能更新文档
└── README.md
```

## 快速开始

安装依赖：

```bash
npm install
```

推荐使用单端口稳定演示模式。Web、API、Socket.IO 和静态资源都由后端托管在 `4300`：

```bash
npm --workspace apps/web run build
PORT=4300 CLIENT_URL=http://localhost:4300 npm --workspace apps/server run start
```

打开：

- 首页：`http://localhost:4300/`
- Web 主播端：`http://localhost:4300/host`
- Web 观众端：`http://localhost:4300/live/live-1`
- 主播创建直播间：`http://localhost:4300/host/setup`

也可以使用开发模式：

```bash
npm run dev
```

开发模式会分别启动后端和 Vite。若端口被占用，Vite 可能自动切换端口；演示时优先使用上面的 `4300` 单端口模式。

## 演示账号

Web 内置演示账号：

| 角色 | 账号 | 密码 |
| --- | --- | --- |
| 商家/主播 | `demo-host` | `demo123` |
| 买家 | `demo-buyer` | `demo123` |

也可以直接注册新账号：

- Web 观众端注册买家账号后，可以在小程序使用同一账号登录。
- Web 主播端注册商家账号后，会进入创建直播间流程。

## 稳定演示状态

本仓库当前已整理为稳定本地演示版本：

- `demo-host / demo123` 默认拥有两个标准直播间：`live-1` 珠宝严选好物专场、`live-2` 腕表收藏好物专场。
- 标准商品图片使用本地静态资源 `/static/jewelry.jpg` 和 `/static/watch.jpg`，不依赖外网图片。
- 主播端商品管理区提供“重置演示数据”按钮，可恢复标准直播间、商品、竞拍、订单、弹幕、用户和会话。
- 重置后建议重新使用 `demo-host / demo123` 和 `demo-buyer / demo123` 登录演示。

## 微信小程序

用微信开发者工具打开：

```text
apps/miniprogram
```

本地联调建议：

1. 先启动 `http://localhost:4300` 单端口服务。
2. 微信开发者工具打开 `apps/miniprogram`。
3. 开启“不校验合法域名、web-view、TLS 版本以及 HTTPS 证书”。
4. 在小程序首页用 Web 买家账号登录，或注册新的买家账号。
5. 进入直播间后可竞拍、发送弹幕、查看订单。

小程序默认依次尝试：

```text
http://localhost:4300
http://127.0.0.1:4300
```

小程序账号说明：

- 注册调用 `/api/auth/web/register`，固定创建 `BUYER` 账号。
- 登录调用 `/api/auth/web/login`。
- 出价和弹幕请求会携带登录 token，服务端使用当前买家身份写入出价和弹幕。

## 主要页面

Web：

- `/`：入口页。
- `/host`：主播控制台。
- `/host/setup`：新主播创建直播间。
- `/live/:liveRoomId`：Web 观众竞拍页。

小程序：

- `pages/index`：买家账号入口和直播间列表。
- `pages/live/index`：观看直播间、竞拍、弹幕、模拟支付。
- `pages/orders/index`：我的订单。

## 环境变量

后端：

```bash
PORT=4300
CLIENT_URL=http://localhost:4300
AUCTION_DATA_FILE=data/auction-state.json
AUCTION_STORAGE=json
DATABASE_URL=
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DATABASE=realtime_auction
AI_API_URL=
AI_API_KEY=
AI_MODEL=
```

说明：

- `PORT`：后端端口。
- `CLIENT_URL`：允许跨域的 Web 地址。
- `AUCTION_STORAGE`：设置为 `mysql` 时启用 MySQL 持久化；未配置时使用本地 JSON。
- `DATABASE_URL`：MySQL 连接字符串，优先级高于拆分的 `MYSQL_*` 配置。
- `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`：MySQL 连接配置。
- `AUCTION_DATA_FILE`：JSON 兜底状态文件路径；MySQL 不可用时仍可保证本地演示。
- `AI_API_URL` / `AI_API_KEY` / `AI_MODEL`：可选 AI 模型配置。

未配置 AI 时，系统会使用本地兜底生成讲解词、复盘和风险提示，保证演示不中断。

## MySQL 持久化

毕设成品建议使用 MySQL。项目支持 MySQL 优先、JSON 兜底：

1. 安装 MySQL 驱动：

```bash
npm install mysql2 --workspace apps/server
```

2. 初始化数据库：

```bash
mysql -u root -p < apps/server/db/mysql-schema.sql
```

3. 启动时启用 MySQL：

```bash
AUCTION_STORAGE=mysql \
MYSQL_HOST=127.0.0.1 \
MYSQL_PORT=3306 \
MYSQL_USER=root \
MYSQL_PASSWORD=your_password \
MYSQL_DATABASE=realtime_auction \
PORT=4300 \
CLIENT_URL=http://localhost:4300 \
npm --workspace apps/server run start
```

也可以使用连接字符串：

```bash
DATABASE_URL=mysql://root:your_password@127.0.0.1:3306/realtime_auction
```

当前 MySQL 表按业务实体拆分为直播间、用户、会话、商品、竞拍、出价、订单、历史、弹幕和屏蔽用户表。每张表用 `entity_key + data_json` 保存实体快照，适合演示阶段稳定迁移；后续可继续拆成完全范式化字段表。

## 核心接口

账号：

- `POST /api/auth/web/register`：注册 Web/小程序共用账号。
- `POST /api/auth/web/login`：账号密码登录。
- `GET /api/me`：获取当前登录用户。
- `GET /api/me/live-rooms`：获取当前主播拥有的直播间。
- `GET /api/me/orders`：获取当前买家订单。

直播间：

- `GET /api/live-rooms`：直播间列表。
- `GET /api/live-rooms/:liveRoomId`：直播间详情。
- `POST /api/live-rooms`：创建主播直播间。

竞拍：

- `GET /api/live-rooms/:liveRoomId/auction`：获取竞拍快照。
- `POST /api/live-rooms/:liveRoomId/auction/start`：开始竞拍。
- `POST /api/live-rooms/:liveRoomId/auction/cancel`：取消竞拍。
- `POST /api/live-rooms/:liveRoomId/auction/bids`：提交出价。
- `POST /api/orders/:orderId/pay`：模拟支付。

商品和 AI：

- `GET /api/live-rooms/:liveRoomId/products`：商品队列。
- `POST /api/live-rooms/:liveRoomId/products/import`：导入商品。
- `POST /api/live-rooms/:liveRoomId/products/:productId/start`：从队列选择商品开拍。
- `POST /api/ai/product-script`：生成商品讲解词。
- `POST /api/ai/auction-summary`：生成竞拍复盘。
- `POST /api/ai/bid-risk`：生成异常出价提示。

弹幕：

- `GET /api/live-rooms/:liveRoomId/danmaku`：弹幕历史。
- `POST /api/live-rooms/:liveRoomId/danmaku`：发送弹幕。
- `POST /api/live-rooms/:liveRoomId/danmaku/:messageId/retract`：撤回弹幕。
- `POST /api/live-rooms/:liveRoomId/danmaku/block-user`：屏蔽弹幕用户。

Socket.IO：

- `auction:snapshot`
- `auction:join-room`
- `auction:bid`
- `auction:bid-success`
- `auction:extended`
- `auction:ended`
- `order:paid`
- `danmaku:history`
- `danmaku:send`
- `danmaku:new`
- `danmaku:retracted`
- `danmaku:user-blocked`

## 演示流程

1. 启动 `4300` 单端口服务。
2. 打开 `/host`，使用 `demo-host / demo123` 登录，或注册新的主播账号。
3. 新主播先创建直播间，填写直播间名称、主播名称和首件商品信息。
4. 主播端开始竞拍。
5. 打开 `/live/live-1` 或小程序首页，使用买家账号登录。
6. 买家提交出价，主播端和观众端同步当前价格和出价记录。
7. 买家发送弹幕，Web 和小程序同直播间可查看弹幕。
8. 出价达到封顶价后自动成交，并生成模拟订单。
9. 买家模拟支付，订单状态更新。
10. 主播使用 AI 助手生成讲解词、复盘或风险提示。

## 验证命令

提交前建议执行：

```bash
npm --workspaces run typecheck
npm --workspaces run build
```

常用冒烟检查：

```bash
curl -I http://localhost:4300/live/live-1
curl -I http://localhost:4300/host/setup
curl http://localhost:4300/api/live-rooms
```

## 文档

- `docs/2026-05-31-danmaku-feature.md`：弹幕、治理、Web/小程序联调更新。
- `docs/test-cases.md`：手工测试用例。
- `docs/final-demo-submission.md`：最终提交材料整理。
- `docs/live-auction-upgrade-requirements.md`：升级需求文档。
- `apps/miniprogram/README.md`：小程序联调说明。

## Git 提交规则

- 一个小功能一个 commit。
- 提交前运行 `npm --workspaces run typecheck`。
- 必要时运行 `npm --workspaces run build`。
- 只暂存本次相关文件，避免混入临时文件。
- commit message 使用清楚前缀，例如：
  - `server:`
  - `web:`
  - `miniprogram:`
  - `docs:`
  - `test:`
  - `chore:`
