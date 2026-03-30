import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  ModelType,
} from "@elizaos/core";
import { z } from "zod";
import { SignalService } from "../services/signalService.js";

const SignalRequestSchema = z.object({
  asset: z.string().min(1),
  timeframe: z.string().optional().default("4h"),
});

export const generateSignal: Action = {
  name: "GENERATE_SIGNAL",
  description:
    "Generate a trading signal for a crypto asset by running a multi-analyst swarm with x402-paid market data.",
  similes: [
    "ANALYZE_MARKET",
    "GET_SIGNAL",
    "CRYPTO_ANALYSIS",
    "TRADE_SIGNAL",
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => {
    const hasSwarms = !!runtime.getSetting("SWARMS_API_KEY");
    const hasWallet =
      !!runtime.getSetting("SOLANA_PRIVATE_KEY") ||
      !!runtime.getSetting("EVM_PRIVATE_KEY");
    return hasSwarms && hasWallet;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<{ success: boolean; text?: string; error?: string } | undefined> => {
    const signalService = runtime.getService<SignalService>("SIGNAL" as any);
    if (!signalService) {
      await callback?.({
        text: "SignalService not initialized. Add SignalService to your agent plugin.",
        error: true,
      });
      return { success: false, error: "SignalService not available" };
    }

    // Extract asset + timeframe from the user message via LLM
    const extraction = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `Extract the crypto asset symbol and timeframe from this message. Return JSON with fields:
- asset (string, e.g. "BTC", "ETH", "SOL")
- timeframe (string, e.g. "1h", "4h", "1d", default "4h")

User message: "${message.content.text ?? ""}"

Return only valid JSON, no markdown.`,
    });

    let params: z.infer<typeof SignalRequestSchema>;
    try {
      params = SignalRequestSchema.parse(JSON.parse(String(extraction)));
    } catch {
      await callback?.({
        text: "Could not determine the asset to analyze. Please specify a crypto asset like BTC, ETH, or SOL.",
        error: true,
      });
      return { success: false, error: "Could not parse asset from message" };
    }

    await callback?.({
      text: `Generating ${params.asset.toUpperCase()} signal (${params.timeframe} timeframe)... Running 3-analyst swarm with market data.`,
    });

    try {
      const signal = await signalService.generateSignal(
        params.asset,
        params.timeframe
      );

      const card = formatSignalCard(signal);

      await callback?.({
        text: card,
        content: {
          asset: signal.asset,
          signal: signal.signal,
          confidence: String(signal.confidence),
          consensus: signal.consensus,
          timeframe: signal.timeframe,
        },
      });
      return { success: true, text: card };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `Signal generation failed: ${msg}`, error: true });
      return { success: false, error: msg };
    }
  },

  examples: [
    [
      {
        name: "user",
        content: { text: "Generate a trading signal for ETH on the 4h timeframe" },
      },
      {
        name: "agent",
        content: {
          text: "SIGNAL: ETH — LONG (72% confidence)\nConsensus: 2/3 LONG\n...",
          actions: ["GENERATE_SIGNAL"],
        },
      },
    ],
  ],
};

function formatSignalCard(signal: import("../types.js").TradingSignal): string {
  const icon =
    signal.signal === "LONG" ? "^" : signal.signal === "SHORT" ? "v" : "-";
  return [
    `SIGNAL: ${signal.asset} — ${signal.signal} ${icon} (${signal.confidence}% confidence)`,
    `Consensus: ${signal.consensus}`,
    `Timeframe: ${signal.timeframe}`,
    ``,
    `Technical: ${signal.analysts.technical.verdict} (${signal.analysts.technical.confidence}%) — ${signal.analysts.technical.reasoning}`,
    `Sentiment: ${signal.analysts.sentiment.verdict} (${signal.analysts.sentiment.confidence}%) — ${signal.analysts.sentiment.reasoning}`,
    `On-Chain:  ${signal.analysts.onchain.verdict} (${signal.analysts.onchain.confidence}%) — ${signal.analysts.onchain.reasoning}`,
    ``,
    `Cost: ${signal.costToGenerate} | Generated: ${signal.generatedAt}`,
  ].join("\n");
}
