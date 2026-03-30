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

// Mock heliusDataRoutes exports used by cryptoRoutes
vi.mock("../../src/routes/heliusDataRoutes.js", () => ({
  SOLANA_ADDR_RE: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  heliusRpcUrl: vi.fn(() => "https://mock-rpc.example.com"),
  rpcCall: vi.fn(async () => ({ value: [] })),
}));

import { cryptoRoutes } from "../../src/routes/cryptoRoutes.js";
import { x402Gate } from "../../src/server/x402Gate.js";

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

describe("cryptoRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes (paid call — not free tier)
    (x402Gate as any).mockResolvedValue({
      paid: true,
      transaction: "tx-test-123",
      network: "base-mainnet",
      amountUsd: 0.10,
    });
  });

  // ── POST /x402/contract-audit ──────────────────────────────────────

  describe("POST /x402/contract-audit", () => {
    const route = cryptoRoutes.find(
      (r) => r.path === "/x402/contract-audit" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing code", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("code") })
      );
    });

    it("returns 400 for empty code string", async () => {
      const req = { body: { code: "   " } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("calls x402Gate with $0.10", async () => {
      const mockSwarms = createMockSwarmsService();
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = { body: { code: "pragma solidity ^0.8.0; contract Foo {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.10" })
      );
    });

    it("calls swarmsService.runSwarm with ConcurrentWorkflow", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          riskScore: 35,
          verdict: "CAUTION",
          findings: { security: ["reentrancy"], economic: [], gas: ["SLOAD in loop"] },
          strengths: ["Uses SafeMath"],
          weaknesses: ["No access control"],
          red_flags: [],
          copy_likelihood_score: 10,
          complexity_score: 65,
          summary: "Medium risk contract",
        })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = {
        body: { code: "pragma solidity ^0.8.0; contract Foo {}", language: "solidity" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          swarm_type: "ConcurrentWorkflow",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "SecurityAuditor" }),
          ]),
        })
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: 35,
          verdict: "CAUTION",
          summary: "Medium risk contract",
          strengths: ["Uses SafeMath"],
          weaknesses: ["No access control"],
          redFlags: [],
          copyLikelihoodScore: 10,
          complexityScore: 65,
          template: "ContractAudit",
          payment: expect.objectContaining({ amount: "0.10" }),
        })
      );
    });

    it("returns 503 when swarms service unavailable", async () => {
      const runtime = createMockRuntime({ services: {} });

      const req = { body: { code: "contract Foo {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const req = { body: { code: "contract Foo {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // Should return early — no json call from our handler
      expect(res.json).not.toHaveBeenCalled();
    });

    it("returns fallback when swarm output is not valid JSON", async () => {
      const mockSwarms = createMockSwarmsService("Some unstructured text about the audit");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = { body: { code: "contract Foo {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: expect.any(Number),
          verdict: expect.any(String),
          findings: expect.any(Object),
          copyLikelihoodScore: expect.any(Number),
          complexityScore: expect.any(Number),
          template: "ContractAudit",
        })
      );
    });
  });

  // ── POST /x402/contract-audit/quick ────────────────────────────────

  describe("POST /x402/contract-audit/quick", () => {
    const route = cryptoRoutes.find(
      (r) => r.path === "/x402/contract-audit/quick" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing code", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("code") })
      );
    });

    it("returns 400 for empty code string", async () => {
      const req = { body: { code: "   " } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("calls x402Gate with $0.03", async () => {
      const mockSwarms = createMockSwarmsService();
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = { body: { code: "pragma solidity ^0.8.0; contract Foo {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.03" })
      );
    });

    it("calls swarmsService.runAgent with SecurityAuditor", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          riskScore: 80,
          verdict: "SAFE",
          findings: { security: [], economic: [], gas: [] },
          strengths: ["Clean code"],
          weaknesses: [],
          red_flags: [],
          copy_likelihood_score: 0,
          complexity_score: 40,
          summary: "Contract looks safe",
        })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = {
        body: { code: "pragma solidity ^0.8.0; contract Foo {}", language: "solidity" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runAgent).toHaveBeenCalledWith(
        expect.objectContaining({ agent_name: "SecurityAuditor" }),
        expect.stringContaining("contract Foo")
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: 80,
          verdict: "SAFE",
          summary: "Contract looks safe",
          template: "ContractAuditQuick",
          tier: "quick",
          payment: expect.objectContaining({ amount: "0.03" }),
        })
      );
    });

    it("returns 503 when swarms service unavailable", async () => {
      const runtime = createMockRuntime({ services: {} });

      const req = { body: { code: "contract Foo {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const req = { body: { code: "contract Foo {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });

    it("returns fallback when agent output is not valid JSON", async () => {
      const mockSwarms = createMockSwarmsService("Some unstructured security text");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = { body: { code: "contract Foo {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: expect.any(Number),
          verdict: expect.any(String),
          findings: expect.any(Object),
          copyLikelihoodScore: expect.any(Number),
          complexityScore: expect.any(Number),
          template: "ContractAuditQuick",
          tier: "quick",
        })
      );
    });
  });

  // ── POST /x402/contract-audit/deep ────────────────────────────────

  describe("POST /x402/contract-audit/deep", () => {
    const route = cryptoRoutes.find(
      (r) => r.path === "/x402/contract-audit/deep" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing code", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("code") })
      );
    });

    it("returns 400 for empty code string", async () => {
      const req = { body: { code: "   " } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("calls x402Gate with $0.25", async () => {
      const mockSwarms = createMockSwarmsService();
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = { body: { code: "pragma solidity ^0.8.0; contract Foo {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.25" })
      );
    });

    it("calls swarmsService.runSwarm with 6 agents including CopyDetector and VerificationAuditor", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          riskScore: 92,
          verdict: "SAFE",
          findings: { security: [], economic: [], gas: [{ title: "SLOAD in loop" }] },
          strengths: ["Uses SafeMath", "Comprehensive access control"],
          weaknesses: [],
          red_flags: [],
          copy_likelihood_score: 5,
          complexity_score: 78,
          summary: "Well-written secure contract",
        })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = {
        body: { code: "pragma solidity ^0.8.0; contract Foo {}", language: "solidity" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          swarm_type: "ConcurrentWorkflow",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "SecurityAuditor" }),
            expect.objectContaining({ agent_name: "EconomicAttacker" }),
            expect.objectContaining({ agent_name: "GasOptimizer" }),
            expect.objectContaining({ agent_name: "CopyDetector" }),
            expect.objectContaining({ agent_name: "VerificationAuditor" }),
            expect.objectContaining({ agent_name: "AuditReporter" }),
          ]),
        })
      );
      // Verify exactly 6 agents
      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      expect(callArgs.agents).toHaveLength(6);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: 92,
          verdict: "SAFE",
          summary: "Well-written secure contract",
          strengths: ["Uses SafeMath", "Comprehensive access control"],
          copyLikelihoodScore: 5,
          complexityScore: 78,
          template: "ContractAuditDeep",
          tier: "deep",
          payment: expect.objectContaining({ amount: "0.25" }),
        })
      );
    });

    it("returns 503 when swarms service unavailable", async () => {
      const runtime = createMockRuntime({ services: {} });

      const req = { body: { code: "contract Foo {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const req = { body: { code: "contract Foo {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });

    it("returns fallback when swarm output is not valid JSON", async () => {
      const mockSwarms = createMockSwarmsService("Unstructured deep audit text");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = { body: { code: "contract Foo {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: expect.any(Number),
          verdict: expect.any(String),
          findings: expect.any(Object),
          copyLikelihoodScore: expect.any(Number),
          complexityScore: expect.any(Number),
          template: "ContractAuditDeep",
          tier: "deep",
        })
      );
    });

    it("handles swarm execution errors gracefully", async () => {
      const mockSwarms = {
        isAvailable: vi.fn(() => true),
        runSwarm: vi.fn(async () => {
          throw new Error("Swarm API timeout");
        }),
        runAgent: vi.fn(),
      };
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = {
        body: { code: "pragma solidity ^0.8.0; contract Foo {}" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("unavailable") })
      );
    });
  });

  // ── POST /x402/token-risk ──────────────────────────────────────────

  describe("POST /x402/token-risk", () => {
    const route = cryptoRoutes.find(
      (r) => r.path === "/x402/token-risk" && r.type === "POST"
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
        expect.objectContaining({ error: expect.stringContaining("mint") })
      );
    });

    it("returns 400 for empty mint string", async () => {
      const req = { body: { mint: "" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("calls swarmsService.runSwarm with SequentialWorkflow", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          riskScore: 15,
          verdict: "SAFE",
          findings: { contract: [], tokenomics: [] },
          copy_likelihood_score: 5,
          timeline_anomalies: [],
          summary: "Token appears safe",
        })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = {
        body: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          swarm_type: "SequentialWorkflow",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "ContractScanner" }),
          ]),
        })
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: 15,
          verdict: "SAFE",
          copyLikelihoodScore: 5,
          timelineAnomalies: [],
          template: "TokenRisk",
          payment: expect.objectContaining({ amount: "0.05" }),
        })
      );
    });

    it("returns 503 when swarms service unavailable", async () => {
      const runtime = createMockRuntime({ services: {} });
      const req = {
        body: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("returns fallback when swarm output is not structured", async () => {
      const mockSwarms = createMockSwarmsService("unstructured risk text");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = {
        body: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: expect.any(Number),
          verdict: expect.any(String),
          findings: { contract: [], tokenomics: [] },
          copyLikelihoodScore: 0,
          timelineAnomalies: [],
          template: "TokenRisk",
        })
      );
    });
  });

  // ── POST /x402/dao-analyze ─────────────────────────────────────────

  describe("POST /x402/dao-analyze", () => {
    const route = cryptoRoutes.find(
      (r) => r.path === "/x402/dao-analyze" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing proposal", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("proposal") })
      );
    });

    it("returns 400 for empty proposal string", async () => {
      const req = { body: { proposal: "   " } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("calls swarmsService.runSwarm with MixtureOfAgents", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          recommendation: "FOR",
          confidence: 82,
          analysis: {
            economic: "Positive treasury impact",
            technical: "Straightforward implementation",
            risk: "Low governance risk",
          },
          summary: "Recommend voting FOR",
        })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = {
        body: {
          proposal: "Increase staking rewards by 5%",
          daoName: "Jito",
        },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          swarm_type: "MixtureOfAgents",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "EconomicAnalyst" }),
          ]),
        })
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          recommendation: "FOR",
          confidence: 82,
          daoName: "Jito",
          template: "DAOAnalysis",
          payment: expect.objectContaining({ amount: "0.10" }),
        })
      );
    });

    it("returns 503 when swarms service unavailable", async () => {
      const runtime = createMockRuntime({ services: {} });
      const req = {
        body: { proposal: "Increase staking rewards by 5%" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("returns fallback when swarm output is not structured", async () => {
      const mockSwarms = createMockSwarmsService("raw analysis text here");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = {
        body: { proposal: "Increase staking rewards by 5%" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          recommendation: expect.any(String),
          confidence: expect.anything(),
          analysis: { economic: "", technical: "", risk: "" },
          template: "DAOAnalysis",
        })
      );
    });

    it("handles swarm execution errors gracefully", async () => {
      const mockSwarms = {
        isAvailable: vi.fn(() => true),
        runSwarm: vi.fn(async () => {
          throw new Error("Swarm API timeout");
        }),
      };
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = {
        body: { proposal: "Increase staking rewards by 5%" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("unavailable") })
      );
    });
  });
});
