/**
 * Knowledge Extractor — distills atomic facts from endpoint results.
 *
 * Each endpoint type has specific extraction rules that pull out
 * structured knowledge entries (scores, findings, verdicts, flags)
 * from the raw API response.
 *
 * No LLM calls here — pure deterministic extraction from structured JSON.
 * The LLM-based extraction (research §6.4) comes in a later phase.
 */

import type { KnowledgeEntry, KnowledgeType } from "./store.js";

type PartialEntry = Omit<KnowledgeEntry, "id" | "timestamp">;

/**
 * Extract knowledge entries from an endpoint's input/result pair.
 * Returns 0-N entries depending on how much structured data is available.
 */
export function extractKnowledge(
  endpoint: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): PartialEntry[] {
  const normalized = normalizeEndpoint(endpoint);

  switch (normalized) {
    case "contract-audit":
    case "code-audit":
      return extractFromContractAudit(endpoint, input, result);
    case "memecoin-score":
      return extractFromMemecoinScore(endpoint, input, result);
    case "token-diligence":
      return extractFromTokenDiligence(endpoint, input, result);
    case "defi-risk-score":
      return extractFromDefiRisk(endpoint, input, result);
    case "fact-check":
      return extractFromFactCheck(endpoint, input, result);
    case "wallet-risk-score":
      return extractFromWalletRisk(endpoint, input, result);
    case "token-risk":
      return extractFromTokenRisk(endpoint, input, result);
    default:
      return extractGeneric(endpoint, input, result);
  }
}

// ── Endpoint normalization ────────────────────────────────────────────

function normalizeEndpoint(endpoint: string): string {
  const lower = endpoint.toLowerCase();

  // Match known endpoint patterns anywhere in the path
  if (lower.includes("contract-audit") || lower.includes("code-audit")) {
    // "/audit/contract" or "/x402/contract-audit"
    if (lower.includes("code-audit")) return "code-audit";
    return "contract-audit";
  }
  if (lower.includes("memecoin-score")) return "memecoin-score";
  if (lower.includes("token-diligence")) return "token-diligence";
  if (lower.includes("defi-risk-score")) return "defi-risk-score";
  if (lower.includes("fact-check")) return "fact-check";
  if (lower.includes("wallet-risk")) return "wallet-risk-score";
  if (lower.includes("token-risk")) return "token-risk";

  // Fallback: "/audit/contract" -> check last two segments
  const segments = endpoint.split("/").filter(Boolean);
  if (segments.length >= 2) {
    const combined = `${segments[segments.length - 2]}-${segments[segments.length - 1]}`.toLowerCase();
    if (combined === "audit-contract") return "contract-audit";
  }

  // Last segment fallback
  return segments.pop()?.toLowerCase() ?? endpoint.toLowerCase();
}

// ── Extraction: contract-audit / code-audit ───────────────────────────

function extractFromContractAudit(
  source: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): PartialEntry[] {
  const entries: PartialEntry[] = [];
  const subject = str(input.code)?.slice(0, 80) ?? str(input.mint) ?? "unknown-contract";

  // Overall score
  const riskScore = num(result.riskScore);
  const verdict = str(result.verdict);
  if (riskScore != null || verdict) {
    entries.push({
      type: "audit-finding",
      subject,
      content: `Contract audit: ${verdict ?? "unknown"} verdict, risk score ${riskScore ?? "N/A"}/100`,
      score: riskScore ?? undefined,
      source,
      metadata: { riskScore, verdict },
    });
  }

  // Individual findings
  const findings = result.findings as Record<string, unknown[]> | undefined;
  if (findings && typeof findings === "object") {
    for (const [category, items] of Object.entries(findings)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const f = item as Record<string, unknown>;
        const severity = str(f.severity) ?? "INFO";
        const title = str(f.title) ?? str(f.description) ?? "unnamed finding";
        entries.push({
          type: "audit-finding",
          subject,
          content: `[${severity}] ${title}${str(f.description) ? ": " + str(f.description) : ""}`,
          score: severityToScore(severity),
          source,
          metadata: { category, severity, title },
        });
      }
    }
  }

  // Red flags
  pushArrayEntries(entries, result.redFlags, "risk-flag", subject, source);
  pushArrayEntries(entries, result.red_flags, "risk-flag", subject, source);

  return entries;
}

// ── Extraction: memecoin-score ────────────────────────────────────────

function extractFromMemecoinScore(
  source: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): PartialEntry[] {
  const entries: PartialEntry[] = [];
  const mint = str(input.mint) ?? "unknown-mint";

  // Overall score + verdict
  const score = num(result.score);
  const verdict = str(result.verdict);
  if (score != null || verdict) {
    entries.push({
      type: "token-score",
      subject: mint,
      content: `Memecoin score: ${score ?? "N/A"}/100, verdict ${verdict ?? "unknown"}`,
      score: score ?? undefined,
      source,
      metadata: { score, verdict },
    });
  }

  // Contract authority info
  const contract = result.contract as Record<string, unknown> | undefined;
  if (contract && typeof contract === "object") {
    const mintAuth = str(contract.mintAuthority);
    const freezeAuth = str(contract.freezeAuthority);
    if (mintAuth) {
      entries.push({
        type: "risk-flag",
        subject: mint,
        content: `Mint authority: ${mintAuth}${mintAuth === "active" ? " (risk: new tokens can be minted)" : ""}`,
        score: mintAuth === "active" ? 80 : 20,
        source,
        metadata: { mintAuthority: mintAuth, freezeAuthority: freezeAuth },
      });
    }
  }

  // Red flags
  pushArrayEntries(entries, result.redFlags, "risk-flag", mint, source);

  return entries;
}

// ── Extraction: token-diligence ───────────────────────────────────────

function extractFromTokenDiligence(
  source: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): PartialEntry[] {
  const entries: PartialEntry[] = [];
  const mint = str(input.mint) ?? "unknown-mint";

  // Overall verdict
  const overallScore = num(result.overallScore);
  const verdict = str(result.verdict);
  if (overallScore != null || verdict) {
    entries.push({
      type: "token-score",
      subject: mint,
      content: `Token diligence: ${verdict ?? "unknown"} (${overallScore ?? "N/A"}/100)`,
      score: overallScore ?? undefined,
      source,
      metadata: { overallScore, verdict },
    });
  }

  // Dimension scores
  const dimensions = result.dimensions as Record<string, unknown> | undefined;
  if (dimensions && typeof dimensions === "object") {
    for (const [dim, val] of Object.entries(dimensions)) {
      if (!val || typeof val !== "object") continue;
      const d = val as Record<string, unknown>;
      const dimScore = num(d.score);
      if (dimScore != null) {
        entries.push({
          type: "token-score",
          subject: mint,
          content: `${dim} dimension: ${dimScore}/100 (weight: ${num(d.weight) ?? "?"}%)`,
          score: dimScore,
          source,
          metadata: { dimension: dim, dimScore, weight: num(d.weight) },
        });
      }
    }
  }

  // Red flags and green flags
  pushArrayEntries(entries, result.redFlags, "risk-flag", mint, source);
  pushArrayEntries(entries, result.greenFlags, "general", mint, source, "green-flag");

  return entries;
}

// ── Extraction: defi-risk-score ───────────────────────────────────────

function extractFromDefiRisk(
  source: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): PartialEntry[] {
  const entries: PartialEntry[] = [];
  const protocol = str(result.protocol) ?? str(input.protocol) ?? str(input.mint) ?? "unknown-protocol";

  // Overall rating
  const overallScore = num(result.overallScore);
  const rating = str(result.rating);
  if (overallScore != null || rating) {
    entries.push({
      type: "defi-rating",
      subject: protocol,
      content: `DeFi risk rating: ${rating ?? "unrated"} (${overallScore ?? "N/A"}/100)`,
      score: overallScore ?? undefined,
      source,
      metadata: { overallScore, rating, chain: str(result.chain) },
    });
  }

  // Dimension scores
  const dimensions = result.dimensions as Record<string, unknown> | undefined;
  if (dimensions && typeof dimensions === "object") {
    for (const [dim, val] of Object.entries(dimensions)) {
      if (!val || typeof val !== "object") continue;
      const d = val as Record<string, unknown>;
      const dimScore = num(d.score);
      if (dimScore != null) {
        entries.push({
          type: "defi-rating",
          subject: protocol,
          content: `${dim}: ${dimScore}/100${str(d.summary) ? " — " + str(d.summary) : ""}`,
          score: dimScore,
          source,
          metadata: { dimension: dim, dimScore, weight: num(d.weight) },
        });
      }
    }
  }

  // Key risks
  pushArrayEntries(entries, result.keyRisks, "risk-flag", protocol, source);

  return entries;
}

// ── Extraction: fact-check ────────────────────────────────────────────

function extractFromFactCheck(
  source: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): PartialEntry[] {
  const entries: PartialEntry[] = [];
  const claim = str(input.claim) ?? str(input.code) ?? "unknown-claim";

  // Overall veracity
  const veracity = num(result.overallVeracity);
  if (veracity != null) {
    entries.push({
      type: "fact-verdict",
      subject: claim.slice(0, 200),
      content: `Fact-check veracity: ${veracity}/100 (${num(result.totalClaims) ?? 0} claims analyzed)`,
      score: veracity,
      source,
      metadata: { overallVeracity: veracity, verdictCounts: result.verdictCounts },
    });
  }

  // Individual verdicts
  const verdicts = result.verdicts as unknown[];
  if (Array.isArray(verdicts)) {
    for (const v of verdicts) {
      if (!v || typeof v !== "object") continue;
      const vObj = v as Record<string, unknown>;
      const vClaim = str(vObj.claim) ?? claim.slice(0, 100);
      const vVerdict = str(vObj.verdict) ?? "UNVERIFIED";
      const confidence = num(vObj.confidence);
      entries.push({
        type: "fact-verdict",
        subject: vClaim.slice(0, 200),
        content: `Verdict: ${vVerdict}${confidence != null ? ` (confidence: ${confidence})` : ""}${str(vObj.reasoning) ? " — " + str(vObj.reasoning) : ""}`,
        score: confidence != null ? Math.round(confidence * 100) : undefined,
        source,
        metadata: { verdict: vVerdict, confidence },
      });
    }
  }

  return entries;
}

// ── Extraction: wallet-risk-score ─────────────────────────────────────

function extractFromWalletRisk(
  source: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): PartialEntry[] {
  const entries: PartialEntry[] = [];
  const address = str(input.address) ?? str(input.mint) ?? "unknown-wallet";

  // Risk level
  const riskScore = num(result.riskScore);
  const riskLevel = str(result.riskLevel);
  if (riskScore != null || riskLevel) {
    entries.push({
      type: "risk-flag",
      subject: address,
      content: `Wallet risk: ${riskLevel ?? "unknown"} (${riskScore ?? "N/A"}/100)`,
      score: riskScore ?? undefined,
      source,
      metadata: { riskScore, riskLevel },
    });
  }

  // Behavioral patterns
  const patterns = result.patterns as unknown[];
  if (Array.isArray(patterns)) {
    for (const p of patterns) {
      if (!p || typeof p !== "object") continue;
      const pObj = p as Record<string, unknown>;
      const pType = str(pObj.type) ?? "unknown-pattern";
      const desc = str(pObj.description) ?? pType;
      entries.push({
        type: "risk-flag",
        subject: address,
        content: `Behavioral pattern: ${desc} (risk: ${str(pObj.riskLevel) ?? "unknown"})`,
        score: riskLevelToScore(str(pObj.riskLevel)),
        source,
        metadata: { patternType: pType, riskLevel: str(pObj.riskLevel) },
      });
    }
  }

  // Flags
  pushArrayEntries(entries, result.flags, "risk-flag", address, source);

  return entries;
}

// ── Extraction: token-risk ────────────────────────────────────────────

function extractFromTokenRisk(
  source: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): PartialEntry[] {
  const entries: PartialEntry[] = [];
  const mint = str(input.mint) ?? "unknown-mint";

  const riskScore = num(result.riskScore);
  const verdict = str(result.verdict);
  if (riskScore != null || verdict) {
    entries.push({
      type: "token-score",
      subject: mint,
      content: `Token risk: ${verdict ?? "unknown"} (${riskScore ?? "N/A"}/100)`,
      score: riskScore ?? undefined,
      source,
      metadata: { riskScore, verdict },
    });
  }

  return entries;
}

// ── Extraction: generic fallback ──────────────────────────────────────

function extractGeneric(
  source: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): PartialEntry[] {
  const entries: PartialEntry[] = [];

  // Try to find a summary or key finding
  const summary = str(result.summary) ?? str(result.content) ?? str(result.text);
  if (summary) {
    const subject =
      str(input.mint) ??
      str(input.address) ??
      str(input.protocol) ??
      str(input.query) ??
      source;

    entries.push({
      type: "general",
      subject,
      content: summary.slice(0, 500),
      source,
      metadata: {},
    });
  }

  return entries;
}

// ── Utility helpers ───────────────────────────────────────────────────

function str(val: unknown): string | undefined {
  return typeof val === "string" && val.length > 0 ? val : undefined;
}

function num(val: unknown): number | undefined {
  return typeof val === "number" && Number.isFinite(val) ? val : undefined;
}

function severityToScore(severity: string): number {
  switch (severity.toUpperCase()) {
    case "CRITICAL": return 95;
    case "HIGH": return 80;
    case "MEDIUM": return 55;
    case "LOW": return 30;
    case "INFO": return 10;
    default: return 50;
  }
}

function riskLevelToScore(level: string | undefined): number | undefined {
  if (!level) return undefined;
  switch (level.toLowerCase()) {
    case "critical": return 95;
    case "high": return 80;
    case "elevated": return 60;
    case "moderate": return 40;
    case "low": return 20;
    default: return 50;
  }
}

function pushArrayEntries(
  entries: PartialEntry[],
  arr: unknown,
  type: KnowledgeType,
  subject: string,
  source: string,
  tag?: string,
): void {
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    if (typeof item === "string" && item.length > 0) {
      entries.push({
        type,
        subject,
        content: tag ? `[${tag}] ${item}` : item,
        source,
        metadata: { tag },
      });
    }
  }
}
