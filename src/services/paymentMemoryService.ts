import { Service, type IAgentRuntime } from "@elizaos/core";
import type { PaymentHistoryRecord } from "../types.js";

/**
 * Unscored payment awaiting quality evaluation.
 */
export interface UnscoredPayment {
  recordId: string;
  endpoint: string;
  domain: string;
  responseStatus: number;
  responseTimeMs: number;
  responsePreview: string;
}

/**
 * Spending stats for a time period.
 */
export interface SpendingStats {
  totalSpent: number;
  totalCalls: number;
  period: string;
}

/**
 * Records payment history, maintains an unscored buffer for the evaluator,
 * and provides spending analytics. Gracefully degrades to in-memory only
 * when no database is available.
 */
export class PaymentMemoryService extends Service {
  static serviceType = "PAYMENT_MEMORY";
  capabilityDescription =
    "Persists payment history across sessions, enables quality scoring and cost optimization";

  private agentRuntime: IAgentRuntime | null = null;
  private history: PaymentHistoryRecord[] = [];
  private unscoredBuffer: UnscoredPayment[] = [];
  private hasDb = false;

  static async start(runtime: IAgentRuntime): Promise<PaymentMemoryService> {
    const instance = new PaymentMemoryService(runtime);
    await instance.initialize(runtime);
    return instance;
  }

  async stop(): Promise<void> {
    this.agentRuntime = null;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.agentRuntime = runtime;

    // Check if DB is available
    try {
      const db = (runtime as any).databaseAdapter?.db;
      this.hasDb = !!db;
    } catch {
      this.hasDb = false;
    }

    runtime.logger.info(
      { hasDb: this.hasDb },
      "[PaymentMemoryService] Initialized"
    );
  }

  /**
   * Record a completed payment.
   * Flow: sanitize → store in memory → add to unscored buffer → persist to DB (fire-and-forget)
   */
  async recordPayment(record: PaymentHistoryRecord): Promise<void> {
    // Step 1: Sanitize on a shallow copy so we never mutate the caller's object
    const sanitized = { ...record };
    if (!Number.isFinite(sanitized.amountUsd)) {
      sanitized.amountUsd = 0;
    }
    if (sanitized.endpoint && sanitized.endpoint.length > 2048) {
      sanitized.endpoint = sanitized.endpoint.slice(0, 2048);
    }
    if (sanitized.responsePreview && sanitized.responsePreview.length > 2048) {
      sanitized.responsePreview = sanitized.responsePreview.slice(0, 2048);
    }

    // Always store in memory (the sanitized copy)
    this.history.push(sanitized);

    // Prune old records to prevent unbounded memory growth
    if (this.history.length > 10000) {
      this.history = this.history.slice(-10000);
    }

    // Add to unscored buffer if we have response data
    if (sanitized.responsePreview) {
      this.unscoredBuffer.push({
        recordId: sanitized.id,
        endpoint: sanitized.endpoint,
        domain: sanitized.domain,
        responseStatus: sanitized.responseStatus ?? 200,
        responseTimeMs: sanitized.responseTimeMs ?? 0,
        responsePreview: sanitized.responsePreview,
      });
    }

    // Try to persist to DB
    if (this.hasDb && this.agentRuntime) {
      try {
        const db = (this.agentRuntime as any).databaseAdapter?.db;
        if (db) {
          const { x402PaymentHistory } = await import("../schemas/paymentHistory.js");
          await db.insert(x402PaymentHistory).values({
            id: sanitized.id,
            agentId: sanitized.agentId,
            endpoint: sanitized.endpoint,
            domain: sanitized.domain,
            method: sanitized.method,
            amountUsd: sanitized.amountUsd,
            txHash: sanitized.txHash,
            network: sanitized.network ?? null,
            payer: sanitized.payer ?? null,
            status: sanitized.status,
            responseStatus: sanitized.responseStatus ?? null,
            responseTimeMs: sanitized.responseTimeMs ?? null,
            responsePreview: sanitized.responsePreview ?? null,
          });
        }
      } catch (err) {
        // DB write failed — data is still in memory
        this.agentRuntime?.logger.debug(
          { error: err instanceof Error ? err.message : String(err) },
          "[PaymentMemoryService] DB write failed, using in-memory only"
        );
      }
    }
  }

  /**
   * Get unscored payments for the evaluator to process.
   */
  getUnscoredPayments(limit = 3): UnscoredPayment[] {
    return this.unscoredBuffer.splice(0, limit);
  }

  /**
   * Mark a payment as scored (update quality in memory and DB).
   */
  async scorePayment(
    recordId: string,
    qualityScore: number,
    qualityReason: string
  ): Promise<void> {
    // Update in-memory record
    const record = this.history.find((r) => r.id === recordId);
    if (record) {
      record.qualityScore = qualityScore;
      record.qualityReason = qualityReason;
    }

    // Try to update DB
    if (this.hasDb && this.agentRuntime) {
      try {
        const db = (this.agentRuntime as any).databaseAdapter?.db;
        if (db) {
          const { x402PaymentHistory } = await import("../schemas/paymentHistory.js");
          const { eq } = await import("drizzle-orm");
          await db
            .update(x402PaymentHistory)
            .set({ qualityScore, qualityReason })
            .where(eq(x402PaymentHistory.id, recordId));
        }
      } catch {
        // DB update failed — in-memory is updated
      }
    }
  }

  /**
   * Upsert endpoint aggregate scores.
   */
  async updateEndpointScore(
    agentId: string,
    domain: string,
    amountUsd: number,
    responseTimeMs: number,
    qualityScore: number,
    isError: boolean
  ): Promise<void> {
    if (!this.hasDb || !this.agentRuntime) return;

    try {
      const db = (this.agentRuntime as any).databaseAdapter?.db;
      if (!db) return;

      const { x402EndpointScores } = await import("../schemas/endpointScores.js");
      const { eq, and, sql } = await import("drizzle-orm");

      // Try to find existing record
      const existing = await db
        .select()
        .from(x402EndpointScores)
        .where(
          and(
            eq(x402EndpointScores.agentId, agentId),
            eq(x402EndpointScores.domain, domain)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        const row = existing[0];
        const newCount = (row.totalCalls ?? 0) + 1;
        const oldAvg = row.avgQualityScore ?? qualityScore;
        const newAvg = ((oldAvg * (row.totalCalls ?? 0)) + qualityScore) / newCount;
        const oldTimeAvg = row.avgResponseTimeMs ?? responseTimeMs;
        const newTimeAvg = ((oldTimeAvg * (row.totalCalls ?? 0)) + responseTimeMs) / newCount;

        await db
          .update(x402EndpointScores)
          .set({
            totalCalls: newCount,
            totalSpentUsd: (row.totalSpentUsd ?? 0) + amountUsd,
            avgQualityScore: newAvg,
            avgResponseTimeMs: newTimeAvg,
            errorCount: (row.errorCount ?? 0) + (isError ? 1 : 0),
            lastCallAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(x402EndpointScores.id, row.id));
      } else {
        await db.insert(x402EndpointScores).values({
          id: crypto.randomUUID(),
          agentId,
          domain,
          totalCalls: 1,
          totalSpentUsd: amountUsd,
          avgQualityScore: qualityScore,
          avgResponseTimeMs: responseTimeMs,
          errorCount: isError ? 1 : 0,
          lastCallAt: new Date(),
          updatedAt: new Date(),
        });
      }
    } catch {
      // Aggregation failed — not critical
    }
  }

  /**
   * Get spending stats for a time period.
   */
  getSpendingStats(period: "24h" | "7d" | "30d"): SpendingStats {
    const now = Date.now();
    const msMap = { "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
    const cutoff = now - msMap[period];

    const inRange = this.history.filter((r) => r.createdAt >= cutoff);
    return {
      totalSpent: inRange.reduce((sum, r) => sum + r.amountUsd, 0),
      totalCalls: inRange.length,
      period,
    };
  }

  /**
   * Get payments by domain for quality lookup.
   */
  getPaymentsByDomain(domain: string): PaymentHistoryRecord[] {
    return this.history.filter((r) => r.domain === domain);
  }

  /**
   * Get all endpoint scores from memory (for provider context).
   */
  getEndpointScoreSummary(): Array<{
    domain: string;
    avgQuality: number;
    avgCostPerCall: number;
    totalCalls: number;
  }> {
    const byDomain = new Map<
      string,
      { totalQuality: number; totalCost: number; count: number; scoredCount: number }
    >();

    for (const record of this.history) {
      const existing = byDomain.get(record.domain) ?? {
        totalQuality: 0,
        totalCost: 0,
        count: 0,
        scoredCount: 0,
      };
      existing.totalCost += record.amountUsd;
      existing.count += 1;
      if (record.qualityScore != null) {
        existing.totalQuality += record.qualityScore;
        existing.scoredCount += 1;
      }
      byDomain.set(record.domain, existing);
    }

    return Array.from(byDomain.entries())
      .map(([domain, stats]) => ({
        domain,
        avgQuality: stats.scoredCount > 0
          ? stats.totalQuality / stats.scoredCount
          : 0,
        avgCostPerCall: stats.totalCost / stats.count,
        totalCalls: stats.count,
      }))
      .sort((a, b) => {
        // Sort by quality/cost ratio (best value first)
        const aRatio = a.avgQuality / Math.max(a.avgCostPerCall, 0.001);
        const bRatio = b.avgQuality / Math.max(b.avgCostPerCall, 0.001);
        return bRatio - aRatio;
      });
  }

  getHistory(): PaymentHistoryRecord[] {
    return [...this.history];
  }
}
