# eliza-x402-swarms — Product Roadmap

> From infrastructure to product. Prioritized implementation plan.
> Generated 2026-03-26 from 5 parallel planning agents.

---

## Current State (All Phases Complete)

All 5 roadmap phases have been implemented. The plugin now ships with:

| Category | Count | Details |
|----------|-------|---------|
| **Actions** | 5 | PAY_FOR_X402_SERVICE, DISCOVER_X402_SERVICES, DELEGATE_TO_SWARM, RUN_SWARM_AGENT, DELEGATE_TO_SWARM_WITH_PAYMENT |
| **Services** | 4 | X402WalletService, SwarmsService, X402ServerService, PaymentMemoryService |
| **Providers** | 2 | x402Provider (wallet context), x402ServerProvider (revenue tracking) |
| **Evaluators** | 1 | paymentEvaluator (budget monitoring + quality scoring) |
| **Routes** | 5 | /x402/research, /x402/analyze, /x402/agent, /x402/swarm, /x402/catalog |
| **Templates** | 4 | ResearchPipeline, AnalysisPanel, CodeReview, DebateAndDecide |
| **DB Schemas** | 3 | x402_payment_history, x402_endpoint_scores, x402_budget_state |
| **LLM Routing** | 2 backends | Single-agent tasks use direct OpenAI (95% margin); multi-agent tasks use Swarms API (40-60% margin) |
| **Tests** | 162 | Unit, integration, smoke, and template tests |
| **Example** | 1 | SignalHawk trading signal agent (buy data, swarm analysis, sell signals) |

---

## The Vision

An AI agent that **buys data**, **processes it through multi-agent teams**, and **sells the result** — all settled in USDC on-chain via x402. Self-sustaining economic loop.

## Priority Order

| Phase | What | Status |
|-------|------|--------|
| **1** | Swarm Templates | [x] COMPLETED (2026-03-26) |
| **2** | x402 + Swarm Bridge | [x] COMPLETED (2026-03-26) |
| **3** | Sell Services (Server-side x402) | [x] COMPLETED (2026-03-26) |
| **4** | SignalHawk Agent | [x] COMPLETED (2026-03-26) |
| **5** | Persistence & Learning | [x] COMPLETED (2026-03-26) |

---

## Phase 1: Swarm Templates --- COMPLETED (2026-03-26)

**Complexity:** Medium | **New files:** 2 | **Modified:** 2

Replace LLM-guessed swarm architecture with 4 opinionated, pre-built templates.

### Templates

| Template | Swarm Type | Agents | Trigger |
|----------|-----------|--------|---------|
| **ResearchPipeline** | SequentialWorkflow | Researcher -> FactChecker -> Writer | "research X", "write a report on X" |
| **AnalysisPanel** | MixtureOfAgents | TechnicalExpert + EconomicExpert + RiskExpert + Synthesizer | "analyze X", "evaluate X" |
| **CodeReview** | ConcurrentWorkflow | SecurityAuditor + PerformanceReviewer + StyleChecker | "review this code", "audit contract" |
| **DebateAndDecide** | MajorityVoting | Proponent + Opponent + Judge | "should I X?", "pros and cons of X" |

### Detection Strategy (2-phase)
1. **Keyword regex** (instant, no LLM call) -- match trigger patterns
2. **LLM classification** (only if ambiguous) -- classify into 4 templates + "custom" fallback
3. **Custom fallback** -- existing behavior preserved for edge cases

### Files
- **New:** `src/templates/swarmTemplates.ts` -- template definitions with agents, prompts, models
- **New:** `src/templates/index.ts` -- registry, `findMatchingTemplate()`, `registerSwarmTemplate()`
- **Modified:** `src/actions/delegateToSwarm.ts` -- use templates when matched, custom as fallback
- **Modified:** `src/types.ts` -- `SwarmTemplate` interface

### Custom Template API
```typescript
import { registerSwarmTemplate } from "@elizaos/plugin-x402-swarms";
registerSwarmTemplate(myCustomTemplate);
```

---

## Phase 2: x402 + Swarm Bridge --- COMPLETED (2026-03-26)

**Complexity:** Medium | **New files:** 1 | **Modified:** 3

Make x402 payments flow INTO swarm workflows. The agent buys data, injects it into the swarm prompt, and optionally re-runs if the swarm needs more.

### Approach: Hybrid Pre-fetch + Post-swarm Chain

**Why not tool-equipped agents?** Swarms run on remote `api.swarms.world` -- no callback mechanism for agents to trigger local x402 payments.

### Flow
```
User: "Analyze top DeFi protocols by TVL and risk"
  1. LLM extracts keywords: "defi", "tvl", "risk"
  2. searchAPIs({ query: "defi tvl" }) -> discovers CoinGecko, DeFi Risk DB
  3. walletService.payForResource(coingecko) -> $0.01 -> gets TVL data
  4. walletService.payForResource(riskdb) -> $0.03 -> gets risk scores
  5. swarmsService.runSwarm({ task: originalTask + "\n\nAVAILABLE DATA:\n" + fetchedData })
  6. Parse output for DATA_REQUESTS section
  7. If found: pay for more data, re-run swarm (max 1 re-run)
  8. Return result with full payment transparency
```

### Files
- **New:** `src/actions/delegateToSwarmWithPayment.ts` -- the bridge action
- **Modified:** `src/types.ts` -- `X402DataFetch`, `SwarmWithPaymentResult`
- **Modified:** `src/providers/x402Provider.ts` -- mention new action
- **Modified:** `src/index.ts` -- register action

### Validation
Requires BOTH `SWARMS_API_KEY` AND a wallet key. Won't appear if only one system is configured.

---

## Phase 3: Sell Services (Server-side x402) --- COMPLETED (2026-03-26)

**Complexity:** Large | **New files:** 5 | **Modified:** 2

Let the agent **sell** its capabilities as x402-protected HTTP endpoints. Uses `@dexterai/x402/server` + ElizaOS v2 `routes` field.

### New Service: X402ServerService (type: `"X402_SERVER"`)
- Holds `X402Server` instance from `createX402Server()`
- `buildRequirements()`, `verifyPayment()`, `settlePayment()`
- Supports fixed, dynamic, and token-based pricing

### Payment Gate: `x402Gate(runtime, req, res, options)`
Adapter for ElizaOS route handlers (not Express middleware):
1. Check for payment header -> if absent, return 402 with requirements
2. If present -> verify -> settle -> return `{ paid: true, transaction }`

### Routes
| Route | Price | Purpose |
|-------|-------|---------|
| `POST /x402/research` | Dynamic (per-char) | Deep research via swarm |
| `POST /x402/analyze` | Fixed ($0.05) | Multi-agent analysis |
| `POST /x402/agent` | Token-based | Single agent task |
| `POST /x402/swarm` | Dynamic (per-agent) | Custom swarm execution |
| `GET /x402/catalog` | **Free** | List sellable endpoints (discovery) |
| `GET /x402/health` | **Free** | Service status |

### Auto-listing on OpenDexter
- First x402 settlement through Dexter facilitator -> auto-indexed
- `/x402/catalog` serves as machine-readable sitemap

### Env Vars
| Variable | Default | Purpose |
|----------|---------|---------|
| `X402_RECEIVE_ADDRESS` | (required) | Wallet to receive payments |
| `X402_SELL_RESEARCH_PRICE_USD` | `0.05` | Research endpoint price |
| `X402_SELL_ANALYZE_PRICE_USD` | `0.03` | Analysis endpoint price |

### Files
- **New:** `src/server/x402ServerService.ts`
- **New:** `src/server/x402Gate.ts`
- **New:** `src/server/index.ts`
- **New:** `src/routes/x402Routes.ts`
- **New:** `src/providers/x402ServerProvider.ts` -- revenue tracking context
- **Modified:** `src/index.ts` -- register server service, routes, provider
- **Modified:** `src/types.ts` -- server-side types

---

## Phase 4: SignalHawk Agent --- COMPLETED (2026-03-26)

**Complexity:** Large | **New files:** 7 | **Depends on:** Phases 1-3

A concrete, demoable product: a **trading signal agent** that buys price/sentiment data via x402, runs a MajorityVoting swarm with 3 analyst agents, and sells signals via its own x402 endpoint.

### Why SignalHawk?
- Buy/sell loop is instantly legible: buy data cheap, sell insights for more
- MajorityVoting swarm is compelling: 3 analysts disagree and reach consensus
- Output is concise (signal card, not an essay) -- demoable in 2 minutes
- Real x402 endpoints exist (CoinGecko, Exa Search)
- Self-sustaining economics: ~$0.07 cost per signal, sells for $0.10

### Signal Card Output
```json
{
  "asset": "ETH",
  "signal": "LONG",
  "confidence": 78,
  "timeframe": "4h",
  "analysts": {
    "technical": { "verdict": "LONG", "confidence": 85 },
    "sentiment": { "verdict": "LONG", "confidence": 72 },
    "onchain": { "verdict": "HOLD", "confidence": 68 }
  },
  "consensus": "2/3 LONG",
  "costToGenerate": "$0.07"
}
```

### Swarm: MajorityVoting with 3 Specialists
| Agent | Focus | Model |
|-------|-------|-------|
| TechnicalAnalyst | Price patterns, support/resistance, momentum | gpt-4o-mini |
| SentimentAnalyst | News/social mood, narrative shifts | gpt-4o-mini |
| OnChainAnalyst | Whale movements, TVL, accumulation/distribution | gpt-4o-mini |

### Sell-side Routes
- `POST /api/signals/generate` -- $0.10 (new signal)
- `GET /api/signals/latest` -- $0.02 (cached)
- `GET /api/signals/health` -- Free

### Files (under `examples/signalhawk/`)
```
examples/signalhawk/
  index.ts              # ElizaOS v2 Project export
  character.ts          # SignalHawk character
  plugin.ts             # SignalHawk plugin (extends base)
  actions/
    generateSignal.ts   # Full pipeline: buy -> swarm -> format
    getLatestSignal.ts  # Cached signal retrieval
  routes/
    signalRoutes.ts     # x402-protected sell endpoints
  services/
    signalService.ts    # Signal cache, cost/revenue tracking
  swarms/
    analystSwarm.ts     # MajorityVoting config (3 agents)
  types.ts              # TradingSignal, AnalystVerdict
```

---

## Phase 5: Persistence & Learning --- COMPLETED (2026-03-26)

**Complexity:** Large | **New files:** 5 | **Modified:** 4

Make the agent remember, score, and optimize its spending across sessions.

### 5a. Payment History (Drizzle ORM)
- `x402_payment_history` table: endpoint, amount, tx_hash, network, response_time, quality_score
- Dual write: Drizzle table (structured queries) + ElizaOS memory (semantic search)
- Survives across sessions

### 5b. Endpoint Quality Scoring
- LLM scores each response 1-5 after payment (via evaluator)
- Running average per domain in `x402_endpoint_scores` table
- Agent learns: "CoinGecko = 4.5/5, RandomAPI = 1.2/5"

### 5c. Cost Optimization in Provider
```
Best Value Endpoints:
  1. api.coingecko.com -- $0.01/call, quality 4.5/5 (28 calls)
  2. exa.ai -- $0.03/call, quality 4.2/5 (12 calls)

Avoid (Low Value):
  1. randomapi.example.com -- $0.05/call, quality 1.2/5 (3 calls)

Spending: Last 24h $0.12 | Last 7d $2.34 | Last 30d $8.91
```

### 5d. Budget Persistence
- `x402_budget_state` table: daily/weekly/monthly spent + reset timestamps
- Configurable reset periods via `X402_BUDGET_RESET_PERIOD`
- Budget carries across sessions (not just in-memory)

### Files
- **New:** `src/schemas/paymentHistory.ts`
- **New:** `src/schemas/endpointScores.ts`
- **New:** `src/schemas/budgetState.ts`
- **New:** `src/schemas/index.ts`
- **New:** `src/services/paymentMemoryService.ts`
- **Modified:** `src/services/x402WalletService.ts` -- capture timing, call recording
- **Modified:** `src/evaluators/paymentEvaluator.ts` -- LLM quality scoring
- **Modified:** `src/providers/x402Provider.ts` -- historical spending + quality data
- **Modified:** `src/index.ts` -- add schema, register service

### Dependencies
- Add `drizzle-orm` as explicit dependency (transitive via @elizaos/core, but used directly)

---

## Implementation Timeline

```
Phase 1 (Swarm Templates):     COMPLETED 2026-03-26
Phase 2 (x402+Swarm Bridge):   COMPLETED 2026-03-26
Phase 3 (Sell Services):       COMPLETED 2026-03-26
Phase 4 (SignalHawk):          COMPLETED 2026-03-26
Phase 5 (Persistence):        COMPLETED 2026-03-26
```

All phases are implemented. The plugin is feature-complete with a full buy-process-sell economic loop, persistence, and the SignalHawk demo agent.
