import {
  type Provider,
  type IAgentRuntime,
  type Memory,
  type State,
  type ProviderResult,
} from "@elizaos/core";
import { X402ServerService } from "../server/index.js";

/**
 * Sell-side endpoint catalog used for the LLM context.
 * Kept in sync with x402Routes definitions.
 */
const SELL_SIDE_ENDPOINTS = [
  { path: "POST /x402/research", price: "$0.05", desc: "Run a ResearchPipeline swarm" },
  { path: "POST /x402/analyze", price: "$0.03", desc: "Run an AnalysisPanel swarm" },
  { path: "POST /x402/agent", price: "$0.02", desc: "Single agent run" },
  { path: "GET  /x402/catalog", price: "FREE", desc: "List all paid endpoints" },
  { path: "GET  /x402/health", price: "FREE", desc: "Service status" },
];

/**
 * Injects sell-side x402 revenue context into the agent's LLM prompt.
 * Active only when X402_RECEIVE_ADDRESS is configured and X402ServerService is running.
 */
export const x402ServerProvider: Provider = {
  name: "X402_SERVER_CONTEXT",
  description:
    "Provides x402 sell-side context: revenue earned, settlements, and available paid endpoints",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    const serverService = runtime.getService<X402ServerService>(
      "X402_SERVER" as any
    );

    if (!serverService?.isAvailable()) {
      return { text: "[x402 Server] Not configured." };
    }

    const receiveAddress = serverService.getReceiveAddress();
    const network = serverService.getNetwork();
    const totalRevenue = serverService.getTotalRevenueUsd();
    const settlementCount = serverService.getSettlementCount();
    const history = serverService.getRevenueHistory();

    const recentPayments = history.slice(-3).map(
      (r) =>
        `  - $${r.amountUsd.toFixed(4)} from ${r.payer || "unknown"} for ${r.endpoint} (tx: ${r.txHash.slice(0, 12)}...)`
    );

    const endpointList = SELL_SIDE_ENDPOINTS.map(
      (e) => `  - ${e.path} — ${e.price} — ${e.desc}`
    ).join("\n");

    return {
      text: `[x402 Server Context — Sell Side]
Receive address: ${receiveAddress}
Network: ${network}
Total revenue: $${totalRevenue.toFixed(4)}
Settlements: ${settlementCount}

Recent incoming payments (last 3):
${recentPayments.length > 0 ? recentPayments.join("\n") : "  None yet"}

Available sell-side endpoints:
${endpointList}

You are accepting x402 payments for agent services. Clients pay USDC to access your endpoints above.`,
    };
  },
};
