import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";

// Mock x402Gate so we can control payment gate behavior
vi.mock("../../src/server/x402Gate.js", () => ({
  x402Gate: vi.fn(async () => ({
    paid: true,
    transaction: "tx-trade-123",
    network: "base-mainnet",
  })),
}));

// Mock heliusDataRoutes exports used by tradingRoutes
vi.mock("../../src/routes/heliusDataRoutes.js", () => ({
  SOLANA_ADDR_RE: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  heliusRpcUrl: vi.fn(() => "https://mock-rpc.example.com"),
  rpcCall: vi.fn(async () => ({
    value: {
      blockhash: "mock-blockhash-abc123",
      lastValidBlockHeight: 123456789,
    },
  })),
}));

// Mock fetch for Jupiter price API
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { tradingRoutes } from "../../src/routes/tradingRoutes.js";
import { x402Gate } from "../../src/server/x402Gate.js";
import { rpcCall } from "../../src/routes/heliusDataRoutes.js";

function createMockRes() {
  const res: any = {
    status: vi.fn(() => res),
    json: vi.fn(),
    setHeader: vi.fn(),
  };
  return res;
}

describe("tradingRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes
    (x402Gate as any).mockResolvedValue({
      paid: true,
      transaction: "tx-trade-123",
      network: "base-mainnet",
    });
  });

  // ── POST /x402/token-price ─────────────────────────────────────────

  describe("POST /x402/token-price", () => {
    const route = tradingRoutes.find(
      (r) => r.path === "/x402/token-price" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing mint", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-helius-key" },
      });

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("mint") })
      );
    });

    it("returns 400 for non-string mint", async () => {
      const req = { body: { mint: 12345 } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-helius-key" },
      });

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 400 for invalid mint format", async () => {
      const req = { body: { mint: "not-a-valid-address!!" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-helius-key" },
      });

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("calls x402Gate with $0.01", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
              price: "1.00",
              extraInfo: { confidenceLevel: "high" },
            },
          },
        }),
      });

      const req = {
        body: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.01" })
      );
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const req = {
        body: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });
  });

  // ── POST /x402/slot-info ───────────────────────────────────────────

  describe("POST /x402/slot-info", () => {
    const route = tradingRoutes.find(
      (r) => r.path === "/x402/slot-info" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("works with empty body (no required fields)", async () => {
      (rpcCall as any)
        .mockResolvedValueOnce(300000000) // getSlot
        .mockResolvedValueOnce({          // getEpochInfo
          epoch: 650,
          slotIndex: 100,
          slotsInEpoch: 432000,
        })
        .mockResolvedValueOnce(1700000000); // getBlockTime

      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-helius-key" },
      });

      await route!.handler(req, res, runtime);

      // Should not return 400 — slot-info has no required body fields
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          slot: expect.any(Number),
          payment: expect.objectContaining({ amount: "0.01" }),
        })
      );
    });

    it("returns 503 when HELIUS_API_KEY not configured", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime({ settings: {} });

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("unavailable") })
      );
    });

    it("calls x402Gate with $0.01", async () => {
      (rpcCall as any)
        .mockResolvedValueOnce(300000000)
        .mockResolvedValueOnce({ epoch: 650, slotIndex: 100, slotsInEpoch: 432000 })
        .mockResolvedValueOnce(1700000000);

      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-helius-key" },
      });

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.01" })
      );
    });
  });

  // ── POST /x402/recent-blockhash ────────────────────────────────────

  describe("POST /x402/recent-blockhash", () => {
    const route = tradingRoutes.find(
      (r) => r.path === "/x402/recent-blockhash" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("works with empty body (no required fields)", async () => {
      (rpcCall as any).mockResolvedValueOnce({
        value: {
          blockhash: "mock-blockhash-abc123",
          lastValidBlockHeight: 123456789,
        },
      });

      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-helius-key" },
      });

      await route!.handler(req, res, runtime);

      // Should not return 400 — recent-blockhash has no required body fields
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          blockhash: "mock-blockhash-abc123",
          lastValidBlockHeight: 123456789,
          payment: expect.objectContaining({ amount: "0.01" }),
        })
      );
    });

    it("returns 503 when HELIUS_API_KEY not configured", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime({ settings: {} });

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("unavailable") })
      );
    });

    it("calls x402Gate with $0.01", async () => {
      (rpcCall as any).mockResolvedValueOnce({
        value: {
          blockhash: "mock-blockhash-abc123",
          lastValidBlockHeight: 123456789,
        },
      });

      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-helius-key" },
      });

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.01" })
      );
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-helius-key" },
      });

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });
  });

  // ── GET /x402/trading/health ───────────────────────────────────────

  describe("GET /x402/trading/health", () => {
    const route = tradingRoutes.find(
      (r) => r.path === "/x402/trading/health" && r.type === "GET"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns health status with endpoint list", async () => {
      const mockServerService = {
        getReceiveAddress: vi.fn(() => "0xTestReceiveAddress"),
        getNetwork: vi.fn(() => "base-mainnet"),
      };

      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key" },
        services: { X402_SERVER: mockServerService },
      });
      const req = {} as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "ok",
          heliusConfigured: true,
          endpoints: expect.any(Array),
        })
      );
    });
  });
});
