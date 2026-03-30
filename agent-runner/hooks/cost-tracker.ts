/**
 * Cost Tracker Hook
 *
 * Tracks token usage and estimated costs per session.
 * Prints a running total after each LLM call.
 *
 * Pricing (approximate):
 * - OpenAI gpt-4o-mini: $0.15/1M input, $0.60/1M output
 * - OpenAI gpt-4o:      $2.50/1M input, $10.00/1M output
 * - Gemini flash:       $0.075/1M input, $0.30/1M output
 * - Gemini pro:         $1.25/1M input, $5.00/1M output
 *
 * @module
 */

import type { Hook, HookContext } from "../types";

interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  calls: number;
}

const PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI (per 1M tokens)
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  // Gemini (per 1M tokens)
  "gemini-2.0-flash": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash-lite": { input: 0.0375, output: 0.15 },
  "gemini-2.5-pro-preview": { input: 1.25, output: 5.0 },
};

export function costTrackerHooks(): Hook[] {
  const cost: CostEstimate = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    calls: 0,
  };

  function updateCost(session: HookContext["session"]): void {
    const tokens = session.metadata.totalTokens as
      | { input: number; output: number }
      | undefined;
    if (!tokens) return;

    cost.inputTokens = tokens.input;
    cost.outputTokens = tokens.output;

    // Determine model pricing
    const model =
      session.model === "gemini"
        ? (process.env.GEMINI_MODEL ?? "gemini-2.0-flash")
        : (process.env.OPENAI_MODEL ?? "gpt-4o-mini");

    const pricing = PRICING[model] ?? PRICING["gpt-4o-mini"];

    cost.estimatedCostUsd =
      (tokens.input / 1_000_000) * pricing.input +
      (tokens.output / 1_000_000) * pricing.output;
  }

  return [
    {
      event: "message:assistant",
      handler: (ctx: HookContext) => {
        cost.calls++;
        updateCost(ctx.session);
        console.log(
          `  [cost] Call #${cost.calls} | Tokens: ${cost.inputTokens.toLocaleString()}in + ${cost.outputTokens.toLocaleString()}out | Est. cost: $${cost.estimatedCostUsd.toFixed(4)}`
        );
      },
    },
    {
      event: "tool:after",
      handler: (ctx: HookContext) => {
        if (ctx.toolName) {
          // SwarmX endpoint costs are separate — tracked by price in tool metadata
          // Here we just note it was called
        }
      },
    },
    {
      event: "session:end",
      handler: (ctx: HookContext) => {
        updateCost(ctx.session);
        console.log(
          `\n[cost] Session total: ${cost.calls} LLM calls | ${(cost.inputTokens + cost.outputTokens).toLocaleString()} tokens | ~$${cost.estimatedCostUsd.toFixed(4)}`
        );
      },
    },
  ];
}
