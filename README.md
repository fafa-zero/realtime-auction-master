# 实时竞拍大师

面向直播电商场景的实时竞拍全栈 Demo。项目模拟“主播配置商品并开拍、买家实时出价、弹幕互动、封顶成交、生成订单、模拟支付、AI 辅助讲解与复盘”的完整业务闭环，适合课程设计、毕业设计、比赛演示和本地功能展示。

远端仓库：

```text
https://github.com/fafa-zero/realtime-auction-master.git
```

> 当前项目是演示级 MVP。真实直播推流、真实微信授权、真实支付、生产级风控、Redis 高并发竞价和完整数据库建模属于后续工程化扩展。

## 功能概览

- 多直播间：直播间、商品、竞拍、订单、弹幕和审计日志按 `liveRoomId` 隔离。
- 主播控制台：创建直播间、管理商品队列、开始/取消竞拍、查看出价、管理订单和治理弹幕。
- 买家竞拍页：买家登录/注册、观看直播间、实时出价、发送弹幕、查看并支付自己的订单。
- 微信小程序：复用 Web 买家账号体系，支持进入同一直播间参与竞拍、发弹幕和查看订单。
- 竞拍状态机：支持 `PENDING`、`ACTIVE`、`SOLD`、`UNSOLD`、`CANCELLED` 状态流转。
- 出价规则：支持起拍价、最低加价、封顶价、倒计时、最后阶段自动延时和封顶自动成交。
- 实时同步：Web 使用 Socket.IO；小程序使用 `/miniprogram-ws`，并保留 REST 请求作为兜底。
- 权限控制：主播不能代替买家出价；Socket 连接使用 token 校验，服务端按登录态识别用户身份。
- 弹幕治理：支持弹幕历史、飞屏展示、限频、敏感词过滤、撤回弹幕和屏蔽用户。
- 审计日志：记录开拍、取消、商品管理、出价、支付、弹幕治理、演示重置和登录限流等关键动作。
- AI 助手：支持商品讲解词、竞拍复盘、主播实时话术和异常出价提示；可接入中科大 LLM 网关，未配置或调用失败时使用本地兜底内容。
- 持久化：默认使用本地 JSON；可切换到 MySQL，MySQL 不可用时仍能保留 JSON 演示兜底。

## 技术栈

- Web：React 18、TypeScript、Vite、Socket.IO Client、Lucide React
- Server：Node.js、Express、Socket.IO、ws、Zod、TypeScript
- 小程序：微信小程序原生 WXML / WXSS / JS
- 数据：本地 JSON 文件或 MySQL
- AI：中科大 LLM 网关 / DeepSeek / 其他兼容 OpenAI Chat Completions 风格的模型接口，可本地兜底

## 项目结构

```text
realtime-auction-master
├── apps
│   ├── server        后端 API、实时通信、竞拍状态机、持久化
│   ├── web           Web 主播端和 Web 买家端
│   └── miniprogram   微信小程序买家端
├── data              本地 JSON 演示状态
├── docs              API、测试用例、演示材料和升级计划
├── package.json      npm workspace 脚本
└── README.md
```

## 环境要求

- Node.js 18 或更高版本
- npm
- 现代浏览器，推荐 Chrome 或 Edge
- 微信开发者工具，小程序联调时需要
- MySQL，可选，仅在需要 MySQL 持久化时使用

## 快速开始

进入项目并安装依赖：

```bash
cd /home/zyy/realtime-auction-master
npm install
```

推荐使用单端口稳定演示模式：

```bash
npm run demo
```

该命令会依次完成 Web 构建、Server 构建、演示数据重置，并以 `4300` 端口启动后端。后端会同时托管 API、Socket.IO、静态图片和前端页面。

如需启用真实 AI 生成，先在 `.env.local` 或启动命令中配置 `USTC_LLM_API_KEY`；未配置时演示仍会返回本地兜底文案。

访问地址：

```text
首页：http://localhost:4300/
主播端：http://localhost:4300/host
主播创建直播间：http://localhost:4300/host/setup
Web 买家端：http://localhost:4300/live/live-1
健康检查：http://localhost:4300/api/health
演示检查：http://localhost:4300/api/demo/check
```

开发模式：

```bash
npm run dev
```

开发模式会同时启动后端和 Vite 前端。Vite 端口可能在被占用时自动变化；正式演示建议优先使用 `npm run demo` 的 `4300` 单端口模式。

## 演示账号

| 角色 | 账号 | 密码 |
| --- | --- | --- |
| 商家/主播 | `demo-host` | `demo123` |
| 买家 | `demo-buyer` | `demo123` |

演示数据包含两个默认直播间：

| 直播间 ID | 名称 | 图片资源 |
| --- | --- | --- |
| `live-1` | 珠宝严选好物专场 | `/static/jewelry.jpg` |
| `live-2` | 腕表收藏好物专场 | `/static/watch.jpg` |

恢复标准演示数据：

```bash
npm run demo:reset
```

重置后建议重新使用 `demo-host / demo123` 和 `demo-buyer / demo123` 登录。

## Web 使用流程

1. 启动 `npm run demo`。
2. 打开 `http://localhost:4300/host`，用 `demo-host / demo123` 登录。
3. 进入直播间后选择商品并开始竞拍。
4. 另开窗口访问 `http://localhost:4300/live/live-1`，用 `demo-buyer / demo123` 登录。
5. 买家提交有效出价，主播端和买家端会实时同步最高价、倒计时、领先用户和出价记录。
6. 买家发送弹幕，主播端可查看、撤回或屏蔽用户。
7. 出价达到封顶价后自动成交并生成待支付订单。
8. 成交买家点击模拟支付，订单状态更新为已支付。
9. 主播端可调用 AI 助手生成商品讲解词、竞拍复盘、主播话术或异常出价提示。

## 微信小程序联调

用微信开发者工具打开：

```text
apps/miniprogram
```

本地联调步骤：

1. 先启动 `npm run demo`，确保 `http://localhost:4300` 可访问。
2. 微信开发者工具打开 `apps/miniprogram`。
3. 开启“不校验合法域名、web-view、TLS 版本以及 HTTPS 证书”。
4. 在小程序首页使用 Web 买家账号登录，或注册新的买家账号。
5. 进入直播间后参与竞拍、发送弹幕、查看订单并模拟支付。

小程序默认依次尝试：

```text
http://localhost:4300
http://127.0.0.1:4300
```

Web 页面和小程序必须连接同一个后端实例，才能共享同一套竞拍状态。

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run demo` | 构建前后端、重置演示数据并启动 `4300` 单端口服务 |
| `npm run demo:reset` | 构建后端并恢复标准演示数据 |
| `npm run dev` | 同时启动 Server 和 Web 开发服务 |
| `npm run build` | 构建全部 workspace |
| `npm run typecheck` | 对全部 workspace 执行 TypeScript 类型检查 |
| `npm run test:state-machine` | 执行后端竞拍状态机测试 |
| `npm --workspace apps/server run test:integration` | 执行后端集成测试 |

提交前建议至少运行：

```bash
npm run typecheck
npm run build
```

## 环境变量

可参考 `.env.example`：

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
MYSQL_CONNECTION_LIMIT=10

HOST_INVITE_CODE=
MAX_UPLOAD_BYTES=2097152

AI_API_URL=
AI_API_KEY=
AI_MODEL=
USTC_LLM_API_KEY=
USTC_LLM_API_URL=https://api.llm.ustc.edu.cn/v1/chat/completions
USTC_LLM_MODEL=deepseek-v4-flash-ascend
DEEPSEEK_API_KEY=
DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions
DEEPSEEK_MODEL=deepseek-v4-flash

WECHAT_MINIPROGRAM_APPID=
WECHAT_MINIPROGRAM_SECRET=
```

关键说明：

- `PORT`：后端服务端口。
- `CLIENT_URL`：允许跨域访问的 Web 地址。
- `AUCTION_DATA_FILE`：本地 JSON 状态文件路径。
- `AUCTION_STORAGE`：设为 `mysql` 时启用 MySQL 持久化；默认使用 JSON。
- `DATABASE_URL`：MySQL 连接字符串，优先级高于拆分的 `MYSQL_*` 配置。
- `HOST_INVITE_CODE`：主播注册邀请码。未配置时不允许公开注册新主播，但内置演示主播可用。
- `MAX_UPLOAD_BYTES`：商品导入文件大小上限，默认 2MB。
- `USTC_LLM_API_KEY`：中科大 LLM 网关 API Key；配置后会默认调用 `https://api.llm.ustc.edu.cn/v1/chat/completions` 和 `deepseek-v4-flash-ascend`。
- `USTC_LLM_API_URL` / `USTC_LLM_MODEL`：中科大 LLM 网关接口地址和模型。
- `DEEPSEEK_API_KEY`：DeepSeek API Key；配置后商品讲解词、主播话术、竞拍复盘和异常出价提示会优先调用 DeepSeek。
- `DEEPSEEK_API_URL` / `DEEPSEEK_MODEL`：DeepSeek 接口地址和模型，默认分别为 `https://api.deepseek.com/chat/completions` 和 `deepseek-v4-flash`。
- `AI_API_URL` / `AI_API_KEY` / `AI_MODEL`：通用 OpenAI 兼容模型配置；优先级最高。模型配置优先级为 `AI_*` > `USTC_LLM_*` > `DEEPSEEK_*`，未配置 key 时使用本地兜底。
- `WECHAT_MINIPROGRAM_APPID` / `WECHAT_MINIPROGRAM_SECRET`：预留给真实微信小程序登录。

中科大 LLM 网关启动示例：

```bash
USTC_LLM_API_KEY=your_ustc_llm_key npm run demo
```

也可以在仓库根目录创建 `.env`，该文件已被 `.gitignore` 忽略，不会提交到远端：

```bash
USTC_LLM_API_KEY=your_ustc_llm_key
```

然后直接运行：

```bash
npm run demo
```

主播端商品队列点击“重新生成讲解词”后，会自动调用中科大 LLM 网关生成商品讲解词；接口成功时返回 `source: "model"` 和 `message: "USTC LLM 生成成功"`，如果模型调用失败则回退到本地兜底文案。

## MySQL 持久化

默认 JSON 已满足本地演示。需要 MySQL 时执行：

```bash
mysql -u root -p < apps/server/db/mysql-schema.sql
```

启动时启用 MySQL：

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

当前 MySQL 表按业务实体拆分为直播间、用户、会话、商品、竞拍、出价、订单、历史、弹幕、屏蔽用户和审计日志表。每张表用 `entity_key + data_json` 保存实体快照，便于演示阶段稳定迁移；后续可继续拆成更细的范式化字段表。

## 核心接口

详细接口见 [docs/api-reference.md](docs/api-reference.md)。需要登录的 REST 接口统一使用：

```http
Authorization: Bearer <token>
```

常用 REST 接口：

| 模块 | 接口 |
| --- | --- |
| 健康检查 | `GET /api/health`、`GET /api/demo/check` |
| 登录注册 | `POST /api/auth/web/register`、`POST /api/auth/web/login`、`POST /api/auth/logout`、`GET /api/me` |
| 直播间 | `GET /api/live-rooms`、`GET /api/live-rooms/:liveRoomId`、`POST /api/live-rooms` |
| 商品 | `GET /api/live-rooms/:liveRoomId/products`、`POST /api/live-rooms/:liveRoomId/products/import`、`POST /api/live-rooms/:liveRoomId/products/:productId/start` |
| 竞拍 | `GET /api/live-rooms/:liveRoomId/auction`、`POST /api/live-rooms/:liveRoomId/auction/start`、`POST /api/live-rooms/:liveRoomId/auction/bids`、`POST /api/live-rooms/:liveRoomId/auction/cancel` |
| 订单 | `GET /api/me/orders`、`GET /api/live-rooms/:liveRoomId/orders`、`POST /api/orders/:orderId/pay` |
| 弹幕 | `GET /api/live-rooms/:liveRoomId/danmaku`、`POST /api/live-rooms/:liveRoomId/danmaku`、`POST /api/live-rooms/:liveRoomId/danmaku/:messageId/retract`、`POST /api/live-rooms/:liveRoomId/danmaku/block-user` |
| 审计 | `GET /api/live-rooms/:liveRoomId/audit-logs` |
| AI | `POST /api/ai/product-script`、`POST /api/ai/auction-summary`、`POST /api/ai/host-cue`、`POST /api/ai/bid-risk` |

Socket.IO 连接示例：

```ts
io(API_URL, {
  auth: { token },
  transports: ["websocket", "polling"]
});
```

主要事件：

```text
auction:join
auction:snapshot
auction:bid
auction:bid-success
auction:extended
auction:ended
auction:cancelled
order:paid
danmaku:history
danmaku:send
danmaku:new
danmaku:retracted
danmaku:user-blocked
```

小程序 WebSocket 路径：

```text
/miniprogram-ws
```

消息格式：

```json
{ "type": "auction:join", "payload": { "liveRoomId": "live-1" } }
```

## 商品导入

商品导入模板：

```text
docs/product-import-template.csv
```

示例数据：

```text
docs/product-import-demo-top10.csv
```

商品图片字段可填写本地静态资源或网络图片：

```text
/static/jewelry.jpg
/static/watch.jpg
https://example.com/product.jpg
```

## 文档索引

- [API Reference](docs/api-reference.md)：REST、Socket.IO 和小程序 WebSocket 接口说明。
- [测试用例](docs/test-cases.md)：手工测试路径和验收要点。
- [稳定本地访问方案](docs/stable-localhost.md)：WSL / 本地 `4300` 单端口演示说明。
- [最终演示材料](docs/final-demo-submission.md)：比赛或课程提交材料整理。
- [小程序说明](apps/miniprogram/README.md)：微信小程序本地联调和上线边界。

## 生产化边界

当前版本重点保证演示闭环清晰、功能可操作、状态可恢复。正式上线前建议补齐：

- 接入真实直播流、商品库、库存系统和支付系统。
- 使用 Redis Lua 或数据库事务保证多实例竞价原子性。
- 使用消息队列和 WebSocket 广播集群支撑高并发。
- 完善登录鉴权、风控策略、敏感词库、审计查询和后台权限。
- 使用正式 HTTPS 域名、WSS 域名和微信小程序合法域名配置。
- 将 MySQL 快照表逐步拆成更细粒度的业务字段和索引。

## Git 提交流程

本项目当前主分支为 `main`。提交前建议：

```bash
git status
npm run typecheck
npm run build
git add README.md
git commit -m "docs: rewrite readme"
git push origin main
```
