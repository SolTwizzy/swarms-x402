import type { Route } from "@elizaos/core";
import { x402Gate } from "../server/x402Gate.js";
import type { X402GateResult } from "../server/x402Gate.js";
import { SwarmsService } from "../services/swarmsService.js";
import type { X402ServiceEndpoint } from "../types.js";
import { SOLANA_ADDR_RE, heliusRpcUrl, rpcCall } from "./heliusDataRoutes.js";
import { saveReport } from "../utils/reportStore.js";

// ── Helper: build public URLs for a report ───────────────────────────────

function reportUrls(id: string): {
  reportUrl: string;
  badgeUrl: string;
  badgeMarkdown: string;
} {
  const base =
    process.env.SWARMX_BASE_URL
      ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "https://swarmx.io");
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

// ── JSON parse helper (try JSON first, fallback to raw text) ───────────

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

// ── Helper: extract raw text from swarm response ─────────────────────
// Swarms API `output` can be:
//   - a plain string
//   - an array of { role: string; content: string } objects
//   - a nested object with an `output` key
// This normalizes all formats to a single concatenated string.

function extractSwarmOutput(result: Record<string, unknown>): string {
  const output = result.output;

  // Case 1: output is a string
  if (typeof output === "string") return output;

  // Case 2: output is an array of agent messages
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

  // Case 3: output is a nested object (e.g. { output: "..." })
  if (output && typeof output === "object") {
    const nested = output as Record<string, unknown>;
    if (typeof nested.output === "string") return nested.output;
    if (typeof nested.content === "string") return nested.content;
    // Last resort: stringify the object
    return JSON.stringify(output);
  }

  // Case 4: no output field — try the whole result
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

// ── Helper: estimate risk score from severity keywords in text ────────
// Scans for CRITICAL, HIGH, MEDIUM, LOW, INFO keywords and produces 0-100.

function estimateRiskScore(text: string): number {
  const upper = text.toUpperCase();
  const critical = (upper.match(/\bCRITICAL\b/g) ?? []).length;
  const high = (upper.match(/\bHIGH\b/g) ?? []).length;
  const medium = (upper.match(/\bMEDIUM\b/g) ?? []).length;
  const low = (upper.match(/\bLOW\b/g) ?? []).length;

  // Weighted scoring: critical=25, high=15, medium=8, low=3
  const raw = critical * 25 + high * 15 + medium * 8 + low * 3;
  // Clamp to 0-100
  return Math.min(100, Math.max(0, raw));
}

// ── Helper: extract contract audit findings from unstructured text ────

interface ContractAuditResult {
  riskScore: number;
  verdict: string;
  findings: { security: unknown[]; economic: unknown[]; gas: unknown[] };
  strengths: string[];
  weaknesses: string[];
  redFlags: string[];
  copyLikelihoodScore: number;
  complexityScore: number;
  summary: string;
}

function parseContractAuditText(text: string): ContractAuditResult {
  // Try to find structured JSON first (the reporter should produce valid JSON)
  const parsed = tryParseJson(text);
  if (parsed && typeof parsed.riskScore === "number") {
    const riskScore = parsed.riskScore as number;
    // Derive verdict from score if not provided
    let verdict = (parsed.verdict as string) ?? "CAUTION";
    if (!parsed.verdict) {
      if (riskScore >= 85) verdict = "SAFE";
      else if (riskScore >= 50) verdict = "CAUTION";
      else verdict = "DANGER";
    }
    return {
      riskScore,
      verdict,
      findings: (parsed.findings as any) ?? { security: [], economic: [], gas: [] },
      strengths: Array.isArray(parsed.strengths) ? (parsed.strengths as string[]) : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? (parsed.weaknesses as string[]) : [],
      redFlags: Array.isArray(parsed.red_flags) ? (parsed.red_flags as string[]) :
                Array.isArray(parsed.redFlags) ? (parsed.redFlags as string[]) : [],
      copyLikelihoodScore: typeof parsed.copy_likelihood_score === "number"
        ? (parsed.copy_likelihood_score as number)
        : typeof parsed.copyLikelihoodScore === "number"
          ? (parsed.copyLikelihoodScore as number)
          : 0,
      complexityScore: typeof parsed.complexity_score === "number"
        ? (parsed.complexity_score as number)
        : typeof parsed.complexityScore === "number"
          ? (parsed.complexityScore as number)
          : 50,
      summary: (parsed.summary as string) ?? text.slice(0, 500),
    };
  }

  // Extract findings from each agent section
  const security: unknown[] = [];
  const economic: unknown[] = [];
  const gas: unknown[] = [];

  // Try to extract individual JSON blocks from each agent's output
  const jsonBlocks = text.match(/\{[\s\S]*?\n\}/g) ?? [];
  for (const block of jsonBlocks) {
    const obj = tryParseJson(block);
    if (!obj) continue;
    const findings = Array.isArray(obj.findings) ? (obj.findings as unknown[]) : [];
    // Categorize by surrounding context or finding content
    const blockContext = text.slice(
      Math.max(0, text.indexOf(block) - 200),
      text.indexOf(block)
    );
    if (/security|auditor|reentrancy|vulnerability|access.control/i.test(blockContext)) {
      security.push(...findings);
    } else if (/economic|attack|mev|sandwich|flashloan|arbitrage/i.test(blockContext)) {
      economic.push(...findings);
    } else if (/gas|optim|sload|storage.packing|calldata/i.test(blockContext)) {
      gas.push(...findings);
    } else {
      // If we can't tell, add to security by default
      security.push(...findings);
    }
  }

  // If no JSON blocks found, extract bullet-point findings
  if (security.length === 0 && economic.length === 0 && gas.length === 0) {
    const findingRegex = /(?:^|\n)\s*[-*•]\s*((?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\s*[:\-–]\s*.+)/gi;
    let match;
    while ((match = findingRegex.exec(text)) !== null) {
      const line = match[1]!.trim();
      const severity = line.match(/^(CRITICAL|HIGH|MEDIUM|LOW|INFO)/i)?.[1] ?? "INFO";
      const title = line.replace(/^(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\s*[:\-–]\s*/i, "").trim();
      security.push({ severity: severity.toUpperCase(), title, description: title });
    }
  }

  const riskScore = estimateRiskScore(text);

  // Derive verdict from risk score
  let verdict: string;
  if (riskScore <= 15) verdict = "SAFE";
  else if (riskScore <= 50) verdict = "CAUTION";
  else verdict = "DANGER";

  // Build summary from first meaningful paragraph
  const summaryMatch = text.match(
    /(?:summary|conclusion|overall|executive)[:\s]*([^\n]{20,500})/i
  );
  const summary = summaryMatch?.[1]?.trim() ?? text.slice(0, 500);

  return {
    riskScore,
    verdict,
    findings: { security, economic, gas },
    strengths: [],
    weaknesses: [],
    redFlags: [],
    copyLikelihoodScore: 0,
    complexityScore: 50,
    summary,
  };
}

// ── Helper: extract token risk data from unstructured text ────────────

interface TokenRiskResult {
  riskScore: number;
  verdict: string;
  findings: { contract: unknown[]; tokenomics: unknown[] };
  copyLikelihoodScore: number;
  timelineAnomalies: string[];
  summary: string;
}

function parseTokenRiskText(text: string): TokenRiskResult {
  const parsed = tryParseJson(text);
  if (
    parsed &&
    typeof parsed.riskScore === "number" &&
    typeof parsed.verdict === "string"
  ) {
    return {
      riskScore: parsed.riskScore as number,
      verdict: parsed.verdict as string,
      findings: (parsed.findings as any) ?? { contract: [], tokenomics: [] },
      copyLikelihoodScore: typeof parsed.copy_likelihood_score === "number"
        ? (parsed.copy_likelihood_score as number)
        : typeof parsed.copyLikelihoodScore === "number"
          ? (parsed.copyLikelihoodScore as number)
          : 0,
      timelineAnomalies: Array.isArray(parsed.timeline_anomalies)
        ? (parsed.timeline_anomalies as string[])
        : Array.isArray(parsed.timelineAnomalies)
          ? (parsed.timelineAnomalies as string[])
          : [],
      summary: (parsed.summary as string) ?? text.slice(0, 500),
    };
  }

  // Extract verdict from text
  let verdict = "CAUTION"; // default
  if (/\bDANGER\b/i.test(text)) verdict = "DANGER";
  else if (/\bSAFE\b/i.test(text) && !/\bNOT\s+SAFE\b/i.test(text)) verdict = "SAFE";
  else if (/\bCAUTION\b/i.test(text)) verdict = "CAUTION";

  const contract: unknown[] = [];
  const tokenomics: unknown[] = [];

  // Extract JSON findings blocks
  const jsonBlocks = text.match(/\{[\s\S]*?\n\}/g) ?? [];
  for (const block of jsonBlocks) {
    const obj = tryParseJson(block);
    if (!obj) continue;
    const findings = Array.isArray(obj.findings) ? (obj.findings as unknown[]) : [];
    const ctx = text.slice(Math.max(0, text.indexOf(block) - 200), text.indexOf(block));
    if (/tokenomics|supply|holder|distribution|liquidity/i.test(ctx)) {
      tokenomics.push(...findings);
    } else {
      contract.push(...findings);
    }
  }

  const riskScore = estimateRiskScore(text);

  // Reconcile verdict with score if not explicitly found
  if (verdict === "CAUTION") {
    if (riskScore <= 25) verdict = "SAFE";
    else if (riskScore >= 61) verdict = "DANGER";
  }

  const summaryMatch = text.match(
    /(?:summary|conclusion|verdict|assessment|overall)[:\s]*([^\n]{20,500})/i
  );
  const summary = summaryMatch?.[1]?.trim() ?? text.slice(0, 500);

  return {
    riskScore,
    verdict,
    findings: { contract, tokenomics },
    copyLikelihoodScore: 0,
    timelineAnomalies: [],
    summary,
  };
}

// ── Helper: extract DAO analysis data from unstructured text ──────────

function parseDaoAnalyzeText(text: string): {
  recommendation: string;
  confidence: number;
  analysis: { economic: string; technical: string; risk: string };
  summary: string;
} {
  const parsed = tryParseJson(text);
  if (
    parsed &&
    typeof parsed.recommendation === "string" &&
    typeof parsed.confidence === "number"
  ) {
    return {
      recommendation: parsed.recommendation as string,
      confidence: parsed.confidence as number,
      analysis: (parsed.analysis as any) ?? { economic: "", technical: "", risk: "" },
      summary: (parsed.summary as string) ?? text.slice(0, 500),
    };
  }

  // Extract recommendation from text
  let recommendation = "ABSTAIN"; // default
  if (/\bRECOMMENDATION\s*[:\-–]\s*FOR\b/i.test(text) || /\bVOTE\s*[:\-–]?\s*FOR\b/i.test(text)) {
    recommendation = "FOR";
  } else if (
    /\bRECOMMENDATION\s*[:\-–]\s*AGAINST\b/i.test(text) ||
    /\bVOTE\s*[:\-–]?\s*AGAINST\b/i.test(text)
  ) {
    recommendation = "AGAINST";
  } else if (/\bAGAINST\b/i.test(text) && !/\bFOR\b/i.test(text)) {
    recommendation = "AGAINST";
  } else if (/\bFOR\b/i.test(text) && !/\bAGAINST\b/i.test(text)) {
    recommendation = "FOR";
  }

  // Extract confidence from text (look for "confidence: XX" or "XX% confident")
  let confidence = 50; // default
  const confMatch = text.match(/confidence\s*[:\-–]\s*(\d{1,3})/i) ??
    text.match(/(\d{1,3})\s*%?\s*confiden/i);
  if (confMatch?.[1]) {
    const val = parseInt(confMatch[1], 10);
    if (val >= 0 && val <= 100) confidence = val;
  }

  // Extract per-agent analysis sections
  const extractSection = (label: RegExp): string => {
    const match = text.match(new RegExp(`${label.source}[:\\s]*([\\s\\S]{20,800}?)(?=\\n\\[|\\n---|\$)`, "i"));
    return match?.[1]?.trim().slice(0, 500) ?? "";
  };

  const economic = extractSection(/economic|financial|treasury/);
  const technical = extractSection(/technical|feasibility|implementation/);
  const risk = extractSection(/risk|threat|danger/);

  const summaryMatch = text.match(
    /(?:summary|conclusion|recommendation|executive)[:\s]*([^\n]{20,500})/i
  );
  const summary = summaryMatch?.[1]?.trim() ?? text.slice(0, 500);

  return { recommendation, confidence, analysis: { economic, technical, risk }, summary };
}

// ── Free tier output truncation ──────────────────────────────────────────
// Free calls get scores and finding COUNTS but not full finding details.

const FREE_TIER_PLACEHOLDER = "[Connect wallet to see full details]";

function truncateContractAuditForFreeTier(
  result: ContractAuditResult,
  gate: X402GateResult
): Record<string, unknown> {
  if (gate.amountUsd > 0) return result as any; // paid — return full
  return {
    riskScore: result.riskScore,
    verdict: result.verdict,
    findings: {
      security: result.findings.security.length,
      economic: result.findings.economic.length,
      gas: result.findings.gas.length,
    },
    copyLikelihoodScore: result.copyLikelihoodScore,
    complexityScore: result.complexityScore,
    summary: FREE_TIER_PLACEHOLDER,
    _preview: true,
    _message: `Verdict: ${result.verdict}. Found ${result.findings.security.length} security, ${result.findings.economic.length} economic, and ${result.findings.gas.length} gas findings. Pay $0.10 to see full details.`,
  };
}

function truncateTokenRiskForFreeTier(
  result: TokenRiskResult,
  gate: X402GateResult
): Record<string, unknown> {
  if (gate.amountUsd > 0) return result as any; // paid — return full
  return {
    riskScore: result.riskScore,
    verdict: result.verdict,
    findings: {
      contract: result.findings.contract.length,
      tokenomics: result.findings.tokenomics.length,
    },
    copyLikelihoodScore: result.copyLikelihoodScore,
    summary: FREE_TIER_PLACEHOLDER,
    _preview: true,
    _message: `Verdict: ${result.verdict} (${result.riskScore}/100). Found ${result.findings.contract.length} contract and ${result.findings.tokenomics.length} tokenomics findings. Pay $0.05 to see full details.`,
  };
}

function truncateDaoAnalyzeForFreeTier(
  result: { recommendation: string; confidence: number; analysis: { economic: string; technical: string; risk: string }; summary: string },
  gate: X402GateResult
): Record<string, unknown> {
  if (gate.amountUsd > 0) return result as any; // paid — return full
  return {
    recommendation: result.recommendation,
    confidence: result.confidence,
    analysis: {
      economic: FREE_TIER_PLACEHOLDER,
      technical: FREE_TIER_PLACEHOLDER,
      risk: FREE_TIER_PLACEHOLDER,
    },
    summary: FREE_TIER_PLACEHOLDER,
    _preview: true,
    _message: `Recommendation: ${result.recommendation} (${result.confidence}% confidence). Pay $0.10 to see full analysis.`,
  };
}

// ── Catalog entries for the 3 crypto-native endpoints ──────────────────

export const CRYPTO_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "Smart Contract Audit",
    description:
      "Multi-agent smart contract pre-audit — security vulns, economic attacks, copy/clone detection, complexity assessment, gas optimization, and structured risk report with verdict (ConcurrentWorkflow, 4 agents)",
    path: "/x402/contract-audit",
    method: "POST",
    priceUsd: "0.10",
  },
  {
    name: "Quick Contract Audit",
    description:
      "Single-agent quick security scan — fast, cheap, covers major security vulnerabilities only (1 agent, SecurityAuditor)",
    path: "/x402/contract-audit/quick",
    method: "POST",
    priceUsd: "0.03",
  },
  {
    name: "Deep Contract Audit",
    description:
      "Comprehensive 6-agent deep audit — security, economic, gas, copy/clone detection, plus additional verification pass with GasOptimizer and CopyDetector cross-checks (ConcurrentWorkflow, 6 agents)",
    path: "/x402/contract-audit/deep",
    method: "POST",
    priceUsd: "0.15",
  },
  {
    name: "Token Risk Assessment",
    description:
      "Multi-agent token risk scoring — rug pull detection, timeline anomalies, copy/clone detection, tokenomics analysis, and SAFE/CAUTION/DANGER verdict (SequentialWorkflow, 3 agents)",
    path: "/x402/token-risk",
    method: "POST",
    priceUsd: "0.05",
  },
  {
    name: "DAO Proposal Analysis",
    description:
      "Multi-agent DAO proposal analysis — economic impact, technical feasibility, risk assessment, and FOR/AGAINST/ABSTAIN recommendation (MixtureOfAgents, 4 agents)",
    path: "/x402/dao-analyze",
    method: "POST",
    priceUsd: "0.10",
  },
];

// ── Routes ─────────────────────────────────────────────────────────────

export const cryptoRoutes: Route[] = [
  // ── POST /x402/contract-audit — $0.10 ──────────────────────────────
  {
    type: "POST",
    path: "/x402/contract-audit",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.10",
        description: "Multi-agent smart contract pre-audit (4 agents, ConcurrentWorkflow)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const code = requireString(body, "code");
      if (!code) {
        res.status(400).json({ error: "Missing required field: code (non-empty string)" });
        return;
      }
      const language: string =
        typeof body.language === "string" &&
        ["solidity", "rust", "anchor"].includes(body.language)
          ? body.language
          : "solidity";

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `contract-audit-${Date.now()}`,
          description: `Smart contract audit (${language})`,
          agents: [
            {
              agent_name: "SecurityAuditor",
              system_prompt:
                `You are an expert smart contract security auditor specializing in ${language}. Analyze the provided code for:\n\n` +
                "SECURITY ISSUES:\n" +
                "- Reentrancy vulnerabilities (external calls before state updates)\n" +
                "- Integer overflow/underflow\n" +
                "- Access control flaws (missing owner checks, unprotected admin functions)\n" +
                "- Front-running / MEV vectors\n" +
                "- Oracle manipulation risks\n" +
                "- Unchecked external calls\n" +
                "- Delegate call risks\n" +
                "- Flash loan attack vectors\n" +
                "- Wallet drain patterns / hidden fee extraction\n" +
                "- Admin backdoors / privileged functions without timelocks\n\n" +
                "IMPORTANT CONTEXT:\n" +
                "- Having contract addresses, token references, or crypto-related functionality is EXPECTED and NORMAL — not a red flag.\n" +
                "- Only report REAL issues you found in the code. Do NOT invent problems or pad your findings.\n" +
                "- Write findings for non-developers — explain like talking to a smart 15-year-old.\n\n" +
                "For each finding, provide:\n" +
                '- severity: "critical" | "high" | "medium" | "low" | "info"\n' +
                "- title: short description\n" +
                "- description: what the issue is and why it matters\n" +
                "- location: where in the code (line/function reference)\n" +
                "- recommendation: how to fix it\n\n" +
                'Output a JSON object: { "findings": [{ "severity": "...", "title": "...", "description": "...", "location": "...", "recommendation": "..." }], ' +
                '"legitimacy_score": <0-100> }',
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
            {
              agent_name: "EconomicAttacker",
              system_prompt:
                `You are an economic security analyst evaluating ${language} smart contracts.\n\n` +
                "ECONOMIC ATTACK VECTORS:\n" +
                "- MEV / sandwich attack surface\n" +
                "- Flash loan exploit paths\n" +
                "- Oracle manipulation (price feed dependency)\n" +
                "- Front-running opportunities\n" +
                "- Liquidity manipulation vectors\n" +
                "- Token economics manipulation (mint/burn authority abuse)\n\n" +
                "COPY/CLONE DETECTION:\n" +
                "- References to different project names in comments, strings, or configs\n" +
                "- Package.json/Cargo.toml with mismatched project names\n" +
                "- TODO comments or placeholders from other projects\n" +
                "- Generic template code with no customization\n" +
                "- README that doesn't match the actual code\n" +
                "- Very shallow commit history (1-2 bulk commits)\n\n" +
                "COMPLEXITY ASSESSMENT:\n" +
                "- HIGH EFFORT: Multiple interconnected files, custom business logic, error handling, tests\n" +
                "- LOW EFFORT: Single file, just boilerplate, no custom logic, no error handling\n\n" +
                "Output a JSON object: {\n" +
                '  "economic_findings": [{ "severity": "...", "title": "...", "attackScenario": "...", "potentialImpact": "..." }],\n' +
                '  "copy_likelihood_score": <0-100>,\n' +
                '  "complexity_score": <0-100>\n' +
                "}",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
            {
              agent_name: "GasOptimizer",
              system_prompt:
                `You are a ${language} gas optimization specialist. ` +
                "Analyze the code for gas inefficiencies: " +
                "unnecessary storage reads (SLOADs), suboptimal storage packing, " +
                "loop inefficiencies, redundant computations, calldata vs memory misuse, " +
                "missing short-circuit logic, expensive operations in loops, " +
                "and opportunities for using unchecked blocks or assembly. " +
                "Estimate gas savings for each suggestion. " +
                "Output a JSON object: { \"findings\": [{ \"title\": \"...\", \"description\": \"...\", \"estimatedSavings\": \"...\" }] }",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
            {
              agent_name: "AuditReporter",
              system_prompt:
                "You are the final audit report synthesizer. Combine findings from the SecurityAuditor, EconomicAttacker, and GasOptimizer into a structured report.\n\n" +
                "OUTPUT FORMAT (JSON):\n" +
                "{\n" +
                '  "riskScore": <0-100 integer>,\n' +
                '  "verdict": "SAFE" | "CAUTION" | "DANGER",\n' +
                '  "findings": {\n' +
                '    "security": [{"severity": "...", "title": "...", "description": "...", "recommendation": "..."}],\n' +
                '    "economic": [{"severity": "...", "title": "...", "description": "...", "recommendation": "..."}],\n' +
                '    "gas": [{"severity": "...", "title": "...", "description": "...", "recommendation": "..."}]\n' +
                "  },\n" +
                '  "strengths": ["..."],\n' +
                '  "weaknesses": ["..."],\n' +
                '  "red_flags": ["..."],\n' +
                '  "copy_likelihood_score": <0-100>,\n' +
                '  "complexity_score": <0-100>,\n' +
                '  "summary": "Non-technical summary for a smart 15-year-old"\n' +
                "}\n\n" +
                "SCORING RUBRIC (riskScore is LEGITIMACY — higher = safer):\n" +
                "85-100: Well-written, secure, legitimate project\n" +
                "70-84: Good project with minor issues\n" +
                "50-69: Concerning issues that need attention\n" +
                "30-49: Significant problems or red flags\n" +
                "0-29: Likely scam or severely compromised\n\n" +
                "Only report REAL issues. Don't invent problems to make the report look thorough.\n" +
                "Output ONLY the JSON object — no markdown fences, no extra text.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 8192,
              temperature: 0.2,
            },
          ],
          swarm_type: "ConcurrentWorkflow",
          task:
            `Audit the following ${language} smart contract code. ` +
            "Each agent should analyze from their specialization and the AuditReporter should synthesize all findings.\n\n" +
            "```\n" +
            code +
            "\n```",
          max_loops: 1,
        });

        const rawOutput = extractSwarmOutput(result);
        const audit = parseContractAuditText(rawOutput);
        const truncated = truncateContractAuditForFreeTier(audit, gate);

        // Save report for shareable link + badge
        const reportId = saveReport({
          type: "contract-audit",
          createdAt: new Date().toISOString(),
          input: { code: code.slice(0, 2000), language },
          result: audit,
          riskScore: audit.riskScore,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        res.json({
          ...truncated,
          ...urls,
          rawOutput: gate.amountUsd > 0 ? rawOutput : undefined,
          template: "ContractAudit",
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
          "[x402/contract-audit] Swarm execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/contract-audit/quick — $0.03 (single SecurityAuditor) ──
  {
    type: "POST",
    path: "/x402/contract-audit/quick",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.03",
        description: "Quick smart contract security scan (1 agent, SecurityAuditor)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const code = requireString(body, "code");
      if (!code) {
        res.status(400).json({ error: "Missing required field: code (non-empty string)" });
        return;
      }
      const language: string =
        typeof body.language === "string" &&
        ["solidity", "rust", "anchor"].includes(body.language)
          ? body.language
          : "solidity";

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      try {
        const result = await swarmsService.runAgent(
          {
            agent_name: "SecurityAuditor",
            system_prompt:
              `You are an expert smart contract security auditor specializing in ${language}. Analyze the provided code for:\n\n` +
              "SECURITY ISSUES:\n" +
              "- Reentrancy vulnerabilities (external calls before state updates)\n" +
              "- Integer overflow/underflow\n" +
              "- Access control flaws (missing owner checks, unprotected admin functions)\n" +
              "- Front-running / MEV vectors\n" +
              "- Oracle manipulation risks\n" +
              "- Unchecked external calls\n" +
              "- Delegate call risks\n" +
              "- Flash loan attack vectors\n" +
              "- Wallet drain patterns / hidden fee extraction\n" +
              "- Admin backdoors / privileged functions without timelocks\n\n" +
              "IMPORTANT: Only report REAL issues you found in the code. Do NOT invent problems.\n\n" +
              "Output ONLY a JSON object with this structure:\n" +
              "{\n" +
              '  "riskScore": <0-100 integer>,\n' +
              '  "verdict": "SAFE" | "CAUTION" | "DANGER",\n' +
              '  "findings": {\n' +
              '    "security": [{"severity": "...", "title": "...", "description": "...", "recommendation": "..."}],\n' +
              '    "economic": [],\n' +
              '    "gas": []\n' +
              "  },\n" +
              '  "strengths": ["..."],\n' +
              '  "weaknesses": ["..."],\n' +
              '  "red_flags": ["..."],\n' +
              '  "copy_likelihood_score": 0,\n' +
              '  "complexity_score": <0-100>,\n' +
              '  "summary": "Non-technical summary for a smart 15-year-old"\n' +
              "}\n\n" +
              "Output ONLY the JSON object — no markdown fences, no extra text.",
            model_name: "gpt-5-mini",
            role: "worker" as const,
            max_loops: 1,
            max_tokens: 4096,
            temperature: 0.2,
          },
          `Audit the following ${language} smart contract code for security issues.\n\n` +
            "```\n" +
            code +
            "\n```"
        );

        const rawOutput = String(result.outputs ?? result);
        const audit = parseContractAuditText(rawOutput);
        const truncated = truncateContractAuditForFreeTier(audit, gate);

        // Save report for shareable link + badge
        const reportId = saveReport({
          type: "contract-audit",
          createdAt: new Date().toISOString(),
          input: { code: code.slice(0, 2000), language },
          result: audit,
          riskScore: audit.riskScore,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        res.json({
          ...truncated,
          ...urls,
          rawOutput: gate.amountUsd > 0 ? rawOutput : undefined,
          template: "ContractAuditQuick",
          tier: "quick",
          freeRemaining: gate.freeRemaining,
          payment: {
            amount: "0.03",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/contract-audit/quick] Agent execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/contract-audit/deep — $0.15 (6 agents) ────────────
  {
    type: "POST",
    path: "/x402/contract-audit/deep",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.15",
        description: "Deep smart contract audit with verification pass (6 agents, ConcurrentWorkflow)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const code = requireString(body, "code");
      if (!code) {
        res.status(400).json({ error: "Missing required field: code (non-empty string)" });
        return;
      }
      const language: string =
        typeof body.language === "string" &&
        ["solidity", "rust", "anchor"].includes(body.language)
          ? body.language
          : "solidity";

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `contract-audit-deep-${Date.now()}`,
          description: `Deep smart contract audit (${language})`,
          agents: [
            {
              agent_name: "SecurityAuditor",
              system_prompt:
                `You are an expert smart contract security auditor specializing in ${language}. Analyze the provided code for:\n\n` +
                "SECURITY ISSUES:\n" +
                "- Reentrancy vulnerabilities (external calls before state updates)\n" +
                "- Integer overflow/underflow\n" +
                "- Access control flaws (missing owner checks, unprotected admin functions)\n" +
                "- Front-running / MEV vectors\n" +
                "- Oracle manipulation risks\n" +
                "- Unchecked external calls\n" +
                "- Delegate call risks\n" +
                "- Flash loan attack vectors\n" +
                "- Wallet drain patterns / hidden fee extraction\n" +
                "- Admin backdoors / privileged functions without timelocks\n\n" +
                "IMPORTANT CONTEXT:\n" +
                "- Having contract addresses, token references, or crypto-related functionality is EXPECTED and NORMAL — not a red flag.\n" +
                "- Only report REAL issues you found in the code. Do NOT invent problems or pad your findings.\n" +
                "- Write findings for non-developers — explain like talking to a smart 15-year-old.\n\n" +
                "For each finding, provide:\n" +
                '- severity: "critical" | "high" | "medium" | "low" | "info"\n' +
                "- title: short description\n" +
                "- description: what the issue is and why it matters\n" +
                "- location: where in the code (line/function reference)\n" +
                "- recommendation: how to fix it\n\n" +
                'Output a JSON object: { "findings": [{ "severity": "...", "title": "...", "description": "...", "location": "...", "recommendation": "..." }], ' +
                '"legitimacy_score": <0-100> }',
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
            {
              agent_name: "EconomicAttacker",
              system_prompt:
                `You are an economic security analyst evaluating ${language} smart contracts.\n\n` +
                "ECONOMIC ATTACK VECTORS:\n" +
                "- MEV / sandwich attack surface\n" +
                "- Flash loan exploit paths\n" +
                "- Oracle manipulation (price feed dependency)\n" +
                "- Front-running opportunities\n" +
                "- Liquidity manipulation vectors\n" +
                "- Token economics manipulation (mint/burn authority abuse)\n\n" +
                "COPY/CLONE DETECTION:\n" +
                "- References to different project names in comments, strings, or configs\n" +
                "- Package.json/Cargo.toml with mismatched project names\n" +
                "- TODO comments or placeholders from other projects\n" +
                "- Generic template code with no customization\n" +
                "- README that doesn't match the actual code\n" +
                "- Very shallow commit history (1-2 bulk commits)\n\n" +
                "COMPLEXITY ASSESSMENT:\n" +
                "- HIGH EFFORT: Multiple interconnected files, custom business logic, error handling, tests\n" +
                "- LOW EFFORT: Single file, just boilerplate, no custom logic, no error handling\n\n" +
                "Output a JSON object: {\n" +
                '  "economic_findings": [{ "severity": "...", "title": "...", "attackScenario": "...", "potentialImpact": "..." }],\n' +
                '  "copy_likelihood_score": <0-100>,\n' +
                '  "complexity_score": <0-100>\n' +
                "}",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
            {
              agent_name: "GasOptimizer",
              system_prompt:
                `You are a ${language} gas optimization specialist. ` +
                "Analyze the code for gas inefficiencies: " +
                "unnecessary storage reads (SLOADs), suboptimal storage packing, " +
                "loop inefficiencies, redundant computations, calldata vs memory misuse, " +
                "missing short-circuit logic, expensive operations in loops, " +
                "and opportunities for using unchecked blocks or assembly. " +
                "Estimate gas savings for each suggestion. " +
                "Output a JSON object: { \"findings\": [{ \"title\": \"...\", \"description\": \"...\", \"estimatedSavings\": \"...\" }] }",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
            {
              agent_name: "CopyDetector",
              system_prompt:
                `You are a ${language} code originality analyst. ` +
                "Determine if the smart contract is original or a copy/fork/clone.\n\n" +
                "DETECTION CRITERIA:\n" +
                "- Compare code structure to well-known templates (OpenZeppelin, SafeMoon, standard ERC20/721)\n" +
                "- Look for residual project names, comments, or URLs from other projects\n" +
                "- Check for unchanged default values or placeholder strings\n" +
                "- Assess customization depth vs boilerplate ratio\n" +
                "- Identify if the code is a minimal fork with only name/symbol changes\n" +
                "- Look for copy-paste artifacts (mismatched naming, dead code from original)\n\n" +
                "Output a JSON object: {\n" +
                '  "copy_likelihood_score": <0-100>,\n' +
                '  "source_matches": ["<known project/template this resembles>"],\n' +
                '  "originality_assessment": "<detailed explanation>",\n' +
                '  "customization_depth": "none|minimal|moderate|extensive"\n' +
                "}",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
            {
              agent_name: "VerificationAuditor",
              system_prompt:
                "You are a verification auditor performing a second-pass review. " +
                "You receive findings from SecurityAuditor, EconomicAttacker, GasOptimizer, and CopyDetector. " +
                "Your job is to:\n" +
                "1. Confirm or reject each finding — remove false positives\n" +
                "2. Identify any issues missed by the other agents\n" +
                "3. Cross-check severity ratings for consistency\n" +
                "4. Flag if copy detection and security findings are contradictory\n\n" +
                "Output a JSON object: {\n" +
                '  "confirmed_findings": [{ "agent": "...", "title": "...", "status": "confirmed|rejected|upgraded|downgraded" }],\n' +
                '  "missed_issues": [{ "severity": "...", "title": "...", "description": "..." }],\n' +
                '  "verification_notes": "..."\n' +
                "}",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
            {
              agent_name: "AuditReporter",
              system_prompt:
                "You are the final audit report synthesizer for a DEEP audit. " +
                "Combine findings from SecurityAuditor, EconomicAttacker, GasOptimizer, CopyDetector, and VerificationAuditor into a comprehensive structured report.\n\n" +
                "The VerificationAuditor has already confirmed/rejected findings — prioritize confirmed findings and include any missed issues they identified.\n\n" +
                "OUTPUT FORMAT (JSON):\n" +
                "{\n" +
                '  "riskScore": <0-100 integer>,\n' +
                '  "verdict": "SAFE" | "CAUTION" | "DANGER",\n' +
                '  "findings": {\n' +
                '    "security": [{"severity": "...", "title": "...", "description": "...", "recommendation": "..."}],\n' +
                '    "economic": [{"severity": "...", "title": "...", "description": "...", "recommendation": "..."}],\n' +
                '    "gas": [{"severity": "...", "title": "...", "description": "...", "recommendation": "..."}]\n' +
                "  },\n" +
                '  "strengths": ["..."],\n' +
                '  "weaknesses": ["..."],\n' +
                '  "red_flags": ["..."],\n' +
                '  "copy_likelihood_score": <0-100>,\n' +
                '  "complexity_score": <0-100>,\n' +
                '  "summary": "Non-technical summary for a smart 15-year-old"\n' +
                "}\n\n" +
                "SCORING RUBRIC (riskScore is LEGITIMACY — higher = safer):\n" +
                "85-100: Well-written, secure, legitimate project\n" +
                "70-84: Good project with minor issues\n" +
                "50-69: Concerning issues that need attention\n" +
                "30-49: Significant problems or red flags\n" +
                "0-29: Likely scam or severely compromised\n\n" +
                "Only report CONFIRMED issues. Don't invent problems.\n" +
                "Output ONLY the JSON object — no markdown fences, no extra text.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 8192,
              temperature: 0.2,
            },
          ],
          swarm_type: "ConcurrentWorkflow",
          task:
            `Deep audit the following ${language} smart contract code. ` +
            "Each agent should analyze from their specialization. The VerificationAuditor should cross-check all findings. " +
            "The AuditReporter should synthesize all confirmed findings into a comprehensive report.\n\n" +
            "```\n" +
            code +
            "\n```",
          max_loops: 1,
        });

        const rawOutput = extractSwarmOutput(result);
        const audit = parseContractAuditText(rawOutput);
        const truncated = truncateContractAuditForFreeTier(audit, gate);

        // Save report for shareable link + badge
        const reportId = saveReport({
          type: "contract-audit",
          createdAt: new Date().toISOString(),
          input: { code: code.slice(0, 2000), language },
          result: audit,
          riskScore: audit.riskScore,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        res.json({
          ...truncated,
          ...urls,
          rawOutput: gate.amountUsd > 0 ? rawOutput : undefined,
          template: "ContractAuditDeep",
          tier: "deep",
          freeRemaining: gate.freeRemaining,
          payment: {
            amount: "0.15",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/contract-audit/deep] Swarm execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/token-risk — $0.05 ──────────────────────────────────
  {
    type: "POST",
    path: "/x402/token-risk",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.05",
        description: "Multi-agent token risk assessment (3 agents, SequentialWorkflow)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const mint = requireString(body, "mint", 200);
      if (!mint) {
        res.status(400).json({ error: "Missing required field: mint (token address string)" });
        return;
      }
      const chain: string =
        typeof body.chain === "string" && ["solana", "evm"].includes(body.chain)
          ? body.chain
          : "solana";

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      // ── Optional on-chain data via Helius (Solana only) ────────────
      let onChainContext = "";
      if (chain === "solana" && SOLANA_ADDR_RE.test(mint)) {
        const heliusKey = String(runtime.getSetting("HELIUS_API_KEY") ?? "");
        if (heliusKey) {
          try {
            const rpcUrl = heliusRpcUrl(heliusKey);
            const holders = await rpcCall(rpcUrl, "getTokenLargestAccounts", [mint]);
            if (holders?.value && Array.isArray(holders.value)) {
              const totalSupply = holders.value.reduce(
                (sum: number, h: any) => sum + parseFloat(h.amount ?? "0"),
                0
              );
              const topHolders = holders.value.slice(0, 10).map((h: any, i: number) => ({
                rank: i + 1,
                address: h.address,
                amount: h.amount,
                percentage: totalSupply > 0
                  ? ((parseFloat(h.amount ?? "0") / totalSupply) * 100).toFixed(2) + "%"
                  : "N/A",
              }));
              onChainContext =
                "\n\n--- ON-CHAIN DATA (Solana) ---\n" +
                `Token mint: ${mint}\n` +
                `Top 10 holders (of ${holders.value.length} total accounts):\n` +
                JSON.stringify(topHolders, null, 2) +
                "\n--- END ON-CHAIN DATA ---\n";
            }
          } catch (err) {
            // Non-fatal: proceed with LLM knowledge only
            runtime.logger.warn(
              { error: err instanceof Error ? err.message : String(err) },
              "[x402/token-risk] Helius lookup failed, proceeding with LLM knowledge only"
            );
          }
        }
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `token-risk-${Date.now()}`,
          description: `Token risk assessment: ${mint}`,
          agents: [
            {
              agent_name: "ContractScanner",
              system_prompt:
                "You are a smart contract scanner specializing in detecting rug pull patterns and timeline anomalies.\n\n" +
                "CONTRACT ANALYSIS:\n" +
                "- Mint authority (can new tokens be minted?)\n" +
                "- Freeze authority (can transfers be frozen?)\n" +
                "- Honeypot patterns (can tokens be sold?)\n" +
                "- Blacklist/whitelist functions\n" +
                "- Hidden fees or fee manipulation\n" +
                "- Proxy/upgradeable patterns (admin can change logic)\n" +
                "- Self-destruct mechanisms\n" +
                "- Ownership renouncement status\n" +
                "- Wallet drain patterns / hidden fee extraction\n" +
                "- Admin backdoors / privileged functions without timelocks\n\n" +
                "TIMELINE ANOMALY DETECTION:\n" +
                "- Token deployed very recently with instant large liquidity (suspicious)\n" +
                "- Contract verified long after deployment (hiding initial malicious code)\n" +
                "- Large number of tokens sent to multiple wallets immediately after creation\n" +
                "- Contract interactions that suggest coordinated wash trading\n" +
                "- Ownership transferred multiple times in rapid succession\n\n" +
                "IMPORTANT: Having contract addresses and token references is NORMAL. Only report REAL issues.\n\n" +
                'Output a JSON object: { "findings": [{ "risk": "critical|high|medium|low|info", "title": "...", "description": "..." }], ' +
                '"mintAuthority": "active|renounced|unknown", "freezeAuthority": "active|renounced|unknown", ' +
                '"timeline_anomalies": ["..."] }',
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
            {
              agent_name: "TokenomicsAnalyzer",
              system_prompt:
                "You are a tokenomics analyst with copy/clone detection capabilities.\n\n" +
                "TOKENOMICS ANALYSIS:\n" +
                "- Supply distribution and top holder concentration (whales)\n" +
                "- Vesting schedules and unlock timelines\n" +
                "- Liquidity lock status and duration\n" +
                "- LP token distribution\n" +
                "- Insider allocation percentage\n" +
                "- Circulating vs total supply ratio\n" +
                "- Inflation/deflation mechanics\n" +
                "If on-chain data is provided, use it for concrete analysis.\n\n" +
                "COPY/CLONE DETECTION:\n" +
                "- Is this token a fork/clone of an existing well-known token?\n" +
                "- Are the tokenomics parameters identical to a template?\n" +
                "- Signs of lazy copying: default values, unchanged descriptions, mismatched naming\n" +
                "- Compare token economics to known patterns (e.g., standard SafeMoon fork, standard reflection token)\n\n" +
                'Output a JSON object: { "findings": [{ "risk": "critical|high|medium|low|info", "title": "...", "description": "..." }], ' +
                '"topHolderConcentration": "<percentage or unknown>", "liquidityLocked": "yes|no|unknown", ' +
                '"copy_likelihood_score": <0-100> }',
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
            {
              agent_name: "RiskVerdict",
              system_prompt:
                "You are a crypto risk assessment judge. You receive findings from ContractScanner and TokenomicsAnalyzer.\n" +
                "Produce a final risk assessment including copy detection and timeline anomalies.\n\n" +
                "Output ONLY a JSON object with this exact structure:\n" +
                "{\n" +
                '  "riskScore": <number 0-100>,\n' +
                '  "verdict": "SAFE" | "CAUTION" | "DANGER",\n' +
                '  "findings": {\n' +
                '    "contract": [{ "risk": "...", "title": "...", "description": "..." }],\n' +
                '    "tokenomics": [{ "risk": "...", "title": "...", "description": "..." }]\n' +
                "  },\n" +
                '  "copy_likelihood_score": <0-100>,\n' +
                '  "timeline_anomalies": ["..."],\n' +
                '  "summary": "<non-technical summary for a smart 15-year-old>"\n' +
                "}\n\n" +
                "Risk score guide: 0-25 = SAFE, 26-60 = CAUTION, 61-100 = DANGER.\n" +
                "Only report REAL issues. Don't invent problems.\n" +
                "Output ONLY the JSON object — no markdown fences, no extra text.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
          ],
          swarm_type: "SequentialWorkflow",
          task:
            `Assess the risk of the following token on ${chain}.\n` +
            `Token address/mint: ${mint}\n` +
            "Analyze for rug pull patterns, tokenomics red flags, and produce a final risk verdict." +
            onChainContext,
          max_loops: 1,
          rules:
            "ContractScanner analyzes the contract first, TokenomicsAnalyzer evaluates supply/distribution, then RiskVerdict synthesizes both into a final score and verdict.",
        });

        const rawOutput = extractSwarmOutput(result);
        const risk = parseTokenRiskText(rawOutput);
        const truncated = truncateTokenRiskForFreeTier(risk, gate);

        // Save report for shareable link + badge
        const reportId = saveReport({
          type: "token-risk",
          createdAt: new Date().toISOString(),
          input: { mint, chain },
          result: risk,
          riskScore: risk.riskScore,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        res.json({
          ...truncated,
          ...urls,
          rawOutput: gate.amountUsd > 0 ? rawOutput : undefined,
          onChainDataUsed: onChainContext.length > 0,
          template: "TokenRisk",
          freeRemaining: gate.freeRemaining,
          payment: {
            amount: "0.05",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/token-risk] Swarm execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/dao-analyze — $0.10 ─────────────────────────────────
  {
    type: "POST",
    path: "/x402/dao-analyze",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.10",
        description: "Multi-agent DAO proposal analysis (4 agents, MixtureOfAgents)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const proposal = requireString(body, "proposal");
      if (!proposal) {
        res.status(400).json({ error: "Missing required field: proposal (non-empty string)" });
        return;
      }
      const daoName: string =
        typeof body.daoName === "string" ? body.daoName : "Unknown DAO";

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `dao-analyze-${Date.now()}`,
          description: `DAO proposal analysis: ${daoName}`,
          agents: [
            {
              agent_name: "EconomicAnalyst",
              system_prompt:
                "You are a DeFi economic analyst specializing in DAO treasury and protocol economics. " +
                "Analyze the financial impact of the proposed change: " +
                "treasury impact, revenue/cost projections, token price implications, " +
                "liquidity effects, incentive alignment, opportunity cost, and comparison to alternatives. " +
                "Quantify where possible. " +
                "Output a JSON object: { \"analysis\": \"<detailed economic analysis>\", " +
                "\"impact\": \"positive|negative|neutral\", \"confidence\": <0-100> }",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.4,
            },
            {
              agent_name: "TechnicalReviewer",
              system_prompt:
                "You are a blockchain technical architect reviewing DAO proposals. " +
                "Evaluate implementation feasibility: " +
                "smart contract changes required, upgrade complexity, integration risks, " +
                "dependencies on external protocols, timeline realism, " +
                "testing requirements, and potential for unintended side effects. " +
                "Output a JSON object: { \"analysis\": \"<detailed technical review>\", " +
                "\"feasibility\": \"straightforward|moderate|complex|infeasible\", \"confidence\": <0-100> }",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
            {
              agent_name: "RiskAssessor",
              system_prompt:
                "You are a crypto risk management specialist analyzing DAO proposals. " +
                "Identify what could go wrong: " +
                "smart contract risk, governance attack vectors, regulatory exposure, " +
                "centralization risks, key person dependencies, market timing risks, " +
                "community backlash potential, and worst-case scenarios. " +
                "Rate overall risk as Low/Medium/High/Critical. " +
                "Output a JSON object: { \"analysis\": \"<detailed risk assessment>\", " +
                "\"riskLevel\": \"low|medium|high|critical\", \"topRisks\": [\"...\"] }",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
            {
              agent_name: "VoteSummarizer",
              system_prompt:
                "You are a DAO governance advisor. You receive analyses from EconomicAnalyst, TechnicalReviewer, and RiskAssessor. " +
                "Synthesize their findings into a clear voting recommendation. " +
                "Output ONLY a JSON object with this exact structure: " +
                "{ \"recommendation\": \"FOR\" | \"AGAINST\" | \"ABSTAIN\", " +
                "\"confidence\": <number 0-100>, " +
                "\"analysis\": { " +
                "\"economic\": \"<summary of economic impact>\", " +
                "\"technical\": \"<summary of technical feasibility>\", " +
                "\"risk\": \"<summary of key risks>\" " +
                "}, " +
                "\"summary\": \"<2-3 sentence executive summary with clear recommendation and reasoning>\" }",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 8192,
              temperature: 0.3,
            },
          ],
          swarm_type: "MixtureOfAgents",
          task:
            `Analyze the following DAO proposal for ${daoName}.\n\n` +
            `Proposal:\n${proposal}\n\n` +
            "Each agent should analyze from their specialization, then the VoteSummarizer should synthesize all findings into a voting recommendation.",
          max_loops: 1,
        });

        const rawOutput = extractSwarmOutput(result);
        const dao = parseDaoAnalyzeText(rawOutput);
        const truncated = truncateDaoAnalyzeForFreeTier(dao, gate);

        res.json({
          ...truncated,
          rawOutput: gate.amountUsd > 0 ? rawOutput : undefined,
          daoName,
          template: "DAOAnalysis",
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
          "[x402/dao-analyze] Swarm execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },
];
