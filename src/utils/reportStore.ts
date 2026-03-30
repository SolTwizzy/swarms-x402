/**
 * Report store — persistent JSONL-backed Map for audit/risk/review reports.
 *
 * Accessed by:
 * - src/routes/cryptoRoutes.ts (save after audit)
 * - server.ts (render report page + badge)
 *
 * Storage strategy:
 * - In-memory Map (capped at 1000) for fast reads
 * - Append-only JSONL file (data/reports.jsonl) for persistence across restarts
 * - On module load: restore in-memory Map from disk
 * - On getReport(): check in-memory first, fall back to scanning JSONL file
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface AuditReport {
  id: string;
  type: "contract-audit" | "token-risk" | "code-review" | "code-audit" | "research-report" | "investment-dd" | "token-diligence" | "defi-risk-score" | "fact-check" | "deep-research" | "monitor";
  createdAt: string;
  input: { code?: string; mint?: string; language?: string; chain?: string };
  result: unknown;
  riskScore: number | null;
  paid: boolean;
}

const MAX_REPORTS = 1000;
const reports = new Map<string, AuditReport>();
const insertionOrder: string[] = [];

/* ── Resolve data directory relative to project root ── */
let DATA_DIR: string;
try {
  // Works in ESM context
  const thisFile = fileURLToPath(import.meta.url);
  DATA_DIR = join(dirname(thisFile), "..", "..", "data");
} catch {
  // Fallback: cwd-based
  DATA_DIR = join(process.cwd(), "data");
}
const JSONL_PATH = join(DATA_DIR, "reports.jsonl");

/** Ensure data/ directory exists. */
function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Append a single report to the JSONL file (fire-and-forget safe). */
function appendToDisk(report: AuditReport): void {
  try {
    ensureDataDir();
    appendFileSync(JSONL_PATH, JSON.stringify(report) + "\n", "utf-8");
  } catch {
    // Disk write failure should never block the request flow
  }
}

/** Scan the JSONL file for a specific report ID. */
function scanDiskForReport(id: string): AuditReport | null {
  try {
    if (!existsSync(JSONL_PATH)) return null;
    const raw = readFileSync(JSONL_PATH, "utf-8");
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as AuditReport;
        if (parsed.id === id) return parsed;
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File read failure
  }
  return null;
}

/** Restore in-memory Map from JSONL on module load. */
function restoreFromDisk(): void {
  try {
    if (!existsSync(JSONL_PATH)) return;
    const raw = readFileSync(JSONL_PATH, "utf-8");
    const lines = raw.split("\n");
    // Read all lines, but only keep the most recent MAX_REPORTS in memory
    const allReports: AuditReport[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        allReports.push(JSON.parse(trimmed) as AuditReport);
      } catch {
        // Skip malformed lines
      }
    }
    // Load the most recent MAX_REPORTS into memory
    const toLoad = allReports.slice(-MAX_REPORTS);
    for (const r of toLoad) {
      if (!reports.has(r.id)) {
        reports.set(r.id, r);
        insertionOrder.push(r.id);
      }
    }
  } catch {
    // Disk restore failure is non-fatal
  }
}

// Restore on module load
restoreFromDisk();

/** Generate an 8-char hex ID. */
function generateId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Save a report and return its unique ID.
 */
export function saveReport(
  report: Omit<AuditReport, "id">
): string {
  // Prune oldest when at capacity
  while (reports.size >= MAX_REPORTS && insertionOrder.length > 0) {
    const oldest = insertionOrder.shift()!;
    reports.delete(oldest);
  }

  const id = generateId();
  const full: AuditReport = { ...report, id };
  reports.set(id, full);
  insertionOrder.push(id);

  // Persist to disk (fire-and-forget)
  appendToDisk(full);

  return id;
}

/**
 * Retrieve a report by ID, or null if not found.
 * Checks in-memory first, then falls back to scanning the JSONL file.
 */
export function getReport(id: string): AuditReport | null {
  const inMemory = reports.get(id);
  if (inMemory) return inMemory;

  // Fall back to disk scan (handles reports evicted from in-memory cache)
  return scanDiskForReport(id);
}

/**
 * Get the N most recent reports (newest first).
 */
export function getRecentReports(limit = 10): AuditReport[] {
  const ids = insertionOrder.slice(-limit).reverse();
  const result: AuditReport[] = [];
  for (const id of ids) {
    const r = reports.get(id);
    if (r) result.push(r);
  }
  return result;
}

/**
 * Total number of stored reports.
 */
export function getReportCount(): number {
  return reports.size;
}
