import { callGemini } from "./gemini.js";

/**
 * Direct OpenAI call for single-agent tasks.
 * Skips Swarms API overhead — uses our own OPENAI_API_KEY.
 *
 * Rule: One agent, one prompt → Direct OpenAI.
 *       Multiple agents coordinating → Swarms.
 */
export async function callOpenAI(options: {
  apiKey: string;
  model?: string;       // default "gpt-4o-mini"
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;   // default 4096
  temperature?: number; // default 0.3
}): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model ?? "gpt-4o-mini",
      messages: [
        { role: "system", content: options.systemPrompt },
        { role: "user", content: options.userPrompt },
      ],
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.3,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${error}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

/* ------------------------------------------------------------------ */
/*  Smart LLM Router                                                   */
/* ------------------------------------------------------------------ */

export type LLMProvider = "openai" | "gemini" | "auto";

export interface SmartLLMOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  provider?: LLMProvider;       // default "auto"
  taskType?: "research" | "analysis" | "creative" | "extraction" | "code" | "general";
  groundingEnabled?: boolean;   // only for Gemini
}

/**
 * Smart LLM router — picks the best provider based on task type and available keys.
 *
 * Auto-routing logic:
 *  1. Explicit provider override -> use that provider.
 *  2. Gemini key available AND taskType is "research" -> Gemini (better grounding).
 *  3. OpenAI key available -> OpenAI (fast, cheap default).
 *  4. Gemini key available -> Gemini (fallback).
 *  5. Neither key -> throw.
 *
 * @param runtime - ElizaOS runtime (or any object with getSetting(key))
 */
export async function callLLM(
  runtime: { getSetting: (key: string) => string | boolean | number | null },
  options: SmartLLMOptions,
): Promise<string> {
  const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "").trim() || undefined;
  const geminiKey = String(runtime.getSetting("GEMINI_API_KEY") ?? "").trim() || undefined;
  const provider = options.provider ?? "auto";
  const taskType = options.taskType ?? "general";

  // Resolve which provider to actually call
  let resolved: "openai" | "gemini";

  if (provider === "openai") {
    if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");
    resolved = "openai";
  } else if (provider === "gemini") {
    if (!geminiKey) throw new Error("GEMINI_API_KEY not configured");
    resolved = "gemini";
  } else {
    // Auto-routing
    if (geminiKey && taskType === "research") {
      resolved = "gemini";
    } else if (openaiKey) {
      resolved = "openai";
    } else if (geminiKey) {
      resolved = "gemini";
    } else {
      throw new Error("No LLM API key configured (need OPENAI_API_KEY or GEMINI_API_KEY)");
    }
  }

  if (resolved === "gemini") {
    return callGemini({
      apiKey: geminiKey!,
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      groundingEnabled: options.groundingEnabled,
    });
  }

  return callOpenAI({
    apiKey: openaiKey!,
    systemPrompt: options.systemPrompt,
    userPrompt: options.userPrompt,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  });
}
