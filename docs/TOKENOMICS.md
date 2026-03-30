# Tokenomics: ElizaOS x402 Swarms Network

## No Native Token — Intentional Design

This protocol deliberately **does not issue a native token**. Payment flows use **USDC** stablecoins across 6 networks (Base, Ethereum, Solana, Polygon, Arbitrum) via the x402 standard and the Dexter SDK. This avoids speculative token dynamics and aligns incentives with actual usage.

> This is consistent with x402's design philosophy: "no native token despite widespread speculation around associated meme coins." (x402 Foundation, 2025)

## Economic Model

### Value Flows

```
Consumer Agent                  Service Provider
     │                                │
     │  $0.001–$0.10 USDC/call        │
     │ ─────────────────────────────► │
     │                                │
     │  Task result / data / compute  │
     │ ◄───────────────────────────── │
```

### Fee Structure

| Role | Fee |
|------|-----|
| Service provider | Sets own price (market-driven) |
| x402 facilitator (Dexter) | ~0% (20K free settlements/day) |
| Network gas | Sponsored by Dexter facilitator |
| This plugin | 0% (MIT open source) |

### Typical Cost Ranges

| Service Type | Cost per Call | Backend | Margin |
|-------------|---------------|---------|--------|
| Data lookup (oracle) | $0.0001 – $0.001 | x402 endpoint | N/A (data cost) |
| Web search | $0.001 – $0.01 | x402 endpoint | N/A (data cost) |
| Single-agent LLM task (summarize, translate, extract, sentiment) | $0.001 – $0.005 | Direct OpenAI | ~95% (sell at $0.02) |
| Single-agent endpoint (`/x402/agent`) | $0.001 – $0.005 | Direct OpenAI | ~90% (sell at $0.02) |
| Multi-agent swarm task (research, analyze, debate) | $0.01 – $0.10 | Swarms API | ~40-60% (Swarms per-token + per-agent fees) |
| Extended research pipeline | $0.10 – $1.00 | Swarms API | ~40-50% |

### LLM Routing Cost Optimization

Single-agent tasks call OpenAI directly via `src/utils/llm.ts`, bypassing Swarms overhead. This yields ~95% margins on simple tasks like summarization, translation, extraction, and sentiment analysis. Multi-agent tasks require Swarms orchestration (multiple agents coordinating server-side), so margins are lower at ~40-60% due to Swarms per-token and per-agent fees.

**Fallback behavior**: If `OPENAI_API_KEY` is not configured, all tasks route through Swarms. This works but reduces single-agent margins from ~95% to ~40-60%.

### Access Pass Model

Per-call pricing ($0.001-$0.10) works well for **multi-agent tasks** that are called occasionally and produce high-value results worth the x402 payment latency (HTTP 402 → sign → retry adds ~200-500ms). However, **data and trading endpoints** are called frequently (100-10K times/day by trading bots) and every millisecond of latency matters. The x402 per-call overhead is unacceptable at that frequency.

Access passes solve this by letting buyers **pay once upfront** for time-limited unlimited access. The Dexter SDK handles pass verification internally — after the initial purchase, subsequent requests skip the 402 → pay → retry cycle entirely and are served at normal HTTP latency.

#### Pricing Tiers

| Tier | Price | Duration | Target User | Equivalent Per-Call (at volume) |
|------|-------|----------|-------------|--------------------------------|
| Day Pass | $1 | 24 hours | Bots testing strategies, devs exploring | ~$0.001 at 1K calls |
| Week Pass | $5 | 7 days | Active trading bots, small aggregators | ~$0.0007 at 7K calls |
| Month Pass | $25 | 30 days | Production trading bots, data platforms | ~$0.0003 at 80K calls |

#### How It Works

```
1. Buyer calls any data endpoint → receives 402 with access pass pricing
2. Buyer's Dexter SDK pays the pass price (e.g. $5 for weekly)
3. Server records the pass (on-chain receipt + expiry timestamp)
4. All subsequent calls from that wallet are served instantly until expiry
   — no 402 negotiation, no payment signing, no extra latency
```

#### When to Use Each Model

| Model | Best For | Latency | Cost Efficiency |
|-------|----------|---------|-----------------|
| Per-call ($0.001-$0.10) | Multi-agent AI tasks (research, analyze, debate) | +200-500ms acceptable | Fair at low volume |
| Access pass ($1-$25) | Data endpoints (wallet, token, defi, sentiment) | Native HTTP latency | Better at high volume |

Configure via `X402_ACCESS_PASS_TIER` env var. The Dexter SDK advertises available pass tiers in the 402 response, and buyers choose their preferred tier.

### Agent Treasury Model

For production deployments, agents can be funded via:

1. **Direct deposit**: Fund agent wallet with USDC on any supported network
2. **Revenue sharing**: Agent earns USDC by exposing its own x402 endpoints (via server-side routes: `/x402/research`, `/x402/analyze`, `/x402/agent`)
3. **Budget caps**: `X402_MAX_AUTO_PAY_USD` per call, `X402_BUDGET_USD` per session, hourly rate limits
4. **Persistent budgets**: Daily/weekly/monthly budget tracking across sessions via Drizzle ORM schemas

### Revenue for Service Operators

Developers who expose ElizaOS agent capabilities as x402 endpoints earn:
- **USDC streamed per call**, no invoicing, instant settlement
- Sub-second finality on Base (~$0.00001 gas)
- No platform fees (permissionless protocol)

### Example: Self-Sustaining Agent

```
SignalHawk Agent (implemented example):
  Buys:  CoinGecko price data @ $0.01 + Exa sentiment search @ $0.03 = $0.04/signal
  Sells: Trading signal @ $0.10/call via /api/signals/generate
  Net margin: ~$0.06 per signal (60% margin, multi-agent Swarms task)
  Break-even: ~34 signals/day to cover $2 USDC hosting costs

Single-agent endpoint example (e.g. /x402/agent for summarization):
  Cost:  ~$0.001 (direct OpenAI call)
  Sells: $0.02/call
  Net margin: ~$0.019 per call (~95% margin)
  Break-even: ~106 calls/day to cover $2 USDC hosting costs
```

## Revenue Strategy

> Generated by `scripts/revenue-intel.ts` — run `bun run scripts/revenue-intel.ts` to refresh data. Full structured report at `scripts/revenue-report.json`.

### Target User Segments

| Segment | Est. Size | Call Frequency | Price Sensitivity | Priority |
|---------|-----------|---------------|-------------------|----------|
| Solana Trading Bots | 50-100K bots | 100-10K/day | High (need $0.001-$0.01) | **#1** |
| ElizaOS Agents | 5-15K agents | 10-500/day | Medium ($0.01-$0.05) | **#2** |
| Data Aggregators | 500-2K platforms | 1K-100K/day | Very High (need volume discounts) | #3 |
| Individual Developers | 10-50K devs | 1-50/day | Low-Medium (need free tier) | #4 |

**Why Solana Trading Bots first**: 3B+ Jito bundles/year, $210M/month peak in MEV tips, 95% of Solana stake running Jito. These bots already pay for speed and data. Our Wallet Analyzer and Sentiment endpoints map directly to their copy-trading and entry/exit workflows.

**Why ElizaOS second**: 102K @elizaos/core npm downloads/month, 17K GitHub stars. Every ElizaOS agent that installs our plugin is a potential buyer of all 15 endpoints.

### Payment Models (All x402-Compatible)

**1. Per-Call Pricing (Current)** -- retain as default for all segments.

| Endpoint Category | Price | Backend Cost | Margin |
|------------------|-------|-------------|--------|
| Single-agent AI (summarize, translate, extract, sentiment) | $0.001-$0.005 | ~$0.0001 (GPT-4.1 nano) | ~90-95% |
| Solana data (wallet, token, tx, defi) | $0.005-$0.02 | ~$0.001 (Helius API) | ~80-95% |
| Multi-agent (research, analyze, debate) | $0.03-$0.10 | ~$0.01-0.04 (Swarms) | ~40-60% |
| Premium reports (wallet report, extended research) | $0.10-$1.00 | ~$0.04-0.40 | ~40-60% |

**2. Volume Discounts** -- implement via x402 V2 dynamic `getAmount` callback.

| Monthly Calls | Discount |
|--------------|----------|
| 0-99 | 0% (standard price) |
| 100-999 | 10% |
| 1,000-9,999 | 20% |
| 10,000+ | 30% |

Track via existing Drizzle ORM `x402_payment_history` table (30-day rolling settlement count per caller address).

**3. Tiered Quality Pricing** -- same endpoint, different LLM backend.

| Tier | Backend | Example: /x402/research | Use Case |
|------|---------|------------------------|----------|
| Basic | GPT-4.1 nano (single-agent) | $0.01 | Quick answers, trading bots |
| Pro | GPT-4.1 (single-agent) | $0.05 | Quality-seeking agents |
| Premium | Multi-agent Swarms pipeline | $0.25 | Deep research with citations |

Implementation: query param `?tier=basic|pro|premium` or separate endpoints.

**4. Access Passes** -- for high-frequency data/trading endpoints.

| Pass | Price | Duration | Includes | Target |
|------|-------|----------|----------|--------|
| Day | $1 | 24 hours | Unlimited data endpoint calls | Devs exploring, bots testing |
| Week | $5 | 7 days | Unlimited data endpoint calls | Active trading bots |
| Month | $25 | 30 days | Unlimited data endpoint calls | Production bots, aggregators |

Per-call pricing adds x402 latency (~200-500ms) on every request. Access passes eliminate this — one upfront payment, then unlimited calls at native HTTP latency until expiry. Ideal for data endpoints called 100-10K times/day by trading bots. See the "Access Pass Model" section above for full details.

Implementation: Dexter `X402_ACCESS_PASS_TIER` env var + on-chain pass verification. The Dexter SDK handles pass purchase, verification, and expiry internally.

### Competitor Benchmark (x402 Ecosystem)

The x402 ecosystem has **90+ active endpoints** across 30+ categories, with 75M cumulative transactions and $24M in payment volume. Dexter facilitates ~50% of all x402 transactions.

**Pricing sweet spots** (where volume x price is maximized):

| Price Range | Endpoints | Volume | Verdict |
|-------------|-----------|--------|---------|
| $0.001-$0.005 | 19 | Low | Crowded, commodity data |
| $0.005-$0.02 | 31 | 1.5M calls | **Our sweet spot** -- high competition but proven demand |
| $0.02-$0.05 | 5 | Low | Moderate competition, good differentiation opportunity |
| $0.05-$0.15 | 14 | 3.3M calls | Jupiter DEX dominates; opportunity for AI services |
| $0.15-$1.00 | 5 | Low | Premium reports; low competition |

**Top revenue endpoint**: Jupiter DEX Quote (Pro) at $0.10/call with 3.3M calls = $333K revenue. This demonstrates that high-value, high-frequency endpoints can generate significant revenue.

**Our unique advantage**: No competitor combines Solana on-chain data + multi-agent AI analysis behind a single x402 paywall. The Wallet Report endpoint ($0.03) that chains Helius data pull with Swarms analysis is uncontested.

### Revenue Projections

| Scenario | Monthly Calls | Avg $/Call | Monthly Rev | Annual Rev |
|----------|--------------|-----------|-------------|------------|
| Dev/Testing | 5,000 | $0.015 | $75 | $900 |
| Early Traction (10 integrations) | 50,000 | $0.012 | $600 | $7,200 |
| Growth (100 users) | 500,000 | $0.010 | $5,000 | $60,000 |
| Scale (1K users) | 5,000,000 | $0.008 | $40,000 | $480,000 |
| Breakout (10K users) | 50,000,000 | $0.005 | $250,000 | $3,000,000 |

### Near-Term Action Items

1. **Tiered pricing**: Add `?tier=basic` query param support to all AI endpoints using GPT-4.1 nano ($0.001/call)
2. **Volume discounts**: Implement dynamic `getAmount` callback checking 30-day settlement count
3. **Free tier**: 10 free calls/day per endpoint (costs ~$0.10/day/user in OpenAI) to drive developer acquisition
4. **Bundle endpoint**: `/x402/bundle` that chains wallet-analyzer + sentiment + research for $0.05-$0.10
5. **Access pass pilot**: Weekly $5 pass for 1,000 calls via Dexter `X402_ACCESS_PASS_TIER`
6. **ElizaOS plugin publish**: npm publish + elizaos-plugins registry PR for distribution

## Governance

The x402 protocol is an open standard. Facilitators include Dexter (used by this plugin) and Coinbase. This plugin is community-maintained and has no governance token or DAO.

## Anti-Patterns Avoided

- **No ponzinomics**: No token required to use the network
- **No lockups**: USDC flows freely, no staking or vesting
- **No meme coin exposure**: Ignore any tokens claiming to be "the x402 token"
- **No oracle dependency**: Prices set by service operators, not on-chain price feeds
