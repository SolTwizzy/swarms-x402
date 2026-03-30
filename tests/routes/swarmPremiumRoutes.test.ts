import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";

// Mock x402Gate so we can control payment gate behavior
vi.mock("../../src/server/x402Gate.js", () => ({
  x402Gate: vi.fn(async () => ({
    paid: true,
    transaction: "tx-test-premium-123",
    network: "base-mainnet",
    amountUsd: 1.0,
  })),
}));

// Mock heliusDataRoutes exports
vi.mock("../../src/routes/heliusDataRoutes.js", () => ({
  SOLANA_ADDR_RE: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  heliusRpcUrl: vi.fn(() => "https://mock-rpc.example.com"),
  rpcCall: vi.fn(async () => ({ value: [] })),
}));

// Mock callOpenAI
vi.mock("../../src/utils/llm.js", () => ({
  callOpenAI: vi.fn(async () =>
    JSON.stringify({
      verifiedFacts: [
        { claim: "Test claim", verdict: "VERIFIED", confidence: 0.9, note: "Confirmed" },
      ],
      contradictions: [],
      overallReliability: 85,
    }),
  ),
}));

// Mock callGemini
vi.mock("../../src/utils/gemini.js", () => ({
  callGemini: vi.fn(async () =>
    JSON.stringify({
      findings: [
        { claim: "Web finding 1", confidence: "HIGH", source: "Google" },
      ],
      summary: "Research summary from Gemini",
    }),
  ),
}));

// Mock reportStore to avoid disk I/O
vi.mock("../../src/utils/reportStore.js", () => ({
  saveReport: vi.fn(() => "mock-report-id"),
}));

import { swarmPremiumRoutes, SWARM_PREMIUM_CATALOG } from "../../src/routes/swarmPremiumRoutes.js";
import { x402Gate } from "../../src/server/x402Gate.js";
import { rpcCall } from "../../src/routes/heliusDataRoutes.js";
import { callOpenAI } from "../../src/utils/llm.js";
import { callGemini } from "../../src/utils/gemini.js";
import { saveReport } from "../../src/utils/reportStore.js";

// Counter for generating unique targets to avoid cache collisions between tests
let testCounter = 0;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Generate unique Solana address (32-44 base58 chars). */
function uniqueAddr(): string {
  testCounter++;
  let n = testCounter;
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix = B58[n % 58] + suffix;
    n = Math.floor(n / 58);
  }
  return `EPjFWdd5AufqSSqeM2qN1xzybapC8G${suffix}v`;
}

function createMockRes() {
  const res: any = {
    status: vi.fn(() => res),
    json: vi.fn(),
    setHeader: vi.fn(),
  };
  return res;
}

describe("swarmPremiumRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes (paid call)
    (x402Gate as any).mockResolvedValue({
      paid: true,
      transaction: "tx-test-premium-123",
      network: "base-mainnet",
      amountUsd: 1.0,
    });
    // Default rpcCall returns balance data
    (rpcCall as any).mockResolvedValue({ value: 5_000_000_000 });
    // Default callOpenAI returns fact-check result
    (callOpenAI as any).mockResolvedValue(
      JSON.stringify({
        verifiedFacts: [
          { claim: "Test claim", verdict: "VERIFIED", confidence: 0.9, note: "Confirmed" },
        ],
        contradictions: [],
        overallReliability: 85,
      }),
    );
    // Default callGemini returns web findings + synthesis
    (callGemini as any).mockResolvedValue(
      JSON.stringify({
        findings: [
          { claim: "Web finding 1", confidence: "HIGH", source: "Google" },
        ],
        summary: "Research summary from Gemini",
      }),
    );
    (saveReport as any).mockReturnValue("mock-report-id");
  });

  // ════════════════════════════════════════════════════════════════════════
  // Catalog
  // ════════════════════════════════════════════════════════════════════════

  describe("SWARM_PREMIUM_CATALOG", () => {
    it("exports 2 catalog entries", () => {
      expect(SWARM_PREMIUM_CATALOG).toHaveLength(2);
    });

    it("has correct paths", () => {
      const paths = SWARM_PREMIUM_CATALOG.map((e) => e.path);
      expect(paths).toContain("/swarm/deep-research");
      expect(paths).toContain("/swarm/monitor");
    });

    it("has correct prices", () => {
      const byPath = Object.fromEntries(SWARM_PREMIUM_CATALOG.map((e) => [e.path, e.priceUsd]));
      expect(byPath["/swarm/deep-research"]).toBe("1.00");
      expect(byPath["/swarm/monitor"]).toBe("0.10");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /swarm/deep-research
  // ════════════════════════════════════════════════════════════════════════

  describe("POST /swarm/deep-research", () => {
    const route = swarmPremiumRoutes.find(
      (r) => r.path === "/swarm/deep-research" && r.type === "POST",
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
        expect.objectContaining({ error: expect.stringContaining("topic") }),
      );
    });

    it("returns 400 for empty topic string", async () => {
      const req = { body: { topic: "   " } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 400 for topic over 500 chars", async () => {
      const req = { body: { topic: "x".repeat(501) } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("500") }),
      );
    });

    it("calls x402Gate with $1.00", async () => {
      const runtime = createMockRuntime({
        settings: { GEMINI_API_KEY: "test-gemini", OPENAI_API_KEY: "test-openai" },
      });
      const req = { body: { topic: "Bitcoin price analysis" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "1.00" }),
      );
    });

    it("returns 503 when no LLM keys configured", async () => {
      const runtime = createMockRuntime({
        settings: {},
      });
      const req = { body: { topic: "Some topic" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("LLM") }),
      );
    });

    it("calls Gemini with grounding for web research", async () => {
      const runtime = createMockRuntime({
        settings: { GEMINI_API_KEY: "test-gemini", OPENAI_API_KEY: "test-openai" },
      });
      const req = { body: { topic: "Solana ecosystem growth" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // Gemini should be called at least once (web research + possibly synthesis)
      expect(callGemini).toHaveBeenCalled();
      // First call should have grounding enabled (web research)
      const firstCall = (callGemini as any).mock.calls[0][0];
      expect(firstCall.groundingEnabled).toBe(true);
    });

    it("calls OpenAI for fact-check step", async () => {
      const runtime = createMockRuntime({
        settings: { GEMINI_API_KEY: "test-gemini", OPENAI_API_KEY: "test-openai" },
      });
      const req = { body: { topic: "Ethereum merge analysis" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // OpenAI should be called for fact-checking
      expect(callOpenAI).toHaveBeenCalled();
      const factCheckCall = (callOpenAI as any).mock.calls.find(
        (c: any[]) => c[0].systemPrompt.includes("fact-checker"),
      );
      expect(factCheckCall).toBeDefined();
    });

    it("falls back to OpenAI when no Gemini key", async () => {
      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const req = { body: { topic: "DeFi analysis" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // Should not call Gemini
      expect(callGemini).not.toHaveBeenCalled();
      // Should call OpenAI for all steps
      expect(callOpenAI).toHaveBeenCalled();
    });

    it("detects on-chain address in topic and fetches data", async () => {
      const runtime = createMockRuntime({
        settings: {
          OPENAI_API_KEY: "test-openai",
          HELIUS_API_KEY: "test-helius",
        },
      });
      // Include a Solana address in the topic
      const req = {
        body: { topic: "Analysis of EPjFWdd5AufqSSqeM2qN1xzybapC8G4wJGETjyh7A7v" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // rpcCall should be called for on-chain data
      expect(rpcCall).toHaveBeenCalled();
    });

    it("returns full report structure for paid call", async () => {
      // Make Gemini return a proper report for synthesis
      (callGemini as any).mockImplementation(async (opts: any) => {
        if (opts.systemPrompt.includes("research report writer")) {
          return "# Executive Summary\n\nThis is a comprehensive report.\n\n# Key Findings\n\n1. Finding one [VERIFIED]\n\n# Conclusions\n\nOverall positive outlook.";
        }
        return JSON.stringify({
          findings: [{ claim: "Test", confidence: "HIGH", source: "Web" }],
          summary: "Summary",
        });
      });

      const runtime = createMockRuntime({
        settings: { GEMINI_API_KEY: "test-gemini", OPENAI_API_KEY: "test-openai" },
      });
      const req = { body: { topic: "Bitcoin ETF impact", focus: "institutional adoption" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: "Bitcoin ETF impact",
          focus: "institutional adoption",
          template: "DeepResearch",
          report: expect.any(String),
          agentsUsed: expect.any(Array),
          sourcesQueried: expect.any(Array),
          factCheck: expect.objectContaining({
            overallReliability: expect.any(Number),
          }),
          disclaimer: expect.stringContaining("AI-generated"),
          payment: expect.objectContaining({ amount: "1.00" }),
        }),
      );
    });

    it("saves report on successful execution", async () => {
      const runtime = createMockRuntime({
        settings: { GEMINI_API_KEY: "test-gemini", OPENAI_API_KEY: "test-openai" },
      });
      const req = { body: { topic: "Solana DeFi growth" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "deep-research",
          paid: true,
        }),
      );
    });

    it("truncates for free tier", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: null,
        network: "base-mainnet",
        amountUsd: 0,
        freeRemaining: 9,
      });

      const runtime = createMockRuntime({
        settings: { GEMINI_API_KEY: "test-gemini", OPENAI_API_KEY: "test-openai" },
      });
      const req = { body: { topic: "Free tier research" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          _preview: true,
          _message: expect.stringContaining("$1.00"),
          template: "DeepResearch",
        }),
      );
      // Should NOT have full report
      const response = (res.json as any).mock.calls[0][0];
      expect(response.report).toBeUndefined();
      expect(response.factCheck).toBeUndefined();
    });

    it("returns early when gate not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const req = { body: { topic: "Any topic" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });

    it("respects custom sources filter", async () => {
      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const req = {
        body: { topic: "Test topic", sources: ["web"] },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // Should include web in sourcesQueried but not onchain
      const response = (res.json as any).mock.calls[0][0];
      expect(response.sources).toEqual(["web"]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /swarm/monitor
  // ════════════════════════════════════════════════════════════════════════

  describe("POST /swarm/monitor", () => {
    const route = swarmPremiumRoutes.find(
      (r) => r.path === "/swarm/monitor" && r.type === "POST",
    );

    beforeEach(() => {
      // Override gate for monitor pricing
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: "tx-test-monitor-123",
        network: "base-mainnet",
        amountUsd: 0.1,
      });
      // Override callOpenAI for alert analysis
      (callOpenAI as any).mockResolvedValue(
        JSON.stringify({
          status: "NORMAL",
          triggeredAlerts: [],
          summary: "All signals within normal range",
          nextCheckRecommended: "15m",
        }),
      );
    });

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing target", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("target") }),
      );
    });

    it("returns 400 for empty target string", async () => {
      const req = { body: { target: "" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("calls x402Gate with $0.10", async () => {
      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "test-openai", HELIUS_API_KEY: "test-helius" },
      });
      const target = uniqueAddr();
      const req = {
        body: { target, type: "token" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.10" }),
      );
    });

    it("returns 503 when no LLM keys configured", async () => {
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-helius" },
      });
      const target = uniqueAddr();
      const req = {
        body: { target, type: "token" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("returns NORMAL status when no alerts", async () => {
      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "test-openai", HELIUS_API_KEY: "test-helius" },
      });
      const target = uniqueAddr();
      const req = {
        body: { target, type: "token" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "NORMAL",
          template: "Monitor",
          signals: expect.any(Array),
          summary: expect.any(String),
          nextCheckRecommended: expect.any(String),
          payment: expect.objectContaining({ amount: "0.10" }),
        }),
      );
    });

    it("returns ALERT status when thresholds crossed", async () => {
      (callOpenAI as any).mockResolvedValue(
        JSON.stringify({
          status: "ALERT",
          triggeredAlerts: [
            { signal: "SOL Balance", threshold: "10", actual: "2.5", severity: "high" },
          ],
          summary: "Balance dropped below threshold",
          nextCheckRecommended: "5m",
        }),
      );

      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "test-openai", HELIUS_API_KEY: "test-helius" },
      });
      const target = uniqueAddr();
      const req = {
        body: {
          target,
          type: "wallet",
          thresholds: { balance_min: 10 },
        },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "ALERT",
          triggeredAlerts: expect.arrayContaining([
            expect.objectContaining({ severity: "high" }),
          ]),
        }),
      );
    });

    it("calls rpcCall for on-chain data when target is Solana address", async () => {
      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "test-openai", HELIUS_API_KEY: "test-helius" },
      });
      const target = uniqueAddr();
      const req = {
        body: { target, type: "wallet" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(rpcCall).toHaveBeenCalled();
    });

    it("handles non-Solana target gracefully", async () => {
      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const req = {
        body: { target: "uniswap-v3", type: "protocol" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // Should still return a response (with limited signals)
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: expect.any(String),
          template: "Monitor",
        }),
      );
    });

    it("saves report on successful execution", async () => {
      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "test-openai", HELIUS_API_KEY: "test-helius" },
      });
      const target = uniqueAddr();
      const req = {
        body: { target, type: "token" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "monitor",
          paid: true,
        }),
      );
    });

    it("truncates for free tier", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: null,
        network: "base-mainnet",
        amountUsd: 0,
        freeRemaining: 9,
      });

      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "test-openai", HELIUS_API_KEY: "test-helius" },
      });
      const target = uniqueAddr();
      const req = {
        body: { target, type: "token" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          _preview: true,
          _message: expect.stringContaining("$0.10"),
          template: "Monitor",
          status: expect.any(String),
        }),
      );
      // Should NOT have full signals array
      const response = (res.json as any).mock.calls[0][0];
      expect(response.signals).toBeUndefined();
      expect(response.triggeredAlerts).toBeUndefined();
    });

    it("returns early when gate not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const target = uniqueAddr();
      const req = {
        body: { target },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });
  });
});
