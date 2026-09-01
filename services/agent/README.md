# Realtime Auction Agent

这是竞拍项目的 Python Agent 服务。它负责模型调用和 Agent 编排，竞拍状态、鉴权、订单和实时广播仍由 `apps/server` 负责。

## Agent 工作方式

Node 只传递当前请求所需的结构化竞拍上下文；Python 不读写 `data/auction-state.json`，也不直接创建订单或修改价格。每种任务会运行一条固定、可测试的工具计划，再将工具结果交给模型：

| 任务 | 工具计划 |
| --- | --- |
| 商品讲解 | `get_product_info` -> `get_live_room_snapshot` |
| 竞拍复盘 | `get_live_room_snapshot` -> `get_product_info` -> `get_auction_history` |
| 主播话术 | `get_live_room_snapshot` -> `get_product_info` -> `get_recent_danmaku` -> `generate_host_script` |
| 出价风险 | `get_live_room_snapshot` -> `analyze_bid_risk` |

出价风险工具使用可解释规则，返回 `ALLOW` 或 `REVIEW` 建议；最终出价校验始终由 Node 竞拍状态机执行。

## 启动

```bash
cd /home/zyy/realtime-auction-master/services/agent
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload
```

在仓库根目录运行测试：

```bash
npm run test:agent
```

不配置模型 Key 也可以启动，接口会返回确定性的本地兜底内容。

## 接口

- `GET /health`
- `GET /v1/tools`
- `GET /v1/metrics`（内部鉴权；延迟、来源、兜底率和最近调用）
- `GET /v1/evaluation`（内部鉴权；离线路由、RAG 和工具回归评测）
- `POST /v1/agent/run`
- `POST /v1/agent/chat`
- `POST /api/agent/product-script`
- `POST /api/agent/auction-summary`
- `POST /api/agent/host-cue`
- `POST /api/agent/bid-risk`
- `POST /api/agent/chat`

`/v1/agent/chat` 和 `/api/agent/chat` 接受 `message`、`session_id`、`user_id`、`user_role`、`live_room_id` 和结构化 `context`，返回意图、工具调用、知识引用和短期记忆长度。

Node 服务设置 `AGENT_BASE_URL=http://127.0.0.1:8100` 后，已有 `/api/ai/*` 接口会转发到 `/v1/agent/run`，前端无需改动。

Agent 响应会额外包含 `toolsUsed` 和 `toolResults`，用于调试、自动化测试和后续前端可解释性展示。

## 观测与评测

指标是进程内的有界聚合数据，不保存提示词、用户 ID 或 API Key。生产环境可由监控系统定时抓取 `/v1/metrics`，再替换为 Prometheus/OpenTelemetry exporter。指标包括总请求数、错误数、模型/兜底来源、平均与 P95 延迟、按任务统计和最近调用的工具列表。

模型访问对超时、HTTP 408/425/429 和 5xx 临时错误执行有限次指数退避重试；连续失败达到阈值后进入熔断，短暂等待后允许一次恢复探测。鉴权错误和其他 4xx 不重试，避免放大配置问题。

离线评测不依赖远程模型，覆盖规则问答、风险分析、主播话术和竞拍复盘四条路径：

```bash
npm run eval:agent
```

评测会校验意图路由、固定工具计划和知识库引用，适合在 CI 中作为 Agent 回归门禁。
