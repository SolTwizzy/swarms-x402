import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";

// Mock x402Gate so we can control payment gate behavior
vi.mock("../../src/server/x402Gate.js", () => ({
  x402Gate: vi.fn(async () => ({
    paid: true,
    transaction: "tx-test-123",
    network: "base-mainnet",
    amountUsd: 0.5,
  })),
}));

// Mock callOpenAI for investment-dd synthesis phase
vi.mock("../../src/utils/llm.js", () => ({
  callOpenAI: vi.fn(async () =>
    JSON.stringify({
      project: "TestProject",
      projectType: "token",
      overallScore: 72,
      recommendation: "BUY",
      dimensions: {
        team: { score: 80, weight: 25, summary: "Strong team" },
        tokenomics: { score: 65, weight: 20, summary: "Fair distribution" },
        tech: { score: 75, weight: 25, summary: "Solid architecture" },
        community: { score: 60, weight: 15, summary: "Growing community" },
        market: { score: 70, weight: 15, summary: "Good timing" },
      },
      keyFindings: ["Doxxed team", "Active GitHub"],
      redFlags: ["High insider allocation"],
      bullCase: "Strong fundamentals",
      bearCase: "Competitive market",
      executiveSummary: "Overall positive assessment",
    }),
  ),
}));

// Mock reportStore to avoid disk I/O
vi.mock("../../src/utils/reportStore.js", () => ({
  saveReport: vi.fn(() => "mock-report-id"),
}));

// Mock global fetch for DeFiLlama
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { advancedRoutes, ADVANCED_CATALOG } from "../../src/routes/advancedRoutes.js";
import { x402Gate } from "../../src/server/x402Gate.js";
import { callOpenAI } from "../../src/utils/llm.js";
import { saveReport } from "../../src/utils/reportStore.js";

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

function createDeFiLlamaResponse(pools: unknown[] = []) {
  return new Response(JSON.stringify({ data: pools }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const MOCK_POOLS = [
  {
    pool: "pool-1",
    chain: "Ethereum",
    project: "aave-v3",
    symbol: "USDC",
    tvlUsd: 5_000_000,
    apy: 8.5,
  },
  {
    pool: "pool-2",
    chain: "Solana",
    project: "marinade",
    symbol: "mSOL",
    tvlUsd: 3_000_000,
    apy: 6.2,
  },
  {
    pool: "pool-3",
    chain: "Arbitrum",
    project: "gmx",
    symbol: "GLP",
    tvlUsd: 10_000_000,
    apy: 12.1,
  },
];

describe("advancedRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes (paid call)
    (x402Gate as any).mockResolvedValue({
      paid: true,
      transaction: "tx-test-123",
      network: "base-mainnet",
      amountUsd: 0.5,
    });
    // Default: DeFiLlama returns valid data
    mockFetch.mockResolvedValue(createDeFiLlamaResponse(MOCK_POOLS));
    // Re-set callOpenAI mock (vi.clearAllMocks clears vi.fn implementation)
    (callOpenAI as any).mockResolvedValue(
      JSON.stringify({
        project: "TestProject",
        projectType: "token",
        overallScore: 72,
        recommendation: "BUY",
        dimensions: {
          team: { score: 80, weight: 25, summary: "Strong team" },
          tokenomics: { score: 65, weight: 20, summary: "Fair distribution" },
          tech: { score: 75, weight: 25, summary: "Solid architecture" },
          community: { score: 60, weight: 15, summary: "Growing community" },
          market: { score: 70, weight: 15, summary: "Good timing" },
        },
        keyFindings: ["Doxxed team", "Active GitHub"],
        redFlags: ["High insider allocation"],
        bullCase: "Strong fundamentals",
        bearCase: "Competitive market",
        executiveSummary: "Overall positive assessment",
      }),
    );
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /x402/yield-optimizer
  // ════════════════════════════════════════════════════════════════════════

  describe("POST /x402/yield-optimizer", () => {
    const route = advancedRoutes.find(
      (r) => r.path === "/x402/yield-optimizer" && r.type === "POST",
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 503 when DeFiLlama fails and no cache", async () => {
      mockFetch.mockResolvedValue(new Response("error", { status: 500 }));

      const mockSwarms = createMockSwarmsService();
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: {} } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("Yield data") }),
      );
    });

    it("calls x402Gate with $0.10", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          strategy: "Conservative Yield",
          positions: [{ protocol: "aave", allocation: 100 }],
          expectedApy: 8.5,
          riskAssessment: "Low risk",
          executionSteps: ["Step 1"],
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: {} } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.10" }),
      );
    });

    it("calls runSwarm with MixtureOfAgents and 3 agents", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          strategy: "Balanced DeFi",
          positions: [],
          expectedApy: 7,
          riskAssessment: "Medium",
          executionSteps: [],
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { riskTolerance: "high", chains: ["ethereum"] } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          swarm_type: "MixtureOfAgents",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "RateScanner" }),
            expect.objectContaining({ agent_name: "RiskAssessor" }),
            expect.objectContaining({ agent_name: "StrategyAdvisor" }),
          ]),
        }),
      );
      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      expect(callArgs.agents).toHaveLength(3);
    });

    it("includes disclaimer in response", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          strategy: "Test",
          positions: [],
          expectedApy: 5,
          riskAssessment: "Low",
          executionSteps: [],
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: {} } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const jsonCall = res.json.mock.calls[0][0];
      expect(jsonCall.disclaimer).toContain("not financial advice");
    });

    it("free tier shows strategy + expectedApy, hides positions", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        amountUsd: 0,
        freeRemaining: 4,
      });

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          strategy: "Conservative Yield",
          positions: [{ protocol: "aave", allocation: 100 }],
          expectedApy: 8.5,
          riskAssessment: "Low risk portfolio",
          executionSteps: ["Step 1"],
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: {} } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const jsonCall = res.json.mock.calls[0][0];
      expect(jsonCall.strategy).toBe("Conservative Yield");
      expect(jsonCall.expectedApy).toBe(8.5);
      expect(jsonCall.positions).toBeUndefined();
      expect(jsonCall.riskAssessment).toBeUndefined();
      expect(jsonCall._preview).toBe(true);
    });

    it("returns 503 when swarms service unavailable", async () => {
      const runtime = createMockRuntime({ services: {} });
      const req = { body: {} } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Swarms service unavailable" }),
      );
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /x402/research-report
  // ════════════════════════════════════════════════════════════════════════

  describe("POST /x402/research-report", () => {
    const route = advancedRoutes.find(
      (r) => r.path === "/x402/research-report" && r.type === "POST",
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

    it("returns 400 for empty topic", async () => {
      const req = { body: { topic: "   " } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("calls x402Gate with $0.50", async () => {
      const mockSwarms = createMockSwarmsService("Executive Summary\nKey findings\nFull report");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { topic: "AI in healthcare" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.50" }),
      );
    });

    it("calls runSwarm with SequentialWorkflow and 4 agents", async () => {
      const mockSwarms = createMockSwarmsService("Some research report output");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { topic: "blockchain scalability solutions" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          swarm_type: "SequentialWorkflow",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "Researcher" }),
            expect.objectContaining({ agent_name: "FactChecker" }),
            expect.objectContaining({ agent_name: "Analyst" }),
            expect.objectContaining({ agent_name: "Writer" }),
          ]),
        }),
      );
      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      expect(callArgs.agents).toHaveLength(4);
    });

    it("fact-checker agent has correct verification keywords in prompt", async () => {
      const mockSwarms = createMockSwarmsService("report text");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { topic: "renewable energy market analysis" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      const factChecker = callArgs.agents.find(
        (a: any) => a.agent_name === "FactChecker",
      );
      expect(factChecker).toBeDefined();
      expect(factChecker.system_prompt).toContain("VERIFIED");
      expect(factChecker.system_prompt).toContain("UNVERIFIED");
      expect(factChecker.system_prompt).toContain("DISPUTED");
      expect(factChecker.system_prompt).toContain("OUTDATED");
      expect(factChecker.system_prompt).toContain("FABRICATED");
    });

    it("free tier shows first 300 chars of summary + 2 findings", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        amountUsd: 0,
        freeRemaining: 3,
      });

      const longSummary = "A".repeat(500);
      const mockSwarms = createMockSwarmsService(
        `## Executive Summary\n${longSummary}\n## Key Findings\nFinding 1 about topic\nFinding 2 about topic\nFinding 3 about topic`,
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { topic: "AI trends" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const jsonCall = res.json.mock.calls[0][0];
      expect(jsonCall._preview).toBe(true);
      expect(jsonCall.executiveSummary.length).toBeLessThanOrEqual(303); // 300 + "..."
      expect(jsonCall.fullReport).toBeUndefined();
    });

    it("saves report with type research-report", async () => {
      const mockSwarms = createMockSwarmsService("Some report");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { topic: "test topic" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "research-report",
        }),
      );
    });

    it("returns 503 when swarms service unavailable", async () => {
      const runtime = createMockRuntime({ services: {} });
      const req = { body: { topic: "quantum computing advances 2026" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /x402/compliance-check
  // ════════════════════════════════════════════════════════════════════════

  describe("POST /x402/compliance-check", () => {
    const route = advancedRoutes.find(
      (r) => r.path === "/x402/compliance-check" && r.type === "POST",
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing document", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("document") }),
      );
    });

    it("returns 400 for empty document", async () => {
      const req = { body: { document: "   " } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("calls x402Gate with $0.50", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          overallComplianceScore: 75,
          gaps: { critical: 1, high: 2, medium: 3, low: 1 },
          criticalFindings: ["Missing DPA"],
          frameworks: [{ name: "GDPR", score: 75, status: "partially-compliant" }],
          remediationRoadmap: [],
          report: "Full report text",
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { document: "Privacy policy text here..." } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.50" }),
      );
    });

    it("calls runSwarm with SequentialWorkflow and 3 agents", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          overallComplianceScore: 60,
          gaps: { critical: 0, high: 1, medium: 2, low: 0 },
          report: "Report",
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { document: "Our data processing agreement..." } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          swarm_type: "SequentialWorkflow",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "RegulatoryExpert" }),
            expect.objectContaining({ agent_name: "GapAnalyzer" }),
            expect.objectContaining({ agent_name: "ComplianceWriter" }),
          ]),
        }),
      );
      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      expect(callArgs.agents).toHaveLength(3);
    });

    it("includes disclaimer in response", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          overallComplianceScore: 80,
          gaps: { critical: 0, high: 0, medium: 1, low: 2 },
          report: "Report",
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { document: "Some document text" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const jsonCall = res.json.mock.calls[0][0];
      expect(jsonCall.disclaimer).toContain("does not constitute legal advice");
    });

    it("passes framework to agents when specified", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          overallComplianceScore: 70,
          gaps: { critical: 0, high: 0, medium: 0, low: 0 },
          report: "Report",
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = {
        body: { document: "Our system handles health data...", framework: "HIPAA" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      expect(callArgs.task).toContain("HIPAA");
      // RegulatoryExpert should focus on HIPAA
      const regExpert = callArgs.agents.find(
        (a: any) => a.agent_name === "RegulatoryExpert",
      );
      expect(regExpert.system_prompt).toContain("HIPAA");
    });

    it("auto-detects framework when not specified", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          overallComplianceScore: 50,
          gaps: { critical: 1, high: 0, medium: 0, low: 0 },
          report: "Report",
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { document: "Generic corporate document..." } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      const regExpert = callArgs.agents.find(
        (a: any) => a.agent_name === "RegulatoryExpert",
      );
      expect(regExpert.system_prompt).toContain("Auto-detect");
    });

    it("free tier shows score + gap counts + disclaimer, hides report", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        amountUsd: 0,
        freeRemaining: 2,
      });

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          overallComplianceScore: 65,
          gaps: { critical: 2, high: 3, medium: 5, low: 1 },
          criticalFindings: ["Missing consent forms"],
          remediationRoadmap: [{ priority: 1, action: "Fix consent" }],
          report: "Detailed compliance report that should be hidden",
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { document: "Privacy doc" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const jsonCall = res.json.mock.calls[0][0];
      expect(jsonCall._preview).toBe(true);
      expect(jsonCall.overallComplianceScore).toBe(65);
      expect(jsonCall.gaps).toEqual({ critical: 2, high: 3, medium: 5, low: 1 });
      expect(jsonCall.disclaimer).toBeDefined();
      expect(jsonCall.report).toBeUndefined();
      expect(jsonCall.criticalFindings).toBeUndefined();
      expect(jsonCall.remediationRoadmap).toBeUndefined();
    });

    it("returns 503 when swarms service unavailable", async () => {
      const runtime = createMockRuntime({ services: {} });
      const req = { body: { document: "Some doc" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /x402/investment-dd
  // ════════════════════════════════════════════════════════════════════════

  describe("POST /x402/investment-dd", () => {
    const route = advancedRoutes.find(
      (r) => r.path === "/x402/investment-dd" && r.type === "POST",
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing project", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("project") }),
      );
    });

    it("returns 400 for empty project", async () => {
      const req = { body: { project: "" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("calls x402Gate with $5.00", async () => {
      const mockSwarms = createMockSwarmsService("Phase 1 output");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "sk-test-123" },
      });
      const req = { body: { project: "Uniswap" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "5.00" }),
      );
    });

    it("two-phase execution: runSwarm (ConcurrentWorkflow) + callOpenAI", async () => {
      const mockSwarms = createMockSwarmsService("Phase 1 specialist output");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "sk-test-123" },
      });
      const req = { body: { project: "Uniswap", projectType: "protocol" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // Phase 1: ConcurrentWorkflow with 5 agents
      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          swarm_type: "ConcurrentWorkflow",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "TeamAnalyst" }),
            expect.objectContaining({ agent_name: "TokenomicsExpert" }),
            expect.objectContaining({ agent_name: "TechReviewer" }),
            expect.objectContaining({ agent_name: "CommunityScanner" }),
            expect.objectContaining({ agent_name: "MarketAnalyst" }),
          ]),
        }),
      );
      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      expect(callArgs.agents).toHaveLength(5);

      // Phase 2: callOpenAI synthesis
      expect(callOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-4o",
          maxTokens: 16384,
        }),
      );
    });

    it("maps score to correct recommendation", async () => {
      // The mocked callOpenAI returns overallScore: 72, recommendation: "BUY"
      const mockSwarms = createMockSwarmsService("specialist output");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "sk-test-123" },
      });
      const req = { body: { project: "TestProject" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const jsonCall = res.json.mock.calls[0][0];
      expect(jsonCall.overallScore).toBe(72);
      expect(jsonCall.recommendation).toBe("BUY");
    });

    it("includes disclaimer in response", async () => {
      const mockSwarms = createMockSwarmsService("specialist output");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "sk-test-123" },
      });
      const req = { body: { project: "DisclaimerProject" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const jsonCall = res.json.mock.calls[0][0];
      expect(jsonCall.disclaimer).toContain("Not financial advice");
    });

    it("saves report with type investment-dd", async () => {
      const mockSwarms = createMockSwarmsService("specialist output");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "sk-test-123" },
      });
      const req = { body: { project: "SaveReportProject" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "investment-dd",
        }),
      );
    });

    it("free tier shows dimension scores + recommendation + red flag count, hides details", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        amountUsd: 0,
        freeRemaining: 1,
      });

      const mockSwarms = createMockSwarmsService("specialist output");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "sk-test-123" },
      });
      const req = { body: { project: "FreeTierProject" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const jsonCall = res.json.mock.calls[0][0];
      expect(jsonCall._preview).toBe(true);
      expect(jsonCall.overallScore).toBe(72);
      expect(jsonCall.recommendation).toBe("BUY");
      expect(jsonCall.redFlagCount).toBe(1); // ["High insider allocation"]
      expect(jsonCall.dimensionScores).toBeDefined();
      // Full details should be hidden
      expect(jsonCall.executiveSummary).toBeUndefined();
      expect(jsonCall.bullCase).toBeUndefined();
      expect(jsonCall.bearCase).toBeUndefined();
      expect(jsonCall.keyFindings).toBeUndefined();
    });

    it("returns 503 when swarms service unavailable", async () => {
      const runtime = createMockRuntime({ services: {} });
      const req = { body: { project: "UnavailableProject" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const req = { body: { project: "UnpaidProject" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // ADVANCED_CATALOG
  // ════════════════════════════════════════════════════════════════════════

  describe("ADVANCED_CATALOG", () => {
    it("exports 4 catalog entries", () => {
      expect(ADVANCED_CATALOG).toHaveLength(4);
    });

    it("has correct paths and prices", () => {
      const byPath = new Map(ADVANCED_CATALOG.map((e) => [e.path, e]));

      expect(byPath.get("/x402/yield-optimizer")?.priceUsd).toBe("0.10");
      expect(byPath.get("/x402/research-report")?.priceUsd).toBe("0.50");
      expect(byPath.get("/x402/compliance-check")?.priceUsd).toBe("0.50");
      expect(byPath.get("/x402/investment-dd")?.priceUsd).toBe("5.00");
    });
  });
});
