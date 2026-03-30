import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMockRuntime,
  createMockCallback,
  createMockMessage,
  createMockWalletService,
  createMockBudgetAccount,
} from "../setup.js";
import { payForService } from "../../src/actions/payForService.js";

describe("payForService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validate()", () => {
    it("returns true when EVM_PRIVATE_KEY is set", async () => {
      const runtime = createMockRuntime({ settings: { EVM_PRIVATE_KEY: "0xabc" } });
      expect(await payForService.validate(runtime, createMockMessage("test"))).toBe(true);
    });

    it("returns true when SOLANA_PRIVATE_KEY is set", async () => {
      const runtime = createMockRuntime({ settings: { SOLANA_PRIVATE_KEY: "5abc" } });
      expect(await payForService.validate(runtime, createMockMessage("test"))).toBe(true);
    });

    it("returns false when neither key is set", async () => {
      const runtime = createMockRuntime({ settings: {} });
      expect(await payForService.validate(runtime, createMockMessage("test"))).toBe(false);
    });
  });

  describe("handler()", () => {
    it("returns error when no wallet service", async () => {
      const runtime = createMockRuntime();
      const callback = createMockCallback();

      await payForService.handler(
        runtime, createMockMessage("pay"), undefined, undefined, callback
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ error: true, text: expect.stringContaining("not initialized") })
      );
    });

    it("returns error when no budget account", async () => {
      const walletService = createMockWalletService({ budgetAccount: null });
      const runtime = createMockRuntime({
        services: { X402_WALLET: walletService },
        useModelReturn: '{"endpoint":"https://api.example.com"}',
      });
      const callback = createMockCallback();

      await payForService.handler(
        runtime, createMockMessage("pay"), undefined, undefined, callback
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ error: true, text: expect.stringContaining("Wallet not configured") })
      );
    });

    it("returns error on invalid LLM extraction", async () => {
      const walletService = createMockWalletService();
      const runtime = createMockRuntime({
        services: { X402_WALLET: walletService },
        useModelReturn: "not json at all",
      });
      const callback = createMockCallback();

      await payForService.handler(
        runtime, createMockMessage("pay"), undefined, undefined, callback
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ error: true, text: expect.stringContaining("Could not parse") })
      );
    });

    it("calls payForResource with correct params on success", async () => {
      const walletService = createMockWalletService();
      const runtime = createMockRuntime({
        services: { X402_WALLET: walletService },
        useModelReturn: JSON.stringify({
          endpoint: "https://api.example.com/data",
          method: "POST",
          body: '{"q":"test"}',
        }),
      });
      const callback = createMockCallback();

      await payForService.handler(
        runtime, createMockMessage("pay"), undefined, undefined, callback
      );

      expect(walletService.payForResource).toHaveBeenCalledWith(
        "https://api.example.com/data",
        expect.objectContaining({ method: "POST", body: '{"q":"test"}' })
      );
    });

    it("formats successful payment in callback", async () => {
      const walletService = createMockWalletService({
        payForResourceResult: {
          txHash: "5realTxHash",
          network: "eip155:8453",
          payer: "0xAgent",
          amountUsd: 0.05,
          receipt: { success: true },
          response: new Response("api response data", { status: 200 }),
        },
      });
      const runtime = createMockRuntime({
        services: { X402_WALLET: walletService },
        useModelReturn: '{"endpoint":"https://api.example.com"}',
      });
      const callback = createMockCallback();

      await payForService.handler(
        runtime, createMockMessage("pay"), undefined, undefined, callback
      );

      // Last call should be the success callback
      const calls = (callback as any).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.text).toContain("Access successful");
      expect(lastCall.text).toContain("5realTxHash");
      expect(lastCall.text).toContain("$0.0500");
      expect(lastCall.text).toContain("api response data");
    });

    it("handles payment failure gracefully", async () => {
      const walletService = createMockWalletService();
      walletService.payForResource.mockRejectedValue(new Error("Insufficient USDC balance"));
      const runtime = createMockRuntime({
        services: { X402_WALLET: walletService },
        useModelReturn: '{"endpoint":"https://api.example.com"}',
      });
      const callback = createMockCallback();

      await payForService.handler(
        runtime, createMockMessage("pay"), undefined, undefined, callback
      );

      const calls = (callback as any).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.error).toBe(true);
      expect(lastCall.text).toContain("Insufficient USDC balance");
    });

    it("truncates long responses to 500 chars", async () => {
      const longText = "x".repeat(1000);
      const walletService = createMockWalletService({
        payForResourceResult: {
          txHash: "tx1",
          amountUsd: 0.01,
          response: new Response(longText, { status: 200 }),
        },
      });
      const runtime = createMockRuntime({
        services: { X402_WALLET: walletService },
        useModelReturn: '{"endpoint":"https://api.example.com"}',
      });
      const callback = createMockCallback();

      await payForService.handler(
        runtime, createMockMessage("pay"), undefined, undefined, callback
      );

      const calls = (callback as any).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      // The response preview in content should be 500 chars max
      expect(lastCall.content.responsePreview.length).toBeLessThanOrEqual(500);
    });
  });
});
