import type { Route } from "@elizaos/core";
import {
  buildRhChainRequirements,
  isRhChainPayment,
  RH_NETWORK,
  settleRhChainPayment,
  usdToUsdgAtomic,
} from "../server/rhChainGate.js";
import { x402Gate } from "../server/x402Gate.js";
import type { X402ServiceEndpoint } from "../types.js";
import { callLLM, runLocalPanel, type PanelAgent } from "../utils/llm.js";

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

// ── Helper: is any LLM provider configured? ────────────────────────────
// The analyst panels now run locally via callLLM (Swarms → OpenAI cascade),
// so we only need SOME provider key, not the Swarms service specifically.
function hasLlmProvider(runtime: any): boolean {
  const swarms = String(runtime.getSetting("SWARMS_API_KEY") ?? "").trim();
  const openai = String(runtime.getSetting("OPENAI_API_KEY") ?? "").trim();
  return Boolean(swarms || openai);
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
  "You are the presiding judge over an equity analyst panel. Read the analysts' arguments " +
  "and the data brief, then deliver a strict JSON verdict. Base it ONLY on the arguments and " +
  "the brief's numbers — do not add your own opinions or invent numbers. Correctly separate " +
  "BULLISH arguments from BEARISH ones. Output ONLY minified JSON, no markdown fences, no commentary.";

function buildStructureUserPrompt(
  ticker: string,
  dataBrief: string,
  transcript: string
): string {
  return (
    `Ticker: ${ticker}\n\n` +
    `Data brief the analysts were given:\n${dataBrief}\n\n` +
    `Analyst arguments (bull vs bear vs risk):\n` +
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
): Promise<{ verdict: StockVerdict; via: "llm" | "heuristic" }> {
  const userPrompt = buildStructureUserPrompt(ticker, dataBrief, transcript);

  // 1) LLM judge (Swarms → OpenAI cascade).
  try {
    const raw = await callLLM(runtime, {
      systemPrompt: STRUCTURE_SYSTEM_PROMPT,
      userPrompt,
      model: "gpt-4o-mini",
      temperature: 0,
      maxTokens: 700,
    });
    const v = parseVerdictJson(raw);
    if (v) return { verdict: v, via: "llm" };
  } catch {
    // fall through
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

// ── RWA suite prices ───────────────────────────────────────────────────

const SCREEN_PRICE_USD = "0.49";
const COMPARE_PRICE_USD = "0.39";
const ELIGIBILITY_PRICE_USD = "0.19";
const CATALYST_PRICE_USD = "0.29";

// ── Analyst panels (run locally via runLocalPanel; judge = the structurer) ─

const STOCK_DD_AGENTS: PanelAgent[] = [
  {
    name: "BullAnalyst",
    systemPrompt:
      "You are a buy-side equity BULL analyst. Build the strongest evidence-based BULLISH case for the " +
      "ticker using ONLY the factual data brief provided plus widely-known qualitative facts about the " +
      "company. Ground every quantitative claim in the brief's numbers (price, trend, range position, " +
      "volume, volatility). Do NOT fabricate specific fundamentals (exact P/E, revenue, margins) — if you " +
      "reference them, explicitly label them as general/qualitative. Be concise and specific.",
  },
  {
    name: "BearAnalyst",
    systemPrompt:
      "You are a buy-side equity BEAR analyst. Build the strongest evidence-based BEARISH case for the " +
      "ticker using ONLY the factual data brief provided plus widely-known qualitative facts about the " +
      "company. Ground every quantitative claim in the brief's numbers (drawdown from 6mo high, weak " +
      "trend, extended range position, volatility, volume). Do NOT fabricate specific fundamentals — if " +
      "you reference them, label them as general/qualitative. Be concise and specific.",
  },
  {
    name: "RiskAnalyst",
    systemPrompt:
      "You are a risk and valuation analyst. Weigh the technical risk in the data brief: distance from " +
      "6-month high/low, momentum, daily volatility, and volume anomalies. Assess downside risk and how " +
      "much of the move may already be priced in, using ONLY the brief's numbers plus general qualitative " +
      "context. Do NOT invent precise fundamentals. Conclude how risk should temper the verdict. Be concise.",
  },
];

const SCREEN_AGENTS: PanelAgent[] = [
  {
    name: "MomentumAnalyst",
    systemPrompt:
      "You are a momentum analyst. Rank the tickers by trend, momentum, and range position using ONLY the " +
      "numbers in each data brief. Do NOT fabricate fundamentals. Be concise.",
  },
  {
    name: "ValueAnalyst",
    systemPrompt:
      "You are a value analyst. Rank the tickers by relative value and mean-reversion potential — position " +
      "within the 6-month range and distance from the 6-month high — using ONLY the briefs' numbers. Do NOT " +
      "fabricate fundamentals. Be concise.",
  },
  {
    name: "RiskAnalyst",
    systemPrompt:
      "You are a risk analyst. Re-rank considering volatility, drawdown from the 6-month high, and volume " +
      "anomalies, using ONLY the briefs' numbers. Do NOT invent fundamentals. Be concise.",
  },
];

/** Compare agents depend on the two tickers, so they are built per request. */
function buildCompareAgents(a: string, b: string): PanelAgent[] {
  return [
    {
      name: `Advocate_${a}`,
      systemPrompt:
        `You argue that ${a} is the better medium-term buy than ${b}, using ONLY the data briefs' numbers ` +
        `plus general qualitative knowledge. Ground quantitative claims in the briefs. Do NOT fabricate ` +
        `fundamentals. Be concise.`,
    },
    {
      name: `Advocate_${b}`,
      systemPrompt:
        `You argue that ${b} is the better medium-term buy than ${a}, using ONLY the data briefs' numbers ` +
        `plus general qualitative knowledge. Ground quantitative claims in the briefs. Do NOT fabricate ` +
        `fundamentals. Be concise.`,
    },
    {
      name: "RiskJudge",
      systemPrompt:
        "You weigh valuation and downside risk for both tickers using ONLY the briefs, then say which is the " +
        "better risk-adjusted buy. Be concise.",
    },
  ];
}

// ── Shared payment helper (dual-rail: RH-Chain USDG first, else x402Gate) ─
// Mirrors the stock-dd ordering EXACTLY: this is called only AFTER all free
// preflight (validation + market-data fetch) has succeeded, so invalid
// requests and upstream data failures never consume payment or free-tier quota.
// On an unpaid/failed result the HTTP 402 response has already been written by
// x402Gate (or here for an RH failure); the caller just returns.
async function settleRwaPayment(
  runtime: any,
  req: any,
  res: any,
  opts: { priceUsd: string; description: string }
): Promise<{ paid: boolean; paidWithRhChain: boolean; gate: Awaited<ReturnType<typeof x402Gate>> }> {
  const resourceUrl = (req as any).url ?? "/x402/rwa";
  const rhRequirements = buildRhChainRequirements({
    amountAtomic: usdToUsdgAtomic(opts.priceUsd),
    resourceUrl,
    description: opts.description,
  });
  const paymentHeader = getPaymentHeader(req);

  if (paymentHeader && isRhChainPayment(paymentHeader)) {
    const settlement = await settleRhChainPayment(paymentHeader, rhRequirements);
    if (!settlement.paid) {
      res.status(402).json({ error: "RH-Chain payment failed", reason: settlement.reason });
      return { paid: false, paidWithRhChain: false, gate: { paid: false, amountUsd: 0 } };
    }
    return {
      paid: true,
      paidWithRhChain: true,
      gate: {
        paid: true,
        amountUsd: Number(opts.priceUsd),
        transaction: settlement.transaction,
        network: RH_NETWORK,
        payer: settlement.payer,
      },
    };
  }

  const gate = await x402Gate(runtime, req, res, {
    amountUsd: opts.priceUsd,
    description: opts.description,
    resourceUrl,
    extraAccepts: [rhRequirements],
  });
  return { paid: gate.paid, paidWithRhChain: false, gate };
}

/**
 * Answer an unauthenticated discovery probe (x402scan/Bazaar registration:
 * no payment header, empty body) with the 402 challenge BEFORE input
 * validation runs. A 402 challenge never settles and (per x402Gate) never
 * consumes free-tier quota, so the money-bug ordering (validate → fetch →
 * pay) is fully preserved for real requests.
 * Returns true when the probe was answered and the handler must return.
 */
async function answeredDiscoveryProbe(
  runtime: any,
  req: any,
  res: any,
  opts: { priceUsd: string; description: string }
): Promise<boolean> {
  const body = (req as any).body;
  const hasInput =
    body !== null &&
    body !== undefined &&
    typeof body === "object" &&
    Object.keys(body).length > 0;
  if (getPaymentHeader(req) || hasInput) return false;
  await settleRwaPayment(runtime, req, res, opts);
  return true;
}

/** Build the response `payment` block, matching the stock-dd shape. */
function paymentBlock(paidWithRhChain: boolean, gate: any, priceUsd: string) {
  return paidWithRhChain
    ? {
        network: RH_NETWORK,
        asset: "USDG",
        amount: priceUsd,
        listPriceUsd: priceUsd,
        transaction: gate.transaction,
        payer: gate.payer,
      }
    : {
        amount: gate.amountUsd,
        listPriceUsd: priceUsd,
        transaction: gate.transaction,
        network: gate.network,
      };
}

// ── Deterministic scoring (grounded in real market data, never fabricated) ─

function clampNum(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(hi, Math.max(lo, n));
}

/** A 0-100 momentum/positioning score derived only from real market stats. */
function compositeScore(m: MarketData): number {
  let s = 50;
  s += clampNum(m.trend6moPct, -30, 30) * 0.5; // ±15
  s += clampNum(m.trend1moPct, -20, 20) * 0.5; // ±10
  s += (clampNum(m.rangePositionPct, 0, 100) - 50) * 0.2; // ±10
  s += clampNum(m.pctChange, -10, 10) * 0.5; // ±5
  s -= Math.min(10, Math.max(0, m.dailyVolatilityPct)); // up to -10 for volatility
  return round(clampNum(s, 0, 100), 1);
}

function ratingFromScore(s: number): "bullish" | "neutral" | "bearish" {
  if (s >= 60) return "bullish";
  if (s <= 40) return "bearish";
  return "neutral";
}

/** Run an LLM judge (Swarms → OpenAI) and parse the first JSON object from its output. */
async function llmExtractJson(
  runtime: any,
  system: string,
  user: string
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await callLLM(runtime, {
      systemPrompt: system,
      userPrompt: user,
      model: "gpt-4o-mini",
      temperature: 0,
      maxTokens: 900,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Catalyst data (real dividends / splits / notable moves from Yahoo) ────

interface DividendEvent {
  date: string;
  amount: number;
}
interface SplitEvent {
  date: string;
  ratio: string;
}
interface PriceMove {
  date: string;
  changePct: number;
}
interface CatalystData {
  price: number;
  currency: string;
  exchange: string;
  asOf: string;
  dividends: DividendEvent[];
  ttmDividend: number;
  dividendYieldPct: number;
  splits: SplitEvent[];
  recentMoves: PriceMove[];
}

/**
 * Fetch 1y daily data WITH dividend + split events from Yahoo Finance (keyless).
 * All values are REAL — future earnings dates are NOT available from this source
 * and are never fabricated. Returns null on not-found / malformed response.
 */
async function fetchCatalystData(ticker: string): Promise<CatalystData | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=1d&range=1y&events=div,splits`;
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

  const price = meta.regularMarketPrice;
  const nowSec = Math.floor(Date.now() / 1000);
  const yearAgo = nowSec - 365 * 24 * 3600;

  const divRaw: Record<string, any> = result.events?.dividends ?? {};
  const dividends: DividendEvent[] = Object.values(divRaw)
    .map((d: any) => ({
      ts: typeof d?.date === "number" ? d.date : 0,
      date: new Date((typeof d?.date === "number" ? d.date : 0) * 1000).toISOString().slice(0, 10),
      amount: round(Number(d?.amount), 4),
    }))
    .filter((d) => Number.isFinite(d.amount) && d.amount > 0)
    .sort((a, b) => b.ts - a.ts)
    .map(({ date, amount }) => ({ date, amount }));

  const ttmDividend = round(
    Object.values(divRaw)
      .filter((d: any) => typeof d?.date === "number" && d.date >= yearAgo)
      .reduce((sum: number, d: any) => sum + (Number.isFinite(Number(d?.amount)) ? Number(d.amount) : 0), 0),
    4
  );
  const dividendYieldPct = price > 0 ? round((ttmDividend / price) * 100, 2) : 0;

  const splitRaw: Record<string, any> = result.events?.splits ?? {};
  const splits: SplitEvent[] = Object.values(splitRaw)
    .map((s: any) => ({
      ts: typeof s?.date === "number" ? s.date : 0,
      date: new Date((typeof s?.date === "number" ? s.date : 0) * 1000).toISOString().slice(0, 10),
      ratio:
        typeof s?.splitRatio === "string"
          ? s.splitRatio
          : `${s?.numerator ?? "?"}:${s?.denominator ?? "?"}`,
    }))
    .sort((a, b) => b.ts - a.ts)
    .map(({ date, ratio }) => ({ date, ratio }));

  const ts: number[] = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];
  const moves: PriceMove[] = [];
  for (let i = Math.max(1, closes.length - 60); i < closes.length; i++) {
    const p0 = closes[i - 1];
    const p1 = closes[i];
    if (typeof p0 === "number" && typeof p1 === "number" && p0) {
      const chg = ((p1 - p0) / p0) * 100;
      if (Math.abs(chg) >= 5) {
        moves.push({
          date: new Date((ts[i] ?? 0) * 1000).toISOString().slice(0, 10),
          changePct: round(chg, 2),
        });
      }
    }
  }
  moves.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

  return {
    price: round(price),
    currency: typeof meta.currency === "string" ? meta.currency : "USD",
    exchange:
      typeof meta.fullExchangeName === "string"
        ? meta.fullExchangeName
        : typeof meta.exchangeName === "string"
          ? meta.exchangeName
          : "unknown",
    asOf:
      typeof meta.regularMarketTime === "number"
        ? new Date(meta.regularMarketTime * 1000).toISOString()
        : new Date().toISOString(),
    dividends: dividends.slice(0, 12),
    ttmDividend,
    dividendYieldPct,
    splits: splits.slice(0, 6),
    recentMoves: moves.slice(0, 8),
  };
}

// ── Eligibility (deterministic compliance screen — no LLM, no fabrication) ─

const US_ALIASES = new Set([
  "US",
  "USA",
  "U.S.",
  "U.S.A.",
  "UNITED STATES",
  "UNITED STATES OF AMERICA",
  "AMERICA",
]);

function assessEligibility(jurisdiction: string): {
  jurisdiction: string;
  usPerson: boolean;
  eligible: "no" | "conditional";
  reason: string;
} {
  const j = jurisdiction.trim().toUpperCase();
  if (US_ALIASES.has(j)) {
    return {
      jurisdiction: "US",
      usPerson: true,
      eligible: "no",
      reason:
        "Tokenized equities on Robinhood Chain are not offered to US persons. A US person cannot hold or trade these stock tokens.",
    };
  }
  return {
    jurisdiction: jurisdiction.trim() || "unspecified",
    usPerson: false,
    eligible: "conditional",
    reason:
      "Not restricted as a US person. Access still depends on Robinhood's onboarding, KYC/identity checks, and your local securities regulations — verify directly with Robinhood before relying on this.",
  };
}

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
  {
    name: "Tokenized-Stock Screener",
    description:
      "Rank a watchlist (2–8 tickers) of tokenized stocks. Fetches real market data for each, then runs a " +
      "multi-agent Swarm screening debate judged into a best-to-worst ranking with per-ticker rating, score, " +
      "and rationale. Grounded deterministic fallback if the Swarm is unavailable.",
    path: "/x402/rwa/screen",
    method: "POST",
    priceUsd: SCREEN_PRICE_USD,
  },
  {
    name: "Tokenized-Stock Comparison",
    description:
      "Head-to-head due diligence on two tokenized equities. Fetches real market data for both and runs an " +
      "adversarial Swarm debate judged into a winner, per-ticker ratings, and the key points and risks.",
    path: "/x402/rwa/compare",
    method: "POST",
    priceUsd: COMPARE_PRICE_USD,
  },
  {
    name: "Tokenized-Asset Eligibility Check",
    description:
      "Compliance screen for a tokenized equity: identifies the underlying (name/exchange via real data) and " +
      "returns a deterministic Robinhood-Chain access assessment by jurisdiction (US persons are not eligible). " +
      "Informational only, not legal advice.",
    path: "/x402/rwa/eligibility",
    method: "POST",
    priceUsd: ELIGIBILITY_PRICE_USD,
  },
  {
    name: "Tokenized-Stock Catalyst Brief",
    description:
      "Corporate-actions and catalyst brief for an equity: real dividend history + trailing yield, stock " +
      "splits, and notable recent single-day moves from Yahoo Finance, summarized by an AI analyst. Future " +
      "earnings dates are not fabricated when unavailable.",
    path: "/x402/rwa/catalyst",
    method: "POST",
    priceUsd: CATALYST_PRICE_USD,
  },
];

// ── Routes ─────────────────────────────────────────────────────────────

export const rwaRoutes: Route[] = [
  // ── POST /x402/rwa/stock-dd — $0.29 ──────────────────────────────────
  {
    type: "POST",
    path: "/x402/rwa/stock-dd",
    handler: async (req, res, runtime) => {
      if (
        await answeredDiscoveryProbe(runtime, req, res, {
          priceUsd: STOCK_DD_PRICE_USD,
          description: STOCK_DD_DESCRIPTION,
        })
      )
        return;

      const body = (req as any).body ?? {};
      const rawTicker = typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
      if (!TICKER_RE.test(rawTicker)) {
        res.status(400).json({
          error: "Invalid ticker. Expected 1–6 uppercase letters A–Z (e.g. NVDA, AAPL).",
        });
        return;
      }
      const ticker = rawTicker;

      if (!hasLlmProvider(runtime)) {
        res.status(503).json({ error: "No LLM provider configured" });
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

      // ── Step 2: Run the analyst panel LOCALLY (Swarms → OpenAI) ─────
      try {
        const agentTask =
          `Analyze whether ${ticker} is a BUY, HOLD, or SELL for a medium-term investor, based ONLY on the ` +
          `factual market data brief below plus general knowledge of the company. Do NOT fabricate specific ` +
          `fundamentals (exact P/E, revenue, margins) that are not in the brief; if referenced, label them as ` +
          `qualitative. Ground every quantitative claim in the brief. Make your case concisely.\n\n${dataBrief}`;
        const panel = await runLocalPanel(runtime, {
          agents: STOCK_DD_AGENTS,
          task: agentTask,
          model: "gpt-4o-mini",
          maxTokens: 350,
          temperature: 0.4,
        });
        if (!panel.transcript.trim()) {
          res.status(502).json({
            error: "Analyst panel returned no usable output",
          });
          return;
        }

        // ── Step 3: The judge structures the arguments into a verdict ──
        const { verdict, via } = await structureVerdict(
          runtime,
          ticker,
          dataBrief,
          panel.transcript
        );

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
            swarm_type: "LocalPanel",
            agents: panel.agentCount,
            execution_time: null,
            cost: null,
          },
          verdictVia: via,
          // Full analyst transcript — paid calls only.
          raw: isPaid ? panel.transcript : undefined,
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
      // Traefik terminates TLS, so req.url arrives http:// — schema validators
      // (Swarms x402 integration, x402scan) reject non-https resource URLs.
      const resourceUrl = String((req as any).url ?? "/x402/rwa/stock-dd").replace(
        /^http:\/\//,
        "https://"
      );
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
        // Swarms' schema fetcher falls back to a bare OPTIONS and reads this
        // header. ASCII only — non-ASCII header values are rejected.
        res.setHeader(
          "x-x402-metadata",
          JSON.stringify({
            description:
              "Tokenized-stock due diligence: real market data + adversarial bull/bear/risk AI panel",
            priceUsd: STOCK_DD_PRICE_USD,
            input: {
              method: "POST",
              schema: {
                type: "object",
                properties: {
                  ticker: {
                    type: "string",
                    description: "Stock ticker, 1-6 uppercase letters (e.g. AAPL)",
                  },
                },
                required: ["ticker"],
              },
              example: { ticker: "AAPL" },
            },
            output: { mimeType: "application/json" },
          })
        );
      }
      // Dexter USDC rails as secondary options, in configured priority order.
      try {
        const serverService = runtime.getService("X402_SERVER" as any) as any;
        if (serverService?.isAvailable?.()) {
          const dexterReq = await serverService.buildAllRequirements({
            amountAtomic: String(Math.round(parseFloat(STOCK_DD_PRICE_USD) * 1_000_000)),
            resourceUrl,
            description: STOCK_DD_DESCRIPTION,
          });
          // Dexter returns a full v2 PaymentRequired envelope; accepts[] must
          // hold flat requirement objects, so unwrap its inner entries and
          // backfill the v1 fields strict schema validators require.
          const inner = Array.isArray((dexterReq as any)?.accepts)
            ? (dexterReq as any).accepts
            : dexterReq
              ? [dexterReq]
              : [];
          for (const entry of inner) {
            accepts.push({
              resource: resourceUrl,
              description: STOCK_DD_DESCRIPTION,
              mimeType: "application/json",
              ...entry,
            });
          }
        }
      } catch (err) {
        runtime.logger?.warn?.(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/rwa/stock-dd GET] Dexter requirements unavailable"
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

  // ── POST /x402/rwa/screen — $0.49 ────────────────────────────────────
  {
    type: "POST",
    path: "/x402/rwa/screen",
    handler: async (req, res, runtime) => {
      if (
        await answeredDiscoveryProbe(runtime, req, res, {
          priceUsd: SCREEN_PRICE_USD,
          description: "Tokenized-stock screener: rank 2-8 tickers by momentum, value, and risk",
        })
      )
        return;

      const body = (req as any).body ?? {};
      const rawList = Array.isArray(body.tickers) ? body.tickers : [];
      const seen = new Set<string>();
      const tickers: string[] = [];
      for (const t of rawList) {
        if (typeof t !== "string") continue;
        const up = t.trim().toUpperCase();
        if (TICKER_RE.test(up) && !seen.has(up)) {
          seen.add(up);
          tickers.push(up);
        }
      }
      if (tickers.length < 2 || tickers.length > 8) {
        res.status(400).json({
          error:
            'Provide 2-8 valid tickers as `tickers` (array of 1-6 uppercase letters, e.g. ["NVDA","AAPL"]).',
        });
        return;
      }

      if (!hasLlmProvider(runtime)) {
        res.status(503).json({ error: "No LLM provider configured" });
        return;
      }

      // ── Fetch REAL market data for each ticker ──────────────────────
      const fetched = await Promise.all(
        tickers.map(async (t) => ({ ticker: t, market: await fetchYahoo(t).catch(() => null) }))
      );
      const found = fetched.filter(
        (f): f is { ticker: string; market: MarketData } => f.market !== null
      );
      const notFound = fetched.filter((f) => f.market === null).map((f) => f.ticker);
      if (found.length < 2) {
        res.status(400).json({
          error: `Need at least 2 valid tickers with market data. Not found: ${notFound.join(", ") || "n/a"}.`,
        });
        return;
      }

      const briefs = found
        .map(({ ticker, market }) => `--- ${ticker} ---\n${buildDataBrief(ticker, market)}`)
        .join("\n\n");

      // Payment settles ONLY after all free preflight succeeded.
      const pay = await settleRwaPayment(runtime, req, res, {
        priceUsd: SCREEN_PRICE_USD,
        description: `Tokenized-stock screener: ${found.map((f) => f.ticker).join(", ")}`,
      });
      if (!pay.paid) return;

      // ── Run the REAL screening Swarm ────────────────────────────────
      let ranking: Array<{
        ticker: string;
        rank: number;
        rating: "bullish" | "neutral" | "bearish";
        score: number;
        rationale: string;
      }> = [];
      let summary = "";
      let via: "llm" | "heuristic" = "heuristic";
      try {
        const panel = await runLocalPanel(runtime, {
          agents: SCREEN_AGENTS,
          task:
            `Screen and RANK these tokenized-stock candidates best-to-worst for a medium-term investor, using ` +
            `ONLY the factual data briefs below plus general knowledge. Ground every quantitative claim in the ` +
            `briefs. Do NOT fabricate fundamentals. Make your case concisely.\n\n${briefs}`,
          model: "gpt-4o-mini",
          maxTokens: 400,
          temperature: 0.3,
        });
        if (panel.transcript.trim()) {
          const parsed = await llmExtractJson(
            runtime,
            "You are the presiding judge over an equity screening panel. Read the analysts' arguments and the " +
              "data and output a strict JSON ranking. Use ONLY the arguments and the provided data. Output ONLY " +
              "minified JSON, no fences.",
            `Tickers: ${found.map((f) => f.ticker).join(", ")}\n\nAnalyst arguments:\n${panel.transcript.slice(0, 20000)}\n\n` +
              `Return {"ranking":[{"ticker":"..","rating":"bullish|neutral|bearish","rationale":"<= 24 words"}], ` +
              `"summary":"<= 50 words"}. Rank ALL tickers best-first; include every ticker exactly once.`
          );
          if (parsed && Array.isArray(parsed.ranking)) {
            const order: string[] = [];
            const rmap = new Map<string, { rating: "bullish" | "neutral" | "bearish"; rationale: string }>();
            for (const r of parsed.ranking as any[]) {
              const tk = String(r?.ticker ?? "").trim().toUpperCase();
              if (found.some((f) => f.ticker === tk) && !rmap.has(tk)) {
                order.push(tk);
                rmap.set(tk, {
                  rating: normalizeRating(r?.rating),
                  rationale: typeof r?.rationale === "string" ? r.rationale.trim() : "",
                });
              }
            }
            for (const f of found) if (!rmap.has(f.ticker)) order.push(f.ticker);
            ranking = order.map((tk, i) => {
              const f = found.find((x) => x.ticker === tk)!;
              const score = compositeScore(f.market);
              const info = rmap.get(tk);
              return {
                ticker: tk,
                rank: i + 1,
                rating: info?.rating ?? ratingFromScore(score),
                score,
                rationale: info?.rationale || "Ranked by momentum/positioning score over real market data.",
              };
            });
            summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
            via = "llm";
          }
        }
      } catch (err) {
        runtime.logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/rwa/screen] panel failed"
        );
      }

      // Deterministic fallback grounded in real data (never fabricated).
      if (ranking.length === 0) {
        ranking = found
          .map(({ ticker, market }) => ({ ticker, score: compositeScore(market) }))
          .sort((a, b) => b.score - a.score)
          .map((x, i) => ({
            ticker: x.ticker,
            rank: i + 1,
            rating: ratingFromScore(x.score),
            score: x.score,
            rationale: "Ranked by momentum/positioning score over real market data.",
          }));
        summary =
          summary ||
          "Ranking derived from a deterministic momentum/positioning score over real market data.";
        via = "heuristic";
      }

      res.json({
        tickers: found.map((f) => f.ticker),
        notFound,
        asOf: found[0].market.asOf,
        ranking,
        summary,
        market: Object.fromEntries(
          found.map((f) => [
            f.ticker,
            {
              price: f.market.price,
              currency: f.market.currency,
              pctChange: f.market.pctChange,
              trend6moPct: f.market.trend6moPct,
              rangePositionPct: f.market.rangePositionPct,
            },
          ])
        ),
        via,
        template: "RwaScreen",
        disclaimer: DISCLAIMER,
        freeRemaining: pay.gate.freeRemaining,
        payment: paymentBlock(pay.paidWithRhChain, pay.gate, SCREEN_PRICE_USD),
      });
    },
  },

  // ── POST /x402/rwa/compare — $0.39 ───────────────────────────────────
  {
    type: "POST",
    path: "/x402/rwa/compare",
    handler: async (req, res, runtime) => {
      if (
        await answeredDiscoveryProbe(runtime, req, res, {
          priceUsd: COMPARE_PRICE_USD,
          description: "Tokenized-stock comparison: head-to-head A vs B verdict",
        })
      )
        return;

      const body = (req as any).body ?? {};
      let a = typeof body.tickerA === "string" ? body.tickerA : "";
      let b = typeof body.tickerB === "string" ? body.tickerB : "";
      if ((!a || !b) && Array.isArray(body.tickers) && body.tickers.length >= 2) {
        a = typeof body.tickers[0] === "string" ? body.tickers[0] : a;
        b = typeof body.tickers[1] === "string" ? body.tickers[1] : b;
      }
      a = a.trim().toUpperCase();
      b = b.trim().toUpperCase();
      if (!TICKER_RE.test(a) || !TICKER_RE.test(b)) {
        res.status(400).json({
          error: "Provide two tickers as `tickerA` and `tickerB` (1-6 uppercase letters each).",
        });
        return;
      }
      if (a === b) {
        res.status(400).json({ error: "tickerA and tickerB must be different." });
        return;
      }

      if (!hasLlmProvider(runtime)) {
        res.status(503).json({ error: "No LLM provider configured" });
        return;
      }

      let ma: MarketData | null;
      let mb: MarketData | null;
      try {
        [ma, mb] = await Promise.all([fetchYahoo(a), fetchYahoo(b)]);
      } catch (err) {
        res.status(502).json({ error: "Failed to fetch market data. Try again shortly." });
        return;
      }
      if (!ma) {
        res.status(400).json({ error: `Ticker not found: ${a}` });
        return;
      }
      if (!mb) {
        res.status(400).json({ error: `Ticker not found: ${b}` });
        return;
      }

      const brief = `--- ${a} ---\n${buildDataBrief(a, ma)}\n\n--- ${b} ---\n${buildDataBrief(b, mb)}`;

      const pay = await settleRwaPayment(runtime, req, res, {
        priceUsd: COMPARE_PRICE_USD,
        description: `Tokenized-stock comparison: ${a} vs ${b}`,
      });
      if (!pay.paid) return;

      const scoreA = compositeScore(ma);
      const scoreB = compositeScore(mb);
      let comparison: {
        winner: string;
        rating_a: "bullish" | "neutral" | "bearish";
        rating_b: "bullish" | "neutral" | "bearish";
        summary: string;
        a_points: string[];
        b_points: string[];
        risks: string[];
      } = {
        winner: scoreA === scoreB ? "tie" : scoreA > scoreB ? a : b,
        rating_a: ratingFromScore(scoreA),
        rating_b: ratingFromScore(scoreB),
        summary: "",
        a_points: [],
        b_points: [],
        risks: [],
      };
      let via: "llm" | "heuristic" = "heuristic";
      try {
        const panel = await runLocalPanel(runtime, {
          agents: buildCompareAgents(a, b),
          task:
            `Argue which is the better medium-term buy: ${a} or ${b}. Use ONLY the factual briefs below plus ` +
            `general knowledge; do NOT fabricate fundamentals. Ground every quantitative claim. Make your case ` +
            `concisely.\n\n${brief}`,
          model: "gpt-4o-mini",
          maxTokens: 350,
          temperature: 0.4,
        });
        if (panel.transcript.trim()) {
          const parsed = await llmExtractJson(
            runtime,
            "You are the presiding judge over a head-to-head equity debate. Read the advocates' arguments and " +
              "output strict JSON. Use ONLY the arguments and provided data. Output ONLY minified JSON, no fences.",
            `A=${a}, B=${b}\n\nAdvocate arguments:\n${panel.transcript.slice(0, 20000)}\n\n` +
              `Return {"winner":"${a}"|"${b}"|"tie","rating_a":"bullish|neutral|bearish","rating_b":"bullish|neutral|bearish",` +
              `"summary":"<= 55 words","a_points":["<=4 short strings"],"b_points":["<=4 short strings"],"risks":["<=4 short strings"]}.`
          );
          if (parsed && typeof parsed.summary === "string" && parsed.summary.trim()) {
            const w = String(parsed.winner ?? "").trim().toUpperCase();
            comparison = {
              winner: w === a ? a : w === b ? b : "tie",
              rating_a: normalizeRating(parsed.rating_a),
              rating_b: normalizeRating(parsed.rating_b),
              summary: parsed.summary.trim(),
              a_points: toStringArray(parsed.a_points, 4),
              b_points: toStringArray(parsed.b_points, 4),
              risks: toStringArray(parsed.risks, 4),
            };
            via = "llm";
          }
        }
      } catch (err) {
        runtime.logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/rwa/compare] panel failed"
        );
      }

      if (via === "heuristic" && !comparison.summary) {
        comparison.summary = `${
          comparison.winner === "tie" ? "Too close to call" : comparison.winner + " scores higher"
        } on a deterministic momentum/positioning score (${a}=${scoreA}, ${b}=${scoreB}) over real market data.`;
      }

      res.json({
        tickerA: a,
        tickerB: b,
        asOf: ma.asOf,
        scores: { [a]: scoreA, [b]: scoreB },
        comparison,
        market: {
          [a]: {
            price: ma.price,
            currency: ma.currency,
            pctChange: ma.pctChange,
            trend6moPct: ma.trend6moPct,
            rangePositionPct: ma.rangePositionPct,
          },
          [b]: {
            price: mb.price,
            currency: mb.currency,
            pctChange: mb.pctChange,
            trend6moPct: mb.trend6moPct,
            rangePositionPct: mb.rangePositionPct,
          },
        },
        via,
        template: "RwaCompare",
        disclaimer: DISCLAIMER,
        freeRemaining: pay.gate.freeRemaining,
        payment: paymentBlock(pay.paidWithRhChain, pay.gate, COMPARE_PRICE_USD),
      });
    },
  },

  // ── POST /x402/rwa/eligibility — $0.19 (deterministic, no LLM) ────────
  {
    type: "POST",
    path: "/x402/rwa/eligibility",
    handler: async (req, res, runtime) => {
      if (
        await answeredDiscoveryProbe(runtime, req, res, {
          priceUsd: ELIGIBILITY_PRICE_USD,
          description: "Tokenized-asset eligibility screen (deterministic, jurisdiction-aware)",
        })
      )
        return;

      const body = (req as any).body ?? {};
      const ticker = typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
      if (!TICKER_RE.test(ticker)) {
        res.status(400).json({ error: "Invalid ticker. Expected 1-6 uppercase letters A-Z (e.g. NVDA)." });
        return;
      }
      const jurisdiction =
        typeof body.jurisdiction === "string" && body.jurisdiction.trim()
          ? body.jurisdiction.trim()
          : "US";

      // Identify the underlying with REAL data (also validates it exists).
      let market: MarketData | null;
      try {
        market = await fetchYahoo(ticker);
      } catch (err) {
        res.status(502).json({ error: "Failed to fetch market data. Try again shortly." });
        return;
      }
      if (!market) {
        res.status(400).json({ error: `Ticker not found or unsupported: ${ticker}.` });
        return;
      }

      const pay = await settleRwaPayment(runtime, req, res, {
        priceUsd: ELIGIBILITY_PRICE_USD,
        description: `Tokenized-asset eligibility: ${ticker} (${jurisdiction})`,
      });
      if (!pay.paid) return;

      const assessment = assessEligibility(jurisdiction);
      const summary =
        assessment.eligible === "no"
          ? `${ticker} tokenized on Robinhood Chain is NOT accessible to US persons. ${assessment.reason}`
          : `${ticker} tokenized on Robinhood Chain is not blocked for a non-US person in ${assessment.jurisdiction}, but access is conditional. ${assessment.reason}`;

      res.json({
        ticker,
        underlying: { exchange: market.exchange, currency: market.currency, lastPrice: market.price },
        chain: {
          name: "Robinhood Chain",
          chainId: "eip155:4663",
          asset: "tokenized equity (stock token)",
          settlement: "gasless USDG",
        },
        jurisdiction: assessment.jurisdiction,
        eligibility: { status: assessment.eligible, usPerson: assessment.usPerson, reason: assessment.reason },
        summary,
        template: "RwaEligibility",
        disclaimer:
          "Informational compliance screen only — NOT legal, tax, or investment advice. Tokenized-equity " +
          "availability is governed by Robinhood's terms and local law; verify directly with Robinhood before acting.",
        freeRemaining: pay.gate.freeRemaining,
        payment: paymentBlock(pay.paidWithRhChain, pay.gate, ELIGIBILITY_PRICE_USD),
      });
    },
  },

  // ── POST /x402/rwa/catalyst — $0.29 ──────────────────────────────────
  {
    type: "POST",
    path: "/x402/rwa/catalyst",
    handler: async (req, res, runtime) => {
      if (
        await answeredDiscoveryProbe(runtime, req, res, {
          priceUsd: CATALYST_PRICE_USD,
          description: "Tokenized-stock catalyst brief: dividends, splits, notable moves",
        })
      )
        return;

      const body = (req as any).body ?? {};
      const ticker = typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
      if (!TICKER_RE.test(ticker)) {
        res.status(400).json({ error: "Invalid ticker. Expected 1-6 uppercase letters A-Z (e.g. AAPL)." });
        return;
      }

      let data: CatalystData | null;
      try {
        data = await fetchCatalystData(ticker);
      } catch (err) {
        runtime.logger.warn(
          { error: err instanceof Error ? err.message : String(err), ticker },
          "[x402/rwa/catalyst] Yahoo fetch failed"
        );
        res.status(502).json({ error: "Failed to fetch market data. Try again shortly." });
        return;
      }
      if (!data) {
        res.status(400).json({ error: `Ticker not found or no data available: ${ticker}.` });
        return;
      }

      const pay = await settleRwaPayment(runtime, req, res, {
        priceUsd: CATALYST_PRICE_USD,
        description: `Tokenized-stock catalyst brief: ${ticker}`,
      });
      if (!pay.paid) return;

      const facts =
        `Ticker: ${ticker} (${data.exchange})\nLast price: ${data.price} ${data.currency}\n` +
        `Trailing-12mo dividends: ${data.ttmDividend} (${data.dividendYieldPct}% yield)\n` +
        `Recent dividends: ${data.dividends.slice(0, 5).map((d) => `${d.date}=${d.amount}`).join(", ") || "none in the last year"}\n` +
        `Stock splits: ${data.splits.slice(0, 3).map((s) => `${s.date} ${s.ratio}`).join(", ") || "none in the last year"}\n` +
        `Notable single-day moves (>=5%): ${data.recentMoves.map((m) => `${m.date} ${m.changePct}%`).join(", ") || "none in the last ~60 sessions"}\n` +
        `NOTE: Future earnings dates and forward guidance are NOT in this data.`;

      let brief = "";
      let via: "llm" | "deterministic" = "deterministic";
      const parsed = await llmExtractJson(
        runtime,
        "You write a concise corporate-actions/catalyst brief for an equity using ONLY the provided facts. " +
          "Do NOT invent earnings dates, guidance, or numbers not present. Output ONLY minified JSON, no fences.",
        `${facts}\n\nReturn {"brief":"<= 90 words, plain English, mention dividend cadence/yield, any splits, and ` +
          `notable moves; explicitly say if future earnings dates are unavailable"}.`
      );
      if (parsed && typeof parsed.brief === "string" && parsed.brief.trim()) {
        brief = parsed.brief.trim();
        via = "llm";
      } else {
        const parts: string[] = [];
        parts.push(
          data.ttmDividend > 0
            ? `${ticker} paid ${data.ttmDividend} ${data.currency} in dividends over the last year (~${data.dividendYieldPct}% yield).`
            : `${ticker} paid no dividends in the last year.`
        );
        if (data.splits.length) parts.push(`Most recent split: ${data.splits[0].date} (${data.splits[0].ratio}).`);
        parts.push(
          data.recentMoves.length
            ? `${data.recentMoves.length} notable single-day move(s) >=5% in the last ~60 sessions; largest ${data.recentMoves[0].changePct}% on ${data.recentMoves[0].date}.`
            : "No single-day moves >=5% in the last ~60 sessions."
        );
        parts.push("Future earnings dates are not available from this data source.");
        brief = parts.join(" ");
      }

      res.json({
        ticker,
        asOf: data.asOf,
        price: data.price,
        currency: data.currency,
        exchange: data.exchange,
        dividends: data.dividends,
        ttmDividend: data.ttmDividend,
        dividendYieldPct: data.dividendYieldPct,
        splits: data.splits,
        recentMoves: data.recentMoves,
        nextEarningsDate: null,
        brief,
        via,
        template: "RwaCatalyst",
        disclaimer: DISCLAIMER,
        freeRemaining: pay.gate.freeRemaining,
        payment: paymentBlock(pay.paidWithRhChain, pay.gate, CATALYST_PRICE_USD),
      });
    },
  },
];
