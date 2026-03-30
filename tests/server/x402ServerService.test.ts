import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";
import { DEFAULT_TEST_SETTINGS } from "../fixtures.js";

// Mock the Dexter server SDK
vi.mock("@dexterai/x402/server", () => {
  const mockServer = {
    buildRequirements: vi.fn(async () => ({})),
    encodeRequirements: vi.fn(() => ""),
    getPaymentAccept: vi.fn(async () => ({})),
    verifyPayment: vi.fn(async () => ({ isValid: true })),
    settlePayment: vi.fn(async () => ({ success: true, transaction: "0x123" })),
  };

  return {
    createX402Server: vi.fn(() => mockServer),
  };
});

import { X402ServerService } from "../../src/server/x402ServerService.js";

describe("X402ServerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes with X402_RECEIVE_ADDRESS set — isAvailable true", async () => {
    const runtime = createMockRuntime({
      settings: {
        X402_RECEIVE_ADDRESS: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        X402_NETWORK_ID: "base-sepolia",
      },
    });

    const service = await X402ServerService.start(runtime);

    expect(service.isAvailable()).toBe(true);
    expect(service.getReceiveAddress()).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(service.getNetwork()).toBe("eip155:84532");
  });

  it("no receive address — isAvailable false", async () => {
    const runtime = createMockRuntime({ settings: {} });

    const service = await X402ServerService.start(runtime);

    expect(service.isAvailable()).toBe(false);
    expect(service.getReceiveAddress()).toBe("");
  });

  it("recordRevenue tracks payments", async () => {
    const runtime = createMockRuntime({
      settings: { X402_RECEIVE_ADDRESS: "0xabc" },
    });
    const service = await X402ServerService.start(runtime);

    service.recordRevenue({
      endpoint: "/api/chat",
      amountUsd: 0.05,
      txHash: "0x111",
      network: "eip155:84532",
      payer: "0xuser1",
      timestamp: 1000,
    });

    service.recordRevenue({
      endpoint: "/api/search",
      amountUsd: 0.10,
      txHash: "0x222",
      network: "eip155:84532",
      payer: "0xuser2",
      timestamp: 2000,
    });

    const history = service.getRevenueHistory();
    expect(history).toHaveLength(2);
    expect(history[0].endpoint).toBe("/api/chat");
    expect(history[1].amountUsd).toBe(0.10);
  });

  it("getTotalRevenueUsd sums correctly", async () => {
    const runtime = createMockRuntime({
      settings: { X402_RECEIVE_ADDRESS: "0xabc" },
    });
    const service = await X402ServerService.start(runtime);

    service.recordRevenue({
      endpoint: "/api/a",
      amountUsd: 0.05,
      txHash: "0x1",
      network: "eip155:84532",
      payer: "0xp1",
      timestamp: 1000,
    });
    service.recordRevenue({
      endpoint: "/api/b",
      amountUsd: 0.03,
      txHash: "0x2",
      network: "eip155:84532",
      payer: "0xp2",
      timestamp: 2000,
    });
    service.recordRevenue({
      endpoint: "/api/c",
      amountUsd: 0.02,
      txHash: "0x3",
      network: "eip155:84532",
      payer: "0xp3",
      timestamp: 3000,
    });

    expect(service.getTotalRevenueUsd()).toBeCloseTo(0.10, 5);
  });

  it("getSettlementCount matches history length", async () => {
    const runtime = createMockRuntime({
      settings: { X402_RECEIVE_ADDRESS: "0xabc" },
    });
    const service = await X402ServerService.start(runtime);

    expect(service.getSettlementCount()).toBe(0);

    service.recordRevenue({
      endpoint: "/api/a",
      amountUsd: 0.01,
      txHash: "0x1",
      network: "eip155:84532",
      payer: "0xp1",
      timestamp: 1000,
    });
    service.recordRevenue({
      endpoint: "/api/b",
      amountUsd: 0.02,
      txHash: "0x2",
      network: "eip155:84532",
      payer: "0xp2",
      timestamp: 2000,
    });

    expect(service.getSettlementCount()).toBe(2);
    expect(service.getSettlementCount()).toBe(service.getRevenueHistory().length);
  });
});
