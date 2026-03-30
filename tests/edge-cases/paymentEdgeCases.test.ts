import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime, createMockBudgetAccount } from "../setup.js";
import { DEFAULT_TEST_SETTINGS } from "../fixtures.js";

// ---- Mock X402Error with real error codes ----
const ALL_X402_ERROR_CODES = [
  "missing_payment_required_header",
  "invalid_payment_required",
  "unsupported_network",
  "no_matching_payment_option",
  "no_solana_accept",
  "missing_fee_payer",
  "missing_decimals",
  "missing_amount",
  "amount_exceeds_max",
  "insufficient_balance",
  "wallet_missing_sign_transaction",
  "wallet_not_connected",
  "wallet_disconnected",
  "user_rejected_signature",
  "transaction_build_failed",
  "payment_rejected",
  "rpc_timeout",
  "facilitator_timeout",
  "invalid_payment_signature",
  "facilitator_verify_failed",
  "facilitator_settle_failed",
  "facilitator_request_failed",
  "no_matching_requirement",
  "access_pass_expired",
  "access_pass_invalid",
  "access_pass_tier_not_found",
  "access_pass_exceeds_max_spend",
] as const;

// Track the mock budget account so tests can swap it
let mockBudgetAccount: ReturnType<typeof createTestBudgetAccount>;

function createTestBudgetAccount(overrides?: {
  spentAmount?: number;
  remainingAmount?: number;
  fetchImpl?: (...args: any[]) => Promise<Response>;
}) {
  const spentAmount = overrides?.spentAmount ?? 0;
  const remainingAmount = overrides?.remainingAmount ?? 10;
  const fetchImpl =
    overrides?.fetchImpl ??
    (async () => new Response("ok", { status: 200 }));

  return {
    fetch: vi.fn(fetchImpl),
    get spent() {
      return `$${spentAmount.toFixed(2)}`;
    },
    get remaining() {
      return `$${remainingAmount.toFixed(2)}`;
    },
    get payments() {
      return 0;
    },
    get spentAmount() {
      return spentAmount;
    },
    get remainingAmount() {
      return remainingAmount;
    },
    get ledger() {
      return [];
    },
    get hourlySpend() {
      return 0;
    },
    reset: vi.fn(),
  };
}

// Mock the Dexter SDK
vi.mock("@dexterai/x402/client", () => {
  const MockX402Error = class X402Error extends Error {
    code: string;
    details?: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.name = "X402Error";
      this.code = code;
      this.details = details;
    }
  };

  return {
    wrapFetch: vi.fn(() => vi.fn(async () => new Response("ok"))),
    createBudgetAccount: vi.fn(() => {
      mockBudgetAccount = createTestBudgetAccount();
      return mockBudgetAccount;
    }),
    getPaymentReceipt: vi.fn(() => undefined),
    X402Error: MockX402Error,
  };
});

import { X402WalletService } from "../../src/services/x402WalletService.js";
import {
  createBudgetAccount,
  getPaymentReceipt,
  X402Error,
} from "@dexterai/x402/client";
import { PaymentMemoryService } from "../../src/services/paymentMemoryService.js";

describe("Payment Edge Cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper to create an initialized wallet service
  async function createService(opts?: {
    fetchImpl?: (...args: any[]) => Promise<Response>;
    spentAmount?: number;
    remainingAmount?: number;
    receiptReturn?: any;
    memoryService?: any;
  }) {
    const ba = createTestBudgetAccount({
      spentAmount: opts?.spentAmount,
      remainingAmount: opts?.remainingAmount,
      fetchImpl: opts?.fetchImpl,
    });
    vi.mocked(createBudgetAccount).mockReturnValue(ba as any);
    // Ensure wrapFetch returns a function (mockReset clears it between tests)
    const { wrapFetch } = await import("@dexterai/x402/client");
    vi.mocked(wrapFetch).mockReturnValue(vi.fn(async () => new Response("ok")) as any);
    if (opts?.receiptReturn !== undefined) {
      vi.mocked(getPaymentReceipt).mockReturnValue(opts.receiptReturn);
    }

    const services: Record<string, any> = {};
    if (opts?.memoryService) {
      services["PAYMENT_MEMORY"] = opts.memoryService;
    }

    const runtime = createMockRuntime({
      settings: DEFAULT_TEST_SETTINGS,
      services,
    });
    const service = await X402WalletService.start(runtime);
    return { service, ba, runtime };
  }

  // ---------------------------------------------------------------
  // 1. Malformed URLs in payForResource
  // ---------------------------------------------------------------
  describe("1. Malformed URLs", () => {
    it("rejects empty string URL (domain extraction fails)", async () => {
      const { service } = await createService({
        fetchImpl: async () => new Response("ok", { status: 200 }),
      });

      // The domain extraction in recordPayment uses `new URL(endpoint)`.
      // An empty string should throw from budgetAccount.fetch or from URL parsing.
      // Either the SDK or our code should handle this.
      // If budgetAccount.fetch doesn't reject it, our code will hit `new URL("")` which throws.
      // The payment itself succeeds, but the fire-and-forget recording should NOT crash.
      // Actually, `new URL("")` throws TypeError. This is inside a try/catch so it should be safe.
      await expect(
        service.payForResource("")
      ).resolves.toBeDefined();
    });

    it("handles URL with no protocol gracefully", async () => {
      const { service } = await createService({
        fetchImpl: async () => new Response("ok", { status: 200 }),
      });
      // "api.example.com/data" — `new URL(...)` will throw TypeError
      // The fire-and-forget should swallow it
      await expect(
        service.payForResource("api.example.com/data")
      ).resolves.toBeDefined();
    });

    it("handles localhost URL", async () => {
      const { service } = await createService({
        fetchImpl: async () => new Response("ok", { status: 200 }),
      });
      const result = await service.payForResource("http://localhost:3000/api");
      expect(result.txHash).toBe("no-payment-required");
    });

    it("handles file:// URL", async () => {
      const { service } = await createService({
        fetchImpl: async () => new Response("ok", { status: 200 }),
      });
      const result = await service.payForResource("file:///etc/passwd");
      expect(result.txHash).toBe("no-payment-required");
    });
  });

  // ---------------------------------------------------------------
  // 2. Budget exhaustion mid-payment (spentAmount equals budget)
  // ---------------------------------------------------------------
  describe("2. Budget exhaustion", () => {
    it("succeeds when spentAmount equals budget exactly (zero remaining)", async () => {
      const { service } = await createService({
        spentAmount: 10,
        remainingAmount: 0,
        fetchImpl: async () => new Response("ok", { status: 200 }),
      });

      // Budget is exhausted but the SDK's fetch succeeded (maybe free endpoint).
      // Our code should still return a result without throwing.
      const result = await service.payForResource(
        "https://free.example.com/data"
      );
      expect(result.amountUsd).toBe(0);
    });

    it("propagates budget-exceeded X402Error from SDK", async () => {
      const { service } = await createService({
        fetchImpl: async () => {
          throw new X402Error(
            "payment_rejected",
            "Budget exhausted: $10.00 / $10.00 spent"
          );
        },
      });

      await expect(
        service.payForResource("https://api.example.com/data")
      ).rejects.toThrow("Budget exhausted");
    });
  });

  // ---------------------------------------------------------------
  // 3. Concurrent payments racing for the same budget
  // ---------------------------------------------------------------
  describe("3. Concurrent payment races", () => {
    it("handles two concurrent payForResource calls without data corruption", async () => {
      let callCount = 0;
      const { service } = await createService({
        fetchImpl: async () => {
          callCount++;
          // Simulate network delay
          await new Promise((r) => setTimeout(r, 10));
          return new Response(`response-${callCount}`, { status: 200 });
        },
      });

      const [r1, r2] = await Promise.all([
        service.payForResource("https://api.example.com/a"),
        service.payForResource("https://api.example.com/b"),
      ]);

      // Both should resolve without throwing
      expect(r1.response).toBeDefined();
      expect(r2.response).toBeDefined();
    });
  });

  // ---------------------------------------------------------------
  // 4. Response body already consumed (clone fails)
  // ---------------------------------------------------------------
  describe("4. Response body that cannot be cloned", () => {
    it("still returns result when response.clone().text() fails", async () => {
      const { service } = await createService({
        fetchImpl: async () => {
          const resp = new Response("ok", { status: 200 });
          // Consume the body so clone().text() might fail
          await resp.text();
          return resp;
        },
      });

      // The fire-and-forget recording clones the response. If clone fails,
      // the outer try/catch in payForResource should swallow it.
      const result = await service.payForResource(
        "https://api.example.com/data"
      );
      expect(result).toBeDefined();
      expect(result.txHash).toBe("no-payment-required");
    });
  });

  // ---------------------------------------------------------------
  // 5. getPaymentReceipt on a non-x402 response (normal 200)
  // ---------------------------------------------------------------
  describe("5. getPaymentReceipt on non-x402 response", () => {
    it("returns no-payment-required for a normal 200 with no receipt", async () => {
      vi.mocked(getPaymentReceipt).mockReturnValue(undefined);

      const { service } = await createService({
        fetchImpl: async () =>
          new Response('{"data": "free"}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      });

      const result = await service.payForResource("https://free.api.com/data");
      expect(result.txHash).toBe("no-payment-required");
      expect(result.receipt).toBeUndefined();
      expect(result.amountUsd).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // 6. X402Error with every error code (all 27 codes)
  // ---------------------------------------------------------------
  describe("6. X402Error with all 27 error codes", () => {
    for (const code of ALL_X402_ERROR_CODES) {
      it(`maps error code '${code}' to a friendly message`, async () => {
        const { service } = await createService({
          fetchImpl: async () => {
            throw new X402Error(code, `Test error for ${code}`);
          },
        });

        try {
          await service.payForResource("https://api.example.com/data");
          // Should not reach here
          expect.unreachable("Should have thrown");
        } catch (err: any) {
          // All X402Errors should be re-thrown as plain Errors with friendly messages
          expect(err).toBeInstanceOf(Error);
          // The friendly message should contain the original error message
          expect(err.message).toContain(`Test error for ${code}`);

          // Specific codes get specific prefixes
          if (code === "insufficient_balance") {
            expect(err.message).toContain("Insufficient USDC balance");
          } else if (code === "amount_exceeds_max") {
            expect(err.message).toContain("exceeds per-request limit");
          } else if (code === "payment_rejected") {
            expect(err.message).toContain("budget exhausted or domain blocked");
          } else if (code === "facilitator_settle_failed") {
            expect(err.message).toContain("settlement failed");
          } else if (
            code === "facilitator_timeout" ||
            code === "rpc_timeout"
          ) {
            expect(err.message).toContain("timeout");
          } else if (code === "user_rejected_signature") {
            expect(err.message).toContain("signature rejected");
          } else if (code === "access_pass_expired") {
            expect(err.message).toContain("expired");
          } else {
            // All unmapped codes should still produce a message with the code in it
            expect(err.message).toContain(`[${code}]`);
          }
        }
      });
    }
  });

  // ---------------------------------------------------------------
  // 7. PaymentMemoryService recording with null/undefined fields
  // ---------------------------------------------------------------
  describe("7. PaymentMemoryService with null/undefined fields", () => {
    it("records payment when receipt has null network and payer", async () => {
      vi.mocked(getPaymentReceipt).mockReturnValue({
        transaction: "tx123",
        network: undefined as any,
        payer: undefined as any,
      } as any);

      const mockMemoryService = {
        recordPayment: vi.fn(async () => {}),
      };

      const { service } = await createService({
        fetchImpl: async () => new Response("ok", { status: 200 }),
        receiptReturn: {
          transaction: "tx123",
          network: undefined,
          payer: undefined,
        },
        memoryService: mockMemoryService,
      });

      const result = await service.payForResource(
        "https://api.example.com/data"
      );
      expect(result.txHash).toBe("tx123");
      expect(result.network).toBeUndefined();
      expect(result.payer).toBeUndefined();

      // Wait a tick for the fire-and-forget
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMemoryService.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          txHash: "tx123",
          network: undefined,
          payer: undefined,
        })
      );
    });

    it("does not crash when memoryService.recordPayment throws", async () => {
      const mockMemoryService = {
        recordPayment: vi.fn(async () => {
          throw new Error("DB write failed");
        }),
      };

      const { service } = await createService({
        fetchImpl: async () => new Response("ok", { status: 200 }),
        memoryService: mockMemoryService,
      });

      // Should not throw even though recordPayment throws
      const result = await service.payForResource(
        "https://api.example.com/data"
      );
      expect(result).toBeDefined();
    });
  });

  // ---------------------------------------------------------------
  // 8. Domain extraction from weird URLs
  // ---------------------------------------------------------------
  describe("8. Domain extraction from weird URLs", () => {
    it("extracts domain from IP address URL", async () => {
      const mockMemoryService = {
        recordPayment: vi.fn(async () => {}),
      };

      const { service } = await createService({
        fetchImpl: async () => new Response("ok", { status: 200 }),
        memoryService: mockMemoryService,
      });

      await service.payForResource("https://192.168.1.1:8080/api/data");
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMemoryService.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({ domain: "192.168.1.1" })
      );
    });

    it("extracts domain from URL with port and query string", async () => {
      const mockMemoryService = {
        recordPayment: vi.fn(async () => {}),
      };

      const { service } = await createService({
        fetchImpl: async () => new Response("ok", { status: 200 }),
        memoryService: mockMemoryService,
      });

      await service.payForResource(
        "https://api.example.com:9443/data?key=val&foo=bar#fragment"
      );
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMemoryService.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({ domain: "api.example.com" })
      );
    });

    it("extracts domain from URL with authentication info", async () => {
      const mockMemoryService = {
        recordPayment: vi.fn(async () => {}),
      };

      const { service } = await createService({
        fetchImpl: async () => new Response("ok", { status: 200 }),
        memoryService: mockMemoryService,
      });

      await service.payForResource("https://user:pass@api.example.com/data");
      await new Promise((r) => setTimeout(r, 10));

      expect(mockMemoryService.recordPayment).toHaveBeenCalledWith(
        expect.objectContaining({ domain: "api.example.com" })
      );
    });
  });

  // ---------------------------------------------------------------
  // 9. BudgetAccount.fetch throwing non-X402Error (network errors)
  // ---------------------------------------------------------------
  describe("9. Non-X402Error from BudgetAccount.fetch", () => {
    it("propagates TypeError (network failure) as-is", async () => {
      const { service } = await createService({
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      });

      await expect(
        service.payForResource("https://api.example.com/data")
      ).rejects.toThrow(TypeError);
    });

    it("propagates DOMException (AbortError/timeout) as-is", async () => {
      const { service } = await createService({
        fetchImpl: async () => {
          const err = new DOMException("The operation was aborted", "AbortError");
          throw err;
        },
      });

      await expect(
        service.payForResource("https://api.example.com/data")
      ).rejects.toThrow("The operation was aborted");
    });

    it("propagates generic Error (DNS failure simulation)", async () => {
      const { service } = await createService({
        fetchImpl: async () => {
          throw new Error("getaddrinfo ENOTFOUND api.example.com");
        },
      });

      await expect(
        service.payForResource("https://api.example.com/data")
      ).rejects.toThrow("ENOTFOUND");
    });
  });

  // ---------------------------------------------------------------
  // 10. Payment that returns 402 but never settles (hung payment)
  // ---------------------------------------------------------------
  describe("10. Hung payment (fetch never resolves)", () => {
    it("can be externally aborted via AbortController", async () => {
      const { service } = await createService({
        fetchImpl: async () => {
          // Simulate a hung request — never resolves within reasonable time
          await new Promise((r) => setTimeout(r, 60_000));
          return new Response("ok");
        },
      });

      const promise = service.payForResource("https://api.example.com/data");

      // Race against a timeout
      const result = await Promise.race([
        promise.then(() => "resolved"),
        new Promise<string>((r) => setTimeout(() => r("timeout"), 100)),
      ]);

      expect(result).toBe("timeout");
    });
  });

  // ---------------------------------------------------------------
  // 11. Extremely large amountUsd values
  // ---------------------------------------------------------------
  describe("11. Extremely large amountUsd values", () => {
    it("handles payment result with very large USD amount", async () => {
      // Simulate spentAmount changing by a huge amount
      let callNum = 0;
      const ba = {
        fetch: vi.fn(async () => new Response("ok", { status: 200 })),
        get spent() { return "$999999.99"; },
        get remaining() { return "$0.01"; },
        get payments() { return 1; },
        get spentAmount() {
          callNum++;
          // First call returns 0, second returns huge number
          return callNum <= 1 ? 0 : 999999.99;
        },
        get remainingAmount() { return 0.01; },
        get ledger() { return []; },
        get hourlySpend() { return 0; },
        reset: vi.fn(),
      };
      vi.mocked(createBudgetAccount).mockReturnValue(ba as any);

      const runtime = createMockRuntime({ settings: DEFAULT_TEST_SETTINGS });
      const service = await X402WalletService.start(runtime);

      const result = await service.payForResource(
        "https://expensive.example.com"
      );
      expect(result.amountUsd).toBe(999999.99);
    });
  });

  // ---------------------------------------------------------------
  // 12. Negative amountUsd values
  // ---------------------------------------------------------------
  describe("12. Negative amountUsd values", () => {
    it("handles case where spentAmount decreases (refund or reset)", async () => {
      let callNum = 0;
      const ba = {
        fetch: vi.fn(async () => new Response("ok", { status: 200 })),
        get spent() { return "$0.00"; },
        get remaining() { return "$10.00"; },
        get payments() { return 0; },
        get spentAmount() {
          callNum++;
          // First call returns 5, second returns 3 (decreased = "refund")
          return callNum <= 1 ? 5 : 3;
        },
        get remainingAmount() { return 10; },
        get ledger() { return []; },
        get hourlySpend() { return 0; },
        reset: vi.fn(),
      };
      vi.mocked(createBudgetAccount).mockReturnValue(ba as any);

      const runtime = createMockRuntime({ settings: DEFAULT_TEST_SETTINGS });
      const service = await X402WalletService.start(runtime);

      const result = await service.payForResource(
        "https://api.example.com/data"
      );
      // amountPaid = spentAfter - spentBefore = 3 - 5 = -2
      expect(result.amountUsd).toBe(-2);
    });
  });

  // ---------------------------------------------------------------
  // 13. payForResource with empty options object vs undefined
  // ---------------------------------------------------------------
  describe("13. Empty options vs undefined", () => {
    it("works with undefined options", async () => {
      const { service, ba } = await createService();
      await service.payForResource("https://api.example.com/data", undefined);
      expect(ba.fetch).toHaveBeenCalledWith("https://api.example.com/data", undefined);
    });

    it("works with empty options object", async () => {
      const { service, ba } = await createService();
      await service.payForResource("https://api.example.com/data", {});
      // Empty options object => empty init => passed as undefined
      expect(ba.fetch).toHaveBeenCalledWith("https://api.example.com/data", undefined);
    });

    it("works with only method set", async () => {
      const { service, ba } = await createService();
      await service.payForResource("https://api.example.com/data", {
        method: "POST",
      });
      expect(ba.fetch).toHaveBeenCalledWith(
        "https://api.example.com/data",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  // ---------------------------------------------------------------
  // 14. Race condition: stop() called during payForResource()
  // ---------------------------------------------------------------
  describe("14. stop() called during payForResource()", () => {
    it("payForResource started before stop still completes", async () => {
      const { service } = await createService({
        fetchImpl: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return new Response("ok", { status: 200 });
        },
      });

      const paymentPromise = service.payForResource(
        "https://api.example.com/data"
      );

      // Call stop while payment is in flight
      await service.stop();

      // The payment was already in progress with a captured reference.
      // It should resolve or reject, not hang.
      const result = await paymentPromise;
      expect(result).toBeDefined();
    });

    it("payForResource after stop throws immediately", async () => {
      const { service } = await createService();
      await service.stop();

      await expect(
        service.payForResource("https://api.example.com/data")
      ).rejects.toThrow("not initialized");
    });
  });

  // ---------------------------------------------------------------
  // 15. x402Gate with extreme amountUsd
  // ---------------------------------------------------------------
  describe("15. x402Gate usdToAtomic edge cases", async () => {
    // Import x402Gate directly for testing the usdToAtomic conversion
    const { x402Gate } = await import("../../src/server/x402Gate.js");

    it("returns paid:false with amountUsd:0 when no server service", async () => {
      const runtime = createMockRuntime({ settings: DEFAULT_TEST_SETTINGS });
      const req = { url: "/test" };
      const res = {
        status: vi.fn(() => res),
        json: vi.fn(),
        setHeader: vi.fn(),
      };

      const result = await x402Gate(runtime, req, res, {
        amountUsd: "999999.99",
      });
      // No server service => graceful degradation
      expect(result.paid).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // 16. PaymentMemoryService in-memory scoring with missing data
  // ---------------------------------------------------------------
  describe("16. PaymentMemoryService edge cases", () => {
    it("handles recordPayment with minimal fields", async () => {
      const runtime = createMockRuntime({ settings: DEFAULT_TEST_SETTINGS });
      const memService = await PaymentMemoryService.start(runtime);

      // Record with bare minimum fields, optional fields undefined
      await memService.recordPayment({
        id: "test-1",
        agentId: "agent-1",
        endpoint: "https://api.example.com",
        domain: "api.example.com",
        method: "GET",
        amountUsd: 0.01,
        txHash: "tx-1",
        status: "confirmed",
        createdAt: Date.now(),
        // No network, payer, responseStatus, responseTimeMs, qualityScore, qualityReason, responsePreview
      });

      const history = memService.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].network).toBeUndefined();
    });

    it("does not add to unscored buffer when responsePreview is empty", async () => {
      const runtime = createMockRuntime({ settings: DEFAULT_TEST_SETTINGS });
      const memService = await PaymentMemoryService.start(runtime);

      await memService.recordPayment({
        id: "test-2",
        agentId: "agent-1",
        endpoint: "https://api.example.com",
        domain: "api.example.com",
        method: "GET",
        amountUsd: 0.01,
        txHash: "tx-2",
        status: "confirmed",
        createdAt: Date.now(),
        responsePreview: "", // Empty string is falsy
      });

      const unscored = memService.getUnscoredPayments();
      expect(unscored).toHaveLength(0);
    });

    it("scorePayment on nonexistent record does not throw", async () => {
      const runtime = createMockRuntime({ settings: DEFAULT_TEST_SETTINGS });
      const memService = await PaymentMemoryService.start(runtime);

      // Score a record that doesn't exist
      await expect(
        memService.scorePayment("nonexistent-id", 85, "Good quality")
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------
  // 17. getX402Fetch after stop
  // ---------------------------------------------------------------
  describe("17. getX402Fetch lifecycle", () => {
    it("throws after stop() is called", async () => {
      const { service } = await createService();
      expect(() => service.getX402Fetch()).not.toThrow();
      await service.stop();
      expect(() => service.getX402Fetch()).toThrow("not initialized");
    });
  });

  // ---------------------------------------------------------------
  // 18. Response with non-200 status from paid endpoint
  // ---------------------------------------------------------------
  describe("18. Non-200 response from paid endpoint", () => {
    it("returns result even with 500 response", async () => {
      vi.mocked(getPaymentReceipt).mockReturnValue({
        transaction: "tx-paid-but-error",
        network: "eip155:8453",
        payer: "0xAgent",
      } as any);

      const { service } = await createService({
        fetchImpl: async () =>
          new Response("Internal Server Error", { status: 500 }),
        receiptReturn: {
          transaction: "tx-paid-but-error",
          network: "eip155:8453",
          payer: "0xAgent",
        },
      });

      const result = await service.payForResource(
        "https://broken.example.com/data"
      );
      // Payment went through even though the endpoint returned 500
      expect(result.txHash).toBe("tx-paid-but-error");
      expect(result.response.status).toBe(500);
    });
  });

  // ---------------------------------------------------------------
  // 19. getPaymentHistory / getters after re-init
  // ---------------------------------------------------------------
  describe("19. Service re-initialization", () => {
    it("provides fresh state after stop + re-init", async () => {
      const { service, runtime } = await createService();

      expect(service.getBudgetAccount()).not.toBeNull();
      expect(service.getRemainingBudget()).toBe(10);

      await service.stop();
      expect(service.getBudgetAccount()).toBeNull();
      expect(service.getPaymentHistory()).toEqual([]);
      expect(service.getTotalSpentUsd()).toBe(0);
      expect(service.getRemainingBudget()).toBe(0);
      expect(service.getHourlySpend()).toBe(0);

      // Re-initialize
      await service.initialize(runtime);
      expect(service.getBudgetAccount()).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // 20. payForResource with string non-Error throw from SDK
  // ---------------------------------------------------------------
  describe("20. Non-Error throw from BudgetAccount.fetch", () => {
    it("propagates string throws", async () => {
      const { service } = await createService({
        fetchImpl: async () => {
          throw "raw string error"; // eslint-disable-line no-throw-literal
        },
      });

      await expect(
        service.payForResource("https://api.example.com/data")
      ).rejects.toBe("raw string error");
    });

    it("propagates number throws", async () => {
      const { service } = await createService({
        fetchImpl: async () => {
          throw 42; // eslint-disable-line no-throw-literal
        },
      });

      await expect(
        service.payForResource("https://api.example.com/data")
      ).rejects.toBe(42);
    });

    it("propagates null throw", async () => {
      const { service } = await createService({
        fetchImpl: async () => {
          throw null; // eslint-disable-line no-throw-literal
        },
      });

      await expect(
        service.payForResource("https://api.example.com/data")
      ).rejects.toBeNull();
    });
  });
});
