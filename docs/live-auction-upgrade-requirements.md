# 实时竞拍大师：Web 直播 + 小程序观看升级需求文档

## 1. 升级版定位

当前项目已经跑通“单直播间、单竞拍、实时出价、自动延时、成交订单、模拟支付、AI 助手”的 MVP。最终希望形成的产品效果是：

```text
Web 端开直播 / 管竞拍 + 用户登录小程序看直播 / 参与竞拍
```

接下来十天不直接追求真正商业上线，而是把项目升级为：

```text
Web 主播运营端 + 小程序观众端接口契约 + Web 观众预览页 + 多直播间 + 模拟直播流 + 竞拍数据持久化 + 可解释的并发控制设计
```

升级版仍然是课程 / 比赛 / 毕设可演示原型，不是完整抖音电商平台。真实直播推流、微信小程序审核和类目权限、真实支付、生产级风控、平台资质和大规模高可用部署属于后续商业化阶段。

## 2. 当前基线

已完成能力：

- React + TypeScript + Vite 前端页面。
- Express + Socket.IO 后端服务。
- 主播端 / 观众端视图切换。
- 默认直播间元数据展示。
- 用户实时出价和多端同步。
- 竞拍状态机：`PENDING`、`ACTIVE`、`SOLD`、`UNSOLD`、`CANCELLED`。
- 自动延时、封顶成交、倒计时成交、流拍、取消竞拍。
- 成交订单、订单列表、模拟支付。
- 竞拍历史和本地 JSON 持久化。
- AI 商品讲解词、竞拍复盘、异常出价提示和本地 fallback。
- 开发环境前端代理 `/api` 和 `/socket.io`，便于端口转发环境演示。

当前主要限制：

- 业务数据仍然围绕默认 `live-1` 和 `auction-1`。
- 前端还不是独立路由，主播端和观众端只是同页切换。
- 直播流目前只是商品图片和直播间视觉模拟。
- 竞拍状态仍是单进程内存对象 + JSON 文件，不适合多实例并发。
- 没有真实账号体系，用户和主播身份仍是模拟数据。
- 没有小程序端，观众登录、直播观看和竞拍仍发生在 Web 页面内。

## 3. 升级目标

### 3.1 P0 目标：直播竞拍原型成立

升级后应能演示：

1. 访问主播端 `/host`，主播可以选择直播间、配置竞拍、开始 / 取消竞拍、查看出价和订单。
2. Web 端提供 `/live/:liveRoomId` 观众预览页，用于开发调试和答辩演示。
3. 小程序最终入口为 `pages/live/index?liveRoomId=live-1`，用户登录后进入指定直播间观看直播和出价。
4. 后端 REST API 和实时消息都使用 `liveRoomId` / `auctionId`，避免继续写死单一竞拍。
5. 每个直播间使用独立实时消息房间，A 直播间出价不会广播到 B 直播间。
6. 页面展示模拟直播流区域，后续可替换为 HLS / 云直播拉流。
7. 竞拍、出价、订单、历史记录可以跨服务重启保留。

### 3.2 P1 目标：更像真实系统

升级后尽量完成：

1. 支持多个模拟直播间列表。
2. 支持每个直播间绑定一个当前竞拍。
3. 支持主播配置竞拍参数：时长、最低加价、封顶价。
4. 支持小程序端登录态、直播间列表、直播间详情、实时竞拍和“我的订单”。
5. 支持 Web 观众预览页的“我的竞拍记录”和“我的订单”，用于复用小程序接口并降低联调风险。
6. 补充接口文档、测试用例和演示脚本。

### 3.3 P2 目标：为生产级扩展留接口

本阶段可以只做设计或局部实现：

1. SQLite / PostgreSQL 数据表设计。
2. Redis 原子出价方案设计。
3. Socket.IO Redis Adapter 多实例广播方案。
4. 小程序登录、鉴权、HTTPS / WSS 域名和支付沙箱的接口边界。

### 3.4 最终产品形态

最终效果按三端划分：

- Web 主播 / 运营端：主播在浏览器登录后台，选择直播间、配置商品和竞拍规则、开始 / 取消竞拍、查看订单和复盘。
- 小程序观众端：用户在微信小程序登录，进入直播间，看直播、出价、查看成交结果、进入我的订单并完成后续支付流程。
- 后端服务：统一管理直播间、用户、竞拍、出价、订单、历史和 AI 助手，对 Web 和小程序暴露同一套业务能力。

Web `/live/:liveRoomId` 不作为最终用户主入口，只作为开发调试、桌面演示和小程序能力未完成前的兼容入口。

## 4. 用户角色

### 4.1 主播 / 运营

入口：

```text
/host
```

核心需求：

- 查看直播间列表。
- 进入某个直播间控制台。
- 查看当前商品、竞拍状态、实时出价、成交结果和订单。
- 设置竞拍规则：竞拍时长、最低加价、封顶价。
- 开始竞拍、取消竞拍、重开竞拍。
- 使用 AI 助手生成讲解词、复盘和风险提示。

### 4.2 观众 / 买家

入口：

```text
小程序：pages/live/index?liveRoomId=live-1
Web 预览：/live/:liveRoomId
```

核心需求：

- 使用小程序登录进入系统，后端生成业务用户身份。
- 进入指定直播间。
- 在小程序内查看直播画面、商品信息、竞拍规则、当前最高价和倒计时。
- 填写昵称并实时出价。
- 看到领先用户、出价记录、自动延时提醒和成交结果。
- 成交后模拟支付。
- 查看自己的参与记录。

阶段边界：

- 第一阶段可以用模拟登录和模拟直播流完成闭环。
- 第二阶段再接微信登录、正式直播拉流和支付沙箱。

### 4.3 系统服务

核心职责：

- 管理直播间、竞拍、出价、订单和历史记录。
- 管理小程序用户登录态，将微信用户身份映射到业务 `userId`。
- 校验竞拍状态和出价规则。
- 维护每个直播间独立的 Socket.IO room。
- 结算竞拍并保证订单幂等。
- 提供 AI 助手 fallback，保证演示不中断。

## 5. 功能需求

### 5.1 多直播间

新增概念：

```text
LiveRoom
- id
- title
- hostName
- streamUrl
- viewerCount
- currentAuctionId
```

需求：

- 后端提供直播间列表接口。
- 前端主播端可以选择直播间。
- 观众端根据 URL 中的 `liveRoomId` 加载对应直播间。
- 不存在的直播间返回明确错误。

建议接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/live-rooms` | 查询直播间列表 |
| GET | `/api/live-rooms/:liveRoomId` | 查询直播间详情 |
| GET | `/api/live-rooms/:liveRoomId/auction` | 查询该直播间当前竞拍快照 |

### 5.2 小程序登录和用户身份

新增概念：

```text
User
- id
- openId
- nickname
- avatarUrl
- role
- createdAt

Session
- token
- userId
- expiresAt
```

需求：

- 小程序端调用微信登录拿到临时 `code`，提交给后端换取业务 token。
- 演示阶段允许 `mockCode` / `nickname` 模拟登录，保证没有微信开发者资质时也能跑通。
- 后端所有小程序侧下单、出价、我的订单接口都应基于 token 识别用户，不依赖前端随意传 `userId`。
- Web 预览页可以继续使用本地模拟用户，但接口字段应尽量和小程序一致。

建议接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/miniprogram/login` | 小程序登录，入参为 `code` 或演示用 `mockCode` |
| GET | `/api/me` | 查询当前用户 |
| PATCH | `/api/me/profile` | 更新昵称、头像等展示信息 |

验收标准：

- 小程序端首次进入直播间会先建立用户身份。
- 同一用户出价后，刷新小程序仍能查看自己的竞拍记录和订单。
- 演示模式不依赖真实微信登录也能完成闭环。

### 5.3 主播端独立页面

需求：

- `/host` 作为主播控制台入口。
- 顶部展示直播间选择器。
- 主体展示竞拍控制、实时出价、订单管理、AI 助手。
- 竞拍配置表单支持：
  - `durationSeconds`
  - `incrementStep`
  - `ceilingPrice`
- 开始竞拍后，同一直播间观众端实时同步。

验收标准：

- 主播在 `live-1` 开始竞拍，只影响 `live-1`。
- 主播切换直播间后，页面展示对应直播间的状态。
- 竞拍开始、取消、成交、支付后页面状态正确。

### 5.4 小程序观众端和 Web 预览页

需求：

- 小程序 `pages/live/index` 作为最终观众入口，通过 `liveRoomId` 加载直播间。
- 小程序启动时先完成登录，拿到后端签发的业务 token，再请求直播间和竞拍接口。
- 小程序直播页展示直播区、竞拍区、出价区、成交区、我的订单入口。
- Web `/live/:liveRoomId` 保留为观众预览页，复用同一套后端接口，用于浏览器调试和演示。
- 观众端只能看到当前直播间的竞拍广播。
- 直播间不存在时展示错误页，不让页面空白。

验收标准：

- 打开两个 Web 预览窗口，均访问 `/live/live-1`，出价实时同步。
- 再打开 `/live/live-2`，`live-1` 的出价不影响 `live-2`。
- 小程序体验版进入 `live-1` 后，可以看到同一场竞拍状态并参与出价。
- 小程序登录失败、直播间不存在、网络断开时都有明确提示。

### 5.5 实时消息和房间隔离

房间命名：

```text
room:live:{liveRoomId}
```

客户端加入：

```ts
socket.emit("auction:join", { liveRoomId });
```

小程序客户端加入：

```json
{
  "type": "auction:join",
  "payload": {
    "liveRoomId": "live-1"
  }
}
```

服务端广播：

- `auction:snapshot`
- `auction:started`
- `auction:bid-success`
- `auction:extended`
- `auction:ended`
- `auction:cancelled`
- `order:paid`

要求：

- 所有广播必须发到对应 `room:live:{liveRoomId}`。
- 回调响应中返回 `ok` 和 `message`，方便前端展示错误。
- 每个快照携带 `auction.version`，前端只接受不落后的版本。
- Web 端可以继续使用 Socket.IO。
- 小程序端优先使用微信原生 WebSocket 能力，消息体使用 JSON `type + payload`，避免强依赖浏览器 `socket.io-client`。
- 如果演示阶段暂不做小程序 WebSocket，可以先用短轮询 `/api/live-rooms/:liveRoomId/auction` 兜底，但最终实时竞拍应走 WebSocket。

### 5.6 Web 开播和小程序直播流

本阶段不接真实推流服务，先做 HLS / 云直播 ready 的模拟区。最终真实直播可以按两步走：

1. Web 主播端用浏览器摄像头采集，通过第三方云直播 SDK、WebRTC 网关或 OBS 推流生成直播流。
2. 小程序端用 `LiveRoom.streamUrl` 播放对应直播流，并和竞拍 WebSocket 同步显示价格、倒计时和出价记录。

需求：

- `LiveRoom.streamUrl` 保留 `.m3u8` 字段。
- Web 主播端展示模拟开播画面、直播状态、观看人数和当前商品。
- Web 预览页优先展示模拟视频 / 静态直播画面。
- 小程序端预留 `live-player` 或云直播组件接入点；没有真实流时展示稳定 fallback。
- 如果后续接入 HLS，Web 预览页可以替换为 `hls.js` 播放器。
- 文档说明当前是模拟直播流，不是生产直播推拉流；真实小程序直播还需要满足类目、资质、域名和审核要求。

验收标准：

- Web 主播端和观众端直播区不是空白。
- 小程序直播流失败时不会影响竞拍数据展示。
- 移动端和桌面端都能看清商品和竞拍信息。
- 没有因为视频资源失败导致整个页面崩溃。

### 5.7 数据持久化

当前已有 JSON 文件持久化。升级路线分两步：

第一步：整理 JSON 状态结构，使其支持多直播间。

```text
liveRooms[]
users[]
sessions[]
products[]
auctions[]
bids[]
orders[]
history[]
```

第二步：设计 SQLite / PostgreSQL 表结构，后续替换 JSON。

建议表：

- `users`
- `sessions`
- `live_rooms`
- `products`
- `auctions`
- `bids`
- `orders`
- `auction_history`

验收标准：

- 服务重启后直播间、竞拍历史、订单仍在。
- 一个竞拍只生成一笔订单。
- 支付后状态可持久化。
- 用户身份和订单归属可以持久化。

### 5.8 AI 助手升级

现有 AI 助手继续保留，升级为“直播间上下文 AI 助手”。

需求：

- 商品讲解词应包含直播间名、主播名和当前竞拍规则。
- 竞拍复盘应包含直播间、成交状态、最高价、参与人数和出价次数。
- 风险提示应结合当前直播间、用户出价、封顶价和出价频率。
- AI 返回仍保持统一结构：

```json
{
  "ok": true,
  "title": "AI 商品讲解词",
  "content": "生成内容",
  "generatedAt": 1710000000000,
  "source": "model",
  "fallback": false,
  "message": "模型生成成功"
}
```

验收标准：

- 不配置模型 API 时仍能稳定返回 fallback。
- 参数错误返回 `ok: false`、`message`、`fallback: true`。
- 前端能明确展示“模型生成 / 本地兜底”。

## 6. 非功能需求

### 6.1 可演示性

- `npm run typecheck` 必须通过。
- `npm run build` 必须通过。
- 默认运行方式仍保持简单：

```bash
npm run dev
```

- 默认前端地址：

```text
http://localhost:5173
```

### 6.2 稳定性

- 页面不能因为后端错误直接空白。
- API 错误要展示可读提示。
- Socket 断线后要自动重连。
- 重连后通过 REST API 或 `auction:snapshot` 校准最新状态。
- 小程序网络断开后要展示重连状态，并通过最新快照校准竞拍状态。

### 6.3 一致性

- 出价必须由服务端校验。
- 出价请求必须包含 `clientRequestId`。
- 订单生成必须幂等。
- 快照必须包含 `serverTime` 和 `version`。
- 小程序端的出价、订单和支付接口必须从 token 解析用户身份。

### 6.4 扩展性

- 前端不要继续写死 `auction-1`。
- 后端接口路径逐步使用 `liveRoomId` 和 `auctionId`。
- Store 层要为多直播间留出数据结构。
- 实时消息事件要和客户端技术无关，Web Socket.IO 和小程序 WebSocket 共享同一套事件语义。
- 直播流字段要兼容模拟流、HLS 和后续云直播地址。

### 6.5 小程序运行约束

- 小程序正式体验需要配置 HTTPS request 合法域名和 WSS socket 合法域名。
- 本地联调可以先使用微信开发者工具的“不校验合法域名”能力，但文档必须标注这不是生产配置。
- 真正上线直播能力需要满足微信小程序直播相关类目、资质、组件权限和审核要求。
- 小程序端不要依赖浏览器 DOM、`window` 或 `socket.io-client` 的浏览器运行时。

## 7. 十天实施计划

### 第 1 天：路由和页面入口拆分

目标：

- 前端增加 `/host` 和 `/live/:liveRoomId`。
- 保留 `/` 自动跳转到 `/live/live-1` 或展示入口选择。

前端任务：

- 在 `apps/web/src/App.tsx` 内先用轻量路由解析 `window.location.pathname`。
- 拆出 `HostView`、`LiveView`、共用竞拍面板组件。
- 确保旧页面功能不丢。

后端任务：

- 确认 `/api/live-rooms/:liveRoomId` 和 `/api/live-rooms/:liveRoomId/auction` 可用。

建议 commit：

```text
frontend: split host and live room views
```

验收：

- `/host` 能打开主播视图。
- `/live/live-1` 能打开观众视图。
- 两个页面都能看到同一场竞拍状态。

### 第 2 天：多直播间数据结构

目标：

- Store 从单对象升级为多直播间容器。

后端任务：

- 将 `liveRoom` 改为 `liveRooms`。
- 将 `auction` 改为按 `auctionId` 或 `liveRoomId` 查询。
- 增加至少两个模拟直播间：`live-1`、`live-2`。
- `getSnapshot(liveRoomId)` 返回指定直播间快照。

前端任务：

- 主播端展示直播间选择器。
- 观众端根据 URL 请求对应直播间。

建议 commit：

```text
server: support multiple live room snapshots
frontend: load auction state by live room id
```

验收：

- `GET /api/live-rooms` 返回多个直播间。
- `GET /api/live-rooms/live-1/auction` 和 `live-2` 返回不同快照。

### 第 3 天：实时消息 room 完整隔离

目标：

- 出价、开始、取消、成交、支付全部按直播间广播。

后端任务：

- Socket `auction:bid` payload 增加 `liveRoomId` 或 `auctionId`。
- 后端从 payload 定位对应竞拍。
- 所有 emit 使用 `room:live:{liveRoomId}`。
- 错误直播间返回 `auction:error`。
- 整理事件 payload，使其可以映射为小程序 WebSocket 的 JSON `type + payload` 格式。

前端任务：

- 连接后 `auction:join` 带上 `liveRoomId`。
- 出价 payload 带上当前 `liveRoomId`。
- 切换直播间时重新 join。

建议 commit：

```text
server: isolate auction socket events by live room
frontend: send live room id with socket actions
```

验收：

- 两个浏览器分别打开 `live-1` 和 `live-2`。
- `live-1` 出价不会刷新 `live-2`。

### 第 4 天：主播竞拍配置表单

目标：

- 主播端可以配置竞拍参数，不只使用默认值。

前端任务：

- 增加竞拍配置表单。
- 支持时长、最低加价、封顶价。
- 做基本输入校验和错误提示。

后端任务：

- 复用现有 start schema。
- 将启动接口切到 `/api/live-rooms/:liveRoomId/auction/start`。

建议 commit：

```text
frontend: add host auction settings form
server: start auctions from live room routes
```

验收：

- 主播设置 30 秒、加价 50、封顶 1000 后开始竞拍。
- 观众端看到规则同步变化。

### 第 5 天：模拟直播流体验

目标：

- Web 主播端和观众预览页更像直播间，而不是单纯商品图，并为小程序直播组件预留字段。

前端任务：

- 增加直播状态条、主播信息、观看人数、直播间标题。
- 使用 `streamUrl` 字段预留 HLS 播放器入口。
- 视频不可用时展示稳定 fallback。

建议 commit：

```text
frontend: improve mock live stream stage
```

验收：

- 桌面端和移动端首屏都能看到直播间身份、商品和竞拍状态。

### 第 6 天：持久化结构升级

目标：

- JSON 持久化支持多直播间。

后端任务：

- 调整 `AUCTION_DATA_FILE` 保存结构。
- 兼容旧数据或在文档说明重置方式。
- 保证订单和历史记录按直播间归档。

建议 commit：

```text
server: persist multi-room auction state
```

验收：

- 完成一场 `live-1` 竞拍并支付。
- 重启服务后订单和历史仍存在。
- `live-2` 状态不被污染。

### 第 7 天：我的竞拍和订单列表

目标：

- Web 预览页和小程序接口有更完整的用户闭环。

前端任务：

- Web 预览页展示“我的竞拍记录”。
- 成交用户看到模拟支付入口。
- 非成交用户看到成交结果但不能支付该订单。

后端任务：

- 增加按 token / `userId` 过滤的历史 / 订单接口。
- 增加演示版小程序登录接口 `/api/auth/miniprogram/login`，支持 `mockCode`。

建议 commit：

```text
frontend: add buyer auction history and order state
server: add demo miniprogram login and user orders
```

验收：

- 用户 A 出价并成交后，用户 A 能看到订单。
- 用户 B 只能看到成交结果和历史，不显示支付自己的按钮。
- 使用演示登录 token 调接口时，订单归属能正确过滤。

### 第 8 天：小程序观众端骨架

目标：

- 建立最小可演示的小程序观众端，让最终形态可以被看见。

任务：

- 新增 `apps/miniprogram` 或独立小程序目录。
- 实现小程序页面：
  - `pages/index`：直播间列表。
  - `pages/live/index`：直播观看、当前竞拍、出价、成交结果。
  - `pages/orders/index`：我的订单。
- 小程序端先使用 REST 快照 + 短轮询，或接入 WebSocket JSON 事件。
- 补充小程序 `appId`、接口域名和本地联调说明。

建议 commit：

```text
miniprogram: add buyer live room prototype
```

验收：

- 微信开发者工具可以打开小程序目录。
- 小程序能登录演示用户、进入 `live-1`、查看竞拍状态并提交出价。
- 小程序端刷新后能看到自己的订单。

### 第 9 天：测试用例和自动化脚本

目标：

- 把核心流程可重复验证。

任务：

- 更新 `docs/test-cases.md`，加入多直播间、小程序登录、小程序出价用例。
- 增加最小 Node 脚本或 npm script，验证：
  - 健康检查
  - 小程序演示登录
  - 创建 / 开始竞拍
  - HTTP 出价
  - Web 实时广播
  - 小程序快照 / WebSocket 消息
  - 封顶成交
  - 支付
  - 重启后持久化

建议 commit：

```text
docs: add web and miniprogram test cases
test: add live room smoke checks
```

验收：

- `npm run typecheck` 通过。
- `npm run build` 通过。
- 手工测试清单覆盖 `live-1` / `live-2` 隔离和小程序演示登录。

### 第 10 天：文档、最终联调和彩排

目标：

- 形成可提交、可演示版本。

任务：

- 更新 README。
- 更新 `docs/final-demo-submission.md`。
- 增加系统架构图说明：
  - Web 主播端
  - Web 观众预览页
  - 小程序观众端
  - REST API
  - 实时消息 room
  - Store / Persistence
  - AI Assistant
- 补充后续 Redis / DB / 微信登录 / 微信支付 / 云直播设计说明。
- 打开两个直播间、两个浏览器窗口和一个小程序预览进行彩排。
- 跑完整流程：
  - 主播开拍
  - Web 预览观众出价
  - 小程序观众出价
  - 实时消息多端同步
  - 自动延时
  - 封顶成交
  - 订单生成
  - 模拟支付
  - AI 讲解 / 复盘
- 修复明显 UI 文案、空白页、错误提示问题。
- 填写最终提交 hash、演示视频链接、仓库链接。

建议 commit：

```text
docs: document web and miniprogram live auction demo
chore: prepare final live auction demo
```

验收：

- `npm run typecheck` 通过。
- `npm run build` 通过。
- `git status --short` 干净。
- 演示视频脚本和测试清单完成。

## 8. 推荐开发顺序

严格按这个顺序做，减少返工：

1. 先拆 Web 前端路由，但不改业务规则。
2. 再改后端多直播间数据结构。
3. 再做实时消息 room 隔离。
4. 然后补主播配置和 Web 观众预览体验。
5. 再补小程序登录接口和小程序观众端骨架。
6. 最后升级持久化、测试和文档。

不要一开始就接 Redis、数据库、真实直播、真实微信支付或正式微信登录。那些会扩大复杂度，容易破坏当前已经能演示的核心闭环。

## 9. 并行开发建议

### 窗口 A：Web 前端

负责文件：

- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`
- 必要时新增 `apps/web/src/*` 组件文件
- `apps/web/vite.config.ts`

任务：

- `/host` 和 `/live/:liveRoomId`。
- 主播端控制台。
- Web 观众预览页。
- 多直播间选择和错误页。
- 模拟直播区和移动端体验。

### 窗口 B：后端

负责文件：

- `apps/server/src/index.ts`
- `apps/server/src/store.ts`
- `apps/server/src/types.ts`
- `apps/server/src/ai.ts`

任务：

- 多直播间数据结构。
- REST API 动态路由。
- 实时消息 room 隔离。
- 小程序演示登录、用户身份和我的订单接口。
- JSON 持久化结构升级。

### 窗口 C：小程序 + 文档

负责文件：

- `apps/miniprogram/**` 或最终选择的小程序目录。
- `docs/*.md`
- `README.md`

任务：

- 小程序项目骨架。
- 直播间列表、直播详情、出价、订单页面。
- 小程序 request / WebSocket 客户端封装。
- 小程序本地联调说明。
- 测试清单和演示材料。

协作规则：

- A 不改后端，B 不改 Web 前端，C 不改后端核心竞拍逻辑，除非提前约定接口字段。
- Web、小程序和后端联动先写接口约定，再分别实现。
- 一个小功能一个 commit。
- commit message 使用清楚前缀：

```text
frontend: split host and live room views
server: support multiple live room snapshots
miniprogram: add buyer live room prototype
docs: add multi-room auction test cases
test: add live room smoke checks
```

## 10. 验收清单

### 多直播间

- `GET /api/live-rooms` 返回多个直播间。
- `/live/live-1` 和 `/live/live-2` 可分别打开。
- 小程序可以进入 `pages/live/index?liveRoomId=live-1`。
- 不存在的直播间显示错误提示。

### 主播端

- `/host` 可打开。
- 可选择直播间。
- 可配置竞拍规则。
- 可开始、取消、重开竞拍。
- 可查看订单和历史。

### 小程序观众端

- 可完成演示登录。
- 可进入指定直播间。
- 可查看商品、规则、倒计时、出价记录。
- 可出价。
- 可看到成交结果。
- 成交用户可模拟支付。
- 可查看自己的订单。

### Web 观众预览页

- `/live/live-1` 和 `/live/live-2` 可作为桌面端预览入口。
- Web 预览页复用同一套后端接口。
- Web 预览页不能成为唯一观众端实现依据。

### 实时同步

- 同一直播间多个 Web 窗口同步。
- 小程序端能通过 WebSocket 或短轮询获得最新快照。
- 不同直播间互不影响。
- 自动延时广播正确。
- 成交和支付广播正确。

### 持久化

- 重启后历史和订单保留。
- 订单状态支付后保留。
- 多直播间状态互不覆盖。

### 工程质量

- `npm run typecheck` 通过。
- `npm run build` 通过。
- 页面没有空白页。
- 错误提示可读。
- 小程序项目能在微信开发者工具打开。
- README 和最终提交文档同步更新。

## 11. 后续商业化路线

当前升级版完成后，如果继续往真实平台走，需要新增：

- 账号体系和权限：主播、观众、管理员。
- 数据库：PostgreSQL / MySQL。
- Redis：原子出价、竞拍锁、Socket.IO Redis Adapter 或统一 WebSocket 网关。
- 支付沙箱：微信支付 / 支付宝 / Stripe。
- 真实直播：腾讯云、阿里云、Agora、SRS 或其他 HLS / WebRTC 方案。
- 微信小程序正式能力：正式 `appId`、登录 `code2Session`、合法域名、直播组件权限、体验版和审核发布。
- 风控：异常出价、频率限制、黑名单、设备指纹。
- 运营后台：商品审核、订单售后、退款、争议处理。
- 部署：反向代理、HTTPS、日志、监控、备份。

这些内容应放在升级版之后，不作为接下来十天的 P0 目标。
