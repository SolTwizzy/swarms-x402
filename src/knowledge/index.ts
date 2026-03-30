/**
 * Knowledge module — barrel export + integration helpers.
 *
 * Provides two main integration points for route handlers:
 *
 * 1. `getRAGContext(endpoint, input)` — call BEFORE running agents,
 *    returns a context string to inject into system prompts.
 *
 * 2. `recordAndEnrich(endpoint, input, result)` — call AFTER producing
 *    a result, extracts knowledge and persists it.
 *
 * Supports two backends:
 * - JSONL (KnowledgeStore) — default, no external deps
 * - pgvector (VectorKnowledgeStore) — when DATABASE_URL + OPENAI_API_KEY set
 *
 * Call `initKnowledgeStore()` at startup for async pgvector init.
 * If not called, falls back to JSONL on first access.
 */

export { KnowledgeStore, createKnowledgeStore } from "./store.js";
export type { KnowledgeEntry, KnowledgeType, KnowledgeStats } from "./store.js";
export { VectorKnowledgeStore } from "./vectorStore.js";
export { extractKnowledge } from "./extractor.js";
export { buildRAGContext } from "./rag.js";
export type { AnyKnowledgeStore } from "./rag.js";

import { KnowledgeStore, createKnowledgeStore } from "./store.js";
import type { VectorKnowledgeStore } from "./vectorStore.js";
import { extractKnowledge } from "./extractor.js";
import { buildRAGContext } from "./rag.js";

// ── Singleton store ───────────────────────────────────────────────────

let _store: KnowledgeStore | VectorKnowledgeStore | null = null;
let _initPromise: Promise<void> | null = null;

/**
 * Initialize the knowledge store asynchronously.
 * Call this at server/plugin startup to enable pgvector if available.
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initKnowledgeStore(runtime?: {
  getSetting?: (key: string) => string | boolean | number | null;
}): Promise<void> {
  if (_store) return;
  if (_initPromise) {
    await _initPromise;
    return;
  }

  _initPromise = (async () => {
    const dbUrl = runtime?.getSetting?.("DATABASE_URL") ?? process.env.DATABASE_URL;
    const openaiKey =
      runtime?.getSetting?.("OPENAI_API_KEY") ?? process.env.OPENAI_API_KEY;

    try {
      _store = await createKnowledgeStore({
        databaseUrl: dbUrl ? String(dbUrl) : undefined,
        openaiKey: openaiKey ? String(openaiKey) : undefined,
      });
    } catch {
      // pgvector init failed — fall back to JSONL
      const store = new KnowledgeStore();
      store.load();
      _store = store;
    }
  })();

  await _initPromise;
}

/**
 * Get or create the singleton knowledge store.
 * If `initKnowledgeStore()` was called, returns the pgvector store.
 * Otherwise, lazily creates a JSONL store.
 */
export function getKnowledgeStore(): KnowledgeStore | VectorKnowledgeStore {
  if (!_store) {
    // Fallback: sync JSONL if initKnowledgeStore() was never called
    const store = new KnowledgeStore();
    store.load();
    _store = store;
  }
  return _store;
}

/**
 * Reset the singleton store (for testing only).
 * If `empty` is true, creates a fresh empty store that skips disk load.
 * @internal
 */
export function _resetStore(empty = false): void {
  _initPromise = null;
  if (empty) {
    _store = new KnowledgeStore();
    // Don't call load() — start completely fresh
  } else {
    _store = null;
  }
}

// ── Integration helpers ───────────────────────────────────────────────

/**
 * Pre-call: retrieve RAG context to inject into agent system prompts.
 * Returns empty string if no relevant knowledge exists.
 *
 * Now async to support pgvector semantic search.
 */
export async function getRAGContext(
  endpoint: string,
  input: Record<string, unknown>,
): Promise<string> {
  return buildRAGContext(endpoint, input, getKnowledgeStore());
}

/**
 * Post-call: extract knowledge from the result and persist it.
 * Fire-and-forget — never blocks the response flow.
 *
 * Now async to support pgvector writes.
 *
 * Also returns the RAG context that *would* apply to the next similar call
 * (useful for debugging/monitoring).
 */
export async function recordAndEnrich(
  endpoint: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<{ ragContext: string; entriesAdded: number }> {
  const store = getKnowledgeStore();

  // 1. Extract knowledge from result
  const extracted = extractKnowledge(endpoint, input, result);

  // 2. Add entries (async for VectorKnowledgeStore, sync for KnowledgeStore)
  const isVector = "semanticSearch" in store;
  for (const entry of extracted) {
    try {
      if (isVector) {
        await (store as VectorKnowledgeStore).add(entry);
      } else {
        (store as KnowledgeStore).add(entry);
      }
    } catch {
      // Never block on a single entry failure
    }
  }

  // 3. Save to disk (fire-and-forget, only for JSONL store)
  if (!isVector) {
    try {
      (store as KnowledgeStore).save();
    } catch {
      // Never block on disk failure
    }
  }

  // 4. Build RAG context for next similar call
  const ragContext = await buildRAGContext(endpoint, input, store);

  return { ragContext, entriesAdded: extracted.length };
}
