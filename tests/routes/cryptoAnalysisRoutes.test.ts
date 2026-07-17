import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";

// Mock x402Gate so we can control payment gate behavior
vi.mock("../../src/server/x402Gate.js", () => ({
  x402Gate: vi.fn(async () => ({
    paid: true,
    transaction: "tx-test-123",
    network: "base-mainnet",
    amountUsd: 0.05,
  })),
}));

// Mock heliusDataRoutes exports
vi.mock("../../src/routes/heliusDataRoutes.js", () => ({
  SOLANA_ADDR_RE: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  heliusRpcUrl: vi.fn(() => "https://mock-rpc.example.com"),
  rpcCall: vi.fn(async () => ({ value: [] })),
}));

// Mock callOpenAI for tx-explainer (single agent)
vi.mock("../../src/utils/llm.js", () => ({
  callOpenAI: vi.fn(async () =>
    JSON.stringify({
      type: "transfer",
      explanation: "A simple SOL transfer between two wallets.",
      participants: [{ address: "abc", role: "sender" }],
      tokensInvolved: [],
      summary: "SOL transfer from sender to recipient.",
    })
  ),
}));

// Mock reportStore
vi.mock("../../src/utils/reportStore.js", () => ({
  saveReport: vi.fn(() => "mock-report-id"),
}));

import { cryptoAnalysisRoutes, CRYPTO_ANALYSIS_CATALOG } from "../../src/routes/cryptoAnalysisRoutes.js";
import { x402Gate } from "../../src/server/x402Gate.js";
import { rpcCall } from "../../src/routes/heliusDataRoutes.js";
import { callOpenAI } from "../../src/utils/llm.js";
import { saveReport } from "../../src/utils/reportStore.js";

// Counter for generating unique IDs to avoid cache collisions between tests
let testCounter = 0;

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

// Base58 chars for unique ID generation (no 0, I, O, l)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Generate unique base58-like signature (64-88 chars) to avoid cache collisions. */
function uniqueSig(): string {
  testCounter++;
  // Encode counter as base58 chars, pad to 4 chars
  let n = testCounter;
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix = B58[n % 58] + suffix;
    n = Math.floor(n / 58);
  }
  return `5wHu1qwD7q4qSCruJKVFUqRE2D3F3u3ZRdKnhBzHMYvHagjYsX5jBZxPb6dQ${suffix}`;
}

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

describe("cryptoAnalysisRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes (paid call)
    (x402Gate as any).mockResolvedValue({
      paid: true,
      transaction: "tx-test-123",
      network: "base-mainnet",
      amountUsd: 0.05,
    });
    // Default rpcCall returns transaction data
    (rpcCall as any).mockResolvedValue({ meta: {}, transaction: { message: {} } });
    // Default callOpenAI returns tx-explainer JSON
    (callOpenAI as any).mockResolvedValue(
      JSON.stringify({
        type: "transfer",
        explanation: "A simple SOL transfer between two wallets.",
        participants: [{ address: "abc", role: "sender" }],
        tokensInvolved: [],
        summary: "SOL transfer from sender to recipient.",
      })
    );
    // Default saveReport returns a mock ID
    (saveReport as any).mockReturnValue("mock-report-id");
  });

  // ── Catalog ──────────────────────────────────────────────────────────

  describe("CRYPTO_ANALYSIS_CATALOG", () => {
    it("exports 3 catalog entries", () => {
      expect(CRYPTO_ANALYSIS_CATALOG).toHaveLength(3);
    });

    it("has correct paths", () => {
      const paths = CRYPTO_ANALYSIS_CATALOG.map((e) => e.path);
      expect(paths).toContain("/x402/tx-explainer");
      expect(paths).toContain("/x402/memecoin-score");
      expect(paths).toContain("/x402/wallet-risk-score");
    });
  });

  // ── POST /x402/tx-explainer ──────────────────────────────────────────

  describe("POST /x402/tx-explainer", () => {
    const route = cryptoAnalysisRoutes.find(
      (r) => r.path === "/x402/tx-explainer" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing signature", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("signature") })
      );
    });

    it("returns 400 for invalid signature format", async () => {
      const req = { body: { signature: "invalid!!!" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("Invalid") })
      );
    });

    it("calls x402Gate with $0.03", async () => {
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key", OPENAI_API_KEY: "test-openai" },
      });
      const sig = uniqueSig();
      const req = { body: { signature: sig } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.03" })
      );
    });

    it("returns 503 when HELIUS_API_KEY not configured", async () => {
      const runtime = createMockRuntime({
        settings: { OPENAI_API_KEY: "test-openai" },
      });
      const sig = uniqueSig();
      const req = { body: { signature: sig } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("returns 404 when transaction not found", async () => {
      (rpcCall as any).mockResolvedValue(null);

      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key", OPENAI_API_KEY: "test-openai" },
      });
      const sig = uniqueSig();
      const req = { body: { signature: sig } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it("calls callOpenAI when OPENAI_API_KEY is set", async () => {
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key", OPENAI_API_KEY: "test-openai" },
      });
      const sig = uniqueSig();
      const req = { body: { signature: sig } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(callOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "test-openai",
          model: "gpt-5-mini",
          temperature: 0.2,
          maxTokens: 2048,
        })
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "transfer",
          summary: expect.stringContaining("SOL transfer"),
          template: "TxExplainer",
          payment: expect.objectContaining({ amount: "0.03" }),
        })
      );
    });

    it("falls back to Swarms when OPENAI_API_KEY not set", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          type: "swap",
          explanation: "A token swap on Jupiter.",
          participants: [],
          tokensInvolved: [],
          summary: "Token swap via Jupiter.",
        })
      );
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key" },
        services: { SWARMS: mockSwarms },
      });
      const sig = uniqueSig();
      const req = { body: { signature: sig } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(callOpenAI).not.toHaveBeenCalled();
      expect(mockSwarms.runAgent).toHaveBeenCalledWith(
        expect.objectContaining({ agent_name: "TxExplainer" }),
        expect.any(String)
      );
    });

    it("returns 503 when neither OPENAI_API_KEY nor Swarms available", async () => {
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key" },
        services: {},
      });
      const sig = uniqueSig();
      const req = { body: { signature: sig } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const sig = uniqueSig();
      const req = { body: { signature: sig } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });

    it("saves report after successful execution", async () => {
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key", OPENAI_API_KEY: "test-openai" },
      });
      const sig = uniqueSig();
      const req = { body: { signature: sig } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          paid: true,
        })
      );
    });

    it("shows free tier truncation when amountUsd is 0", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        transaction: undefined,
        network: undefined,
        amountUsd: 0,
        freeRemaining: 3,
      });

      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key", OPENAI_API_KEY: "test-openai" },
      });
      const sig = uniqueSig();
      const req = { body: { signature: sig } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "transfer",
          _preview: true,
          _message: expect.stringContaining("Pay $0.03"),
        })
      );
      // Should NOT include full explanation or participants
      const jsonArg = (res.json as any).mock.calls[0][0];
      expect(jsonArg.explanation).toBeUndefined();
      expect(jsonArg.participants).toBeUndefined();
    });

    it("handles non-JSON LLM output gracefully", async () => {
      (callOpenAI as any).mockResolvedValue("This is just plain text about a transaction");

      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key", OPENAI_API_KEY: "test-openai" },
      });
      const sig = uniqueSig();
      const req = { body: { signature: sig } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "unknown",
          template: "TxExplainer",
        })
      );
    });
  });

  // ── POST /x402/memecoin-score ────────────────────────────────────────

  describe("POST /x402/memecoin-score", () => {
    const route = cryptoAnalysisRoutes.find(
      (r) => r.path === "/x402/memecoin-score" && r.type === "POST"
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

    it("returns 400 for invalid mint format", async () => {
      const req = { body: { mint: "invalid!!!" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("Invalid") })
      );
    });

    it("calls x402Gate with $0.05", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ score: 30, verdict: "CAUTION", contract: {}, tokenomics: {}, redFlags: [], summary: "test" })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.05" })
      );
    });

    it("returns 503 when swarms service unavailable", async () => {
      const runtime = createMockRuntime({ services: {} });
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("calls swarmsService.runSwarm with SequentialWorkflow and 3 agents", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          score: 25,
          verdict: "SAFE",
          contract: { mintAuthority: "renounced", freezeAuthority: "renounced", riskScore: 10 },
          tokenomics: { topHolderPct: "5%", riskScore: 15 },
          redFlags: [],
          summary: "Token appears safe with renounced authorities.",
        })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          swarm_type: "SequentialWorkflow",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "ContractScanner" }),
            expect.objectContaining({ agent_name: "TokenomicsAnalyst" }),
            expect.objectContaining({ agent_name: "RiskSynthesizer" }),
          ]),
        })
      );
      // Verify exactly 3 agents
      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      expect(callArgs.agents).toHaveLength(3);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          score: 25,
          verdict: "SAFE",
          template: "MemecoinScore",
          payment: expect.objectContaining({ amount: "0.05" }),
        })
      );
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });

    it("shows free tier truncation when amountUsd is 0", async () => {
      (x402Gate as any).mockResolvedValue({
        paid: true,
        amountUsd: 0,
        freeRemaining: 2,
      });

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          score: 80,
          verdict: "DANGER",
          contract: {},
          tokenomics: {},
          redFlags: ["Mint authority active", "Top holder owns 90%"],
          summary: "High risk memecoin.",
        })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          score: 80,
          verdict: "DANGER",
          redFlagCount: 2,
          _preview: true,
          _message: expect.stringContaining("Pay $0.05"),
        })
      );
      // Should NOT include full contract/tokenomics/summary
      const jsonArg = (res.json as any).mock.calls[0][0];
      expect(jsonArg.contract).toBeUndefined();
      expect(jsonArg.tokenomics).toBeUndefined();
    });

    it("saves report after successful execution", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ score: 50, verdict: "CAUTION", contract: {}, tokenomics: {}, redFlags: [], summary: "test" })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: 50,
          paid: true,
        })
      );
    });

    it("handles non-JSON swarm output with fallback defaults", async () => {
      const mockSwarms = createMockSwarmsService("Some unstructured text about the memecoin");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const mint = uniqueAddr();
      const req = { body: { mint } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          score: 50,
          verdict: "CAUTION",
          redFlags: [],
          template: "MemecoinScore",
        })
      );
    });
  });

  // ── POST /x402/wallet-risk-score ─────────────────────────────────────

  describe("POST /x402/wallet-risk-score", () => {
    const route = cryptoAnalysisRoutes.find(
      (r) => r.path === "/x402/wallet-risk-score" && r.type === "POST"
    );

    /** Setup rpcCall to return appropriate values for wallet-risk RPC calls. */
    function setupWalletRpcMock() {
      (rpcCall as any).mockImplementation(async (_url: string, method: string) => {
        if (method === "getBalance") return { value: 1_500_000_000 };
        if (method === "getSignaturesForAddress") return [{ signature: "sig1" }, { signature: "sig2" }];
        if (method === "getTransaction") return { meta: { fee: 5000 }, transaction: { message: {} } };
        return null;
      });
    }

    it("route exists", () => {
      expect(route).toBeDefined();
    });

    it("returns 400 for missing address", async () => {
      const req = { body: {} } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("address") })
      );
    });

    it("returns 400 for invalid address format", async () => {
      const req = { body: { address: "invalid!!!" } } as any;
      const res = createMockRes();
      const runtime = createMockRuntime();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("Invalid") })
      );
    });

    it("calls x402Gate with $0.05", async () => {
      setupWalletRpcMock();
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ riskScore: 20, riskLevel: "low", patterns: [], flags: [], summary: "test" })
      );
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key" },
        services: { SWARMS: mockSwarms },
      });
      const addr = uniqueAddr();
      const req = { body: { address: addr } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.05" })
      );
    });

    it("returns 503 when HELIUS_API_KEY not configured", async () => {
      const mockSwarms = createMockSwarmsService();
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });
      const addr = uniqueAddr();
      const req = { body: { address: addr } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("returns 503 when Helius RPC fails", async () => {
      (rpcCall as any).mockRejectedValue(new Error("RPC connection failed"));

      const mockSwarms = createMockSwarmsService();
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key" },
        services: { SWARMS: mockSwarms },
      });
      const addr = uniqueAddr();
      const req = { body: { address: addr } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("Helius") })
      );
    });

    it("returns 503 when swarms service unavailable", async () => {
      setupWalletRpcMock();
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key" },
        services: {},
      });
      const addr = uniqueAddr();
      const req = { body: { address: addr } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it("calls swarmsService.runSwarm with SequentialWorkflow and 2 agents", async () => {
      setupWalletRpcMock();
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          riskScore: 15,
          riskLevel: "low",
          patterns: [{ type: "normal-trading", description: "Regular DeFi activity", riskLevel: "low" }],
          flags: [],
          summary: "Low risk wallet with normal activity.",
        })
      );
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key" },
        services: { SWARMS: mockSwarms },
      });
      const addr = uniqueAddr();
      const req = { body: { address: addr } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          swarm_type: "SequentialWorkflow",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "TransactionAnalyzer" }),
            expect.objectContaining({ agent_name: "RiskScorer" }),
          ]),
        })
      );
      // Verify exactly 2 agents
      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      expect(callArgs.agents).toHaveLength(2);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: 15,
          riskLevel: "low",
          template: "WalletRiskScore",
          payment: expect.objectContaining({ amount: "0.05" }),
        })
      );
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const addr = uniqueAddr();
      const req = { body: { address: addr } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).not.toHaveBeenCalled();
    });

    it("shows free tier truncation when amountUsd is 0", async () => {
      setupWalletRpcMock();
      (x402Gate as any).mockResolvedValue({
        paid: true,
        amountUsd: 0,
        freeRemaining: 1,
      });

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          riskScore: 65,
          riskLevel: "high",
          patterns: [{ type: "mev-bot", description: "Sandwich attack patterns", riskLevel: "high" }],
          flags: ["Frequent sandwich attacks"],
          summary: "High risk wallet.",
        })
      );
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key" },
        services: { SWARMS: mockSwarms },
      });
      const addr = uniqueAddr();
      const req = { body: { address: addr } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: 65,
          riskLevel: "high",
          _preview: true,
          _message: expect.stringContaining("Pay $0.05"),
        })
      );
      // Should NOT include full patterns/flags/summary
      const jsonArg = (res.json as any).mock.calls[0][0];
      expect(jsonArg.patterns).toBeUndefined();
      expect(jsonArg.flags).toBeUndefined();
    });

    it("saves report after successful execution", async () => {
      setupWalletRpcMock();
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({ riskScore: 30, riskLevel: "moderate", patterns: [], flags: [], summary: "test" })
      );
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key" },
        services: { SWARMS: mockSwarms },
      });
      const addr = uniqueAddr();
      const req = { body: { address: addr } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: 30,
          paid: true,
        })
      );
    });

    it("handles non-JSON swarm output with fallback defaults", async () => {
      setupWalletRpcMock();
      const mockSwarms = createMockSwarmsService("Some unstructured risk analysis text");
      const runtime = createMockRuntime({
        settings: { HELIUS_API_KEY: "test-key" },
        services: { SWARMS: mockSwarms },
      });
      const addr = uniqueAddr();
      const req = { body: { address: addr } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          riskScore: 50,
          riskLevel: "moderate",
          patterns: [],
          flags: [],
          template: "WalletRiskScore",
        })
      );
    });
  });
});
