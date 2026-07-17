import type { Route } from "@elizaos/core";
import { x402Gate } from "../server/x402Gate.js";
import type { X402GateResult } from "../server/x402Gate.js";
import { SwarmsService } from "../services/swarmsService.js";
import type { X402ServiceEndpoint } from "../types.js";
import { SOLANA_ADDR_RE, heliusRpcUrl, rpcCall } from "./heliusDataRoutes.js";
import { callOpenAI } from "../utils/llm.js";
import { TTLCache } from "../utils/cache.js";
import { saveReport } from "../utils/reportStore.js";

// ── Disclaimers ─────────────────────────────────────────────────────────

const FINANCIAL_DISCLAIMER = "Not financial advice. Do your own research.";

// ── Caches ──────────────────────────────────────────────────────────────

const diligenceCache = new TTLCache<any>(5 * 60_000);   // 5 min
const defiRiskCache = new TTLCache<any>(10 * 60_000);    // 10 min
// fact-check: NO cache (every claim is unique)

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

// ── Input validation ────────────────────────────────────────────────────

function requireString(
  body: Record<string, unknown>,
  field: string,
  maxLen = 100_000,
): string | null {
  const val = body[field];
  if (!val || typeof val !== "string" || val.trim().length === 0) return null;
  return val.slice(0, maxLen);
}

// ── Service helpers ─────────────────────────────────────────────────────

function getSwarmsService(runtime: any): SwarmsService | null {
  const svc = runtime.getService("SWARMS" as any) as SwarmsService | null;
  return svc?.isAvailable() ? svc : null;
}

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

// ── Catalog entries ─────────────────────────────────────────────────────

export const SWARM_ROUTE_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "Token Launch Due Diligence",
    description:
      "5-agent concurrent token launch analysis — contract audit, tokenomics, team credibility, market, liquidity — with weighted synthesis and APEWORTHY/PROMISING/CAUTION/HIGH_RISK/RUG_LIKELY verdict (ConcurrentWorkflow + synthesis, 5+1 agents)",
    path: "/swarm/token-diligence",
    method: "POST",
    priceUsd: "0.15",
  },
  {
    name: "DeFi Protocol Risk Score",
    description:
      "5-agent protocol risk assessment — contract security, tokenomics, on-chain activity, governance, historical risk — with AAA-to-D credit-style rating (ConcurrentWorkflow + synthesis, 5+1 agents)",
    path: "/swarm/defi-risk-score",
    method: "POST",
    priceUsd: "0.15",
  },
  {
    name: "Adversarial Fact Check",
    description:
      "4-agent adversarial fact-checking pipeline — claim extraction, evidence gathering, devil's advocate, judge verdict with VERIFIED/LIKELY_TRUE/UNVERIFIED/DISPUTED/FALSE rulings (SequentialWorkflow, 4 agents)",
    path: "/swarm/fact-check",
    method: "POST",
    priceUsd: "0.10",
  },
];

// ── Routes ──────────────────────────────────────────────────────────────

export const swarmRoutes: Route[] = [

  // ══════════════════════════════════════════════════════════════════════
  // POST /swarm/token-diligence — $0.15 (5 agents ConcurrentWorkflow + synthesis)
  // ══════════════════════════════════════════════════════════════════════
  {
    type: "POST",
    path: "/swarm/token-diligence",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.15",
        description: "Token launch due diligence (5+1 agents, ConcurrentWorkflow + synthesis)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const mint: unknown = body.mint;
      if (!mint || typeof mint !== "string") {
        res.status(400).json({ error: "Missing required field: mint (token mint address string)" });
        return;
      }
      if (!SOLANA_ADDR_RE.test(mint)) {
        res.status(400).json({ error: "Invalid mint address format" });
        return;
      }

      // Check cache
      const cached = diligenceCache.get(`diligence:${mint}`);
      if (cached) {
        res.json({
          ...cached,
          payment: {
            amount: "0.15",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
        return;
      }

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");

      // ── Pre-fetch on-chain data via Helius (non-fatal) ──────────────
      let onChainContext = "";
      const heliusKey = String(runtime.getSetting("HELIUS_API_KEY") ?? "");
      if (heliusKey && !isHeliusRateLimited()) {
        try {
          const rpcUrl = heliusRpcUrl(heliusKey);
          const [accountInfo, largestAccounts, tokenSupply, creatorSigs] = await Promise.all([
            rpcCall(rpcUrl, "getAccountInfo", [mint, { encoding: "jsonParsed" }]).catch(() => null),
            rpcCall(rpcUrl, "getTokenLargestAccounts", [mint]).catch(() => null),
            rpcCall(rpcUrl, "getTokenSupply", [mint]).catch(() => null),
            rpcCall(rpcUrl, "getSignaturesForAddress", [mint, { limit: 10 }]).catch(() => null),
          ]);

          const parts: string[] = [];
          if (accountInfo) {
            parts.push(`Account info:\n${JSON.stringify(accountInfo, null, 2).slice(0, 3000)}`);
          }
          if (largestAccounts?.value) {
            parts.push(`Top holders:\n${JSON.stringify(largestAccounts.value.slice(0, 20), null, 2)}`);
          }
          if (tokenSupply?.value) {
            parts.push(`Token supply:\n${JSON.stringify(tokenSupply.value, null, 2)}`);
          }
          if (creatorSigs) {
            const sigs = Array.isArray(creatorSigs) ? creatorSigs : creatorSigs.value ?? [];
            parts.push(`Creator signatures (${sigs.length}):\n${JSON.stringify(sigs.slice(0, 5), null, 2)}`);
          }
          if (parts.length > 0) {
            onChainContext = "\n\n--- ON-CHAIN DATA ---\n" + parts.join("\n\n") + "\n--- END ON-CHAIN DATA ---\n";
          }
        } catch (err) {
          recordHeliusError(err);
          runtime.logger.warn(
            { error: err instanceof Error ? err.message : String(err) },
            "[swarm/token-diligence] Helius lookup failed, proceeding with LLM knowledge only",
          );
        }
      }

      try {
        // Phase 1: 5 concurrent specialist agents
        const phase1Result = await swarmsService.runSwarm({
          name: `token-diligence-${Date.now()}`,
          description: `Token launch due diligence: ${mint}`,
          agents: [
            {
              agent_name: "ContractAuditor",
              system_prompt:
                "You are a smart contract security auditor. Given on-chain token contract data, analyze: " +
                "mint authority status (revoked?), freeze authority, upgrade authority, contract mutability, " +
                "known vulnerability patterns. Score 0-100 (higher = safer). " +
                "Output JSON: { \"contractScore\": <number>, \"findings\": [{\"severity\": \"...\", \"title\": \"...\", \"description\": \"...\"}], " +
                "\"mintAuthorityRevoked\": true|false, \"freezeAuthorityRevoked\": true|false }. " +
                "Only report issues supported by the data. Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.15,
            },
            {
              agent_name: "TokenomicsValidator",
              system_prompt:
                "You are a tokenomics analyst. Analyze: total supply, top holder concentration (top 1, 5, 10), " +
                "liquidity pool presence, distribution fairness. Red flags: top holder >50%, no liquidity pool, " +
                "creator holding >20%. Score 0-100. " +
                "Output JSON: { \"tokenomicsScore\": <number>, \"topHolderPct\": <number|null>, \"top5Pct\": <number|null>, " +
                "\"top10Pct\": <number|null>, \"liquidityFound\": true|false, \"findings\": [\"...\"] }. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
            {
              agent_name: "TeamCredibility",
              system_prompt:
                "You are a team/social credibility analyst for crypto tokens. Evaluate: " +
                "whether creator wallet has history, prior token launches by same creator, " +
                "social media presence indicators, project age. Score 0-100. " +
                "Output JSON: { \"credibilityScore\": <number>, \"creatorHistory\": \"...\", " +
                "\"priorTokens\": <number|null>, \"findings\": [\"...\"] }. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
            {
              agent_name: "MarketAnalyst",
              system_prompt:
                "You are a crypto market analyst. Evaluate token's market positioning: " +
                "comparable tokens, market timing, volume patterns, price action if available. Score 0-100. " +
                "Output JSON: { \"marketScore\": <number>, \"comparableTokens\": [\"...\"], \"findings\": [\"...\"] }. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
            {
              agent_name: "LiquidityAnalyst",
              system_prompt:
                "You are a DeFi liquidity analyst. Evaluate: LP token locks, liquidity depth relative to market cap, " +
                "impermanent loss exposure, DEX listing status. Score 0-100. " +
                "Output JSON: { \"liquidityScore\": <number>, \"lpLocked\": true|false|null, " +
                "\"liquidityDepth\": \"...\", \"findings\": [\"...\"] }. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
          ],
          swarm_type: "ConcurrentWorkflow",
          task:
            `Perform full token launch due diligence on the following Solana token.\nToken mint: ${mint}\n` +
            "Analyze contract security, tokenomics, team credibility, market positioning, and liquidity." +
            onChainContext,
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
              "You are a crypto investment verdict synthesizer. Given 5 specialist reports, produce a final assessment.\n\n" +
              "WEIGHTED SCORING: contract 30%, tokenomics 25%, liquidity 20%, credibility 15%, market 10%.\n\n" +
              "CROSS-CHECKS:\n" +
              "- If contract unsafe (score < 40) AND high concentration (top holder > 50%), add -20 penalty to overall score.\n" +
              "- If no liquidity found AND credibility score < 30, add -15 penalty.\n\n" +
              "VERDICT SCALE:\n" +
              "- APEWORTHY: 80-100\n" +
              "- PROMISING: 60-79\n" +
              "- CAUTION: 40-59\n" +
              "- HIGH_RISK: 20-39\n" +
              "- RUG_LIKELY: 0-19\n\n" +
              "Output JSON:\n" +
              "{\n" +
              '  "overallScore": <0-100>,\n' +
              '  "verdict": "APEWORTHY"|"PROMISING"|"CAUTION"|"HIGH_RISK"|"RUG_LIKELY",\n' +
              '  "dimensions": {\n' +
              '    "contract": { "score": <0-100>, "weight": 30 },\n' +
              '    "tokenomics": { "score": <0-100>, "weight": 25 },\n' +
              '    "liquidity": { "score": <0-100>, "weight": 20 },\n' +
              '    "credibility": { "score": <0-100>, "weight": 15 },\n' +
              '    "market": { "score": <0-100>, "weight": 10 }\n' +
              "  },\n" +
              '  "redFlags": ["..."],\n' +
              '  "greenFlags": ["..."],\n' +
              '  "summary": "...",\n' +
              '  "disclaimer": "Not financial advice"\n' +
              "}\n" +
              "Output ONLY JSON.",
            userPrompt:
              `Synthesize the following 5 specialist analyses into a final token due diligence verdict for mint ${mint}:\n\n${phase1Output}`,
            maxTokens: 8192,
            temperature: 0.25,
          });
        } else {
          // Fallback: use swarms for synthesis too
          const synthResult = await swarmsService.runAgent(
            {
              agent_name: "DiligenceSynthesizer",
              model_name: "gpt-5-mini",
              system_prompt:
                "Synthesize the 5 specialist analyses into a final token due diligence verdict. " +
                "Weighted scoring: contract 30%, tokenomics 25%, liquidity 20%, credibility 15%, market 10%. " +
                "Output JSON with overallScore, verdict, dimensions, redFlags, greenFlags, summary, disclaimer.",
              max_loops: 1,
              max_tokens: 8192,
              temperature: 0.25,
              role: "worker",
            },
            `Synthesize the following 5 specialist analyses into a final token due diligence verdict for mint ${mint}:\n\n${phase1Output}`,
          );
          synthesisOutput = String(synthResult.outputs ?? synthResult);
        }

        const parsed = tryParseJson(synthesisOutput);

        const overallScore = typeof parsed?.overallScore === "number" ? (parsed.overallScore as number) : 50;
        const verdict = (parsed?.verdict as string) ?? scoreToVerdict(overallScore);
        const dimensions = (parsed?.dimensions as Record<string, unknown>) ?? {};
        const redFlags = Array.isArray(parsed?.redFlags) ? (parsed.redFlags as string[]) : [];
        const greenFlags = Array.isArray(parsed?.greenFlags) ? (parsed.greenFlags as string[]) : [];
        const summary = (parsed?.summary as string) ?? synthesisOutput.slice(0, 1000);

        const fullResult = {
          overallScore,
          verdict,
          dimensions,
          redFlags,
          greenFlags,
          summary,
          disclaimer: FINANCIAL_DISCLAIMER,
        };

        // Save report
        const reportId = saveReport({
          type: "token-diligence",
          createdAt: new Date().toISOString(),
          input: { mint },
          result: fullResult,
          riskScore: overallScore,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        // Free tier: show verdict + overallScore + red flag count only
        let responseData: Record<string, unknown>;
        if (gate.amountUsd === 0) {
          responseData = {
            overallScore,
            verdict,
            redFlagCount: redFlags.length,
            disclaimer: FINANCIAL_DISCLAIMER,
            _preview: true,
            _message: `Verdict: ${verdict} (${overallScore}/100). ${redFlags.length} red flag(s). Pay $0.15 to see full report.`,
          };
        } else {
          responseData = fullResult;
        }

        const cacheData = {
          ...responseData,
          ...urls,
          template: "TokenDiligence",
          freeRemaining: gate.freeRemaining,
        };
        diligenceCache.set(`diligence:${mint}`, cacheData);

        res.json({
          ...cacheData,
          payment: {
            amount: "0.15",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        recordHeliusError(err);
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[swarm/token-diligence] Execution failed",
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ══════════════════════════════════════════════════════════════════════
  // POST /swarm/defi-risk-score — $0.15 (5 agents ConcurrentWorkflow + synthesis)
  // ══════════════════════════════════════════════════════════════════════
  {
    type: "POST",
    path: "/swarm/defi-risk-score",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.15",
        description: "DeFi protocol risk assessment (5+1 agents, ConcurrentWorkflow + synthesis)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const protocol = requireString(body, "protocol", 500);
      if (!protocol) {
        res.status(400).json({ error: "Missing required field: protocol (non-empty string, max 500 chars)" });
        return;
      }
      const chain = typeof body.chain === "string" ? body.chain.slice(0, 100) : undefined;
      const context = typeof body.context === "string" ? body.context.slice(0, 5000) : undefined;

      // Check cache
      const cacheKey = `defi-risk:${protocol.toLowerCase().trim()}:${chain ?? "any"}`;
      const cached = defiRiskCache.get(cacheKey);
      if (cached) {
        res.json({
          ...cached,
          payment: {
            amount: "0.15",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
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
          name: `defi-risk-score-${Date.now()}`,
          description: `DeFi risk assessment: ${protocol}${chain ? ` (${chain})` : ""}`,
          agents: [
            {
              agent_name: "ContractSecurityAgent",
              system_prompt:
                "You are a smart contract security auditor for DeFi protocols. " +
                "Audit the protocol's contract security: upgradeability risks, admin keys, proxy patterns, " +
                "audit history (CertiK, Trail of Bits, OpenZeppelin, etc.), known vulnerability patterns, " +
                "immutable vs mutable components, emergency shutdown mechanisms. Score 0-100. " +
                "Output JSON: { \"securityScore\": <number>, \"auditHistory\": [\"...\"], " +
                "\"upgradeability\": \"...\", \"adminKeys\": \"...\", \"findings\": [{\"severity\": \"...\", \"title\": \"...\", \"description\": \"...\"}] }. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.15,
            },
            {
              agent_name: "TokenomicsAgent",
              system_prompt:
                "You are a DeFi protocol tokenomics analyst. " +
                "Analyze protocol token: supply distribution, inflation schedule, staking mechanics, " +
                "governance token utility, emission rate, treasury size, burn mechanisms, " +
                "insider allocation, vesting schedules. Score 0-100. " +
                "Output JSON: { \"tokenomicsScore\": <number>, \"inflationRate\": \"...\", " +
                "\"stakingAPR\": \"...\", \"treasurySize\": \"...\", \"findings\": [\"...\"] }. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
            {
              agent_name: "OnChainActivityAgent",
              system_prompt:
                "You are a DeFi on-chain analytics specialist. " +
                "Analyze TVL trends (growth/decline), user growth rates, transaction volumes, " +
                "whale concentration in protocol, unique user counts, deposit/withdrawal patterns, " +
                "cross-chain deployment status. Score 0-100. " +
                "Output JSON: { \"activityScore\": <number>, \"tvlTrend\": \"...\", " +
                "\"userGrowth\": \"...\", \"whaleConcentration\": \"...\", \"findings\": [\"...\"] }. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.25,
            },
            {
              agent_name: "GovernanceAgent",
              system_prompt:
                "You are a DeFi governance analyst. " +
                "Assess multisig structure (number of signers, threshold), timelock presence and duration, " +
                "governance participation rates, key-person risk, DAO treasury management, " +
                "proposal frequency, voter concentration. Score 0-100. " +
                "Output JSON: { \"governanceScore\": <number>, \"multisig\": \"...\", " +
                "\"timelock\": \"...\", \"participationRate\": \"...\", \"findings\": [\"...\"] }. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
            {
              agent_name: "HistoricalRiskAgent",
              system_prompt:
                "You are a DeFi risk historian. " +
                "Research past exploits, team controversies, similar protocol failures, " +
                "insurance coverage (Nexus Mutual, InsurAce, etc.), regulatory actions, " +
                "chain-specific risks, oracle dependencies, bridge risks. Score 0-100. " +
                "Output JSON: { \"historicalScore\": <number>, \"pastExploits\": [\"...\"], " +
                "\"insuranceCoverage\": \"...\", \"regulatoryRisk\": \"...\", \"findings\": [\"...\"] }. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
          ],
          swarm_type: "ConcurrentWorkflow",
          task:
            `Perform comprehensive DeFi protocol risk assessment for: "${protocol}"` +
            (chain ? ` on ${chain}` : "") +
            ".\nAnalyze contract security, tokenomics, on-chain activity, governance, and historical risk." +
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
              "You are a DeFi protocol risk rating synthesizer. Given 5 specialist reports, " +
              "produce a final credit-style rating for the protocol.\n\n" +
              "WEIGHTED SCORING: contract 25%, tokenomics 20%, on-chain activity 20%, governance 20%, historical 15%.\n\n" +
              "RATING SCALE:\n" +
              "- AAA: 90-100 (extremely safe, blue-chip)\n" +
              "- AA: 80-89 (very safe, established)\n" +
              "- A: 70-79 (safe, well-managed)\n" +
              "- BBB: 60-69 (moderate risk, acceptable)\n" +
              "- BB: 50-59 (elevated risk, caution)\n" +
              "- B: 40-49 (high risk, speculative)\n" +
              "- CCC: 30-39 (very high risk, distressed)\n" +
              "- D: 0-29 (critical risk, avoid)\n\n" +
              "Output JSON:\n" +
              "{\n" +
              `  "protocol": "${protocol}",\n` +
              '  "overallScore": <0-100>,\n' +
              '  "rating": "AAA"|"AA"|"A"|"BBB"|"BB"|"B"|"CCC"|"D",\n' +
              '  "dimensions": {\n' +
              '    "contractSecurity": { "score": <0-100>, "weight": 25, "summary": "..." },\n' +
              '    "tokenomics": { "score": <0-100>, "weight": 20, "summary": "..." },\n' +
              '    "onChainActivity": { "score": <0-100>, "weight": 20, "summary": "..." },\n' +
              '    "governance": { "score": <0-100>, "weight": 20, "summary": "..." },\n' +
              '    "historicalRisk": { "score": <0-100>, "weight": 15, "summary": "..." }\n' +
              "  },\n" +
              '  "keyRisks": ["..."],\n' +
              '  "strengths": ["..."],\n' +
              '  "summary": "...",\n' +
              '  "disclaimer": "Not financial advice"\n' +
              "}\n" +
              "Output ONLY JSON.",
            userPrompt:
              `Synthesize the following 5 specialist analyses into a final DeFi risk rating for "${protocol}"${chain ? ` on ${chain}` : ""}:\n\n${phase1Output}`,
            maxTokens: 8192,
            temperature: 0.25,
          });
        } else {
          // Fallback: use swarms for synthesis too
          const synthResult = await swarmsService.runAgent(
            {
              agent_name: "RiskSynthesizer",
              model_name: "gpt-5-mini",
              system_prompt:
                "Synthesize the 5 specialist analyses into a final DeFi risk rating. " +
                "Weighted scoring: contract 25%, tokenomics 20%, on-chain 20%, governance 20%, historical 15%. " +
                "Output JSON with overallScore, rating (AAA-D), dimensions, keyRisks, strengths, summary, disclaimer.",
              max_loops: 1,
              max_tokens: 8192,
              temperature: 0.25,
              role: "worker",
            },
            `Synthesize the following 5 specialist analyses into a final DeFi risk rating for "${protocol}"${chain ? ` on ${chain}` : ""}:\n\n${phase1Output}`,
          );
          synthesisOutput = String(synthResult.outputs ?? synthResult);
        }

        const parsed = tryParseJson(synthesisOutput);

        const overallScore = typeof parsed?.overallScore === "number" ? (parsed.overallScore as number) : 50;
        const rating = (parsed?.rating as string) ?? scoreToRating(overallScore);
        const dimensions = (parsed?.dimensions as Record<string, unknown>) ?? {};
        const keyRisks = Array.isArray(parsed?.keyRisks) ? (parsed.keyRisks as string[]) : [];
        const strengths = Array.isArray(parsed?.strengths) ? (parsed.strengths as string[]) : [];
        const summary = (parsed?.summary as string) ?? synthesisOutput.slice(0, 1000);

        const fullResult = {
          protocol,
          chain: chain ?? "multi-chain",
          overallScore,
          rating,
          dimensions,
          keyRisks,
          strengths,
          summary,
          disclaimer: FINANCIAL_DISCLAIMER,
        };

        // Save report
        const reportId = saveReport({
          type: "defi-risk-score",
          createdAt: new Date().toISOString(),
          input: { mint: protocol },
          result: fullResult,
          riskScore: overallScore,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        // Free tier: show rating + overall score only
        let responseData: Record<string, unknown>;
        if (gate.amountUsd === 0) {
          responseData = {
            protocol,
            overallScore,
            rating,
            disclaimer: FINANCIAL_DISCLAIMER,
            _preview: true,
            _message: `Rating: ${rating} (${overallScore}/100). Pay $0.15 to see full risk assessment.`,
          };
        } else {
          responseData = fullResult;
        }

        const cacheData = {
          ...responseData,
          ...urls,
          template: "DefiRiskScore",
          freeRemaining: gate.freeRemaining,
        };
        defiRiskCache.set(cacheKey, cacheData);

        res.json({
          ...cacheData,
          payment: {
            amount: "0.15",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[swarm/defi-risk-score] Execution failed",
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ══════════════════════════════════════════════════════════════════════
  // POST /swarm/fact-check — $0.10 (4 agents SequentialWorkflow)
  // ══════════════════════════════════════════════════════════════════════
  {
    type: "POST",
    path: "/swarm/fact-check",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.10",
        description: "Adversarial fact-checking (4 agents, SequentialWorkflow)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const claim = requireString(body, "claim", 5000);
      if (!claim) {
        res.status(400).json({ error: "Missing required field: claim (non-empty string, max 5000 chars)" });
        return;
      }
      const context = typeof body.context === "string" ? body.context.slice(0, 5000) : undefined;

      // NO cache — every claim is unique

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `fact-check-${Date.now()}`,
          description: `Adversarial fact-check: ${claim.slice(0, 100)}`,
          agents: [
            {
              agent_name: "ClaimExtractor",
              system_prompt:
                "You are a claim extraction specialist. Break the input into atomic verifiable claims. " +
                "For each claim, identify what would need to be true for it to be verified. " +
                "Output JSON: { \"claims\": [{\"text\": \"...\", \"verifiableCondition\": \"...\", \"category\": \"...\"}] }. " +
                "Categories: factual, statistical, causal, predictive, opinion, definition. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 2048,
              temperature: 0.2,
            },
            {
              agent_name: "EvidenceGatherer",
              system_prompt:
                "You are a thorough evidence gatherer. For each claim from ClaimExtractor, " +
                "search your knowledge for supporting AND contradicting evidence. Be thorough — " +
                "find counterexamples. Consider multiple perspectives and sources. " +
                "Output JSON: { \"evidence\": [{\"claim\": \"...\", " +
                "\"supporting\": [{\"source\": \"...\", \"detail\": \"...\"}], " +
                "\"contradicting\": [{\"source\": \"...\", \"detail\": \"...\"}]}] }. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.4,
            },
            {
              agent_name: "DevilsAdvocate",
              system_prompt:
                "Your job is to DISPROVE each claim. Find the strongest possible counterarguments. " +
                "Play devil's advocate aggressively. If a claim is actually true, acknowledge it — but push hard. " +
                "Consider logical fallacies, missing context, outdated information, selection bias, " +
                "and alternative explanations. " +
                "Output JSON: { \"challenges\": [{\"claim\": \"...\", \"counterargument\": \"...\", " +
                "\"strength\": \"weak\"|\"moderate\"|\"strong\"|\"devastating\"}] }. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.5,
            },
            {
              agent_name: "Judge",
              system_prompt:
                "You are the final arbiter. Given evidence from both sides (EvidenceGatherer and DevilsAdvocate), " +
                "rule on each claim. Be fair and impartial. " +
                "Verdicts: VERIFIED (strong evidence, weak counter), LIKELY_TRUE (moderate evidence), " +
                "UNVERIFIED (insufficient evidence), DISPUTED (strong counter), FALSE (devastating counter). " +
                "Output JSON: { \"verdicts\": [{\"claim\": \"...\", \"verdict\": \"...\", " +
                "\"confidence\": <0-1>, \"reasoning\": \"...\"}], \"overallVeracity\": <0-100> }. " +
                "overallVeracity: weighted average of claim confidences, adjusted for verdict severity. " +
                "Output ONLY JSON.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
          ],
          swarm_type: "SequentialWorkflow",
          task:
            `Fact-check the following claim:\n\n"${claim}"` +
            (context ? `\n\nAdditional context: ${context}` : ""),
          max_loops: 1,
          rules:
            "ClaimExtractor breaks down the claim first, EvidenceGatherer finds supporting and contradicting evidence, " +
            "DevilsAdvocate challenges each claim aggressively, then Judge makes the final ruling.",
        });

        const rawOutput = extractSwarmOutput(result);
        const parsed = tryParseJson(rawOutput);

        const verdicts = Array.isArray(parsed?.verdicts) ? (parsed.verdicts as any[]) : [];
        const overallVeracity = typeof parsed?.overallVeracity === "number" ? (parsed.overallVeracity as number) : 50;

        // Count verdicts by type
        const verdictCounts: Record<string, number> = {};
        for (const v of verdicts) {
          const vType = typeof v?.verdict === "string" ? v.verdict : "UNVERIFIED";
          verdictCounts[vType] = (verdictCounts[vType] ?? 0) + 1;
        }

        const fullResult = {
          claim,
          verdicts,
          overallVeracity,
          verdictCounts,
          totalClaims: verdicts.length,
        };

        // Save report
        const reportId = saveReport({
          type: "fact-check",
          createdAt: new Date().toISOString(),
          input: { code: claim },
          result: fullResult,
          riskScore: overallVeracity,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        // Free tier: show overall veracity score + verdict count only
        let responseData: Record<string, unknown>;
        if (gate.amountUsd === 0) {
          responseData = {
            overallVeracity,
            verdictCounts,
            totalClaims: verdicts.length,
            _preview: true,
            _message: `Veracity: ${overallVeracity}/100. ${verdicts.length} claim(s) analyzed. Pay $0.10 to see full breakdown.`,
          };
        } else {
          responseData = fullResult;
        }

        res.json({
          ...responseData,
          ...urls,
          template: "FactCheck",
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
          "[swarm/fact-check] Execution failed",
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },
];

// ── Helper: score to verdict mapping ──────────────────────────────────

function scoreToVerdict(score: number): string {
  if (score >= 80) return "APEWORTHY";
  if (score >= 60) return "PROMISING";
  if (score >= 40) return "CAUTION";
  if (score >= 20) return "HIGH_RISK";
  return "RUG_LIKELY";
}

// ── Helper: score to rating mapping ───────────────────────────────────

function scoreToRating(score: number): string {
  if (score >= 90) return "AAA";
  if (score >= 80) return "AA";
  if (score >= 70) return "A";
  if (score >= 60) return "BBB";
  if (score >= 50) return "BB";
  if (score >= 40) return "B";
  if (score >= 30) return "CCC";
  return "D";
}
