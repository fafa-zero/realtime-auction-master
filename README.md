# 实时竞拍大师

这是一个用于课程设计/毕业设计的直播电商实时竞拍 MVP 项目。当前版本定位为“Web 主播运营端 + Web 观众预览页 + 小程序买家端原型”，重点演示直播间竞拍业务闭环和 AI 辅助能力；真实抖音电商接入、真实微信登录/支付、Redis 高并发和数据库持久化属于后续扩展。

## 技术栈

- 前端：React + TypeScript + Vite
- 后端：Node.js + Express + Socket.IO
- 小程序：微信小程序原生页面
- AI 辅助：兼容大模型 API 的 AI 助手接口，本地兜底生成
- 第一阶段存储：本地 JSON 文件持久化
- 后续扩展：MySQL / PostgreSQL + Redis

## 项目结构

```text
realtime-auction-master
├── apps
│   ├── server   后端 API 与 WebSocket 服务
│   ├── web      Web 主播端与观众预览页
│   └── miniprogram   小程序买家端原型
└── docs         项目文档
```

## 当前 MVP 功能

- 查看竞拍商品
- 多直播间列表和直播间独立状态
- 启动竞拍
- 用户实时出价
- 广播当前最高价
- 结束前自动延时
- 达到封顶价自动成交
- 主播取消异常竞拍
- 成交后生成模拟订单
- 小程序演示登录、出价、我的订单
- AI 生成商品讲解词
- AI 生成竞拍复盘总结
- AI 生成异常出价提示

## 运行方式

安装依赖：

```bash
npm install
```

启动前后端：

```bash
npm run dev
```

默认地址：

- Web 主播端：http://localhost:5173/host
- Web 观众预览页：http://localhost:5173/live/live-1
- 后端：http://localhost:4000

如果 5173 被占用，Vite 会自动切到 5174 等下一个端口。

小程序：

- 用微信开发者工具打开 `apps/miniprogram`。
- 默认 API 地址写在 `apps/miniprogram/app.js`，当前为 `http://localhost:4200`。
- 本地联调说明见 `apps/miniprogram/README.md`。

## 环境变量

后端：

```bash
PORT=4000
CLIENT_URL=http://localhost:5173
AUCTION_DATA_FILE=data/auction-state.json
```

`AUCTION_DATA_FILE` 用于保存直播间、用户、会话、竞拍、出价、历史记录和订单。默认写入本地 `data/` 目录，适合演示阶段的轻量持久化；生产环境应替换为数据库。

前端：

```bash
VITE_API_URL=http://localhost:4000
```

## AI 配置

AI 助手默认可以在不配置模型的情况下运行，系统会使用本地兜底策略生成商品讲解词、竞拍复盘和风险提示。

如果需要接入兼容 OpenAI Chat Completions 格式的大模型接口，可配置：

```bash
AI_API_URL=https://api.example.com/v1/chat/completions
AI_API_KEY=your_api_key
AI_MODEL=your_model_name
```

未配置或模型调用失败时，接口会自动返回本地兜底结果，保证演示流程不中断。AI 接口成功时会返回以下结构，前端可根据 `fallback` 展示“模型生成”或“本地兜底”状态：

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

参数错误时返回：

```json
{
  "ok": false,
  "message": "错误原因",
  "fallback": true
}
```

## 主要接口

- `GET /api/health`：健康检查。
- `POST /api/auth/miniprogram/login`：小程序演示登录，支持 `mockCode`。
- `GET /api/me`：通过 Bearer token 查询当前用户。
- `GET /api/me/orders?liveRoomId=live-1`：查询当前用户订单。
- `GET /api/live-rooms`：获取直播间列表。
- `GET /api/live-rooms/default`：获取默认模拟直播间信息，包括主播、直播流地址和当前竞拍 ID。
- `GET /api/live-rooms/:liveRoomId/auction`：获取指定直播间竞拍快照。
- `GET /api/auction`：获取竞拍快照。
- `GET /api/auction/history`：获取最近竞拍历史，用于观众“我的竞拍”和演示复盘。
- `GET /api/orders`：获取内存中的订单列表，用于主播端订单管理。
- `POST /api/auction/start`：启动或重开竞拍。可传演示参数：

```json
{
  "durationSeconds": 30,
  "incrementStep": 100,
  "ceilingPrice": 3000
}
```

`durationSeconds` 范围为 15 到 600 秒，适合录制短 Demo；不传参数时使用默认 90 秒竞拍。

- `POST /api/auction/cancel`：主播取消竞拍。
- `POST /api/auction/bids`：HTTP 出价降级接口，适合 WebSocket 不可用或自动化测试时使用。
- `POST /api/live-rooms/:liveRoomId/auction/bids`：指定直播间出价。小程序可用 Bearer token，不需要前端传 `userId`。
- `POST /api/orders/:orderId/pay`：模拟支付，返回订单和最新快照。
- `POST /api/ai/product-script`：生成商品讲解词。
- `POST /api/ai/auction-summary`：生成竞拍复盘。
- `POST /api/ai/bid-risk`：生成异常出价提示。

Socket.IO 事件：

- `auction:snapshot`：连接或加入房间后的全量快照。
- `auction:bid`：客户端提交出价。
- `auction:bid-success`：有效出价广播。
- `auction:extended`：自动延时广播。
- `auction:ended`：成交或流拍广播。
- `order:paid`：模拟支付成功后的快照广播。

## 演示流程

1. 打开前端页面。
2. 访问 `/host`，选择直播间并配置竞拍时长、最低加价、封顶价。
3. 访问 `/live/live-1` 或 `/live/live-2` 打开 Web 观众预览页。
4. 主播端点击“开始/重开竞拍”，或使用演示出价工具模拟多人出价。
5. Web 观众预览页或小程序直播页提交出价，观察当前最高价和出价记录实时变化。
6. 在倒计时最后 10 秒内出价，观察自动延时。
7. 出价达到封顶价，观察自动成交和订单生成。
8. 点击“模拟支付”，观察订单状态变为已支付。
9. 主播端点击 AI 竞拍助手按钮，生成讲解词、竞拍复盘或异常出价提示。

## 关键代码位置

- 后端入口：`apps/server/src/index.ts`
- 竞拍规则：`apps/server/src/store.ts`
- 前端页面：`apps/web/src/App.tsx`
- 页面样式：`apps/web/src/styles.css`
- 小程序页面：`apps/miniprogram/pages/*`

## 后续开发建议

第一阶段先跑通完整业务闭环，再逐步加入数据库、Redis、登录鉴权和更完整的管理后台。
