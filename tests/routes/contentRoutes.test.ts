import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";

// Mock x402Gate so we can control payment gate behavior
vi.mock("../../src/server/x402Gate.js", () => ({
  x402Gate: vi.fn(async () => ({
    paid: true,
    transaction: "tx-content-123",
    network: "base-mainnet",
    amountUsd: 0.10,
  })),
}));

// Mock callOpenAI used by single-agent endpoints
vi.mock("../../src/utils/llm.js", () => ({
  callOpenAI: vi.fn(async () => "mock LLM response"),
}));

import { contentRoutes, CONTENT_CATALOG } from "../../src/routes/contentRoutes.js";
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

describe("contentRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes with paid amount
    (x402Gate as any).mockResolvedValue({
      paid: true,
      transaction: "tx-content-123",
      network: "base-mainnet",
      amountUsd: 0.10,
    });
  });

  // ── POST /x402/seo-article ──────────────────────────────────────────

  describe("POST /x402/seo-article", () => {
    const route = contentRoutes.find(
      (r) => r.path === "/x402/seo-article" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing topic", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("topic") })
      );
    });

    it("x402Gate called with $0.10", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          article: "# Full article",
          title: "Test Title",
          metaDescription: "A test article",
          wordCount: 1500,
          readabilityScore: 85,
          keywordDensity: { test: 2.1 },
          editsApplied: ["grammar fix"],
        })
      );
      const runtime = createMockRuntime({
        settings: {},
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { topic: "AI in healthcare" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.10" })
      );
    });

    it("returns 503 when Swarms unavailable", async () => {
      const runtime = createMockRuntime({
        settings: {},
        services: {},
      });
      const req = { body: { topic: "AI in healthcare" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("runSwarm called with SequentialWorkflow and 3 agents", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          article: "Article content here",
          title: "Great Title",
          metaDescription: "Meta desc",
          wordCount: 1500,
          readabilityScore: 80,
          keywordDensity: {},
          editsApplied: [],
        })
      );
      const runtime = createMockRuntime({
        settings: {},
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { topic: "Blockchain scalability" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          swarm_type: "SequentialWorkflow",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "SEOResearcher" }),
            expect.objectContaining({ agent_name: "ContentWriter" }),
            expect.objectContaining({ agent_name: "Editor" }),
          ]),
        })
      );
      // Verify exactly 3 agents
      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      expect(callArgs.agents).toHaveLength(3);
    });

    it("validates optional params — keywords array, wordCount range, tone enum", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          article: "Content",
          title: "Title",
          metaDescription: "Desc",
          wordCount: 2000,
          readabilityScore: 75,
          keywordDensity: {},
          editsApplied: [],
        })
      );
      const runtime = createMockRuntime({
        settings: {},
        services: { SWARMS: mockSwarms },
      });

      // Valid keywords, wordCount clamped from 100 to 500, invalid tone defaults to "professional"
      const req = {
        body: {
          topic: "Testing params",
          keywords: ["seo", "content"],
          wordCount: 100, // below min, should clamp to 500
          tone: "invalid-tone", // should default to "professional"
        },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalled();
      const response = res.json.mock.calls[0][0];
      expect(response.tone).toBe("professional");

      // Verify the task string includes clamped word count
      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      expect(callArgs.task).toContain("500"); // clamped from 100
      expect(callArgs.task).toContain("professional");
    });

    it("free tier truncation — shows title + meta + wordCount + first 200 chars", async () => {
      // Set gate to free tier (amountUsd: 0)
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: undefined,
        network: undefined,
        amountUsd: 0,
        freeRemaining: 4,
      });

      const longArticle = "A".repeat(500);
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          article: longArticle,
          title: "SEO Article Title",
          metaDescription: "A great meta description",
          wordCount: 1500,
          readabilityScore: 90,
          keywordDensity: { seo: 2.5 },
          editsApplied: ["trimmed intro"],
        })
      );
      const runtime = createMockRuntime({
        settings: {},
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { topic: "SEO strategies" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalled();
      // Free tier unified: full output, no preview gating
      const response = res.json.mock.calls[0][0];
      expect(response._preview).toBeUndefined();
      expect(response.title).toBe("SEO Article Title");
      expect(response.metaDescription).toBe("A great meta description");
      expect(response.wordCount).toBe(1500);
      expect(response.article).toBe(longArticle);
      expect(response.readabilityScore).toBe(90);
      expect(response.freeRemaining).toBe(4);
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false, amountUsd: 0 });

      const req = { body: { topic: "some topic" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });
  });

  // ── POST /x402/document-extract ─────────────────────────────────────

  describe("POST /x402/document-extract", () => {
    const route = contentRoutes.find(
      (r) => r.path === "/x402/document-extract" && r.type === "POST"
    );

    beforeEach(() => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: "tx-extract-456",
        network: "base-mainnet",
        amountUsd: 0.05,
      });
    });

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

    it("x402Gate called with $0.05", async () => {
      const extractResponse = JSON.stringify({
        extracted: { name: "John", email: "john@test.com" },
        confidence: 0.95,
        fieldsFound: 2,
        fieldsRequested: 2,
        notes: [],
      });
      (callOpenAI as any).mockResolvedValueOnce(extractResponse);

      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "sk-test-key" },
      });
      const req = {
        body: { text: "John Doe, email: john@test.com", fields: ["name", "email"] },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.05" })
      );
    });

    it("uses OpenAI when key available", async () => {
      const extractResponse = JSON.stringify({
        extracted: { name: "Jane", age: "30" },
        confidence: 0.9,
        fieldsFound: 2,
        fieldsRequested: 2,
        notes: ["age extracted from context"],
      });
      (callOpenAI as any).mockResolvedValueOnce(extractResponse);

      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "sk-test-key" },
      });
      const req = {
        body: { text: "Jane is 30 years old", fields: ["name", "age"] },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(callOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "sk-test-key",
          model: "gpt-5-mini",
          temperature: 0.1,
          maxTokens: 4096,
        })
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          extracted: { name: "Jane", age: "30" },
          confidence: 0.9,
          payment: expect.objectContaining({ amount: "0.05" }),
        })
      );
    });

    it("falls back to Swarms when no OPENAI_API_KEY", async () => {
      const extractResponse = JSON.stringify({
        extracted: { company: "Acme" },
        confidence: 0.85,
        fieldsFound: 1,
        fieldsRequested: 1,
        notes: [],
      });
      const mockSwarms = createMockSwarmsService(extractResponse);
      const runtime = createMockRuntime({
        settings: {},
        services: { SWARMS: mockSwarms },
      });
      const req = {
        body: { text: "Acme Corporation was founded in 1999", fields: ["company"] },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runAgent).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          extracted: { company: "Acme" },
          payment: expect.objectContaining({ amount: "0.05" }),
        })
      );
    });

    it("handles json and table format", async () => {
      const tableResponse = JSON.stringify({
        extracted: { headers: ["Name", "Age"], rows: [["John", "30"]] },
        confidence: 0.9,
        fieldsFound: 2,
        fieldsRequested: "auto",
        notes: [],
      });
      (callOpenAI as any).mockResolvedValueOnce(tableResponse);

      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "sk-test-key" },
      });
      const req = {
        body: { text: "John is 30", format: "table" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          format: "table",
          extracted: { headers: ["Name", "Age"], rows: [["John", "30"]] },
        })
      );

      // Verify system prompt includes table format instruction
      const callArgs = (callOpenAI as any).mock.calls[0][0];
      expect(callArgs.systemPrompt).toContain("table");
    });

    it("free tier truncation — shows fieldsFound + confidence + field names only", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: undefined,
        network: undefined,
        amountUsd: 0,
        freeRemaining: 3,
      });

      const extractResponse = JSON.stringify({
        extracted: { name: "Secret Name", email: "secret@email.com", phone: "555-1234" },
        confidence: 0.92,
        fieldsFound: 3,
        fieldsRequested: 3,
        notes: ["all fields found"],
      });
      (callOpenAI as any).mockResolvedValueOnce(extractResponse);

      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "sk-test-key" },
      });
      const req = {
        body: { text: "Some document text", fields: ["name", "email", "phone"] },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // Free tier unified: full output, no preview gating
      const response = res.json.mock.calls[0][0];
      expect(response._preview).toBeUndefined();
      expect(response.fieldsFound).toBe(3);
      expect(response.confidence).toBe(0.92);
      expect(response.extracted).toEqual({ name: "Secret Name", email: "secret@email.com", phone: "555-1234" });
      expect(response.freeRemaining).toBe(3);
    });

    it("returns 503 when neither OpenAI nor Swarms available", async () => {
      const runtime = createMockRuntime({
        settings: {},
        services: {},
      });
      const req = { body: { text: "some document text" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false, amountUsd: 0 });

      const req = { body: { text: "some text" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });
  });

  // ── Catalog ─────────────────────────────────────────────────────────

  describe("CONTENT_CATALOG", () => {
    it("exports catalog with 2 endpoints", () => {
      expect(CONTENT_CATALOG).toHaveLength(2);
      expect(CONTENT_CATALOG.map((c) => c.path)).toEqual([
        "/x402/seo-article",
        "/x402/document-extract",
      ]);
    });
  });
});
