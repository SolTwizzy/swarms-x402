import type { Route } from "@elizaos/core";
import { x402Gate } from "../server/x402Gate.js";
import type { X402GateResult } from "../server/x402Gate.js";
import { SwarmsService } from "../services/swarmsService.js";
import type { X402ServiceEndpoint } from "../types.js";
import { callOpenAI } from "../utils/llm.js";
import { TTLCache } from "../utils/cache.js";
import { saveReport } from "../utils/reportStore.js";

// ── Disclaimers ─────────────────────────────────────────────────────────

const YIELD_DISCLAIMER =
  "This is not financial advice. DeFi carries inherent risks including smart contract vulnerabilities, impermanent loss, and protocol failures. Always do your own research.";

const COMPLIANCE_DISCLAIMER =
  "This analysis is for informational purposes only and does not constitute legal advice. Consult a qualified legal professional for compliance decisions.";

const DD_DISCLAIMER = "Not financial advice. Do your own research.";

// ── Input validation helpers ────────────────────────────────────────────

function requireString(
  body: Record<string, unknown>,
  field: string,
  maxLen = 100_000,
): string | null {
  const val = body[field];
  if (!val || typeof val !== "string" || val.trim().length === 0) return null;
  return val.slice(0, maxLen);
}

// ── Helper: get SwarmsService or null ───────────────────────────────────

function getSwarmsService(runtime: any): SwarmsService | null {
  const svc = runtime.getService("SWARMS" as any) as SwarmsService | null;
  return svc?.isAvailable() ? svc : null;
}

// ── JSON parse helper ───────────────────────────────────────────────────

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

// ── Extract raw text from swarm response ────────────────────────────────

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

// ── Report URL helpers ──────────────────────────────────────────────────

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
    badgeMarkdown: `[![SwarmX Report](${base}/badge/${id})](${base}/report/${id})`,
  };
}

// ── Free tier placeholder ───────────────────────────────────────────────

const FREE_TIER_PLACEHOLDER = "[Connect wallet to see full details]";

// ── Caches ──────────────────────────────────────────────────────────────

const yieldCache = new TTLCache<unknown[]>(5 * 60 * 1000);      // 5 min
const researchCache = new TTLCache<unknown>(60 * 60 * 1000);     // 1 hour
const ddCache = new TTLCache<unknown>(30 * 60 * 1000);           // 30 min

// ── DeFiLlama yield fetcher ─────────────────────────────────────────────

interface LlamaPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase?: number;
  apyReward?: number;
  stablecoin?: boolean;
}

async function fetchYields(chains: string[]): Promise<LlamaPool[]> {
  const cacheKey = `yields:${chains.sort().join(",")}`;
  const cached = yieldCache.get(cacheKey) as LlamaPool[] | undefined;
  if (cached) return cached;

  const response = await fetch("https://yields.llama.fi/pools");
  if (!response.ok) {
    // Try stale cache (any chain combo)
    const stale = yieldCache.get("yields:stale") as LlamaPool[] | undefined;
    if (stale) return stale;
    throw new Error("Yield data temporarily unavailable");
  }

  const data = (await response.json()) as { data: LlamaPool[] };
  const chainSet = new Set(chains.map((c) => c.toLowerCase()));
  const filtered = (data.data ?? [])
    .filter(
      (p: LlamaPool) =>
        p.tvlUsd > 1_000_000 &&
        chainSet.has(p.chain?.toLowerCase() ?? ""),
    )
    .sort((a: LlamaPool, b: LlamaPool) => (b.apy ?? 0) - (a.apy ?? 0))
    .slice(0, 50);

  yieldCache.set(cacheKey, filtered);
  yieldCache.set("yields:stale", filtered); // stale fallback
  return filtered;
}

// ── Topic hash for research cache ───────────────────────────────────────

function topicHash(topic: string, depth: string): string {
  let hash = 0;
  const key = `${topic.toLowerCase().trim()}:${depth}`;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return `research:${hash}`;
}

// ── Catalog entries ─────────────────────────────────────────────────────

export const ADVANCED_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "DeFi Yield Optimizer",
    description:
      "3-agent yield optimization — scans DeFiLlama yields, evaluates protocol risk, recommends allocation strategy (MixtureOfAgents, 3 agents)",
    path: "/x402/yield-optimizer",
    method: "POST",
    priceUsd: "0.10",
  },
  {
    name: "Fact-Checked Research Report",
    description:
      "4-agent research pipeline with fact-checking — researcher, fact-checker (VERIFIED/UNVERIFIED/DISPUTED/OUTDATED/FABRICATED), analyst, writer (SequentialWorkflow, 4 agents)",
    path: "/x402/research-report",
    method: "POST",
    priceUsd: "0.15",
  },
  {
    name: "Compliance Check",
    description:
      "3-agent compliance analysis — auto-detects or targets GDPR/SOC2/HIPAA/MiCA/AML/PCI-DSS/CCPA, gap analysis, remediation roadmap (SequentialWorkflow, 3 agents)",
    path: "/x402/compliance-check",
    method: "POST",
    priceUsd: "0.15",
  },
  {
    name: "Investment Due Diligence",
    description:
      "5-agent concurrent analysis + synthesis — team, tokenomics, tech, community, market scoring with cross-check penalties and STRONG_BUY/BUY/HOLD/AVOID/STRONG_AVOID recommendation (ConcurrentWorkflow + synthesis, 5+1 agents)",
    path: "/x402/investment-dd",
    method: "POST",
    priceUsd: "0.19",
  },
];

// ── Routes ──────────────────────────────────────────────────────────────

export const advancedRoutes: Route[] = [

  // ── POST /x402/yield-optimizer — $0.10 ────────────────────────────────
  {
    type: "POST",
    path: "/x402/yield-optimizer",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.10",
        description: "DeFi yield optimizer (3 agents, MixtureOfAgents)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const amount = typeof body.amount === "number" ? body.amount : undefined;
      const riskTolerance: "low" | "medium" | "high" =
        typeof body.riskTolerance === "string" &&
        ["low", "medium", "high"].includes(body.riskTolerance)
          ? (body.riskTolerance as "low" | "medium" | "high")
          : "medium";
      const chains: string[] =
        Array.isArray(body.chains) && body.chains.every((c: unknown) => typeof c === "string")
          ? body.chains
          : ["ethereum", "solana", "arbitrum", "base"];

      // Pre-fetch yields from DeFiLlama
      let yields: LlamaPool[];
      try {
        yields = await fetchYields(chains);
      } catch {
        res.status(503).json({ error: "Yield data temporarily unavailable" });
        return;
      }

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      const yieldSummary = yields
        .slice(0, 20)
        .map(
          (p) =>
            `${p.project} (${p.chain}) — ${p.symbol}: APY ${p.apy?.toFixed(2)}%, TVL $${(p.tvlUsd / 1e6).toFixed(1)}M`,
        )
        .join("\n");

      try {
        const result = await swarmsService.runSwarm({
          name: `yield-optimizer-${Date.now()}`,
          description: `Yield optimization for ${chains.join(", ")}`,
          agents: [
            {
              agent_name: "RateScanner",
              system_prompt:
                "You are a DeFi yield rate scanner. Analyze the provided yield data and identify the top 10 opportunities. " +
                "Consider APY, TVL (higher = safer), protocol reputation, and yield sustainability. " +
                "Output a JSON array of the top 10: [{ \"protocol\": \"...\", \"chain\": \"...\", \"symbol\": \"...\", \"apy\": ..., \"tvl\": ..., \"riskLevel\": \"low\"|\"medium\"|\"high\", \"notes\": \"...\" }]",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
            {
              agent_name: "RiskAssessor",
              system_prompt:
                "You are a DeFi risk assessment specialist. Evaluate the protocol safety of each yield opportunity. " +
                "Consider: smart contract audit status, time in production, TVL trends, protocol team, past incidents, " +
                "complexity of strategy, impermanent loss exposure, and depeg risk for stablecoins. " +
                "Output a JSON array: [{ \"protocol\": \"...\", \"riskScore\": <1-10>, \"auditStatus\": \"...\", \"concerns\": [\"...\"], \"safeForRisk\": \"low\"|\"medium\"|\"high\" }]",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.25,
            },
            {
              agent_name: "StrategyAdvisor",
              system_prompt:
                "You are a DeFi portfolio strategist. Based on the rate scanner's top opportunities and the risk assessor's evaluations, " +
                `recommend an allocation strategy for a ${riskTolerance} risk tolerance investor` +
                (amount ? ` with $${amount} to deploy` : "") +
                ".\n\n" +
                "Recommend 3-5 positions that sum to 100% allocation. " +
                "Output a JSON object:\n" +
                "{\n" +
                '  "strategy": "name of the strategy",\n' +
                '  "positions": [{ "protocol": "...", "chain": "...", "symbol": "...", "allocation": <percentage>, "expectedApy": ..., "rationale": "..." }],\n' +
                '  "expectedApy": <weighted average APY>,\n' +
                '  "riskAssessment": "overall risk narrative",\n' +
                '  "executionSteps": ["step 1", "step 2", ...]\n' +
                "}",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 8192,
              temperature: 0.35,
            },
          ],
          swarm_type: "MixtureOfAgents",
          task:
            `Optimize DeFi yield allocation for a ${riskTolerance} risk tolerance investor` +
            (amount ? ` with $${amount}` : "") +
            ` across chains: ${chains.join(", ")}.\n\n` +
            `Current top yields:\n${yieldSummary}`,
          max_loops: 1,
        });

        const rawOutput = extractSwarmOutput(result);
        const parsed = tryParseJson(rawOutput);

        const strategy = (parsed?.strategy as string) ?? "Balanced DeFi Yield";
        const positions = Array.isArray(parsed?.positions) ? parsed.positions : [];
        const expectedApy = typeof parsed?.expectedApy === "number" ? parsed.expectedApy : 0;
        const riskAssessment = (parsed?.riskAssessment as string) ?? rawOutput.slice(0, 1000);
        const executionSteps = Array.isArray(parsed?.executionSteps) ? parsed.executionSteps : [];

        // Free tier: show strategy name + expectedApy + disclaimer. Hide positions/riskAssessment.
        let responseBody: Record<string, unknown>;
        if (gate.amountUsd > 0) {
          responseBody = {
            strategy,
            positions,
            expectedApy,
            riskAssessment,
            executionSteps,
            disclaimer: YIELD_DISCLAIMER,
            rawOutput,
          };
        } else {
          responseBody = {
            strategy,
            expectedApy,
            disclaimer: YIELD_DISCLAIMER,
            _preview: true,
            _message: `Strategy: ${strategy}. Expected APY: ${expectedApy}%. Pay $0.10 to see positions and risk assessment.`,
          };
        }

        res.json({
          ...responseBody,
          template: "YieldOptimizer",
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
          "[x402/yield-optimizer] Swarm execution failed",
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/research-report — $0.15 ───────────────────────────────
  {
    type: "POST",
    path: "/x402/research-report",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.15",
        description: "Fact-checked research report (4 agents, SequentialWorkflow)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const topic = requireString(body, "topic", 500);
      if (!topic) {
        res.status(400).json({ error: "Missing required field: topic (non-empty string, max 500 chars)" });
        return;
      }
      const depth: "brief" | "standard" | "deep" =
        typeof body.depth === "string" &&
        ["brief", "standard", "deep"].includes(body.depth)
          ? (body.depth as "brief" | "standard" | "deep")
          : "standard";
      const focus = typeof body.focus === "string" ? body.focus : undefined;

      // Check cache
      const cacheKey = topicHash(topic, depth);
      const cached = researchCache.get(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `research-report-${Date.now()}`,
          description: `Research report: ${topic}`,
          agents: [
            {
              agent_name: "Researcher",
              system_prompt:
                "You are a thorough researcher. Gather comprehensive information about the topic. " +
                "Tag each claim with a confidence indicator: [HIGH], [MEDIUM], or [LOW]. " +
                "Be exhaustive in your coverage. Structure your findings clearly with headings. " +
                "Include data points, statistics, and source references where possible.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 8192,
              temperature: 0.6,
            },
            {
              agent_name: "FactChecker",
              system_prompt:
                "You are a meticulous fact-checker. Cross-reference every significant claim from the researcher. " +
                "Mark each claim as: VERIFIED, UNVERIFIED, DISPUTED, OUTDATED, or FABRICATED. " +
                "If unsure, mark UNVERIFIED not DISPUTED. Do NOT fabricate corrections. " +
                "For each claim, provide your reasoning for the status. " +
                "Output structured findings with the original claim, your verdict, and brief justification.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 6144,
              temperature: 0.15,
            },
            {
              agent_name: "Analyst",
              system_prompt:
                "You are an expert analyst. Synthesize the verified research into actionable insights. " +
                "Downweight claims marked UNVERIFIED or DISPUTED. Highlight VERIFIED claims prominently. " +
                "Flag any FABRICATED claims as warnings. " +
                "Identify patterns, trends, implications, and areas that need further investigation.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 6144,
              temperature: 0.4,
            },
            {
              agent_name: "Writer",
              system_prompt:
                "You are a skilled report writer. Produce a polished final report with these sections:\n" +
                "1. Executive Summary (2-3 paragraphs)\n" +
                "2. Background\n" +
                "3. Key Findings (with [VERIFIED]/[UNVERIFIED]/[DISPUTED] confidence indicators)\n" +
                "4. Analysis\n" +
                "5. Risks\n" +
                "6. Recommendations\n\n" +
                "Write in a professional, concise style. Use the analyst's insights as the primary input. " +
                "Preserve confidence indicators on key claims.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 16384,
              temperature: 0.45,
            },
          ],
          swarm_type: "SequentialWorkflow",
          task:
            `Research the following topic (depth: ${depth})${focus ? `, focusing on: ${focus}` : ""}: ${topic}`,
          max_loops: 1,
          rules:
            "Each agent builds on the previous agent's output. The Researcher gathers raw information with confidence tags, the FactChecker verifies claims, the Analyst synthesizes insights, and the Writer produces the final report.",
        });

        const rawOutput = extractSwarmOutput(result);

        // Extract executive summary (first section or first 300 chars)
        const execMatch = rawOutput.match(
          /(?:executive\s+summary|summary)[:\s]*([\s\S]{20,2000}?)(?=\n#{1,3}\s|\n\d+\.\s|$)/i,
        );
        const executiveSummary = execMatch?.[1]?.trim() ?? rawOutput.slice(0, 500);

        // Extract key findings
        const findingsMatch = rawOutput.match(
          /(?:key\s+findings|findings)[:\s]*([\s\S]{20,3000}?)(?=\n#{1,3}\s|\n\d+\.\s(?:analysis|risk|recommendation)|$)/i,
        );
        const keyFindings = findingsMatch?.[1]?.trim() ?? "";

        // Save report
        const reportId = saveReport({
          type: "research-report",
          createdAt: new Date().toISOString(),
          input: { code: topic },
          result: { executiveSummary, keyFindings, fullReport: rawOutput },
          riskScore: null,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        // Free tier: first 300 chars of executive summary + 2 key findings
        let responseBody: Record<string, unknown>;
        if (gate.amountUsd > 0) {
          responseBody = {
            executiveSummary,
            keyFindings,
            fullReport: rawOutput,
          };
        } else {
          // Extract first 2 findings
          const findingLines = keyFindings
            .split("\n")
            .filter((l) => l.trim().length > 10)
            .slice(0, 2);
          responseBody = {
            executiveSummary: executiveSummary.slice(0, 300) + (executiveSummary.length > 300 ? "..." : ""),
            keyFindings: findingLines.join("\n"),
            _preview: true,
            _message: `Report preview. Pay $0.15 to see the full report.`,
          };
        }

        const fullResponse = {
          ...responseBody,
          ...urls,
          topic,
          depth,
          template: "ResearchReport",
          freeRemaining: gate.freeRemaining,
          payment: {
            amount: "0.15",
            transaction: gate.transaction,
            network: gate.network,
          },
        };

        // Cache the full response
        researchCache.set(cacheKey, fullResponse);

        res.json(fullResponse);
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/research-report] Swarm execution failed",
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/compliance-check — $0.15 ──────────────────────────────
  {
    type: "POST",
    path: "/x402/compliance-check",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.15",
        description: "Compliance analysis (3 agents, SequentialWorkflow)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const document = requireString(body, "document", 100_000);
      if (!document) {
        res.status(400).json({ error: "Missing required field: document (non-empty string, max 100,000 chars)" });
        return;
      }

      const jurisdiction = typeof body.jurisdiction === "string" ? body.jurisdiction : undefined;
      const industry = typeof body.industry === "string" ? body.industry : undefined;

      const validFrameworks = ["GDPR", "SOC2", "HIPAA", "MiCA", "AML", "PCI-DSS", "CCPA"];
      const framework =
        typeof body.framework === "string" && validFrameworks.includes(body.framework)
          ? body.framework
          : undefined;

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      const frameworkInstruction = framework
        ? `Focus specifically on ${framework} compliance.`
        : "Auto-detect the most relevant regulatory frameworks based on the document content, jurisdiction, and industry.";

      try {
        const result = await swarmsService.runSwarm({
          name: `compliance-check-${Date.now()}`,
          description: `Compliance check${framework ? ` (${framework})` : ""}`,
          agents: [
            {
              agent_name: "RegulatoryExpert",
              system_prompt:
                "You are a regulatory compliance expert. Identify all applicable regulatory frameworks and their specific requirements. " +
                `${frameworkInstruction}\n` +
                (jurisdiction ? `Jurisdiction: ${jurisdiction}. ` : "") +
                (industry ? `Industry: ${industry}. ` : "") +
                "For each framework, cite specific article/section references. " +
                "ANTI-HALLUCINATION: If unsure about a specific article number, say 'approximately'. Note that regulatory info may be outdated. " +
                "Output a structured list of applicable frameworks with their key requirements.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 6144,
              temperature: 0.2,
            },
            {
              agent_name: "GapAnalyzer",
              system_prompt:
                "You are a compliance gap analyst. Compare the provided document against the regulatory requirements identified by the RegulatoryExpert. " +
                "For each requirement, assign a status: compliant, partially-compliant, non-compliant, or not-applicable. " +
                "Group findings by severity: critical (immediate legal risk), high (significant gaps), medium (improvement needed), low (minor issues). " +
                "Output structured gap analysis with requirement, status, severity, and specific evidence from the document.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 8192,
              temperature: 0.2,
            },
            {
              agent_name: "ComplianceWriter",
              system_prompt:
                "You are a compliance report writer. Synthesize the regulatory analysis and gap findings into a comprehensive report.\n\n" +
                "Include:\n" +
                "1. Compliance Scorecard — overall score (0-100) and per-framework scores\n" +
                "2. Critical Findings — issues requiring immediate attention\n" +
                "3. Gap Summary — counts by severity (critical, high, medium, low)\n" +
                "4. Detailed Findings — each gap with status, evidence, and recommendation\n" +
                "5. Remediation Roadmap — prioritized action items with estimated effort\n\n" +
                "Output a JSON object:\n" +
                "{\n" +
                '  "overallComplianceScore": <0-100>,\n' +
                '  "frameworks": [{ "name": "...", "score": <0-100>, "status": "..." }],\n' +
                '  "gaps": { "critical": <count>, "high": <count>, "medium": <count>, "low": <count> },\n' +
                '  "criticalFindings": ["..."],\n' +
                '  "remediationRoadmap": [{ "priority": <1-N>, "action": "...", "effort": "low|medium|high", "impact": "..." }],\n' +
                '  "report": "full text report"\n' +
                "}",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 16384,
              temperature: 0.35,
            },
          ],
          swarm_type: "SequentialWorkflow",
          task:
            `Analyze the following document for regulatory compliance${framework ? ` (${framework})` : ""}` +
            (jurisdiction ? `, jurisdiction: ${jurisdiction}` : "") +
            (industry ? `, industry: ${industry}` : "") +
            `:\n\n${document}`,
          max_loops: 1,
          rules:
            "Each agent builds on the previous agent's output. The RegulatoryExpert identifies applicable frameworks, the GapAnalyzer finds compliance gaps, and the ComplianceWriter produces the final report.",
        });

        const rawOutput = extractSwarmOutput(result);
        const parsed = tryParseJson(rawOutput);

        const overallComplianceScore =
          typeof parsed?.overallComplianceScore === "number"
            ? (parsed.overallComplianceScore as number)
            : 50;
        const gaps = (parsed?.gaps as Record<string, number>) ?? { critical: 0, high: 0, medium: 0, low: 0 };
        const criticalFindings = Array.isArray(parsed?.criticalFindings) ? parsed.criticalFindings : [];
        const frameworks = Array.isArray(parsed?.frameworks) ? parsed.frameworks : [];
        const remediationRoadmap = Array.isArray(parsed?.remediationRoadmap) ? parsed.remediationRoadmap : [];
        const reportText = (parsed?.report as string) ?? rawOutput;

        // Free tier: show overallComplianceScore + gap counts by severity + disclaimer
        let responseBody: Record<string, unknown>;
        if (gate.amountUsd > 0) {
          responseBody = {
            overallComplianceScore,
            frameworks,
            gaps,
            criticalFindings,
            remediationRoadmap,
            report: reportText,
            disclaimer: COMPLIANCE_DISCLAIMER,
          };
        } else {
          responseBody = {
            overallComplianceScore,
            gaps,
            disclaimer: COMPLIANCE_DISCLAIMER,
            _preview: true,
            _message: `Compliance score: ${overallComplianceScore}/100. Gaps: ${gaps.critical ?? 0} critical, ${gaps.high ?? 0} high, ${gaps.medium ?? 0} medium, ${gaps.low ?? 0} low. Pay $0.15 to see full report.`,
          };
        }

        res.json({
          ...responseBody,
          template: "ComplianceCheck",
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
          "[x402/compliance-check] Swarm execution failed",
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/investment-dd — $0.19 ─────────────────────────────────
  {
    type: "POST",
    path: "/x402/investment-dd",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.19",
        description: "Investment due diligence (5+1 agents, ConcurrentWorkflow + synthesis)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const project = requireString(body, "project", 500);
      if (!project) {
        res.status(400).json({ error: "Missing required field: project (non-empty string, max 500 chars)" });
        return;
      }
      const projectType: "token" | "protocol" | "dao" | "nft" =
        typeof body.projectType === "string" &&
        ["token", "protocol", "dao", "nft"].includes(body.projectType)
          ? (body.projectType as "token" | "protocol" | "dao" | "nft")
          : "token";
      const context = typeof body.context === "string" ? body.context.slice(0, 5000) : undefined;

      // Check cache
      const cacheKey = `dd:${project.toLowerCase().trim()}:${projectType}`;
      const cached = ddCache.get(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");

      try {
        // Phase 1: 5 concurrent specialist agents
        const phase1Result = await swarmsService.runSwarm({
          name: `investment-dd-${Date.now()}`,
          description: `Investment DD: ${project} (${projectType})`,
          agents: [
            {
              agent_name: "TeamAnalyst",
              system_prompt:
                `You are a team due diligence analyst evaluating the ${projectType} project "${project}". ` +
                "Analyze: team background, doxxed status, track record, previous projects, " +
                "LinkedIn/Twitter presence, advisory board quality, team size, relevant experience. " +
                "Output a JSON object: { \"score\": <0-100>, \"summary\": \"...\", \"doxxed\": true|false, " +
                "\"trackRecord\": \"...\", \"concerns\": [\"...\"], \"strengths\": [\"...\"] }",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
            {
              agent_name: "TokenomicsExpert",
              system_prompt:
                `You are a tokenomics expert evaluating "${project}" (${projectType}). ` +
                "Analyze: token distribution, vesting schedules, emission rates, utility, " +
                "insider allocation percentage, unlock schedules, supply mechanics (inflationary/deflationary), " +
                "staking incentives, treasury management. " +
                "Output a JSON object: { \"score\": <0-100>, \"summary\": \"...\", " +
                "\"insiderAllocation\": <percentage>, \"vestingDetails\": \"...\", " +
                "\"concerns\": [\"...\"], \"strengths\": [\"...\"] }",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.25,
            },
            {
              agent_name: "TechReviewer",
              system_prompt:
                `You are a technical reviewer evaluating "${project}" (${projectType}). ` +
                "Analyze: architecture design, code quality (if open source), audit history, " +
                "technology stack, scalability approach, security practices, open source status, " +
                "GitHub activity, test coverage, documentation quality. " +
                "Output a JSON object: { \"score\": <0-100>, \"summary\": \"...\", " +
                "\"openSource\": true|false, \"auditHistory\": [\"...\"], " +
                "\"concerns\": [\"...\"], \"strengths\": [\"...\"] }",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.25,
            },
            {
              agent_name: "CommunityScanner",
              system_prompt:
                `You are a community analyst evaluating "${project}" (${projectType}). ` +
                "Analyze: social media presence (Twitter, Discord, Telegram), engagement quality, " +
                "community sentiment, bot activity detection, growth trends, developer community, " +
                "governance participation, content quality vs hype ratio. " +
                "Output a JSON object: { \"score\": <0-100>, \"summary\": \"...\", " +
                "\"concerns\": [\"...\"], \"strengths\": [\"...\"] }",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.35,
            },
            {
              agent_name: "MarketAnalyst",
              system_prompt:
                `You are a market analyst evaluating "${project}" (${projectType}). ` +
                "Analyze: total addressable market, competitive landscape, market timing, " +
                "comparable projects and their performance, market saturation, " +
                "regulatory environment, macro trends affecting the sector. " +
                "Output a JSON object: { \"score\": <0-100>, \"summary\": \"...\", " +
                "\"competitors\": [\"...\"], \"concerns\": [\"...\"], \"strengths\": [\"...\"] }",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
          ],
          swarm_type: "ConcurrentWorkflow",
          task:
            `Perform investment due diligence on ${projectType} project: "${project}".` +
            (context ? `\n\nAdditional context: ${context}` : ""),
          max_loops: 1,
        });

        const phase1Output = extractSwarmOutput(phase1Result);

        // Phase 2: Synthesis via callOpenAI
        let synthesisOutput: string;
        if (openaiKey) {
          synthesisOutput = await callOpenAI({
            apiKey: openaiKey,
            model: "gpt-5-mini",
            systemPrompt:
              "You are an investment due diligence synthesizer. You receive outputs from 5 specialist analysts " +
              "(Team, Tokenomics, Tech, Community, Market). Synthesize into a final DD report.\n\n" +
              "SCORING WEIGHTS: team 25%, tokenomics 20%, tech 25%, community 15%, market 15%.\n\n" +
              "CROSS-CHECK PENALTIES:\n" +
              "- Anonymous team + closed source code = -15 points from overall score\n" +
              "- >40% insider allocation + poor community engagement = -20 points from overall score\n\n" +
              "RECOMMENDATION SCALE:\n" +
              "- STRONG_BUY: 80-100\n" +
              "- BUY: 65-79\n" +
              "- HOLD: 50-64\n" +
              "- AVOID: 35-49\n" +
              "- STRONG_AVOID: 0-34\n\n" +
              "Output a JSON object:\n" +
              "{\n" +
              `  "project": "${project}",\n` +
              `  "projectType": "${projectType}",\n` +
              '  "overallScore": <0-100>,\n' +
              '  "recommendation": "STRONG_BUY"|"BUY"|"HOLD"|"AVOID"|"STRONG_AVOID",\n' +
              '  "dimensions": {\n' +
              '    "team": { "score": <0-100>, "weight": 25, "summary": "..." },\n' +
              '    "tokenomics": { "score": <0-100>, "weight": 20, "summary": "..." },\n' +
              '    "tech": { "score": <0-100>, "weight": 25, "summary": "..." },\n' +
              '    "community": { "score": <0-100>, "weight": 15, "summary": "..." },\n' +
              '    "market": { "score": <0-100>, "weight": 15, "summary": "..." }\n' +
              "  },\n" +
              '  "keyFindings": ["..."],\n' +
              '  "redFlags": ["..."],\n' +
              '  "bullCase": "...",\n' +
              '  "bearCase": "...",\n' +
              '  "executiveSummary": "..."\n' +
              "}",
            userPrompt:
              `Synthesize the following 5 specialist analyses into a final investment DD report for "${project}" (${projectType}):\n\n${phase1Output}`,
            maxTokens: 16384,
            temperature: 0.3,
          });
        } else {
          // Fallback: use swarms for synthesis too
          const synthResult = await swarmsService.runAgent(
            {
              agent_name: "DDSynthesizer",
              model_name: "gpt-5-mini",
              system_prompt: "Synthesize the specialist analyses into a final DD report with overallScore, recommendation, dimensions, keyFindings, redFlags, bullCase, bearCase, executiveSummary. Output JSON.",
              max_loops: 1,
              max_tokens: 16384,
              temperature: 0.3,
              role: "worker",
            },
            `Synthesize the following 5 specialist analyses into a final investment DD report for "${project}" (${projectType}):\n\n${phase1Output}`,
          );
          synthesisOutput = String(synthResult.outputs ?? synthResult);
        }

        const parsed = tryParseJson(synthesisOutput);

        const overallScore = typeof parsed?.overallScore === "number" ? (parsed.overallScore as number) : 50;
        const recommendation = (parsed?.recommendation as string) ?? scoreToRecommendation(overallScore);
        const dimensions = (parsed?.dimensions as Record<string, unknown>) ?? {};
        const keyFindings = Array.isArray(parsed?.keyFindings) ? parsed.keyFindings : [];
        const redFlags = Array.isArray(parsed?.redFlags) ? parsed.redFlags : [];
        const bullCase = (parsed?.bullCase as string) ?? "";
        const bearCase = (parsed?.bearCase as string) ?? "";
        const executiveSummary = (parsed?.executiveSummary as string) ?? synthesisOutput.slice(0, 1000);

        // Save report
        const reportId = saveReport({
          type: "investment-dd",
          createdAt: new Date().toISOString(),
          input: { code: project },
          result: {
            overallScore,
            recommendation,
            dimensions,
            keyFindings,
            redFlags,
            bullCase,
            bearCase,
            executiveSummary,
          },
          riskScore: overallScore,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        // Free tier: show dimension scores + recommendation + red flag count + disclaimer
        let responseBody: Record<string, unknown>;
        if (gate.amountUsd > 0) {
          responseBody = {
            project,
            projectType,
            overallScore,
            recommendation,
            dimensions,
            keyFindings,
            redFlags,
            bullCase,
            bearCase,
            executiveSummary,
            disclaimer: DD_DISCLAIMER,
          };
        } else {
          // Extract just scores from dimensions
          const dimScores: Record<string, number> = {};
          for (const [key, val] of Object.entries(dimensions)) {
            if (val && typeof val === "object" && "score" in (val as Record<string, unknown>)) {
              dimScores[key] = (val as Record<string, unknown>).score as number;
            }
          }
          responseBody = {
            project,
            projectType,
            overallScore,
            recommendation,
            dimensionScores: dimScores,
            redFlagCount: redFlags.length,
            disclaimer: DD_DISCLAIMER,
            _preview: true,
            _message: `Score: ${overallScore}/100 (${recommendation}). ${redFlags.length} red flag(s). Pay $0.19 to see full report.`,
          };
        }

        const fullResponse = {
          ...responseBody,
          ...urls,
          template: "InvestmentDD",
          freeRemaining: gate.freeRemaining,
          payment: {
            amount: "0.19",
            transaction: gate.transaction,
            network: gate.network,
          },
        };

        // Cache the full response
        ddCache.set(cacheKey, fullResponse);

        res.json(fullResponse);
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/investment-dd] Execution failed",
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },
];

// ── Helper: score to recommendation mapping ─────────────────────────────

function scoreToRecommendation(score: number): string {
  if (score >= 80) return "STRONG_BUY";
  if (score >= 65) return "BUY";
  if (score >= 50) return "HOLD";
  if (score >= 35) return "AVOID";
  return "STRONG_AVOID";
}
