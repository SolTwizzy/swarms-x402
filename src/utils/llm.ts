/**
 * Single-agent LLM utilities.
 *
 * Provider priority (production): **Swarms → OpenAI.**
 *  - Swarms single-agent API (`/v1/agent/completions`) is the funded, working
 *    primary. Swarms runs the model server-side and bills it — this does NOT use
 *    our OpenAI key.
 *  - Direct OpenAI is the last-resort fallback (works only if the OpenAI quota is
 *    topped up).
 *
 * Historical note: single-agent tasks used to call OpenAI directly. The OpenAI
 * key went out of quota (HTTP 429 `insufficient_quota`), so `callOpenAI` was
 * reworked into a Swarms-first cascade. The name is kept for call-site
 * compatibility — it no longer calls OpenAI first. (Gemini was removed as a
 * provider — the platform runs on Swarms only.)
 */

const SWARMS_API_BASE = "https://api.swarms.world";

/* ------------------------------------------------------------------ */
/*  Raw provider calls                                                 */
/* ------------------------------------------------------------------ */

/**
 * Raw OpenAI chat completion. Private — the exported `callOpenAI` cascades
 * through Swarms before reaching this.
 */
async function callOpenAIRaw(options: {
  apiKey: string;
  model?: string; // default "gpt-4o-mini"
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number; // default 4096
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
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${error}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) {
    throw new Error("OpenAI API returned empty output");
  }
  return text;
}

/**
 * Extract the text output from a Swarms `/v1/agent/completions` response.
 * `output` may be a string, or `outputs` an array of `{ role, content }` turns
 * (return the LAST turn's content), or a nested object — handle all shapes.
 */
function extractSwarmsAgentText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;

  // `outputs`: array of conversation turns — the final assistant turn is the answer.
  const outputs = obj.outputs;
  if (Array.isArray(outputs) && outputs.length) {
    for (let i = outputs.length - 1; i >= 0; i--) {
      const turn = outputs[i];
      if (turn && typeof turn === "object") {
        const content = (turn as Record<string, unknown>).content;
        if (typeof content === "string" && content.trim()) return content;
      } else if (typeof turn === "string" && turn.trim()) {
        return turn;
      }
    }
  }

  // `output`: string, or nested { output|content }.
  const output = obj.output;
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const nested = output as Record<string, unknown>;
    if (typeof nested.content === "string") return nested.content;
    if (typeof nested.output === "string") return nested.output;
  }

  return "";
}

export interface SwarmsAgentOptions {
  swarmsApiKey: string;
  systemPrompt: string;
  userPrompt: string;
  model?: string; // model Swarms runs server-side (default "gpt-4o-mini") — Swarms bills it
  maxTokens?: number; // default 4096
  temperature?: number; // default 0.3
  agentName?: string;
  description?: string;
}

/**
 * Run a single agent through the Swarms API (`POST /v1/agent/completions`).
 * Auth via `x-api-key: <SWARMS_API_KEY>`. 120s timeout.
 *
 * Throws on non-2xx or empty output so callers can cascade to the next provider.
 */
export async function callSwarmsAgent(options: SwarmsAgentOptions): Promise<string> {
  const response = await fetch(`${SWARMS_API_BASE}/v1/agent/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": options.swarmsApiKey,
    },
    body: JSON.stringify({
      agent_config: {
        agent_name: options.agentName ?? "assistant",
        description: options.description ?? "Single-agent task executor",
        system_prompt: options.systemPrompt,
        model_name: options.model ?? "gpt-4o-mini",
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.3,
        max_loops: 1,
        role: "worker",
      },
      task: options.userPrompt,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => "");
    throw new Error(`Swarms agent API error (${response.status}): ${error.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = extractSwarmsAgentText(data);
  if (!text.trim()) {
    throw new Error("Swarms agent returned empty output");
  }
  return text;
}

/* ------------------------------------------------------------------ */
/*  callOpenAI — Swarms-first single-agent cascade                     */
/* ------------------------------------------------------------------ */

export interface CallOpenAIOptions {
  apiKey: string; // OpenAI key (last-resort provider; may be out of quota)
  model?: string; // OpenAI model / Swarms server-side model (default "gpt-4o-mini")
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number; // default 4096
  temperature?: number; // default 0.3
  /**
   * Optional provider-key override. Defaults to `process.env`. In the standalone
   * server every setting is resolved from env (`getSetting(k) === process.env[k]`),
   * so callers that pass only the OpenAI `apiKey` still get Swarms-first routing.
   */
  swarmsApiKey?: string;
}

/**
 * Single-agent LLM call. Routes **Swarms → OpenAI**, cascading to the next
 * provider on error or empty output. Named `callOpenAI` for historical call-site
 * compatibility; it no longer calls OpenAI first.
 *
 * Returns the completion text. Throws only if every configured provider fails.
 */
export async function callOpenAI(options: CallOpenAIOptions): Promise<string> {
  const swarmsKey = (options.swarmsApiKey ?? process.env.SWARMS_API_KEY ?? "").trim();
  const openaiKey = (options.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim();

  const attempts: Array<{ name: string; run: () => Promise<string> }> = [];

  if (swarmsKey) {
    attempts.push({
      name: "swarms",
      run: () =>
        callSwarmsAgent({
          swarmsApiKey: swarmsKey,
          systemPrompt: options.systemPrompt,
          userPrompt: options.userPrompt,
          model: options.model,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
        }),
    });
  }

  if (openaiKey) {
    attempts.push({
      name: "openai",
      run: () =>
        callOpenAIRaw({
          apiKey: openaiKey,
          model: options.model,
          systemPrompt: options.systemPrompt,
          userPrompt: options.userPrompt,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
        }),
    });
  }

  if (attempts.length === 0) {
    throw new Error(
      "No LLM provider configured (need SWARMS_API_KEY or OPENAI_API_KEY)",
    );
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const out = await attempt.run();
      if (out && out.trim()) return out;
      errors.push(`${attempt.name}: empty output`);
    } catch (err) {
      errors.push(`${attempt.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`All LLM providers failed — ${errors.join("; ")}`);
}

/* ------------------------------------------------------------------ */
/*  Smart LLM Router                                                   */
/* ------------------------------------------------------------------ */

export type LLMProvider = "swarms" | "openai" | "auto";

export interface SmartLLMOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  provider?: LLMProvider;       // default "auto"
  taskType?: "research" | "analysis" | "creative" | "extraction" | "code" | "general";
  model?: string;               // OpenAI / Swarms server-side model
}

/**
 * Smart LLM router — reads provider keys from the runtime and picks a provider.
 *
 * Auto-routing (preferred order): **Swarms → OpenAI**, cascading to the next on
 * failure. An explicit `provider` override is honored and does NOT cascade (it
 * either runs that provider or throws if its key is missing).
 *
 * @param runtime - ElizaOS runtime (or any object with getSetting(key))
 */
export async function callLLM(
  runtime: { getSetting: (key: string) => string | boolean | number | null },
  options: SmartLLMOptions,
): Promise<string> {
  const swarmsKey = String(runtime.getSetting("SWARMS_API_KEY") ?? "").trim() || undefined;
  const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "").trim() || undefined;
  const provider = options.provider ?? "auto";

  const runSwarms = (key: string) =>
    callSwarmsAgent({
      swarmsApiKey: key,
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      model: options.model,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    });
  const runOpenAI = (key: string) =>
    callOpenAIRaw({
      apiKey: key,
      model: options.model,
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    });

  // Explicit provider override — run exactly that provider, no cascade.
  if (provider === "swarms") {
    if (!swarmsKey) throw new Error("SWARMS_API_KEY not configured");
    return runSwarms(swarmsKey);
  }
  if (provider === "openai") {
    if (!openaiKey) throw new Error("OPENAI_API_KEY not configured");
    return runOpenAI(openaiKey);
  }

  // Auto — Swarms → OpenAI, cascading on failure.
  const attempts: Array<{ name: string; run: () => Promise<string> }> = [];
  if (swarmsKey) attempts.push({ name: "swarms", run: () => runSwarms(swarmsKey) });
  if (openaiKey) attempts.push({ name: "openai", run: () => runOpenAI(openaiKey) });

  if (attempts.length === 0) {
    throw new Error("No LLM API key configured (need SWARMS_API_KEY or OPENAI_API_KEY)");
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const out = await attempt.run();
      if (out && out.trim()) return out;
      errors.push(`${attempt.name}: empty output`);
    } catch (err) {
      errors.push(`${attempt.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`All LLM providers failed — ${errors.join("; ")}`);
}
