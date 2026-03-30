import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  ModelType,
} from "@elizaos/core";
import { SignalService } from "../services/signalService.js";

export const getLatestSignal: Action = {
  name: "GET_LATEST_SIGNAL",
  description:
    "Retrieve the latest cached trading signal for a crypto asset.",
  similes: [
    "CHECK_SIGNAL",
    "LAST_SIGNAL",
    "CACHED_SIGNAL",
    "SHOW_SIGNAL",
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => true,

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

    // Extract asset from user message
    const extraction = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `Extract the crypto asset symbol from this message. Return JSON with field:
- asset (string, e.g. "BTC", "ETH", "SOL")

User message: "${message.content.text ?? ""}"

Return only valid JSON, no markdown.`,
    });

    let asset: string;
    try {
      const parsed = JSON.parse(String(extraction));
      asset = String(parsed.asset ?? "").toUpperCase();
      if (!asset) throw new Error("empty");
    } catch {
      await callback?.({
        text: "Could not determine which asset to look up. Please specify a crypto asset like BTC, ETH, or SOL.",
        error: true,
      });
      return { success: false, error: "Could not parse asset from message" };
    }

    const signal = signalService.getLatestSignal(asset);

    if (!signal) {
      const text = `No cached signal for ${asset}. Use GENERATE_SIGNAL to create one first.`;
      await callback?.({ text });
      return { success: true, text };
    }

    const text = [
      `Cached signal for ${signal.asset}:`,
      `Signal: ${signal.signal} (${signal.confidence}% confidence)`,
      `Consensus: ${signal.consensus}`,
      `Timeframe: ${signal.timeframe}`,
      `Generated: ${signal.generatedAt}`,
    ].join("\n");

    await callback?.({
      text,
      content: {
        asset: signal.asset,
        signal: signal.signal,
        confidence: String(signal.confidence),
        consensus: signal.consensus,
      },
    });
    return { success: true, text };
  },

  examples: [
    [
      {
        name: "user",
        content: { text: "What's the latest signal for BTC?" },
      },
      {
        name: "agent",
        content: {
          text: "Cached signal for BTC:\nSignal: LONG (72% confidence)\nConsensus: 2/3 LONG\n...",
          actions: ["GET_LATEST_SIGNAL"],
        },
      },
    ],
  ],
};
