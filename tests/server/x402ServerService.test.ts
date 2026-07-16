import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";

// Mock the Dexter server SDK
vi.mock("@dexterai/x402/server", () => {
  return {
    createX402Server: vi.fn(),
  };
});

import { createX402Server } from "@dexterai/x402/server";
import { X402ServerService } from "../../src/server/x402ServerService.js";

describe("X402ServerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createX402Server).mockImplementation(({ network }) => ({
      buildRequirements: vi.fn(async () => ({
        x402Version: 2,
        resource: "r",
        accepts: [{ network }],
      })),
      encodeRequirements: vi.fn(() => ""),
      getPaymentAccept: vi.fn(async () => ({})),
      verifyPayment: vi.fn(async () => ({ isValid: true })),
      settlePayment: vi.fn(async () => ({
        success: true,
        transaction: "0x123",
      })),
      network: network ?? "",
    }) as ReturnType<typeof createX402Server>);
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
    expect(service.getServer()).toBe(
      vi.mocked(createX402Server).mock.results[0].value
    );
  });

  it("no receive address — isAvailable false", async () => {
    const runtime = createMockRuntime({ settings: {} });

    const service = await X402ServerService.start(runtime);

    expect(service.isAvailable()).toBe(false);
    expect(service.getReceiveAddress()).toBe("");
    expect(service.getNetwork()).toBe("");
    expect(() => service.getPrimaryNetwork()).toThrow(
      "X402 server not initialized — set X402_RECEIVE_ADDRESS"
    );
  });

  it("initializes and merges requirements for multiple networks in priority order", async () => {
    const evmPayTo = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const solanaPayTo = "7YttLkHDoNj9wyDur5hY5b9usVwPdWq7KZPUVXmN7Rrf";
    const solanaCaip2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    const facilitatorUrl = "https://facilitator.example.com";
    const runtime = createMockRuntime({
      settings: {
        X402_NETWORKS: "base-mainnet,solana-mainnet,arbitrum-mainnet",
        X402_RECEIVE_ADDRESS_EVM: evmPayTo,
        X402_RECEIVE_ADDRESS_SOLANA: solanaPayTo,
        X402_FACILITATOR_URL: facilitatorUrl,
      },
    });

    const service = await X402ServerService.start(runtime);
    const servers = vi.mocked(createX402Server).mock.results.map(
      (result) => result.value
    );

    expect(service.getNetworks()).toEqual([
      {
        friendlyId: "base-mainnet",
        caip2: "eip155:8453",
        kind: "evm",
        payTo: evmPayTo,
      },
      {
        friendlyId: "solana-mainnet",
        caip2: solanaCaip2,
        kind: "solana",
        payTo: solanaPayTo,
      },
      {
        friendlyId: "arbitrum-mainnet",
        caip2: "eip155:42161",
        kind: "evm",
        payTo: evmPayTo,
      },
    ]);
    expect(service.getPrimaryNetwork()).toEqual(service.getNetworks()[0]);
    expect(service.getServerFor(solanaCaip2)).toBe(servers[1]);
    expect(service.getServerFor("eip155:999")).toBeUndefined();
    expect(service.getPayToFor("eip155:8453")).toBe(evmPayTo);
    expect(service.getPayToFor(solanaCaip2)).toBe(solanaPayTo);
    expect(service.getPayToFor("eip155:999")).toBeUndefined();
    expect(service.getServer()).toBe(servers[0]);
    expect(service.getNetwork()).toBe("eip155:8453");
    expect(service.getReceiveAddress()).toBe(evmPayTo);
    expect(vi.mocked(createX402Server)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(createX402Server)).toHaveBeenNthCalledWith(1, {
      payTo: evmPayTo,
      network: "eip155:8453",
      facilitatorUrl,
    });
    expect(vi.mocked(createX402Server)).toHaveBeenNthCalledWith(2, {
      payTo: solanaPayTo,
      network: solanaCaip2,
      facilitatorUrl,
    });
    expect(vi.mocked(createX402Server)).toHaveBeenNthCalledWith(3, {
      payTo: evmPayTo,
      network: "eip155:42161",
      facilitatorUrl,
    });

    await expect(
      service.buildAllRequirements({
        amountAtomic: "50000",
        resourceUrl: "https://swarmx.io/api/research",
        description: "Research task",
      })
    ).resolves.toEqual({
      x402Version: 2,
      resource: "r",
      accepts: [
        { network: "eip155:8453" },
        { network: solanaCaip2 },
        { network: "eip155:42161" },
      ],
    });
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
