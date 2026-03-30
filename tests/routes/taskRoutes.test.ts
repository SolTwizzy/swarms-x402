import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";

// Mock x402Gate so we can control payment gate behavior
vi.mock("../../src/server/x402Gate.js", () => ({
  x402Gate: vi.fn(async () => ({
    paid: true,
    transaction: "tx-task-123",
    network: "base-mainnet",
  })),
}));

// Mock callOpenAI used by single-agent task endpoints
vi.mock("../../src/utils/llm.js", () => ({
  callOpenAI: vi.fn(async () => "mock LLM response"),
}));

// Mock swarm templates used by multi-agent task endpoints
vi.mock("../../src/templates/swarmTemplates.js", () => ({
  codeReviewTemplate: {
    agents: [
      { agent_name: "SecurityAuditor", system_prompt: "audit", model_name: "gpt-4o", role: "worker", max_loops: 1 },
    ],
    swarmType: "ConcurrentWorkflow",
    maxLoops: 1,
  },
  researchPipelineTemplate: {
    agents: [
      { agent_name: "Researcher", system_prompt: "research", model_name: "gpt-4o", role: "worker", max_loops: 1 },
    ],
    swarmType: "SequentialWorkflow",
    maxLoops: 1,
    rules: "Research then write",
  },
  debateAndDecideTemplate: {
    agents: [
      { agent_name: "Proponent", system_prompt: "argue for", model_name: "gpt-4o", role: "worker", max_loops: 1 },
    ],
    swarmType: "SequentialWorkflow",
    maxLoops: 1,
  },
}));

import { taskRoutes } from "../../src/routes/taskRoutes.js";
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

function createMockSwarmsService(output: string = "mock output") {
  return {
    isAvailable: vi.fn(() => true),
    runSwarm: vi.fn(async () => ({ output })),
    runAgent: vi.fn(async () => ({ outputs: output })),
  };
}

describe("taskRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes
    (x402Gate as any).mockResolvedValue({
      paid: true,
      transaction: "tx-task-123",
      network: "base-mainnet",
    });
  });

  // ── POST /x402/summarize ───────────────────────────────────────────

  describe("POST /x402/summarize", () => {
    const route = taskRoutes.find(
      (r) => r.path === "/x402/summarize" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing text", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("text") })
      );
    });

    it("returns 400 for empty text string", async () => {
      const req = { body: { text: "   " } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("uses OpenAI directly when OPENAI_API_KEY is set", async () => {
      (callOpenAI as any).mockResolvedValueOnce("This is a summary of the text.");

      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "sk-test-key" },
      });
      const req = { body: { text: "A long article about blockchain technology..." } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(callOpenAI).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: "This is a summary of the text.",
          wordCount: expect.any(Number),
          payment: expect.objectContaining({ amount: "0.01" }),
        })
      );
    });

    it("falls back to Swarms when no OPENAI_API_KEY", async () => {
      const mockSwarms = createMockSwarmsService("Swarms summary output");
      const runtime = createMockRuntime({
        settings: {},
        services: { SWARMS: mockSwarms },
      });

      const req = { body: { text: "A long article..." } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runAgent).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: expect.any(String),
          payment: expect.objectContaining({ amount: "0.01" }),
        })
      );
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const req = { body: { text: "some text" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });
  });

  // ── POST /x402/translate ───────────────────────────────────────────

  describe("POST /x402/translate", () => {
    const route = taskRoutes.find(
      (r) => r.path === "/x402/translate" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing text", async () => {
      const req = { body: { targetLanguage: "Spanish" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("text") })
      );
    });

    it("returns 400 for missing targetLanguage", async () => {
      const req = { body: { text: "Hello world" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("targetLanguage") })
      );
    });

    it("returns 400 when both text and targetLanguage are missing", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("uses OpenAI directly when OPENAI_API_KEY is set", async () => {
      (callOpenAI as any).mockResolvedValueOnce(
        JSON.stringify({ translation: "Hola mundo", sourceLanguage: "English" })
      );

      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "sk-test-key" },
      });
      const req = {
        body: { text: "Hello world", targetLanguage: "Spanish" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(callOpenAI).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          translation: "Hola mundo",
          sourceLanguage: "English",
          targetLanguage: "Spanish",
          payment: expect.objectContaining({ amount: "0.02" }),
        })
      );
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const req = {
        body: { text: "Hello world", targetLanguage: "Spanish" },
      } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });
  });

  // ── POST /x402/sentiment ───────────────────────────────────────────

  describe("POST /x402/sentiment", () => {
    const route = taskRoutes.find(
      (r) => r.path === "/x402/sentiment" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing text", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("text") })
      );
    });

    it("returns 400 for empty text string", async () => {
      const req = { body: { text: "" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("uses OpenAI and parses structured sentiment response", async () => {
      (callOpenAI as any).mockResolvedValueOnce(
        JSON.stringify({
          sentiment: "positive",
          confidence: 0.95,
          reasoning: "The text expresses strong enthusiasm",
        })
      );

      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "sk-test-key" },
      });
      const req = { body: { text: "I absolutely love this product!" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(callOpenAI).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          sentiment: "positive",
          confidence: 0.95,
          reasoning: "The text expresses strong enthusiasm",
          payment: expect.objectContaining({ amount: "0.01" }),
        })
      );
    });

    it("returns 503 when neither OpenAI nor Swarms available", async () => {
      const runtime = createMockRuntime({
        settings: {},
        services: {},
      });
      const req = { body: { text: "some text to analyze" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const req = { body: { text: "some text" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });
  });
});
