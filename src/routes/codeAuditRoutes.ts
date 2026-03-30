import type { Route } from "@elizaos/core";
import { x402Gate } from "../server/x402Gate.js";
import type { X402GateResult } from "../server/x402Gate.js";
import { SwarmsService } from "../services/swarmsService.js";
import type { X402ServiceEndpoint } from "../types.js";
import { saveReport } from "../utils/reportStore.js";
import { callOpenAI } from "../utils/llm.js";

// ── Helper: build public URLs for a report ───────────────────────────────

function reportUrls(id: string): {
  reportUrl: string;
  badgeUrl: string;
  badgeMarkdown: string;
} {
  const base =
    process.env.SWARMX_BASE_URL
      ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "https://api.swarmx.io");
  return {
    reportUrl: `${base}/report/${id}`,
    badgeUrl: `${base}/badge/${id}`,
    badgeMarkdown: `[![SwarmX Audit](${base}/badge/${id})](${base}/report/${id})`,
  };
}

// ── Input validation helpers ───────────────────────────────────────────

function requireString(
  body: Record<string, unknown>,
  field: string,
  maxLen = 100_000
): string | null {
  const val = body[field];
  if (!val || typeof val !== "string" || val.trim().length === 0) return null;
  return val.slice(0, maxLen);
}

// ── Helper: get SwarmsService or null ──────────────────────────────────

function getSwarmsService(runtime: any): SwarmsService | null {
  const svc = runtime.getService("SWARMS" as any) as SwarmsService | null;
  return svc?.isAvailable() ? svc : null;
}

// ── JSON parse helper ──────────────────────────────────────────────────

function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as Record<string, unknown>;
    }
  } catch {
    // not valid JSON
  }
  return null;
}

// ── Extract raw text from swarm response ───────────────────────────────

function extractSwarmOutput(result: Record<string, unknown>): string {
  const output = result.output;

  if (typeof output === "string") return output;

  if (Array.isArray(output)) {
    return output
      .map((item: unknown) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const role = obj.role ?? obj.agent_name ?? "agent";
          const content = obj.content ?? obj.text ?? obj.output ?? "";
          return `[${role}]\n${content}`;
        }
        return String(item);
      })
      .join("\n\n");
  }

  if (output && typeof output === "object") {
    const nested = output as Record<string, unknown>;
    if (typeof nested.output === "string") return nested.output;
    if (typeof nested.content === "string") return nested.content;
    return JSON.stringify(output);
  }

  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

// ── Language auto-detection ────────────────────────────────────────────

export function detectLanguage(code: string): string {
  if (/pragma\s+solidity/i.test(code)) return "solidity";
  if (/(?:^|\n)\s*def\s+/.test(code) || /(?:^|\n)\s*import\s+/.test(code)) return "python";
  if (/\bfunc\s+/.test(code) && /\bpackage\s+/.test(code)) return "go";
  if (/\bfn\s+/.test(code) && /\blet\s+mut\b/.test(code)) return "rust";
  if (/\bfunction\b/.test(code) || /\bconst\s+/.test(code) || /=>/.test(code)) return "typescript";
  if (/\bpublic\s+class\b/.test(code) || /\bprivate\s+void\b/.test(code)) return "java";
  if (/<\?php/.test(code)) return "php";
  if (/#include/.test(code)) return "c/cpp";
  return "unknown";
}

// ── Code audit result types ────────────────────────────────────────────

interface SecurityFinding {
  severity: string;
  title: string;
  description: string;
  confirmed: boolean;
  lineRef: string | null;
}

interface PerformanceFinding {
  severity: string;
  title: string;
  description: string;
  impact: string;
  suggestion: string;
}

interface QualityFinding {
  severity: string;
  title: string;
  description: string;
}

interface CodeAuditResult {
  language: string;
  overallScore: number;
  verdict: string;
  security: { score: number; findings: SecurityFinding[] };
  performance: { score: number; findings: PerformanceFinding[] };
  quality: { score: number; findings: QualityFinding[]; strengths: string[] };
}

// ── Parse individual agent outputs ─────────────────────────────────────

function parseSecurityOutput(raw: string): { findings: SecurityFinding[]; securityScore: number } {
  const parsed = tryParseJson(raw);
  if (parsed) {
    const findings = Array.isArray(parsed.findings) ? (parsed.findings as SecurityFinding[]) : [];
    const securityScore = typeof parsed.securityScore === "number"
      ? (parsed.securityScore as number)
      : 50;
    return { findings, securityScore };
  }
  return { findings: [], securityScore: 50 };
}

function parsePerformanceOutput(raw: string): { findings: PerformanceFinding[]; performanceScore: number } {
  const parsed = tryParseJson(raw);
  if (parsed) {
    const findings = Array.isArray(parsed.findings) ? (parsed.findings as PerformanceFinding[]) : [];
    const performanceScore = typeof parsed.performanceScore === "number"
      ? (parsed.performanceScore as number)
      : 50;
    return { findings, performanceScore };
  }
  return { findings: [], performanceScore: 50 };
}

function parseQualityOutput(raw: string): { findings: QualityFinding[]; strengths: string[]; qualityScore: number } {
  const parsed = tryParseJson(raw);
  if (parsed) {
    const findings = Array.isArray(parsed.findings) ? (parsed.findings as QualityFinding[]) : [];
    const strengths = Array.isArray(parsed.strengths) ? (parsed.strengths as string[]) : [];
    const qualityScore = typeof parsed.qualityScore === "number"
      ? (parsed.qualityScore as number)
      : 50;
    return { findings, strengths, qualityScore };
  }
  return { findings: [], strengths: [], qualityScore: 50 };
}

// ── Parse combined swarm output into CodeAuditResult ───────────────────

function parseCodeAuditOutput(rawOutput: string, language: string): CodeAuditResult {
  // Try to find 3 separate JSON blocks from the concurrent agents
  const jsonBlocks: string[] = [];
  const regex = /\{[\s\S]*?\}(?=\s*(?:\[|$|\{))/g;
  // Simpler: split by agent markers and extract JSON from each section
  const sections = rawOutput.split(/\[(?:SecurityReviewer|PerformanceAnalyst|BestPracticesChecker|agent)\]/i);

  let secResult = { findings: [] as SecurityFinding[], securityScore: 50 };
  let perfResult = { findings: [] as PerformanceFinding[], performanceScore: 50 };
  let qualResult = { findings: [] as QualityFinding[], strengths: [] as string[], qualityScore: 50 };

  if (sections.length >= 4) {
    // Each section after split corresponds to an agent's output
    secResult = parseSecurityOutput(sections[1]);
    perfResult = parsePerformanceOutput(sections[2]);
    qualResult = parseQualityOutput(sections[3]);
  } else {
    // Try parsing the whole output as a single JSON block
    const allJson = tryParseJson(rawOutput);
    if (allJson) {
      // Check if it's a combined result
      if (allJson.security && typeof allJson.security === "object") {
        const sec = allJson.security as Record<string, unknown>;
        secResult = {
          findings: Array.isArray(sec.findings) ? (sec.findings as SecurityFinding[]) : [],
          securityScore: typeof sec.score === "number" ? (sec.score as number) : 50,
        };
      }
      if (allJson.performance && typeof allJson.performance === "object") {
        const perf = allJson.performance as Record<string, unknown>;
        perfResult = {
          findings: Array.isArray(perf.findings) ? (perf.findings as PerformanceFinding[]) : [],
          performanceScore: typeof perf.score === "number" ? (perf.score as number) : 50,
        };
      }
      if (allJson.quality && typeof allJson.quality === "object") {
        const qual = allJson.quality as Record<string, unknown>;
        qualResult = {
          findings: Array.isArray(qual.findings) ? (qual.findings as QualityFinding[]) : [],
          strengths: Array.isArray(qual.strengths) ? (qual.strengths as string[]) : [],
          qualityScore: typeof qual.score === "number" ? (qual.score as number) : 50,
        };
      }
      // Also try top-level scores
      if (typeof allJson.securityScore === "number") secResult.securityScore = allJson.securityScore as number;
      if (typeof allJson.performanceScore === "number") perfResult.performanceScore = allJson.performanceScore as number;
      if (typeof allJson.qualityScore === "number") qualResult.qualityScore = allJson.qualityScore as number;
      if (Array.isArray(allJson.strengths) && qualResult.strengths.length === 0) {
        qualResult.strengths = allJson.strengths as string[];
      }
    } else {
      // Try to find multiple JSON blocks in the raw output
      const jsonMatches = rawOutput.match(/\{[\s\S]*?\n\}/g) ?? [];
      for (const block of jsonMatches) {
        const obj = tryParseJson(block);
        if (!obj) continue;
        if (typeof obj.securityScore === "number") {
          secResult = parseSecurityOutput(block);
        } else if (typeof obj.performanceScore === "number") {
          perfResult = parsePerformanceOutput(block);
        } else if (typeof obj.qualityScore === "number") {
          qualResult = parseQualityOutput(block);
        }
      }
    }
  }

  const overallScore = Math.round(
    secResult.securityScore * 0.50 +
    perfResult.performanceScore * 0.25 +
    qualResult.qualityScore * 0.25
  );

  let verdict: string;
  if (overallScore >= 85) verdict = "EXCELLENT";
  else if (overallScore >= 70) verdict = "GOOD";
  else if (overallScore >= 50) verdict = "NEEDS_WORK";
  else verdict = "POOR";

  return {
    language,
    overallScore,
    verdict,
    security: { score: secResult.securityScore, findings: secResult.findings },
    performance: { score: perfResult.performanceScore, findings: perfResult.findings },
    quality: { score: qualResult.qualityScore, findings: qualResult.findings, strengths: qualResult.strengths },
  };
}

// ── Free tier truncation ───────────────────────────────────────────────

function truncateCodeAuditForFreeTier(
  result: CodeAuditResult,
  gate: X402GateResult
): Record<string, unknown> {
  if (gate.amountUsd > 0) return result as any; // paid — return full
  return {
    language: result.language,
    overallScore: result.overallScore,
    verdict: result.verdict,
    security: { score: result.security.score, findingCount: result.security.findings.length },
    performance: { score: result.performance.score, findingCount: result.performance.findings.length },
    quality: { score: result.quality.score, findingCount: result.quality.findings.length },
    _preview: true,
    _message: `Verdict: ${result.verdict} (${result.overallScore}/100). Found ${result.security.findings.length} security, ${result.performance.findings.length} performance, and ${result.quality.findings.length} quality findings. Pay $0.10 to see full details.`,
  };
}

// ── Catalog ────────────────────────────────────────────────────────────

export const CODE_AUDIT_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "Code Audit",
    description:
      "Multi-agent code audit for ANY programming language — security review, performance analysis, best practices check with EXCELLENT/GOOD/NEEDS_WORK/POOR verdict (ConcurrentWorkflow, 3 agents)",
    path: "/x402/code-audit",
    method: "POST",
    priceUsd: "0.10",
  },
];

// ── Agent definitions ──────────────────────────────────────────────────

function securityReviewerAgent(language: string) {
  return {
    agent_name: "SecurityReviewer",
    system_prompt:
      `You are a code security reviewer. Analyze code for: injection vulnerabilities, authentication/authorization flaws, cryptographic issues, data exposure, input validation gaps, concurrency bugs, memory safety issues. Tag each finding as 'confirmed' (directly visible in code) or 'potential' (possible depending on context). Reference specific line numbers or code patterns. If the code is too short for meaningful security analysis, say so. Do NOT pad findings. Output JSON: { findings: [{severity: "critical"|"high"|"medium"|"low"|"info", title: "...", description: "...", confirmed: true|false, lineRef: "..."|null}], securityScore: 0-100 (100=perfect) }. Output ONLY JSON.`,
    model_name: "gpt-4o",
    role: "worker" as const,
    max_loops: 1,
    max_tokens: 4096,
    temperature: 0.15,
  };
}

function performanceAnalystAgent() {
  return {
    agent_name: "PerformanceAnalyst",
    system_prompt:
      `You are a code performance analyst. Analyze for: algorithmic complexity issues (flag O(n^2) where O(n) possible), memory patterns (leaks, unnecessary allocations), I/O antipatterns (N+1 queries, missing batching), missing caching/memoization, wrong data structure choices. Each finding includes estimated impact (high|medium|low). Output JSON: { findings: [{severity: "high"|"medium"|"low", title: "...", description: "...", impact: "...", suggestion: "..."}], performanceScore: 0-100 (100=optimal) }. Output ONLY JSON.`,
    model_name: "gpt-4o-mini",
    role: "worker" as const,
    max_loops: 1,
    max_tokens: 4096,
    temperature: 0.25,
  };
}

function bestPracticesCheckerAgent() {
  return {
    agent_name: "BestPracticesChecker",
    system_prompt:
      `You are a code quality reviewer. Analyze for: naming conventions, error handling quality, code organization (SRP, DRY), documentation gaps, testing gaps, language-specific idiom violations. ALSO list strengths — well-written code deserves recognition. Output JSON: { findings: [{severity: "medium"|"low"|"info", title: "...", description: "..."}], strengths: ["..."], qualityScore: 0-100 (100=excellent) }. Output ONLY JSON.`,
    model_name: "gpt-4o-mini",
    role: "worker" as const,
    max_loops: 1,
    max_tokens: 4096,
    temperature: 0.3,
  };
}

// ── Routes ─────────────────────────────────────────────────────────────

export const codeAuditRoutes: Route[] = [
  {
    type: "POST",
    path: "/x402/code-audit",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.10",
        description: "Multi-agent code audit — security, performance, quality (3 agents, ConcurrentWorkflow)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const code = requireString(body, "code");
      if (!code) {
        res.status(400).json({ error: "Missing required field: code (non-empty string)" });
        return;
      }

      const language: string =
        typeof body.language === "string" && body.language.trim().length > 0
          ? body.language.trim()
          : detectLanguage(code);

      const swarmsService = getSwarmsService(runtime);

      // Fallback: if Swarms unavailable, run SecurityReviewer only via callOpenAI
      if (!swarmsService) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          res.status(503).json({ error: "Swarms service unavailable" });
          return;
        }

        try {
          const agent = securityReviewerAgent(language);
          const secRaw = await callOpenAI({
            apiKey,
            model: agent.model_name,
            systemPrompt: agent.system_prompt,
            userPrompt: `Analyze this ${language} code:\n\n\`\`\`\n${code}\n\`\`\``,
            maxTokens: agent.max_tokens,
            temperature: agent.temperature,
          });

          const secResult = parseSecurityOutput(secRaw);
          const overallScore = secResult.securityScore;
          let verdict: string;
          if (overallScore >= 85) verdict = "EXCELLENT";
          else if (overallScore >= 70) verdict = "GOOD";
          else if (overallScore >= 50) verdict = "NEEDS_WORK";
          else verdict = "POOR";

          const auditResult: CodeAuditResult = {
            language,
            overallScore,
            verdict,
            security: { score: secResult.securityScore, findings: secResult.findings },
            performance: { score: 0, findings: [] },
            quality: { score: 0, findings: [], strengths: [] },
          };
          const truncated = truncateCodeAuditForFreeTier(auditResult, gate);

          const reportId = saveReport({
            type: "code-audit",
            createdAt: new Date().toISOString(),
            input: { code: code.slice(0, 2000), language },
            result: auditResult,
            riskScore: 100 - overallScore,
            paid: gate.amountUsd > 0,
          });
          const urls = reportUrls(reportId);

          res.json({
            ...truncated,
            ...urls,
            template: "CodeAudit",
            _degraded: true,
            freeRemaining: gate.freeRemaining,
            payment: {
              amount: "0.10",
              transaction: gate.transaction,
              network: gate.network,
            },
          });
          return;
        } catch (err) {
          runtime.logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            "[x402/code-audit] Fallback OpenAI call failed"
          );
          res.status(503).json({ error: "Swarms service unavailable" });
          return;
        }
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `code-audit-${Date.now()}`,
          description: `Code audit (${language})`,
          agents: [
            securityReviewerAgent(language),
            performanceAnalystAgent(),
            bestPracticesCheckerAgent(),
          ],
          swarm_type: "ConcurrentWorkflow",
          task:
            `Audit the following ${language} code. Each agent should analyze from their specialization.\n\n` +
            "```\n" +
            code +
            "\n```",
          max_loops: 1,
        });

        const rawOutput = extractSwarmOutput(result);
        const audit = parseCodeAuditOutput(rawOutput, language);
        const truncated = truncateCodeAuditForFreeTier(audit, gate);

        const reportId = saveReport({
          type: "code-audit",
          createdAt: new Date().toISOString(),
          input: { code: code.slice(0, 2000), language },
          result: audit,
          riskScore: 100 - audit.overallScore,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        res.json({
          ...truncated,
          ...urls,
          template: "CodeAudit",
          freeRemaining: gate.freeRemaining,
          payment: {
            amount: "0.10",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/code-audit] Swarm execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },
];
