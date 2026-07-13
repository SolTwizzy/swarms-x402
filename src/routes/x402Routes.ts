import type { Route } from "@elizaos/core";
import { x402Gate, getFreeTierStats } from "../server/x402Gate.js";
import type { X402GateResult } from "../server/x402Gate.js";
import { X402ServerService } from "../server/x402ServerService.js";
import { SwarmsService } from "../services/swarmsService.js";
import {
  researchPipelineTemplate,
  analysisPanelTemplate,
} from "../templates/swarmTemplates.js";
import type { X402ServiceEndpoint, X402RevenueRecord } from "../types.js";
import { TASK_CATALOG } from "./taskRoutes.js";
import { TRADING_CATALOG } from "./tradingRoutes.js";
import { CRYPTO_CATALOG } from "./cryptoRoutes.js";
import { BATCH_CATALOG } from "./batchRoutes.js";
import { CODE_AUDIT_CATALOG } from "./codeAuditRoutes.js";
import { CONTENT_CATALOG } from "./contentRoutes.js";
import { ADVANCED_CATALOG } from "./advancedRoutes.js";
import { CRYPTO_ANALYSIS_CATALOG } from "./cryptoAnalysisRoutes.js";
import { SWARM_ROUTE_CATALOG } from "./swarmRoutes.js";
import { SWARM_PREMIUM_CATALOG } from "./swarmPremiumRoutes.js";
import { RWA_CATALOG } from "./rwaRoutes.js";
import { callOpenAI } from "../utils/llm.js";
import { taskQueue } from "../utils/taskQueue.js";

// ── Free tier output truncation for multi-agent endpoints ───────────────
// Free calls get a preview; paid calls get full output.

const FREE_TIER_TRUNCATE_MSG = "[Connect wallet to see full output]";
const FREE_TIER_PREVIEW_CHARS = 300;

/**
 * For multi-agent endpoints (research, analyze, agent): truncate output for free tier.
 * Returns the full text if paid, or a preview + CTA if free.
 */
function truncateOutputForFreeTier(text: string, gate: X402GateResult, priceUsd: string): string | Record<string, unknown> {
  if (gate.amountUsd > 0) return text; // paid — full output
  const preview = text.slice(0, FREE_TIER_PREVIEW_CHARS);
  const suffix = text.length > FREE_TIER_PREVIEW_CHARS ? "..." : "";
  return {
    preview: preview + suffix,
    _preview: true,
    _message: `Output truncated. Pay $${priceUsd} to see the full result.`,
    _fullLength: text.length,
  };
}

/**
 * Catalog of all x402 endpoints (used by /x402/catalog).
 */
const SERVICE_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "SwarmX Research Pipeline",
    description:
      "Multi-agent research: Researcher, FactChecker, and Writer produce a verified report on any topic",
    path: "/x402/research",
    method: "POST",
    priceUsd: "0.05",
  },
  {
    name: "SwarmX Analysis Panel",
    description:
      "Multi-perspective analysis: Technical, Economic, and Risk experts synthesize an assessment",
    path: "/x402/analyze",
    method: "POST",
    priceUsd: "0.03",
  },
  {
    name: "SwarmX Single Agent",
    description:
      "Run a single AI agent with custom task, model, and system prompt",
    path: "/x402/agent",
    method: "POST",
    priceUsd: "0.02",
  },
  {
    name: "SwarmX Solana Wallet Analyzer",
    description:
      "Analyze any Solana wallet — SOL balance, token holdings with USD values, NFTs, recent transactions",
    path: "/x402/wallet-analyzer",
    method: "POST",
    priceUsd: "0.01",
  },
  {
    name: "SwarmX Token Holders",
    description:
      "Get top holders for any SPL token — amounts, percentages, concentration analysis",
    path: "/x402/token-holders",
    method: "POST",
    priceUsd: "0.01",
  },
  {
    name: "SwarmX Transaction History",
    description:
      "Get recent transaction history for any Solana address — signatures, types, timestamps",
    path: "/x402/tx-history",
    method: "POST",
    priceUsd: "0.01",
  },
  {
    name: "SwarmX DeFi Positions",
    description:
      "Scan a Solana wallet for DeFi positions — Marinade, Jito, Raydium LP tokens and more",
    path: "/x402/defi-positions",
    method: "POST",
    priceUsd: "0.02",
  },
  {
    name: "SwarmX Wallet Report Bundle",
    description:
      "Full wallet report — SOL balance, token holdings, top-token holder concentration, and DeFi positions in one call",
    path: "/x402/wallet-report",
    method: "POST",
    priceUsd: "0.03",
  },
  ...TASK_CATALOG,
  ...TRADING_CATALOG,
  ...CRYPTO_CATALOG,
  ...CODE_AUDIT_CATALOG,
  ...CONTENT_CATALOG,
  ...BATCH_CATALOG,
  ...ADVANCED_CATALOG,
  ...CRYPTO_ANALYSIS_CATALOG,
  ...SWARM_ROUTE_CATALOG,
  ...SWARM_PREMIUM_CATALOG,
  ...RWA_CATALOG,
  {
    name: "SwarmX Service Catalog",
    description: "List all available SwarmX paid endpoints with pricing",
    path: "/x402/catalog",
    method: "GET",
    priceUsd: "0.00",
    free: true,
  },
  {
    name: "SwarmX Health Check",
    description: "SwarmX service health, revenue stats, and network info",
    path: "/x402/health",
    method: "GET",
    priceUsd: "0.00",
    free: true,
  },
  {
    name: "SwarmX Revenue Dashboard",
    description:
      "Detailed revenue breakdown — totals, time-period stats, top buyers, conversion rate",
    path: "/x402/revenue",
    method: "GET",
    priceUsd: "0.00",
    free: true,
  },
  {
    name: "SwarmX Async Task Submit",
    description:
      "Submit a long-running task for async execution, get a task ID to poll for results",
    path: "/x402/async",
    method: "POST",
    priceUsd: "0.00",
    free: true,
  },
  {
    name: "SwarmX Task Status",
    description: "Poll the status and result of an async task by ID",
    path: "/x402/task/:id",
    method: "GET",
    priceUsd: "0.00",
    free: true,
  },
];

/**
 * x402 paid routes for selling agent capabilities.
 *
 * Paid routes use x402Gate to require USDC payment before processing.
 * Free routes (catalog, health) are publicly accessible.
 */
export const x402Routes: Route[] = [
  // ── POST /x402/research — $0.05 ──────────────────────────────────
  {
    type: "POST",
    path: "/x402/research",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.05",
        description: "Multi-agent research pipeline",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const query = body.query;
      if (!query || typeof query !== "string") {
        res.status(400).json({ error: "Missing required field: query" });
        return;
      }
      const depth = body.depth ?? "standard";

      const swarmsService = runtime.getService<SwarmsService>("SWARMS" as any);
      if (!swarmsService?.isAvailable()) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `research-${Date.now()}`,
          description: `Research: ${query}`,
          agents: researchPipelineTemplate.agents,
          swarm_type: researchPipelineTemplate.swarmType as any,
          task: `Research the following topic (depth: ${depth}): ${query}`,
          max_loops: researchPipelineTemplate.maxLoops ?? 1,
          rules: researchPipelineTemplate.rules,
        });

        const rawResult = String(result.output ?? result);
        const output = truncateOutputForFreeTier(rawResult, gate, "0.05");

        res.json({
          result: output,
          template: "ResearchPipeline",
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
          "[x402/research] Swarm execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/analyze — $0.03 ───────────────────────────────────
  {
    type: "POST",
    path: "/x402/analyze",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.03",
        description: "Multi-perspective analysis panel",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const text = body.text;
      if (!text || typeof text !== "string") {
        res.status(400).json({ error: "Missing required field: text" });
        return;
      }
      const analysisType = body.type ?? "comprehensive";

      const swarmsService = runtime.getService<SwarmsService>("SWARMS" as any);
      if (!swarmsService?.isAvailable()) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `analysis-${Date.now()}`,
          description: `Analysis: ${text.slice(0, 100)}`,
          agents: analysisPanelTemplate.agents,
          swarm_type: analysisPanelTemplate.swarmType as any,
          task: `Perform a ${analysisType} analysis of the following: ${text}`,
          max_loops: analysisPanelTemplate.maxLoops ?? 1,
        });

        const rawResult = String(result.output ?? result);
        const output = truncateOutputForFreeTier(rawResult, gate, "0.03");

        res.json({
          result: output,
          template: "AnalysisPanel",
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
          "[x402/analyze] Swarm execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/agent — $0.02 ─────────────────────────────────────
  {
    type: "POST",
    path: "/x402/agent",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.02",
        description: "Single agent execution",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const task = body.task;
      if (!task || typeof task !== "string") {
        res.status(400).json({ error: "Missing required field: task" });
        return;
      }

      const systemPrompt: string =
        typeof body.systemPrompt === "string"
          ? body.systemPrompt
          : "You are a helpful AI agent. Complete the given task thoroughly and concisely.";
      const model: string = typeof body.model === "string" ? body.model : "gpt-4o-mini";

      try {
        let output: string;
        const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");

        if (openaiKey) {
          // Direct OpenAI — single agent, no Swarms overhead
          output = await callOpenAI({
            apiKey: openaiKey,
            model,
            systemPrompt,
            userPrompt: task,
            maxTokens: 4096,
            temperature: 0.5,
          });
        } else {
          // Fallback: Swarms API
          const swarmsService = runtime.getService<SwarmsService>("SWARMS" as any);
          if (!swarmsService?.isAvailable()) {
            res.status(503).json({ error: "Neither OPENAI_API_KEY nor Swarms service available" });
            return;
          }
          const result = await swarmsService.runAgent(
            {
              agent_name: body.agentName ?? "x402-agent",
              model_name: model,
              system_prompt: systemPrompt,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.5,
              role: "worker",
            },
            task
          );
          output = String(result.outputs ?? result);
        }

        const truncated = truncateOutputForFreeTier(output, gate, "0.02");

        res.json({
          result: truncated,
          freeRemaining: gate.freeRemaining,
          payment: {
            amount: "0.02",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/agent] Agent execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── GET /x402/catalog — FREE ─────────────────────────────────────
  {
    type: "GET",
    path: "/x402/catalog",
    name: "x402-catalog",
    public: true,
    handler: async (_req, res, _runtime) => {
      res.json(SERVICE_CATALOG);
    },
  },

  // ── GET /x402/health — FREE ──────────────────────────────────────
  {
    type: "GET",
    path: "/x402/health",
    name: "x402-health",
    public: true,
    handler: async (_req, res, runtime) => {
      const serverService = runtime.getService<X402ServerService>(
        "X402_SERVER" as any
      );
      const freeTier = typeof getFreeTierStats === "function" ? getFreeTierStats() : null;

      res.json({
        status: "ok",
        receiveAddress: serverService?.getReceiveAddress() ?? "",
        network: serverService?.getNetwork() ?? "",
        totalRevenue: serverService?.getTotalRevenueUsd() ?? 0,
        settlements: serverService?.getSettlementCount() ?? 0,
        freeTierCallsToday: freeTier?.totalFreeCallsToday ?? 0,
        freeTierUniqueIPs: freeTier?.uniqueIPs ?? 0,
      });
    },
  },

  // ── GET /x402/revenue — FREE (revenue dashboard) ────────────────
  {
    type: "GET",
    path: "/x402/revenue",
    name: "x402-revenue",
    public: true,
    handler: async (_req, res, runtime) => {
      const serverService = runtime.getService<X402ServerService>(
        "X402_SERVER" as any
      );
      const revenueHistory: X402RevenueRecord[] =
        serverService?.getRevenueHistory() ?? [];
      const totalRevenue = serverService?.getTotalRevenueUsd() ?? 0;
      const settlements = serverService?.getSettlementCount() ?? 0;
      const freeTier = typeof getFreeTierStats === "function" ? getFreeTierStats() : null;

      // ── Time-period breakdowns ──────────────────────────────────
      const now = Date.now();
      const ms24h = 86_400_000;
      const ms7d = 604_800_000;
      const ms30d = 2_592_000_000;

      function periodStats(cutoffMs: number) {
        const cutoff = now - cutoffMs;
        const inRange = revenueHistory.filter((r) => r.timestamp >= cutoff);
        return {
          revenue: parseFloat(
            inRange.reduce((sum, r) => sum + r.amountUsd, 0).toFixed(6)
          ),
          settlements: inRange.length,
        };
      }

      // ── Revenue by endpoint ─────────────────────────────────────
      const byEndpoint = new Map<string, { revenue: number; calls: number }>();
      for (const r of revenueHistory) {
        const entry = byEndpoint.get(r.endpoint) ?? { revenue: 0, calls: 0 };
        entry.revenue += r.amountUsd;
        entry.calls += 1;
        byEndpoint.set(r.endpoint, entry);
      }
      const revenueByEndpoint = Object.fromEntries(
        [...byEndpoint.entries()].map(([ep, stats]) => [
          ep,
          {
            revenue: parseFloat(stats.revenue.toFixed(6)),
            calls: stats.calls,
          },
        ])
      );

      // ── Top buyers ──────────────────────────────────────────────
      const byPayer = new Map<string, number>();
      for (const r of revenueHistory) {
        if (r.payer) {
          byPayer.set(r.payer, (byPayer.get(r.payer) ?? 0) + r.amountUsd);
        }
      }
      const topBuyers = [...byPayer.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([payer, spent]) => ({
          payer,
          spent: parseFloat(spent.toFixed(6)),
        }));

      // ── Conversion rate ─────────────────────────────────────────
      const totalFreeCallsToday = freeTier?.totalFreeCallsToday ?? 0;
      const paidCalls = settlements;
      const totalCalls = paidCalls + totalFreeCallsToday;
      const conversionRate =
        totalCalls > 0
          ? parseFloat((paidCalls / totalCalls).toFixed(4))
          : 0;

      res.json({
        totalRevenue: parseFloat(totalRevenue.toFixed(6)),
        settlements,
        revenueByEndpoint,
        last24h: periodStats(ms24h),
        last7d: periodStats(ms7d),
        last30d: periodStats(ms30d),
        freeTier: freeTier ?? { totalFreeCallsToday: 0, uniqueIPs: 0, topIPs: [] },
        conversionRate,
        topBuyers,
        averageTransactionUsd:
          settlements > 0
            ? parseFloat((totalRevenue / settlements).toFixed(6))
            : 0,
      });
    },
  },

  // ── POST /x402/async — Submit async task ─────────────────────────
  {
    type: "POST",
    path: "/x402/async",
    name: "x402-async-submit",
    public: true,
    handler: async (req, res, _runtime) => {
      const body = (req as any).body ?? {};
      const endpoint = body.endpoint;
      if (!endpoint || typeof endpoint !== "string") {
        res.status(400).json({ error: "Missing required field: endpoint" });
        return;
      }

      const params: Record<string, unknown> =
        typeof body.params === "object" && body.params !== null
          ? body.params
          : {};
      const webhookUrl =
        typeof body.webhookUrl === "string" ? body.webhookUrl : undefined;

      const taskId = taskQueue.submit(endpoint, params, webhookUrl);

      res.json({
        taskId,
        statusUrl: `/x402/task/${taskId}`,
      });
    },
  },

  // ── GET /x402/task/:id — Poll task status ────────────────────────
  {
    type: "GET",
    path: "/x402/task/:id",
    name: "x402-task-status",
    public: true,
    handler: async (req, res, _runtime) => {
      const taskId = (req as any).params?.id;
      if (!taskId || typeof taskId !== "string") {
        res.status(400).json({ error: "Missing task ID" });
        return;
      }

      const status = taskQueue.getStatus(taskId);
      if (!status) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      res.json(status);
    },
  },

  // ── GET /x402/access-passes — Access pass tiers info ──────────────
  {
    type: "GET",
    path: "/x402/access-passes",
    handler: async (_req, res, _runtime) => {
      res.json({
        description:
          "Access passes give unlimited calls for a time window at native HTTP latency (no per-call 402 overhead). " +
          "Purchase via Dexter SDK: wrapFetch(fetch, { accessPass: { preferTier: '24h', maxSpend: '2.00' } })",
        tiers: {
          "1h": { price: "$0.50", description: "1 hour unlimited access", bestFor: "Quick testing sessions" },
          "24h": { price: "$2.00", description: "24 hour unlimited access", bestFor: "Day trading bots" },
          "7d": { price: "$10.00", description: "7 day unlimited access", bestFor: "Weekly research sprints" },
          "30d": { price: "$35.00", description: "30 day unlimited access", bestFor: "Production integrations" },
        },
        coveredEndpoints: [
          "/x402/token-price", "/x402/token-supply", "/x402/slot-info",
          "/x402/token-accounts", "/x402/recent-blockhash",
          "/x402/tx-explainer", "/x402/memecoin-score", "/x402/wallet-risk-score",
        ],
        howToUse: {
          client: "import { wrapFetch } from '@dexterai/x402/client';\nconst x402Fetch = wrapFetch(fetch, { walletPrivateKey: KEY, accessPass: { preferTier: '24h', maxSpend: '2.00' } });",
          note: "First call auto-purchases the pass. All subsequent calls use cached JWT — zero payment latency.",
        },
      });
    },
  },
];
