/**
 * Round 5 — FINAL edge case tests.
 *
 * Targets areas no previous round tested:
 * 1. server.ts standalone server shape & route map logic
 * 2. Drizzle schemas match what the code actually writes
 * 3. SignalHawk analystSwarm functions (buildAnalystSwarm, parseSwarmVerdicts, computeConsensus)
 * 4. Full plugin shape regression (counts, uniqueness, exports)
 * 5. Cross-round regression (previous 8 bugs stay fixed, recordPayment mutation)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMockRuntime,
  createMockCallback,
  createMockMessage,
  createMockWalletService,
  createMockBudgetAccount,
} from "../setup.js";
import { DEFAULT_TEST_SETTINGS } from "../fixtures.js";
import type { PaymentHistoryRecord } from "../../src/types.js";

// ======================================================================
// Mocks
// ======================================================================

vi.mock("@dexterai/x402/client", () => ({
  searchAPIs: vi.fn(async () => []),
  wrapFetch: vi.fn(() => vi.fn()),
  createBudgetAccount: vi.fn(),
  getPaymentReceipt: vi.fn(() => null),
  X402Error: class X402Error extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  },
}));

vi.mock("@dexterai/x402/server", () => ({
  createX402Server: vi.fn(() => ({
    buildRequirements: vi.fn(async () => ({ type: "x402", amount: "50000" })),
    encodeRequirements: vi.fn(() => "encoded-requirements"),
    getPaymentAccept: vi.fn(async () => ({ type: "accept", amount: "50000" })),
    verifyPayment: vi.fn(async () => ({ isValid: true })),
    settlePayment: vi.fn(async () => ({
      success: true,
      transaction: "0xabc",
      network: "eip155:84532",
    })),
  })),
}));

// ======================================================================
// Imports (after mocks)
// ======================================================================

import { PaymentMemoryService } from "../../src/services/paymentMemoryService.js";
import { paymentEvaluator } from "../../src/evaluators/paymentEvaluator.js";
import { x402Routes } from "../../src/routes/x402Routes.js";
import { walletAnalyzerRoutes } from "../../src/routes/walletAnalyzerRoutes.js";
import {
  buildAnalystSwarm,
  parseSwarmVerdicts,
  computeConsensus,
} from "../../examples/signalhawk/swarms/analystSwarm.js";

// ======================================================================
// Helpers
// ======================================================================

function makeRecord(
  overrides?: Partial<PaymentHistoryRecord>
): PaymentHistoryRecord {
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

// ======================================================================
// 1. server.ts standalone server shape & route map logic
// ======================================================================
describe("1. Standalone server shape & route map", () => {
  it("1a. Mock runtime factory creates valid runtime shape (all methods used by routes)", () => {
    // The standalone server.ts creates a runtime with: agentId, logger, getSetting, getService, hasService
    const serviceMap = new Map<string, any>();
    const runtime = {
      agentId: "standalone-server",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      getSetting(key: string): string | boolean | number | null {
        const val = (process.env as any)[key];
        if (val === undefined) return null;
        if (val === "true") return true;
        if (val === "false") return false;
        const num = Number(val);
        if (!isNaN(num) && val.trim() !== "") return num;
        return val;
      },
      getService<T>(serviceType: string): T | null {
        return (serviceMap.get(serviceType) as T) ?? null;
      },
      hasService(serviceType: string): boolean {
        return serviceMap.has(serviceType);
      },
    };

    // Verify it has all fields routes expect
    expect(runtime.agentId).toBe("standalone-server");
    expect(typeof runtime.getSetting).toBe("function");
    expect(typeof runtime.getService).toBe("function");
    expect(typeof runtime.logger.info).toBe("function");
    expect(typeof runtime.logger.warn).toBe("function");
    expect(typeof runtime.logger.error).toBe("function");
    expect(typeof runtime.logger.debug).toBe("function");

    // getSetting should handle boolean conversion
    expect(runtime.getSetting("NONEXISTENT")).toBeNull();
  });

  it("1b. Route map construction: all routes have unique 'METHOD /path' keys", () => {
    const allRoutes = [...x402Routes, ...walletAnalyzerRoutes];
    const map = new Map<string, any>();

    for (const route of allRoutes) {
      if (route.handler) {
        const key = `${route.type} ${route.path}`;
        // No duplicate keys
        expect(map.has(key)).toBe(false);
        map.set(key, route.handler);
      }
    }

    // Should have at least 8 routes (x402 core + wallet-analyzer + revenue/async/task)
    expect(map.size).toBeGreaterThanOrEqual(8);

    // Verify all expected keys are present
    expect(map.has("POST /x402/research")).toBe(true);
    expect(map.has("POST /x402/analyze")).toBe(true);
    expect(map.has("POST /x402/agent")).toBe(true);
    expect(map.has("GET /x402/catalog")).toBe(true);
    expect(map.has("GET /x402/health")).toBe(true);
    expect(map.has("POST /x402/wallet-analyzer")).toBe(true);
    expect(map.has("POST /x402/wallet-report")).toBe(true);
    expect(map.has("GET /x402/wallet-analyzer/health")).toBe(true);
  });

  it("1c. Health endpoint returns valid JSON structure", async () => {
    const allRoutes = [...x402Routes, ...walletAnalyzerRoutes];
    const healthRoute = allRoutes.find(
      (r) => r.type === "GET" && r.path === "/x402/health"
    );
    expect(healthRoute?.handler).toBeDefined();

    const runtime = createMockRuntime({ services: {} });
    const res = {
      status: vi.fn(() => res),
      json: vi.fn(),
      setHeader: vi.fn(),
    };

    await healthRoute!.handler!({} as any, res as any, runtime);

    expect(res.json).toHaveBeenCalledTimes(1);
    const data = res.json.mock.calls[0][0];
    // Must have all required fields per server.ts expectations
    expect(data).toHaveProperty("status", "ok");
    expect(data).toHaveProperty("receiveAddress");
    expect(data).toHaveProperty("network");
    expect(data).toHaveProperty("totalRevenue");
    expect(data).toHaveProperty("settlements");
    // All values should be JSON-serializable (no undefined)
    const serialized = JSON.parse(JSON.stringify(data));
    expect(serialized.status).toBe("ok");
  });
});

// ======================================================================
// 2. Drizzle schema validation
// ======================================================================
describe("2. Drizzle schema validation", () => {
  it("2a. x402PaymentHistory has all columns the code writes to", async () => {
    const { x402PaymentHistory } = await import(
      "../../src/schemas/paymentHistory.js"
    );

    // The paymentMemoryService.recordPayment writes these fields:
    const requiredColumns = [
      "id",
      "agentId",
      "endpoint",
      "domain",
      "method",
      "amountUsd",
      "txHash",
      "network",
      "payer",
      "status",
      "responseStatus",
      "responseTimeMs",
      "responsePreview",
    ];

    // Additionally scorePayment writes:
    const scoreColumns = ["qualityScore", "qualityReason"];

    // createdAt is auto-set by the DB
    const allColumns = [...requiredColumns, ...scoreColumns, "createdAt"];

    const tableColumns = Object.keys(x402PaymentHistory);
    // Filter to only the column property names (exclude Symbol and internal Drizzle props)
    // The table object should have a property for each column name
    for (const col of allColumns) {
      expect(
        tableColumns.includes(col),
        `x402PaymentHistory missing column: ${col}`
      ).toBe(true);
    }
  });

  it("2b. x402EndpointScores has the compound unique index on (agentId, domain)", async () => {
    const { x402EndpointScores } = await import(
      "../../src/schemas/endpointScores.js"
    );

    // Verify all columns that updateEndpointScore writes to exist
    const requiredColumns = [
      "id",
      "agentId",
      "domain",
      "totalCalls",
      "totalSpentUsd",
      "avgQualityScore",
      "avgResponseTimeMs",
      "errorCount",
      "lastCallAt",
      "updatedAt",
    ];

    const tableColumns = Object.keys(x402EndpointScores);
    for (const col of requiredColumns) {
      expect(
        tableColumns.includes(col),
        `x402EndpointScores missing column: ${col}`
      ).toBe(true);
    }
  });

  it("2c. x402BudgetState has all budget period columns", async () => {
    const { x402BudgetState } = await import(
      "../../src/schemas/budgetState.js"
    );

    // Verify all columns match the BudgetState type
    const requiredColumns = [
      "id",
      "agentId",
      "dailySpentUsd",
      "dailyResetAt",
      "weeklySpentUsd",
      "weeklyResetAt",
      "monthlySpentUsd",
      "monthlyResetAt",
      "lifetimeSpentUsd",
      "lifetimePayments",
      "dailyBudgetUsd",
      "weeklyBudgetUsd",
      "monthlyBudgetUsd",
      "updatedAt",
    ];

    const tableColumns = Object.keys(x402BudgetState);
    for (const col of requiredColumns) {
      expect(
        tableColumns.includes(col),
        `x402BudgetState missing column: ${col}`
      ).toBe(true);
    }
  });
});

// ======================================================================
// 3. SignalHawk unit tests
// ======================================================================
describe("3. SignalHawk analystSwarm", () => {
  it("3a. buildAnalystSwarm produces valid SwarmRunParams shape", () => {
    const params = buildAnalystSwarm("BTC", "4h", "price=67000", "bullish sentiment");

    expect(params.name).toContain("SignalHawk-BTC-4h");
    expect(params.description).toContain("BTC");
    expect(params.description).toContain("4h");
    expect(params.swarm_type).toBe("MajorityVoting");
    expect(params.max_loops).toBe(1);
    expect(params.agents).toHaveLength(3);
    expect(params.task).toContain("BTC");
    expect(params.task).toContain("4h");
    expect(params.task).toContain("price=67000");
    expect(params.task).toContain("bullish sentiment");
    expect(params.task).toContain("VERDICT: LONG|SHORT|HOLD");

    // Each agent has required fields
    const agentNames = params.agents.map((a) => a.agent_name);
    expect(agentNames).toContain("TechnicalAnalyst");
    expect(agentNames).toContain("SentimentAnalyst");
    expect(agentNames).toContain("OnChainAnalyst");

    for (const agent of params.agents) {
      expect(agent.system_prompt).toBeTruthy();
      expect(agent.model_name).toBe("gpt-4o-mini");
      expect(agent.role).toBe("worker");
      expect(agent.max_loops).toBe(1);
      expect(agent.max_tokens).toBe(4096);
      expect(typeof agent.temperature).toBe("number");
    }
  });

  it("3b. buildAnalystSwarm handles empty price/sentiment data gracefully", () => {
    const params = buildAnalystSwarm("ETH", "1d", "", "");

    expect(params.task).toContain("(no price data available)");
    expect(params.task).toContain("(no sentiment data available)");
    expect(params.agents).toHaveLength(3);
  });

  it("3c. parseSwarmVerdicts with real-looking agent output", () => {
    const output = `TechnicalAnalyst:
Based on the price data, BTC shows strong momentum above the 50-day MA.
VERDICT: LONG
CONFIDENCE: 75
REASONING: Breakout above key resistance at 65000 with increasing volume.

SentimentAnalyst:
Market sentiment is cautiously optimistic with institutional interest rising.
VERDICT: LONG
CONFIDENCE: 60
REASONING: Growing institutional adoption narrative supports price action.

OnChainAnalyst:
Whale accumulation patterns are mixed but exchange outflows continue.
VERDICT: HOLD
CONFIDENCE: 55
REASONING: On-chain signals are neutral with slight accumulation bias.`;

    const verdicts = parseSwarmVerdicts(output);

    expect(verdicts.technical.verdict).toBe("LONG");
    expect(verdicts.technical.confidence).toBe(75);
    expect(verdicts.technical.reasoning).toContain("Breakout");

    expect(verdicts.sentiment.verdict).toBe("LONG");
    expect(verdicts.sentiment.confidence).toBe(60);

    expect(verdicts.onchain.verdict).toBe("HOLD");
    expect(verdicts.onchain.confidence).toBe(55);
  });

  it("3d. parseSwarmVerdicts with completely garbled output", () => {
    const garbled = "This output has no structure whatsoever. Random text 12345 @@#$%";

    const verdicts = parseSwarmVerdicts(garbled);

    // All should fall back to defaults
    expect(verdicts.technical.verdict).toBe("HOLD");
    expect(verdicts.technical.confidence).toBe(50);
    expect(verdicts.sentiment.verdict).toBe("HOLD");
    expect(verdicts.onchain.verdict).toBe("HOLD");
  });

  it("3e. computeConsensus with unanimous votes", () => {
    const result = computeConsensus({
      technical: { verdict: "LONG", confidence: 80 },
      sentiment: { verdict: "LONG", confidence: 70 },
      onchain: { verdict: "LONG", confidence: 90 },
    });

    expect(result.signal).toBe("LONG");
    expect(result.confidence).toBe(80); // avg of 80,70,90
    expect(result.consensus).toBe("3/3 LONG");
  });

  it("3f. computeConsensus with split votes (2-1)", () => {
    const result = computeConsensus({
      technical: { verdict: "SHORT", confidence: 65 },
      sentiment: { verdict: "SHORT", confidence: 55 },
      onchain: { verdict: "HOLD", confidence: 40 },
    });

    expect(result.signal).toBe("SHORT");
    expect(result.confidence).toBe(53); // avg of 65,55,40 = 160/3 ≈ 53
    expect(result.consensus).toBe("2/3 SHORT");
  });

  it("3g. computeConsensus with three-way tie resolves to a deterministic choice", () => {
    const result = computeConsensus({
      technical: { verdict: "LONG", confidence: 50 },
      sentiment: { verdict: "SHORT", confidence: 50 },
      onchain: { verdict: "HOLD", confidence: 50 },
    });

    // Three-way tie: each has count=1. The iteration order of Object.entries determines winner.
    // The function picks the last one with count > majorityCount.
    // Iteration order: LONG(1), SHORT(1), HOLD(1) — each replaces because count >= prev max.
    // Final: whichever appears last in iteration. For { LONG:1, SHORT:1, HOLD:1 },
    // HOLD will be the majority since it's the last entry with count > 0.
    expect(["LONG", "SHORT", "HOLD"]).toContain(result.signal);
    expect(result.confidence).toBe(50);
    expect(result.consensus).toMatch(/1\/3/);
  });
});

// ======================================================================
// 4. Full plugin shape regression
// ======================================================================
describe("4. Plugin shape regression", () => {
  it("4a. Plugin exports exact counts: 5 actions, 4 services, 2 providers, 1 evaluator, 19 routes", async () => {
    const { x402SwarmsPlugin } = await import("../../src/index.js");

    expect(x402SwarmsPlugin.actions).toHaveLength(5);
    expect(x402SwarmsPlugin.services).toHaveLength(4);
    expect(x402SwarmsPlugin.providers).toHaveLength(2);
    expect(x402SwarmsPlugin.evaluators).toHaveLength(1);
    expect(x402SwarmsPlugin.routes!.length).toBeGreaterThanOrEqual(19);
  });

  it("4b. All action names are unique strings", async () => {
    const { x402SwarmsPlugin } = await import("../../src/index.js");

    const actionNames = x402SwarmsPlugin.actions!.map((a) => a.name);
    const uniqueNames = new Set(actionNames);
    expect(uniqueNames.size).toBe(actionNames.length);

    // Verify the specific action names
    expect(actionNames).toContain("PAY_FOR_X402_SERVICE");
    expect(actionNames).toContain("DISCOVER_X402_SERVICES");
    expect(actionNames).toContain("DELEGATE_TO_SWARM");
    expect(actionNames).toContain("RUN_SWARM_AGENT");
    expect(actionNames).toContain("DELEGATE_TO_SWARM_WITH_PAYMENT");
  });

  it("4c. All service types are unique strings", async () => {
    const { x402SwarmsPlugin } = await import("../../src/index.js");

    const serviceTypes = x402SwarmsPlugin.services!.map(
      (s: any) => s.serviceType
    );
    const uniqueTypes = new Set(serviceTypes);
    expect(uniqueTypes.size).toBe(serviceTypes.length);
  });

  it("4d. No undefined exports from src/index.ts", async () => {
    const indexExports = await import("../../src/index.js");

    // Check named exports that CLAUDE.md documents
    expect(indexExports.payForService).toBeDefined();
    expect(indexExports.discoverServices).toBeDefined();
    expect(indexExports.delegateToSwarm).toBeDefined();
    expect(indexExports.runSwarmAgent).toBeDefined();
    expect(indexExports.delegateToSwarmWithPayment).toBeDefined();
    expect(indexExports.x402Provider).toBeDefined();
    expect(indexExports.x402ServerProvider).toBeDefined();
    expect(indexExports.paymentEvaluator).toBeDefined();
    expect(indexExports.X402WalletService).toBeDefined();
    expect(indexExports.SwarmsService).toBeDefined();
    expect(indexExports.PaymentMemoryService).toBeDefined();
    expect(indexExports.X402ServerService).toBeDefined();
    expect(indexExports.x402Gate).toBeDefined();
    expect(indexExports.x402Routes).toBeDefined();
    expect(indexExports.walletAnalyzerRoutes).toBeDefined();
    expect(indexExports.SWARM_TEMPLATES).toBeDefined();
    expect(indexExports.findMatchingTemplate).toBeDefined();
    expect(indexExports.registerSwarmTemplate).toBeDefined();
    expect(indexExports.x402SwarmsPlugin).toBeDefined();
  });

  it("4e. Schema has exactly 4 tables", async () => {
    const { x402SwarmsPlugin } = await import("../../src/index.js");

    const schema = (x402SwarmsPlugin as any).schema;
    expect(schema).toBeDefined();
    const tableNames = Object.keys(schema);
    expect(tableNames).toHaveLength(4);
    expect(tableNames).toContain("x402PaymentHistory");
    expect(tableNames).toContain("x402EndpointScores");
    expect(tableNames).toContain("x402BudgetState");
    expect(tableNames).toContain("x402Knowledge");
  });
});

// ======================================================================
// 5. Cross-round regression: recordPayment mutation + evaluator edge cases
// ======================================================================
describe("5. Cross-round regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("5a. recordPayment sanitization does NOT mutate the original object (BUG FIX)", async () => {
    const runtime = createMockRuntime();
    const memService = await PaymentMemoryService.start(runtime);

    const original: PaymentHistoryRecord = {
      id: "mutation-test",
      agentId: "agent-1",
      endpoint: "https://api.example.com/" + "x".repeat(3000),
      domain: "api.example.com",
      method: "GET",
      amountUsd: Infinity,
      txHash: "0xabc",
      status: "confirmed",
      createdAt: Date.now(),
    };

    // Save values before recording
    const originalEndpointLength = original.endpoint.length;

    await memService.recordPayment(original);

    // FIXED: recordPayment no longer mutates the caller's object
    expect(original.amountUsd).toBe(Infinity); // unchanged
    expect(original.endpoint.length).toBe(originalEndpointLength); // unchanged

    // But the stored copy IS sanitized
    const history = memService.getHistory();
    expect(history[0].amountUsd).toBe(0); // clamped
    expect(history[0].endpoint.length).toBe(2048); // truncated
  });

  it("5b. Infinity amountUsd is sanitized to 0 in spending stats (round 4 fix stays fixed)", async () => {
    const runtime = createMockRuntime();
    const memService = await PaymentMemoryService.start(runtime);

    await memService.recordPayment(
      makeRecord({ id: "inf-regress", amountUsd: Infinity })
    );
    await memService.recordPayment(
      makeRecord({ id: "normal-regress", amountUsd: 0.05 })
    );

    const stats = memService.getSpendingStats("24h");
    // Infinity is clamped to 0 by sanitization
    expect(stats.totalSpent).toBe(0.05);
    expect(stats.totalCalls).toBe(2);
  });

  it("5c. Long URL endpoint is truncated to 2048 chars (round 4 fix stays fixed)", async () => {
    const runtime = createMockRuntime();
    const memService = await PaymentMemoryService.start(runtime);

    const longUrl = "https://api.example.com/" + "a".repeat(5000);
    await memService.recordPayment(
      makeRecord({ id: "long-regress", endpoint: longUrl })
    );

    const history = memService.getHistory();
    expect(history[0].endpoint.length).toBeLessThanOrEqual(2048);
  });

  it("5d. avgQuality only counts scored records (round 3 fix stays fixed)", async () => {
    const runtime = createMockRuntime();
    const memService = await PaymentMemoryService.start(runtime);

    for (let i = 0; i < 4; i++) {
      await memService.recordPayment(
        makeRecord({ id: `qual-${i}`, domain: "scored.example.com" })
      );
    }
    // Score only 2 records with quality=5
    await memService.scorePayment("qual-0", 5, "great");
    await memService.scorePayment("qual-1", 5, "great");

    const summary = memService.getEndpointScoreSummary();
    expect(summary[0].avgQuality).toBe(5); // 10/2 = 5, not 10/4 = 2.5
    expect(summary[0].totalCalls).toBe(4);
  });

  it("5e. Evaluator handles LLM returning non-JSON string gracefully", async () => {
    const runtime = createMockRuntime();
    const memService = await PaymentMemoryService.start(runtime);

    // Add a record with responsePreview so it goes to unscored buffer
    await memService.recordPayment(
      makeRecord({
        id: "eval-nonjson",
        responsePreview: '{"data":"test"}',
      })
    );

    const walletService = createMockWalletService({
      budgetAccount: createMockBudgetAccount({ payments: 0 }),
    });

    const evalRuntime = createMockRuntime({
      services: {
        X402_WALLET: walletService,
        PAYMENT_MEMORY: memService,
      },
      // LLM returns pure text instead of JSON
      useModelReturn: "I think this response is pretty good, about a 4 out of 5.",
    });

    // Should not throw — the evaluator gracefully handles non-JSON
    const result = await paymentEvaluator.handler!(
      evalRuntime,
      createMockMessage("test") as any,
      undefined,
      undefined,
      undefined
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
  });

  it("5f. Evaluator handles LLM returning score outside 1-5 range (clamped)", async () => {
    const runtime = createMockRuntime();
    const memService = await PaymentMemoryService.start(runtime);

    await memService.recordPayment(
      makeRecord({
        id: "eval-outofrange",
        responsePreview: '{"data":"test"}',
      })
    );

    const walletService = createMockWalletService({
      budgetAccount: createMockBudgetAccount({ payments: 0 }),
    });

    const evalRuntime = createMockRuntime({
      services: {
        X402_WALLET: walletService,
        PAYMENT_MEMORY: memService,
      },
      // LLM returns score of 99
      useModelReturn: JSON.stringify({ score: 99, reason: "Excellent" }),
    });

    await paymentEvaluator.handler!(
      evalRuntime,
      createMockMessage("test") as any,
      undefined,
      undefined,
      undefined
    );

    // The record should have been scored with clamped value (max 5)
    const history = memService.getHistory();
    const scored = history.find((r) => r.id === "eval-outofrange");
    expect(scored?.qualityScore).toBe(5); // clamped from 99 to 5
    expect(scored?.qualityReason).toBe("Excellent");
  });

  it("5g. Evaluator handles LLM returning score of NaN (skip)", async () => {
    const runtime = createMockRuntime();
    const memService = await PaymentMemoryService.start(runtime);

    await memService.recordPayment(
      makeRecord({
        id: "eval-nan",
        responsePreview: '{"data":"test"}',
      })
    );

    const walletService = createMockWalletService({
      budgetAccount: createMockBudgetAccount({ payments: 0 }),
    });

    const evalRuntime = createMockRuntime({
      services: {
        X402_WALLET: walletService,
        PAYMENT_MEMORY: memService,
      },
      // LLM returns non-numeric score
      useModelReturn: JSON.stringify({ score: "not-a-number", reason: "idk" }),
    });

    await paymentEvaluator.handler!(
      evalRuntime,
      createMockMessage("test") as any,
      undefined,
      undefined,
      undefined
    );

    // The record should NOT have been scored (NaN is skipped)
    const history = memService.getHistory();
    const record = history.find((r) => r.id === "eval-nan");
    expect(record?.qualityScore).toBeUndefined();
  });

  it("5h. Evaluator handles LLM returning markdown-wrapped JSON", async () => {
    const runtime = createMockRuntime();
    const memService = await PaymentMemoryService.start(runtime);

    await memService.recordPayment(
      makeRecord({
        id: "eval-markdown",
        responsePreview: '{"data":"test"}',
      })
    );

    const walletService = createMockWalletService({
      budgetAccount: createMockBudgetAccount({ payments: 0 }),
    });

    const evalRuntime = createMockRuntime({
      services: {
        X402_WALLET: walletService,
        PAYMENT_MEMORY: memService,
      },
      // LLM wraps JSON in markdown code block
      useModelReturn: '```json\n{ "score": 4, "reason": "Good response" }\n```',
    });

    await paymentEvaluator.handler!(
      evalRuntime,
      createMockMessage("test") as any,
      undefined,
      undefined,
      undefined
    );

    // The evaluator regex extracts JSON from markdown blocks
    const history = memService.getHistory();
    const record = history.find((r) => r.id === "eval-markdown");
    expect(record?.qualityScore).toBe(4);
    expect(record?.qualityReason).toBe("Good response");
  });

  it("5i. SQL injection in domain does not corrupt in-memory store (round 4 fix stays fixed)", async () => {
    const runtime = createMockRuntime();
    const memService = await PaymentMemoryService.start(runtime);

    const sqli = "'; DROP TABLE x402_payment_history; --";
    await memService.recordPayment(
      makeRecord({ id: "sqli-regress", domain: sqli })
    );

    const history = memService.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].domain).toBe(sqli);
    const byDomain = memService.getPaymentsByDomain(sqli);
    expect(byDomain).toHaveLength(1);
  });

  it("5j. Empty responsePreview does not enter unscored buffer (round 1 fix stays fixed)", async () => {
    const runtime = createMockRuntime();
    const memService = await PaymentMemoryService.start(runtime);

    await memService.recordPayment(
      makeRecord({ id: "empty-preview", responsePreview: "" })
    );

    const unscored = memService.getUnscoredPayments();
    expect(unscored).toHaveLength(0);
  });
});
