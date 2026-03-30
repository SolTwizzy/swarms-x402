/**
 * Direct Gemini API call for research-heavy and grounding tasks.
 * Complements callOpenAI — preferred when Google Search grounding is needed.
 *
 * Rule: Research / fact-check tasks with grounding -> Gemini.
 *       Fast single-agent tasks -> OpenAI.
 *       Multiple agents coordinating -> Swarms.
 */

export interface GeminiOptions {
  apiKey: string;
  model?: string;            // default "gemini-2.5-flash"
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;        // default 8192
  temperature?: number;      // default 0.3
  groundingEnabled?: boolean; // default false — enable Google Search grounding
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export async function callGemini(options: GeminiOptions): Promise<string> {
  const model = options.model ?? "gemini-2.5-flash";
  const maxTokens = options.maxTokens ?? 8192;
  const temperature = options.temperature ?? 0.3;
  const groundingEnabled = options.groundingEnabled ?? false;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${options.apiKey}`;

  const body: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [{ text: options.userPrompt }],
      },
    ],
    systemInstruction: {
      parts: [{ text: options.systemPrompt }],
    },
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  };

  if (groundingEnabled) {
    body.tools = [{ googleSearch: {} }];
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 429) {
      throw new Error(`Gemini rate limit exceeded (429): ${errorText}`);
    }
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as GeminiResponse;

  if (data.error) {
    throw new Error(`Gemini API error (${data.error.code}): ${data.error.message}`);
  }

  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    return "";
  }

  return parts.map((p: { text?: string }) => p.text ?? "").join("");
}
