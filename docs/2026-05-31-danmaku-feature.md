# 2026-05-31 弹幕功能更新文档

## 更新目标

为实时竞拍直播间增加弹幕互动能力，让 Web 主播端、Web 观众端和小程序观众端都能围绕同一个直播间发送和查看互动消息。

## 功能范围

- 后端新增直播间弹幕数据结构 `DanmakuMessage`。
- 后端新增弹幕历史接口：
  - `GET /api/live-rooms/:liveRoomId/danmaku`
  - `POST /api/live-rooms/:liveRoomId/danmaku`
- Socket.IO 新增实时事件：
  - `danmaku:history`
  - `danmaku:send`
  - `danmaku:new`
- 小程序 WebSocket 协议预留弹幕发送事件：
  - `danmaku:send`
  - `danmaku:ack`
  - `danmaku:new`
- Web 直播画面新增弹幕飞屏层和弹幕发送栏。
- 小程序直播页新增弹幕发送区、弹幕列表和直播画面内弹幕展示。

## 后端实现

核心文件：

- `apps/server/src/types.ts`
- `apps/server/src/store.ts`
- `apps/server/src/index.ts`

实现要点：

- 弹幕按 `liveRoomId` 隔离，不会串到其他直播间。
- 单条弹幕内容最多 80 个字符。
- 服务端保留每个直播间最近 80 条弹幕。
- 弹幕写入 `auction-state.json`，重启后可恢复历史。
- Web 端通过 Socket.IO 实时发送和接收。
- 小程序端当前通过 HTTP 接口发送和拉取历史，同时服务端已支持 WebSocket 弹幕协议。

## Web 端实现

核心文件：

- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/types.ts`

实现要点：

- 进入直播间后监听 `danmaku:history` 和 `danmaku:new`。
- 用户发送弹幕时复用当前登录身份和直播间 ID。
- 最新弹幕会在直播画面上横向滚动展示。
- 发送失败时复用现有顶部消息区域提示错误。

## 小程序端实现

核心文件：

- `apps/miniprogram/utils/api.js`
- `apps/miniprogram/pages/live/index.js`
- `apps/miniprogram/pages/live/index.wxml`
- `apps/miniprogram/pages/live/index.wxss`

实现要点：

- 新增 `getDanmakuMessages` 和 `sendDanmaku` API 封装。
- 直播页加载和轮询同步时刷新弹幕历史。
- 发送成功后将新弹幕插入本地列表。
- 页面保留最近 20 条弹幕，直播画面展示最近 5 条。

## 验证结果

已执行：

```bash
npm run typecheck
npm run build
```

两项均通过。

额外冒烟验证：

- `GET /api/live-rooms/live-1/danmaku` 可返回弹幕历史。
- `POST /api/live-rooms/live-1/danmaku` 可创建弹幕。
- Socket.IO 客户端发送 `danmaku:send` 后，另一个同直播间客户端可收到 `danmaku:new`。

## Git 提交说明

本次更新属于一个完整小功能，按项目提交规则合并为一个功能 commit。

建议提交信息：

```text
server: add live room danmaku
```

提交前检查项：

- 已只暂存弹幕功能相关代码和本文档。
- 已运行 `npm --workspaces run typecheck`。
- 已运行 `npm run build`。
