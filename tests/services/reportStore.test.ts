import { describe, it, expect } from "vitest";
import {
  saveReport,
  getReport,
  getRecentReports,
  getReportCount,
} from "../../src/utils/reportStore.js";

describe("reportStore", () => {
  it("saveReport returns an 8-char hex ID", () => {
    const id = saveReport({
      type: "contract-audit",
      createdAt: new Date().toISOString(),
      input: { code: "pragma solidity ^0.8.0;", language: "solidity" },
      result: { riskScore: 42, findings: { security: [], economic: [], gas: [] }, summary: "ok" },
      riskScore: 42,
      paid: false,
    });
    expect(id).toHaveLength(8);
    expect(/^[0-9a-f]{8}$/.test(id)).toBe(true);
  });

  it("getReport retrieves a saved report by ID", () => {
    const id = saveReport({
      type: "token-risk",
      createdAt: new Date().toISOString(),
      input: { mint: "So111...", chain: "solana" },
      result: { riskScore: 15, verdict: "SAFE" },
      riskScore: 15,
      paid: true,
    });

    const report = getReport(id);
    expect(report).not.toBeNull();
    expect(report!.id).toBe(id);
    expect(report!.type).toBe("token-risk");
    expect(report!.riskScore).toBe(15);
    expect(report!.paid).toBe(true);
  });

  it("getReport returns null for unknown ID", () => {
    expect(getReport("zzzzzzzz")).toBeNull();
  });

  it("getRecentReports returns newest first", () => {
    const id1 = saveReport({
      type: "contract-audit",
      createdAt: "2025-01-01T00:00:00Z",
      input: {},
      result: {},
      riskScore: 10,
      paid: false,
    });
    const id2 = saveReport({
      type: "code-review",
      createdAt: "2025-01-02T00:00:00Z",
      input: {},
      result: {},
      riskScore: null,
      paid: false,
    });

    const recent = getRecentReports(2);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    // Most recent should be first
    expect(recent[0].id).toBe(id2);
    expect(recent[1].id).toBe(id1);
  });

  it("getReportCount tracks total stored reports", () => {
    const before = getReportCount();
    saveReport({
      type: "contract-audit",
      createdAt: new Date().toISOString(),
      input: {},
      result: {},
      riskScore: 50,
      paid: false,
    });
    expect(getReportCount()).toBe(before + 1);
  });

  it("report includes all fields", () => {
    const id = saveReport({
      type: "code-review",
      createdAt: "2025-03-27T12:00:00Z",
      input: { code: "fn main() {}", language: "rust" },
      result: { output: "looks good" },
      riskScore: null,
      paid: false,
    });

    const report = getReport(id);
    expect(report).not.toBeNull();
    expect(report!.type).toBe("code-review");
    expect(report!.createdAt).toBe("2025-03-27T12:00:00Z");
    expect(report!.input.code).toBe("fn main() {}");
    expect(report!.input.language).toBe("rust");
    expect(report!.riskScore).toBeNull();
    expect(report!.paid).toBe(false);
  });
});
