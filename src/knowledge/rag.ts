/**
 * RAG Retriever — builds contextual knowledge blocks to inject into agent prompts.
 *
 * Before each paid API call, we search the KnowledgeStore for relevant past
 * analyses and format them as a structured context block. This enriches agent
 * system prompts with historical data so future analyses are better-informed.
 *
 * Context is capped at ~2000 tokens to avoid prompt bloat.
 *
 * Supports both sync (JSONL KnowledgeStore) and async (VectorKnowledgeStore)
 * backends. When a VectorKnowledgeStore is provided, semantic search is used
 * instead of keyword matching — "reentrancy vulnerability" will match
 * "recursive call exploit".
 */

import type { KnowledgeStore, KnowledgeEntry, KnowledgeType } from "./store.js";
import type { VectorKnowledgeStore } from "./vectorStore.js";

/** Maximum characters for the RAG context block (~2000 tokens at ~4 chars/token). */
const MAX_CONTEXT_CHARS = 8000;

/** Union type for both store implementations. */
export type AnyKnowledgeStore = KnowledgeStore | VectorKnowledgeStore;

// ── Type guard ───────────────────────────────────────────────────────

function isVectorStore(store: AnyKnowledgeStore): store is VectorKnowledgeStore {
  return "semanticSearch" in store && typeof (store as VectorKnowledgeStore).semanticSearch === "function";
}

// ── Async search helpers ─────────────────────────────────────────────

async function searchBySubjectAsync(
  store: AnyKnowledgeStore,
  subject: string,
  limit: number,
): Promise<KnowledgeEntry[]> {
  if (isVectorStore(store)) {
    return store.searchBySubject(subject, limit);
  }
  return store.searchBySubject(subject, limit);
}

async function searchByTypeAsync(
  store: AnyKnowledgeStore,
  type: KnowledgeType,
  limit: number,
): Promise<KnowledgeEntry[]> {
  if (isVectorStore(store)) {
    return store.searchByType(type, limit);
  }
  return store.searchByType(type, limit);
}

async function searchAsync(
  store: AnyKnowledgeStore,
  query: string,
  limit: number,
): Promise<KnowledgeEntry[]> {
  if (isVectorStore(store)) {
    return store.search(query, limit);
  }
  return store.search(query, limit);
}

// ── Main builder ─────────────────────────────────────────────────────

/**
 * Build a RAG context string for a given endpoint + input.
 * Returns empty string if no relevant knowledge is found (don't inject noise).
 *
 * Supports both KnowledgeStore (sync, JSONL) and VectorKnowledgeStore
 * (async, pgvector). When using VectorKnowledgeStore, the keyword search
 * section is upgraded to semantic search.
 */
export async function buildRAGContext(
  endpoint: string,
  input: Record<string, unknown>,
  store: AnyKnowledgeStore,
): Promise<string> {
  const normalized = normalizeEndpoint(endpoint);
  const subject = extractSubject(input);

  const sections: string[] = [];
  let charBudget = MAX_CONTEXT_CHARS;

  // ── 1. Direct match: exact subject ──────────────────────────────────
  if (subject) {
    const direct = await searchBySubjectAsync(store, subject, 5);
    if (direct.length > 0) {
      const section = formatSection(
        "PREVIOUS ANALYSES OF THIS SUBJECT",
        direct,
        charBudget,
      );
      if (section) {
        sections.push(section);
        charBudget -= section.length;
      }
    }
  }

  // ── 2. Type-specific context ────────────────────────────────────────
  const relevantType = endpointToKnowledgeType(normalized);
  if (relevantType && charBudget > 200) {
    const byType = await searchByTypeAsync(store, relevantType, 10);
    // Exclude entries already shown in direct match
    const directIds = new Set(
      subject ? (await searchBySubjectAsync(store, subject, 5)).map((e) => e.id) : [],
    );
    const filtered = byType.filter((e) => !directIds.has(e.id));

    if (filtered.length > 0) {
      const section = formatSection(
        "RELATED PAST ANALYSES",
        filtered.slice(0, 5),
        charBudget,
      );
      if (section) {
        sections.push(section);
        charBudget -= section.length;
      }
    }
  }

  // ── 3. Keyword / semantic search for broader context ────────────────
  if (charBudget > 200) {
    const query = buildSearchQuery(normalized, input);
    if (query) {
      const keywordResults = await searchAsync(store, query, 10);
      // Exclude entries already shown
      const shownIds = new Set<string>();
      if (subject) {
        for (const e of await searchBySubjectAsync(store, subject, 5)) shownIds.add(e.id);
      }
      if (relevantType) {
        for (const e of await searchByTypeAsync(store, relevantType, 10)) shownIds.add(e.id);
      }
      const filtered = keywordResults.filter((e) => !shownIds.has(e.id));

      if (filtered.length > 0) {
        const section = formatSection(
          "ADDITIONAL CONTEXT",
          filtered.slice(0, 3),
          charBudget,
        );
        if (section) {
          sections.push(section);
        }
      }
    }
  }

  if (sections.length === 0) return "";

  // ── Wrap in context block ───────────────────────────────────────────
  const totalEntries = sections.join("\n");
  return (
    "\n[HISTORICAL CONTEXT -- from SwarmX knowledge base]\n" +
    totalEntries +
    "\nUse this context to improve your analysis. Reference historical data where relevant.\n" +
    "If a token/contract was previously analyzed, compare with current findings.\n" +
    "[END HISTORICAL CONTEXT]\n"
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function normalizeEndpoint(endpoint: string): string {
  const last = endpoint.split("/").filter(Boolean).pop() ?? endpoint;
  return last.toLowerCase();
}

function extractSubject(input: Record<string, unknown>): string | undefined {
  const mint = input.mint;
  if (typeof mint === "string" && mint.length > 0) return mint;
  const address = input.address;
  if (typeof address === "string" && address.length > 0) return address;
  const protocol = input.protocol;
  if (typeof protocol === "string" && protocol.length > 0) return protocol;
  const claim = input.claim;
  if (typeof claim === "string" && claim.length > 0) return claim.slice(0, 200);
  return undefined;
}

function endpointToKnowledgeType(
  endpoint: string,
): KnowledgeType | undefined {
  switch (endpoint) {
    case "contract-audit":
    case "code-audit":
      return "audit-finding";
    case "memecoin-score":
    case "token-risk":
    case "token-diligence":
      return "token-score";
    case "defi-risk-score":
      return "defi-rating";
    case "fact-check":
      return "fact-verdict";
    case "wallet-risk-score":
      return "risk-flag";
    default:
      return undefined;
  }
}

function buildSearchQuery(
  endpoint: string,
  input: Record<string, unknown>,
): string | undefined {
  const parts: string[] = [];

  // Add endpoint-specific keywords
  switch (endpoint) {
    case "memecoin-score":
      parts.push("memecoin", "score", "verdict");
      break;
    case "token-diligence":
      parts.push("token", "diligence", "contract", "tokenomics");
      break;
    case "defi-risk-score":
      parts.push("defi", "risk", "protocol", "rating");
      break;
    case "fact-check":
      parts.push("fact", "check", "verdict", "claim");
      break;
    case "wallet-risk-score":
      parts.push("wallet", "risk", "pattern");
      break;
    case "contract-audit":
    case "code-audit":
      parts.push("audit", "security", "vulnerability");
      break;
  }

  // Add subject terms
  if (typeof input.mint === "string") parts.push(input.mint.slice(0, 20));
  if (typeof input.protocol === "string") parts.push(input.protocol.slice(0, 50));

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function formatSection(
  title: string,
  entries: KnowledgeEntry[],
  maxChars: number,
): string | null {
  if (entries.length === 0) return null;

  const lines: string[] = [`--- ${title} (${entries.length} entries) ---`];
  let chars = lines[0].length;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const line =
      `${i + 1}. [${e.timestamp.slice(0, 10)}] ${e.subject.slice(0, 40)}: ` +
      `${e.content.slice(0, 200)}` +
      (e.score != null ? ` (score: ${e.score})` : "");

    if (chars + line.length + 1 > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }

  if (lines.length <= 1) return null; // Only the header, no entries fit
  lines.push(`--- END ${title} ---`);
  return lines.join("\n");
}
