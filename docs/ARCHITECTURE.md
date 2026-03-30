# Architecture: ElizaOS x402 Swarms Plugin

## Overview

This plugin bridges three systems:

1. **ElizaOS v2** — autonomous AI agent framework (actions, providers, evaluators, services)
2. **x402 + Dexter SDK** — HTTP-native payment protocol (HTTP 402, USDC on 6 networks)
3. **Swarms** — multi-agent orchestration API (15+ architectures via swarms-ts SDK)
4. **OpenAI** — direct LLM calls for single-agent tasks (cost optimization, bypasses Swarms overhead)

```
+----------------------------------------------------------------------+
|                        ElizaOS v2 Agent                              |
|                                                                      |
|  +-------------------+  +--------------------+  +------------------+ |
|  |      Actions       |  |     Providers      |  |   Evaluators     | |
|  |                    |  |                    |  |                  | |
|  | PAY_FOR_X402_      |  | X402_PAYMENT_      |  | PAYMENT_         | |
|  |   SERVICE          |  |   CONTEXT          |  |   EVALUATOR      | |
|  |                    |  |   (buy-side wallet  |  |   (tracks spend, | |
|  | DISCOVER_X402_     |  |    info + budget    |  |    warns >80%    | |
|  |   SERVICES         |  |    into LLM prompt) |  |    budget, logs  | |
|  |                    |  |                    |  |    every 10 pays)| |
|  | DELEGATE_TO_       |  | X402_SERVER_        |  |                  | |
|  |   SWARM            |  |   CONTEXT          |  +------------------+ |
|  |                    |  |   (sell-side revenue |                     |
|  | RUN_SWARM_         |  |    + endpoint       |                     |
|  |   AGENT            |  |    catalog into     |                     |
|  |                    |  |    LLM prompt)      |                     |
|  | DELEGATE_TO_SWARM_ |  |                    |                     |
|  |   _WITH_PAYMENT    |  +--------------------+                     |
|  +--------+-----------+                                              |
|           |                                                          |
|  +--------v-----------+  +-------------+  +------------------------+ |
|  | X402WalletService  |  | SwarmsService|  | X402ServerService      | |
|  |                    |  |             |  |                        | |
|  | - Dexter SDK       |  | - swarms-ts |  | - Dexter server SDK   | |
|  |   (wrapFetch)      |  |   SDK client|  | - Sell-side x402 gate | |
|  | - BudgetAccount    |  | - Single &  |  | - Revenue tracking    | |
|  |   controls         |  |   multi-    |  | - Payment verify +    | |
|  | - Access Pass      |  |   agent     |  |   settle              | |
|  | - Receipt extract  |  | - 15+ archs|  +------------------------+ |
|  | - 6-network        |  | - API key   |                            |
|  +--------+-----------+  +------+------+  +------------------------+ |
|           |                     |         | PaymentMemoryService   | |
|           |                     |         |                        | |
|           |                     |         | - Payment history      | |
|           |                     |         | - Quality scoring      | |
|           |                     |         | - Endpoint aggregates  | |
|           |                     |         | - DB + in-memory       | |
|           |                     |         +------------------------+ |
+-----------+---------------------+------------------------------------|
            |                     |
            |  HTTP + x402 pay    |  HTTPS + API key
            |                     |
   +--------v-----------+  +-----v-----------------+
   |  x402 Endpoints    |  |   Swarms Cloud API    |
   |                    |  |                       |
   | - OpenDexter       |  | - api.swarms.world    |
   |   marketplace      |  | - Agent runs          |
   | - Any x402-        |  | - Swarm runs          |
   |   protected API    |  | - 15+ swarm types     |
   +--------------------+  +-----------------------+
```

## Plugin Components

### Actions (5)

| Action | Trigger Phrases | Service Used | Description |
|--------|----------------|--------------|-------------|
| `PAY_FOR_X402_SERVICE` | "access endpoint", "pay for API" | X402WalletService | Pays for an x402-protected endpoint. Supports GET/POST/PUT/DELETE. LLM extracts endpoint details. |
| `DISCOVER_X402_SERVICES` | "what services", "find APIs" | Direct SDK (`searchAPIs`) | Searches OpenDexter marketplace. No wallet needed. |
| `DELEGATE_TO_SWARM` | "use swarm to...", "multi-agent" | SwarmsService | Delegates to a multi-agent swarm. LLM selects architecture. Default: Researcher + Analyst agents. |
| `RUN_SWARM_AGENT` | "run agent", "use single agent" | SwarmsService | Runs a single specialized agent. LLM configures name, model, temperature. |
| `DELEGATE_TO_SWARM_WITH_PAYMENT` | "research and buy data", "funded multi-agent" | SwarmsService + X402WalletService | Discovers x402 data sources, pays for them, injects data into a swarm, and optionally re-runs if the swarm requests more data. Bridges marketplace discovery, micropayments, and multi-agent orchestration in one action. |

### Providers (2)

**`X402_PAYMENT_CONTEXT`** (buy-side) — Injected into every LLM prompt with:
- Network and wallet configuration
- Per-request auto-pay limit and budget remaining
- Total spent and hourly spend rate
- Access pass status
- Last 3 payment transactions
- Available action guidance

**`X402_SERVER_CONTEXT`** (sell-side) — Active only when `X402_RECEIVE_ADDRESS` is set and `X402ServerService` is running. Injects:
- Receive address and network
- Total revenue earned and settlement count
- Last 3 incoming payments (amount, payer, endpoint, tx hash)
- Catalog of all sell-side endpoints with prices
- Guidance that the agent is accepting x402 payments

### Evaluators (1)

**`PAYMENT_EVALUATOR`** (`alwaysRun: false`) — Post-interaction monitoring:
- Warns when >80% of total budget spent
- Warns when >80% of hourly spend limit reached
- Logs session summary every 10 payments
- Hourly limit computed as `min(budget, maxAutoPayUsd * 100)`

### Services (4)

**`X402WalletService`** (type: `"X402_WALLET"`):
- Wraps Dexter SDK's `createBudgetAccount()` and `wrapFetch()`
- Budget controls: total, per-request, per-hour limits
- `payForResource()`: budget-enforced fetch with full `RequestInit` support
- `getPaymentReceipt()` for real on-chain tx hash, network, payer
- `mapX402Error()`: 8 error codes mapped to user-friendly messages
- Network mapping: human-readable IDs -> CAIP-2 chain IDs
- Access Pass support: auto-buy, auto-renew

**`SwarmsService`** (type: `"SWARMS"`):
- Wraps `swarms-ts` SDK's `SwarmsClient`
- `runAgent()`: single-agent execution via `client.agent.run()`
- `runSwarm()`: multi-agent swarm execution via `client.swarms.run()`
- `getAvailableSwarmTypes()`: list supported architectures
- Config: maxRetries=2, timeout=120s
- Auth: API key header (`x-api-key`), NOT x402 payments

**`X402ServerService`** (type: `"X402_SERVER"`):
- Wraps Dexter server SDK's `createX402Server()`
- Sell-side payment verification and settlement for incoming requests
- Revenue tracking: history, total revenue, settlement count
- Requires `X402_RECEIVE_ADDRESS` env var; gracefully disabled if absent
- Network + facilitator URL configurable via `X402_NETWORK_ID` / `X402_FACILITATOR_URL`

**`PaymentMemoryService`** (type: `"PAYMENT_MEMORY"`):
- Persists payment history across sessions (DB + in-memory fallback)
- `recordPayment()`: writes to in-memory history and DB (if available)
- `scorePayment()`: attach quality score + reason to a payment record
- `updateEndpointScore()`: upsert per-domain aggregate metrics (avg quality, avg response time, error count)
- `getSpendingStats()`: spending analytics for 24h / 7d / 30d periods
- `getUnscoredPayments()`: buffer for the evaluator to process
- `getEndpointScoreSummary()`: ranked domain list sorted by quality/cost ratio

### Routes (5)

All routes are registered via the plugin's `routes` field. Paid routes use `x402Gate()` middleware to require USDC payment before processing.

| Route | Method | Price | Description |
|-------|--------|-------|-------------|
| `/x402/research` | POST | $0.05 | Runs a ResearchPipeline swarm (Researcher + FactChecker + Writer). Body: `{ query, depth? }` |
| `/x402/analyze` | POST | $0.03 | Runs an AnalysisPanel swarm (Technical + Economic + Risk + Synthesizer). Body: `{ text, type? }` |
| `/x402/agent` | POST | $0.02 | Runs a single agent. Body: `{ task, agentName?, model?, systemPrompt? }` |
| `/x402/catalog` | GET | FREE | Returns the service catalog (name, description, path, method, price for each endpoint) |
| `/x402/health` | GET | FREE | Returns service status, receive address, network, total revenue, and settlement count |

`x402Gate()` checks the incoming request for a `payment-signature` header. If absent, responds with HTTP 402 + payment requirements. If present, verifies the payment via the Dexter facilitator, settles it, records revenue, and lets the request through.

### Templates (4)

Pre-built swarm configurations with regex-based trigger patterns. Templates are checked in specificity order (most specific first). If no template matches, the action falls back to a default Researcher + Analyst pair.

| Template | Swarm Type | Agents | Triggers |
|----------|-----------|--------|----------|
| `CodeReview` | ConcurrentWorkflow | SecurityAuditor, PerformanceReviewer, StyleChecker | "review code", "audit", "security check", "vulnerabilities" |
| `DebateAndDecide` | MajorityVoting | Proponent, Opponent, Judge | "should I", "pros and cons", "debate", "worth it" |
| `ResearchPipeline` | SequentialWorkflow | Researcher, FactChecker, Writer | "research", "report", "summarize", "deep dive" |
| `AnalysisPanel` | MixtureOfAgents | TechnicalExpert, EconomicExpert, RiskExpert, Synthesizer | "analyze", "perspectives", "assess", "evaluate" |

Detection strategy: `findMatchingTemplate(text)` iterates templates in order, testing each `triggerPatterns` regex array. First match wins. `buildClassificationPrompt()` is available as a fallback when keyword matching is ambiguous. Custom templates can be added at runtime via `registerSwarmTemplate()`.

### DB Schemas (3)

Drizzle ORM table definitions in `src/schemas/`. Used by `PaymentMemoryService` for persistent storage; all gracefully degrade to in-memory when no database is available.

**`x402_payment_history`** — Individual payment records:
- `id`, `agentId`, `endpoint`, `domain`, `method`, `amountUsd`, `txHash`, `network`, `payer`
- `status`, `responseStatus`, `responseTimeMs`, `qualityScore`, `qualityReason`, `responsePreview`
- Indexes: `(agentId, domain)`, `(agentId, createdAt)`, `(domain, qualityScore)`

**`x402_endpoint_scores`** — Per-domain aggregate metrics:
- `id`, `agentId`, `domain`, `totalCalls`, `totalSpentUsd`, `avgQualityScore`, `avgResponseTimeMs`, `errorCount`
- Unique index: `(agentId, domain)`
- Index: `(agentId, avgQualityScore)`

**`x402_budget_state`** — Rolling budget tracking:
- `id`, `agentId`, `dailySpentUsd`, `weeklySpentUsd`, `monthlySpentUsd`, `lifetimeSpentUsd`, `lifetimePayments`
- Configurable limits: `dailyBudgetUsd`, `weeklyBudgetUsd`, `monthlyBudgetUsd`
- Rolling reset timestamps: `dailyResetAt`, `weeklyResetAt`, `monthlyResetAt`
- Unique index: `(agentId)`

## LLM Routing Strategy

SwarmX routes LLM calls through two backends based on task complexity:

| Endpoint | Agents | Backend | Why |
|----------|--------|---------|-----|
| `/x402/agent` | 1 | Direct OpenAI | Single-agent task, no orchestration needed |
| summarize | 1 | Direct OpenAI | Simple text transformation |
| translate | 1 | Direct OpenAI | Simple text transformation |
| extract | 1 | Direct OpenAI | Structured data extraction |
| sentiment | 1 | Direct OpenAI | Classification task |
| `/x402/research` | 3 (Researcher + FactChecker + Writer) | Swarms API | Sequential multi-agent pipeline |
| `/x402/analyze` | 4 (Technical + Economic + Risk + Synthesizer) | Swarms API | Mixture-of-agents orchestration |
| code-review | 3 (Security + Performance + Style) | Swarms API | Concurrent multi-agent workflow |
| write | 3 (Researcher + Writer + Editor) | Swarms API | Sequential multi-agent pipeline |
| debate | 3 (Proponent + Opponent + Judge) | Swarms API | Majority voting orchestration |

**Implementation**: `src/utils/llm.ts` provides a direct OpenAI client used by single-agent endpoints. Multi-agent endpoints use `SwarmsService` which calls the Swarms cloud API (`api.swarms.world`).

**Fallback**: If `OPENAI_API_KEY` is not set, single-agent tasks route through Swarms as a single-agent swarm. This works but incurs Swarms per-token + per-agent fees unnecessarily.

```
Request arrives at endpoint
     |
     v
Single-agent?  ──yes──>  src/utils/llm.ts  ──>  OpenAI API (direct)
     |                                              ~$0.001/call
     no
     |
     v
Multi-agent  ──────────>  SwarmsService  ──>  Swarms Cloud API
                                                 ~$0.01-0.10/call
```

## x402 Payment Flow

```
Agent wants data from paid endpoint
     |
     v
Dexter SDK: budgetAccount.fetch(url, init)
     |
     v  HTTP 402 (handled automatically by SDK)
Server: { price: "$0.01", payTo: "0x...", network: "eip155:8453" }
     |
     v  (SDK handles signing + budget check)
Dexter SDK: signs USDC transfer, deducts from budget
     |
     v
Retries request with payment proof header
     |
     v  HTTP 200
Server validates payment via Dexter facilitator -> returns data
     |
     v
Plugin extracts receipt: getPaymentReceipt(response)
  -> { transaction: "5abc...", network: "eip155:8453", payer: "0x..." }
```

Gas fees are sponsored by the Dexter facilitator. The agent's wallet only needs USDC, not ETH/SOL for gas.

## Swarms Integration

The Swarms API (`api.swarms.world`) provides multi-agent orchestration as a cloud service. **Swarms uses API key auth, not x402 payments.**

1. Agent receives a natural-language task from the user
2. LLM selects appropriate swarm architecture (or uses `"auto"`)
3. LLM generates agent specs (or defaults to Researcher + Analyst)
4. Plugin sends request to Swarms API with agent specs, swarm type, and task
5. Swarms API executes the multi-agent pipeline server-side
6. Plugin returns result with job_id, execution_time, and output

### Supported Swarm Architectures

`SequentialWorkflow`, `ConcurrentWorkflow`, `MixtureOfAgents`, `AgentRearrange`, `HiearchicalSwarm`, `GroupChat`, `MultiAgentRouter`, `AutoSwarmBuilder`, `MajorityVoting`, `HeavySwarm`, `DeepResearchSwarm`, `auto`

## Supported Networks

| Human-Readable ID | CAIP-2 Chain ID | Currency |
|--------------------|-----------------|----------|
| `base-mainnet` | `eip155:8453` | USDC |
| `base-sepolia` | `eip155:84532` | USDC (testnet) |
| `ethereum-mainnet` | `eip155:1` | USDC |
| `solana-mainnet` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | USDC |
| `polygon-mainnet` | `eip155:137` | USDC |
| `arbitrum-mainnet` | `eip155:42161` | USDC |

## Security Considerations

- **Spend threshold**: `X402_MAX_AUTO_PAY_USD` prevents runaway per-request payments
- **Budget cap**: `X402_BUDGET_USD` limits total session spending
- **Hourly limit**: Computed as `min(budget, maxAutoPayUsd * 100)` per hour
- **Wallet keys**: Store in `.env`, never commit. `.gitignore` includes `.env`
- **Network**: Default to `base-sepolia` for testing; switch to mainnet intentionally
- **X402Error handling**: 8 error codes mapped to actionable user messages
- **Access Pass**: Auto-renew with configurable max spend cap

## File Structure

```
src/
  index.ts                              # Plugin entry + re-exports
  types.ts                              # TypeScript interfaces
  actions/
    index.ts                            # Actions barrel export
    payForService.ts                    # PAY_FOR_X402_SERVICE
    discoverServices.ts                 # DISCOVER_X402_SERVICES
    delegateToSwarm.ts                  # DELEGATE_TO_SWARM
    runSwarmAgent.ts                    # RUN_SWARM_AGENT
    delegateToSwarmWithPayment.ts       # DELEGATE_TO_SWARM_WITH_PAYMENT
  providers/
    x402Provider.ts                     # X402_PAYMENT_CONTEXT (buy-side)
    x402ServerProvider.ts               # X402_SERVER_CONTEXT (sell-side)
  evaluators/
    paymentEvaluator.ts                 # PAYMENT_EVALUATOR
  services/
    x402WalletService.ts                # X402WalletService (Dexter SDK)
    swarmsService.ts                    # SwarmsService (swarms-ts)
    paymentMemoryService.ts             # PaymentMemoryService (history + scoring)
  server/
    index.ts                            # X402ServerService + x402Gate re-exports
    x402ServerService.ts                # X402ServerService (sell-side Dexter server)
    x402Gate.ts                         # x402Gate() payment middleware
  routes/
    x402Routes.ts                       # 5 x402 route definitions
  templates/
    index.ts                            # Template registry + matching + registration
    swarmTemplates.ts                   # 4 pre-built swarm templates
  schemas/
    index.ts                            # Schema barrel export
    paymentHistory.ts                   # x402_payment_history table
    endpointScores.ts                   # x402_endpoint_scores table
    budgetState.ts                      # x402_budget_state table
tests/                                  # 157 unit/integration + 5 smoke tests
examples/
  basic-agent.ts                        # Standalone demo + v2 Project export
docs/
  ARCHITECTURE.md                       # This file
  TOKENOMICS.md                         # Economic model
```
