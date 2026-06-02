# API Reference

本文档记录当前演示版 REST API、Socket.IO 事件和小程序 WebSocket 事件。所有需要登录的 REST 接口均使用：

```http
Authorization: Bearer <token>
```

常见错误：

- `401`：缺少 token、登录已失效或用户不存在。
- `403`：角色或直播间归属权限不足。
- `404`：直播间、商品、订单或弹幕不存在。
- `400`：请求体字段错误、业务状态不允许或限流。

## Auth

| Method | Path | 权限 | 请求体 | 成功响应 |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/web/register` | 公开 | `account`, `password`, `nickname?`, `role?`, `hostInviteCode?` | `{ ok, user }` |
| POST | `/api/auth/web/login` | 公开 | `account`, `password` | `{ ok, token, expiresAt, user }` |
| POST | `/api/auth/logout` | 登录用户 | 无 | `{ ok: true }` |
| GET | `/api/me` | 登录用户 | 无 | `{ ok, user }` |
| PATCH | `/api/me/profile` | 登录用户 | `nickname?`, `avatarUrl?` | `{ ok, user }` |

注册限制：

- `ADMIN` 不能通过公开注册创建。
- `HOST` 注册需要 `HOST_INVITE_CODE`。
- `BUYER` 可公开注册。

## Live Rooms

| Method | Path | 权限 | 请求体 | 成功响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/live-rooms` | 公开 | 无 | `{ ok, items }` |
| GET | `/api/live-rooms/:liveRoomId` | 公开 | 无 | `{ ok, room }` |
| GET | `/api/me/live-rooms` | 主播/管理员 | 无 | `{ ok, items }` |
| POST | `/api/live-rooms` | 主播/管理员 | `title`, `hostName?`, `productName`, `productDescription`, `startPrice`, `incrementStep`, `ceilingPrice`, `durationSeconds`, `stock?` | `{ ok, room, snapshot }` |

普通主播只能管理自己 `ownerUserId` 对应的直播间；管理员可管理所有直播间。

## Auctions

| Method | Path | 权限 | 请求体 | 成功响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/live-rooms/:liveRoomId/auction` | 公开 | 无 | `AuctionSnapshot` |
| GET | `/api/live-rooms/:liveRoomId/auction/history` | 登录用户 | 无 | `{ ok, items }` |
| GET | `/api/auction/history` | 主播/管理员 | 无 | `{ ok, items }` |
| POST | `/api/live-rooms/:liveRoomId/auction/start` | 房主主播/管理员 | `durationSeconds?`, `incrementStep?`, `ceilingPrice?` | `AuctionSnapshot` |
| POST | `/api/live-rooms/:liveRoomId/auction/cancel` | 房主主播/管理员 | `reason?` | `AuctionSnapshot` |
| POST | `/api/live-rooms/:liveRoomId/auction/bids` | 买家 | `price`, `clientRequestId` | `{ ok, bid, snapshot, extended, settled, duplicate, risk }` |

历史访问规则：

- 买家只能看到自己参与过的出价和自己的订单。
- 主播只能看到自己直播间的完整历史。
- 管理员可查看全部历史。

## Orders

| Method | Path | 权限 | 请求体 | 成功响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/me/orders?liveRoomId=` | 买家 | 无 | `{ ok, items }` |
| GET | `/api/live-rooms/:liveRoomId/orders` | 房主主播/管理员 | 无 | `{ ok, items }` |
| GET | `/api/orders` | 主播/管理员 | 无 | `{ ok, items }` |
| POST | `/api/orders/:orderId/pay` | 成交买家 | 无 | `{ ok, order, snapshot }` |

支付接口只允许订单归属买家调用，主播或其他买家会返回 `403`。

## Products

| Method | Path | 权限 | 请求体 | 成功响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/live-rooms/:liveRoomId/products` | 公开 | 无 | `{ ok, items }` |
| POST | `/api/live-rooms/:liveRoomId/products` | 房主主播/管理员 | 商品字段 | `{ ok, items }` |
| PATCH | `/api/live-rooms/:liveRoomId/products/:productId` | 房主主播/管理员 | 商品字段子集 | `{ ok, items }` |
| DELETE | `/api/live-rooms/:liveRoomId/products/:productId` | 房主主播/管理员 | 无 | `{ ok, items }` |
| POST | `/api/live-rooms/:liveRoomId/products/reorder` | 房主主播/管理员 | `productIds` | `{ ok, items }` |
| POST | `/api/live-rooms/:liveRoomId/products/import` | 房主主播/管理员 | JSON `rows` 或上传文件 | `{ ok, importedCount, failedRows, items }` |
| POST | `/api/live-rooms/:liveRoomId/products/:productId/start` | 房主主播/管理员 | 无 | `AuctionSnapshot` |

商品导入受 `MAX_UPLOAD_BYTES` 限制，默认 2MB。

## Danmaku

| Method | Path | 权限 | 请求体 | 成功响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/live-rooms/:liveRoomId/danmaku` | 公开 | 无 | `{ ok, items }` |
| POST | `/api/live-rooms/:liveRoomId/danmaku` | 登录用户 | `content` | `{ ok, message }` |
| GET | `/api/live-rooms/:liveRoomId/danmaku/blocked-users` | 房主主播/管理员 | 无 | `{ ok, items }` |
| POST | `/api/live-rooms/:liveRoomId/danmaku/:messageId/retract` | 房主主播/管理员 | `reason?` | `{ ok, message }` |
| POST | `/api/live-rooms/:liveRoomId/danmaku/block-user` | 房主主播/管理员 | `userId`, `nickname`, `reason?` | `{ ok, blockedUser }` |

弹幕发送会做敏感词过滤、屏蔽用户校验和发送频率限制。

## Audit Logs

| Method | Path | 权限 | 请求体 | 成功响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/live-rooms/:liveRoomId/audit-logs` | 房主主播/管理员 | 无 | `{ ok, items }` |

审计日志记录主播开拍、取消、商品管理、弹幕治理、演示重置、买家出价、买家支付和登录限流等关键动作。返回最近 20 条。

## AI

| Method | Path | 权限 | 请求体 | 成功响应 |
| --- | --- | --- | --- | --- |
| POST | `/api/ai/product-script` | 房主主播/管理员 | `liveRoomId?`, `productId?` | `{ title, content, source, generatedAt }` |
| POST | `/api/ai/auction-summary` | 房主主播/管理员 | `liveRoomId?` | `{ title, content, source, generatedAt }` |
| POST | `/api/ai/host-cue` | 房主主播/管理员 | `liveRoomId?` | `{ title, content, source, generatedAt }` |
| POST | `/api/ai/bid-risk` | 房主主播/管理员 | `liveRoomId?`, `userId`, `price` | `{ title, content, source, generatedAt, level }` |

未配置模型或模型调用失败时，返回本地兜底内容。

## Socket.IO

连接参数：

```ts
io(API_URL, {
  auth: { token },
  transports: ["websocket", "polling"]
});
```

未提供 token 或 token 已注销时，连接阶段返回 `connect_error`。

| Event | 方向 | Payload | 说明 |
| --- | --- | --- | --- |
| `auction:join` | client -> server | `{ liveRoomId }` | 加入直播间 room 并返回快照 |
| `auction:bid` | client -> server | `{ liveRoomId?, price, clientRequestId }` | 买家出价，服务端使用连接 token 识别用户 |
| `danmaku:send` | client -> server | `{ liveRoomId, content }` | 发送弹幕，服务端使用连接 token 识别用户 |
| `auction:snapshot` | server -> client | `AuctionSnapshot` | 当前快照 |
| `auction:bid-success` | server -> client | `AuctionSnapshot` | 出价成功广播 |
| `auction:extended` | server -> client | `AuctionSnapshot` | 自动延时广播 |
| `auction:ended` | server -> client | `AuctionSnapshot` | 成交/流拍广播 |
| `auction:cancelled` | server -> client | `{ reason, snapshot }` | 取消竞拍广播 |
| `order:paid` | server -> client | `AuctionSnapshot` | 支付成功广播 |
| `danmaku:history` | server -> client | `DanmakuMessage[]` | 弹幕历史 |
| `danmaku:new` | server -> client | `DanmakuMessage` | 新弹幕广播 |
| `danmaku:retracted` | server -> client | `DanmakuMessage` | 撤回弹幕广播 |
| `danmaku:user-blocked` | server -> client | `DanmakuBlockedUser` | 屏蔽用户广播 |

## Miniprogram WebSocket

路径：`/miniprogram-ws`

消息格式：

```json
{ "type": "auction:join", "payload": { "liveRoomId": "live-1" } }
```

小程序 WebSocket 使用 JSON `type + payload`，出价和弹幕事件仍在 payload 中携带 token：

- `auction:join`：`{ liveRoomId }`
- `auction:bid`：`{ liveRoomId, token, price, clientRequestId }`
- `danmaku:send`：`{ liveRoomId, token, content }`
- `ping`：心跳，服务端返回 `pong`

服务端广播事件语义与 Socket.IO 保持一致。
