import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";
import { DEFAULT_TEST_SETTINGS } from "../fixtures.js";

// Mock the Dexter SDK
vi.mock("@dexterai/x402/client", () => {
  const mockBudgetAccount = {
    fetch: vi.fn(async () => new Response("ok", { status: 200 })),
    get spent() { return "$0.00"; },
    get remaining() { return "$10.00"; },
    get payments() { return 0; },
    get spentAmount() { return 0; },
    get remainingAmount() { return 10; },
    get ledger() { return []; },
    get hourlySpend() { return 0; },
    reset: vi.fn(),
  };

  return {
    wrapFetch: vi.fn(() => vi.fn(async () => new Response("ok"))),
    createBudgetAccount: vi.fn(() => mockBudgetAccount),
    getPaymentReceipt: vi.fn(() => undefined),
    X402Error: class X402Error extends Error {
      code: string;
      constructor(code: string, message: string) {
        super(message);
        this.code = code;
      }
    },
  };
});

import { X402WalletService } from "../../src/services/x402WalletService.js";
import { wrapFetch, createBudgetAccount } from "@dexterai/x402/client";

describe("X402WalletService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("initialize()", () => {
    it("initializes with EVM key", async () => {
      const runtime = createMockRuntime({ settings: DEFAULT_TEST_SETTINGS });
      const service = await X402WalletService.start(runtime);

      expect(createBudgetAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          evmPrivateKey: DEFAULT_TEST_SETTINGS.EVM_PRIVATE_KEY,
        })
      );
      expect(service.getBudgetAccount()).not.toBeNull();
    });

    it("initializes with Solana key", async () => {
      const runtime = createMockRuntime({
        settings: {
          SOLANA_PRIVATE_KEY: "5abc123xyz",
          X402_NETWORK_ID: "solana-mainnet",
          X402_MAX_AUTO_PAY_USD: "0.10",
          X402_BUDGET_USD: "10.00",
        },
      });
      const service = await X402WalletService.start(runtime);

      expect(createBudgetAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          walletPrivateKey: "5abc123xyz",
          preferredNetwork: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        })
      );
      expect(service.getBudgetAccount()).not.toBeNull();
    });

    it("warns and disables payments when no wallet key set", async () => {
      const runtime = createMockRuntime({ settings: {} });
      const service = await X402WalletService.start(runtime);

      expect(runtime.logger.warn).toHaveBeenCalled();
      expect(service.getBudgetAccount()).toBeNull();
    });

    it("passes facilitator URL when set", async () => {
      const runtime = createMockRuntime({
        settings: {
          ...DEFAULT_TEST_SETTINGS,
          X402_FACILITATOR_URL: "https://custom.facilitator.com",
        },
      });
      await X402WalletService.start(runtime);

      expect(wrapFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          facilitatorUrl: "https://custom.facilitator.com",
        })
      );
    });

    it("configures access pass when tier is set", async () => {
      const runtime = createMockRuntime({
        settings: {
          ...DEFAULT_TEST_SETTINGS,
          X402_ACCESS_PASS_TIER: "1h",
          X402_ACCESS_PASS_MAX_SPEND: "2.00",
        },
      });
      await X402WalletService.start(runtime);

      expect(createBudgetAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          accessPass: { preferTier: "1h", maxSpend: "2.00", autoRenew: true },
        })
      );
    });

    it("maps network IDs to CAIP-2 correctly", async () => {
      const networks: Record<string, string> = {
        "base-mainnet": "eip155:8453",
        "base-sepolia": "eip155:84532",
        "polygon-mainnet": "eip155:137",
        "arbitrum-mainnet": "eip155:42161",
        "ethereum-mainnet": "eip155:1",
        "solana-mainnet": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      };

      for (const [friendly, caip2] of Object.entries(networks)) {
        vi.clearAllMocks();
        const runtime = createMockRuntime({
          settings: { ...DEFAULT_TEST_SETTINGS, X402_NETWORK_ID: friendly },
        });
        await X402WalletService.start(runtime);

        expect(createBudgetAccount).toHaveBeenCalledWith(
          expect.objectContaining({ preferredNetwork: caip2 })
        );
      }
    });

    it("prefers the first X402_NETWORKS entry over X402_NETWORK_ID", async () => {
      const runtime = createMockRuntime({
        settings: {
          ...DEFAULT_TEST_SETTINGS,
          X402_NETWORKS: "base-mainnet,solana-mainnet",
          X402_NETWORK_ID: "solana-mainnet",
        },
      });

      await X402WalletService.start(runtime);

      expect(createBudgetAccount).toHaveBeenCalledWith(
        expect.objectContaining({ preferredNetwork: "eip155:8453" })
      );
    });

    it("falls back to X402_NETWORK_ID when the first X402_NETWORKS entry is unknown", async () => {
      const runtime = createMockRuntime({
        settings: {
          ...DEFAULT_TEST_SETTINGS,
          X402_NETWORKS: "unknown-chain,base-mainnet",
          X402_NETWORK_ID: "solana-mainnet",
        },
      });

      await X402WalletService.start(runtime);

      expect(createBudgetAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          preferredNetwork: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        })
      );
    });
  });

  describe("payForResource()", () => {
    // Re-setup the mock before each payForResource test since mockReset clears it
    const setupBudgetMock = () => {
      const mockFetch = vi.fn(async () => new Response("ok", { status: 200 }));
      const mockBA = {
        fetch: mockFetch,
        get spent() { return "$0.00"; },
        get remaining() { return "$10.00"; },
        get payments() { return 0; },
        get spentAmount() { return 0; },
        get remainingAmount() { return 10; },
        get ledger() { return []; },
        get hourlySpend() { return 0; },
        reset: vi.fn(),
      };
      vi.mocked(createBudgetAccount).mockReturnValue(mockBA as any);
      vi.mocked(wrapFetch).mockReturnValue(vi.fn() as any);
      return { mockBA, mockFetch };
    };

    it("throws when no budget account", async () => {
      const runtime = createMockRuntime({ settings: {} });
      const service = await X402WalletService.start(runtime);

      await expect(service.payForResource("https://api.example.com")).rejects.toThrow(
        "no wallet key configured"
      );
    });

    it("passes method and body to fetch", async () => {
      const { mockFetch } = setupBudgetMock();
      const runtime = createMockRuntime({ settings: DEFAULT_TEST_SETTINGS });
      const service = await X402WalletService.start(runtime);

      await service.payForResource("https://api.example.com", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"query":"test"}',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"query":"test"}',
        })
      );
    });

    it("returns no-payment-required when no receipt", async () => {
      setupBudgetMock();
      const runtime = createMockRuntime({ settings: DEFAULT_TEST_SETTINGS });
      const service = await X402WalletService.start(runtime);

      const result = await service.payForResource("https://free.example.com");

      expect(result.txHash).toBe("no-payment-required");
      expect(result.amountUsd).toBe(0);
    });
  });

  describe("stop()", () => {
    it("clears state", async () => {
      const runtime = createMockRuntime({ settings: DEFAULT_TEST_SETTINGS });
      const service = await X402WalletService.start(runtime);

      expect(service.getBudgetAccount()).not.toBeNull();

      await service.stop();

      expect(service.getBudgetAccount()).toBeNull();
      expect(() => service.getX402Fetch()).toThrow();
    });
  });

  describe("getters", () => {
    it("returns empty history when no budget account", async () => {
      const runtime = createMockRuntime({ settings: {} });
      const service = await X402WalletService.start(runtime);

      expect(service.getPaymentHistory()).toEqual([]);
      expect(service.getTotalSpentUsd()).toBe(0);
      expect(service.getRemainingBudget()).toBe(0);
      expect(service.getHourlySpend()).toBe(0);
    });
  });
});
