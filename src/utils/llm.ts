/**
 * Single-agent LLM utilities.
 *
 * Provider priority (production): **OpenAI → Swarms.**
 *  - Direct OpenAI (funded key) is the primary: the Swarms single-agent API
 *    has been returning empty `outputs: []` while still billing per call
 *    (verified again 2026-07-17), so leading with it wasted a round-trip and
 *    a micro-charge on every request.
 *  - Swarms remains the fallback and takes over automatically if OpenAI errors.
 */

const SWARMS_API_BASE = "https://api.swarms.world";

/** Default model for both providers. gpt-5 family = reasoning models (see callOpenAIRaw). */
export const DEFAULT_LLM_MODEL = "gpt-5-mini";

/** Reasoning models reject `max_tokens`/custom `temperature` and burn part of the completion budget on reasoning tokens. */
const REASONING_MODEL_RE = /^(gpt-5|o\d)/i;
const REASONING_TOKEN_HEADROOM = 1024;

/* ------------------------------------------------------------------ */
/*  Raw provider calls                                                 */
/* ------------------------------------------------------------------ */

/**
 * Raw OpenAI chat completion. Private — the exported `callOpenAI` cascades
 * through Swarms before reaching this.
 */
async function callOpenAIRaw(options: {
  apiKey: string;
  model?: string; // default DEFAULT_LLM_MODEL
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number; // default 4096
  temperature?: number; // default 0.3 (ignored for reasoning models — they only allow the default)
}): Promise<string> {
  const model = options.model ?? DEFAULT_LLM_MODEL;
  const isReasoningModel = REASONING_MODEL_RE.test(model);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: options.systemPrompt },
        { role: "user", content: options.userPrompt },
      ],
      ...(isReasoningModel
        ? {
            // Reasoning tokens are billed against the completion budget, so pad
            // it — otherwise small caps (e.g. panel agents at 400) return empty.
            max_completion_tokens:
              (options.maxTokens ?? 4096) + REASONING_TOKEN_HEADROOM,
            reasoning_effort: "low",
          }
        : {
            max_tokens: options.maxTokens ?? 4096,
            temperature: options.temperature ?? 0.3,
          }),
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
  model?: string; // model Swarms runs server-side (default DEFAULT_LLM_MODEL) — Swarms bills it
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
        model_name: options.model ?? DEFAULT_LLM_MODEL,
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
  apiKey: string; // OpenAI key (primary provider)
  model?: string; // OpenAI model / Swarms server-side model (default DEFAULT_LLM_MODEL)
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
 * Single-agent LLM call. Routes **OpenAI → Swarms**, cascading to the next
 * provider on error or empty output. (Named `callOpenAI` for historical
 * call-site compatibility.)
 *
 * Returns the completion text. Throws only if every configured provider fails.
 */
export async function callOpenAI(options: CallOpenAIOptions): Promise<string> {
  const swarmsKey = (options.swarmsApiKey ?? process.env.SWARMS_API_KEY ?? "").trim();
  const openaiKey = (options.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim();

  const attempts: Array<{ name: string; run: () => Promise<string> }> = [];

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
/*  Local multi-agent panel                                            */
/* ------------------------------------------------------------------ */

export interface PanelAgent {
  name: string;
  systemPrompt: string;
}

export interface LocalPanelResult {
  /** Concatenated `[Name]\n<argument>` blocks for the agents that produced output. */
  transcript: string;
  /** Number of agents that produced usable output. */
  agentCount: number;
}

/**
 * Marker of Swarms `DebateWithJudge` prompt scaffolding (the framework's role
 * prompts, which its broken serialization returned in place of completions).
 * If the Swarms single-agent endpoint ever recovers but echoes such scaffolding
 * through the cascade, we drop it rather than pass it off as analysis.
 */
const PANEL_SCAFFOLD_RE =
  /Present your (?:argument in favor|counter-argument against)|Loop \d+\/\d+: Evaluate the debate/i;

/**
 * Run a multi-agent analyst panel LOCALLY: each agent is one `callLLM` call
 * (Swarms → OpenAI cascade), all run concurrently, and their arguments are
 * concatenated into a transcript. A downstream "judge" call (via `callLLM`)
 * then synthesizes a verdict from that transcript.
 *
 * This replaces the server-side Swarms `DebateWithJudge` orchestration, which
 * became unusable (its response returns prompt scaffolding, not completions).
 * Because it is built on `callLLM`, it is provider-resilient: it uses whichever
 * of Swarms / OpenAI is actually returning output.
 *
 * An agent whose call fails or returns empty is simply dropped (never fabricated).
 */
export async function runLocalPanel(
  runtime: { getSetting: (key: string) => string | boolean | number | null },
  opts: {
    agents: PanelAgent[];
    task: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }
): Promise<LocalPanelResult> {
  const results = await Promise.all(
    opts.agents.map(async (a) => {
      try {
        const text = await callLLM(runtime, {
          systemPrompt: a.systemPrompt,
          userPrompt: opts.task,
          model: opts.model,
          maxTokens: opts.maxTokens ?? 400,
          temperature: opts.temperature ?? 0.4,
        });
        const trimmed = (text ?? "").trim();
        // Never pass off prompt scaffolding as analysis — drop it (→ empty).
        return { name: a.name, text: PANEL_SCAFFOLD_RE.test(trimmed) ? "" : trimmed };
      } catch {
        return { name: a.name, text: "" };
      }
    })
  );
  const good = results.filter((r) => r.text);
  return {
    transcript: good.map((r) => `[${r.name}]\n${r.text}`).join("\n\n"),
    agentCount: good.length,
  };
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
 * Auto-routing (preferred order): **OpenAI → Swarms**, cascading to the next on
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

  // Auto — OpenAI → Swarms, cascading on failure.
  const attempts: Array<{ name: string; run: () => Promise<string> }> = [];
  if (openaiKey) attempts.push({ name: "openai", run: () => runOpenAI(openaiKey) });
  if (swarmsKey) attempts.push({ name: "swarms", run: () => runSwarms(swarmsKey) });

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
