export interface AiResult {
  ok: true;
  title: string;
  content: string;
  generatedAt: number;
  source: "model" | "fallback";
  fallback: boolean;
  message: string;
}

export async function completeWithModel(input: {
  title: string;
  systemPrompt: string;
  userPrompt: string;
  fallbackContent: string;
}): Promise<AiResult> {
  const apiUrl = process.env.AI_API_URL;
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;

  if (!apiUrl || !apiKey || !model) {
    return createFallback(input.title, input.fallbackContent, "未配置模型 API，已使用本地兜底策略");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt }
        ],
        temperature: 0.4,
        max_tokens: 300
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return createFallback(input.title, input.fallbackContent, "模型接口返回异常，已使用本地兜底策略");
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      output_text?: string;
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? data.output_text?.trim();

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
      message: "模型生成成功"
    };
  } catch {
    return createFallback(input.title, input.fallbackContent, "模型调用失败，已使用本地兜底策略");
  } finally {
    clearTimeout(timeout);
  }
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
