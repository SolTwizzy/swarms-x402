import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../setup.js";

// Mock x402Gate so we can control payment gate behavior
vi.mock("../../src/server/x402Gate.js", () => ({
  x402Gate: vi.fn(async () => ({
    paid: true,
    transaction: "tx-test-123",
    network: "base-mainnet",
    amountUsd: 0.10,
  })),
}));

// Mock reportStore so saves don't touch disk
vi.mock("../../src/utils/reportStore.js", () => ({
  saveReport: vi.fn(() => "rpt-abc123"),
}));

// Mock callOpenAI for fallback tests
vi.mock("../../src/utils/llm.js", () => ({
  callOpenAI: vi.fn(async () =>
    JSON.stringify({
      findings: [{ severity: "medium", title: "SQL injection", description: "Unsanitized input", confirmed: true, lineRef: "L12" }],
      securityScore: 60,
    })
  ),
}));

import { codeAuditRoutes, CODE_AUDIT_CATALOG } from "../../src/routes/codeAuditRoutes.js";
import { detectLanguage } from "../../src/routes/codeAuditRoutes.js";
import { x402Gate } from "../../src/server/x402Gate.js";
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

describe("codeAuditRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gate passes (paid call)
    (x402Gate as any).mockResolvedValue({
      paid: true,
      transaction: "tx-test-123",
      network: "base-mainnet",
      amountUsd: 0.10,
    });
  });

  describe("POST /x402/code-audit", () => {
    const route = codeAuditRoutes.find(
      (r) => r.path === "/x402/code-audit" && r.type === "POST"
    );

    it("route exists", () => {
      expect(route).toBeDefined();
      expect(CODE_AUDIT_CATALOG).toHaveLength(1);
      expect(CODE_AUDIT_CATALOG[0].path).toBe("/x402/code-audit");
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

    it("returns 400 for empty/whitespace code", async () => {
      const req = { body: { code: "   \n\t  " } } as any;
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

      const req = { body: { code: "function hello() { return 1; }" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(x402Gate).toHaveBeenCalledWith(
        runtime,
        req,
        res,
        expect.objectContaining({ amountUsd: "0.10" })
      );
    });

    it("returns 503 when Swarms unavailable and no OPENAI_API_KEY", async () => {
      const origKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const runtime = createMockRuntime({ services: {} });
      const req = { body: { code: "function hello() {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(503);

      // Restore
      if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
    });

    it("calls runSwarm with ConcurrentWorkflow + 3 agents", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          securityScore: 80,
          performanceScore: 70,
          qualityScore: 90,
          security: { score: 80, findings: [] },
          performance: { score: 70, findings: [] },
          quality: { score: 90, findings: [], strengths: ["Clean code"] },
        })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = {
        body: { code: "def hello():\n  return 1", language: "python" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(mockSwarms.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          swarm_type: "ConcurrentWorkflow",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "SecurityReviewer" }),
            expect.objectContaining({ agent_name: "PerformanceAnalyst" }),
            expect.objectContaining({ agent_name: "BestPracticesChecker" }),
          ]),
        })
      );
      // Verify exactly 3 agents
      const callArgs = mockSwarms.runSwarm.mock.calls[0][0];
      expect(callArgs.agents).toHaveLength(3);
    });

    it("auto-detects Python language from code content", () => {
      expect(detectLanguage("def hello():\n  return 1")).toBe("python");
    });

    it("auto-detects TypeScript language from code content", () => {
      expect(detectLanguage("const foo = () => 42;")).toBe("typescript");
    });

    it("computes correct scoring formula (50% sec + 25% perf + 25% qual)", async () => {
      // securityScore=80, performanceScore=60, qualityScore=40
      // overallScore = round(80*0.50 + 60*0.25 + 40*0.25) = round(40 + 15 + 10) = 65
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          securityScore: 80,
          performanceScore: 60,
          qualityScore: 40,
        })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = {
        body: { code: "function test() {}" },
      } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          overallScore: 65,
          verdict: "NEEDS_WORK",
        })
      );
    });

    it("maps verdict correctly: EXCELLENT >= 85, GOOD >= 70, NEEDS_WORK >= 50, POOR < 50", async () => {
      // Test EXCELLENT: 90*0.5 + 90*0.25 + 90*0.25 = 90
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          securityScore: 90,
          performanceScore: 90,
          qualityScore: 90,
        })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = { body: { code: "function test() {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          overallScore: 90,
          verdict: "EXCELLENT",
        })
      );
    });

    it("saves report with type code-audit and riskScore = 100 - overallScore", async () => {
      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          securityScore: 80,
          performanceScore: 80,
          qualityScore: 80,
        })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = { body: { code: "function test() {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "code-audit",
          riskScore: 20, // 100 - 80
          paid: true,
        })
      );

      // Should include reportUrl and badgeUrl in response
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          reportUrl: expect.stringContaining("/report/"),
          badgeUrl: expect.stringContaining("/badge/"),
          badgeMarkdown: expect.stringContaining("[![SwarmX Audit]"),
        })
      );
    });

    it("truncates output for free tier (hides finding details)", async () => {
      // Simulate free tier call (amountUsd = 0)
      (x402Gate as any).mockResolvedValue({
        paid: true,
        amountUsd: 0,
        freeRemaining: 3,
      });

      const mockSwarms = createMockSwarmsService(
        JSON.stringify({
          securityScore: 70,
          performanceScore: 60,
          qualityScore: 50,
          security: { score: 70, findings: [{ severity: "high", title: "XSS" }] },
          performance: { score: 60, findings: [{ severity: "medium", title: "N+1" }] },
          quality: { score: 50, findings: [{ severity: "low", title: "naming" }], strengths: ["Good structure"] },
        })
      );
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = { body: { code: "function test() {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      const response = res.json.mock.calls[0][0];
      expect(response.overallScore).toBeDefined();
      expect(response.verdict).toBeDefined();
      expect(response._preview).toBe(true);
      // Should show counts, not full findings
      expect(response.security.findingCount).toBeDefined();
      expect(response.security.findings).toBeUndefined();
    });

    it("does not proceed when gate is not paid", async () => {
      (x402Gate as any).mockResolvedValue({ paid: false });

      const runtime = createMockRuntime();
      const req = { body: { code: "function hello() {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      // Should return early -- no json call from our handler
      expect(res.json).not.toHaveBeenCalled();
    });

    it("returns fallback when agent output is not valid JSON", async () => {
      const mockSwarms = createMockSwarmsService("Some unstructured text about the code quality and issues found");
      const runtime = createMockRuntime({
        services: { SWARMS: mockSwarms },
      });

      const req = { body: { code: "function test() {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          overallScore: expect.any(Number),
          verdict: expect.any(String),
          template: "CodeAudit",
          payment: expect.objectContaining({ amount: "0.10" }),
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

      const req = { body: { code: "function test() {}" } } as any;
      const res = createMockRes();

      await route!.handler(req, res, runtime);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining("unavailable") })
      );
    });
  });

  describe("detectLanguage", () => {
    it("detects Solidity", () => {
      expect(detectLanguage("pragma solidity ^0.8.0;\ncontract Foo {}")).toBe("solidity");
    });

    it("detects Go", () => {
      expect(detectLanguage("package main\n\nfunc main() {}")).toBe("go");
    });

    it("detects Rust", () => {
      expect(detectLanguage("fn main() {\n  let mut x = 5;\n}")).toBe("rust");
    });

    it("detects Java", () => {
      expect(detectLanguage("public class Main {\n  private void run() {}\n}")).toBe("java");
    });

    it("detects PHP", () => {
      expect(detectLanguage("<?php echo 'hello'; ?>")).toBe("php");
    });

    it("detects C/C++", () => {
      expect(detectLanguage("#include <stdio.h>\nint main() {}")).toBe("c/cpp");
    });

    it("returns unknown for unrecognized code", () => {
      expect(detectLanguage("hello world 123")).toBe("unknown");
    });
  });
});
