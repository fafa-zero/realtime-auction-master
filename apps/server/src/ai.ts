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

export interface AgentChatResult extends AiResult {
  sessionId: string;
  intent: "product-script" | "auction-summary" | "host-cue" | "bid-risk" | "chat";
  citations: Array<{ id: string; title: string; content: string; score: number }>;
  historySize: number;
}

const DEFAULT_DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_USTC_LLM_API_URL = "https://api.llm.ustc.edu.cn/v1/chat/completions";
const DEFAULT_USTC_LLM_MODEL = "deepseek-v4-flash-ascend";

export async function completeWithModel(input: {
  task?: "product-script" | "auction-summary" | "host-cue" | "bid-risk" | "chat";
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
  const fallbackContent = "已读取当前竞拍状态，请继续描述你想了解的内容。";

  if (!baseUrl) {
    const result = await completeWithModel({
      task: "chat",
      title: "AI 竞拍助手",
      systemPrompt: "你是直播电商竞拍助手，回答要客观、简洁、合规，不要替用户出价或修改订单。",
      userPrompt: input.message,
      fallbackContent,
      context: input.context
    });
    return {
      ...result,
      sessionId: input.sessionId,
      intent: "chat",
      citations: [],
      historySize: 0
    };
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
      title: data.title?.trim() || "AI 竞拍助手",
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

function toChatFallback(input: { sessionId: string }, message: string): AgentChatResult {
  return {
    ok: true,
    title: "AI 竞拍助手",
    content: "已读取当前竞拍状态，请继续描述你想了解的内容。",
    generatedAt: Date.now(),
    source: "fallback",
    fallback: true,
    message,
    sessionId: input.sessionId,
    intent: "chat",
    citations: [],
    historySize: 0,
    toolsUsed: [],
    toolResults: {}
  };
}

function isAgentIntent(value: unknown): value is AgentChatResult["intent"] {
  return value === "product-script" || value === "auction-summary" || value === "host-cue" || value === "bid-risk" || value === "chat";
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
    task?: "product-script" | "auction-summary" | "host-cue" | "bid-risk" | "chat";
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
