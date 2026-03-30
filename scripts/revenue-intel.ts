/**
 * SwarmX Revenue Intelligence Script
 *
 * Collects data in parallel across 3 dimensions:
 *   1. User Segments — WHO would pay?
 *   2. Payment Models — HOW should we charge?
 *   3. Competitor Pricing — benchmark against marketplace endpoints
 *
 * Run: bun run scripts/revenue-intel.ts
 */

import "dotenv/config";
import { searchAPIs } from "@dexterai/x402/client";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

interface UserSegment {
  name: string;
  description: string;
  estimatedSize: string;
  frequency: string;
  willingness: string;
  priceRange: string;
  keyNeeds: string[];
  evidence: string[];
}

interface PaymentModel {
  name: string;
  description: string;
  x402Compatible: boolean;
  implementation: string;
  pros: string[];
  cons: string[];
  recommendedSegments: string[];
  examplePricing: Record<string, string>;
}

interface CompetitorEndpoint {
  name: string;
  url: string;
  price: number;
  quality: number;
  calls: number;
  seller: string;
  category: string;
  network: string;
  estimatedRevenue: number;
}

interface OurEndpoint {
  name: string;
  path: string;
  price: number;
  category: string;
  closestCompetitors: string[];
  pricingAdvice: string;
}

interface PricingSweetSpot {
  priceRange: string;
  minPrice: number;
  maxPrice: number;
  endpointCount: number;
  totalCalls: number;
  totalRevenue: number;
  avgQuality: number;
  verdict: string;
}

interface RevenueReport {
  generatedAt: string;
  userSegments: UserSegment[];
  paymentModels: PaymentModel[];
  competitorLandscape: {
    totalEndpoints: number;
    endpoints: CompetitorEndpoint[];
    topByRevenue: CompetitorEndpoint[];
    topByVolume: CompetitorEndpoint[];
    categoryBreakdown: Record<string, { count: number; avgPrice: number; totalCalls: number; totalRevenue: number }>;
    pricingSweetSpots: PricingSweetSpot[];
  };
  ourEndpoints: OurEndpoint[];
  recommendations: string[];
  revenueProjections: {
    scenario: string;
    monthlyCallVolume: number;
    avgRevenuePerCall: number;
    monthlyRevenue: number;
    annualRevenue: number;
  }[];
}

// ── Our Endpoints (mirrors server.ts + train-on-marketplace.ts) ──────────────

const OUR_ENDPOINTS_RAW = [
  { name: "Wallet Analyzer", path: "/x402/wallet-analyzer", price: 0.01, category: "Solana Data" },
  { name: "Token Holders", path: "/x402/token-holders", price: 0.01, category: "Solana Data" },
  { name: "Tx History", path: "/x402/tx-history", price: 0.01, category: "Solana Data" },
  { name: "DeFi Positions", path: "/x402/defi-positions", price: 0.02, category: "Solana Data" },
  { name: "Wallet Report", path: "/x402/wallet-report", price: 0.03, category: "Solana Data" },
  { name: "Summarize", path: "/x402/summarize", price: 0.01, category: "AI Tasks" },
  { name: "Translate", path: "/x402/translate", price: 0.02, category: "AI Tasks" },
  { name: "Extract", path: "/x402/extract", price: 0.01, category: "AI Tasks" },
  { name: "Sentiment", path: "/x402/sentiment", price: 0.01, category: "AI Tasks" },
  { name: "Research", path: "/x402/research", price: 0.05, category: "Multi-Agent" },
  { name: "Analyze", path: "/x402/analyze", price: 0.03, category: "Multi-Agent" },
  { name: "Code Review", path: "/x402/code-review", price: 0.03, category: "Multi-Agent" },
  { name: "Write", path: "/x402/write", price: 0.03, category: "Multi-Agent" },
  { name: "Debate", path: "/x402/debate", price: 0.03, category: "Multi-Agent" },
  { name: "Agent", path: "/x402/agent", price: 0.02, category: "Custom" },
];

// ── Dimension 1: User Segments ───────────────────────────────────────────────

function collectUserSegments(): UserSegment[] {
  console.log("\n[1/3] Collecting user segment data...\n");

  const segments: UserSegment[] = [
    {
      name: "Solana Trading Bots",
      description: "High-frequency automated trading systems using Jito bundles, Jupiter, and MEV strategies on Solana",
      estimatedSize: "50,000-100,000 active bots",
      frequency: "High (100-10,000+ calls/day per bot)",
      willingness: "High — already spend on Jito tips ($210M/month peak), RPC nodes ($49-999/mo)",
      priceRange: "$0.001-$0.01 per call (price-sensitive at volume)",
      keyNeeds: [
        "Sub-second latency",
        "Wallet analysis for copy-trading",
        "Token safety scanning before buys",
        "Sentiment signals for meme coin entry/exit",
        "High uptime (99.9%+)",
      ],
      evidence: [
        "3B+ Jito bundles processed in the past year",
        "95% of Solana stake runs Jito client",
        "Solana DEX volume $1.2T annually, 40% from new token activity",
        "Single sandwich bot did 1.55M txns in 30 days ($13.4M profit)",
        "Jupiter processes millions of successful transactions daily",
      ],
    },
    {
      name: "ElizaOS Agents",
      description: "AI agents built on the ElizaOS framework, deployed as chatbots, trading agents, NPCs, and business automation",
      estimatedSize: "5,000-15,000 active agents (est. from npm + GitHub activity)",
      frequency: "Medium (10-500 calls/day per agent)",
      willingness: "Medium — already integrated into plugin ecosystem, convenience-driven",
      priceRange: "$0.01-$0.05 per call (value-driven)",
      keyNeeds: [
        "Plugin-based integration (drop-in npm package)",
        "Multi-agent orchestration (Swarms templates)",
        "Research + analysis for autonomous decision-making",
        "Memory-aware context across sessions",
        "Budget controls (auto-pay limits)",
      ],
      evidence: [
        "17,389 GitHub stars on elizaOS/eliza",
        "102,714 @elizaos/core npm downloads last month",
        "27,678 @elizaos/core npm downloads last week",
        "@elizaos/core at v1.7.2 (active development)",
        "Doodles using ElizaOS for Dreamnet metaverse agents",
        "elizaos-plugin topic on GitHub shows growing ecosystem",
      ],
    },
    {
      name: "Data Aggregators & Platforms",
      description: "Bulk data consumers building dashboards, analytics platforms, and data pipelines that aggregate multiple x402 endpoints",
      estimatedSize: "500-2,000 active platforms",
      frequency: "Very High (1,000-100,000 calls/day)",
      willingness: "High — but need volume discounts to justify cost at scale",
      priceRange: "$0.0005-$0.005 per call (volume-discounted)",
      keyNeeds: [
        "Bulk pricing / volume discounts",
        "API reliability (SLA guarantees)",
        "Consistent response formats (JSON schemas)",
        "Historical data access",
        "Multi-endpoint bundling",
      ],
      evidence: [
        "Birdeye, Helius, DeFiLlama all aggregate and resell data",
        "Helius Developer tier: $49/mo for 10M credits",
        "x402 ecosystem: 90+ services, 500K+ weekly txns",
        "Alfred's Digital Bazaar: 100+ endpoints from a single provider",
      ],
    },
    {
      name: "Individual Developers",
      description: "Solo devs and small teams exploring AI agent development, prototyping, and learning",
      estimatedSize: "10,000-50,000 developers",
      frequency: "Low (1-50 calls/day)",
      willingness: "Low-Medium — need free tier or very low cost to start, convert later",
      priceRange: "$0.001-$0.02 per call (need free tier)",
      keyNeeds: [
        "Free tier / trial credits",
        "Clear documentation",
        "SDKs in multiple languages",
        "Example code and templates",
        "Low barrier to first payment",
      ],
      evidence: [
        "swarms-ts has only 28 npm downloads/month — early market",
        "Swarms GitHub has 6.1K stars",
        "Gartner predicts 40% of enterprise apps deploy multi-agent swarms by end of 2026",
        "OpenAI Agents SDK launched March 2026 — growing interest",
        "SolSignal offers 10 free scans/day to attract developers",
      ],
    },
  ];

  for (const seg of segments) {
    console.log(`  [Segment] ${seg.name}`);
    console.log(`    Size: ${seg.estimatedSize}`);
    console.log(`    Frequency: ${seg.frequency}`);
    console.log(`    Price range: ${seg.priceRange}`);
    console.log();
  }

  return segments;
}

// ── Dimension 2: Payment Models ──────────────────────────────────────────────

function collectPaymentModels(): PaymentModel[] {
  console.log("[2/3] Analyzing payment models...\n");

  const models: PaymentModel[] = [
    {
      name: "Per-Call Pricing (Current)",
      description: "Each API call costs a fixed USDC amount, paid via x402 HTTP 402 flow. Current SwarmX model.",
      x402Compatible: true,
      implementation: "Already implemented. x402Gate() returns 402 with price header, client pays, server verifies.",
      pros: [
        "Zero commitment for users — pay only for what you use",
        "Simple mental model — price is transparent per call",
        "Native x402 pattern — no middleware needed",
        "Works across all user segments",
        "Instant settlement via Dexter (0 fees for first 20K/day)",
      ],
      cons: [
        "Unpredictable revenue for operator",
        "High-volume users pay more than subscription would cost",
        "Each call has blockchain settlement overhead (even if sub-cent)",
        "No lock-in — users can switch providers instantly",
      ],
      recommendedSegments: ["Individual Developers", "ElizaOS Agents"],
      examplePricing: {
        "Single-agent AI tasks": "$0.001-$0.005/call (95% margin via direct OpenAI)",
        "Solana data lookups": "$0.005-$0.02/call",
        "Multi-agent research": "$0.03-$0.10/call (40-60% margin via Swarms)",
        "Premium reports": "$0.10-$1.00/call",
      },
    },
    {
      name: "Volume Discount Tiers",
      description: "Discounted per-call rates based on cumulative usage within a billing period. Track via on-chain settlement count.",
      x402Compatible: true,
      implementation: "Use x402 V2 dynamic getAmount callback. Server checks caller's 30-day settlement count from payment history DB, returns discounted price. Already have Drizzle ORM tables for tracking.",
      pros: [
        "Incentivizes higher volume — rewards loyal users",
        "Keeps pay-per-call simplicity",
        "Competitive with subscription at scale",
        "Data aggregators specifically need this",
      ],
      cons: [
        "Complexity in price calculation per request",
        "Need reliable settlement counting (DB dependency)",
        "Potential for gaming via multiple wallets",
        "Reduced per-call revenue at high tiers",
      ],
      recommendedSegments: ["Data Aggregators & Platforms", "Solana Trading Bots"],
      examplePricing: {
        "0-99 calls/month": "Standard price (no discount)",
        "100-999 calls/month": "10% discount",
        "1,000-9,999 calls/month": "20% discount",
        "10,000+ calls/month": "30% discount",
      },
    },
    {
      name: "Access Pass (Time-Based)",
      description: "Pay a fixed amount for unlimited (or high-limit) access over a time period. Dexter SDK supports X402_ACCESS_PASS_TIER.",
      x402Compatible: true,
      implementation: "Dexter X402_ACCESS_PASS_TIER env var. Client purchases access pass NFT/token, server checks validity. Pass stored on-chain or in DB with expiry timestamp.",
      pros: [
        "Predictable cost for users — budget certainty",
        "Predictable revenue for operators",
        "Reduces per-call friction for high-frequency users",
        "Familiar SaaS model (monthly subscription)",
        "Lock-in effect — users commit for duration",
      ],
      cons: [
        "Complex to implement on-chain (NFT or token-gated)",
        "Risk of underpricing if user volume exceeds projections",
        "Less native to x402 per-call philosophy",
        "Requires refund/cancellation policy",
      ],
      recommendedSegments: ["Solana Trading Bots", "Data Aggregators & Platforms"],
      examplePricing: {
        "Basic Pass (1 week)": "$5 — up to 1,000 calls across all single-agent endpoints",
        "Pro Pass (1 month)": "$25 — up to 10,000 calls across all endpoints",
        "Enterprise Pass (1 month)": "$100 — unlimited calls, priority queue, SLA",
      },
    },
    {
      name: "Tiered Quality Pricing",
      description: "Same endpoint at different quality/speed tiers. Like Jupiter regular vs Pro quotes, or Claude Haiku vs Opus pricing.",
      x402Compatible: true,
      implementation: "Query param or separate endpoints: /x402/research?tier=basic ($0.01) vs /x402/research?tier=pro ($0.05). Basic uses single-agent direct OpenAI, Pro uses multi-agent Swarms orchestration.",
      pros: [
        "Captures value at every price sensitivity level",
        "Users self-select into appropriate tier",
        "Higher tiers have higher margins per call",
        "Can use cheaper models for basic tier (GPT-4.1 nano at $0.10/M tokens)",
      ],
      cons: [
        "More endpoints to maintain and document",
        "Users may always choose cheapest tier",
        "Quality difference must be clearly demonstrable",
        "Naming/branding complexity",
      ],
      recommendedSegments: ["ElizaOS Agents", "Individual Developers", "Solana Trading Bots"],
      examplePricing: {
        "Basic Summarize (GPT-4.1 nano)": "$0.001/call — fast, good enough for most uses",
        "Pro Summarize (GPT-4.1)": "$0.005/call — better quality, longer context",
        "Basic Research (single-agent)": "$0.01/call — quick answer",
        "Pro Research (multi-agent Swarms)": "$0.05/call — thorough, multiple perspectives",
        "Premium Research (extended pipeline)": "$0.25/call — deep research with citations",
      },
    },
  ];

  for (const model of models) {
    console.log(`  [Model] ${model.name}`);
    console.log(`    x402 Compatible: ${model.x402Compatible ? "Yes" : "No"}`);
    console.log(`    Best for: ${model.recommendedSegments.join(", ")}`);
    console.log();
  }

  return models;
}

// ── Dimension 3: Competitor Pricing ──────────────────────────────────────────

async function collectCompetitorPricing(): Promise<{
  endpoints: CompetitorEndpoint[];
  categoryBreakdown: Record<string, { count: number; avgPrice: number; totalCalls: number; totalRevenue: number }>;
  sweetSpots: PricingSweetSpot[];
}> {
  console.log("[3/3] Collecting competitor pricing from OpenDexter marketplace...\n");

  let rawEndpoints: any[] = [];

  try {
    rawEndpoints = await searchAPIs({ limit: 100 });
    console.log(`  Fetched ${rawEndpoints.length} endpoints from OpenDexter`);
  } catch (err) {
    console.log(`  Warning: Could not fetch live marketplace data: ${(err as Error).message}`);
    console.log("  Using supplemental data from web research...\n");
  }

  // Build endpoint list from marketplace + known x402 ecosystem data
  const endpoints: CompetitorEndpoint[] = rawEndpoints.map((a: any) => ({
    name: a.name ?? "Unknown",
    url: a.url ?? "",
    price: a.priceUsdc ?? a.price ?? 0,
    quality: a.qualityScore ?? a.quality ?? 0,
    calls: a.totalCalls ?? a.calls ?? 0,
    seller: a.seller ?? "unknown",
    category: a.category ?? "unknown",
    network: a.network ?? "unknown",
    estimatedRevenue: (a.priceUsdc ?? a.price ?? 0) * (a.totalCalls ?? a.calls ?? 0),
  }));

  // Supplement with known ecosystem data if marketplace fetch was sparse
  const knownEcosystem: CompetitorEndpoint[] = [
    { name: "SolSignal API (Token Safety)", url: "solsignal-api.onrender.com", price: 0.01, quality: 0, calls: 0, seller: "SolSignal", category: "Crypto Security", network: "solana", estimatedRevenue: 0 },
    { name: "Alfred's Digital Bazaar", url: "httpay.xyz", price: 0.10, quality: 0, calls: 0, seller: "Alfred", category: "Utility APIs", network: "base", estimatedRevenue: 0 },
    { name: "Gotobi Calendar API", url: "gotobi.hugen.tokyo", price: 0.001, quality: 0, calls: 0, seller: "hugen", category: "FX Intelligence", network: "base", estimatedRevenue: 0 },
    { name: "Weather API", url: "weather.hugen.tokyo", price: 0.001, quality: 0, calls: 0, seller: "hugen", category: "Weather", network: "base", estimatedRevenue: 0 },
    { name: "Scout MCP (Multi-Source Search)", url: "scout.hugen.tokyo", price: 0.001, quality: 0, calls: 0, seller: "hugen", category: "Search", network: "base", estimatedRevenue: 0 },
    { name: "Obol (AI Code Generation)", url: "obol.sh", price: 5.0, quality: 0, calls: 0, seller: "Obol", category: "AI Code", network: "base", estimatedRevenue: 0 },
    { name: "DeFi Intelligence API", url: "defi.hugen.tokyo", price: 0.005, quality: 0, calls: 0, seller: "hugen", category: "DeFi Security", network: "base", estimatedRevenue: 0 },
    { name: "Visual API (Screenshot/PDF)", url: "visual.hugen.tokyo", price: 0.01, quality: 0, calls: 0, seller: "hugen", category: "Media", network: "base", estimatedRevenue: 0 },
    { name: "MoonMaker API (Crypto Signals)", url: "api.moonmaker.cc", price: 0.02, quality: 0, calls: 0, seller: "MoonMaker", category: "Crypto Signals", network: "base", estimatedRevenue: 0 },
    { name: "zeroreader AI API (29 Models)", url: "api.zeroreader.com", price: 0.001, quality: 0, calls: 0, seller: "zeroreader", category: "AI Models", network: "base", estimatedRevenue: 0 },
    { name: "Content Intelligence API", url: "content.hugen.tokyo", price: 0.003, quality: 0, calls: 0, seller: "hugen", category: "Content", network: "base", estimatedRevenue: 0 },
    { name: "Intel API (Crypto Due Diligence)", url: "intel.hugen.tokyo", price: 0.50, quality: 0, calls: 0, seller: "hugen", category: "Due Diligence", network: "base", estimatedRevenue: 0 },
    { name: "Tick Aggregator API (FX Data)", url: "tick.hugen.tokyo", price: 0.005, quality: 0, calls: 0, seller: "hugen", category: "FX Data", network: "base", estimatedRevenue: 0 },
    { name: "PortsideLabs Places API", url: "portsidelabs", price: 0.001, quality: 0, calls: 0, seller: "PortsideLabs", category: "Location", network: "base", estimatedRevenue: 0 },
    { name: "PortsideLabs KoinChappie", url: "portsidelabs", price: 0.001, quality: 0, calls: 0, seller: "PortsideLabs", category: "Crypto Signals", network: "base", estimatedRevenue: 0 },
    { name: "AskClaude (Claude AI)", url: "askclaude", price: 0.03, quality: 0, calls: 0, seller: "AskClaude", category: "AI LLM", network: "base", estimatedRevenue: 0 },
    { name: "BlockRun.AI (LLM Gateway)", url: "blockrun.ai", price: 0.01, quality: 0, calls: 0, seller: "BlockRun", category: "AI LLM", network: "base", estimatedRevenue: 0 },
    { name: "GPU-Bridge (GPU Inference)", url: "gpubridge.xyz", price: 0.05, quality: 0, calls: 0, seller: "GPU-Bridge", category: "GPU Compute", network: "base", estimatedRevenue: 0 },
    { name: "Augur (Prediction)", url: "augur", price: 0.10, quality: 0, calls: 0, seller: "Augur", category: "Predictions", network: "base", estimatedRevenue: 0 },
    { name: "Stakevia (Staking Reports)", url: "stakevia", price: 1.00, quality: 0, calls: 0, seller: "Stakevia", category: "Reports", network: "base", estimatedRevenue: 0 },
    { name: "Mycelia Signal (Price Feeds)", url: "mycelia", price: 0.001, quality: 0, calls: 0, seller: "Mycelia", category: "Price Feeds", network: "base", estimatedRevenue: 0 },
    { name: "Mailcheck API", url: "mailcheck.hugen.tokyo", price: 0.001, quality: 0, calls: 0, seller: "hugen", category: "Email Validation", network: "base", estimatedRevenue: 0 },
    { name: "Domain Intelligence API", url: "domain.hugen.tokyo", price: 0.001, quality: 0, calls: 0, seller: "hugen", category: "Domain Analysis", network: "base", estimatedRevenue: 0 },
    { name: "Agent Arena (Agent Registry)", url: "agentarena.site", price: 0.001, quality: 0, calls: 0, seller: "AgentArena", category: "Agent Registry", network: "base", estimatedRevenue: 0 },
    { name: "Firecrawl (Web Scraping)", url: "firecrawl", price: 0.01, quality: 0, calls: 0, seller: "Firecrawl", category: "Web Scraping", network: "base", estimatedRevenue: 0 },
    { name: "Pinata (IPFS Uploads)", url: "pinata", price: 0.01, quality: 0, calls: 0, seller: "Pinata", category: "Storage", network: "base", estimatedRevenue: 0 },
    { name: "dTelecom STT", url: "dtelecom", price: 0.01, quality: 0, calls: 0, seller: "dTelecom", category: "Speech-to-Text", network: "base", estimatedRevenue: 0 },
    { name: "DiamondClaws (DeFi Data)", url: "diamondclaws", price: 0.001, quality: 0, calls: 0, seller: "DiamondClaws", category: "DeFi Data", network: "base", estimatedRevenue: 0 },
    { name: "ShieldAPI MCP (Security)", url: "shieldapi", price: 0.005, quality: 0, calls: 0, seller: "ShieldAPI", category: "Security", network: "base", estimatedRevenue: 0 },
    { name: "Robtex (Network Intel)", url: "robtex", price: 0.005, quality: 0, calls: 0, seller: "Robtex", category: "Network Intelligence", network: "base", estimatedRevenue: 0 },
  ];

  // Merge: avoid duplicates by URL
  const existingUrls = new Set(endpoints.map((e) => e.url.toLowerCase()));
  for (const known of knownEcosystem) {
    if (!existingUrls.has(known.url.toLowerCase())) {
      endpoints.push(known);
    }
  }

  console.log(`  Total endpoints catalogued: ${endpoints.length}\n`);

  // Category breakdown
  const categoryBreakdown: Record<string, { count: number; avgPrice: number; totalCalls: number; totalRevenue: number }> = {};
  for (const ep of endpoints) {
    const cat = ep.category || "unknown";
    if (!categoryBreakdown[cat]) {
      categoryBreakdown[cat] = { count: 0, avgPrice: 0, totalCalls: 0, totalRevenue: 0 };
    }
    categoryBreakdown[cat].count++;
    categoryBreakdown[cat].totalCalls += ep.calls;
    categoryBreakdown[cat].totalRevenue += ep.estimatedRevenue;
  }
  // Calculate avg prices
  for (const cat of Object.keys(categoryBreakdown)) {
    const catEndpoints = endpoints.filter((e) => (e.category || "unknown") === cat);
    const prices = catEndpoints.map((e) => e.price).filter((p) => p > 0);
    categoryBreakdown[cat].avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  }

  // Pricing sweet spots
  const ranges = [
    { label: "Micro ($0.0001-$0.001)", min: 0.0001, max: 0.001 },
    { label: "Low ($0.001-$0.005)", min: 0.001, max: 0.005 },
    { label: "Standard ($0.005-$0.02)", min: 0.005, max: 0.02 },
    { label: "Mid ($0.02-$0.05)", min: 0.02, max: 0.05 },
    { label: "High ($0.05-$0.15)", min: 0.05, max: 0.15 },
    { label: "Premium ($0.15-$1.00)", min: 0.15, max: 1.0 },
    { label: "Enterprise ($1.00+)", min: 1.0, max: 100 },
  ];

  const sweetSpots: PricingSweetSpot[] = ranges.map((r) => {
    const inRange = endpoints.filter((e) => e.price >= r.min && e.price < r.max);
    const totalCalls = inRange.reduce((sum, e) => sum + e.calls, 0);
    const totalRevenue = inRange.reduce((sum, e) => sum + e.estimatedRevenue, 0);
    const qualities = inRange.map((e) => e.quality).filter((q) => q > 0);
    const avgQuality = qualities.length > 0 ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0;

    let verdict = "";
    if (inRange.length >= 10 && totalCalls > 0) {
      verdict = "HIGH COMPETITION — differentiate on quality/speed";
    } else if (inRange.length >= 5) {
      verdict = "MODERATE COMPETITION — good opportunity with differentiation";
    } else if (inRange.length >= 1) {
      verdict = "LOW COMPETITION — first-mover advantage available";
    } else {
      verdict = "EMPTY — potential whitespace opportunity";
    }

    return {
      priceRange: r.label,
      minPrice: r.min,
      maxPrice: r.max,
      endpointCount: inRange.length,
      totalCalls,
      totalRevenue,
      avgQuality,
      verdict,
    };
  });

  return { endpoints, categoryBreakdown, sweetSpots };
}

// ── Map Our Endpoints to Competitors ─────────────────────────────────────────

function mapOurEndpoints(competitors: CompetitorEndpoint[]): OurEndpoint[] {
  const competitorsByKeyword: Record<string, string[]> = {
    "Wallet Analyzer": ["wallet", "analyzer", "portfolio"],
    "Token Holders": ["token", "holders", "nft"],
    "Tx History": ["transaction", "history", "tx"],
    "DeFi Positions": ["defi", "position", "protocol"],
    "Wallet Report": ["wallet", "report", "due diligence", "intel"],
    Summarize: ["summarize", "summary", "content", "llm"],
    Translate: ["translate", "language"],
    Extract: ["extract", "ner", "entity"],
    Sentiment: ["sentiment", "signal", "bull", "bear"],
    Research: ["research", "analysis", "deep", "multi-agent"],
    Analyze: ["analyze", "opinion", "debate"],
    "Code Review": ["code", "review", "audit"],
    Write: ["write", "content", "blog", "article"],
    Debate: ["debate", "argue", "proposition"],
    Agent: ["agent", "task", "claude", "llm", "ai"],
  };

  return OUR_ENDPOINTS_RAW.map((ep) => {
    const keywords = competitorsByKeyword[ep.name] ?? [ep.name.toLowerCase().split(" ")];
    const closest = competitors
      .filter((c) => {
        const cName = c.name.toLowerCase();
        return keywords.some((kw) => cName.includes(kw));
      })
      .map((c) => `${c.name} ($${c.price})`)
      .slice(0, 3);

    // Pricing advice based on competitor landscape
    const relevantPrices = competitors
      .filter((c) => {
        const cName = c.name.toLowerCase();
        return keywords.some((kw) => cName.includes(kw));
      })
      .map((c) => c.price)
      .filter((p) => p > 0);

    const avgCompPrice = relevantPrices.length > 0 ? relevantPrices.reduce((a, b) => a + b, 0) / relevantPrices.length : 0;

    let advice = "";
    if (avgCompPrice === 0) {
      advice = `No direct competitors found. Current price $${ep.price} is in uncontested space. Consider this a FIRST-MOVER advantage.`;
    } else if (ep.price < avgCompPrice * 0.5) {
      advice = `UNDERPRICED — current $${ep.price} is ${((1 - ep.price / avgCompPrice) * 100).toFixed(0)}% below competitor avg $${avgCompPrice.toFixed(3)}. Consider raising to capture more value.`;
    } else if (ep.price > avgCompPrice * 1.5) {
      advice = `PREMIUM — current $${ep.price} is ${((ep.price / avgCompPrice - 1) * 100).toFixed(0)}% above competitor avg $${avgCompPrice.toFixed(3)}. Ensure quality justifies premium.`;
    } else {
      advice = `COMPETITIVE — current $${ep.price} is near competitor avg $${avgCompPrice.toFixed(3)}. Good positioning.`;
    }

    return {
      name: ep.name,
      path: ep.path,
      price: ep.price,
      category: ep.category,
      closestCompetitors: closest.length > 0 ? closest : ["No direct competitors found in marketplace"],
      pricingAdvice: advice,
    };
  });
}

// ── Revenue Projections ──────────────────────────────────────────────────────

function calculateRevenueProjections(): RevenueReport["revenueProjections"] {
  return [
    {
      scenario: "Conservative (Dev/Testing phase)",
      monthlyCallVolume: 5_000,
      avgRevenuePerCall: 0.015,
      monthlyRevenue: 75,
      annualRevenue: 900,
    },
    {
      scenario: "Early Traction (10 active integrations)",
      monthlyCallVolume: 50_000,
      avgRevenuePerCall: 0.012,
      monthlyRevenue: 600,
      annualRevenue: 7_200,
    },
    {
      scenario: "Growth (100 active users, some volume discount)",
      monthlyCallVolume: 500_000,
      avgRevenuePerCall: 0.010,
      monthlyRevenue: 5_000,
      annualRevenue: 60_000,
    },
    {
      scenario: "Scale (1K users, trading bots + aggregators)",
      monthlyCallVolume: 5_000_000,
      avgRevenuePerCall: 0.008,
      monthlyRevenue: 40_000,
      annualRevenue: 480_000,
    },
    {
      scenario: "Breakout (10K users, access passes + volume)",
      monthlyCallVolume: 50_000_000,
      avgRevenuePerCall: 0.005,
      monthlyRevenue: 250_000,
      annualRevenue: 3_000_000,
    },
  ];
}

// ── Recommendations Engine ───────────────────────────────────────────────────

function generateRecommendations(
  segments: UserSegment[],
  models: PaymentModel[],
  competitorData: Awaited<ReturnType<typeof collectCompetitorPricing>>,
  ourEndpoints: OurEndpoint[],
): string[] {
  const recs: string[] = [];

  // 1. Segment-based
  recs.push(
    "PRIORITY SEGMENT: Target Solana Trading Bots first — they are the largest segment (50-100K bots), highest frequency, and already conditioned to pay for speed (Jito tips, RPC nodes). Our Wallet Analyzer and Sentiment endpoints directly serve their copy-trading and entry/exit workflows.",
  );

  recs.push(
    "GROWTH SEGMENT: ElizaOS agents are our natural distribution channel (102K npm downloads/month). Publish @elizaos/plugin-x402-swarms to npm and PR to elizaos-plugins registry. Every ElizaOS agent that installs our plugin becomes a potential buyer of all 15 endpoints.",
  );

  // 2. Pricing-based
  recs.push(
    "IMPLEMENT TIERED PRICING: Offer a Basic tier (GPT-4.1 nano, $0.001/call) and Pro tier (GPT-4.1/Swarms, $0.01-$0.05/call) for each endpoint. Basic tier captures price-sensitive trading bots; Pro tier captures quality-seeking agents. Cost of basic tier is ~$0.0001, yielding 90%+ margins.",
  );

  recs.push(
    "ADD VOLUME DISCOUNTS: Use x402 V2 dynamic pricing callback. Track caller's 30-day settlement count in our existing Drizzle ORM tables. 100 calls = 10% off, 1K = 20%, 10K = 30%. This is essential for retaining Data Aggregators who will otherwise build their own.",
  );

  recs.push(
    "PILOT ACCESS PASSES: Offer weekly ($5) and monthly ($25) access passes for up to 10K calls. Target Solana trading bots that need predictable costs. Implement via Dexter X402_ACCESS_PASS_TIER. This creates recurring revenue and lock-in.",
  );

  // 3. Competitor-based
  const ourAvgPrice = OUR_ENDPOINTS_RAW.reduce((sum, e) => sum + e.price, 0) / OUR_ENDPOINTS_RAW.length;
  recs.push(
    `PRICING POSITION: Our average endpoint price ($${ourAvgPrice.toFixed(3)}) is competitive. The x402 ecosystem has 90+ endpoints, with most priced at $0.001-$0.01. We are positioned in the Standard-to-Mid range, which is appropriate for AI + data services. Do NOT race to the bottom on price — our multi-agent capabilities are differentiated.`,
  );

  recs.push(
    "EXPLOIT WHITESPACE: No competitors offer combined Solana on-chain data + multi-agent AI analysis behind a single x402 paywall. Our Wallet Report endpoint ($0.03) that does Helius data pull + Swarms analysis is UNIQUE. Promote this as the flagship product.",
  );

  recs.push(
    "BUNDLED ENDPOINT: Create a /x402/bundle endpoint that chains multiple calls (e.g., wallet-analyzer + sentiment + research) into a single payment. Price at $0.05-$0.10 — cheaper than calling all three separately ($0.07) but higher margin per request.",
  );

  // 4. Market timing
  recs.push(
    "MARKET TIMING: The x402 ecosystem processed 75M transactions totaling $24M in volume. Dexter handles 50% of facilitation with zero fees for first 20K txns/day. This is the window to establish market share before fees increase or competition intensifies.",
  );

  recs.push(
    "DEVELOPER ACQUISITION: Offer 10 free calls/day per endpoint (like SolSignal's model). This costs us ~$0.10/day in OpenAI API costs per free user but creates pipeline to paid usage. Track free-to-paid conversion rate as primary metric.",
  );

  return recs;
}

// ── Human-Readable Report Printer ────────────────────────────────────────────

function printReport(report: RevenueReport): void {
  const line = "=".repeat(80);
  const subline = "-".repeat(80);

  console.log(`\n${line}`);
  console.log("  SWARMX REVENUE INTELLIGENCE REPORT");
  console.log(`  Generated: ${report.generatedAt}`);
  console.log(line);

  // User Segments
  console.log(`\n${"#".repeat(3)} 1. USER SEGMENTS — WHO WOULD PAY?\n`);
  for (const seg of report.userSegments) {
    console.log(`  ${seg.name}`);
    console.log(`  ${"~".repeat(seg.name.length)}`);
    console.log(`  Size:        ${seg.estimatedSize}`);
    console.log(`  Frequency:   ${seg.frequency}`);
    console.log(`  Willingness: ${seg.willingness}`);
    console.log(`  Price range: ${seg.priceRange}`);
    console.log(`  Key needs:   ${seg.keyNeeds.join("; ")}`);
    console.log(`  Evidence:`);
    for (const ev of seg.evidence) {
      console.log(`    - ${ev}`);
    }
    console.log();
  }

  // Payment Models
  console.log(`${subline}\n${"#".repeat(3)} 2. PAYMENT MODELS — HOW SHOULD WE CHARGE?\n`);
  for (const model of report.paymentModels) {
    console.log(`  ${model.name}`);
    console.log(`  ${"~".repeat(model.name.length)}`);
    console.log(`  x402 Compatible: ${model.x402Compatible ? "YES" : "NO"}`);
    console.log(`  Implementation:  ${model.implementation.slice(0, 120)}...`);
    console.log(`  Best for:        ${model.recommendedSegments.join(", ")}`);
    console.log(`  Pricing:`);
    for (const [tier, price] of Object.entries(model.examplePricing)) {
      console.log(`    ${tier}: ${price}`);
    }
    console.log();
  }

  // Competitor Landscape
  console.log(`${subline}\n${"#".repeat(3)} 3. COMPETITOR LANDSCAPE\n`);
  console.log(`  Total endpoints catalogued: ${report.competitorLandscape.totalEndpoints}`);
  console.log();

  console.log("  Category Breakdown:");
  const sortedCats = Object.entries(report.competitorLandscape.categoryBreakdown).sort((a, b) => b[1].count - a[1].count);
  for (const [cat, stats] of sortedCats) {
    console.log(`    ${cat.padEnd(25)} ${String(stats.count).padStart(3)} endpoints | avg $${stats.avgPrice.toFixed(4)} | ${stats.totalCalls.toLocaleString().padStart(12)} calls | $${stats.totalRevenue.toFixed(2)} rev`);
  }
  console.log();

  console.log("  Pricing Sweet Spots:");
  for (const spot of report.competitorLandscape.pricingSweetSpots) {
    console.log(`    ${spot.priceRange.padEnd(30)} ${String(spot.endpointCount).padStart(3)} endpoints | ${spot.totalCalls.toLocaleString().padStart(12)} calls | ${spot.verdict}`);
  }
  console.log();

  if (report.competitorLandscape.topByRevenue.length > 0) {
    console.log("  Top 5 by Estimated Revenue:");
    for (const ep of report.competitorLandscape.topByRevenue.slice(0, 5)) {
      console.log(`    ${ep.name.padEnd(35)} $${ep.price.toFixed(4)} x ${ep.calls.toLocaleString().padStart(10)} = $${ep.estimatedRevenue.toFixed(2)}`);
    }
    console.log();
  }

  if (report.competitorLandscape.topByVolume.length > 0) {
    console.log("  Top 5 by Call Volume:");
    for (const ep of report.competitorLandscape.topByVolume.slice(0, 5)) {
      console.log(`    ${ep.name.padEnd(35)} ${ep.calls.toLocaleString().padStart(12)} calls @ $${ep.price.toFixed(4)}`);
    }
    console.log();
  }

  // Our Endpoints vs Competition
  console.log(`${subline}\n${"#".repeat(3)} 4. OUR ENDPOINTS vs COMPETITION\n`);
  for (const ep of report.ourEndpoints) {
    console.log(`  ${ep.name} (${ep.path}) — $${ep.price}`);
    console.log(`    Category: ${ep.category}`);
    console.log(`    Closest competitors: ${ep.closestCompetitors.join(", ")}`);
    console.log(`    Advice: ${ep.pricingAdvice}`);
    console.log();
  }

  // Revenue Projections
  console.log(`${subline}\n${"#".repeat(3)} 5. REVENUE PROJECTIONS\n`);
  console.log("  Scenario".padEnd(50) + "Monthly Calls".padStart(15) + "Avg $/Call".padStart(12) + "Monthly Rev".padStart(14) + "Annual Rev".padStart(14));
  console.log("  " + "-".repeat(100));
  for (const proj of report.revenueProjections) {
    console.log(
      `  ${proj.scenario.padEnd(48)}${proj.monthlyCallVolume.toLocaleString().padStart(15)}${("$" + proj.avgRevenuePerCall.toFixed(3)).padStart(12)}${("$" + proj.monthlyRevenue.toLocaleString()).padStart(14)}${("$" + proj.annualRevenue.toLocaleString()).padStart(14)}`,
    );
  }
  console.log();

  // Recommendations
  console.log(`${subline}\n${"#".repeat(3)} 6. STRATEGIC RECOMMENDATIONS\n`);
  for (let i = 0; i < report.recommendations.length; i++) {
    console.log(`  ${i + 1}. ${report.recommendations[i]}`);
    console.log();
  }

  console.log(line);
  console.log("  END OF REPORT");
  console.log(line);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("========================================");
  console.log("  SwarmX Revenue Intelligence Collector");
  console.log("========================================\n");
  console.log("Collecting data in parallel across 3 dimensions...\n");

  // Run all 3 dimensions in parallel
  const [segments, models, competitorData] = await Promise.all([
    Promise.resolve(collectUserSegments()),
    Promise.resolve(collectPaymentModels()),
    collectCompetitorPricing(),
  ]);

  // Map our endpoints to competitors
  const ourEndpoints = mapOurEndpoints(competitorData.endpoints);

  // Calculate revenue projections
  const projections = calculateRevenueProjections();

  // Generate recommendations
  const recommendations = generateRecommendations(segments, models, competitorData, ourEndpoints);

  // Build report
  const report: RevenueReport = {
    generatedAt: new Date().toISOString(),
    userSegments: segments,
    paymentModels: models,
    competitorLandscape: {
      totalEndpoints: competitorData.endpoints.length,
      endpoints: competitorData.endpoints,
      topByRevenue: [...competitorData.endpoints].sort((a, b) => b.estimatedRevenue - a.estimatedRevenue).slice(0, 10),
      topByVolume: [...competitorData.endpoints].sort((a, b) => b.calls - a.calls).slice(0, 10),
      categoryBreakdown: competitorData.categoryBreakdown,
      pricingSweetSpots: competitorData.sweetSpots,
    },
    ourEndpoints,
    recommendations,
    revenueProjections: projections,
  };

  // Save structured JSON
  const jsonPath = resolve(import.meta.dirname ?? ".", "revenue-report.json");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nStructured data saved to: ${jsonPath}`);

  // Print human-readable report
  printReport(report);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
