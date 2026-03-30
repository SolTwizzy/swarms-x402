import {
  type Evaluator,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  ModelType,
} from "@elizaos/core";
import { X402WalletService } from "../services/x402WalletService.js";
import { PaymentMemoryService } from "../services/paymentMemoryService.js";

/**
 * Evaluates conversations for payment-related patterns and monitors
 * spending against budget via Dexter SDK.
 */
export const paymentEvaluator: Evaluator = {
  name: "PAYMENT_EVALUATOR",
  description:
    "Tracks x402 payment patterns and budget usage after each interaction",
  similes: ["X402_TRACKER", "SPEND_MONITOR"],
  alwaysRun: false,

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => {
    const walletService = runtime.getService<X402WalletService>(
      "X402_WALLET" as any
    );
    return !!walletService;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback
  ): Promise<{ success: boolean } | undefined> => {
    const walletService = runtime.getService<X402WalletService>(
      "X402_WALLET" as any
    );
    if (!walletService) return { success: true };

    const budgetAccount = walletService.getBudgetAccount();
    if (!budgetAccount) return { success: true };

    const remaining = budgetAccount.remainingAmount;
    const spent = budgetAccount.spentAmount;
    const total = remaining + spent;
    const payments = budgetAccount.payments;
    const hourlySpend = walletService.getHourlySpend();

    // Warn if approaching budget exhaustion (>80% spent)
    if (total > 0 && spent > total * 0.8) {
      runtime.logger.warn(
        { spent, remaining, total, payments },
        "[PaymentEvaluator] Approaching budget limit (>80% spent)"
      );
    }

    // Warn if hourly spend is high
    const config = walletService.getConfig();
    const perHourLimit = config.maxAutoPayUsd * 100;
    if (hourlySpend > perHourLimit * 0.8) {
      runtime.logger.warn(
        { hourlySpend, perHourLimit },
        "[PaymentEvaluator] Approaching hourly spend limit"
      );
    }

    // Log session summary every 10 payments
    if (payments > 0 && payments % 10 === 0) {
      runtime.logger.info(
        {
          totalPayments: payments,
          totalSpentUsd: spent,
          remaining,
          avgCostUsd: spent / payments,
          hourlySpend,
        },
        "[PaymentEvaluator] Payment session summary"
      );
    }

    // LLM-based quality scoring for recent payments
    try {
      const paymentMemoryService =
        runtime.getService<PaymentMemoryService>("PAYMENT_MEMORY" as any);

      if (paymentMemoryService) {
        const unscored = paymentMemoryService.getUnscoredPayments(3);

        for (const payment of unscored) {
          try {
            const scoringPrompt = `Rate this API response quality from 1 to 5.
Endpoint: ${payment.endpoint}
Status: ${payment.responseStatus}
Response time: ${payment.responseTimeMs}ms
Response preview: ${payment.responsePreview.slice(0, 200)}

Return ONLY valid JSON: { "score": <number 1-5>, "reason": "<brief explanation>" }`;

            const result = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: scoringPrompt,
            });

            const resultStr =
              typeof result === "string" ? result : String(result);

            // Extract JSON from the response (handle markdown code blocks)
            const jsonMatch = resultStr.match(/\{[\s\S]*?\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]) as {
                score: number;
                reason: string;
              };
              const rawScore = Math.round(parsed.score);
              if (Number.isNaN(rawScore)) {
                runtime.logger.debug(
                  { endpoint: payment.endpoint, rawScore: parsed.score },
                  "[PaymentEvaluator] LLM returned non-numeric score, skipping"
                );
                continue;
              }
              const score = Math.max(1, Math.min(5, rawScore));
              const reason = parsed.reason ?? "No reason provided";

              await paymentMemoryService.scorePayment(
                payment.recordId,
                score,
                reason
              );

              const isError =
                payment.responseStatus >= 400 ||
                payment.responseStatus === 0;
              // Extract amountUsd from the history record if available
              const agentId = runtime.agentId ?? "unknown";
              await paymentMemoryService.updateEndpointScore(
                agentId,
                payment.domain,
                0, // amountUsd not available on UnscoredPayment
                payment.responseTimeMs,
                score,
                isError
              );

              runtime.logger.debug(
                { endpoint: payment.endpoint, score, reason },
                "[PaymentEvaluator] Scored payment quality"
              );
            }
          } catch (scoreErr) {
            runtime.logger.debug(
              {
                error:
                  scoreErr instanceof Error
                    ? scoreErr.message
                    : String(scoreErr),
                endpoint: payment.endpoint,
              },
              "[PaymentEvaluator] Failed to score individual payment"
            );
          }
        }
      }
    } catch (err) {
      runtime.logger.debug(
        { error: err instanceof Error ? err.message : String(err) },
        "[PaymentEvaluator] Quality scoring pass failed"
      );
    }

    return { success: true };
  },

  examples: [],
};
