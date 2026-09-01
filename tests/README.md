# 测试开发入口

安装测试依赖：

```bash
pip install -r services/agent/requirements.txt
pip install -r tests/requirements.txt
npm install -D @playwright/test
```

启动 `npm run demo` 后，可以分别运行：

```bash
# FastAPI Agent 和业务编排（含覆盖率门禁）
npm run test:agent

# Agent 离线回归评测（无需模型 API Key）
npm run eval:agent

# Node -> FastAPI 请求/响应契约
npm run test:agent-contract

# 小程序原生 WebSocket 协议
pytest -q tests/websocket

# 浏览器端登录、控制台和 Agent 对话 UI
npx playwright install chromium
npx playwright test -c tests/e2e/playwright.config.ts

# 只读接口压测
locust -f tests/load/locustfile.py --headless -u 20 -r 5 -t 30s
```

默认压测只读取公开接口，不会修改竞拍价格或订单。

CI 工作流位于 `.github/workflows/ci.yml`，分开执行 Node、Python Agent、WebSocket、Playwright 和 Compose 配置校验。Playwright 失败时会保留 trace 和截图供定位。
