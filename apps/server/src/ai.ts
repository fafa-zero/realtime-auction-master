export interface AiResult {
  ok: true;
  title: string;
  content: string;
  generatedAt: number;
  source: "model" | "fallback";
  fallback: boolean;
  message: string;
}

const DEFAULT_DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_USTC_LLM_API_URL = "https://api.llm.ustc.edu.cn/v1/chat/completions";
const DEFAULT_USTC_LLM_MODEL = "deepseek-v4-flash-ascend";

export async function completeWithModel(input: {
  title: string;
  systemPrompt: string;
  userPrompt: string;
  fallbackContent: string;
}): Promise<AiResult> {
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
  try {
    const data = (await response.json()) as {
      error?: {
        message?: string;
        type?: string;
        code?: string;
      };
      message?: string;
    };
    const message = data.error?.message || data.message || "模型接口返回异常";
    return sanitizeModelError(message);
  } catch {
    return `模型接口返回异常（HTTP ${response.status}）`;
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
