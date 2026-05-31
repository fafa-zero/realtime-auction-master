# 好物助手小程序原型

这是买家侧微信小程序原型，用于演示“用户登录小程序查看好物专场并参与互动购买”的最终形态。

## 名称建议

- 小程序名称：好物助手
- 小程序简称：好物助手

“好物助手”共 4 个中文字，按微信规则计 8 个字符，满足名称 4-30 个字符限制，也满足简称 4-10 个字符限制。名称避开个人主体不适合备案的高资质业务表述。

## 本地联调

1. 启动稳定单端口服务：

```bash
npm --workspace apps/web run build
env PORT=4300 CLIENT_URL=http://localhost:4300 npm --workspace apps/server run dev
```

2. 用微信开发者工具打开 `apps/miniprogram`。

3. 当前小程序会按顺序尝试多个本地 API 地址，避免微信开发者工具访问某一个地址时被 Windows 代理或 WSL 转发拦截：

```text
http://localhost:4300
http://127.0.0.1:4300
```

Web 页面和小程序必须连到同一个 `4300` 后端实例，才能共享同一套拍卖状态。Web 页面可以继续打开 `http://localhost:4300/host?liveRoomId=live-1`，小程序会自动使用能访问到该服务的本地地址。

不能一边连 `4200`，另一边连 `4300`。

4. 开发者工具里需要开启“不校验合法域名、web-view、TLS 版本以及 HTTPS 证书”。

## 当前能力

- `pages/index`：好物专场列表。
- `pages/live/index`：专场详情、商品画面、实时快照、参与金额、确认后模拟支付。
- `pages/orders/index`：我的订单。
- 小程序买家登录和注册复用 Web 账号体系，统一调用 `/api/auth/web/register` 和 `/api/auth/web/login`。
- 首页区分买家注册和买家登录；注册需要账号、密码和买家昵称，登录需要账号和密码。
- 详情页使用 REST 轮询同步，出价也走 HTTP 接口，避免微信开发者工具 WebSocket timeout 阻断演示。

## 生产边界

真实上线需要替换：

- 正式微信 `appId` 和 `secret` 环境变量。
- HTTPS request 合法域名和 WSS socket 合法域名。
- 真实音视频组件权限和内容服务。
- 微信支付沙箱或正式支付。
