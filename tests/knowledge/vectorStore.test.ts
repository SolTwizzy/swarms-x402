import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VectorKnowledgeStore } from "../../src/knowledge/vectorStore.js";
import { KnowledgeStore, createKnowledgeStore } from "../../src/knowledge/store.js";
import { _resetStore, initKnowledgeStore, getKnowledgeStore } from "../../src/knowledge/index.js";
import { buildRAGContext } from "../../src/knowledge/rag.js";

// ── Mock fetch for OpenAI embeddings ─────────────────────────────────

const originalFetch = globalThis.fetch;
const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

function mockEmbeddingResponse(embedding?: number[]): void {
  const vec = embedding ?? Array.from({ length: 1536 }, (_, i) => i * 0.001);
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data: [{ embedding: vec }] }),
  });
}

function mockEmbeddingError(): void {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 429,
    statusText: "Rate limited",
    json: async () => ({ error: "rate_limited" }),
  });
}

// ── Mock Drizzle db ──────────────────────────────────────────────────

/** Queue of row arrays to return from db.execute() */
let mockRowQueue: unknown[][] = [];

function pushMockRows(rows: unknown[]): void {
  mockRowQueue.push(rows);
}

function createMockDb() {
  const executeFn = vi.fn(async () => {
    return mockRowQueue.shift() ?? [];
  });

  return {
    execute: executeFn,
    _executeFn: executeFn,
  };
}

// ═════════════════════════════════════════════════════════════════════
// VectorKnowledgeStore
// ═════════════════════════════════════════════════════════════════════

describe("VectorKnowledgeStore", () => {
  let store: VectorKnowledgeStore;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockRowQueue = [];
    mockDb = createMockDb();

    // 8 SQL calls during initialize: CREATE EXTENSION, CREATE TABLE, 5 CREATE INDEX, 1 HNSW index
    for (let i = 0; i < 8; i++) {
      pushMockRows([]);
    }

    store = new VectorKnowledgeStore(
      "postgresql://test:test@localhost/test",
      "sk-test-key",
      mockDb, // inject mock db
    );
  });

  afterEach(() => {
    _resetStore(true);
  });

  it("initialize() creates pgvector extension and table", async () => {
    await store.initialize();

    expect(mockDb._executeFn).toHaveBeenCalled();
    const calls = mockDb._executeFn.mock.calls.length;
    // At least CREATE EXTENSION + CREATE TABLE + several indexes
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("initialize() is idempotent", async () => {
    await store.initialize();
    const count1 = mockDb._executeFn.mock.calls.length;

    await store.initialize();
    const count2 = mockDb._executeFn.mock.calls.length;

    // Second call should not add more SQL statements
    expect(count2).toBe(count1);
  });

  it("add() stores entry with embedding", async () => {
    await store.initialize();
    const callsBefore = mockDb._executeFn.mock.calls.length;

    mockEmbeddingResponse();
    pushMockRows([]); // INSERT result

    const id = await store.add({
      type: "token-score",
      subject: "TokenX",
      content: "Score 80",
      score: 80,
      source: "/memecoin-score",
      metadata: { foo: "bar" },
    });

    expect(id).toBeTruthy();
    expect(id.length).toBe(16); // 8 random bytes = 16 hex chars
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Should have issued an INSERT
    expect(mockDb._executeFn.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("add() handles embedding failure gracefully", async () => {
    await store.initialize();
    const callsBefore = mockDb._executeFn.mock.calls.length;

    mockEmbeddingError();
    pushMockRows([]); // INSERT without embedding

    const id = await store.add({
      type: "risk-flag",
      subject: "BadToken",
      content: "Red flag detected",
      source: "/test",
      metadata: {},
    });

    expect(id).toBeTruthy();
    // Should still insert (without embedding)
    expect(mockDb._executeFn.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("semanticSearch() returns results sorted by distance", async () => {
    await store.initialize();

    mockEmbeddingResponse();
    pushMockRows([
      {
        entry_id: "aaa", type: "token-score", subject: "TokenA",
        content: "Score 70", score: 70, source: "/test", metadata: {},
        created_at: new Date("2026-01-01"), distance: 0.1,
      },
      {
        entry_id: "bbb", type: "token-score", subject: "TokenB",
        content: "Score 90", score: 90, source: "/test", metadata: {},
        created_at: new Date("2026-01-02"), distance: 0.3,
      },
    ]);

    const results = await store.semanticSearch("token analysis");

    expect(results.length).toBe(2);
    expect(results[0].id).toBe("aaa");
    expect(results[0].subject).toBe("TokenA");
    expect(results[1].id).toBe("bbb");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("searchBySubject() returns matching entries", async () => {
    await store.initialize();

    pushMockRows([
      {
        entry_id: "x1", type: "audit-finding", subject: "TokenX",
        content: "Reentrancy found", score: 80, source: "/audit",
        metadata: {}, created_at: new Date(),
      },
    ]);

    const results = await store.searchBySubject("TokenX");
    expect(results.length).toBe(1);
    expect(results[0].subject).toBe("TokenX");
    expect(results[0].content).toBe("Reentrancy found");
  });

  it("searchByType() returns matching entries", async () => {
    await store.initialize();

    pushMockRows([
      {
        entry_id: "t1", type: "risk-flag", subject: "A",
        content: "Flag 1", score: null, source: "/test",
        metadata: {}, created_at: new Date(),
      },
      {
        entry_id: "t2", type: "risk-flag", subject: "B",
        content: "Flag 2", score: null, source: "/test",
        metadata: {}, created_at: new Date(),
      },
    ]);

    const results = await store.searchByType("risk-flag");
    expect(results.length).toBe(2);
    expect(results[0].type).toBe("risk-flag");
  });

  it("getRecent() returns newest entries", async () => {
    await store.initialize();

    pushMockRows([
      {
        entry_id: "r1", type: "general", subject: "Latest",
        content: "New thing", score: null, source: "/test",
        metadata: {}, created_at: new Date("2026-03-29"),
      },
    ]);

    const results = await store.getRecent(5);
    expect(results.length).toBe(1);
    expect(results[0].subject).toBe("Latest");
  });

  it("getStats() returns correct counts", async () => {
    await store.initialize();

    // Total count
    pushMockRows([{ total: 42 }]);
    // Type breakdown
    pushMockRows([
      { type: "token-score", count: 20 },
      { type: "risk-flag", count: 22 },
    ]);
    // Source breakdown
    pushMockRows([
      { source: "/memecoin-score", count: 30 },
      { source: "/wallet-risk", count: 12 },
    ]);

    const stats = await store.getStats();
    expect(stats.total).toBe(42);
    expect(stats.byType["token-score"]).toBe(20);
    expect(stats.byType["risk-flag"]).toBe(22);
    expect(stats.bySource["/memecoin-score"]).toBe(30);
    expect(stats.bySource["/wallet-risk"]).toBe(12);
  });

  it("search() falls back to ILIKE when semantic search fails", async () => {
    await store.initialize();

    // First call: embedding fails (for semantic search)
    mockEmbeddingError();
    // Fallback ILIKE query result
    pushMockRows([
      {
        entry_id: "fb1", type: "general", subject: "Test",
        content: "Fallback result", score: null, source: "/test",
        metadata: {}, created_at: new Date(),
      },
    ]);

    const results = await store.search("test query");
    expect(results.length).toBe(1);
    expect(results[0].content).toBe("Fallback result");
  });

  it("rowToEntry maps null score to undefined", async () => {
    await store.initialize();

    pushMockRows([
      {
        entry_id: "ns1", type: "general", subject: "NoScore",
        content: "Test", score: null, source: "/test",
        metadata: {}, created_at: new Date("2026-01-15"),
      },
    ]);

    const results = await store.getRecent(1);
    expect(results[0].score).toBeUndefined();
    expect(results[0].timestamp).toContain("2026-01-15");
  });
});

// ═════════════════════════════════════════════════════════════════════
// createKnowledgeStore factory
// ═════════════════════════════════════════════════════════════════════

describe("createKnowledgeStore", () => {
  it("returns JSONL KnowledgeStore when no DATABASE_URL", async () => {
    const store = await createKnowledgeStore({});
    expect(store).toBeInstanceOf(KnowledgeStore);
  });

  it("returns JSONL KnowledgeStore when no OPENAI_API_KEY", async () => {
    const store = await createKnowledgeStore({ databaseUrl: "postgresql://localhost/test" });
    expect(store).toBeInstanceOf(KnowledgeStore);
  });

  it("returns JSONL KnowledgeStore when only openaiKey is provided", async () => {
    const store = await createKnowledgeStore({ openaiKey: "sk-test" });
    expect(store).toBeInstanceOf(KnowledgeStore);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Async RAG with both store types
// ═════════════════════════════════════════════════════════════════════

describe("buildRAGContext (async)", () => {
  it("returns empty string from empty JSONL store", async () => {
    const store = new KnowledgeStore({ maxEntries: 100 });
    const ctx = await buildRAGContext("/x402/memecoin-score", { mint: "NewToken" }, store);
    expect(ctx).toBe("");
  });

  it("builds context from JSONL store (backward compat)", async () => {
    const store = new KnowledgeStore({ maxEntries: 100 });
    store.add({
      type: "token-score",
      subject: "TokenAAA",
      content: "Score 75, verdict CAUTION",
      score: 75,
      source: "/x402/memecoin-score",
      metadata: {},
    });

    const ctx = await buildRAGContext("/x402/memecoin-score", { mint: "TokenAAA" }, store);
    expect(ctx).toContain("HISTORICAL CONTEXT");
    expect(ctx).toContain("TokenAAA");
  });

  it("builds context from VectorKnowledgeStore", async () => {
    const mockDb = createMockDb();
    // Initialize
    for (let i = 0; i < 8; i++) {
      mockRowQueue.push([]);
    }
    const vStore = new VectorKnowledgeStore("postgresql://test/test", "sk-test", mockDb);
    await vStore.initialize();

    // searchBySubject (direct match)
    mockRowQueue.push([
      {
        entry_id: "v1", type: "token-score", subject: "MintX",
        content: "Score 60 CAUTION", score: 60, source: "/memecoin-score",
        metadata: {}, created_at: new Date("2026-03-01"),
      },
    ]);

    // searchByType (related)
    mockRowQueue.push([]);

    // searchBySubject (dedup lookup for type section)
    mockRowQueue.push([
      {
        entry_id: "v1", type: "token-score", subject: "MintX",
        content: "Score 60 CAUTION", score: 60, source: "/memecoin-score",
        metadata: {}, created_at: new Date("2026-03-01"),
      },
    ]);

    // semantic search (additional context) — requires an embedding call
    mockEmbeddingResponse();
    mockRowQueue.push([]);

    // searchBySubject for dedup
    mockRowQueue.push([
      {
        entry_id: "v1", type: "token-score", subject: "MintX",
        content: "Score 60 CAUTION", score: 60, source: "/memecoin-score",
        metadata: {}, created_at: new Date("2026-03-01"),
      },
    ]);

    // searchByType for dedup
    mockRowQueue.push([]);

    const ctx = await buildRAGContext("/x402/memecoin-score", { mint: "MintX" }, vStore);
    expect(ctx).toContain("HISTORICAL CONTEXT");
    expect(ctx).toContain("MintX");
    expect(ctx).toContain("Score 60");
  });
});

// ═════════════════════════════════════════════════════════════════════
// initKnowledgeStore / getKnowledgeStore
// ═════════════════════════════════════════════════════════════════════

describe("initKnowledgeStore", () => {
  beforeEach(() => {
    _resetStore(true);
  });

  afterEach(() => {
    _resetStore(true);
  });

  it("falls back to JSONL when no env vars set", async () => {
    const origDb = process.env.DATABASE_URL;
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.OPENAI_API_KEY;

    _resetStore();
    await initKnowledgeStore();
    const store = getKnowledgeStore();
    expect(store).toBeInstanceOf(KnowledgeStore);

    if (origDb) process.env.DATABASE_URL = origDb;
    if (origKey) process.env.OPENAI_API_KEY = origKey;
  });

  it("getKnowledgeStore() creates JSONL store when init not called", () => {
    _resetStore();
    const store = getKnowledgeStore();
    expect(store).toBeInstanceOf(KnowledgeStore);
  });
});
