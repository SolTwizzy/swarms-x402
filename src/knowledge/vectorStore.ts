/**
 * VectorKnowledgeStore — pgvector-powered knowledge store for SwarmX.
 *
 * Stores knowledge entries with OpenAI embeddings in PostgreSQL and
 * supports semantic (cosine-similarity) search via pgvector, plus
 * exact-match filters on subject, type, and source.
 *
 * Falls back gracefully when embedding generation fails (entry is
 * stored without an embedding and excluded from semantic search).
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { desc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { x402Knowledge } from "../schemas/knowledgeStore.js";
import type { KnowledgeEntry, KnowledgeType, KnowledgeStats } from "./store.js";

// ── Embedding helper ─────────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

async function getEmbedding(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI embeddings API error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return data.data[0].embedding;
}

/** Build a short text blob for embedding from a KnowledgeEntry. */
function embeddingText(entry: { subject: string; content: string; type: string }): string {
  return `[${entry.type}] ${entry.subject}: ${entry.content}`.slice(0, 8000);
}

// ── ID generator ─────────────────────────────────────────────────────

function generateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── VectorKnowledgeStore ─────────────────────────────────────────────

export class VectorKnowledgeStore {
  private db: ReturnType<typeof drizzle>;
  private pgClient: ReturnType<typeof postgres> | null;
  private openaiKey: string;
  private _initialized = false;

  /**
   * @param databaseUrl  PostgreSQL connection string
   * @param openaiKey    OpenAI API key for embedding generation
   * @param _testDb      Optional pre-built drizzle instance (testing only)
   */
  constructor(databaseUrl: string, openaiKey: string, _testDb?: unknown) {
    if (_testDb) {
      // Testing path: use injected db, skip real connection
      this.db = _testDb as ReturnType<typeof drizzle>;
      this.pgClient = null;
    } else {
      this.pgClient = postgres(databaseUrl);
      this.db = drizzle(this.pgClient);
    }
    this.openaiKey = openaiKey;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Create the pgvector extension and table if they don't exist. */
  async initialize(): Promise<void> {
    if (this._initialized) return;

    // Enable pgvector extension (idempotent)
    await this.db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

    // Create table if not exists (Drizzle push is not available at
    // runtime, so we do a raw CREATE TABLE with IF NOT EXISTS).
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS x402_knowledge (
        id            SERIAL PRIMARY KEY,
        entry_id      TEXT NOT NULL UNIQUE,
        type          TEXT NOT NULL,
        subject       TEXT NOT NULL,
        content       TEXT NOT NULL,
        score         INTEGER,
        source        TEXT NOT NULL,
        metadata      JSONB,
        embedding     vector(${sql.raw(String(EMBEDDING_DIMS))}),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Indexes (idempotent via IF NOT EXISTS)
    await this.db.execute(sql`CREATE INDEX IF NOT EXISTS idx_knowledge_subject ON x402_knowledge (subject)`);
    await this.db.execute(sql`CREATE INDEX IF NOT EXISTS idx_knowledge_type ON x402_knowledge (type)`);
    await this.db.execute(sql`CREATE INDEX IF NOT EXISTS idx_knowledge_source ON x402_knowledge (source)`);
    await this.db.execute(sql`CREATE INDEX IF NOT EXISTS idx_knowledge_entry_id ON x402_knowledge (entry_id)`);
    await this.db.execute(sql`CREATE INDEX IF NOT EXISTS idx_knowledge_created ON x402_knowledge (created_at)`);

    // HNSW index for fast cosine search (expensive to build, but worth it at scale)
    await this.db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_knowledge_embedding
      ON x402_knowledge USING hnsw (embedding vector_cosine_ops)
    `);

    this._initialized = true;
  }

  /** Cleanly shut down the connection pool. */
  async close(): Promise<void> {
    if (this.pgClient) {
      await this.pgClient.end();
    }
  }

  // ── Core CRUD ────────────────────────────────────────────────────────

  /** Add a knowledge entry with auto-generated embedding. Returns the entry ID. */
  async add(entry: Omit<KnowledgeEntry, "id" | "timestamp">): Promise<string> {
    const entryId = generateId();
    const now = new Date();

    // Generate embedding (best-effort — store without if it fails)
    let embeddingVec: number[] | null = null;
    try {
      embeddingVec = await getEmbedding(embeddingText(entry), this.openaiKey);
    } catch {
      // Embedding generation failed — store entry without vector
    }

    const embeddingStr = embeddingVec ? `[${embeddingVec.join(",")}]` : null;

    if (embeddingStr) {
      // Use raw SQL to insert with proper vector casting
      await this.db.execute(sql`
        INSERT INTO x402_knowledge (entry_id, type, subject, content, score, source, metadata, embedding, created_at)
        VALUES (
          ${entryId},
          ${entry.type},
          ${entry.subject},
          ${entry.content},
          ${entry.score ?? null},
          ${entry.source},
          ${JSON.stringify(entry.metadata ?? {})}::jsonb,
          ${embeddingStr}::vector,
          ${now}
        )
      `);
    } else {
      // No embedding — insert without vector
      await this.db.execute(sql`
        INSERT INTO x402_knowledge (entry_id, type, subject, content, score, source, metadata, created_at)
        VALUES (
          ${entryId},
          ${entry.type},
          ${entry.subject},
          ${entry.content},
          ${entry.score ?? null},
          ${entry.source},
          ${JSON.stringify(entry.metadata ?? {})}::jsonb,
          ${now}
        )
      `);
    }

    return entryId;
  }

  // ── Search methods ───────────────────────────────────────────────────

  /** Semantic search using cosine similarity via pgvector. */
  async semanticSearch(query: string, limit = 10): Promise<KnowledgeEntry[]> {
    const queryEmbedding = await getEmbedding(query, this.openaiKey);
    const vecStr = `[${queryEmbedding.join(",")}]`;

    const rows = await this.db.execute(sql`
      SELECT entry_id, type, subject, content, score, source, metadata, created_at,
             embedding <=> ${vecStr}::vector AS distance
      FROM x402_knowledge
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${vecStr}::vector
      LIMIT ${limit}
    `);

    return (rows as unknown as Array<Record<string, unknown>>).map(rowToEntry);
  }

  /** Keyword search — splits query into tokens, matches against subject + content. */
  async search(query: string, limit = 20): Promise<KnowledgeEntry[]> {
    // If we have an OpenAI key, prefer semantic search
    try {
      return await this.semanticSearch(query, limit);
    } catch {
      // Fall back to ILIKE-based keyword search
      const pattern = `%${query.replace(/[%_]/g, "")}%`;
      const rows = await this.db.execute(sql`
        SELECT entry_id, type, subject, content, score, source, metadata, created_at
        FROM x402_knowledge
        WHERE subject ILIKE ${pattern} OR content ILIKE ${pattern}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);
      return (rows as unknown as Array<Record<string, unknown>>).map(rowToEntry);
    }
  }

  /** Search by subject (case-insensitive). */
  async searchBySubject(subject: string, limit = 20): Promise<KnowledgeEntry[]> {
    const lower = subject.toLowerCase();
    const rows = await this.db.execute(sql`
      SELECT entry_id, type, subject, content, score, source, metadata, created_at
      FROM x402_knowledge
      WHERE LOWER(subject) = ${lower} OR LOWER(subject) LIKE ${"%" + lower + "%"}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map(rowToEntry);
  }

  /** Search by knowledge type. */
  async searchByType(type: string, limit = 20): Promise<KnowledgeEntry[]> {
    const rows = await this.db.execute(sql`
      SELECT entry_id, type, subject, content, score, source, metadata, created_at
      FROM x402_knowledge
      WHERE type = ${type}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map(rowToEntry);
  }

  /** Get N most recent entries (newest first). */
  async getRecent(limit = 20): Promise<KnowledgeEntry[]> {
    const rows = await this.db.execute(sql`
      SELECT entry_id, type, subject, content, score, source, metadata, created_at
      FROM x402_knowledge
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map(rowToEntry);
  }

  // ── Stats ────────────────────────────────────────────────────────────

  async getStats(): Promise<KnowledgeStats> {
    const totalRow = await this.db.execute(sql`SELECT COUNT(*)::int AS total FROM x402_knowledge`);
    const total = (totalRow as unknown as Array<{ total: number }>)[0]?.total ?? 0;

    const typeRows = await this.db.execute(sql`
      SELECT type, COUNT(*)::int AS count FROM x402_knowledge GROUP BY type
    `);
    const byType: Record<string, number> = {};
    for (const row of typeRows as unknown as Array<{ type: string; count: number }>) {
      byType[row.type] = row.count;
    }

    const sourceRows = await this.db.execute(sql`
      SELECT source, COUNT(*)::int AS count FROM x402_knowledge GROUP BY source
    `);
    const bySource: Record<string, number> = {};
    for (const row of sourceRows as unknown as Array<{ source: string; count: number }>) {
      bySource[row.source] = row.count;
    }

    return { total, byType, bySource };
  }

  /** Expose for interface compat: total entries (async). */
  get size(): number {
    // Cannot be async; return -1 as a sentinel. Use getStats().total instead.
    return -1;
  }
}

// ── Row-to-entry mapper ──────────────────────────────────────────────

function rowToEntry(row: Record<string, unknown>): KnowledgeEntry {
  return {
    id: String(row.entry_id ?? ""),
    type: String(row.type ?? "general") as KnowledgeType,
    subject: String(row.subject ?? ""),
    content: String(row.content ?? ""),
    score: typeof row.score === "number" ? row.score : undefined,
    source: String(row.source ?? ""),
    timestamp:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at ?? new Date().toISOString()),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

// ── Exports for testing ──────────────────────────────────────────────

export { getEmbedding, embeddingText, EMBEDDING_DIMS };
