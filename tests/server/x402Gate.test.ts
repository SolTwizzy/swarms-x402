import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";
import { x402Gate } from "../../src/server/x402Gate.js";

/**
 * Create a mock X402ServerService with controllable behavior.
 */
function createMockServerService(overrides?: {
  available?: boolean;
  verifyValid?: boolean;
  settleSuccess?: boolean;
  settleTransaction?: string;
  settleNetwork?: string;
}) {
  const available = overrides?.available ?? true;
  const verifyValid = overrides?.verifyValid ?? true;
  const settleSuccess = overrides?.settleSuccess ?? true;

  const mockServer = {
    buildRequirements: vi.fn(async () => ({ type: "x402", amount: "50000" })),
    encodeRequirements: vi.fn(() => "encoded-requirements"),
    getPaymentAccept: vi.fn(async () => ({ type: "accept", amount: "50000" })),
    verifyPayment: vi.fn(async () => ({ isValid: verifyValid })),
    settlePayment: vi.fn(async () => ({
      success: settleSuccess,
      transaction: overrides?.settleTransaction ?? "0xabc123",
      network: overrides?.settleNetwork ?? "eip155:84532",
    })),
  };

  return {
    isAvailable: vi.fn(() => available),
    getServer: vi.fn(() => mockServer),
    getNetwork: vi.fn(() => "eip155:84532"),
    getReceiveAddress: vi.fn(() => "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
    recordRevenue: vi.fn(),
    mockServer,
  };
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

  it("includes additional advertised payment options in the unpaid 402 body", async () => {
    const serverService = createMockServerService();
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

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        accepts: [
          { type: "x402", amount: "50000" },
          expect.objectContaining({ network: "eip155:4663", asset: "0xUSDG" }),
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
