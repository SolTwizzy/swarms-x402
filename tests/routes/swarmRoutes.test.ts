import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";

// Mock x402Gate so we can control payment gate behavior
vi.mock("../../src/server/x402Gate.js", () => ({
  x402Gate: vi.fn(async () => ({
    paid: true,
    transaction: "tx-test-123",
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

// Mock callOpenAI for synthesis phases
vi.mock("../../src/utils/llm.js", () => ({
  callOpenAI: vi.fn(async () =>
    JSON.stringify({
      overallScore: 72,
      verdict: "PROMISING",
      dimensions: {
        contract: { score: 80, weight: 30 },
        tokenomics: { score: 65, weight: 25 },
        liquidity: { score: 70, weight: 20 },
        credibility: { score: 60, weight: 15 },
        market: { score: 75, weight: 10 },
      },
      redFlags: ["High holder concentration"],
      greenFlags: ["Mint authority revoked"],
      summary: "Overall positive assessment",
      disclaimer: "Not financial advice",
    }),
  ),
}));

// Mock reportStore to avoid disk I/O
vi.mock("../../src/utils/reportStore.js", () => ({
  saveReport: vi.fn(() => "mock-report-id"),
}));

import { swarmRoutes, SWARM_ROUTE_CATALOG } from "../../src/routes/swarmRoutes.js";
import { x402Gate } from "../../src/server/x402Gate.js";
import { rpcCall } from "../../src/routes/heliusDataRoutes.js";
import { callOpenAI } from "../../src/utils/llm.js";
import { saveReport } from "../../src/utils/reportStore.js";

// Counter for generating unique IDs to avoid cache collisions between tests
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

function createMockSwarmsService(output: string = "mock swarm output") {
  return {
    isAvailable: vi.fn(() => true),
    runSwarm: vi.fn(async () => ({ output })),
    runAgent: vi.fn(async () => ({ outputs: output })),
  };
}

describe("swarmRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes (paid call)
    (x402Gate as any).mockResolvedValue({
      paid: true,
      transaction: "tx-test-123",
      network: "base-mainnet",
      amountUsd: 1.0,
    });
    // Default rpcCall returns account data
    (rpcCall as any).mockResolvedValue({ value: [] });
    // Default callOpenAI returns token-diligence synthesis
    (callOpenAI as any).mockResolvedValue(
      JSON.stringify({
        overallScore: 72,
        verdict: "PROMISING",
        dimensions: {
          contract: { score: 80, weight: 30 },
          tokenomics: { score: 65, weight: 25 },
          liquidity: { score: 70, weight: 20 },
          credibility: { score: 60, weight: 15 },
          market: { score: 75, weight: 10 },
        },
        redFlags: ["High holder concentration"],
        greenFlags: ["Mint authority revoked"],
        summary: "Overall positive assessment",
        disclaimer: "Not financial advice",
      }),
    );
    (saveReport as any).mockReturnValue("mock-report-id");
  });

  // ════════════════════════════════════════════════════════════════════════
  // Catalog
  // ════════════════════════════════════════════════════════════════════════

  describe("SWARM_ROUTE_CATALOG", () => {
    it("exports 3 catalog entries", () => {
      expect(SWARM_ROUTE_CATALOG).toHaveLength(3);
    });

    it("has correct paths", () => {
      const paths = SWARM_ROUTE_CATALOG.map((e) => e.path);
      expect(paths).toContain("/swarm/token-diligence");
      expect(paths).toContain("/swarm/defi-risk-score");
      expect(paths).toContain("/swarm/fact-check");
    });

    it("has correct prices", () => {
      const byPath = Object.fromEntries(SWARM_ROUTE_CATALOG.map((e) => [e.path, e.priceUsd]));
      expect(byPath["/swarm/token-diligence"]).toBe("0.15");
      expect(byPath["/swarm/defi-risk-score"]).toBe("0.15");
      expect(byPath["/swarm/fact-check"]).toBe("0.10");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /swarm/token-diligence
  // ════════════════════════════════════════════════════════════════════════

  describe("POST /swarm/token-diligence", () => {
    const route = swarmRoutes.find(
      (r) => r.path === "/swarm/token-diligence" && r.type === "POST",
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing mint", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("mint") }),
      );
    });

    it("returns 400 for invalid mint format", async () => {
      const req = { body: { mint: "invalid!!!" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("Invalid") }),
      );
    });

    it("calls x402Gate with $0.15", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ output: "agent analysis" }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.15" }),
      );
    });

    it("returns 503 when Swarms service unavailable", async () => {
      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("Swarms") }),
      );
    });

    it("runs two-phase execution: runSwarm + callOpenAI", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ output: "5 agent analyses" }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "test-openai", HELIUS_API_KEY: "test-helius" },
      });
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledTimes(1);
      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({ swarm_type: "ConcurrentWorkflow" }),
      );
      expect(callOpenAI).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          overallScore: 72,
          verdict: "PROMISING",
          template: "TokenDiligence",
        }),
      );
    });

    it("saves report on successful execution", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ output: "analysis" }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "token-diligence",
          paid: true,
        }),
      );
    });

    it("includes disclaimer in response", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ output: "analysis" }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ disclaimer: expect.stringContaining("Not financial advice") }),
      );
    });

    it("truncates for free tier", async () => {
      // Set gate to free (amountUsd = 0)
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: null,
        network: "base-mainnet",
        amountUsd: 0,
        freeRemaining: 9,
      });

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ output: "analysis" }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // Free tier unified: full output, no preview gating
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          overallScore: expect.any(Number),
          verdict: expect.any(String),
        }),
      );
      const response = (res.json as any).mock.calls[0][0];
      expect(response._preview).toBeUndefined();
      expect(response.redFlags).toBeDefined();
    });

    it("returns early when gate not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const req = { body: { mint: uniqueAddr() } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /swarm/defi-risk-score
  // ════════════════════════════════════════════════════════════════════════

  describe("POST /swarm/defi-risk-score", () => {
    const route = swarmRoutes.find(
      (r) => r.path === "/swarm/defi-risk-score" && r.type === "POST",
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing protocol", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("protocol") }),
      );
    });

    it("returns 400 for empty protocol string", async () => {
      const req = { body: { protocol: "   " } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("calls x402Gate with $0.15", async () => {
      // Set gate for defi-risk-score pricing
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: "tx-test-456",
        network: "base-mainnet",
        amountUsd: 2.0,
      });

      // Mock callOpenAI for defi-risk-score synthesis
      (callOpenAI as any).mockResolvedValue(
        JSON.stringify({
          protocol: "Aave",
          overallScore: 85,
          rating: "AA",
          dimensions: {},
          keyRisks: [],
          strengths: ["Battle-tested"],
          summary: "Strong protocol",
          disclaimer: "Not financial advice",
        }),
      );

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ output: "5 agent risk analyses" }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const req = { body: { protocol: "Aave" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.15" }),
      );
    });

    it("runs two-phase execution: runSwarm + callOpenAI", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: "tx-test-456",
        network: "base-mainnet",
        amountUsd: 2.0,
      });

      (callOpenAI as any).mockResolvedValue(
        JSON.stringify({
          protocol: "Aave",
          overallScore: 85,
          rating: "AA",
          dimensions: {
            contractSecurity: { score: 90, weight: 25, summary: "Audited" },
          },
          keyRisks: [],
          strengths: ["Battle-tested"],
          summary: "Strong protocol",
          disclaimer: "Not financial advice",
        }),
      );

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ output: "5 agent analyses" }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const req = { body: { protocol: "Aave", chain: "Ethereum" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledTimes(1);
      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({ swarm_type: "ConcurrentWorkflow" }),
      );
      expect(callOpenAI).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          overallScore: 85,
          rating: "AA",
          template: "DefiRiskScore",
        }),
      );
    });

    it("saves report on successful execution", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: "tx-test-456",
        network: "base-mainnet",
        amountUsd: 2.0,
      });

      (callOpenAI as any).mockResolvedValue(
        JSON.stringify({
          overallScore: 85,
          rating: "AA",
          dimensions: {},
          keyRisks: [],
          strengths: [],
          summary: "Good protocol",
          disclaimer: "Not financial advice",
        }),
      );

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ output: "analysis" }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const req = { body: { protocol: "Uniswap" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "defi-risk-score",
          paid: true,
        }),
      );
    });

    it("includes disclaimer in response", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: "tx-test-456",
        network: "base-mainnet",
        amountUsd: 2.0,
      });

      (callOpenAI as any).mockResolvedValue(
        JSON.stringify({
          overallScore: 70,
          rating: "A",
          dimensions: {},
          keyRisks: [],
          strengths: [],
          summary: "Solid protocol",
          disclaimer: "Not financial advice",
        }),
      );

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ output: "analysis" }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const req = { body: { protocol: "Compound" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ disclaimer: expect.stringContaining("Not financial advice") }),
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

      (callOpenAI as any).mockResolvedValue(
        JSON.stringify({
          overallScore: 75,
          rating: "A",
          dimensions: {},
          keyRisks: ["Governance risk"],
          strengths: ["High TVL"],
          summary: "Moderate risk",
          disclaimer: "Not financial advice",
        }),
      );

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ output: "analysis" }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const req = { body: { protocol: "Raydium" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // Free tier unified: full output, no preview gating
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          rating: "A",
          overallScore: 75,
        }),
      );
      const response = (res.json as any).mock.calls[0][0];
      expect(response._preview).toBeUndefined();
      expect(response.keyRisks).toEqual(["Governance risk"]);
      expect(response.strengths).toEqual(["High TVL"]);
    });

    it("returns early when gate not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const req = { body: { protocol: "Aave" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // POST /swarm/fact-check
  // ════════════════════════════════════════════════════════════════════════

  describe("POST /swarm/fact-check", () => {
    const route = swarmRoutes.find(
      (r) => r.path === "/swarm/fact-check" && r.type === "POST",
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing claim", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("claim") }),
      );
    });

    it("returns 400 for empty claim string", async () => {
      const req = { body: { claim: "" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("calls x402Gate with $0.10", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: "tx-test-789",
        network: "base-mainnet",
        amountUsd: 0.10,
      });

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          verdicts: [
            { claim: "The sky is blue", verdict: "VERIFIED", confidence: 0.95, reasoning: "Established fact" },
          ],
          overallVeracity: 95,
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { claim: "The sky is blue" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.10" }),
      );
    });

    it("runs SequentialWorkflow with 4 agents", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: "tx-test-789",
        network: "base-mainnet",
        amountUsd: 0.10,
      });

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          verdicts: [
            { claim: "Test claim", verdict: "VERIFIED", confidence: 0.9, reasoning: "Evidence supports it" },
          ],
          overallVeracity: 90,
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { claim: "Bitcoin was created in 2009" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledTimes(1);
      const swarmCall = mockSwarms.runSwarm.mock.calls[0][0];
      expect(swarmCall.swarm_type).toBe("SequentialWorkflow");
      expect(swarmCall.agents).toHaveLength(4);
      expect(swarmCall.agents.map((a: any) => a.agent_name)).toEqual([
        "ClaimExtractor",
        "EvidenceGatherer",
        "DevilsAdvocate",
        "Judge",
      ]);
    });

    it("does NOT call callOpenAI (no synthesis phase)", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: "tx-test-789",
        network: "base-mainnet",
        amountUsd: 0.10,
      });

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          verdicts: [
            { claim: "Test", verdict: "VERIFIED", confidence: 0.9, reasoning: "True" },
          ],
          overallVeracity: 90,
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { claim: "Water boils at 100C" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // Fact-check uses SequentialWorkflow only, no callOpenAI synthesis
      expect(callOpenAI).not.toHaveBeenCalled();
    });

    it("saves report on successful execution", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: "tx-test-789",
        network: "base-mainnet",
        amountUsd: 0.10,
      });

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          verdicts: [
            { claim: "Test", verdict: "VERIFIED", confidence: 0.9, reasoning: "True" },
          ],
          overallVeracity: 90,
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { claim: "Ethereum uses proof of stake" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "fact-check",
          paid: true,
        }),
      );
    });

    it("returns verdicts and overallVeracity for paid call", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: "tx-test-789",
        network: "base-mainnet",
        amountUsd: 0.10,
      });

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          verdicts: [
            { claim: "Claim A", verdict: "VERIFIED", confidence: 0.95, reasoning: "Confirmed" },
            { claim: "Claim B", verdict: "DISPUTED", confidence: 0.4, reasoning: "Contradicted" },
          ],
          overallVeracity: 68,
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { claim: "Multiple claims here" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          overallVeracity: 68,
          totalClaims: 2,
          verdictCounts: expect.objectContaining({
            VERIFIED: 1,
            DISPUTED: 1,
          }),
          template: "FactCheck",
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

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          verdicts: [
            { claim: "Test", verdict: "VERIFIED", confidence: 0.9, reasoning: "True" },
          ],
          overallVeracity: 90,
        }),
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const req = { body: { claim: "The Earth is round" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // Free tier unified: full output, no preview gating
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          overallVeracity: 90,
        }),
      );
      const response = (res.json as any).mock.calls[0][0];
      expect(response._preview).toBeUndefined();
      expect(response.verdicts).toBeDefined();
    });

    it("returns early when gate not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const req = { body: { claim: "Some claim" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });

    it("returns 503 when Swarms service unavailable", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: "tx-test-789",
        network: "base-mainnet",
        amountUsd: 0.10,
      });

      const runtime = createMockRuntime();
      const req = { body: { claim: "Some claim to check" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("Swarms") }),
      );
    });
  });
});
