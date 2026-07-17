import type { Route } from "@elizaos/core";
import { x402Gate } from "../server/x402Gate.js";
import type { X402GateResult } from "../server/x402Gate.js";
import { SwarmsService } from "../services/swarmsService.js";
import type { X402ServiceEndpoint } from "../types.js";
import { SOLANA_ADDR_RE, heliusRpcUrl, rpcCall } from "./heliusDataRoutes.js";
import { callOpenAI } from "../utils/llm.js";
import { TTLCache } from "../utils/cache.js";
import { saveReport } from "../utils/reportStore.js";

// ── Signature regex (base58, 64-88 chars) ──────────────────────────────
const SOLANA_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

// ── Caches ─────────────────────────────────────────────────────────────
const txExplainerCache = new TTLCache<any>(5 * 60_000); // 5 min
const memecoinScoreCache = new TTLCache<any>(60_000);    // 60 s
const walletRiskCache = new TTLCache<any>(30_000);       // 30 s
const heliusErrorCache = new TTLCache<string>(60_000);   // 60 s rate limit cooldown

function isHeliusRateLimited(): boolean {
  return !!heliusErrorCache.get("helius:rate-limit");
}

function recordHeliusError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (/rate.limit|429|max.usage|too.many/i.test(msg)) {
    heliusErrorCache.set("helius:rate-limit", msg);
  }
}

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

// ── Swarm output extractor ─────────────────────────────────────────────
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
export const CRYPTO_ANALYSIS_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "Transaction Explainer",
    description:
      "Explain any Solana transaction in plain English — type classification, participants, tokens involved, and summary",
    path: "/x402/tx-explainer",
    method: "POST",
    priceUsd: "0.03",
  },
  {
    name: "Memecoin Score",
    description:
      "Multi-agent memecoin risk scoring — contract authority checks, holder concentration, and SAFE/CAUTION/DANGER/SCAM verdict (SequentialWorkflow, 3 agents)",
    path: "/x402/memecoin-score",
    method: "POST",
    priceUsd: "0.05",
  },
  {
    name: "Wallet Risk Score",
    description:
      "Multi-agent wallet risk assessment — transaction pattern analysis and risk level scoring (SequentialWorkflow, 2 agents)",
    path: "/x402/wallet-risk-score",
    method: "POST",
    priceUsd: "0.05",
  },
];

// ── Free tier placeholder ──────────────────────────────────────────────
const FREE_TIER_PLACEHOLDER = "[Connect wallet to see full details]";

// ── Routes ─────────────────────────────────────────────────────────────
export const cryptoAnalysisRoutes: Route[] = [
  // ── POST /x402/tx-explainer — $0.03 ──────────────────────────────────
  {
    type: "POST",
    path: "/x402/tx-explainer",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.03",
        description: "Solana transaction explainer — plain English analysis of any transaction",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const signature: unknown = body.signature;
      if (!signature || typeof signature !== "string") {
        res.status(400).json({ error: "Missing required field: signature (transaction signature string)" });
        return;
      }
      if (!SOLANA_SIG_RE.test(signature)) {
        res.status(400).json({ error: "Invalid transaction signature format" });
        return;
      }

      // Check cache
      const cached = txExplainerCache.get(`tx-explain:${signature}`);
      if (cached) {
        res.json({
          ...cached,
          payment: {
            amount: "0.03",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
        return;
      }

      const heliusKey = runtime.getSetting("HELIUS_API_KEY");
      const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");

      if (!heliusKey) {
        res.status(503).json({ error: "HELIUS_API_KEY not configured" });
        return;
      }

      if (isHeliusRateLimited()) {
        res.status(503).json({ error: "Helius RPC rate limited — try again in a few minutes" });
        return;
      }

      try {
        const rpcUrl = heliusRpcUrl(String(heliusKey));
        const tx = await rpcCall(rpcUrl, "getTransaction", [
          signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ]);

        if (!tx) {
          res.status(404).json({ error: "Transaction not found" });
          return;
        }

        const systemPrompt =
          "You are a Solana blockchain transaction analyst. Explain transactions in plain English. " +
          "Given a parsed transaction, produce JSON: " +
          '{ "type": "<swap|transfer|nft-mint|nft-sale|stake|unstake|program-interaction|unknown>", ' +
          '"explanation": "<2-4 sentences>", ' +
          '"participants": [{"address": "...", "role": "..."}], ' +
          '"tokensInvolved": [{"mint": "...", "amount": "...", "direction": "..."}], ' +
          '"summary": "<1 sentence>" }. ' +
          "Analyze ONLY data provided. Do NOT fabricate. SOL amounts in lamports (1 SOL = 1B lamports). " +
          "Output ONLY JSON.";

        const userPrompt = `Explain this Solana transaction:\n\n${JSON.stringify(tx, null, 2).slice(0, 8000)}`;

        let raw: string;
        if (openaiKey) {
          raw = await callOpenAI({
            apiKey: openaiKey,
            model: "gpt-5-mini",
            systemPrompt,
            userPrompt,
            maxTokens: 2048,
            temperature: 0.2,
          });
        } else {
          // Fallback: Swarms API
          const swarmsService = getSwarmsService(runtime);
          if (!swarmsService) {
            res.status(503).json({ error: "Neither OPENAI_API_KEY nor Swarms service available" });
            return;
          }
          const result = await swarmsService.runAgent(
            {
              agent_name: "TxExplainer",
              model_name: "gpt-5-mini",
              system_prompt: systemPrompt,
              max_loops: 1,
              max_tokens: 2048,
              temperature: 0.2,
              role: "worker" as const,
            },
            userPrompt
          );
          raw = String(result.outputs ?? result);
        }

        const parsed = tryParseJson(raw);
        const explanation = parsed ?? {
          type: "unknown",
          explanation: raw.slice(0, 500),
          participants: [],
          tokensInvolved: [],
          summary: raw.slice(0, 200),
        };

        // Free tier: show type + summary only
        let responseData: Record<string, unknown>;
        if (gate.amountUsd === 0) {
          responseData = {
            type: (explanation as any).type ?? "unknown",
            summary: (explanation as any).summary ?? FREE_TIER_PLACEHOLDER,
            _preview: true,
            _message: `Type: ${(explanation as any).type ?? "unknown"}. Pay $0.03 to see full explanation.`,
          };
        } else {
          responseData = explanation as Record<string, unknown>;
        }

        // Save report
        const reportId = saveReport({
          type: "token-risk" as any, // closest available type
          createdAt: new Date().toISOString(),
          input: { mint: signature },
          result: explanation,
          riskScore: null,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        const cacheData = {
          ...responseData,
          ...urls,
          template: "TxExplainer",
          freeRemaining: gate.freeRemaining,
        };
        txExplainerCache.set(`tx-explain:${signature}`, cacheData);

        res.json({
          ...cacheData,
          payment: {
            amount: "0.03",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        recordHeliusError(err);
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/tx-explainer] Execution failed"
        );
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimit = /rate.limit|429|max.usage|too.many/i.test(msg);
        res.status(503).json({
          error: isRateLimit
            ? "Helius RPC rate limited — try again in a few minutes"
            : "Service temporarily unavailable",
        });
      }
    },
  },

  // ── POST /x402/memecoin-score — $0.05 ────────────────────────────────
  {
    type: "POST",
    path: "/x402/memecoin-score",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.05",
        description: "Multi-agent memecoin risk scoring (3 agents, SequentialWorkflow)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const mint: unknown = body.mint;
      if (!mint || typeof mint !== "string") {
        res.status(400).json({ error: "Missing required field: mint (SPL token mint address)" });
        return;
      }
      if (!SOLANA_ADDR_RE.test(mint)) {
        res.status(400).json({ error: "Invalid mint address format" });
        return;
      }

      // Check cache
      const cached = memecoinScoreCache.get(`memecoin:${mint}`);
      if (cached) {
        res.json({
          ...cached,
          payment: {
            amount: "0.05",
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

      // ── Pre-fetch on-chain data via Helius (non-fatal) ────────────────
      let onChainContext = "";
      const heliusKey = String(runtime.getSetting("HELIUS_API_KEY") ?? "");
      if (heliusKey && !isHeliusRateLimited()) {
        try {
          const rpcUrl = heliusRpcUrl(heliusKey);
          const [accountInfo, largestAccounts, tokenSupply] = await Promise.all([
            rpcCall(rpcUrl, "getAccountInfo", [mint, { encoding: "jsonParsed" }]).catch(() => null),
            rpcCall(rpcUrl, "getTokenLargestAccounts", [mint]).catch(() => null),
            rpcCall(rpcUrl, "getTokenSupply", [mint]).catch(() => null),
          ]);

          const parts: string[] = [];
          if (accountInfo) {
            parts.push(`Account info:\n${JSON.stringify(accountInfo, null, 2).slice(0, 2000)}`);
          }
          if (largestAccounts?.value) {
            parts.push(`Top holders:\n${JSON.stringify(largestAccounts.value.slice(0, 10), null, 2)}`);
          }
          if (tokenSupply?.value) {
            parts.push(`Token supply:\n${JSON.stringify(tokenSupply.value, null, 2)}`);
          }
          if (parts.length > 0) {
            onChainContext = "\n\n--- ON-CHAIN DATA ---\n" + parts.join("\n\n") + "\n--- END ON-CHAIN DATA ---\n";
          }
        } catch (err) {
          runtime.logger.warn(
            { error: err instanceof Error ? err.message : String(err) },
            "[x402/memecoin-score] Helius lookup failed, proceeding with LLM knowledge only"
          );
        }
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `memecoin-score-${Date.now()}`,
          description: `Memecoin risk scoring: ${mint}`,
          agents: [
            {
              agent_name: "ContractScanner",
              system_prompt:
                "You are a Solana smart contract scanner specializing in memecoin risk detection.\n\n" +
                "Analyze the token's contract properties:\n" +
                "- Mint authority: can new tokens be minted? (active/renounced)\n" +
                "- Freeze authority: can transfers be frozen? (active/renounced)\n" +
                "- Mutability: can token metadata be changed?\n" +
                "- Honeypot patterns: can tokens actually be sold?\n" +
                "- Hidden fee mechanisms\n" +
                "- Admin backdoors without timelocks\n\n" +
                "Output ONLY a JSON object:\n" +
                "{\n" +
                '  "contractRiskScore": <0-100>,\n' +
                '  "mintAuthority": "active|renounced|unknown",\n' +
                '  "freezeAuthority": "active|renounced|unknown",\n' +
                '  "mutable": true|false,\n' +
                '  "findings": [{"severity": "...", "title": "...", "description": "..."}]\n' +
                "}\n" +
                "Output ONLY JSON — no markdown fences.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
            {
              agent_name: "TokenomicsAnalyst",
              system_prompt:
                "You are a tokenomics analyst specializing in memecoin holder distribution analysis.\n\n" +
                "Analyze holder concentration and distribution:\n" +
                "- Top holder percentage (whale risk)\n" +
                "- Developer/team wallet holdings\n" +
                "- Liquidity pool token distribution\n" +
                "- Insider allocation patterns\n" +
                "- Wash trading indicators\n" +
                "- Supply distribution fairness\n\n" +
                "Output ONLY a JSON object:\n" +
                "{\n" +
                '  "tokenomicsRiskScore": <0-100>,\n' +
                '  "topHolderPct": "<percentage or unknown>",\n' +
                '  "liquidityLocked": "yes|no|unknown",\n' +
                '  "findings": [{"severity": "...", "title": "...", "description": "..."}]\n' +
                "}\n" +
                "Output ONLY JSON — no markdown fences.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
            },
            {
              agent_name: "RiskSynthesizer",
              system_prompt:
                "You are a memecoin risk judge. Combine ContractScanner and TokenomicsAnalyst findings into a final score.\n\n" +
                "Output ONLY a JSON object:\n" +
                "{\n" +
                '  "score": <0-100>,\n' +
                '  "verdict": "SAFE"|"CAUTION"|"DANGER"|"SCAM",\n' +
                '  "contract": { "mintAuthority": "...", "freezeAuthority": "...", "riskScore": <0-100> },\n' +
                '  "tokenomics": { "topHolderPct": "...", "riskScore": <0-100> },\n' +
                '  "redFlags": ["..."],\n' +
                '  "summary": "<1-2 sentence non-technical summary>"\n' +
                "}\n\n" +
                "Scoring: 0-25 SAFE, 26-50 CAUTION, 51-75 DANGER, 76-100 SCAM.\n" +
                "Only report REAL issues. Output ONLY JSON — no markdown fences.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
          ],
          swarm_type: "SequentialWorkflow",
          task:
            `Assess the risk of the following Solana memecoin.\nToken mint: ${mint}\n` +
            "Analyze contract authorities, holder concentration, and produce a final risk verdict." +
            onChainContext,
          max_loops: 1,
          rules:
            "ContractScanner checks authorities first, TokenomicsAnalyst evaluates distribution, then RiskSynthesizer combines both into a final score and verdict.",
        });

        const rawOutput = extractSwarmOutput(result);
        const parsed = tryParseJson(rawOutput);

        // Normalize the result
        const score = typeof parsed?.score === "number" ? (parsed.score as number) : 50;
        const verdict = typeof parsed?.verdict === "string" ? (parsed.verdict as string) : "CAUTION";
        const contract = (parsed?.contract as any) ?? {};
        const tokenomics = (parsed?.tokenomics as any) ?? {};
        const redFlags = Array.isArray(parsed?.redFlags) ? (parsed.redFlags as string[]) : [];
        const summary = typeof parsed?.summary === "string" ? (parsed.summary as string) : rawOutput.slice(0, 500);

        const fullResult = { score, verdict, contract, tokenomics, redFlags, summary };

        // Free tier: show score + verdict + redFlag count only
        let responseData: Record<string, unknown>;
        if (gate.amountUsd === 0) {
          responseData = {
            score,
            verdict,
            redFlagCount: redFlags.length,
            _preview: true,
            _message: `Verdict: ${verdict} (${score}/100). ${redFlags.length} red flags found. Pay $0.05 to see full details.`,
          };
        } else {
          responseData = fullResult;
        }

        // Save report
        const reportId = saveReport({
          type: "token-risk" as any,
          createdAt: new Date().toISOString(),
          input: { mint },
          result: fullResult,
          riskScore: score,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        const cacheData = {
          ...responseData,
          ...urls,
          template: "MemecoinScore",
          freeRemaining: gate.freeRemaining,
        };
        memecoinScoreCache.set(`memecoin:${mint}`, cacheData);

        res.json({
          ...cacheData,
          payment: {
            amount: "0.05",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        recordHeliusError(err);
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/memecoin-score] Swarm execution failed"
        );
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimit = /rate.limit|429|max.usage|too.many/i.test(msg);
        res.status(503).json({
          error: isRateLimit
            ? "Helius RPC rate limited — try again in a few minutes"
            : "Service temporarily unavailable",
        });
      }
    },
  },

  // ── POST /x402/wallet-risk-score — $0.05 ─────────────────────────────
  {
    type: "POST",
    path: "/x402/wallet-risk-score",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.05",
        description: "Multi-agent wallet risk assessment (2 agents, SequentialWorkflow)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const address: unknown = body.address;
      if (!address || typeof address !== "string") {
        res.status(400).json({ error: "Missing required field: address (Solana wallet address)" });
        return;
      }
      if (!SOLANA_ADDR_RE.test(address)) {
        res.status(400).json({ error: "Invalid Solana address format" });
        return;
      }

      // Check cache
      const cached = walletRiskCache.get(`wallet-risk:${address}`);
      if (cached) {
        res.json({
          ...cached,
          payment: {
            amount: "0.05",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
        return;
      }

      // HARD REQUIREMENT: Helius must be available
      const heliusKey = runtime.getSetting("HELIUS_API_KEY");
      if (!heliusKey) {
        res.status(503).json({ error: "HELIUS_API_KEY not configured" });
        return;
      }

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      // ── Pre-fetch on-chain data ───────────────────────────────────────
      let onChainContext = "";
      try {
        const rpcUrl = heliusRpcUrl(String(heliusKey));

        const [balance, signatures] = await Promise.all([
          rpcCall(rpcUrl, "getBalance", [address]),
          rpcCall(rpcUrl, "getSignaturesForAddress", [address, { limit: 20 }]),
        ]);

        const parts: string[] = [];
        parts.push(`Balance: ${JSON.stringify(balance)}`);

        const sigs: Array<{ signature: string }> = signatures ?? [];
        parts.push(`Recent signatures (${sigs.length}):\n${JSON.stringify(sigs.slice(0, 5), null, 2)}`);

        // Fetch top 5 transactions
        const topSigs = sigs.slice(0, 5);
        const txDetails = await Promise.all(
          topSigs.map(async (sig, idx) => {
            try {
              return await rpcCall(
                rpcUrl,
                "getTransaction",
                [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
                10 + idx
              );
            } catch {
              return null;
            }
          })
        );

        const validTxs = txDetails.filter(Boolean);
        if (validTxs.length > 0) {
          parts.push(`Transaction details (${validTxs.length}):\n${JSON.stringify(validTxs, null, 2).slice(0, 6000)}`);
        }

        onChainContext = "\n\n--- ON-CHAIN DATA ---\n" + parts.join("\n\n") + "\n--- END ON-CHAIN DATA ---\n";
      } catch (err) {
        // HARD REQUIREMENT: If Helius unavailable, return 503
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/wallet-risk-score] Helius RPC failed"
        );
        res.status(503).json({ error: "Helius RPC unavailable" });
        return;
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `wallet-risk-${Date.now()}`,
          description: `Wallet risk assessment: ${address}`,
          agents: [
            {
              agent_name: "TransactionAnalyzer",
              system_prompt:
                "You are a blockchain forensic analyst specializing in Solana wallet activity pattern detection.\n\n" +
                "Categorize the wallet's activity patterns:\n" +
                "- Transaction frequency and timing patterns\n" +
                "- Interaction with known scam/exploit contracts\n" +
                "- Wash trading indicators\n" +
                "- Sybil attack patterns (many small wallets funding one)\n" +
                "- MEV bot behavior (sandwich attacks, frontrunning)\n" +
                "- Mixer/tumbler usage\n" +
                "- Rapid token cycling (pump and dump participation)\n" +
                "- Airdrop farming patterns\n\n" +
                "Output ONLY a JSON object:\n" +
                "{\n" +
                '  "patternRiskScore": <0-100>,\n' +
                '  "patterns": [{"type": "...", "description": "...", "riskLevel": "low|moderate|elevated|high|critical"}],\n' +
                '  "txCount": <number>,\n' +
                '  "dominantActivity": "<description>"\n' +
                "}\n" +
                "Output ONLY JSON — no markdown fences.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
            {
              agent_name: "RiskScorer",
              system_prompt:
                "You are a crypto compliance risk scorer. Combine TransactionAnalyzer findings into a final risk assessment.\n\n" +
                "Output ONLY a JSON object:\n" +
                "{\n" +
                '  "riskScore": <0-100>,\n' +
                '  "riskLevel": "low"|"moderate"|"elevated"|"high"|"critical",\n' +
                '  "patterns": [{"type": "...", "description": "...", "riskLevel": "..."}],\n' +
                '  "flags": ["..."],\n' +
                '  "summary": "<1-2 sentence non-technical summary>"\n' +
                "}\n\n" +
                "Risk scoring: 0-20 low, 21-40 moderate, 41-60 elevated, 61-80 high, 81-100 critical.\n" +
                "Only report REAL patterns found in the data. Output ONLY JSON — no markdown fences.",
              model_name: "gpt-5-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.2,
            },
          ],
          swarm_type: "SequentialWorkflow",
          task:
            `Assess the risk profile of the following Solana wallet.\nWallet address: ${address}\n` +
            "Analyze transaction patterns and produce a final risk score." +
            onChainContext,
          max_loops: 1,
          rules:
            "TransactionAnalyzer categorizes activity patterns first, then RiskScorer produces the final risk assessment.",
        });

        const rawOutput = extractSwarmOutput(result);
        const parsed = tryParseJson(rawOutput);

        // Normalize the result
        const riskScore = typeof parsed?.riskScore === "number" ? (parsed.riskScore as number) : 50;
        const riskLevel = typeof parsed?.riskLevel === "string" ? (parsed.riskLevel as string) : "moderate";
        const patterns = Array.isArray(parsed?.patterns) ? (parsed.patterns as any[]) : [];
        const flags = Array.isArray(parsed?.flags) ? (parsed.flags as string[]) : [];
        const summary = typeof parsed?.summary === "string" ? (parsed.summary as string) : rawOutput.slice(0, 500);

        const fullResult = { riskScore, riskLevel, patterns, flags, summary };

        // Free tier: show riskScore + riskLevel only
        let responseData: Record<string, unknown>;
        if (gate.amountUsd === 0) {
          responseData = {
            riskScore,
            riskLevel,
            _preview: true,
            _message: `Risk: ${riskLevel} (${riskScore}/100). Pay $0.05 to see full details.`,
          };
        } else {
          responseData = fullResult;
        }

        // Save report
        const reportId = saveReport({
          type: "token-risk" as any,
          createdAt: new Date().toISOString(),
          input: { mint: address },
          result: fullResult,
          riskScore,
          paid: gate.amountUsd > 0,
        });
        const urls = reportUrls(reportId);

        const cacheData = {
          ...responseData,
          ...urls,
          template: "WalletRiskScore",
          freeRemaining: gate.freeRemaining,
        };
        walletRiskCache.set(`wallet-risk:${address}`, cacheData);

        res.json({
          ...cacheData,
          payment: {
            amount: "0.05",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        recordHeliusError(err);
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/wallet-risk-score] Swarm execution failed"
        );
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimit = /rate.limit|429|max.usage|too.many/i.test(msg);
        res.status(503).json({
          error: isRateLimit
            ? "Helius RPC rate limited — try again in a few minutes"
            : "Service temporarily unavailable",
        });
      }
    },
  },
];
