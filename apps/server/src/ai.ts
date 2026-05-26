export interface AiResult {
  title: string;
  content: string;
  generatedAt: number;
  source: "model" | "fallback";
}

export async function completeWithModel(input: {
  title: string;
  systemPrompt: string;
  userPrompt: string;
  fallbackContent: string;
}): Promise<AiResult> {
  const fallback = createFallback(input.title, input.fallbackContent);
  const apiUrl = process.env.AI_API_URL;
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;

  if (!apiUrl || !apiKey || !model) {
    return fallback;
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
      return fallback;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      output_text?: string;
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? data.output_text?.trim();

    if (!content) {
      return fallback;
    }

    return {
      title: input.title,
      content,
      generatedAt: Date.now(),
      source: "model"
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

function createFallback(title: string, content: string): AiResult {
  return {
    title,
    content,
    generatedAt: Date.now(),
    source: "fallback"
  };
}
