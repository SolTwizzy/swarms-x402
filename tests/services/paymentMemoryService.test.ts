import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";
import { PaymentMemoryService } from "../../src/services/paymentMemoryService.js";
import type { PaymentHistoryRecord } from "../../src/types.js";

function makeRecord(overrides?: Partial<PaymentHistoryRecord>): PaymentHistoryRecord {
  return {
    id: overrides?.id ?? crypto.randomUUID(),
    agentId: overrides?.agentId ?? "test-agent",
    endpoint: overrides?.endpoint ?? "https://api.example.com/data",
    domain: overrides?.domain ?? "api.example.com",
    method: overrides?.method ?? "GET",
    amountUsd: overrides?.amountUsd ?? 0.05,
    txHash: overrides?.txHash ?? "0xabc123",
    network: overrides?.network ?? "eip155:84532",
    payer: overrides?.payer ?? "0x1234",
    status: overrides?.status ?? "confirmed",
    responseStatus: overrides?.responseStatus ?? 200,
    responseTimeMs: overrides?.responseTimeMs ?? 150,
    responsePreview: overrides?.responsePreview ?? '{"result":"ok"}',
    createdAt: overrides?.createdAt ?? Date.now(),
  };
}

describe("PaymentMemoryService", () => {
  let service: PaymentMemoryService;
  let runtime: ReturnType<typeof createMockRuntime>;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtime = createMockRuntime();
    service = await PaymentMemoryService.start(runtime);
  });

  describe("recordPayment()", () => {
    it("stores payment in history", async () => {
      const record = makeRecord();
      await service.recordPayment(record);

      const history = service.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(record.id);
      expect(history[0].endpoint).toBe("https://api.example.com/data");
    });

    it("adds to unscored buffer when responsePreview is present", async () => {
      const record = makeRecord({ responsePreview: "some response data" });
      await service.recordPayment(record);

      const unscored = service.getUnscoredPayments();
      expect(unscored).toHaveLength(1);
      expect(unscored[0].recordId).toBe(record.id);
      expect(unscored[0].endpoint).toBe(record.endpoint);
      expect(unscored[0].domain).toBe(record.domain);
    });

    it("does not add to unscored buffer when responsePreview is empty", async () => {
      const record = makeRecord();
      record.responsePreview = undefined;
      await service.recordPayment(record);

      const unscored = service.getUnscoredPayments();
      expect(unscored).toHaveLength(0);
    });
  });

  describe("getUnscoredPayments()", () => {
    it("returns and removes from buffer (splice)", async () => {
      await service.recordPayment(makeRecord({ id: "r1", responsePreview: "data1" }));
      await service.recordPayment(makeRecord({ id: "r2", responsePreview: "data2" }));
      await service.recordPayment(makeRecord({ id: "r3", responsePreview: "data3" }));
      await service.recordPayment(makeRecord({ id: "r4", responsePreview: "data4" }));

      // Default limit is 3
      const batch1 = service.getUnscoredPayments();
      expect(batch1).toHaveLength(3);
      expect(batch1[0].recordId).toBe("r1");
      expect(batch1[2].recordId).toBe("r3");

      // Second call gets remaining
      const batch2 = service.getUnscoredPayments();
      expect(batch2).toHaveLength(1);
      expect(batch2[0].recordId).toBe("r4");

      // Third call returns empty
      const batch3 = service.getUnscoredPayments();
      expect(batch3).toHaveLength(0);
    });

    it("respects custom limit", async () => {
      await service.recordPayment(makeRecord({ id: "r1", responsePreview: "d1" }));
      await service.recordPayment(makeRecord({ id: "r2", responsePreview: "d2" }));
      await service.recordPayment(makeRecord({ id: "r3", responsePreview: "d3" }));

      const batch = service.getUnscoredPayments(1);
      expect(batch).toHaveLength(1);
      expect(batch[0].recordId).toBe("r1");
    });
  });

  describe("scorePayment()", () => {
    it("updates quality score in memory", async () => {
      const record = makeRecord({ id: "score-test" });
      await service.recordPayment(record);

      await service.scorePayment("score-test", 4, "Good quality response");

      const history = service.getHistory();
      const scored = history.find((r) => r.id === "score-test");
      expect(scored?.qualityScore).toBe(4);
      expect(scored?.qualityReason).toBe("Good quality response");
    });

    it("does not throw for non-existent recordId", async () => {
      await expect(
        service.scorePayment("nonexistent", 3, "test")
      ).resolves.not.toThrow();
    });
  });

  describe("getSpendingStats()", () => {
    it("filters by 24h period", async () => {
      const now = Date.now();
      await service.recordPayment(
        makeRecord({ amountUsd: 0.05, createdAt: now - 3600000 }) // 1h ago
      );
      await service.recordPayment(
        makeRecord({ amountUsd: 0.10, createdAt: now - 7200000 }) // 2h ago
      );
      await service.recordPayment(
        makeRecord({ amountUsd: 1.00, createdAt: now - 90000000 }) // ~25h ago
      );

      const stats = service.getSpendingStats("24h");
      expect(stats.totalCalls).toBe(2);
      expect(stats.totalSpent).toBeCloseTo(0.15, 2);
      expect(stats.period).toBe("24h");
    });

    it("filters by 7d period", async () => {
      const now = Date.now();
      await service.recordPayment(
        makeRecord({ amountUsd: 0.05, createdAt: now - 86400000 }) // 1d ago
      );
      await service.recordPayment(
        makeRecord({ amountUsd: 0.10, createdAt: now - 604800000 - 1000 }) // 7d+ ago
      );

      const stats = service.getSpendingStats("7d");
      expect(stats.totalCalls).toBe(1);
      expect(stats.totalSpent).toBeCloseTo(0.05, 2);
    });

    it("returns zero stats for empty history", () => {
      const stats = service.getSpendingStats("30d");
      expect(stats.totalCalls).toBe(0);
      expect(stats.totalSpent).toBe(0);
    });
  });

  describe("getEndpointScoreSummary()", () => {
    it("groups by domain and calculates averages", async () => {
      await service.recordPayment(makeRecord({ domain: "api.a.com", amountUsd: 0.10 }));
      await service.recordPayment(makeRecord({ domain: "api.a.com", amountUsd: 0.20 }));
      await service.recordPayment(makeRecord({ domain: "api.b.com", amountUsd: 0.05 }));

      // Score some payments
      const history = service.getHistory();
      await service.scorePayment(history[0].id, 4, "good");
      await service.scorePayment(history[1].id, 2, "poor");
      await service.scorePayment(history[2].id, 5, "excellent");

      const summary = service.getEndpointScoreSummary();
      expect(summary).toHaveLength(2);

      // api.b.com should be first (higher quality/cost ratio: 5/0.05=100 vs 3/0.15=20)
      expect(summary[0].domain).toBe("api.b.com");
      expect(summary[0].avgQuality).toBe(5);
      expect(summary[0].totalCalls).toBe(1);

      expect(summary[1].domain).toBe("api.a.com");
      expect(summary[1].avgCostPerCall).toBeCloseTo(0.15, 2);
      expect(summary[1].totalCalls).toBe(2);
    });

    it("returns empty for no history", () => {
      const summary = service.getEndpointScoreSummary();
      expect(summary).toHaveLength(0);
    });
  });

  describe("getPaymentsByDomain()", () => {
    it("filters correctly by domain", async () => {
      await service.recordPayment(makeRecord({ domain: "api.a.com" }));
      await service.recordPayment(makeRecord({ domain: "api.b.com" }));
      await service.recordPayment(makeRecord({ domain: "api.a.com" }));

      const results = service.getPaymentsByDomain("api.a.com");
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.domain === "api.a.com")).toBe(true);
    });

    it("returns empty for unknown domain", () => {
      const results = service.getPaymentsByDomain("unknown.com");
      expect(results).toHaveLength(0);
    });
  });

  describe("stop()", () => {
    it("clears runtime reference", async () => {
      await service.stop();
      // Service should not throw — just clears state
    });
  });
});
