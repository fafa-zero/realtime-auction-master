# 明日任务计划

日期：2026-05-27

## 当前进度

今天已经完成 Web 主播端、Web 观众预览、小程序买家端的基础联调方向：

- Web 主播端可以选择直播间、开始拍卖、设置封顶价和加价幅度。
- 小程序已经可以在微信开发者工具中打开页面。
- 小程序已接入演示登录、本地接口、WebSocket 实时同步和出价流程。
- 后端已经支持多直播间隔离、订单、支付权限校验和本地数据持久化。
- 测试文档已经补充多直播间、小程序登录、小程序 WebSocket 出价、我的订单和支付权限校验用例。

## 明天核心目标

1. 用微信开发者工具跑完整的小程序端到端流程。
2. 把 `docs/test-cases.md` 里的关键用例逐条执行并记录结果。
3. 修复小程序实际运行时发现的问题。
4. 更新最终演示文档，让项目可以按固定脚本展示。

## 启动方式

在 WSL 终端进入项目目录：

```bash
cd /home/zyy/realtime-auction-master
```

启动后端和 Web：

```bash
PORT=4200 CLIENT_URL=http://localhost:5174 VITE_API_URL=http://localhost:4200 npm run dev
```

检查地址：

- 后端健康检查：http://localhost:4200/api/health
- Web 主播端：http://localhost:5174/host
- Web 观众预览：http://localhost:5174/live/live-1

微信开发者工具打开小程序目录：

```text
\\wsl$\Ubuntu\home\zyy\realtime-auction-master\apps\miniprogram
```

如果 Windows 里 Ubuntu 名称不一样，先在 PowerShell 查看：

```powershell
wsl -l -v
```

本地联调时，微信开发者工具需要开启：

```text
不校验合法域名、web-view、TLS 版本以及 HTTPS 证书
```

## 明天测试清单

- [ ] 打开 Web 主播端 `/host`，确认默认直播间 `live-1` 数据正常。
- [ ] 在主播端开始 `live-1` 拍卖，设置合适的封顶价和加价幅度。
- [ ] 打开小程序，完成演示登录，进入直播间页面。
- [ ] 用小程序对 `live-1` 出价，确认页面能收到 WebSocket 实时反馈。
- [ ] 出价达到封顶价后，确认拍卖变成已成交，并生成订单。
- [ ] 在小程序“我的订单”页面查看订单。
- [ ] 在小程序订单页面执行支付，确认支付后状态变成已支付。
- [ ] 切换到 `live-2`，重复开始拍卖和出价，确认 `live-1` 与 `live-2` 数据互不影响。
- [ ] 在 Web 观众预览页打开 `/live/live-1`，确认 Web 和小程序数据同步。
- [ ] 尝试用非订单所属用户支付订单，确认后端拒绝。

## 文档要更新

- [ ] 在 `docs/test-cases.md` 记录明天实际执行结果。
- [ ] 更新 `docs/final-demo-submission.md`：
  - 当前架构：Web 主播端 + 小程序买家端 + 后端实时服务。
  - 演示入口：主播端、小程序目录、后端地址。
  - 演示步骤：登录、进入直播间、出价、成交、查看订单、支付。
  - 当前限制：演示登录、本地支付、本地直播预览。

## 明天先不要做的事

除非上面的流程全部跑通，否则先不要投入这些内容：

- 真实微信 `wx.login` 换取 `openid`。
- 真实微信支付。
- 真正的视频推流和 CDN。
- 数据库、Redis、部署服务器。
- 后台管理系统的大规模扩展。

这些都属于下一阶段，当前最重要的是把本地演示流程跑稳。

## Git 提交流程

每完成一个小功能或一组文档更新后再提交：

1. 只 `git add` 本次相关文件。
2. 提交前运行：

```bash
npm --workspaces run typecheck
```

3. 涉及构建或前端页面时再运行：

```bash
npm run build
```

4. commit message 使用已有前缀：

```text
frontend:
server:
miniprogram:
docs:
test:
chore:
```

明天第一条建议 commit：

```text
test: record miniprogram manual test results
```
