import type { Route } from "@elizaos/core";
import {
  buildRhChainRequirements,
  isRhChainPayment,
  RH_NETWORK,
  settleRhChainPayment,
  usdToUsdgAtomic,
} from "../server/rhChainGate.js";
import { x402Gate } from "../server/x402Gate.js";
import { SwarmsService } from "../services/swarmsService.js";
import type { X402ServiceEndpoint } from "../types.js";
import { callSwarmsAgent } from "../utils/llm.js";

/**
 * RWA / tokenized-stock intelligence routes.
 *
 * Flagship endpoint: POST /x402/rwa/stock-dd — "Tokenized-Stock Due Diligence".
 * Fetches REAL market data from Yahoo Finance (keyless), computes derived
 * technical stats server-side, then runs a REAL adversarial multi-agent Swarm
 * (bull / bear / risk debaters judged into a verdict) grounded in that data.
 *
 * v1 analyzes the UNDERLYING equity. The tokenized versions of these stocks
 * live on Robinhood Chain and are not available to US persons — this is an
 * information/analysis product, not investment advice or a solicitation.
 */

// ── Ticker validation ──────────────────────────────────────────────────
// Uppercase A–Z, 1–6 chars. Reject junk (digits, symbols, empty).
const TICKER_RE = /^[A-Z]{1,6}$/;

const STOCK_DD_PRICE_USD = "0.29";
const STOCK_DD_DESCRIPTION =
  "Tokenized-stock due diligence — real market data + adversarial bull/bear/risk Swarm (DebateWithJudge, 3 agents)";

function getPaymentHeader(req: any): string | null {
  const headers = req?.headers;
  if (!headers) return null;

  if (typeof headers.get === "function") {
    return headers.get("payment-signature") ?? headers.get("x-payment") ?? null;
  }

  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (normalized !== "payment-signature" && normalized !== "x-payment") continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return null;
}

// ── Helper: get SwarmsService or null ──────────────────────────────────
function getSwarmsService(runtime: any): SwarmsService | null {
  const svc = runtime.getService("SWARMS" as any) as SwarmsService | null;
  return svc?.isAvailable() ? svc : null;
}

// ── Helper: extract raw text from a Swarms response ────────────────────
// Only explicit transcript-bearing response fields are considered. This avoids
// treating job IDs, usage data, or other response metadata as analyst output.
function extractSwarmOutput(result: Record<string, unknown>): string {
  const output = result.output ?? result.outputs;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((item: unknown) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const role = obj.role ?? obj.agent_name ?? "agent";
          const content = obj.content ?? obj.text ?? obj.output;
          return typeof content === "string" && content.trim()
            ? `[${String(role)}]\n${content}`
            : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (output && typeof output === "object") {
    const nested = output as Record<string, unknown>;
    if (typeof nested.output === "string") return nested.output;
    if (typeof nested.content === "string") return nested.content;
  }
  return "";
}

// ── Yahoo Finance market data ──────────────────────────────────────────

interface MarketData {
  price: number;
  currency: string;
  exchange: string;
  prevClose: number;
  pctChange: number;
  high6mo: number;
  low6mo: number;
  avgVolume: number;
  /** Extra derived context used only for the data brief (not the public shape). */
  recentVolume: number;
  rangePositionPct: number;
  trend6moPct: number;
  trend1moPct: number;
  dailyVolatilityPct: number;
  asOf: string;
}

/** Round to n decimals, tolerant of nulls. */
function round(n: number, dp = 2): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Fetch 6mo daily OHLCV for a ticker from Yahoo Finance and compute derived
 * technical stats. Returns null on a not-found / malformed response.
 */
async function fetchYahoo(ticker: string): Promise<MarketData | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=1d&range=6mo`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Yahoo Finance API error (${res.status})`);
  }

  const json = (await res.json()) as any;
  const result = json?.chart?.result?.[0];
  const meta = result?.meta;
  if (!result || !meta || typeof meta.regularMarketPrice !== "number") return null;

  const quote = result.indicators?.quote?.[0] ?? {};
  const closes: number[] = (quote.close ?? []).filter((x: unknown): x is number =>
    typeof x === "number" && Number.isFinite(x)
  );
  const highs: number[] = (quote.high ?? []).filter((x: unknown): x is number =>
    typeof x === "number" && Number.isFinite(x)
  );
  const lows: number[] = (quote.low ?? []).filter((x: unknown): x is number =>
    typeof x === "number" && Number.isFinite(x)
  );
  const volumes: number[] = (quote.volume ?? []).filter((x: unknown): x is number =>
    typeof x === "number" && Number.isFinite(x)
  );

  const price = meta.regularMarketPrice;
  const prevClose =
    typeof meta.previousClose === "number" && Number.isFinite(meta.previousClose)
      ? meta.previousClose
      : typeof meta.regularMarketPreviousClose === "number" &&
          Number.isFinite(meta.regularMarketPreviousClose)
        ? meta.regularMarketPreviousClose
        : closes.length > 1
          ? closes[closes.length - 2]
          : price;

  const high6mo = highs.length ? Math.max(...highs) : price;
  const low6mo = lows.length ? Math.min(...lows) : price;
  const avgVolume = volumes.length
    ? volumes.reduce((s, v) => s + v, 0) / volumes.length
    : 0;
  const recentVolume = volumes.length ? volumes[volumes.length - 1] : 0;

  const pctChange = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
  const range = high6mo - low6mo;
  const rangePositionPct = range > 0 ? ((price - low6mo) / range) * 100 : 50;

  const first6mo = closes.length ? closes[0] : price;
  const trend6moPct = first6mo ? ((price - first6mo) / first6mo) * 100 : 0;
  const ref1mo = closes.length > 21 ? closes[closes.length - 22] : first6mo;
  const trend1moPct = ref1mo ? ((price - ref1mo) / ref1mo) * 100 : 0;

  // Daily volatility = stdev of daily simple returns over the window.
  let dailyVolatilityPct = 0;
  if (closes.length > 2) {
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1]) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    if (rets.length) {
      const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
      const variance =
        rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
      dailyVolatilityPct = Math.sqrt(variance) * 100;
    }
  }

  const asOf =
    typeof meta.regularMarketTime === "number"
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : new Date().toISOString();

  return {
    price: round(price),
    currency: typeof meta.currency === "string" ? meta.currency : "USD",
    exchange:
      typeof meta.fullExchangeName === "string"
        ? meta.fullExchangeName
        : typeof meta.exchangeName === "string"
          ? meta.exchangeName
          : "unknown",
    prevClose: round(prevClose),
    pctChange: round(pctChange),
    high6mo: round(high6mo),
    low6mo: round(low6mo),
    avgVolume: Math.round(avgVolume),
    recentVolume: Math.round(recentVolume),
    rangePositionPct: round(rangePositionPct, 1),
    trend6moPct: round(trend6moPct, 1),
    trend1moPct: round(trend1moPct, 1),
    dailyVolatilityPct: round(dailyVolatilityPct, 2),
    asOf,
  };
}

/** Build a compact factual data brief string from real numbers. */
function buildDataBrief(ticker: string, m: MarketData): string {
  const volVsAvg = m.avgVolume ? (m.recentVolume / m.avgVolume).toFixed(2) : "n/a";
  return (
    `FACTUAL MARKET DATA BRIEF — ${ticker} (${m.exchange})\n` +
    `As of: ${m.asOf}\n` +
    `Currency: ${m.currency}\n` +
    `Last price: ${m.price}\n` +
    `Previous close: ${m.prevClose}\n` +
    `Change vs previous close: ${m.pctChange}%\n` +
    `6-month high: ${m.high6mo}\n` +
    `6-month low: ${m.low6mo}\n` +
    `Position within 6-month range: ${m.rangePositionPct}% (0 = at low, 100 = at high)\n` +
    `Average daily volume (6mo): ${m.avgVolume.toLocaleString()}\n` +
    `Most recent session volume: ${m.recentVolume.toLocaleString()} (${volVsAvg}x average)\n` +
    `6-month price trend: ${m.trend6moPct}% over the period\n` +
    `~1-month price trend: ${m.trend1moPct}% over ~21 sessions\n` +
    `Daily return volatility (6mo stdev): ${m.dailyVolatilityPct}%\n` +
    `NOTE: Fundamentals (P/E, revenue, margins) are NOT in this brief — do not fabricate them.`
  );
}

// ── Verdict structuring ────────────────────────────────────────────────

export interface StockVerdict {
  rating: "bullish" | "neutral" | "bearish";
  confidence: number;
  summary: string;
  bull_points: string[];
  bear_points: string[];
  risks: string[];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function normalizeRating(v: unknown): "bullish" | "neutral" | "bearish" {
  const s = String(v ?? "").toLowerCase();
  if (s.includes("bull")) return "bullish";
  if (s.includes("bear")) return "bearish";
  return "neutral";
}

function toStringArray(v: unknown, max = 6): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, max);
}

/** Parse a strict-JSON verdict from raw model text. Returns null if unusable. */
function parseVerdictJson(raw: string): StockVerdict | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : "";
  if (!summary) return null;
  return {
    rating: normalizeRating(parsed.rating),
    confidence: clamp01(Number(parsed.confidence)),
    summary,
    bull_points: toStringArray(parsed.bull_points, 5),
    bear_points: toStringArray(parsed.bear_points, 5),
    risks: toStringArray(parsed.risks, 5),
  };
}

const STRUCTURE_SYSTEM_PROMPT =
  "You convert an equity analyst debate transcript into a strict JSON verdict. " +
  "Extract ONLY what the debate and its judge concluded — do not add your own opinions " +
  "or invent numbers. Correctly separate BULLISH arguments from BEARISH ones. " +
  "Output ONLY minified JSON, no markdown fences, no commentary.";

function buildStructureUserPrompt(
  ticker: string,
  dataBrief: string,
  transcript: string
): string {
  return (
    `Ticker: ${ticker}\n\n` +
    `Data brief the analysts were given:\n${dataBrief}\n\n` +
    `Debate transcript (bull vs bear vs risk, followed by the judge's final evaluation):\n` +
    `${transcript.slice(0, 24_000)}\n\n` +
    `Return a JSON object with EXACTLY these keys:\n` +
    `{"rating": one of "bullish"|"neutral"|"bearish" (the judge's overall stance),\n` +
    ` "confidence": number between 0 and 1,\n` +
    ` "summary": string, <= 60 words, plain English,\n` +
    ` "bull_points": array of up to 5 short strings (the bullish case only),\n` +
    ` "bear_points": array of up to 5 short strings (the bearish case only),\n` +
    ` "risks": array of up to 5 short strings}`
  );
}

/**
 * Convert the REAL debate transcript into a strict JSON verdict via a grounded
 * extraction pass. This does not add opinions — it reformats the judge's
 * conclusion. Resilient cascade: Swarms single-agent → keyword heuristic.
 * Always grounded in the real transcript.
 *
 * (Swarms single-agent is the only structuring provider — OpenAI direct was
 * removed when its key went out of quota; the platform runs on Swarms only.)
 */
async function structureVerdict(
  runtime: any,
  ticker: string,
  dataBrief: string,
  transcript: string
): Promise<{ verdict: StockVerdict; via: "swarms" | "heuristic" }> {
  const swarmsKey = String(runtime.getSetting("SWARMS_API_KEY") ?? "").trim();
  const userPrompt = buildStructureUserPrompt(ticker, dataBrief, transcript);

  // 1) Swarms single-agent — funded, confirmed-working primary provider.
  if (swarmsKey) {
    try {
      const raw = await callSwarmsAgent({
        swarmsApiKey: swarmsKey,
        systemPrompt: STRUCTURE_SYSTEM_PROMPT,
        userPrompt,
        model: "gpt-4o-mini",
        temperature: 0,
        maxTokens: 700,
        agentName: "VerdictStructurer",
        description: "Extracts a strict JSON verdict from an analyst debate",
      });
      const v = parseVerdictJson(raw);
      if (v) return { verdict: v, via: "swarms" };
    } catch {
      // fall through
    }
  }

  // 2) Keyword heuristic over the real transcript.
  return { verdict: heuristicVerdict(transcript), via: "heuristic" };
}

/** Keyword-sentiment fallback grounded in the real transcript. */
function heuristicVerdict(transcript: string): StockVerdict {
  const t = transcript.toLowerCase();
  const bull = (t.match(/\b(buy|bullish|upside|outperform|undervalued|strong)\b/g) ?? []).length;
  const bear = (t.match(/\b(sell|bearish|downside|overvalued|underperform|avoid|weak)\b/g) ?? []).length;
  let rating: "bullish" | "neutral" | "bearish" = "neutral";
  if (bull > bear * 1.3) rating = "bullish";
  else if (bear > bull * 1.3) rating = "bearish";
  const total = bull + bear;
  const confidence = clamp01(0.4 + (total ? Math.abs(bull - bear) / total : 0) * 0.4);

  // Pull a handful of bulleted / numbered lines as rough points.
  const lines = transcript
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(\d+[.)]|[-*•])\s+/.test(l))
    .map((l) => l.replace(/^(\d+[.)]|[-*•])\s+/, "").replace(/\*\*/g, "").trim())
    .filter((l) => l.length > 8);

  return {
    rating,
    confidence,
    summary:
      "Automated structuring was unavailable; verdict derived from keyword sentiment over the raw debate. " +
      "See `raw` for the full analyst debate.",
    bull_points: lines.slice(0, 4),
    bear_points: lines.slice(4, 8),
    risks: lines.slice(8, 12),
  };
}

const DISCLAIMER =
  "This is AI-generated information and analysis, NOT investment advice, a recommendation, " +
  "or a solicitation to buy or sell any security. Data may be delayed or inaccurate; verify " +
  "independently. Tokenized versions of these stocks trade on Robinhood Chain and are not " +
  "available to US persons.";

// ── Catalog entry ──────────────────────────────────────────────────────

export const RWA_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "Tokenized-Stock Due Diligence",
    description:
      "RWA equity due diligence — fetches real Yahoo Finance market data (price, 6mo range, trend, volatility) " +
      "then runs an adversarial bull/bear/risk Swarm debate judged into a bullish/neutral/bearish verdict " +
      "(DebateWithJudge, 3 agents). v1 analyzes the underlying equity behind Robinhood-Chain stock tokens.",
    path: "/x402/rwa/stock-dd",
    method: "POST",
    priceUsd: "0.29",
  },
];

// ── Routes ─────────────────────────────────────────────────────────────

export const rwaRoutes: Route[] = [
  // ── POST /x402/rwa/stock-dd — $0.29 ──────────────────────────────────
  {
    type: "POST",
    path: "/x402/rwa/stock-dd",
    handler: async (req, res, runtime) => {
      const body = (req as any).body ?? {};
      const rawTicker = typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
      if (!TICKER_RE.test(rawTicker)) {
        res.status(400).json({
          error: "Invalid ticker. Expected 1–6 uppercase letters A–Z (e.g. NVDA, AAPL).",
        });
        return;
      }
      const ticker = rawTicker;

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      // ── Step 1: Fetch REAL market data ──────────────────────────────
      let market: MarketData | null;
      try {
        market = await fetchYahoo(ticker);
      } catch (err) {
        runtime.logger.warn(
          { error: err instanceof Error ? err.message : String(err), ticker },
          "[x402/rwa/stock-dd] Yahoo fetch failed"
        );
        res.status(502).json({ error: "Failed to fetch market data. Try again shortly." });
        return;
      }
      if (!market) {
        res.status(400).json({
          error: `Ticker not found or no market data available: ${ticker}. It may be delisted or unsupported.`,
        });
        return;
      }

      const dataBrief = buildDataBrief(ticker, market);

      const resourceUrl = (req as any).url ?? "/x402/rwa/stock-dd";
      const rhRequirements = buildRhChainRequirements({
        amountAtomic: usdToUsdgAtomic(STOCK_DD_PRICE_USD),
        resourceUrl,
        description: STOCK_DD_DESCRIPTION,
      });
      const paymentHeader = getPaymentHeader(req);

      // All free/preflight work succeeded. Settle payment immediately before
      // the paid Swarms computation so invalid requests and upstream market
      // data failures never consume payment or free-tier quota.
      let gate: Awaited<ReturnType<typeof x402Gate>>;
      let paidWithRhChain = false;
      if (paymentHeader && isRhChainPayment(paymentHeader)) {
        const settlement = await settleRhChainPayment(paymentHeader, rhRequirements);
        if (!settlement.paid) {
          res.status(402).json({
            error: "RH-Chain payment failed",
            reason: settlement.reason,
          });
          return;
        }
        paidWithRhChain = true;
        gate = {
          paid: true,
          amountUsd: Number(STOCK_DD_PRICE_USD),
          transaction: settlement.transaction,
          network: RH_NETWORK,
          payer: settlement.payer,
        };
      } else {
        gate = await x402Gate(runtime, req, res, {
          amountUsd: STOCK_DD_PRICE_USD,
          description: STOCK_DD_DESCRIPTION,
          resourceUrl,
          extraAccepts: [rhRequirements],
        });
      }
      if (!gate.paid) return;

      // ── Step 2: Run the REAL adversarial Swarm ──────────────────────
      try {
        const result = await swarmsService.runSwarm({
          name: `stock-dd-${ticker}-${Date.now()}`,
          description: `Tokenized-stock due diligence debate: ${ticker}`,
          // "DebateWithJudge" is supported by the live API but missing from the
          // outdated swarms-ts type union — same cast pattern used across routes.
          swarm_type: "DebateWithJudge" as any,
          agents: [
            {
              agent_name: "BullAnalyst",
              description: "Argues the bullish investment case",
              system_prompt:
                "You are a buy-side equity BULL analyst. Build the strongest evidence-based BULLISH case for the " +
                "ticker using ONLY the factual data brief provided plus widely-known qualitative facts about the " +
                "company. Ground every quantitative claim in the brief's numbers (price, trend, range position, " +
                "volume, volatility). Do NOT fabricate specific fundamentals (exact P/E, revenue, margins) — if you " +
                "reference them, explicitly label them as general/qualitative. Be concise and specific.",
              model_name: "gpt-4o-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 350,
              temperature: 0.4,
            },
            {
              agent_name: "BearAnalyst",
              description: "Argues the bearish investment case",
              system_prompt:
                "You are a buy-side equity BEAR analyst. Build the strongest evidence-based BEARISH case for the " +
                "ticker using ONLY the factual data brief provided plus widely-known qualitative facts about the " +
                "company. Ground every quantitative claim in the brief's numbers (drawdown from 6mo high, weak " +
                "trend, extended range position, volatility, volume). Do NOT fabricate specific fundamentals — if " +
                "you reference them, label them as general/qualitative. Be concise and specific.",
              model_name: "gpt-4o-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 350,
              temperature: 0.4,
            },
            {
              agent_name: "RiskAnalyst",
              description: "Weighs valuation and downside risk",
              system_prompt:
                "You are a risk and valuation analyst. Weigh the technical risk in the data brief: distance from " +
                "6-month high/low, momentum, daily volatility, and volume anomalies. Assess downside risk and how " +
                "much of the move may already be priced in, using ONLY the brief's numbers plus general qualitative " +
                "context. Do NOT invent precise fundamentals. Conclude how risk should temper the verdict. Be concise.",
              model_name: "gpt-4o-mini",
              role: "worker" as const,
              max_loops: 1,
              max_tokens: 350,
              temperature: 0.3,
            },
          ],
          task:
            `Debate whether ${ticker} is a BUY, HOLD, or SELL for a medium-term investor, based ONLY on the ` +
            `factual market data brief below plus general knowledge of the company. Do NOT fabricate specific ` +
            `fundamentals (exact P/E, revenue, margins) that are not in the brief; if referenced, label them as ` +
            `qualitative. Ground every quantitative claim in the brief.\n\n` +
            `${dataBrief}\n\n` +
            `After the debate, the judge must deliver a CONCISE final verdict: an overall rating ` +
            `(bullish / neutral / bearish), a confidence level, a short plain-English summary, the strongest bull ` +
            `points, the strongest bear points, and the key risks. Keep the final verdict tight — brief bullet lists.`,
          max_loops: 1,
          rules:
            "BullAnalyst argues the upside, BearAnalyst argues the downside, RiskAnalyst weighs valuation and " +
            "downside risk. The judge synthesizes ONE verdict grounded only in the provided data brief.",
        });

        const transcript = extractSwarmOutput(result as Record<string, unknown>);
        if (!transcript.trim()) {
          res.status(502).json({
            error: "Swarms returned no usable analyst or judge transcript",
          });
          return;
        }

        // ── Step 3: Structure the real debate into a verdict ──────────
        const { verdict, via } = await structureVerdict(
          runtime,
          ticker,
          dataBrief,
          transcript
        );

        // Swarm accounting (proves the API was actually called).
        const usage = (result as any).usage ?? {};
        const cost =
          typeof usage?.billing_info?.total_cost === "number"
            ? usage.billing_info.total_cost
            : typeof usage?.total_cost === "number"
              ? usage.total_cost
              : null;

        const isPaid = gate.amountUsd > 0;

        res.json({
          ticker,
          asOf: market.asOf,
          market: {
            price: market.price,
            currency: market.currency,
            exchange: market.exchange,
            prevClose: market.prevClose,
            pctChange: market.pctChange,
            high6mo: market.high6mo,
            low6mo: market.low6mo,
            avgVolume: market.avgVolume,
          },
          verdict,
          swarm: {
            swarm_type: (result as any).swarm_type ?? "DebateWithJudge",
            agents: (result as any).number_of_agents ?? 3,
            execution_time: (result as any).execution_time ?? null,
            cost,
          },
          verdictVia: via,
          // Full analyst debate transcript — paid calls only.
          raw: isPaid ? transcript : undefined,
          template: "StockDD",
          disclaimer: DISCLAIMER,
          freeRemaining: gate.freeRemaining,
          payment: paidWithRhChain
            ? {
                network: RH_NETWORK,
                asset: "USDG",
                amount: STOCK_DD_PRICE_USD,
                listPriceUsd: STOCK_DD_PRICE_USD,
                transaction: gate.transaction,
                payer: gate.payer,
              }
            : {
                amount: gate.amountUsd,
                listPriceUsd: STOCK_DD_PRICE_USD,
                transaction: gate.transaction,
                network: gate.network,
              },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err), ticker },
          "[x402/rwa/stock-dd] Swarm execution failed"
        );
        res.status(502).json({ error: "Swarms execution failed. Try again shortly." });
      }
    },
  },

  // ── GET /x402/rwa/stock-dd — x402 discovery challenge ──────────────────
  // A bare GET (no payment) returns the 402 challenge advertising the payment
  // options so x402 crawlers (402 Index, x402scan, CDP Bazaar) and agents can
  // discover the endpoint. Never charges, never runs the swarm.
  {
    type: "GET",
    path: "/x402/rwa/stock-dd",
    handler: async (req, res, runtime) => {
      const resourceUrl = (req as any).url ?? "/x402/rwa/stock-dd";
      const rhReq = buildRhChainRequirements({
        amountAtomic: usdToUsdgAtomic(STOCK_DD_PRICE_USD),
        resourceUrl,
        description: STOCK_DD_DESCRIPTION,
      });
      // Robinhood Chain (USDG) is the PRIMARY rail — advertised first and in the
      // PAYMENT-REQUIRED header so x402 crawlers (402 Index, x402scan, CDP Bazaar)
      // index USDG/RH-Chain as the default payment option.
      const accepts: unknown[] = [rhReq];
      if (res.setHeader) {
        res.setHeader(
          "PAYMENT-REQUIRED",
          Buffer.from(JSON.stringify(rhReq)).toString("base64")
        );
      }
      // Solana/USDC (Dexter) as a secondary option.
      try {
        const serverService = runtime.getService("X402_SERVER" as any) as any;
        if (serverService?.isAvailable?.()) {
          const server = serverService.getServer();
          const solReq = await server.buildRequirements({
            amountAtomic: String(Math.round(parseFloat(STOCK_DD_PRICE_USD) * 1_000_000)),
            resourceUrl,
            description: STOCK_DD_DESCRIPTION,
          });
          accepts.push(solReq);
        }
      } catch (err) {
        runtime.logger?.warn?.(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/rwa/stock-dd GET] Solana requirements unavailable"
        );
      }
      res.status(402).json({
        x402Version: 1,
        error: "Payment required",
        resource: resourceUrl,
        description: STOCK_DD_DESCRIPTION,
        price: STOCK_DD_PRICE_USD,
        accepts,
      });
    },
  },
];
