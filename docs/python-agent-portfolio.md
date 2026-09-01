# Python Agent 求职展示说明

这份项目可以作为 Python Agent、测试开发或质量工程岗位的完整案例。重点不是把原有实时竞拍全部改写成 Python，而是让 Python 负责最适合 Agent 的边界，同时保留 Node 对实时状态和交易一致性的控制。

## 一句话项目介绍

我在一个 React + Node.js 实时竞拍系统旁路部署了 FastAPI Agent 服务：通过结构化上下文、固定工具计划、轻量 RAG 和短期会话记忆，构建面向主播运营的 Agent 工作台，覆盖商品讲解、竞拍复盘、实时话术、异常出价、库存预警、订单查询和售后辅助；同时用离线评测、接口测试、WebSocket 契约测试和 CI 保证 Agent 不越权、不影响交易主流程。

## 技术亮点

| 能力 | 项目中的落点 |
| --- | --- |
| Python Web | FastAPI、Pydantic 请求模型、异步 `httpx` 模型适配 |
| Agent 编排 | 9 类意图路由、固定工具计划、结构化 tool results、模型失败兜底 |
| RAG | 基于竞拍规则和 AI 合规规范的轻量词法检索，并返回 citations |
| 记忆 | 按用户、直播间和 session 隔离的有界 TTL 会话记忆 |
| Agent 安全 | Agent 只读 Node 传入上下文，按主播/买家角色隔离订单，不能出价、支付或修改订单 |
| 测试开发 | pytest API/工具测试、离线评测集、WebSocket 契约、Playwright、Locust |
| 安全测试 | Prompt Injection、系统提示泄露、出价/支付越权请求均在模型调用前拦截 |
| 服务契约 | Node -> FastAPI snake_case 请求、鉴权头、响应字段和追踪 ID 有独立契约测试 |
| 工程交付 | Docker Compose、健康检查、GitHub Actions 多 Job CI |
| 可观测性 | `/v1/metrics` 提供 JSON 调试视图，`/metrics` 提供 Prometheus 累计指标和延迟 histogram |

## 面试演示路径

1. 启动 `npm run compose:up`，展示 Node 和 FastAPI 的独立健康检查。
2. 打开主播端，进入 Agent 运营工作台，先展示低库存、待支付、已支付和可复盘轮次四个运营指标。
3. 点击库存预警、订单查询或直播复盘，展示统一对话时间线中的意图、`toolsUsed` 和 `toolResults`。
4. 连续发送两条 `/api/agent/chat` 消息，展示意图变化、知识引用和 `historySize`。
4. 暂时不配置模型 Key，说明服务仍由确定性 fallback 保持可用；再配置兼容 OpenAI 的 Key，比较 `source: model` 与 `source: fallback`。
5. 运行 `npm run eval:agent`，展示无需网络的四条 Agent 回归用例。
6. 访问 `/v1/metrics` 观察 P95 延迟和兜底率，再抓取 `/metrics` 展示 Prometheus counter、histogram 和模型熔断状态。

## 可以写进简历的描述

- 使用 FastAPI 构建独立 Python Agent sidecar，设计 Node-to-Agent 结构化上下文协议，按角色提供库存、订单、历史和互动数据，避免 Agent 直接修改竞拍、订单和支付状态。
- 设计统一 Agent 运营工作台，将快捷任务转换为可追踪的自然语言指令，覆盖库存预警、订单查询、售后建议和直播复盘。
- 实现意图路由、可解释风险工具、固定工具计划、轻量 RAG 和用户级短期记忆；模型不可用时自动降级到确定性本地策略。
- 建立 pytest + WebSocket + Playwright + Locust 的分层测试体系，并加入无模型 Key 的离线评测门禁和 GitHub Actions CI。
- 增加 Agent 延迟 histogram、模型/兜底来源、失败数、P95 和工具调用指标，并提供 Prometheus 抓取端点定位模型超时与回退问题。
- 为模型临时故障加入有限重试、指数退避和熔断恢复；为 Node-FastAPI 协议加入独立契约测试。

## 诚实的工程边界

- 会话记忆优先写入 Redis；Redis 不可用时自动回退到有界进程内存，回退数据会随重启清空。
- RAG 是依赖轻量的词法检索，数据规模扩大后可替换为向量索引，但保留当前 citations 合同。
- Redis 已用于会话记忆、跨 Node 实例事件桥和短期快照缓存；Node 状态机及 MySQL/JSON 仍是竞拍交易事实来源，多写入实例尚需锁或单写入者设计。
