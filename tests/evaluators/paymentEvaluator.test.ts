import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMockRuntime,
  createMockMessage,
  createMockWalletService,
  createMockBudgetAccount,
} from "../setup.js";
import { paymentEvaluator } from "../../src/evaluators/paymentEvaluator.js";

describe("paymentEvaluator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validate()", () => {
    it("returns true when wallet service exists", async () => {
      const walletService = createMockWalletService();
      const runtime = createMockRuntime({ services: { X402_WALLET: walletService } });
      expect(await paymentEvaluator.validate(runtime, createMockMessage("test"))).toBe(true);
    });

    it("returns false when no wallet service", async () => {
      const runtime = createMockRuntime();
      expect(await paymentEvaluator.validate(runtime, createMockMessage("test"))).toBe(false);
    });
  });

  describe("handler()", () => {
    it("returns early when no wallet service", async () => {
      const runtime = createMockRuntime();
      await paymentEvaluator.handler(runtime, createMockMessage("test"));
      expect(runtime.logger.warn).not.toHaveBeenCalled();
    });

    it("returns early when no budget account", async () => {
      const walletService = createMockWalletService({ budgetAccount: null });
      const runtime = createMockRuntime({ services: { X402_WALLET: walletService } });
      await paymentEvaluator.handler(runtime, createMockMessage("test"));
      expect(runtime.logger.warn).not.toHaveBeenCalled();
    });

    it("warns at 80% budget usage", async () => {
      const budgetAccount = createMockBudgetAccount({
        spentAmount: 9,
        remainingAmount: 1,
        payments: 5,
      });
      const walletService = createMockWalletService({ budgetAccount, hourlySpend: 0 });
      const runtime = createMockRuntime({ services: { X402_WALLET: walletService } });

      await paymentEvaluator.handler(runtime, createMockMessage("test"));

      expect(runtime.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ spent: 9, remaining: 1 }),
        expect.stringContaining("budget limit")
      );
    });

    it("does not warn below 80% budget usage", async () => {
      const budgetAccount = createMockBudgetAccount({
        spentAmount: 5,
        remainingAmount: 5,
        payments: 3,
      });
      const walletService = createMockWalletService({ budgetAccount, hourlySpend: 0 });
      const runtime = createMockRuntime({ services: { X402_WALLET: walletService } });

      await paymentEvaluator.handler(runtime, createMockMessage("test"));

      expect(runtime.logger.warn).not.toHaveBeenCalled();
    });

    it("logs summary every 10 payments", async () => {
      const budgetAccount = createMockBudgetAccount({
        spentAmount: 1,
        remainingAmount: 9,
        payments: 10,
      });
      const walletService = createMockWalletService({ budgetAccount, hourlySpend: 0 });
      const runtime = createMockRuntime({ services: { X402_WALLET: walletService } });

      await paymentEvaluator.handler(runtime, createMockMessage("test"));

      expect(runtime.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ totalPayments: 10 }),
        expect.stringContaining("summary")
      );
    });

    it("does not log summary at non-milestone counts", async () => {
      const budgetAccount = createMockBudgetAccount({
        spentAmount: 0.7,
        remainingAmount: 9.3,
        payments: 7,
      });
      const walletService = createMockWalletService({ budgetAccount, hourlySpend: 0 });
      const runtime = createMockRuntime({ services: { X402_WALLET: walletService } });

      await paymentEvaluator.handler(runtime, createMockMessage("test"));

      expect(runtime.logger.info).not.toHaveBeenCalled();
    });

    it("scores unscored payments when PaymentMemoryService is available", async () => {
      const scoredIds: Array<{ id: string; score: number; reason: string }> = [];
      const mockMemoryService = {
        getUnscoredPayments: vi.fn(() => [
          {
            recordId: "pay-1",
            endpoint: "https://api.exa.ai/search",
            domain: "api.exa.ai",
            responseStatus: 200,
            responseTimeMs: 120,
            responsePreview: '{"results":[{"title":"test"}]}',
          },
        ]),
        scorePayment: vi.fn(async (id: string, score: number, reason: string) => {
          scoredIds.push({ id, score, reason });
        }),
        updateEndpointScore: vi.fn(async () => {}),
      };

      const budgetAccount = createMockBudgetAccount({
        spentAmount: 0.5,
        remainingAmount: 9.5,
        payments: 1,
      });
      const walletService = createMockWalletService({ budgetAccount, hourlySpend: 0 });
      const runtime = createMockRuntime({
        services: {
          X402_WALLET: walletService,
          PAYMENT_MEMORY: mockMemoryService,
        },
        useModelReturn: '{"score": 4, "reason": "Fast and accurate response"}',
      });

      await paymentEvaluator.handler(runtime, createMockMessage("test"));

      expect(mockMemoryService.getUnscoredPayments).toHaveBeenCalledWith(3);
      expect(mockMemoryService.scorePayment).toHaveBeenCalledWith(
        "pay-1",
        4,
        "Fast and accurate response"
      );
      expect(mockMemoryService.updateEndpointScore).toHaveBeenCalledWith(
        "test-agent-id",
        "api.exa.ai",
        0,
        120,
        4,
        false
      );
    });
  });
});
