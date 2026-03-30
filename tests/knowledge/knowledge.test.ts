import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeStore } from "../../src/knowledge/store.js";
import { extractKnowledge } from "../../src/knowledge/extractor.js";
import { buildRAGContext } from "../../src/knowledge/rag.js";
import {
  getKnowledgeStore,
  getRAGContext,
  recordAndEnrich,
  _resetStore,
} from "../../src/knowledge/index.js";

// ── Test data directory ──────────────────────────────────────────────

const TEST_DATA_DIR = join(process.cwd(), "data", "test");
const TEST_JSONL = join(TEST_DATA_DIR, "knowledge-test.jsonl");

function cleanupTestFile(): void {
  try {
    if (existsSync(TEST_JSONL)) unlinkSync(TEST_JSONL);
  } catch {
    // ignore
  }
}

// ═══════════════════════════════════════════════════════════════════════
// KnowledgeStore
// ═══════════════════════════════════════════════════════════════════════

describe("KnowledgeStore", () => {
  let store: KnowledgeStore;

  beforeEach(() => {
    cleanupTestFile();
    if (!existsSync(TEST_DATA_DIR)) {
      mkdirSync(TEST_DATA_DIR, { recursive: true });
    }
    store = new KnowledgeStore({ maxEntries: 100, jsonlPath: TEST_JSONL });
  });

  afterEach(() => {
    cleanupTestFile();
  });

  it("add() returns a unique ID and increments size", () => {
    const id1 = store.add({
      type: "token-score",
      subject: "TokenA",
      content: "Score 75",
      source: "/x402/memecoin-score",
      metadata: {},
    });
    const id2 = store.add({
      type: "token-score",
      subject: "TokenB",
      content: "Score 80",
      source: "/x402/memecoin-score",
      metadata: {},
    });

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
    expect(store.size).toBe(2);
  });

  it("add() sets timestamp automatically", () => {
    const id = store.add({
      type: "general",
      subject: "test",
      content: "hello",
      source: "test",
      metadata: {},
    });
    const entry = store.getById(id);
    expect(entry).toBeDefined();
    expect(entry!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("add() prunes oldest entries when at maxEntries", () => {
    const small = new KnowledgeStore({ maxEntries: 3, jsonlPath: TEST_JSONL });
    small.add({ type: "general", subject: "first", content: "1", source: "t", metadata: {} });
    small.add({ type: "general", subject: "second", content: "2", source: "t", metadata: {} });
    small.add({ type: "general", subject: "third", content: "3", source: "t", metadata: {} });
    small.add({ type: "general", subject: "fourth", content: "4", source: "t", metadata: {} });

    expect(small.size).toBe(3);
    // First entry should be gone
    const results = small.searchBySubject("first");
    expect(results.length).toBe(0);
    // Fourth should exist
    const fourth = small.searchBySubject("fourth");
    expect(fourth.length).toBe(1);
  });

  it("searchBySubject() returns exact matches", () => {
    store.add({ type: "token-score", subject: "MintABC", content: "Score 50", source: "test", metadata: {} });
    store.add({ type: "token-score", subject: "MintDEF", content: "Score 70", source: "test", metadata: {} });

    const results = store.searchBySubject("MintABC");
    expect(results.length).toBe(1);
    expect(results[0].subject).toBe("MintABC");
  });

  it("searchBySubject() returns substring matches", () => {
    store.add({ type: "token-score", subject: "So11111111111111111111111111111111111111112", content: "SOL", source: "test", metadata: {} });

    const results = store.searchBySubject("So1111111111");
    expect(results.length).toBe(1);
  });

  it("searchBySubject() is case-insensitive", () => {
    store.add({ type: "defi-rating", subject: "Aave", content: "Rating AA", source: "test", metadata: {} });

    const results = store.searchBySubject("aave");
    expect(results.length).toBe(1);
  });

  it("searchByType() filters by type", () => {
    store.add({ type: "token-score", subject: "A", content: "x", source: "t", metadata: {} });
    store.add({ type: "risk-flag", subject: "B", content: "y", source: "t", metadata: {} });
    store.add({ type: "token-score", subject: "C", content: "z", source: "t", metadata: {} });

    const tokens = store.searchByType("token-score");
    expect(tokens.length).toBe(2);
    const risks = store.searchByType("risk-flag");
    expect(risks.length).toBe(1);
  });

  it("getRecent() returns newest first", () => {
    store.add({ type: "general", subject: "first", content: "1", source: "t", metadata: {} });
    store.add({ type: "general", subject: "second", content: "2", source: "t", metadata: {} });
    store.add({ type: "general", subject: "third", content: "3", source: "t", metadata: {} });

    const recent = store.getRecent(2);
    expect(recent.length).toBe(2);
    expect(recent[0].subject).toBe("third");
    expect(recent[1].subject).toBe("second");
  });

  it("search() matches keywords across subject and content", () => {
    store.add({ type: "token-score", subject: "TokenX", content: "Memecoin with high holder concentration", source: "t", metadata: {} });
    store.add({ type: "risk-flag", subject: "TokenY", content: "Low risk normal distribution", source: "t", metadata: {} });
    store.add({ type: "general", subject: "Aave", content: "DeFi protocol rating", source: "t", metadata: {} });

    const results = store.search("holder concentration");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].subject).toBe("TokenX");
  });

  it("search() ranks by token hit count", () => {
    store.add({ type: "general", subject: "A", content: "token analysis report", source: "t", metadata: {} });
    store.add({ type: "general", subject: "B", content: "token risk score high danger", source: "t", metadata: {} });

    const results = store.search("token risk danger");
    expect(results.length).toBe(2);
    // B matches all 3 tokens ("token", "risk", "danger"), A matches only 1 ("token")
    expect(results[0].subject).toBe("B");
  });

  it("getStats() returns correct counts", () => {
    store.add({ type: "token-score", subject: "A", content: "x", source: "/memecoin-score", metadata: {} });
    store.add({ type: "token-score", subject: "B", content: "y", source: "/memecoin-score", metadata: {} });
    store.add({ type: "risk-flag", subject: "C", content: "z", source: "/wallet-risk", metadata: {} });

    const stats = store.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byType["token-score"]).toBe(2);
    expect(stats.byType["risk-flag"]).toBe(1);
    expect(stats.bySource["/memecoin-score"]).toBe(2);
    expect(stats.bySource["/wallet-risk"]).toBe(1);
  });

  it("save() and load() round-trip entries", () => {
    store.add({ type: "token-score", subject: "Mint123", content: "Score 80", score: 80, source: "/test", metadata: { foo: "bar" } });
    store.add({ type: "risk-flag", subject: "Wallet456", content: "Suspicious", score: 70, source: "/test", metadata: {} });
    store.save();

    // Create a new store from the same file
    const store2 = new KnowledgeStore({ maxEntries: 100, jsonlPath: TEST_JSONL });
    store2.load();

    expect(store2.size).toBe(2);
    const found = store2.searchBySubject("Mint123");
    expect(found.length).toBe(1);
    expect(found[0].content).toBe("Score 80");
    expect(found[0].score).toBe(80);
    expect(found[0].metadata).toEqual({ foo: "bar" });
  });

  it("load() handles empty/missing file gracefully", () => {
    const store2 = new KnowledgeStore({ maxEntries: 100, jsonlPath: join(TEST_DATA_DIR, "nonexistent.jsonl") });
    expect(() => store2.load()).not.toThrow();
    expect(store2.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Extractor
// ═══════════════════════════════════════════════════════════════════════

describe("extractKnowledge", () => {
  it("extracts from contract-audit result", () => {
    const entries = extractKnowledge(
      "/audit/contract",
      { code: "contract Foo { ... }" },
      {
        riskScore: 35,
        verdict: "CAUTION",
        findings: {
          security: [
            { severity: "HIGH", title: "Reentrancy", description: "Vulnerable to reentrancy in withdraw()" },
          ],
          economic: [],
          gas: [],
        },
        redFlags: ["No access controls"],
      },
    );

    expect(entries.length).toBeGreaterThanOrEqual(2); // overall + finding + red flag
    const overall = entries.find((e) => e.content.includes("CAUTION"));
    expect(overall).toBeDefined();
    expect(overall!.type).toBe("audit-finding");

    const finding = entries.find((e) => e.content.includes("Reentrancy"));
    expect(finding).toBeDefined();
    expect(finding!.type).toBe("audit-finding");

    const redFlag = entries.find((e) => e.content.includes("No access controls"));
    expect(redFlag).toBeDefined();
    expect(redFlag!.type).toBe("risk-flag");
  });

  it("extracts from memecoin-score result", () => {
    const entries = extractKnowledge(
      "/x402/memecoin-score",
      { mint: "So11111111111111111111111111111111111111112" },
      {
        score: 72,
        verdict: "CAUTION",
        contract: { mintAuthority: "renounced", freezeAuthority: "renounced" },
        redFlags: ["Low liquidity"],
        summary: "Token shows moderate risk",
      },
    );

    expect(entries.length).toBeGreaterThanOrEqual(2); // overall + authority + red flag
    const score = entries.find((e) => e.type === "token-score");
    expect(score).toBeDefined();
    expect(score!.subject).toBe("So11111111111111111111111111111111111111112");
    expect(score!.score).toBe(72);
  });

  it("extracts from token-diligence result with dimensions", () => {
    const entries = extractKnowledge(
      "/swarm/token-diligence",
      { mint: "ABC123" },
      {
        overallScore: 45,
        verdict: "CAUTION",
        dimensions: {
          contract: { score: 60, weight: 30 },
          tokenomics: { score: 40, weight: 25 },
        },
        redFlags: ["Mint authority active", "High concentration"],
        greenFlags: ["Liquidity locked"],
      },
    );

    // Overall + 2 dimensions + 2 red flags + 1 green flag = 6+
    expect(entries.length).toBeGreaterThanOrEqual(5);
    const dims = entries.filter((e) => e.content.includes("dimension"));
    expect(dims.length).toBe(2);
  });

  it("extracts from defi-risk-score result", () => {
    const entries = extractKnowledge(
      "/swarm/defi-risk-score",
      { protocol: "Aave" },
      {
        protocol: "Aave",
        overallScore: 88,
        rating: "AA",
        dimensions: {
          contractSecurity: { score: 95, weight: 25, summary: "Well audited" },
        },
        keyRisks: ["Oracle dependency"],
      },
    );

    expect(entries.length).toBeGreaterThanOrEqual(2);
    const rating = entries.find((e) => e.type === "defi-rating" && e.content.includes("AA"));
    expect(rating).toBeDefined();
    expect(rating!.subject).toBe("Aave");
  });

  it("extracts from fact-check result", () => {
    const entries = extractKnowledge(
      "/swarm/fact-check",
      { claim: "Solana processes 65,000 TPS" },
      {
        claim: "Solana processes 65,000 TPS",
        verdicts: [
          { claim: "Solana processes 65,000 TPS", verdict: "DISPUTED", confidence: 0.7, reasoning: "Theoretical max, not sustained" },
        ],
        overallVeracity: 45,
        totalClaims: 1,
      },
    );

    expect(entries.length).toBeGreaterThanOrEqual(2); // overall + individual verdict
    const verdict = entries.find((e) => e.type === "fact-verdict" && e.content.includes("DISPUTED"));
    expect(verdict).toBeDefined();
    expect(verdict!.score).toBe(70); // 0.7 * 100
  });

  it("extracts from wallet-risk-score result", () => {
    const entries = extractKnowledge(
      "/x402/wallet-risk-score",
      { address: "WalletXYZ" },
      {
        riskScore: 65,
        riskLevel: "high",
        patterns: [
          { type: "rapid-cycling", description: "Rapid token cycling detected", riskLevel: "high" },
        ],
        flags: ["Interacted with known scam"],
      },
    );

    expect(entries.length).toBeGreaterThanOrEqual(3); // risk + pattern + flag
    const risk = entries.find((e) => e.content.includes("Wallet risk"));
    expect(risk).toBeDefined();
    expect(risk!.subject).toBe("WalletXYZ");
  });

  it("handles missing fields gracefully", () => {
    const entries = extractKnowledge(
      "/x402/memecoin-score",
      { mint: "EmptyToken" },
      {},
    );
    // Should not throw, may return 0 entries
    expect(entries).toBeInstanceOf(Array);
  });

  it("handles unknown endpoint with generic extraction", () => {
    const entries = extractKnowledge(
      "/unknown/endpoint",
      { query: "test" },
      { summary: "This is a generic result summary" },
    );
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("general");
    expect(entries[0].content).toContain("generic result summary");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// RAG Retriever
// ═══════════════════════════════════════════════════════════════════════

describe("buildRAGContext", () => {
  let store: KnowledgeStore;

  beforeEach(() => {
    store = new KnowledgeStore({ maxEntries: 100 });
  });

  it("returns empty string when no relevant knowledge exists", async () => {
    const ctx = await buildRAGContext("/x402/memecoin-score", { mint: "NewToken" }, store);
    expect(ctx).toBe("");
  });

  it("builds context for a known subject", async () => {
    store.add({
      type: "token-score",
      subject: "TokenAAA",
      content: "Score 75, verdict CAUTION",
      score: 75,
      source: "/x402/memecoin-score",
      metadata: {},
    });
    store.add({
      type: "risk-flag",
      subject: "TokenAAA",
      content: "Mint authority still active",
      score: 80,
      source: "/x402/memecoin-score",
      metadata: {},
    });

    const ctx = await buildRAGContext("/x402/memecoin-score", { mint: "TokenAAA" }, store);
    expect(ctx).toContain("HISTORICAL CONTEXT");
    expect(ctx).toContain("TokenAAA");
    expect(ctx).toContain("Score 75");
    expect(ctx).toContain("END HISTORICAL CONTEXT");
  });

  it("includes related entries by type", async () => {
    // Add entries for a different token but same type
    store.add({
      type: "token-score",
      subject: "TokenBBB",
      content: "Score 30, verdict DANGER",
      score: 30,
      source: "/x402/memecoin-score",
      metadata: {},
    });

    const ctx = await buildRAGContext("/x402/memecoin-score", { mint: "TokenCCC" }, store);
    // Should still find related entries by type
    expect(ctx).toContain("RELATED PAST ANALYSES");
    expect(ctx).toContain("TokenBBB");
  });

  it("limits context length", async () => {
    // Add many entries
    for (let i = 0; i < 50; i++) {
      store.add({
        type: "token-score",
        subject: `Token${i}`,
        content: `Analysis number ${i} with a lot of details about the token and its risk factors and score and everything else. `.repeat(5),
        score: i,
        source: "/test",
        metadata: {},
      });
    }

    const ctx = await buildRAGContext("/x402/memecoin-score", { mint: "Token0" }, store);
    // Should not exceed ~8000 chars + wrapper text
    expect(ctx.length).toBeLessThan(10000);
  });

  it("handles defi-risk-score context", async () => {
    store.add({
      type: "defi-rating",
      subject: "Uniswap",
      content: "DeFi risk rating: AA (85/100)",
      score: 85,
      source: "/swarm/defi-risk-score",
      metadata: {},
    });

    const ctx = await buildRAGContext("/swarm/defi-risk-score", { protocol: "Uniswap" }, store);
    expect(ctx).toContain("Uniswap");
    expect(ctx).toContain("AA");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Integration helpers (index.ts)
// ═══════════════════════════════════════════════════════════════════════

describe("Integration helpers", () => {
  beforeEach(() => {
    _resetStore();
  });

  it("getKnowledgeStore() returns a singleton", () => {
    const s1 = getKnowledgeStore();
    const s2 = getKnowledgeStore();
    expect(s1).toBe(s2);
  });

  it("recordAndEnrich() extracts and stores knowledge", async () => {
    const { entriesAdded } = await recordAndEnrich(
      "/x402/memecoin-score",
      { mint: "TestMint" },
      {
        score: 60,
        verdict: "CAUTION",
        contract: { mintAuthority: "active" },
        redFlags: ["Suspicious"],
      },
    );

    expect(entriesAdded).toBeGreaterThanOrEqual(2);

    // Now getRAGContext should find it
    const ctx = await getRAGContext("/x402/memecoin-score", { mint: "TestMint" });
    expect(ctx).toContain("TestMint");
  });

  it("getRAGContext() returns empty for unknown subjects on empty store", async () => {
    // Reset with empty=true to skip disk load (prior tests may have written to disk)
    _resetStore(true);
    const ctx = await getRAGContext("/x402/memecoin-score", { mint: "NeverSeen" });
    expect(ctx).toBe("");
  });
});
