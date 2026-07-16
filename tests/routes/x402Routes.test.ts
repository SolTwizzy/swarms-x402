import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";

// Mock x402Gate so we can control payment gate behavior
vi.mock("../../src/server/x402Gate.js", () => ({
  x402Gate: vi.fn(async () => ({ paid: false, amountUsd: 0 })),
  getFreeTierStats: vi.fn(() => ({ totalFreeCallsToday: 0, uniqueIPs: 0, topIPs: [] })),
}));

// Mock taskQueue so we can control async task behavior
const _taskStore = new Map<string, any>();
vi.mock("../../src/utils/taskQueue.js", () => ({
  taskQueue: {
    submit: vi.fn(),
    getStatus: vi.fn(),
    setExecutor: vi.fn(),
  },
}));

import { x402Routes } from "../../src/routes/x402Routes.js";
import { x402Gate, getFreeTierStats } from "../../src/server/x402Gate.js";
import { taskQueue } from "../../src/utils/taskQueue.js";

function createMockRes() {
  const res: any = {
    status: vi.fn(() => res),
    json: vi.fn(),
    setHeader: vi.fn(),
  };
  return res;
}

const MOCK_NETWORKS = [
  {
    friendlyId: "base-mainnet",
    caip2: "eip155:8453",
    kind: "evm",
    payTo: "0xBasePayTo",
  },
  {
    friendlyId: "solana-mainnet",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    kind: "solana",
    payTo: "SolanaPayTo",
  },
  {
    friendlyId: "arbitrum-mainnet",
    caip2: "eip155:42161",
    kind: "evm",
    payTo: "0xArbitrumPayTo",
  },
] as const;

describe("x402Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _taskStore.clear();
    // Re-set mock implementations after clearAllMocks resets them
    (getFreeTierStats as any).mockReturnValue({ totalFreeCallsToday: 0, uniqueIPs: 0, topIPs: [] });
    (taskQueue.submit as any).mockImplementation((endpoint: string, _params: any, webhookUrl?: string) => {
      const id = "test-task-id-123";
      _taskStore.set(id, { id, status: "pending", endpoint, createdAt: Date.now(), webhookUrl });
      return id;
    });
    (taskQueue.getStatus as any).mockImplementation((taskId: string) => _taskStore.get(taskId) ?? null);
  });

  describe("GET /x402/catalog", () => {
    it("returns array of endpoints with name and priceUsd", async () => {
      const catalogRoute = x402Routes.find(
        (r) => r.path === "/x402/catalog" && r.type === "GET"
      );
      expect(catalogRoute).toBeDefined();

      const req = {};
      const res = createMockRes();
      const runtime = createMockRuntime();

      await catalogRoute!.handler(req as any, res, runtime);

      expect(res.json).toHaveBeenCalledTimes(1);
      const catalog = res.json.mock.calls[0][0];
      expect(Array.isArray(catalog)).toBe(true);
      expect(catalog.length).toBeGreaterThan(0);

      // Each entry should have name, path, priceUsd
      for (const entry of catalog) {
        expect(entry).toHaveProperty("name");
        expect(entry).toHaveProperty("priceUsd");
        expect(entry).toHaveProperty("path");
        expect(typeof entry.name).toBe("string");
        expect(typeof entry.priceUsd).toBe("string");
      }
    });
  });

  describe("GET /x402/health", () => {
    it("returns status ok with revenue info", async () => {
      const healthRoute = x402Routes.find(
        (r) => r.path === "/x402/health" && r.type === "GET"
      );
      expect(healthRoute).toBeDefined();

      const mockServerService = {
        getReceiveAddress: vi.fn(() => "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
        getNetwork: vi.fn(() => "eip155:8453"),
        getNetworks: vi.fn(() => MOCK_NETWORKS),
        getTotalRevenueUsd: vi.fn(() => 0.15),
        getSettlementCount: vi.fn(() => 3),
      };

      const runtime = createMockRuntime({
        services: { X402_SERVER: mockServerService },
      });
      const req = {};
      const res = createMockRes();

      await healthRoute!.handler(req as any, res, runtime);

      expect(res.json).toHaveBeenCalledTimes(1);
      const health = res.json.mock.calls[0][0];
      expect(health.status).toBe("ok");
      expect(health.receiveAddress).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
      expect(health.payTo).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
      expect(health.network).toBe("eip155:8453");
      expect(health.networks).toEqual(
        MOCK_NETWORKS.map(({ caip2, friendlyId, payTo }) => ({
          network: caip2,
          friendlyId,
          payTo,
        }))
      );
      expect(health.totalRevenue).toBe(0.15);
      expect(health.settlements).toBe(3);
      expect(health.freeTierCallsToday).toBe(0);
      expect(health.freeTierUniqueIPs).toBe(0);
    });

    it("returns defaults when no server service", async () => {
      const healthRoute = x402Routes.find(
        (r) => r.path === "/x402/health" && r.type === "GET"
      );

      const runtime = createMockRuntime({ services: {} });
      const req = {};
      const res = createMockRes();

      await healthRoute!.handler(req as any, res, runtime);

      const health = res.json.mock.calls[0][0];
      expect(health.status).toBe("ok");
      expect(health.receiveAddress).toBe("");
      expect(health.payTo).toBe("");
      expect(health.networks).toEqual([]);
      expect(health.totalRevenue).toBe(0);
      expect(health.settlements).toBe(0);
      expect(health.freeTierCallsToday).toBe(0);
      expect(health.freeTierUniqueIPs).toBe(0);
    });
  });

  describe("x402 discovery surfaces", () => {
    it("includes every active Dexter network after RH-Chain for each resource", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/discovery/resources" && r.type === "GET"
      );
      const buildAllRequirements = vi.fn(async ({ resourceUrl }: { resourceUrl: string }) => ({
        x402Version: 2,
        resource: { url: resourceUrl },
        accepts: MOCK_NETWORKS.map(({ caip2, payTo }) => ({
          scheme: "exact",
          network: caip2,
          payTo,
          maxAmountRequired: "50000",
        })),
      }));
      const runtime = createMockRuntime({
        services: {
          X402_SERVER: {
            isAvailable: vi.fn(() => true),
            buildAllRequirements,
          },
        },
      });
      const res = createMockRes();

      await route!.handler(
        {
          url: "http://localhost/discovery/resources",
          query: { url: "https://localhost/x402/research" },
        } as any,
        res,
        runtime
      );

      const body = res.json.mock.calls[0][0];
      expect(body.items).toHaveLength(1);
      expect(body.items[0].accepts[0].network).toBe("eip155:4663");
      expect(body.items[0].accepts.slice(1).map((entry: any) => entry.network)).toEqual(
        MOCK_NETWORKS.map(({ caip2 }) => caip2)
      );
      for (const entry of body.items[0].accepts.slice(1)) {
        expect(entry).toEqual(
          expect.objectContaining({
            resource: "https://localhost/x402/research",
            mimeType: "application/json",
          })
        );
        expect(entry.description).toEqual(expect.any(String));
      }
      expect(buildAllRequirements).toHaveBeenCalledTimes(1);
    });

    it("substitutes Meridian EVM entries in discovery when configured", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/discovery/resources" && r.type === "GET"
      );
      const buildAllRequirements = vi.fn(async () => ({
        x402Version: 2,
        resource: { url: "https://localhost/x402/research" },
        accepts: MOCK_NETWORKS.map(({ caip2, payTo }) => ({
          scheme: "exact",
          network: caip2,
          payTo,
          maxAmountRequired: "50000",
        })),
      }));
      const runtime = createMockRuntime({
        settings: {
          MERIDIAN_API_KEY: "pk_live",
          X402_RECEIVE_ADDRESS_EVM:
            "0x1111111111111111111111111111111111111111",
        },
        services: {
          X402_SERVER: {
            isAvailable: vi.fn(() => true),
            buildAllRequirements,
          },
        },
      });
      const res = createMockRes();

      await route!.handler(
        {
          url: "http://localhost/discovery/resources",
          query: { url: "https://localhost/x402/research" },
        } as any,
        res,
        runtime
      );

      const accepts = res.json.mock.calls[0][0].items[0].accepts;
      expect(accepts.map((entry: any) => entry.network)).toEqual([
        "eip155:4663",
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        "base",
        "arbitrum",
      ]);
      expect(accepts[2].extra.creditedRecipient).toBe(
        "0x1111111111111111111111111111111111111111"
      );
    });

    it("mentions every active chain in well-known instructions", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/.well-known/x402" && r.type === "GET"
      );
      const runtime = createMockRuntime({
        services: { X402_SERVER: { getNetworks: vi.fn(() => MOCK_NETWORKS) } },
      });
      const res = createMockRes();

      await route!.handler(
        { url: "http://localhost/.well-known/x402" } as any,
        res,
        runtime
      );

      expect(res.json.mock.calls[0][0].instructions).toContain(
        "Base, Solana + Arbitrum USDC via the Dexter facilitator"
      );
    });

    it("generates OpenAPI payment copy from every active chain", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/openapi.json" && r.type === "GET"
      );
      const runtime = createMockRuntime({
        services: { X402_SERVER: { getNetworks: vi.fn(() => MOCK_NETWORKS) } },
      });
      const res = createMockRes();

      await route!.handler(
        { url: "http://localhost/openapi.json" } as any,
        res,
        runtime
      );

      const body = res.json.mock.calls[0][0];
      expect(body.info.description).toContain("USDC (Base, Solana + Arbitrum)");
      expect(body.paths["/x402/research"].post.responses["402"].description).toContain(
        "Base, Solana + Arbitrum USDC"
      );
    });
  });

  // ── Revenue Dashboard ─────────────────────────────────────────────

  describe("GET /x402/revenue", () => {
    it("returns revenue breakdown with zero data", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/x402/revenue" && r.type === "GET"
      );
      expect(route).toBeDefined();

      const mockServerService = {
        getRevenueHistory: vi.fn(() => []),
        getTotalRevenueUsd: vi.fn(() => 0),
        getSettlementCount: vi.fn(() => 0),
        getReceiveAddress: vi.fn(() => ""),
        getNetwork: vi.fn(() => ""),
      };

      const runtime = createMockRuntime({
        services: { X402_SERVER: mockServerService },
      });
      const req = {};
      const res = createMockRes();

      await route!.handler(req as any, res, runtime);

      expect(res.json).toHaveBeenCalledTimes(1);
      const data = res.json.mock.calls[0][0];
      expect(data.totalRevenue).toBe(0);
      expect(data.settlements).toBe(0);
      expect(data.revenueByEndpoint).toEqual({});
      expect(data.last24h).toEqual({ revenue: 0, settlements: 0 });
      expect(data.last7d).toEqual({ revenue: 0, settlements: 0 });
      expect(data.last30d).toEqual({ revenue: 0, settlements: 0 });
      expect(data.conversionRate).toBe(0);
      expect(data.topBuyers).toEqual([]);
      expect(data.averageTransactionUsd).toBe(0);
      expect(data.freeTier).toBeDefined();
    });

    it("returns revenue breakdown with populated data", async () => {
      const revenueRoute = x402Routes.find(
        (r) => r.path === "/x402/revenue" && r.type === "GET"
      );
      expect(revenueRoute).toBeDefined();

      const now = Date.now();
      const revenueHistory = [
        {
          endpoint: "/x402/research",
          amountUsd: 0.05,
          txHash: "tx1",
          network: "eip155:8453",
          payer: "0xAlice",
          timestamp: now - 3600_000, // 1 hour ago
        },
        {
          endpoint: "/x402/analyze",
          amountUsd: 0.03,
          txHash: "tx2",
          network: "eip155:8453",
          payer: "0xBob",
          timestamp: now - 3600_000,
        },
        {
          endpoint: "/x402/research",
          amountUsd: 0.05,
          txHash: "tx3",
          network: "eip155:8453",
          payer: "0xAlice",
          timestamp: now - 3600_000,
        },
      ];

      const mockServerService = {
        getRevenueHistory: vi.fn(() => revenueHistory),
        getTotalRevenueUsd: vi.fn(() => 0.13),
        getSettlementCount: vi.fn(() => 3),
        getReceiveAddress: vi.fn(() => "0xReceiver"),
        getNetwork: vi.fn(() => "eip155:8453"),
      };

      const runtime = createMockRuntime({
        services: { X402_SERVER: mockServerService },
      });
      const req = {};
      const res = createMockRes();

      await revenueRoute!.handler(req as any, res, runtime);

      const data = res.json.mock.calls[0][0];
      expect(data.totalRevenue).toBe(0.13);
      expect(data.settlements).toBe(3);

      // Revenue by endpoint
      expect(data.revenueByEndpoint["/x402/research"]).toBeDefined();
      expect(data.revenueByEndpoint["/x402/research"].calls).toBe(2);
      expect(data.revenueByEndpoint["/x402/analyze"].calls).toBe(1);

      // Time period stats — all records are within 24h
      expect(data.last24h.settlements).toBe(3);
      expect(data.last7d.settlements).toBe(3);
      expect(data.last30d.settlements).toBe(3);

      // Top buyers — Alice spent more
      expect(data.topBuyers.length).toBe(2);
      expect(data.topBuyers[0].payer).toBe("0xAlice");

      // Average
      expect(data.averageTransactionUsd).toBeGreaterThan(0);

      // Conversion rate = paid / (paid + free) = 3 / (3 + 0)
      expect(data.conversionRate).toBe(1);
    });

    it("returns defaults when no server service", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/x402/revenue" && r.type === "GET"
      );

      const runtime = createMockRuntime({ services: {} });
      const req = {};
      const res = createMockRes();

      await route!.handler(req as any, res, runtime);

      const data = res.json.mock.calls[0][0];
      expect(data.totalRevenue).toBe(0);
      expect(data.settlements).toBe(0);
      expect(data.revenueByEndpoint).toEqual({});
      expect(data.topBuyers).toEqual([]);
    });
  });

  // ── Async Task Submission ─────────────────────────────────────────

  describe("POST /x402/async", () => {
    it("submits a task and returns taskId + statusUrl", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/x402/async" && r.type === "POST"
      );
      expect(route).toBeDefined();

      const runtime = createMockRuntime();
      const req = {
        body: {
          endpoint: "/x402/research",
          params: { query: "AI safety" },
        },
      };
      const res = createMockRes();

      await route!.handler(req as any, res, runtime);

      expect(res.json).toHaveBeenCalledTimes(1);
      const data = res.json.mock.calls[0][0];
      expect(data.taskId).toBe("test-task-id-123");
      expect(data.statusUrl).toBe("/x402/task/test-task-id-123");
    });

    it("submits with webhookUrl", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/x402/async" && r.type === "POST"
      );

      const runtime = createMockRuntime();
      const req = {
        body: {
          endpoint: "/x402/agent",
          params: { task: "summarize" },
          webhookUrl: "https://example.com/hook",
        },
      };
      const res = createMockRes();

      await route!.handler(req as any, res, runtime);

      expect(taskQueue.submit).toHaveBeenCalledWith(
        "/x402/agent",
        { task: "summarize" },
        "https://example.com/hook"
      );
      expect(res.json.mock.calls[0][0].taskId).toBe("test-task-id-123");
    });

    it("returns 400 when endpoint is missing", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/x402/async" && r.type === "POST"
      );

      const runtime = createMockRuntime();
      const req = { body: {} };
      const res = createMockRes();

      await route!.handler(req as any, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "Missing required field: endpoint",
      });
    });

    it("returns 400 when body is empty", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/x402/async" && r.type === "POST"
      );

      const runtime = createMockRuntime();
      const req = {};
      const res = createMockRes();

      await route!.handler(req as any, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // ── Task Status Polling ───────────────────────────────────────────

  describe("GET /x402/task/:id", () => {
    it("returns task status for a known task", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/x402/task/:id" && r.type === "GET"
      );
      expect(route).toBeDefined();

      // First submit a task to populate the store
      const asyncRoute = x402Routes.find(
        (r) => r.path === "/x402/async" && r.type === "POST"
      );
      const submitReq = {
        body: { endpoint: "/x402/research", params: { query: "test" } },
      };
      const submitRes = createMockRes();
      await asyncRoute!.handler(submitReq as any, submitRes, createMockRuntime());

      // Now poll for the task
      const runtime = createMockRuntime();
      const req = { params: { id: "test-task-id-123" } };
      const res = createMockRes();

      await route!.handler(req as any, res, runtime);

      expect(res.json).toHaveBeenCalledTimes(1);
      const data = res.json.mock.calls[0][0];
      expect(data.id).toBe("test-task-id-123");
      expect(data.status).toBe("pending");
      expect(data.endpoint).toBe("/x402/research");
    });

    it("returns 404 for unknown task ID", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/x402/task/:id" && r.type === "GET"
      );

      // Mock getStatus to return null for unknown IDs
      (taskQueue.getStatus as any).mockReturnValueOnce(null);

      const runtime = createMockRuntime();
      const req = { params: { id: "nonexistent-id" } };
      const res = createMockRes();

      await route!.handler(req as any, res, runtime);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: "Task not found" });
    });

    it("returns 400 when task ID is missing", async () => {
      const route = x402Routes.find(
        (r) => r.path === "/x402/task/:id" && r.type === "GET"
      );

      const runtime = createMockRuntime();
      const req = { params: {} };
      const res = createMockRes();

      await route!.handler(req as any, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: "Missing task ID" });
    });
  });
});
