# 好物助手小程序原型

这是买家侧微信小程序原型，用于演示“用户登录小程序查看好物专场并参与互动购买”的最终形态。

## 名称建议

- 小程序名称：好物助手
- 小程序简称：好物助手

“好物助手”共 4 个中文字，按微信规则计 8 个字符，满足名称 4-30 个字符限制，也满足简称 4-10 个字符限制。名称避开个人主体不适合备案的高资质业务表述。

## 本地联调

1. 启动 Web + API：

```bash
npm run dev
```

如果默认端口被占用，可以使用当前开发环境约定：

```bash
PORT=4200 CLIENT_URL=http://localhost:5174 VITE_API_URL=http://localhost:4200 npm run dev
```

2. 用微信开发者工具打开 `apps/miniprogram`。

3. 当前 `app.js` 默认 API 地址是：

```text
http://localhost:4200
ws://localhost:4200/miniprogram-ws
```

如需改端口，修改 `app.js` 里的 `globalData.apiBaseUrl` 和 `globalData.wsUrl`。

4. 开发者工具里需要开启“不校验合法域名、web-view、TLS 版本以及 HTTPS 证书”。

## 当前能力

- `pages/index`：好物专场列表。
- `pages/live/index`：专场详情、商品画面、实时快照、参与金额、确认后模拟支付。
- `pages/orders/index`：我的订单。
- 登录使用 `/api/auth/miniprogram/login` 的 `mockCode` 演示模式。
- 实时同步优先使用小程序原生 `wx.connectSocket`，消息格式为 JSON `type + payload`。
- WebSocket 断开时详情页会临时降级为 REST 轮询。

## 生产边界

真实上线需要替换：

- 正式微信 `appId`。
- `wx.login` + 后端 `code2Session`。
- HTTPS request 合法域名和 WSS socket 合法域名。
- 真实音视频组件权限和内容服务。
- 微信支付沙箱或正式支付。
