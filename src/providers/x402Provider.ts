import {
  type Provider,
  type IAgentRuntime,
  type Memory,
  type State,
  type ProviderResult,
} from "@elizaos/core";
import { X402WalletService } from "../services/x402WalletService.js";
import { PaymentMemoryService } from "../services/paymentMemoryService.js";

/**
 * Injects x402 payment context into the agent's LLM prompt.
 * Lets the agent know its wallet status, spending history, budget, and access pass.
 */
export const x402Provider: Provider = {
  name: "X402_PAYMENT_CONTEXT",
  description:
    "Provides x402 payment wallet status, Dexter budget, and spending context to the agent",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const walletService = runtime.getService<X402WalletService>(
      "X402_WALLET" as any
    );

    if (!walletService) {
      return { text: "[x402] Payment service not initialized." };
    }

    const config = walletService.getConfig();
    const budgetAccount = walletService.getBudgetAccount();
    const history = walletService.getPaymentHistory();
    const recentPayments = history.slice(-3).map(
      (p) => `  - $${p.amount.toFixed(4)} -> ${p.domain} on ${p.network}`
    );

    const accessPassLine = config.accessPassTier
      ? `Access pass: ${config.accessPassTier} tier (auto-renew enabled)`
      : "Access pass: not configured";

    // Build spending history and endpoint value sections from PaymentMemoryService
    let spendingSection = "";
    const memoryService = runtime.getService<PaymentMemoryService>(
      "PAYMENT_MEMORY" as any
    );

    if (memoryService) {
      const stats24h = memoryService.getSpendingStats("24h");
      const stats7d = memoryService.getSpendingStats("7d");
      const stats30d = memoryService.getSpendingStats("30d");

      if (stats24h.totalCalls > 0 || stats7d.totalCalls > 0 || stats30d.totalCalls > 0) {
        spendingSection += `\nSpending History:
  Last 24h: $${stats24h.totalSpent.toFixed(2)} across ${stats24h.totalCalls} calls
  Last 7d: $${stats7d.totalSpent.toFixed(2)} across ${stats7d.totalCalls} calls
  Last 30d: $${stats30d.totalSpent.toFixed(2)} across ${stats30d.totalCalls} calls`;
      }

      const scores = memoryService.getEndpointScoreSummary();
      const scoredEndpoints = scores.filter((s) => s.avgQuality > 0);

      if (scoredEndpoints.length > 0) {
        // Best value: highest quality/cost ratio (already sorted best-first)
        const bestValue = scoredEndpoints.slice(0, 3);
        spendingSection += `\n\nBest Value Endpoints:`;
        bestValue.forEach((ep, i) => {
          spendingSection += `\n  ${i + 1}. ${ep.domain} — $${ep.avgCostPerCall.toFixed(2)}/call, quality ${ep.avgQuality.toFixed(1)}/5 (${ep.totalCalls} calls)`;
        });

        // Worst value: lowest ratio (reverse of sorted)
        const worstValue = scoredEndpoints.slice(-3).reverse();
        // Only show if distinct from best value endpoints
        const bestDomains = new Set(bestValue.map((e) => e.domain));
        const uniqueWorst = worstValue.filter((e) => !bestDomains.has(e.domain));
        if (uniqueWorst.length > 0) {
          spendingSection += `\n\nAvoid (Low Value):`;
          uniqueWorst.forEach((ep, i) => {
            spendingSection += `\n  ${i + 1}. ${ep.domain} — $${ep.avgCostPerCall.toFixed(2)}/call, quality ${ep.avgQuality.toFixed(1)}/5 (${ep.totalCalls} calls)`;
          });
        }
      }
    }

    return {
      text: `[x402 Wallet Context — Dexter SDK]
Network: ${config.networkId}
Auto-pay limit: $${config.maxAutoPayUsd} per request
Budget remaining: ${budgetAccount?.remaining ?? "not configured"}
Total spent this session: $${(budgetAccount?.spentAmount ?? 0).toFixed(4)}
Payments made: ${budgetAccount?.payments ?? 0}
Hourly spend: $${(walletService.getHourlySpend()).toFixed(4)}
${accessPassLine}
Recent payments (last 3):
${recentPayments.length > 0 ? recentPayments.join("\n") : "  None yet"}
${spendingSection}
You can pay for x402-protected APIs autonomously up to $${config.maxAutoPayUsd} per call.
Use DISCOVER_X402_SERVICES to find available services on OpenDexter, PAY_FOR_X402_SERVICE to access paid endpoints, DELEGATE_TO_SWARM for complex tasks, or DELEGATE_TO_SWARM_WITH_PAYMENT for tasks that need paid external data fed into swarm analysis.`,
    };
  },
};
