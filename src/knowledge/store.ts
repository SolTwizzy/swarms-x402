/**
 * KnowledgeStore — persistent JSONL-backed knowledge base for SwarmX.
 *
 * Every paid API call extracts atomic facts (audit findings, token scores,
 * risk flags, fact verdicts, etc.) and stores them here. Future calls
 * retrieve relevant past knowledge via RAG to improve agent prompts.
 *
 * Storage: append-only JSONL at data/knowledge.jsonl
 * In-memory: Map indexed by subject for O(1) lookups, capped at 10k entries.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ─────────────────────────────────────────────────────────────

export type KnowledgeType =
  | "audit-finding"
  | "token-score"
  | "risk-flag"
  | "fact-verdict"
  | "defi-rating"
  | "compliance-gap"
  | "general";

export interface KnowledgeEntry {
  id: string;
  type: KnowledgeType;
  subject: string;
  content: string;
  score?: number;
  source: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeStats {
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
}

// ── Resolve data directory ────────────────────────────────────────────

let DATA_DIR: string;
try {
  const thisFile = fileURLToPath(import.meta.url);
  DATA_DIR = join(dirname(thisFile), "..", "..", "data");
} catch {
  DATA_DIR = join(process.cwd(), "data");
}
const JSONL_PATH = join(DATA_DIR, "knowledge.jsonl");

// ── Helpers ───────────────────────────────────────────────────────────

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function generateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── KnowledgeStore class ──────────────────────────────────────────────

export class KnowledgeStore {
  private entries: KnowledgeEntry[] = [];
  private bySubject = new Map<string, KnowledgeEntry[]>();
  private byType = new Map<KnowledgeType, KnowledgeEntry[]>();
  private maxEntries: number;
  private jsonlPath: string;

  constructor(opts?: { maxEntries?: number; jsonlPath?: string }) {
    this.maxEntries = opts?.maxEntries ?? 10_000;
    this.jsonlPath = opts?.jsonlPath ?? JSONL_PATH;
  }

  // ── Core CRUD ───────────────────────────────────────────────────────

  /** Add a knowledge entry. Returns the generated ID. */
  add(entry: Omit<KnowledgeEntry, "id" | "timestamp">): string {
    const id = generateId();
    const full: KnowledgeEntry = {
      ...entry,
      id,
      timestamp: new Date().toISOString(),
    };

    // Prune oldest when at capacity
    while (this.entries.length >= this.maxEntries) {
      const oldest = this.entries.shift();
      if (oldest) {
        this.removeFromIndex(oldest);
      }
    }

    this.entries.push(full);
    this.addToIndex(full);
    return id;
  }

  /** Get entry by ID */
  getById(id: string): KnowledgeEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  // ── Search methods ──────────────────────────────────────────────────

  /** Search by subject (case-insensitive substring match). */
  searchBySubject(subject: string, limit = 20): KnowledgeEntry[] {
    const lower = subject.toLowerCase();

    // Fast path: exact match in index
    const exact = this.bySubject.get(lower);
    if (exact && exact.length > 0) {
      return exact.slice(-limit).reverse();
    }

    // Slower: substring match across all subjects
    const results: KnowledgeEntry[] = [];
    for (const [key, entries] of this.bySubject) {
      if (key.includes(lower) || lower.includes(key)) {
        results.push(...entries);
      }
    }
    return results
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  /** Search by type. */
  searchByType(type: KnowledgeType, limit = 20): KnowledgeEntry[] {
    const entries = this.byType.get(type) ?? [];
    return entries.slice(-limit).reverse();
  }

  /** Get N most recent entries (newest first). */
  getRecent(limit = 20): KnowledgeEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  /**
   * Keyword search across subject + content fields.
   * Splits query into tokens, scores by token hit count.
   */
  search(query: string, limit = 20): KnowledgeEntry[] {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);

    if (tokens.length === 0) return this.getRecent(limit);

    const scored: Array<{ entry: KnowledgeEntry; hits: number }> = [];

    for (const entry of this.entries) {
      const haystack = `${entry.subject} ${entry.content}`.toLowerCase();
      let hits = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) hits++;
      }
      if (hits > 0) {
        scored.push({ entry, hits });
      }
    }

    return scored
      .sort((a, b) => {
        // Primary: more token hits = better
        if (b.hits !== a.hits) return b.hits - a.hits;
        // Secondary: newer first
        return b.entry.timestamp.localeCompare(a.entry.timestamp);
      })
      .slice(0, limit)
      .map((s) => s.entry);
  }

  // ── Persistence ─────────────────────────────────────────────────────

  /** Persist all entries to JSONL file (append new entries only). */
  save(): void {
    try {
      ensureDataDir();
      // For simplicity, we append the entire current set.
      // In production, we'd track a write cursor.
      const existingCount = this.countDiskEntries();
      const newEntries = this.entries.slice(existingCount);
      if (newEntries.length === 0) return;

      const lines = newEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      appendFileSync(this.jsonlPath, lines, "utf-8");
    } catch {
      // Disk write failure should never block the request flow
    }
  }

  /** Load entries from JSONL file into memory. */
  load(): void {
    try {
      if (!existsSync(this.jsonlPath)) return;
      const raw = readFileSync(this.jsonlPath, "utf-8");
      const lines = raw.split("\n");

      const loaded: KnowledgeEntry[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          loaded.push(JSON.parse(trimmed) as KnowledgeEntry);
        } catch {
          // Skip malformed lines
        }
      }

      // Keep the most recent maxEntries
      const toLoad = loaded.slice(-this.maxEntries);
      // Clear current state
      this.entries = [];
      this.bySubject.clear();
      this.byType.clear();

      for (const entry of toLoad) {
        this.entries.push(entry);
        this.addToIndex(entry);
      }
    } catch {
      // Disk restore failure is non-fatal
    }
  }

  // ── Stats ───────────────────────────────────────────────────────────

  getStats(): KnowledgeStats {
    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    for (const entry of this.entries) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
    }

    return { total: this.entries.length, byType, bySource };
  }

  /** Total number of entries in memory. */
  get size(): number {
    return this.entries.length;
  }

  // ── Index management (private) ──────────────────────────────────────

  private addToIndex(entry: KnowledgeEntry): void {
    const subjectKey = entry.subject.toLowerCase();
    const subjectList = this.bySubject.get(subjectKey) ?? [];
    subjectList.push(entry);
    this.bySubject.set(subjectKey, subjectList);

    const typeList = this.byType.get(entry.type) ?? [];
    typeList.push(entry);
    this.byType.set(entry.type, typeList);
  }

  private removeFromIndex(entry: KnowledgeEntry): void {
    const subjectKey = entry.subject.toLowerCase();
    const subjectList = this.bySubject.get(subjectKey);
    if (subjectList) {
      const idx = subjectList.indexOf(entry);
      if (idx >= 0) subjectList.splice(idx, 1);
      if (subjectList.length === 0) this.bySubject.delete(subjectKey);
    }

    const typeList = this.byType.get(entry.type);
    if (typeList) {
      const idx = typeList.indexOf(entry);
      if (idx >= 0) typeList.splice(idx, 1);
      if (typeList.length === 0) this.byType.delete(entry.type);
    }
  }

  private countDiskEntries(): number {
    try {
      if (!existsSync(this.jsonlPath)) return 0;
      const raw = readFileSync(this.jsonlPath, "utf-8");
      return raw.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create the best available knowledge store:
 * - If DATABASE_URL + OPENAI_API_KEY are provided → VectorKnowledgeStore (pgvector)
 * - Otherwise → JSONL-backed KnowledgeStore (in-memory)
 */
export async function createKnowledgeStore(config: {
  databaseUrl?: string;
  openaiKey?: string;
}): Promise<KnowledgeStore | import("./vectorStore.js").VectorKnowledgeStore> {
  if (config.databaseUrl && config.openaiKey) {
    const { VectorKnowledgeStore } = await import("./vectorStore.js");
    const store = new VectorKnowledgeStore(config.databaseUrl, config.openaiKey);
    await store.initialize();
    return store;
  }
  // Fallback to JSONL
  const store = new KnowledgeStore();
  store.load();
  return store;
}
