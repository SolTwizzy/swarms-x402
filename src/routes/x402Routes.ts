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
import { buildRhChainRequirements, usdToUsdgAtomic } from "../server/rhChainGate.js";
import { getMcpToolDefinitions } from "../mcp/index.js";
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
 * Resolve the public https base URL from a request.
 * Proxy-terminated TLS means req.url arrives http:// — resources must be https.
 */
function resolveBaseUrl(req: unknown): string {
  try {
    return `https://${new URL(String((req as { url?: string }).url)).host}`;
  } catch {
    return "https://swarmx.io";
  }
}

const NETWORK_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "base-mainnet": "Base",
  "solana-mainnet": "Solana",
  "arbitrum-mainnet": "Arbitrum",
  "polygon-mainnet": "Polygon",
  "ethereum-mainnet": "Ethereum",
  "base-sepolia": "Base Sepolia",
};

function formatNetworkDisplayNames(
  networks: readonly { friendlyId: string }[]
): string {
  const names = networks.map(
    ({ friendlyId }) => NETWORK_DISPLAY_NAMES[friendlyId] ?? friendlyId
  );
  if (names.length === 0) return "Base";
  if (names.length === 1) return names[0] ?? "Base";
  return `${names.slice(0, -1).join(", ")} + ${names.at(-1)}`;
}

// ── Discovery input metadata (path → inputSchema + example) ─────────────
// Built lazily from the MCP tool definitions so schema fetchers can generate
// runnable request code without a second source of truth.

let mcpSchemaByPath: Map<string, { schema: unknown; example: Record<string, unknown> }> | null =
  null;

function sampleForProp(
  name: string,
  prop: { default?: unknown; enum?: string[]; type?: string; minimum?: number } | undefined
): unknown {
  if (prop?.default !== undefined) return prop.default;
  if (Array.isArray(prop?.enum) && prop.enum.length) return prop.enum[0];
  switch (prop?.type) {
    case "number":
    case "integer":
      return prop?.minimum ?? 1;
    case "boolean":
      return false;
    case "array":
      return name === "tickers" ? ["NVDA", "AAPL"] : [];
    default:
      if (name === "ticker") return "AAPL";
      return "...";
  }
}

// Endpoints without an MCP tool definition still need an input schema in
// /openapi.json — discovery validators (x402scan) reject paid operations
// whose requestBody has no property schema.
const EXTRA_INPUT_META: Record<
  string,
  { schema: unknown; example: Record<string, unknown> }
> = {
  "/swarm/token-diligence": {
    schema: {
      type: "object",
      properties: {
        mint: { type: "string", description: "SPL token mint address to research" },
      },
      required: ["mint"],
    },
    example: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  },
  "/swarm/defi-risk-score": {
    schema: {
      type: "object",
      properties: {
        protocol: { type: "string", description: "DeFi protocol name or URL to assess" },
      },
      required: ["protocol"],
    },
    example: { protocol: "marinade.finance" },
  },
  "/swarm/fact-check": {
    schema: {
      type: "object",
      properties: {
        claim: { type: "string", description: "Claim to fact-check (max 5000 chars)" },
      },
      required: ["claim"],
    },
    example: { claim: "Solana processes more transactions per day than Ethereum" },
  },
  "/swarm/deep-research": {
    schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Research topic (max 500 chars)" },
        focus: { type: "string", description: "Optional focus area" },
      },
      required: ["topic"],
    },
    example: { topic: "x402 payment protocol adoption" },
  },
  "/swarm/monitor": {
    schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Address or identifier to monitor" },
        type: { type: "string", description: "Optional target type" },
      },
      required: ["target"],
    },
    example: { target: "H1ooMkPx8uXoPS5WYz5JMY7dnYacqGLD3ZfEEku5caAZ" },
  },
};

function getEndpointInputMeta(
  path: string
): { schema: unknown; example: Record<string, unknown> } | undefined {
  if (!mcpSchemaByPath) {
    mcpSchemaByPath = new Map();
    for (const t of getMcpToolDefinitions().tools) {
      const schema = t.inputSchema;
      const example: Record<string, unknown> = {};
      for (const req of schema.required ?? []) {
        example[req] = sampleForProp(req, schema.properties?.[req]);
      }
      mcpSchemaByPath.set(t.metadata.endpoint, { schema, example });
    }
  }
  return mcpSchemaByPath.get(path) ?? EXTRA_INPUT_META[path];
}

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

  // ── GET /discovery/resources — FREE (x402 Bazaar-style discovery) ──
  // Schema fetchers (Swarms x402 Integration widget, CDP Bazaar clients)
  // resolve an endpoint's payment schema via GET /discovery/resources?url=<resource>.
  // Two consumer dialects served side by side: `items` (Bazaar: resource/accepts)
  // and `resources` (Swarms widget: url/metadata.input with schema + example).
  {
    type: "GET",
    path: "/discovery/resources",
    name: "x402-discovery",
    public: true,
    handler: async (req, res, runtime) => {
      const query = ((req as any).query ?? {}) as Record<string, string>;
      const filterUrl = typeof query.url === "string" && query.url ? query.url : undefined;
      const limit = Math.min(Math.max(parseInt(query.limit ?? "50", 10) || 50, 1), 100);
      const offset = Math.max(parseInt(query.offset ?? "0", 10) || 0, 0);

      const base = resolveBaseUrl(req);

      let entries = SERVICE_CATALOG.filter((e) => !e.free && !e.path.includes(":"));
      if (filterUrl) {
        const norm = filterUrl.replace(/\/+$/, "");
        entries = entries.filter(
          (e) => `${base}${e.path}` === norm || norm.endsWith(e.path)
        );
      }
      const total = entries.length;
      const page = entries.slice(offset, offset + limit);

      const serverService = runtime.getService("X402_SERVER" as any) as any;
      const lastUpdated = new Date().toISOString();

      const items = await Promise.all(
        page.map(async (e) => {
          const resource = `${base}${e.path}`;
          const accepts: unknown[] = [];
          try {
            accepts.push(
              buildRhChainRequirements({
                amountAtomic: usdToUsdgAtomic(e.priceUsd),
                resourceUrl: resource,
                description: e.description,
              })
            );
          } catch {
            /* RH rail optional */
          }
          if (serverService?.isAvailable?.()) {
            try {
              const dexterReq = await serverService.buildAllRequirements({
                amountAtomic: String(Math.round(parseFloat(e.priceUsd) * 1_000_000)),
                resourceUrl: resource,
                description: e.description,
              });
              // Dexter returns a full v2 envelope; accepts[] holds flat entries
              // backfilled with the v1 fields strict schema validators require.
              const inner = Array.isArray(dexterReq?.accepts)
                ? dexterReq.accepts
                : dexterReq
                  ? [dexterReq]
                  : [];
              for (const entry of inner) {
                accepts.push({
                  resource,
                  description: e.description,
                  mimeType: "application/json",
                  ...entry,
                });
              }
            } catch {
              /* Dexter rails optional */
            }
          }
          return {
            resource,
            type: "http",
            x402Version: 1,
            accepts,
            lastUpdated,
            metadata: {
              name: e.name,
              description: e.description,
              method: e.method,
              priceUsd: e.priceUsd,
            },
          };
        })
      );

      // Swarms-widget dialect: exact-url-keyed entries with an input spec the
      // widget turns into runnable client code.
      const resources = page.map((e) => {
        const input = getEndpointInputMeta(e.path);
        return {
          url: `${base}${e.path}`,
          type: "http",
          metadata: {
            name: e.name,
            description: e.description,
            priceUsd: e.priceUsd,
            input: {
              method: e.method,
              ...(input ? { schema: input.schema, example: input.example } : {}),
            },
            output: { mimeType: "application/json" },
          },
        };
      });

      res.json({ x402Version: 1, items, resources, pagination: { limit, offset, total } });
    },
  },

  // ── GET /.well-known/x402 — FREE (x402scan discovery document) ────
  // Minimal well-known payload per x402scan's DISCOVERY.md: version + the
  // list of paid resource URLs. x402scan falls back to this when no
  // OpenAPI document is found.
  {
    type: "GET",
    path: "/.well-known/x402",
    name: "x402-well-known",
    public: true,
    handler: async (req, res, runtime) => {
      const base = resolveBaseUrl(req);
      const serverService = runtime.getService<X402ServerService>(
        "X402_SERVER" as any
      );
      const networkNames = formatNetworkDisplayNames(
        serverService?.getNetworks?.() ?? []
      );
      const resources = SERVICE_CATALOG.filter(
        (e) => !e.free && !e.path.includes(":")
      ).map((e) => `${base}${e.path}`);

      res.json({
        version: 1,
        resources,
        instructions:
          "SwarmX paid AI endpoints. POST JSON per the input schema in " +
          `${base}/openapi.json — unauthenticated requests receive an x402 ` +
          `402 challenge (${networkNames} USDC via the Dexter facilitator).`,
      });
    },
  },

  // ── GET /openapi.json — FREE (x402scan primary discovery source) ──
  // OpenAPI 3 document with per-operation `x-payment-info` and a declared
  // 402 response, per x402scan's DISCOVERY.md. Input schemas come from the
  // MCP tool definitions (same source as /discovery/resources).
  {
    type: "GET",
    path: "/openapi.json",
    name: "x402-openapi",
    public: true,
    handler: async (req, res, runtime) => {
      const base = resolveBaseUrl(req);
      const serverService = runtime.getService<X402ServerService>(
        "X402_SERVER" as any
      );
      const networkNames = formatNetworkDisplayNames(
        serverService?.getNetworks?.() ?? []
      );
      const paths: Record<string, Record<string, unknown>> = {};

      for (const e of SERVICE_CATALOG) {
        if (e.path.includes(":")) continue;
        const method = e.method.toLowerCase();
        const input = getEndpointInputMeta(e.path);
        const isPaid = !e.free && parseFloat(e.priceUsd) > 0;

        const operation: Record<string, unknown> = {
          operationId: e.path.replace(/^\//, "").replace(/\//g, "-"),
          summary: e.name,
          description: e.description,
          responses: {
            "200": { description: "Successful result (JSON)" },
            ...(isPaid
              ? {
                  "402": {
                    description:
                      `Payment required — x402 challenge with \`accepts\` payment requirements (${networkNames} USDC)`,
                  },
                }
              : {}),
          },
        };

        if (method === "post") {
          operation.requestBody = {
            required: true,
            content: {
              "application/json": {
                schema: input?.schema ?? { type: "object" },
                ...(input?.example ? { example: input.example } : {}),
              },
            },
          };
        }

        if (isPaid) {
          operation["x-payment-info"] = {
            protocols: ["x402"],
            price: { mode: "fixed", currency: "USD", amount: e.priceUsd },
          };
        }

        paths[e.path] = { ...(paths[e.path] ?? {}), [method]: operation };
      }

      res.json({
        openapi: "3.0.3",
        info: {
          title: "SwarmX — AI Agent Teams, One Payment",
          version: "1.0.0",
          contact: { email: "Management@swarmx.io" },
          description:
            `x402-monetized AI endpoints: multi-agent swarms, RWA/stock due diligence, crypto analysis, and Solana data. Pay per call in USDC (${networkNames}) via the x402 protocol — no API keys.`,
        },
        servers: [{ url: base }],
        paths,
      });
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
      const receiveAddress = serverService?.getReceiveAddress() ?? "";
      const networks = (serverService?.getNetworks?.() ?? []).map((config) => ({
        network: config.caip2,
        friendlyId: config.friendlyId,
        payTo: config.payTo,
      }));

      res.json({
        status: "ok",
        receiveAddress,
        payTo: receiveAddress,
        network: serverService?.getNetwork() ?? "",
        networks,
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
