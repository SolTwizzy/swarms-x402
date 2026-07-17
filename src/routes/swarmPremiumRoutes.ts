import type { Route } from "@elizaos/core";
import { x402Gate } from "../server/x402Gate.js";
import type { X402GateResult } from "../server/x402Gate.js";
import type { X402ServiceEndpoint } from "../types.js";
import { SOLANA_ADDR_RE, heliusRpcUrl, rpcCall } from "./heliusDataRoutes.js";
import { callOpenAI } from "../utils/llm.js";
import { TTLCache } from "../utils/cache.js";
import { saveReport } from "../utils/reportStore.js";

// ── Disclaimers ─────────────────────────────────────────────────────────

const RESEARCH_DISCLAIMER =
  "This research report is AI-generated from multiple data sources. Verify all claims independently before making decisions.";

// ── Caches ──────────────────────────────────────────────────────────────

const deepResearchCache = new TTLCache<any>(10 * 60_000); // 10 min
const monitorCache = new TTLCache<any>(30_000);            // 30 s

// ── Helius rate-limit tracking ──────────────────────────────────────────

const heliusErrorCache = new TTLCache<string>(60_000);

function isHeliusRateLimited(): boolean {
  return !!heliusErrorCache.get("helius:rate-limit");
}

function recordHeliusError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (/rate.limit|429|max.usage|too.many/i.test(msg)) {
    heliusErrorCache.set("helius:rate-limit", msg);
  }
}

// ── Report URL helper ───────────────────────────────────────────────────

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

// ── Agent System Prompts ────────────────────────────────────────────────

const MODEL_KNOWLEDGE_PROMPT = `You are a research agent. Draw on your knowledge to provide comprehensive information about the given topic. You do NOT have live web access — do not claim to have searched or cite URLs you cannot verify.

Instructions:
- Cover multiple perspectives
- Tag each claim with confidence: [HIGH] (well-established), [MEDIUM] (generally accepted), [LOW] (uncertain/speculative)
- Be explicit about the recency limits of your knowledge
- Focus on factual information, not opinions

Output ONLY valid JSON:
{
  "findings": [
    { "claim": "...", "confidence": "HIGH|MEDIUM|LOW", "source": "..." }
  ],
  "summary": "Brief 2-3 sentence summary of key findings"
}`;

const ONCHAIN_ANALYSIS_PROMPT = `You are an on-chain data analyst. Given raw blockchain data, extract relevant facts and insights.

Instructions:
- Interpret balances, supply, holder distributions
- Flag any unusual patterns (concentration, activity spikes)
- Convert raw values to human-readable formats
- Note data freshness/recency

Output ONLY valid JSON:
{
  "onChainFacts": [
    { "fact": "...", "dataSource": "...", "value": "..." }
  ],
  "interpretation": "Brief analysis of what the data suggests"
}`;

const FACT_CHECK_PROMPT = `You are an adversarial fact-checker. Cross-reference all provided claims from multiple sources.

Instructions:
- Compare model-knowledge findings against on-chain data where applicable
- Flag contradictions between sources
- Rate each claim: VERIFIED (multiple sources confirm) / LIKELY_TRUE (credible but unconfirmed) / UNVERIFIED (cannot confirm) / DISPUTED (contradictory evidence) / FALSE (evidence contradicts)
- Be skeptical — default to UNVERIFIED when uncertain

Output ONLY valid JSON:
{
  "verifiedFacts": [
    { "claim": "...", "verdict": "VERIFIED|LIKELY_TRUE|UNVERIFIED|DISPUTED|FALSE", "confidence": 0.0-1.0, "note": "..." }
  ],
  "contradictions": ["..."],
  "overallReliability": 0-100
}`;

const SYNTHESIS_PROMPT = `You are a research report writer producing comprehensive, fact-checked reports.

Instructions:
- Use ONLY the verified facts provided — do not fabricate information
- Structure the report clearly with sections
- Include confidence indicators inline (e.g., [VERIFIED], [LIKELY_TRUE])
- Highlight contradictions and areas of uncertainty
- Be balanced — present both positive and negative findings
- Target 1500-3000 words

Format:
# Executive Summary
(2-3 paragraph overview)

# Key Findings
(Numbered list with confidence tags)

# Data Sources
(What sources were consulted)

# Risk Factors
(Potential concerns or caveats)

# Conclusions
(Final assessment with confidence level)`;

// ── Monitor Agent Prompts ───────────────────────────────────────────────

const PRICE_CHECK_PROMPT = `You are a price/balance monitoring agent. Given on-chain data for a target, report current state.

Output ONLY valid JSON:
{
  "signals": [
    { "type": "balance|supply|price", "label": "...", "value": "...", "unit": "..." }
  ]
}`;

const ACTIVITY_CHECK_PROMPT = `You are a transaction activity monitor. Analyze recent transactions for a target address or token.

Output ONLY valid JSON:
{
  "signals": [
    { "type": "activity", "label": "...", "value": "...", "detail": "..." }
  ],
  "recentTxCount": 0,
  "mostRecentTxAge": "..."
}`;

const ALERT_ANALYSIS_PROMPT = `You are an alert analysis agent. Given monitoring signals and optional thresholds, determine if the target needs attention.

Status levels:
- ALERT: Threshold crossed or critical anomaly detected
- WATCH: Approaching thresholds or unusual activity
- NORMAL: All signals within expected ranges

Output ONLY valid JSON:
{
  "status": "ALERT|WATCH|NORMAL",
  "triggeredAlerts": [
    { "signal": "...", "threshold": "...", "actual": "...", "severity": "high|medium|low" }
  ],
  "summary": "One-sentence status summary",
  "nextCheckRecommended": "5m|15m|1h|4h|24h"
}`;

// ── On-Chain Context Fetcher ────────────────────────────────────────────

export async function fetchOnChainContext(
  topic: string,
  runtime: any,
): Promise<string> {
  const heliusKey = String(runtime.getSetting("HELIUS_API_KEY") ?? "");
  if (!heliusKey || isHeliusRateLimited()) {
    return "No on-chain data available (HELIUS_API_KEY not configured or rate limited)";
  }

  const rpcUrl = heliusRpcUrl(heliusKey);
  const parts: string[] = [];

  // Check if topic contains a Solana address
  const addrMatch = topic.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  if (!addrMatch) {
    return "No Solana address detected in topic";
  }

  const addr = addrMatch[0];
  if (!SOLANA_ADDR_RE.test(addr)) {
    return "No valid Solana address detected in topic";
  }

  try {
    // Parallel fetch: balance, token supply, largest accounts, recent signatures
    const [balance, supply, holders, sigs] = await Promise.all([
      rpcCall(rpcUrl, "getBalance", [addr]).catch(() => null),
      rpcCall(rpcUrl, "getTokenSupply", [addr]).catch(() => null),
      rpcCall(rpcUrl, "getTokenLargestAccounts", [addr]).catch(() => null),
      rpcCall(rpcUrl, "getSignaturesForAddress", [addr, { limit: 5 }]).catch(() => null),
    ]);

    if (balance?.value !== undefined) {
      parts.push(`SOL balance: ${balance.value / 1e9} SOL`);
    }
    if (supply?.value) {
      parts.push(`Token supply: ${supply.value.uiAmountString ?? JSON.stringify(supply.value)}`);
    }
    if (holders?.value) {
      const top5 = holders.value
        .slice(0, 5)
        .map((h: any) => `${h.address}: ${h.uiAmountString}`)
        .join(", ");
      parts.push(`Top holders: ${top5}`);
    }
    if (sigs) {
      const sigArr = Array.isArray(sigs) ? sigs : [];
      parts.push(`Recent transactions: ${sigArr.length} found`);
      if (sigArr.length > 0 && sigArr[0].blockTime) {
        const age = Math.floor((Date.now() / 1000 - sigArr[0].blockTime) / 60);
        parts.push(`Most recent tx: ${age} minutes ago`);
      }
    }
  } catch (err) {
    recordHeliusError(err);
    return "On-chain data fetch failed (Helius error)";
  }

  return parts.length > 0 ? parts.join("\n") : "Address found but no on-chain data retrieved";
}

// ── Monitor Data Fetcher ────────────────────────────────────────────────

interface MonitorSignal {
  type: string;
  label: string;
  value: string;
  unit?: string;
  detail?: string;
}

async function fetchMonitorData(
  target: string,
  type: "token" | "wallet" | "protocol",
  runtime: any,
): Promise<{ priceSignals: MonitorSignal[]; activitySignals: MonitorSignal[] }> {
  const heliusKey = String(runtime.getSetting("HELIUS_API_KEY") ?? "");
  const priceSignals: MonitorSignal[] = [];
  const activitySignals: MonitorSignal[] = [];

  if (!heliusKey || isHeliusRateLimited()) {
    priceSignals.push({ type: "error", label: "Helius unavailable", value: "N/A" });
    return { priceSignals, activitySignals };
  }

  const rpcUrl = heliusRpcUrl(heliusKey);

  // Only fetch on-chain data if target looks like a Solana address
  if (!SOLANA_ADDR_RE.test(target)) {
    priceSignals.push({ type: "info", label: "target", value: target, detail: "Not a Solana address — limited data" });
    return { priceSignals, activitySignals };
  }

  try {
    if (type === "wallet") {
      const [balance, sigs] = await Promise.all([
        rpcCall(rpcUrl, "getBalance", [target]).catch(() => null),
        rpcCall(rpcUrl, "getSignaturesForAddress", [target, { limit: 10 }]).catch(() => null),
      ]);
      if (balance?.value !== undefined) {
        priceSignals.push({
          type: "balance",
          label: "SOL Balance",
          value: String(balance.value / 1e9),
          unit: "SOL",
        });
      }
      if (sigs) {
        const sigArr = Array.isArray(sigs) ? sigs : [];
        activitySignals.push({
          type: "activity",
          label: "Recent Transactions",
          value: String(sigArr.length),
          detail: sigArr.length > 0 && sigArr[0].blockTime
            ? `Most recent: ${Math.floor((Date.now() / 1000 - sigArr[0].blockTime) / 60)} min ago`
            : "No recent activity",
        });
      }
    } else if (type === "token") {
      const [supply, holders, sigs] = await Promise.all([
        rpcCall(rpcUrl, "getTokenSupply", [target]).catch(() => null),
        rpcCall(rpcUrl, "getTokenLargestAccounts", [target]).catch(() => null),
        rpcCall(rpcUrl, "getSignaturesForAddress", [target, { limit: 10 }]).catch(() => null),
      ]);
      if (supply?.value) {
        priceSignals.push({
          type: "supply",
          label: "Token Supply",
          value: supply.value.uiAmountString ?? String(supply.value.amount),
          unit: "tokens",
        });
      }
      if (holders?.value) {
        const top = holders.value[0];
        if (top) {
          const totalSupply = supply?.value?.uiAmount ?? 1;
          const concentration = totalSupply > 0
            ? ((top.uiAmount ?? 0) / totalSupply * 100).toFixed(1)
            : "N/A";
          priceSignals.push({
            type: "concentration",
            label: "Top Holder %",
            value: concentration,
            unit: "%",
          });
        }
      }
      if (sigs) {
        const sigArr = Array.isArray(sigs) ? sigs : [];
        activitySignals.push({
          type: "activity",
          label: "Recent Mint/Transfer Activity",
          value: String(sigArr.length),
          detail: sigArr.length > 0 && sigArr[0].blockTime
            ? `Most recent: ${Math.floor((Date.now() / 1000 - sigArr[0].blockTime) / 60)} min ago`
            : "No recent activity",
        });
      }
    } else {
      // protocol — treat target as an address
      const balance = await rpcCall(rpcUrl, "getBalance", [target]).catch(() => null);
      if (balance?.value !== undefined) {
        priceSignals.push({
          type: "balance",
          label: "Protocol Treasury",
          value: String(balance.value / 1e9),
          unit: "SOL",
        });
      }
    }
  } catch (err) {
    recordHeliusError(err);
    priceSignals.push({ type: "error", label: "Helius error", value: String(err) });
  }

  return { priceSignals, activitySignals };
}

// ── Deep Research Pipeline ──────────────────────────────────────────────

interface DeepResearchResult {
  report: string;
  webFindings: string;
  onChainData: string;
  factCheckResults: string;
  agentsUsed: string[];
  sourcesQueried: string[];
}

export async function runDeepResearch(
  topic: string,
  focus: string,
  sources: string[],
  runtime: any,
): Promise<DeepResearchResult> {
  const swarmsKey = String(runtime.getSetting("SWARMS_API_KEY") ?? "");
  const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");
  const agentsUsed: string[] = [];
  const sourcesQueried: string[] = [];

  // Swarms-first single-agent call (cascades to OpenAI if Swarms fails).
  const llm = (systemPrompt: string, userPrompt: string, maxTokens: number, temperature: number) =>
    callOpenAI({ apiKey: openaiKey, swarmsApiKey: swarmsKey, systemPrompt, userPrompt, maxTokens, temperature });

  // ── Step 1: Model-knowledge research (no live web retrieval)
  let modelFindings = "";
  if (sources.includes("model-knowledge") || sources.includes("web")) {
    const researchPrompt = `Research topic: ${topic}\nFocus: ${focus || "comprehensive overview"}`;
    modelFindings = await llm(MODEL_KNOWLEDGE_PROMPT, researchPrompt, 4096, 0.5);
    agentsUsed.push("ResearchAgent (model knowledge; no live retrieval)");
    sourcesQueried.push("model-knowledge");
  }

  // ── Step 2: On-Chain Data Agent (if applicable)
  let onChainData = "";
  if (sources.includes("onchain")) {
    onChainData = await fetchOnChainContext(topic, runtime);
    if (onChainData && !onChainData.includes("No ") && !onChainData.includes("not configured")) {
      // Run analysis agent on the raw data
      onChainData = await llm(
        ONCHAIN_ANALYSIS_PROMPT,
        `On-chain data for "${topic}":\n${onChainData}`,
        2048,
        0.2,
      );
      agentsUsed.push("OnChainDataAgent (Helius RPC + routed model analysis)");
      sourcesQueried.push("onchain (Helius RPC)");
    }
  }

  // ── Step 3: Fact-Check Agent (provider-routed model cross-check)
  const factCheckInput = [
    modelFindings ? `Model-knowledge findings:\n${modelFindings}` : "",
    onChainData ? `On-chain data:\n${onChainData}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  let factChecked = "";
  if (factCheckInput) {
    factChecked = await llm(FACT_CHECK_PROMPT, factCheckInput, 4096, 0.15);
    agentsUsed.push("FactCheckAgent (routed model cross-check)");
  }

  // ── Step 4: Synthesis Agent (provider-routed model)
  const synthesisInput = [
    `Verified facts:\n${factChecked || "No fact-check available"}`,
    `\nOriginal topic: ${topic}`,
    focus ? `Focus: ${focus}` : "",
    modelFindings
      ? `\nRaw model-knowledge findings (for context):\n${modelFindings.slice(0, 2000)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const report = await llm(SYNTHESIS_PROMPT, synthesisInput, 8192, 0.4);
  agentsUsed.push("SynthesisAgent (routed model synthesis)");

  return {
    report,
    webFindings: modelFindings,
    onChainData,
    factCheckResults: factChecked,
    agentsUsed,
    sourcesQueried,
  };
}

// ── Catalog entries ─────────────────────────────────────────────────────

export const SWARM_PREMIUM_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "Deep Research Swarm",
    description:
      "Provider-routed research pipeline — model-knowledge analysis (no live web retrieval), optional on-chain data from Helius, adversarial consistency checks, and a synthesis report.",
    path: "/swarm/deep-research",
    method: "POST",
    priceUsd: "0.15",
  },
  {
    name: "Monitor Swarm",
    description:
      "3-agent parallel monitoring — price/balance checker, activity monitor, alert analyzer. Checks multiple signals against thresholds, returns ALERT/WATCH/NORMAL status. Designed for access-pass buyers running on a schedule.",
    path: "/swarm/monitor",
    method: "POST",
    priceUsd: "0.10",
  },
];

// ── Routes ──────────────────────────────────────────────────────────────

export const swarmPremiumRoutes: Route[] = [

  // ══════════════════════════════════════════════════════════════════════
  // POST /swarm/deep-research — $0.15 (4 agents, orchestrated pipeline)
  // ══════════════════════════════════════════════════════════════════════
  {
    type: "POST",
    path: "/swarm/deep-research",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.15",
        description: "Deep research swarm — 4-agent self-funding pipeline with web, on-chain, fact-check, synthesis",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const topic = body.topic;
      if (!topic || typeof topic !== "string" || topic.trim().length === 0) {
        res.status(400).json({ error: "Missing required field: topic (string, max 500 chars)" });
        return;
      }
      if (topic.length > 500) {
        res.status(400).json({ error: "Topic too long (max 500 characters)" });
        return;
      }

      const focus = typeof body.focus === "string" ? body.focus.slice(0, 200) : "";
      const validSources = ["model-knowledge", "onchain"];
      let sources: string[] = validSources; // default all
      if (Array.isArray(body.sources)) {
        sources = Array.from(
          new Set(
            body.sources
              .filter((s: unknown): s is string => typeof s === "string")
              .map((s: string) => (s === "web" ? "model-knowledge" : s))
              .filter((s: string) => validSources.includes(s)),
          ),
        );
      }

      // Cache check
      const cacheKey = `deep-research:${topic.toLowerCase().trim()}:${focus}:${sources.sort().join(",")}`;
      const cached = deepResearchCache.get(cacheKey);
      if (cached) {
        res.json({
          ...cached,
          cached: true,
          payment: {
            amount: "0.15",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
        return;
      }

      // Check that at least one LLM key is available
      const swarmsKey = String(runtime.getSetting("SWARMS_API_KEY") ?? "");
      const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");
      if (!swarmsKey && !openaiKey) {
        res.status(503).json({ error: "No LLM API key configured (need SWARMS_API_KEY or OPENAI_API_KEY)" });
        return;
      }

      try {
        const startMs = Date.now();
        const result = await runDeepResearch(topic, focus, sources, runtime);
        const durationMs = Date.now() - startMs;

        // Parse fact-check for metrics
        const factCheckParsed = tryParseJson(result.factCheckResults);
        const overallReliability =
          typeof factCheckParsed?.overallReliability === "number"
            ? factCheckParsed.overallReliability
            : null;
        const verifiedFacts = Array.isArray(factCheckParsed?.verifiedFacts)
          ? factCheckParsed.verifiedFacts
          : [];
        const contradictions = Array.isArray(factCheckParsed?.contradictions)
          ? factCheckParsed.contradictions
          : [];

        // Verdict counts
        const verdictCounts: Record<string, number> = {};
        for (const fact of verifiedFacts) {
          const v = (fact as any).verdict ?? "UNKNOWN";
          verdictCounts[v] = (verdictCounts[v] ?? 0) + 1;
        }

        // Save report
        const reportId = saveReport({
          type: "deep-research",
          createdAt: new Date().toISOString(),
          input: { code: topic },
          result: {
            topic,
            focus,
            sources,
            report: result.report,
            agentsUsed: result.agentsUsed,
            sourcesQueried: result.sourcesQueried,
            overallReliability,
            verdictCounts,
            contradictions: contradictions.length,
            durationMs,
          },
          riskScore: overallReliability,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        // Build response
        const fullResponse: Record<string, unknown> = {
          topic,
          focus: focus || null,
          sources,
          report: result.report,
          agentsUsed: result.agentsUsed,
          sourcesQueried: result.sourcesQueried,
          factCheck: {
            overallReliability,
            totalFacts: verifiedFacts.length,
            verdictCounts,
            contradictions,
          },
          template: "DeepResearch",
          durationMs,
          disclaimer: RESEARCH_DISCLAIMER,
          ...urls,
          payment: {
            amount: "0.15",
            transaction: gate.transaction,
            network: gate.network,
          },
        };

        // Free tier truncation
        if (gate.amountUsd === 0) {
          const preview = result.report.slice(0, 300);
          const suffix = result.report.length > 300 ? "..." : "";
          res.json({
            topic,
            template: "DeepResearch",
            _preview: true,
            _message: "Output truncated. Pay $0.15 to see the full research report.",
            reportPreview: preview + suffix,
            agentsUsed: result.agentsUsed.length,
            sourcesQueried: result.sourcesQueried,
            overallReliability,
            disclaimer: RESEARCH_DISCLAIMER,
          });
          return;
        }

        deepResearchCache.set(cacheKey, fullResponse);
        res.json(fullResponse);
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[swarm/deep-research] Pipeline failed",
        );
        res.status(500).json({
          error: "Deep research pipeline failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  },

  // ══════════════════════════════════════════════════════════════════════
  // POST /swarm/monitor — $0.10 (3 agents, parallel signals)
  // ══════════════════════════════════════════════════════════════════════
  {
    type: "POST",
    path: "/swarm/monitor",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.10",
        description: "Monitor swarm — 3-agent parallel monitoring with alert analysis",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const target = body.target;
      if (!target || typeof target !== "string" || target.trim().length === 0) {
        res.status(400).json({ error: "Missing required field: target (address or identifier)" });
        return;
      }

      const validTypes = ["token", "wallet", "protocol"];
      const type = validTypes.includes(body.type) ? body.type : "token";
      const thresholds: Record<string, number> = {};
      if (body.thresholds && typeof body.thresholds === "object") {
        for (const [k, v] of Object.entries(body.thresholds)) {
          if (typeof v === "number") thresholds[k] = v;
        }
      }

      // Cache check
      const cacheKey = `monitor:${target}:${type}`;
      const cached = monitorCache.get(cacheKey);
      if (cached) {
        res.json({
          ...cached,
          cached: true,
          payment: {
            amount: "0.10",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
        return;
      }

      const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");
      const swarmsKey = String(runtime.getSetting("SWARMS_API_KEY") ?? "");
      if (!swarmsKey && !openaiKey) {
        res.status(503).json({ error: "No LLM API key configured (need SWARMS_API_KEY or OPENAI_API_KEY)" });
        return;
      }

      try {
        const startMs = Date.now();

        // ── Agent 1 & 2: Parallel data fetch ────────────────────────
        const { priceSignals, activitySignals } = await fetchMonitorData(target, type, runtime);

        // ── Agent 3: Alert Analyzer (LLM) ───────────────────────────
        const allSignals = [...priceSignals, ...activitySignals];
        const alertInput = [
          `Target: ${target} (type: ${type})`,
          `\nSignals:\n${JSON.stringify(allSignals, null, 2)}`,
          Object.keys(thresholds).length > 0
            ? `\nThresholds:\n${JSON.stringify(thresholds, null, 2)}`
            : "\nNo custom thresholds set — use reasonable defaults.",
        ].join("\n");

        const alertResult = await callOpenAI({
          apiKey: openaiKey,
          swarmsApiKey: swarmsKey,
          systemPrompt: ALERT_ANALYSIS_PROMPT,
          userPrompt: alertInput,
          maxTokens: 2048,
          temperature: 0.15,
        });

        const durationMs = Date.now() - startMs;

        // Parse alert result
        const alertParsed = tryParseJson(alertResult);
        const status = (alertParsed?.status as string) ?? "NORMAL";
        const triggeredAlerts = Array.isArray(alertParsed?.triggeredAlerts)
          ? alertParsed.triggeredAlerts
          : [];
        const summary = (alertParsed?.summary as string) ?? "Monitoring complete";
        const nextCheckRecommended = (alertParsed?.nextCheckRecommended as string) ?? "15m";

        // Save report
        const reportId = saveReport({
          type: "monitor",
          createdAt: new Date().toISOString(),
          input: { mint: target },
          result: {
            target,
            type,
            status,
            signalCount: allSignals.length,
            alertCount: triggeredAlerts.length,
            durationMs,
          },
          riskScore: null,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        const fullResponse: Record<string, unknown> = {
          target,
          type,
          status,
          signals: allSignals,
          triggeredAlerts,
          summary,
          nextCheckRecommended,
          thresholds: Object.keys(thresholds).length > 0 ? thresholds : "defaults",
          template: "Monitor",
          durationMs,
          ...urls,
          payment: {
            amount: "0.10",
            transaction: gate.transaction,
            network: gate.network,
          },
        };

        // Free tier truncation
        if (gate.amountUsd === 0) {
          res.json({
            target,
            type,
            status,
            template: "Monitor",
            _preview: true,
            _message: "Output truncated. Pay $0.10 to see full signals and alerts.",
            signalCount: allSignals.length,
            alertCount: triggeredAlerts.length,
            summary,
          });
          return;
        }

        monitorCache.set(cacheKey, fullResponse);
        res.json(fullResponse);
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[swarm/monitor] Pipeline failed",
        );
        res.status(500).json({
          error: "Monitor pipeline failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  },
];
