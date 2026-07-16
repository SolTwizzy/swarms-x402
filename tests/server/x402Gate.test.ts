import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";
import { x402Gate } from "../../src/server/x402Gate.js";

const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

function createMockPaymentServer(overrides?: {
  verifyValid?: boolean;
  settleSuccess?: boolean;
  settleTransaction?: string;
  settleNetwork?: string;
}) {
  return {
    buildRequirements: vi.fn(async () => ({ type: "x402", amount: "50000" })),
    encodeRequirements: vi.fn(() => "encoded-requirements"),
    getPaymentAccept: vi.fn(async () => ({ type: "accept", amount: "50000" })),
    verifyPayment: vi.fn(async () => ({ isValid: overrides?.verifyValid ?? true })),
    settlePayment: vi.fn(async () => ({
      success: overrides?.settleSuccess ?? true,
      transaction: overrides?.settleTransaction ?? "0xabc123",
      network: overrides?.settleNetwork ?? "eip155:84532",
    })),
  };
}

/**
 * Create a mock X402ServerService with controllable behavior.
 */
function createMockServerService(overrides?: {
  available?: boolean;
  verifyValid?: boolean;
  settleSuccess?: boolean;
  settleTransaction?: string;
  settleNetwork?: string;
  requirementsAccepts?: object[];
  servers?: Record<string, ReturnType<typeof createMockPaymentServer>>;
}) {
  const available = overrides?.available ?? true;
  const mockServer = createMockPaymentServer(overrides);
  const requirements = {
    x402Version: 2,
    resource: { url: "/api/test" },
    accepts: overrides?.requirementsAccepts ?? [
      { type: "x402", amount: "50000" },
    ],
  };

  return {
    isAvailable: vi.fn(() => available),
    getServer: vi.fn(() => mockServer),
    getServerFor: vi.fn((network: string) => overrides?.servers?.[network]),
    buildAllRequirements: vi.fn(async () => requirements),
    getNetwork: vi.fn(() => "eip155:84532"),
    getReceiveAddress: vi.fn(() => "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
    recordRevenue: vi.fn(),
    mockServer,
    requirements,
  };
}

function encodePaymentHeader(network: string): string {
  return Buffer.from(JSON.stringify({ accepted: { network } })).toString("base64");
}

function createMockRes() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(),
    setHeader: vi.fn(),
  };
  return res;
}

describe("x402Gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns paid:false and sends 402 when no payment header", async () => {
    const serverService = createMockServerService();
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    const req = { headers: {}, url: "/api/test", method: "GET" };
    const res = createMockRes();

    const result = await x402Gate(runtime, req, res, {
      amountUsd: "0.05",
      description: "Test endpoint",
    });

    expect(result.paid).toBe(false);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Payment required",
        amount: "0.05",
      })
    );
    expect(res.setHeader).toHaveBeenCalledWith("PAYMENT-REQUIRED", "encoded-requirements");
  });

  it("sends 402 (not free tier) to discovery probes with an empty body", async () => {
    const serverService = createMockServerService();
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    // x402scan/Bazaar probe shape: no payment header, empty JSON body
    const req = { headers: {}, url: "/api/test", method: "POST", body: {} };
    const res = createMockRes();

    const result = await x402Gate(runtime, req, res, {
      amountUsd: "0.05",
      freeTierEnabled: true,
    });

    expect(result.paid).toBe(false);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        x402Version: 1,
        accepts: [expect.objectContaining({ type: "x402", amount: "50000" })],
      })
    );
  });

  it("advertises merged network accepts in priority order", async () => {
    const mergedAccepts = [
      { scheme: "exact", network: "eip155:8453", asset: "0xBaseUSDC" },
      { scheme: "exact", network: SOLANA_CAIP2, asset: "SolanaUSDC" },
      { scheme: "exact", network: "eip155:42161", asset: "0xArbitrumUSDC" },
    ];
    const serverService = createMockServerService({
      requirementsAccepts: mergedAccepts,
    });
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    const req = { headers: {}, url: "/api/test", method: "GET" };
    const res = createMockRes();

    await x402Gate(runtime, req, res, {
      amountUsd: "0.05",
      description: "Test endpoint",
    });

    expect(serverService.buildAllRequirements).toHaveBeenCalledWith({
      amountAtomic: "50000",
      resourceUrl: "/api/test",
      description: "Test endpoint",
    });
    expect(serverService.mockServer.encodeRequirements).toHaveBeenCalledWith(
      serverService.requirements
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        network: "eip155:84532",
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        accepts: [
          expect.objectContaining({ network: "eip155:8453" }),
          expect.objectContaining({ network: SOLANA_CAIP2 }),
          expect.objectContaining({ network: "eip155:42161" }),
        ],
      })
    );
  });

  it("grants free tier to unpaid requests that carry a real body", async () => {
    const serverService = createMockServerService();
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    const req = {
      headers: { "x-forwarded-for": "203.0.113.7" },
      url: "/api/test",
      method: "POST",
      body: { query: "real user input" },
    };
    const res = createMockRes();

    const result = await x402Gate(runtime, req, res, {
      amountUsd: "0.05",
      freeTierEnabled: true,
    });

    expect(result.paid).toBe(true);
    expect(result.amountUsd).toBe(0);
    expect(result.freeRemaining).toBeGreaterThanOrEqual(0);
    expect(res.status).not.toHaveBeenCalledWith(402);
  });

  it("keeps extraAccepts before all merged network entries", async () => {
    const serverService = createMockServerService({
      requirementsAccepts: [
        { scheme: "exact", network: "eip155:8453", asset: "0xBaseUSDC" },
        { scheme: "exact", network: SOLANA_CAIP2, asset: "SolanaUSDC" },
        { scheme: "exact", network: "eip155:42161", asset: "0xArbitrumUSDC" },
      ],
    });
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    const req = { headers: {}, url: "/api/test", method: "GET" };
    const res = createMockRes();
    const rhAccept = {
      scheme: "exact",
      network: "eip155:4663",
      asset: "0xUSDG",
    };

    await x402Gate(runtime, req, res, {
      amountUsd: "0.29",
      extraAccepts: [rhAccept],
    });

    // extraAccepts (RH-Chain USDG) is advertised FIRST as the primary rail.
    // Dexter entries are backfilled with v1 resource/mimeType fields that
    // strict discovery validators (x402scan, Bazaar) require.
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        accepts: [
          expect.objectContaining({ network: "eip155:4663", asset: "0xUSDG" }),
          expect.objectContaining({
            network: "eip155:8453",
            resource: "/api/test",
            mimeType: "application/json",
          }),
          expect.objectContaining({ network: SOLANA_CAIP2 }),
          expect.objectContaining({ network: "eip155:42161" }),
        ],
      })
    );
  });

  it("verifies and settles payment, returns paid:true with transaction", async () => {
    const serverService = createMockServerService({
      settleTransaction: "0xdef456",
      settleNetwork: "eip155:84532",
    });
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    const req = {
      headers: { "payment-signature": "valid-payment-sig" },
      url: "/api/test",
      method: "POST",
    };
    const res = createMockRes();

    const result = await x402Gate(runtime, req, res, {
      amountUsd: "0.05",
      description: "Test endpoint",
    });

    expect(result.paid).toBe(true);
    expect(result.transaction).toBe("0xdef456");
    expect(result.network).toBe("eip155:84532");
    expect(result.amountUsd).toBe(0.05);
    expect(serverService.mockServer.verifyPayment).toHaveBeenCalledWith(
      "valid-payment-sig",
      expect.anything()
    );
    expect(serverService.mockServer.settlePayment).toHaveBeenCalled();
    expect(serverService.recordRevenue).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/api/test",
        amountUsd: 0.05,
        txHash: "0xdef456",
      })
    );
  });

  it("routes a Solana payment to the Solana server instance", async () => {
    const solanaServer = createMockPaymentServer({
      settleTransaction: "solana-signature",
      settleNetwork: SOLANA_CAIP2,
    });
    const serverService = createMockServerService({
      servers: { [SOLANA_CAIP2]: solanaServer },
    });
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    const paymentHeader = encodePaymentHeader(SOLANA_CAIP2);
    const req = {
      headers: { "payment-signature": paymentHeader },
      url: "/api/test",
      method: "POST",
    };
    const res = createMockRes();

    const result = await x402Gate(runtime, req, res, { amountUsd: "0.05" });

    expect(result.paid).toBe(true);
    expect(serverService.getServerFor).toHaveBeenCalledWith(SOLANA_CAIP2);
    expect(solanaServer.verifyPayment).toHaveBeenCalledWith(
      paymentHeader,
      expect.anything()
    );
    expect(solanaServer.settlePayment).toHaveBeenCalled();
    expect(serverService.mockServer.verifyPayment).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown network", encodePaymentHeader("eip155:999999"), "eip155:999999"],
    ["a garbage header", "not-base64-json", undefined],
  ])("falls back to the primary server for %s", async (_label, paymentHeader, network) => {
    const serverService = createMockServerService();
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    const req = {
      headers: { "payment-signature": paymentHeader },
      url: "/api/test",
      method: "POST",
    };
    const res = createMockRes();

    const result = await x402Gate(runtime, req, res, { amountUsd: "0.05" });

    expect(result.paid).toBe(true);
    if (network) {
      expect(serverService.getServerFor).toHaveBeenCalledWith(network);
    } else {
      expect(serverService.getServerFor).not.toHaveBeenCalled();
    }
    expect(serverService.mockServer.verifyPayment).toHaveBeenCalledWith(
      paymentHeader,
      expect.anything()
    );
    expect(serverService.mockServer.settlePayment).toHaveBeenCalled();
  });

  it("returns paid:false when server service is not available (graceful)", async () => {
    const runtime = createMockRuntime({ services: {} });
    const req = { headers: {}, url: "/api/test" };
    const res = createMockRes();

    const result = await x402Gate(runtime, req, res, { amountUsd: "0.05" });

    expect(result.paid).toBe(false);
    expect(result.amountUsd).toBe(0);
    // Should not send any HTTP response — just degrades gracefully
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns paid:false when verify fails", async () => {
    const serverService = createMockServerService({ verifyValid: false });
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    const req = {
      headers: { "payment-signature": "invalid-sig" },
      url: "/api/test",
    };
    const res = createMockRes();

    const result = await x402Gate(runtime, req, res, { amountUsd: "0.05" });

    expect(result.paid).toBe(false);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Payment verification failed" })
    );
    expect(serverService.recordRevenue).not.toHaveBeenCalled();
  });

  it("returns paid:false when settle fails", async () => {
    const serverService = createMockServerService({ settleSuccess: false });
    const runtime = createMockRuntime({ services: { X402_SERVER: serverService } });
    const req = {
      headers: { "payment-signature": "valid-sig" },
      url: "/api/test",
    };
    const res = createMockRes();

    const result = await x402Gate(runtime, req, res, { amountUsd: "0.05" });

    expect(result.paid).toBe(false);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Payment settlement failed" })
    );
    expect(serverService.recordRevenue).not.toHaveBeenCalled();
  });
});
