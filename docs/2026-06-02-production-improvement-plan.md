# 2026-06-02 生产化改进计划

## 目标

在当前本地演示版已经稳定可跑的基础上，把项目继续升级为更接近真实直播电商系统的工程版本。重点不是增加更多界面，而是提升竞拍一致性、安全性、可测试性、可部署性和文档完整度。

## 当前基础

当前项目已经具备：

- Web 主播端、Web 买家端和微信小程序买家端。
- 多直播间竞拍、商品队列、弹幕、订单、模拟支付和 AI 助手。
- 主播权限按直播间归属隔离。
- 出价、弹幕和支付已要求登录 token。
- Web 密码使用 `scrypt` 哈希存储。
- 主播注册需要 `HOST_INVITE_CODE` 邀请码。
- 小程序 `/static` 本地图片可正常解析为后端资源地址。
- MySQL 初始化在服务启动前完成，接口返回前会等待最近一次持久化写入。
- 后端集成测试覆盖注册、登录、权限、竞拍、支付、弹幕和历史访问。
- 已新增状态机测试脚本 `npm run test:state-machine`。
- 已新增 `.env.example` 部署配置模板。
- 已新增 `POST /api/auth/logout`，Web 和小程序退出会注销当前 token。
- Socket.IO 已在连接阶段通过 `handshake.auth.token` 鉴权，并把用户身份挂到 `socket.data.user`。
- 已新增审计日志、主播端最近操作列表和 `GET /api/live-rooms/:liveRoomId/audit-logs`。
- 已新增详细接口文档 `docs/api-reference.md`，README 已链接。

## 优先级高

### 1. 竞拍状态改成事务化持久化

目标：避免并发出价、封顶成交、倒计时结束和订单生成之间出现状态不一致。

当前问题：

- 核心竞拍状态仍主要保存在内存数组中。
- MySQL 当前以实体快照方式保存，适合演示和恢复，不适合高并发竞价。
- 多实例部署时，多个 Node 进程之间无法共享内存状态。

建议方案：

- 将竞拍、出价、订单、商品库存拆成明确的数据表。
- `placeBid` 使用数据库事务或 Redis 原子脚本处理。
- 同一场竞拍用 `auction.version` 或行锁保证并发更新安全。
- 封顶成交、库存扣减和订单生成放在同一个事务里。
- WebSocket 广播只在事务成功后发送。

建议拆分步骤：

1. 设计范式化表结构：`auctions`、`bids`、`orders`、`products`、`live_rooms`。
2. 抽出 `AuctionRepository`，让业务逻辑不直接操作内存数组。
3. 先支持单实例 MySQL 事务。
4. 再引入 Redis 锁或 Redis Lua 脚本处理高并发出价。
5. 最后接 Socket.IO Redis adapter 支持多实例广播。

验收标准：

- 同一时间提交多个有效出价，只能按价格和时间规则产生一个最终最高价。
- 达到封顶价时只生成一笔订单。
- 同一商品库存不会被重复扣减。
- 服务重启后竞拍、订单和历史状态仍能恢复。

### 2. 增加状态机单元测试

目标：用自动化测试守住竞拍核心规则，避免后续改 UI 或接口时破坏业务状态。

重点覆盖：

- 重复 `clientRequestId` 只记录一次出价。
- 封顶价立即成交。
- 倒计时结束后有出价则成交。
- 倒计时结束后无出价则流拍。
- 主播取消后不能继续出价。
- 已成交/已流拍/已取消后可以按规则重开。
- 库存只扣减一次。
- 成交订单只生成一次。
- 非买家不能出价。
- 存在过多待支付订单时触发风控拦截。

建议实现：

- 为 `store.ts` 或新的状态机模块拆出纯函数测试。
- 使用临时数据文件或内存 fixture，避免污染演示数据。
- 每个状态用例都断言 `auction.status`、`currentPrice`、`winnerUserId`、`orders`、`history`。

验收标准：

- 新增状态机测试脚本，例如 `npm --workspace apps/server run test:state-machine`。
- 至少覆盖 10 个核心状态流转场景。
- 所有测试可在无 MySQL、无 AI API 的环境下运行。

### 3. Socket 鉴权前置

目标：把 Socket 事件里的重复 token 校验收敛到连接阶段，让实时通信更清晰、更安全。

已完成：

- Socket.IO 使用 `io.use()` 中间件解析 `handshake.auth.token`。
- 用户信息挂到 `socket.data.user`。
- `auction:bid` 和 `danmaku:send` 不再从事件 payload 解析 token。
- 买家事件校验 `socket.data.user.role === "BUYER"`。
- Web 端连接时通过 `auth.token` 传入 token。
- 小程序原生 WebSocket 仍保留 payload token 校验，保证原生协议兼容。

验收标准：

- 未登录 Socket 无法提交出价和弹幕。
- 主播账号通过 Socket 出价会被拒绝。
- 买家账号只能以自己的用户身份出价。
- 事件处理函数不再直接解析 token 字段。

### 4. 真实 logout / session revocation

目标：用户退出后 token 立即失效，而不是等到过期时间。

已新增接口：

```text
POST /api/auth/logout
```

已完成：

- 从 Authorization header 读取当前 token。
- 从 `sessions` 中删除该 token。
- 保存状态并等待持久化完成。
- Web 端 `handleLogout` 调用该接口后再清理 localStorage。
- 小程序 `logout` 调用接口后再清理本地缓存。

验收标准：

- 退出登录后，旧 token 调用 `/api/me` 返回 401。
- 退出登录后，旧 Socket token 不能继续出价或发弹幕。
- 重启服务后，被注销 token 不会恢复有效。

## 优先级中

### 5. 审计日志

目标：记录关键操作，方便答辩展示、问题排查和权限追踪。

建议记录字段：

```text
AuditLog {
  id
  userId
  userNickname
  role
  liveRoomId
  action
  targetId
  detail
  createdAt
}
```

建议记录的动作：

- 主播开拍。
- 主播取消竞拍。
- 主播开始下一件商品。
- 商品新增、编辑、下架、导入和排序。
- 弹幕撤回和屏蔽用户。
- 演示数据重置。
- 买家出价。
- 买家支付。
- 登录失败达到限流阈值。

验收标准：

- 已新增 `GET /api/live-rooms/:liveRoomId/audit-logs`，仅房主主播或管理员可访问。
- 主播端已展示最近 20 条操作记录。
- 审计日志已随 JSON/MySQL 状态持久化。

### 6. OpenAPI / 接口文档

目标：让接口输入、输出和错误码更清晰，提升项目工程完整度。

已输出：

- `docs/api-reference.md`

内容范围：

- 账号认证接口。
- 当前用户和直播间接口。
- 竞拍接口。
- 商品队列和商品导入接口。
- 订单接口。
- 弹幕治理接口。
- AI 助手接口。
- Socket.IO 和小程序 WebSocket 事件说明。

验收标准：

- 文档包含 method、path、权限、请求体、响应说明和错误码。
- README 已链接到接口文档。
- 新增接口已同步到接口文档。

### 7. 前端 E2E 测试

目标：用浏览器自动化覆盖最终演示主流程，减少人工回归成本。

建议使用 Playwright 覆盖：

1. 打开 `/host`，登录 `demo-host / demo123`。
2. 进入 `live-1` 主播控制台。
3. 点击开始竞拍。
4. 打开 `/live/live-1`，登录 `demo-buyer / demo123`。
5. 买家提交有效出价。
6. 主播端同步看到当前价更新。
7. 买家封顶出价触发成交。
8. 成交买家点击模拟支付。
9. 主播端订单状态同步为已支付。

验收标准：

- 新增 E2E 脚本，例如 `npm run test:e2e`。
- 测试启动独立端口和临时数据文件，不污染演示数据。
- 失败时输出截图或 trace，便于定位。

### 8. 部署配置模板

目标：让本地演示、MySQL 演示和生产部署配置更清楚。

建议新增：

```text
.env.example
```

建议包含：

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
HOST_INVITE_CODE=
MAX_UPLOAD_BYTES=2097152
AI_API_URL=
AI_API_KEY=
AI_MODEL=
WECHAT_MINIPROGRAM_APPID=
WECHAT_MINIPROGRAM_SECRET=
```

验收标准：

- README 说明如何从 `.env.example` 创建本地 `.env`。
- 演示模式和 MySQL 模式分别给出启动命令。
- 敏感配置不提交真实值。

## 优先级低但加分

### 9. 订单状态更完整

目标：让订单流程更像真实电商系统。

建议扩展状态：

```text
PENDING_PAYMENT
PAID
CANCELLED
EXPIRED
REFUNDED
```

建议规则：

- `PENDING_PAYMENT` 超时后自动变为 `EXPIRED`。
- 买家可取消未支付订单。
- 主播或管理员可标记异常取消。
- 已支付订单可模拟退款，状态变为 `REFUNDED`。

验收标准：

- 订单状态展示覆盖新增状态。
- 买家订单页和主播订单管理都能看到状态变化。
- 状态流转有测试覆盖。

## 建议落地顺序

短期先做：

1. Playwright E2E。
2. 扩展状态机测试的并发/风控边界。
3. 事务化 MySQL/Redis 竞拍状态设计。

中期再做：

1. 事务化 MySQL/Redis 竞拍状态。
2. 订单状态扩展。
3. 多实例 Socket.IO Redis adapter。

长期加分：

1. 订单状态扩展。
2. 多实例 WebSocket 广播。
3. 生产级支付、退款和风控。

## 0602 当前结论

当前版本已经适合稳定本地演示和答辩展示。当前已完成账号安全、权限隔离、Socket 前置鉴权、审计日志、接口文档、部署模板和状态机测试。下一步最值得投入的是浏览器 E2E 和状态一致性：先用 Playwright 锁住最终演示流程，再逐步把内存状态迁移到事务化存储。
