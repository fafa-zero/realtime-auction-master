import { randomUUID } from "node:crypto";

export interface AiResult {
  ok: true;
  title: string;
  content: string;
  generatedAt: number;
  source: "agent" | "model" | "fallback";
  fallback: boolean;
  message: string;
  toolsUsed?: string[];
  toolResults?: Record<string, unknown>;
}

export type AgentIntent =
  | "product-script"
  | "auction-summary"
  | "host-cue"
  | "bid-risk"
  | "inventory-alert"
  | "order-query"
  | "after-sales"
  | "live-review"
  | "chat";

export interface AgentChatResult extends AiResult {
  sessionId: string;
  intent: AgentIntent;
  citations: Array<{ id: string; title: string; content: string; score: number }>;
  historySize: number;
}

const DEFAULT_DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_USTC_LLM_API_URL = "https://api.llm.ustc.edu.cn/v1/chat/completions";
const DEFAULT_USTC_LLM_MODEL = "deepseek-v4-flash-ascend";

export async function completeWithModel(input: {
  task?: AgentIntent;
  title: string;
  systemPrompt: string;
  userPrompt: string;
  fallbackContent: string;
  context?: Record<string, unknown>;
  requestId?: string;
}): Promise<AiResult> {
  const agentBaseUrl = process.env.AGENT_BASE_URL?.trim();

  if (agentBaseUrl) {
    return completeWithAgent(agentBaseUrl, input);
  }

  const config = getModelConfig();

  if (!config.apiKey) {
    return createFallback(input.title, input.fallbackContent, "未配置模型 API Key，已使用本地兜底策略");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(getRequestBody(config, input)),
      signal: controller.signal
    });

    if (!response.ok) {
      const reason = await getModelErrorMessage(response);
      return createFallback(input.title, input.fallbackContent, `${reason}，已使用本地兜底策略`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      output_text?: string;
    };
    const message = data.choices?.[0]?.message;
    const content = message?.content?.trim() ?? message?.reasoning_content?.trim() ?? data.output_text?.trim();

    if (!content) {
      return createFallback(input.title, input.fallbackContent, "模型返回内容为空，已使用本地兜底策略");
    }

    return {
      ok: true,
      title: input.title,
      content,
      generatedAt: Date.now(),
      source: "model",
      fallback: false,
      message: `${config.providerName} 生成成功`
    };
  } catch {
    return createFallback(input.title, input.fallbackContent, "模型调用失败，已使用本地兜底策略");
  } finally {
    clearTimeout(timeout);
  }
}

export async function completeWithAgentChat(input: {
  message: string;
  sessionId: string;
  userId: string;
  userRole: string;
  liveRoomId: string;
  context: Record<string, unknown>;
  requestId?: string;
}): Promise<AgentChatResult> {
  const baseUrl = process.env.AGENT_BASE_URL?.trim();

  if (!baseUrl) {
    return toChatFallback(input, "未配置 AGENT_BASE_URL，已使用 Node 只读运营兜底");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getAgentTimeoutMs());
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const serviceToken = process.env.AGENT_SERVICE_TOKEN?.trim();

  if (serviceToken) {
    headers["X-Agent-Service-Token"] = serviceToken;
  }
  headers["X-Request-Id"] = input.requestId?.trim() || randomUUID();

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/agent/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: input.message,
        session_id: input.sessionId,
        user_id: input.userId,
        user_role: input.userRole,
        live_room_id: input.liveRoomId,
        context: input.context
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const reason = await getResponseErrorMessage(response, "Agent 服务返回异常");
      return toChatFallback(input, `${reason}，已使用本地兜底策略`);
    }

    const data = (await response.json()) as {
      title?: string;
      content?: string;
      generatedAt?: number;
      source?: "model" | "fallback";
      fallback?: boolean;
      message?: string;
      sessionId?: string;
      intent?: AgentChatResult["intent"];
      citations?: unknown;
      historySize?: number;
      toolsUsed?: unknown;
      toolResults?: unknown;
    };
    const content = data.content?.trim();

    if (!content) {
      return toChatFallback(input, "Agent 返回内容为空，已使用本地兜底策略");
    }

    const isFallback = data.fallback === true || data.source === "fallback";
    return {
      ok: true,
      title: data.title?.trim() || "Agent 运营工作台",
      content,
      generatedAt: typeof data.generatedAt === "number" ? data.generatedAt : Date.now(),
      source: isFallback ? "fallback" : "agent",
      fallback: isFallback,
      message: data.message?.trim() || (isFallback ? "Agent 已使用本地兜底策略" : "FastAPI Agent 生成成功"),
      sessionId: data.sessionId?.trim() || input.sessionId,
      intent: isAgentIntent(data.intent) ? data.intent : "chat",
      citations: parseCitations(data.citations),
      historySize: typeof data.historySize === "number" ? data.historySize : 0,
      toolsUsed: parseStringList(data.toolsUsed),
      toolResults: isRecord(data.toolResults) ? data.toolResults : {}
    };
  } catch {
    return toChatFallback(input, "Agent 调用失败，已使用本地兜底策略");
  } finally {
    clearTimeout(timeout);
  }
}

function toChatFallback(
  input: { sessionId: string; message: string; context: Record<string, unknown> },
  message: string
): AgentChatResult {
  const intent = detectLocalAgentIntent(input.message);
  return {
    ok: true,
    title: "Agent 运营工作台",
    content: createLocalChatContent(intent, input.context),
    generatedAt: Date.now(),
    source: "fallback",
    fallback: true,
    message,
    sessionId: input.sessionId,
    intent,
    citations: [],
    historySize: 0,
    toolsUsed: getLocalToolPlan(intent),
    toolResults: { localFallback: { intent, readOnly: true } }
  };
}

function detectLocalAgentIntent(message: string): AgentIntent {
  const text = message.toLowerCase();

  if (["售后", "退款", "退货", "换货", "物流", "投诉"].some((word) => text.includes(word))) {
    return "after-sales";
  }
  if (["库存", "补货", "缺货", "低库存"].some((word) => text.includes(word))) {
    return "inventory-alert";
  }
  if (["订单", "待支付", "已支付", "gmv", "成交额"].some((word) => text.includes(word))) {
    return "order-query";
  }
  if (["直播复盘", "整场复盘", "全场复盘", "运营复盘", "直播表现"].some((word) => text.includes(word))) {
    return "live-review";
  }
  if (["风险", "异常", "可疑", "风控"].some((word) => text.includes(word))) {
    return "bid-risk";
  }
  if (["话术", "怎么说", "主播", "促成交"].some((word) => text.includes(word))) {
    return "host-cue";
  }
  if (["复盘", "总结", "数据", "表现", "成交"].some((word) => text.includes(word))) {
    return "auction-summary";
  }
  if (["商品", "卖点", "介绍", "讲解"].some((word) => text.includes(word))) {
    return "product-script";
  }
  return "chat";
}

function createLocalChatContent(intent: AgentIntent, context: Record<string, unknown>) {
  const product = asRecord(context.product);
  const auction = asRecord(context.auction);
  const inventory = asRecordList(context.inventory);
  const orders = asRecordList(context.orders);
  const history = asRecordList(context.history);
  const bids = asRecordList(context.bids);
  const paidOrders = orders.filter((item) => item.status === "PAID");
  const pendingOrders = orders.filter((item) => item.status === "PENDING_PAYMENT");
  const paidRevenue = paidOrders.reduce((sum, item) => sum + asNumber(item.finalPrice), 0);

  if (intent === "inventory-alert") {
    const attention = inventory
      .filter((item) => asNumber(item.stock) <= 3)
      .sort((left, right) => asNumber(left.stock) - asNumber(right.stock));
    const outOfStock = attention.filter((item) => asNumber(item.stock) <= 0);
    const names = attention.slice(0, 5).map((item) => String(item.name ?? "未命名商品")).join("、");
    return `库存巡检：共 ${inventory.length} 件商品，缺货 ${outOfStock.length} 件，低库存 ${attention.length - outOfStock.length} 件。${names ? `建议优先核对：${names}。` : "当前无低库存商品。"}`;
  }
  if (intent === "order-query") {
    return `订单概况：共 ${orders.length} 笔，已支付 ${paidOrders.length} 笔，待支付 ${pendingOrders.length} 笔，已支付成交额 ${paidRevenue} 元。`;
  }
  if (intent === "after-sales") {
    return `当前未接入退款、退货或物流工单，Agent 只提供处理建议。可核对 ${paidOrders.length} 笔已支付订单和 ${pendingOrders.length} 笔待支付订单，再转人工处理。`;
  }
  if (intent === "live-review") {
    const completed = history.filter((item) => ["SOLD", "UNSOLD", "CANCELLED"].includes(String(item.status)));
    const sold = completed.filter((item) => item.status === "SOLD");
    const bidCount = history.reduce((sum, item) => sum + asNumber(item.bidCount), 0);
    const rate = completed.length ? Math.round((sold.length / completed.length) * 100) : 0;
    return `直播复盘：已完成 ${completed.length} 轮，成交 ${sold.length} 轮，成交率 ${rate}%，累计出价 ${bidCount} 次，已支付成交额 ${paidRevenue} 元。`;
  }
  if (intent === "bid-risk") {
    const bidRisk = asRecord(context.bidRisk);
    if (!Object.keys(bidRisk).length) {
      return "当前没有可供分析的最近出价，无法生成风险结论。";
    }
    const reasons = [
      bidRisk.reachesCeiling ? "最近出价达到封顶价" : "",
      asNumber(bidRisk.recentBidCount) >= 3 ? "30 秒内出价频率较高" : "",
      asNumber(bidRisk.price) - asNumber(bidRisk.currentPrice) >= asNumber(bidRisk.incrementStep) * 5
        ? "加价幅度明显高于最低加价"
        : ""
    ].filter(Boolean);
    return reasons.length ? `风险等级：中。${reasons.join("；")}。建议人工复核。` : "风险等级：低。当前未发现明显异常。";
  }
  if (intent === "host-cue") {
    const currentPrice = asNumber(auction.currentPrice);
    const nextBid = currentPrice + asNumber(auction.incrementStep);
    return `主播可以这样说：${String(product.name ?? "当前商品")}目前最高价 ${currentPrice} 元，下一口 ${nextBid} 元起，请结合商品详情理性参与。`;
  }
  if (intent === "auction-summary") {
    return `当前竞拍状态为 ${String(auction.status ?? "PENDING")}，共 ${asNumber(context.participantCount)} 位参与者，累计 ${bids.length} 次出价，当前价 ${asNumber(auction.currentPrice)} 元。`;
  }
  if (intent === "product-script") {
    return `${String(product.name ?? "当前商品")}：${String(product.description ?? "请先查看商品详情")}。当前库存 ${asNumber(product.stock)} 件，起拍价 ${asNumber(auction.startPrice)} 元，请理性参与竞拍。`;
  }
  return `已读取 ${String(product.name ?? "当前商品")} 的竞拍状态。你可以继续询问库存、订单、售后或直播复盘。`;
}

function getLocalToolPlan(intent: AgentIntent) {
  const plans: Record<AgentIntent, string[]> = {
    "product-script": ["get_product_info", "get_live_room_snapshot"],
    "auction-summary": ["get_live_room_snapshot", "get_product_info", "get_auction_history"],
    "host-cue": ["get_live_room_snapshot", "get_product_info", "generate_host_script"],
    "bid-risk": ["get_live_room_snapshot", "analyze_bid_risk"],
    "inventory-alert": ["get_live_room_snapshot", "get_inventory_status"],
    "order-query": ["get_order_overview"],
    "after-sales": ["get_order_overview", "get_after_sales_context"],
    "live-review": ["get_live_room_snapshot", "get_auction_history", "get_order_overview", "analyze_live_performance"],
    chat: ["get_live_room_snapshot", "get_product_info"]
  };
  return plans[intent];
}

function asRecordList(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isAgentIntent(value: unknown): value is AgentChatResult["intent"] {
  return (
    value === "product-script" ||
    value === "auction-summary" ||
    value === "host-cue" ||
    value === "bid-risk" ||
    value === "inventory-alert" ||
    value === "order-query" ||
    value === "after-sales" ||
    value === "live-review" ||
    value === "chat"
  );
}

function parseStringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseCitations(value: unknown): AgentChatResult["citations"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.content !== "string") {
      return [];
    }
    return [{
      id: item.id,
      title: item.title,
      content: item.content,
      score: typeof item.score === "number" ? item.score : 0
    }];
  });
}

async function completeWithAgent(
  baseUrl: string,
  input: {
    task?: AgentIntent;
    title: string;
    systemPrompt: string;
    userPrompt: string;
    fallbackContent: string;
    context?: Record<string, unknown>;
    requestId?: string;
  }
): Promise<AiResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getAgentTimeoutMs());
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const serviceToken = process.env.AGENT_SERVICE_TOKEN?.trim();

  if (serviceToken) {
    headers["X-Agent-Service-Token"] = serviceToken;
  }
  headers["X-Request-Id"] = input.requestId?.trim() || randomUUID();

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/agent/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        task: input.task ?? "chat",
        title: input.title,
        system_prompt: input.systemPrompt,
        user_prompt: input.userPrompt,
        fallback_content: input.fallbackContent,
        context: input.context ?? {}
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const reason = await getResponseErrorMessage(response, "Agent 服务返回异常");
      return createFallback(input.title, input.fallbackContent, `${reason}，已使用本地兜底策略`);
    }

    const data = (await response.json()) as {
      title?: string;
      content?: string;
      generatedAt?: number;
      source?: "model" | "fallback";
      fallback?: boolean;
      message?: string;
      toolsUsed?: unknown;
      toolResults?: unknown;
    };
    const content = data.content?.trim();

    if (!content) {
      return createFallback(input.title, input.fallbackContent, "Agent 返回内容为空，已使用本地兜底策略");
    }

    const isFallback = data.fallback === true || data.source === "fallback";

    return {
      ok: true,
      title: data.title?.trim() || input.title,
      content,
      generatedAt: typeof data.generatedAt === "number" ? data.generatedAt : Date.now(),
      source: isFallback ? "fallback" : "agent",
      fallback: isFallback,
      message: data.message?.trim() || (isFallback ? "Agent 已使用本地兜底策略" : "FastAPI Agent 生成成功"),
      toolsUsed: Array.isArray(data.toolsUsed) ? data.toolsUsed.filter((item): item is string => typeof item === "string") : [],
      toolResults: isRecord(data.toolResults) ? data.toolResults : {}
    };
  } catch {
    return createFallback(input.title, input.fallbackContent, "Agent 调用失败，已使用本地兜底策略");
  } finally {
    clearTimeout(timeout);
  }
}

function getAgentTimeoutMs() {
  const configured = Number(process.env.AGENT_TIMEOUT_MS ?? 8000);

  return Number.isFinite(configured) && configured > 0 ? configured : 8000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getModelConfig() {
  const provider = getConfiguredProvider();
  const apiKey = provider.apiKey;
  const apiUrl = provider.apiUrl;
  const model = provider.model;
  const isDeepSeek = apiUrl.includes("api.deepseek.com") || model.startsWith("deepseek-");
  const isUstcLlm = apiUrl.includes("api.llm.ustc.edu.cn");

  return {
    apiKey,
    apiUrl,
    model,
    isDeepSeek,
    isUstcLlm,
    providerName: isUstcLlm ? "USTC LLM" : isDeepSeek ? "DeepSeek" : "模型"
  };
}

function getConfiguredProvider() {
  if (process.env.AI_API_KEY) {
    return {
      apiKey: process.env.AI_API_KEY,
      apiUrl: process.env.AI_API_URL || DEFAULT_DEEPSEEK_API_URL,
      model: process.env.AI_MODEL || DEFAULT_DEEPSEEK_MODEL
    };
  }

  if (process.env.USTC_LLM_API_KEY) {
    return {
      apiKey: process.env.USTC_LLM_API_KEY,
      apiUrl: process.env.USTC_LLM_API_URL || DEFAULT_USTC_LLM_API_URL,
      model: process.env.USTC_LLM_MODEL || DEFAULT_USTC_LLM_MODEL
    };
  }

  if (process.env.DEEPSEEK_API_KEY) {
    return {
      apiKey: process.env.DEEPSEEK_API_KEY,
      apiUrl: process.env.DEEPSEEK_API_URL || DEFAULT_DEEPSEEK_API_URL,
      model: process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL
    };
  }

  return {
    apiKey: "",
    apiUrl: process.env.AI_API_URL || process.env.USTC_LLM_API_URL || process.env.DEEPSEEK_API_URL || DEFAULT_DEEPSEEK_API_URL,
    model: process.env.AI_MODEL || process.env.USTC_LLM_MODEL || process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL
  };
}

function getRequestBody(
  config: ReturnType<typeof getModelConfig>,
  input: {
    systemPrompt: string;
    userPrompt: string;
  }
) {
  return {
    model: config.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt }
    ],
    temperature: 0.4,
    max_tokens: 300,
    ...(config.isDeepSeek || config.isUstcLlm ? { thinking: { type: "disabled" } } : {})
  };
}

async function getModelErrorMessage(response: Response) {
  return getResponseErrorMessage(response, "模型接口返回异常");
}

async function getResponseErrorMessage(response: Response, fallback: string) {
  try {
    const data = (await response.json()) as {
      error?: {
        message?: string;
        type?: string;
        code?: string;
      };
      message?: string;
    };
    const message = data.error?.message || data.message || `${fallback}（HTTP ${response.status}）`;
    return sanitizeModelError(message);
  } catch {
    return `${fallback}（HTTP ${response.status}）`;
  }
}

function sanitizeModelError(message: string) {
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
}

function createFallback(title: string, content: string, message = "已使用本地兜底策略生成结果"): AiResult {
  return {
    ok: true,
    title,
    content,
    generatedAt: Date.now(),
    source: "fallback",
    fallback: true,
    message
  };
}
