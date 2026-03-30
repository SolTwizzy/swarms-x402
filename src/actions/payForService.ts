import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  ModelType,
} from "@elizaos/core";
import { z } from "zod";
import { X402WalletService } from "../services/x402WalletService.js";

const PaySchema = z.object({
  endpoint: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().default("GET"),
  body: z.string().optional(),
  headers: z.record(z.string()).optional(),
  description: z.string().optional(),
});

export const payForService: Action = {
  name: "PAY_FOR_X402_SERVICE",
  description:
    "Access an x402-protected API endpoint. Payment is handled automatically by the Dexter SDK. Supports GET, POST, PUT, DELETE.",
  similes: [
    "PAY_FOR_API",
    "X402_PAY",
    "MICROPAYMENT",
    "PAY_FOR_RESOURCE",
    "BUY_API_ACCESS",
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => {
    return (
      !!runtime.getSetting("SOLANA_PRIVATE_KEY") ||
      !!runtime.getSetting("EVM_PRIVATE_KEY")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<{ success: boolean; text?: string; error?: string } | undefined> => {
    const walletService = runtime.getService<X402WalletService>(
      "X402_WALLET" as any
    );
    if (!walletService) {
      await callback?.({
        text: "X402 wallet service is not initialized. Add X402WalletService to your agent.",
        error: true,
      });
      return { success: false, error: "X402 wallet service not initialized" };
    }

    // Extract endpoint details from the message using the LLM
    const extraction = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `Extract API endpoint details from this request. Return JSON with fields:
- endpoint (URL, required)
- method ("GET", "POST", "PUT", or "DELETE", default "GET")
- body (request body string, optional)
- headers (object of header key-value pairs, optional)
- description (optional)

User message: "${message.content.text ?? ""}"

Return only valid JSON, no markdown.`,
    });

    let params: z.infer<typeof PaySchema>;
    try {
      params = PaySchema.parse(JSON.parse(String(extraction)));
    } catch {
      await callback?.({
        text: "Could not parse endpoint details. Please specify the endpoint URL to access.",
        error: true,
      });
      return { success: false, error: "Could not parse endpoint details" };
    }

    const budgetAccount = walletService.getBudgetAccount();
    if (!budgetAccount) {
      await callback?.({
        text: "Wallet not configured. Set SOLANA_PRIVATE_KEY or EVM_PRIVATE_KEY.",
        error: true,
      });
      return { success: false, error: "Wallet not configured" };
    }

    await callback?.({
      text: `Accessing x402 endpoint: ${params.method} ${params.endpoint}\nRemaining budget: ${budgetAccount.remaining}`,
    });

    try {
      const result = await walletService.payForResource(params.endpoint, {
        method: params.method,
        headers: params.headers,
        body: params.body,
      });

      const responseText =
        result.response.ok
          ? await result.response.text().catch(() => "(binary response)")
          : null;

      const txInfo =
        result.txHash !== "no-payment-required"
          ? `\n- Tx: ${result.txHash}${result.network ? ` (${result.network})` : ""}`
          : "";

      const text = `Access successful.\n- Endpoint: ${params.method} ${params.endpoint}\n- Amount paid: $${result.amountUsd.toFixed(4)} USDC${txInfo}\n- Remaining budget: ${budgetAccount.remaining}${responseText ? `\n\nResponse:\n${responseText.slice(0, 500)}` : ""}`;

      await callback?.({
        text,
        content: {
          txHash: result.txHash,
          amountUsd: String(result.amountUsd),
          responsePreview: responseText?.slice(0, 500),
        },
      });
      return { success: true, text };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `Payment failed: ${msg}`, error: true });
      return { success: false, error: msg };
    }
  },

  examples: [
    [
      {
        name: "user",
        content: {
          text: "Access the x402 endpoint at https://api.example.com/data",
        },
      },
      {
        name: "agent",
        content: {
          text: "Access successful.\n- Endpoint: GET https://api.example.com/data\n- Amount paid: $0.0100 USDC\n- Tx: 5abc...xyz (solana:5eykt...)\n- Remaining budget: $9.99",
          actions: ["PAY_FOR_X402_SERVICE"],
        },
      },
    ],
  ],
};
