import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime, createMockMessage } from "../setup.js";
import { x402ServerProvider } from "../../src/providers/x402ServerProvider.js";

/**
 * Create a mock X402ServerService for provider tests.
 */
function createMockServerService(overrides?: {
  available?: boolean;
  receiveAddress?: string;
  network?: string;
  totalRevenue?: number;
  settlementCount?: number;
  revenueHistory?: Array<{
    endpoint: string;
    amountUsd: number;
    txHash: string;
    network: string;
    payer: string;
    timestamp: number;
  }>;
}) {
  const available = overrides?.available ?? true;
  return {
    isAvailable: vi.fn(() => available),
    getReceiveAddress: vi.fn(() => overrides?.receiveAddress ?? "0xabc123"),
    getNetwork: vi.fn(() => overrides?.network ?? "eip155:84532"),
    getTotalRevenueUsd: vi.fn(() => overrides?.totalRevenue ?? 0),
    getSettlementCount: vi.fn(() => overrides?.settlementCount ?? 0),
    getRevenueHistory: vi.fn(() => overrides?.revenueHistory ?? []),
  };
}

describe("x402ServerProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'Not configured' text when service not available", async () => {
    const runtime = createMockRuntime({ services: {} });
    const message = createMockMessage("test");
    const state = { values: {}, data: {}, text: "" } as any;

    const result = await x402ServerProvider.get(runtime, message, state);

    expect(result.text).toContain("Not configured");
  });

  it("returns 'Not configured' when service available but isAvailable is false", async () => {
    const serverService = createMockServerService({ available: false });
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    const message = createMockMessage("test");
    const state = { values: {}, data: {}, text: "" } as any;

    const result = await x402ServerProvider.get(runtime, message, state);

    expect(result.text).toContain("Not configured");
  });

  it("returns revenue context with address, network, and settlements when configured", async () => {
    const serverService = createMockServerService({
      available: true,
      receiveAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      network: "eip155:84532",
      totalRevenue: 0.15,
      settlementCount: 3,
      revenueHistory: [
        {
          endpoint: "/x402/research",
          amountUsd: 0.05,
          txHash: "0xabc123def456789",
          network: "eip155:84532",
          payer: "0xuser1",
          timestamp: Date.now() - 60000,
        },
        {
          endpoint: "/x402/analyze",
          amountUsd: 0.03,
          txHash: "0xdef456abc789012",
          network: "eip155:84532",
          payer: "0xuser2",
          timestamp: Date.now() - 30000,
        },
      ],
    });
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    const message = createMockMessage("test");
    const state = { values: {}, data: {}, text: "" } as any;

    const result = await x402ServerProvider.get(runtime, message, state);

    expect(result.text).toContain("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(result.text).toContain("eip155:84532");
    expect(result.text).toContain("$0.1500");
    expect(result.text).toContain("3");
    expect(result.text).toContain("/x402/research");
    expect(result.text).toContain("0xuser1");
  });

  it("shows 'None yet' when no revenue history", async () => {
    const serverService = createMockServerService({
      available: true,
      totalRevenue: 0,
      settlementCount: 0,
      revenueHistory: [],
    });
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    const message = createMockMessage("test");
    const state = { values: {}, data: {}, text: "" } as any;

    const result = await x402ServerProvider.get(runtime, message, state);

    expect(result.text).toContain("None yet");
  });
});
