import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime, createMockMessage, createMockWalletService, createMockBudgetAccount } from "../setup.js";
import { MOCK_LEDGER } from "../fixtures.js";
import { x402Provider } from "../../src/providers/x402Provider.js";

describe("x402Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not initialized when no wallet service", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("test");
    const state = { values: {}, data: {}, text: "" } as any;

    const result = await x402Provider.get(runtime, message, state);

    expect(result.text).toContain("not initialized");
  });

  it("returns full context with wallet data", async () => {
    const budgetAccount = createMockBudgetAccount({
      spentAmount: 1.5,
      remainingAmount: 8.5,
      payments: 12,
      ledger: MOCK_LEDGER,
      hourlySpend: 0.3,
    });
    const walletService = createMockWalletService({
      budgetAccount,
      paymentHistory: MOCK_LEDGER,
      hourlySpend: 0.3,
    });
    const runtime = createMockRuntime({ services: { X402_WALLET: walletService } });
    const message = createMockMessage("test");
    const state = { values: {}, data: {}, text: "" } as any;

    const result = await x402Provider.get(runtime, message, state);

    expect(result.text).toContain("base-sepolia");
    expect(result.text).toContain("$0.1");
    expect(result.text).toContain("$8.50");
    expect(result.text).toContain("12");
  });

  it("shows only last 3 payments", async () => {
    const walletService = createMockWalletService({
      paymentHistory: MOCK_LEDGER,
      hourlySpend: 0,
    });
    const runtime = createMockRuntime({ services: { X402_WALLET: walletService } });
    const message = createMockMessage("test");
    const state = { values: {}, data: {}, text: "" } as any;

    const result = await x402Provider.get(runtime, message, state);

    expect(result.text).toContain("api.exa.ai");
    expect(result.text).toContain("oracle.io");
  });

  it("shows None yet for empty history", async () => {
    const walletService = createMockWalletService({ paymentHistory: [], hourlySpend: 0 });
    const runtime = createMockRuntime({ services: { X402_WALLET: walletService } });
    const message = createMockMessage("test");
    const state = { values: {}, data: {}, text: "" } as any;

    const result = await x402Provider.get(runtime, message, state);

    expect(result.text).toContain("None yet");
  });

  it("shows access pass status when configured", async () => {
    const walletService = createMockWalletService({
      config: { accessPassTier: "1h" },
      hourlySpend: 0,
    });
    const runtime = createMockRuntime({ services: { X402_WALLET: walletService } });
    const message = createMockMessage("test");
    const state = { values: {}, data: {}, text: "" } as any;

    const result = await x402Provider.get(runtime, message, state);

    expect(result.text).toContain("1h tier");
  });

  it("shows spending history when PaymentMemoryService has data", async () => {
    const mockMemoryService = {
      getSpendingStats: vi.fn((period: string) => {
        if (period === "24h") return { totalSpent: 0.50, totalCalls: 10, period };
        if (period === "7d") return { totalSpent: 2.50, totalCalls: 50, period };
        return { totalSpent: 8.00, totalCalls: 150, period };
      }),
      getEndpointScoreSummary: vi.fn(() => [
        { domain: "api.exa.ai", avgQuality: 4.5, avgCostPerCall: 0.05, totalCalls: 30 },
        { domain: "oracle.io", avgQuality: 3.0, avgCostPerCall: 0.10, totalCalls: 20 },
      ]),
    };

    const walletService = createMockWalletService({ hourlySpend: 0.1 });
    const runtime = createMockRuntime({
      services: {
        X402_WALLET: walletService,
        PAYMENT_MEMORY: mockMemoryService,
      },
    });
    const message = createMockMessage("test");
    const state = { values: {}, data: {}, text: "" } as any;

    const result = await x402Provider.get(runtime, message, state);

    expect(result.text).toContain("Last 24h: $0.50 across 10 calls");
    expect(result.text).toContain("Last 7d: $2.50 across 50 calls");
    expect(result.text).toContain("Last 30d: $8.00 across 150 calls");
    expect(result.text).toContain("Best Value Endpoints");
    expect(result.text).toContain("api.exa.ai");
    expect(result.text).toContain("quality 4.5/5");
  });
});
