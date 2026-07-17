import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";

// Mock x402Gate so we can control payment gate behavior
vi.mock("../../src/server/x402Gate.js", () => ({
  x402Gate: vi.fn(async () => ({
    paid: true,
    transaction: "tx-batch-123",
    network: "base-mainnet",
    amountUsd: 0.04,
  })),
}));

// Mock callOpenAI used by single-agent task executors
vi.mock("../../src/utils/llm.js", () => ({
  callOpenAI: vi.fn(async () => "mock LLM response"),
}));

// Mock swarm templates used by multi-agent task executors
vi.mock("../../src/templates/swarmTemplates.js", () => ({
  codeReviewTemplate: {
    agents: [
      { agent_name: "SecurityAuditor", system_prompt: "audit", model_name: "gpt-5-mini", role: "worker", max_loops: 1 },
    ],
    swarmType: "ConcurrentWorkflow",
    maxLoops: 1,
  },
  researchPipelineTemplate: {
    agents: [
      { agent_name: "Researcher", system_prompt: "research", model_name: "gpt-5-mini", role: "worker", max_loops: 1 },
    ],
    swarmType: "SequentialWorkflow",
    maxLoops: 1,
    rules: "Research then write",
  },
  analysisPanelTemplate: {
    agents: [
      { agent_name: "Analyst", system_prompt: "analyze", model_name: "gpt-5-mini", role: "worker", max_loops: 1 },
    ],
    swarmType: "MixtureOfAgents",
    maxLoops: 1,
  },
  debateAndDecideTemplate: {
    agents: [
      { agent_name: "Proponent", system_prompt: "argue for", model_name: "gpt-5-mini", role: "worker", max_loops: 1 },
    ],
    swarmType: "SequentialWorkflow",
    maxLoops: 1,
  },
}));

import { batchRoutes, calculateBatchPrice, BATCH_CATALOG } from "../../src/routes/batchRoutes.js";
import { x402Gate } from "../../src/server/x402Gate.js";
import { callOpenAI } from "../../src/utils/llm.js";

function createMockRes() {
  const res: any = {
    status: vi.fn(() => res),
    json: vi.fn(),
    setHeader: vi.fn(),
  };
  return res;
}

function createMockSwarmsService(output: string = "mock swarm output") {
  return {
    isAvailable: vi.fn(() => true),
    runSwarm: vi.fn(async () => ({ output })),
    runAgent: vi.fn(async () => ({ outputs: output })),
  };
}

describe("batchRoutes", () => {
  const route = batchRoutes.find(
    (r) => r.path === "/x402/batch" && r.type === "POST"
  );

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes
    (x402Gate as any).mockResolvedValue({
      paid: true,
      transaction: "tx-batch-123",
      network: "base-mainnet",
      amountUsd: 0.04,
    });
  });

  it("route exists", () => {
    expect(route).toBeDefined();
  });

  it("exports BATCH_CATALOG with the batch endpoint entry", () => {
    expect(BATCH_CATALOG).toHaveLength(1);
    expect(BATCH_CATALOG[0].path).toBe("/x402/batch");
    expect(BATCH_CATALOG[0].method).toBe("POST");
  });

  // ── Validation tests ──────────────────────────────────────────────────

  describe("validation", () => {
    it("returns 400 for missing tasks array", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("tasks") })
      );
    });

    it("returns 400 for non-array tasks", async () => {
      const req = { body: { tasks: "not an array" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("tasks") })
      );
    });

    it("returns 400 for empty tasks array", async () => {
      const req = { body: { tasks: [] } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("empty") })
      );
    });

    it("returns 400 for too many tasks (>10)", async () => {
      const tasks = Array.from({ length: 11 }, (_, i) => ({
        endpoint: "summarize",
        params: { text: `text ${i}` },
      }));
      const req = { body: { tasks } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("maximum 10") })
      );
    });

    it("returns 400 for invalid endpoint name", async () => {
      const req = {
        body: {
          tasks: [{ endpoint: "nonexistent-endpoint", params: { text: "hello" } }],
        },
      } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("Unknown endpoint") })
      );
    });

    it("returns 400 for task without params object", async () => {
      const req = {
        body: {
          tasks: [{ endpoint: "summarize" }],
        },
      } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("params") })
      );
    });
  });

  // ── Discount calculation tests ────────────────────────────────────────

  describe("calculateBatchPrice", () => {
    it("calculates correct discount for two summarize tasks", () => {
      const result = calculateBatchPrice(["summarize", "summarize"]);
      // 0.02 + 0.02 = 0.04, 20% off = 0.032
      expect(result.originalTotal).toBe("0.04");
      expect(result.discountedTotal).toBe("0.03");
    });

    it("calculates correct discount for mixed tasks", () => {
      const result = calculateBatchPrice(["summarize", "contract-audit", "sentiment"]);
      // 0.02 + 0.10 + 0.01 = 0.13, 20% off = 0.104
      expect(result.originalTotal).toBe("0.13");
      expect(result.discountedTotal).toBe("0.10");
    });

    it("throws for unknown endpoint", () => {
      expect(() => calculateBatchPrice(["fake-endpoint"])).toThrow("Unknown endpoint");
    });

    it("handles single task", () => {
      const result = calculateBatchPrice(["contract-audit"]);
      // 0.10 * 0.80 = 0.08
      expect(result.originalTotal).toBe("0.10");
      expect(result.discountedTotal).toBe("0.08");
    });
  });

  // ── Gate not paid ─────────────────────────────────────────────────────

  describe("gate not paid", () => {
    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false, amountUsd: 0 });

      const req = {
        body: {
          tasks: [{ endpoint: "summarize", params: { text: "hello" } }],
        },
      } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      // res.json should not be called (the gate sends 402 internally)
      expect(res.json).not.toHaveBeenCalled();
    });

    it("calls x402Gate with the discounted total", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false, amountUsd: 0 });

      const req = {
        body: {
          tasks: [
            { endpoint: "summarize", params: { text: "hello" } },
            { endpoint: "sentiment", params: { text: "great" } },
          ],
        },
      } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      // 0.02 + 0.01 = 0.03, 20% off = 0.024 → "0.02"
      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({
          amountUsd: "0.02",
          description: expect.stringContaining("2 tasks"),
        })
      );
    });
  });

  // ── Successful batch execution ────────────────────────────────────────

  describe("successful batch", () => {
    it("executes multiple tasks in parallel and returns results", async () => {
      (callOpenAI as any).mockResolvedValue("mock LLM response");

      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "sk-test-key" },
      });
      const req = {
        body: {
          tasks: [
            { endpoint: "summarize", params: { text: "A long article about AI." } },
            { endpoint: "sentiment", params: { text: "I love this product!" } },
          ],
        },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledTimes(1);
      const response = res.json.mock.calls[0][0];

      expect(response.results).toHaveLength(2);
      expect(response.results[0].endpoint).toBe("summarize");
      expect(response.results[0].status).toBe("success");
      expect(response.results[0].data).toBeDefined();
      expect(response.results[1].endpoint).toBe("sentiment");
      expect(response.results[1].status).toBe("success");

      expect(response.payment).toEqual(
        expect.objectContaining({
          discount: "20%",
          transaction: "tx-batch-123",
          network: "base-mainnet",
        })
      );
      expect(response.template).toBe("Batch");
    });

    it("handles mixed success and error results", async () => {
      // summarize will succeed (via callOpenAI mock)
      (callOpenAI as any).mockResolvedValue("mock summary");

      // No Swarms service → contract-audit executor will throw
      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "sk-test-key" },
        services: {},
      });
      const req = {
        body: {
          tasks: [
            { endpoint: "summarize", params: { text: "Hello world" } },
            { endpoint: "contract-audit", params: { code: "pragma solidity..." } },
          ],
        },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const response = res.json.mock.calls[0][0];
      expect(response.results).toHaveLength(2);

      // summarize should succeed
      expect(response.results[0].endpoint).toBe("summarize");
      expect(response.results[0].status).toBe("success");

      // contract-audit should fail (no Swarms service)
      expect(response.results[1].endpoint).toBe("contract-audit");
      expect(response.results[1].status).toBe("error");
      expect(response.results[1].error).toContain("Swarms service unavailable");
    });

    it("returns correct payment info with discount", async () => {
      (callOpenAI as any).mockResolvedValue("mock response");

      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "sk-test-key" },
      });
      const req = {
        body: {
          tasks: [
            { endpoint: "summarize", params: { text: "Hello" } },
            { endpoint: "translate", params: { text: "Hello", targetLanguage: "Spanish" } },
            { endpoint: "sentiment", params: { text: "Great!" } },
          ],
        },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const response = res.json.mock.calls[0][0];
      // 0.02 + 0.02 + 0.01 = 0.05, 20% off = 0.04
      expect(response.payment.amount).toBe("0.04");
      expect(response.payment.originalAmount).toBe("0.05");
      expect(response.payment.discount).toBe("20%");
    });
  });

  // ── Multi-agent tasks with Swarms service ─────────────────────────────

  describe("multi-agent tasks", () => {
    it("executes code-review via Swarms service", async () => {
      const mockSwarms = createMockSwarmsService("review output");
      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "sk-test-key" },
        services: { SWARMS: mockSwarms },
      });

      const req = {
        body: {
          tasks: [
            { endpoint: "code-review", params: { code: "function foo() { return 1; }" } },
          ],
        },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalled();
      const response = res.json.mock.calls[0][0];
      expect(response.results[0].status).toBe("success");
      expect(response.results[0].data.output).toBe("review output");
    });

    it("reports error when executor params are invalid", async () => {
      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "sk-test-key" },
      });

      // summarize with missing text param
      const req = {
        body: {
          tasks: [
            { endpoint: "summarize", params: {} },
          ],
        },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const response = res.json.mock.calls[0][0];
      expect(response.results[0].status).toBe("error");
      expect(response.results[0].error).toContain("text");
    });
  });
});
