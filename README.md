# SwarmX (@elizaos/plugin-x402-swarms)

ElizaOS v2 plugin that gives AI agents the ability to **pay for APIs** using the [x402 HTTP payment protocol](https://www.x402.org/) via the [Dexter SDK](https://dexter.cash/) and **orchestrate multi-agent tasks** using [Swarms](https://swarms.world/) — settled in USDC across 5 networks (Base, Ethereum, Solana, Polygon, Arbitrum).

## What This Enables

- **Hire AI agent teams** — code review (3 agents), research (3 agents), multi-angle analysis (4 agents), debate (3 agents) — one API call, one USDC payment
- **Consume paid APIs autonomously** — agent detects HTTP 402, pays with USDC via Dexter SDK, retries automatically
- **Discover x402 services** — browse the [OpenDexter marketplace](https://dexter.cash/opendexter) of pay-per-call AI/data APIs
- **Delegate to Swarms** — route complex tasks to multi-agent systems (15+ architectures) via the Swarms cloud API
- **Delegate with x402 data** — combine x402 data fetching with swarm analysis in a single action
- **Run single agents** — execute focused tasks with a specific agent role via Swarms
- **Sell agent services** — expose your agent's capabilities as x402-gated HTTP endpoints
- **Budget controls** — per-request, per-hour, and total session spending limits with persistent DB state
- **Access Passes** — time-limited unlimited access for frequently-used endpoints

## Featured Endpoints

| Endpoint | Team | Agents | Price | What You Get |
|----------|------|--------|-------|--------------|
| `POST /x402/code-review` | **Code Review** | Security Auditor + Performance Reviewer + Style Checker | $0.03 | Three specialists audit your code in parallel — security, performance, and style — merged into one report |
| `POST /x402/research` | **Deep Research** | Researcher → Fact Checker → Writer | $0.05 | A pipeline that investigates any topic, verifies claims, and delivers a polished report |
| `POST /x402/analyze` | **Multi-Angle Analysis** | Technical + Economic + Risk → Synthesizer | $0.03 | Four domain experts analyze your topic from every angle, then synthesize actionable intelligence |
| `POST /x402/debate` | **Debate & Decide** | Proponent + Opponent + Judge | $0.03 | Two agents argue opposing sides while a neutral judge weighs evidence and delivers a verdict |

All endpoints accept JSON via HTTP POST and settle payments in USDC via the x402 protocol. 3 free calls/day — no wallet needed to start.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full system diagram.

See [docs/TOKENOMICS.md](docs/TOKENOMICS.md) for the economic model.

## Quick Start

### 1. Install

```bash
bun add @elizaos/plugin-x402-swarms
```

### 2. Configure

```bash
cp .env.example .env
# Fill in: EVM_PRIVATE_KEY (or SOLANA_PRIVATE_KEY), OPENAI_API_KEY (or ANTHROPIC_API_KEY)
# Optional: SWARMS_API_KEY for multi-agent features
```

### 3. Add to Your Agent (ElizaOS v2)

```typescript
import type { Project, ProjectAgent } from "@elizaos/core";
import { x402SwarmsPlugin } from "@elizaos/plugin-x402-swarms";

const character = {
  name: "PayAgent",
  bio: ["An AI agent that can pay for APIs and orchestrate multi-agent tasks."],
  system: "You are PayAgent. Use DISCOVER_X402_SERVICES to find paid APIs, PAY_FOR_X402_SERVICE to access them, DELEGATE_TO_SWARM for multi-agent tasks, or RUN_SWARM_AGENT for single-agent tasks.",
  plugins: [],
  settings: {
    EVM_PRIVATE_KEY: process.env.EVM_PRIVATE_KEY ?? "",
    X402_NETWORK_ID: "base-sepolia",
    X402_MAX_AUTO_PAY_USD: "0.10",
    X402_BUDGET_USD: "10.00",
    SWARMS_API_KEY: process.env.SWARMS_API_KEY ?? "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  },
};

const agent: ProjectAgent = { character, plugins: [x402SwarmsPlugin] };
export const project: Project = { agents: [agent] };
export default project;
```

### 4. Run

```bash
# As an ElizaOS project:
elizaos start

# Or run the standalone demo:
bun run example
```

### 5. Chat with Your Agent

```
You: What x402 services are available?
Agent: Found 5 x402 service(s) on OpenDexter:
  WETH On-Chain Price ($0.01/call), Solana Token Price ($0.01/call)...

You: Access the x402 endpoint at https://pro-api.coingecko.com/api/v3/x402/onchain/simple/net
Agent: Access successful.
- Endpoint: GET https://pro-api.coingecko.com/...
- Amount paid: $0.0100 USDC
- Tx: 5abc...xyz (eip155:84532)
- Remaining budget: $9.99

You: Use the swarm to analyze top DeFi protocols and summarize risks
Agent: Swarm completed (SequentialWorkflow)
Agents: 2, Execution time: 12.3s
Result: [detailed analysis]...

You: Run a code review agent to check this smart contract
Agent: Agent "CodeReviewer" completed.
[detailed review]...
```

## Plugin Components

| Component | Type | Name | Purpose |
|-----------|------|------|---------|
| Action | | `PAY_FOR_X402_SERVICE` | Access x402-protected APIs with automatic USDC payment |
| Action | | `DISCOVER_X402_SERVICES` | Browse OpenDexter marketplace for paid APIs |
| Action | | `DELEGATE_TO_SWARM` | Delegate to 15+ multi-agent swarm architectures |
| Action | | `RUN_SWARM_AGENT` | Run a single specialized agent via Swarms |
| Action | | `DELEGATE_TO_SWARM_WITH_PAYMENT` | Fetch x402 data then feed it into a swarm analysis |
| Provider | | `X402_PAYMENT_CONTEXT` | Injects wallet/budget/spending into LLM prompt |
| Provider | | `X402_SERVER_CONTEXT` | Injects sell-side revenue and endpoint catalog into LLM prompt |
| Evaluator | | `PAYMENT_EVALUATOR` | Warns at >80% budget usage, logs summaries |
| Service | | `X402WalletService` | Dexter SDK wallet with budget controls |
| Service | | `SwarmsService` | swarms-ts SDK wrapper for agent/swarm runs |
| Service | | `X402ServerService` | Server-side x402 gate for selling agent services |
| Service | | `PaymentMemoryService` | Persistent payment history and endpoint scoring |

## Routes

The plugin registers 5 HTTP routes for selling agent capabilities via x402 micropayments:

| Route | Method | Price | Description |
|-------|--------|-------|-------------|
| `/x402/research` | POST | $0.05 | Multi-agent research pipeline (Researcher + FactChecker + Writer) |
| `/x402/analyze` | POST | $0.03 | Multi-perspective analysis panel (Technical + Economic + Risk experts) |
| `/x402/agent` | POST | $0.02 | Run a single AI agent with custom task, model, and system prompt |
| `/x402/catalog` | GET | FREE | List all available paid endpoints with pricing |
| `/x402/health` | GET | FREE | Service health, revenue stats, and network info |

Paid routes use `x402Gate` to require USDC payment before processing. Free routes are publicly accessible.

## Templates

4 pre-built swarm templates map user intent to specific architectures and agent configurations:

| Template | Swarm Type | Agents | Trigger Examples |
|----------|-----------|--------|------------------|
| `ResearchPipeline` | SequentialWorkflow | Researcher, FactChecker, Writer | "research X", "write a report on X" |
| `AnalysisPanel` | MixtureOfAgents | TechnicalExpert, EconomicExpert, RiskExpert, Synthesizer | "analyze X from multiple perspectives" |
| `CodeReview` | ConcurrentWorkflow | SecurityAuditor, PerformanceReviewer, StyleChecker | "audit this smart contract", "review this code" |
| `DebateAndDecide` | MajorityVoting | Proponent, Opponent, Judge | "should I do X?", "pros and cons of X" |

Templates are matched via regex trigger patterns. Custom templates can be registered at runtime with `registerSwarmTemplate()`.

## DB Schemas

3 Drizzle ORM tables provide persistent storage for payment analytics and budget tracking:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `x402_payment_history` | Every payment the agent makes | endpoint, amountUsd, txHash, network, qualityScore, responseTimeMs |
| `x402_endpoint_scores` | Aggregate quality scores per domain | totalCalls, totalSpentUsd, avgQualityScore, errorCount |
| `x402_budget_state` | Cross-session budget state per agent | dailySpentUsd, weeklySpentUsd, monthlySpentUsd, lifetimeSpentUsd |

Schemas are exported as `schema` on the plugin object and auto-migrated by ElizaOS v2.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EVM_PRIVATE_KEY` | One of EVM/Solana | — | EVM private key (hex) for Base/Polygon/Arbitrum |
| `SOLANA_PRIVATE_KEY` | One of EVM/Solana | — | Solana private key (base58) |
| `X402_NETWORK_ID` | No | `base-mainnet` | Network: `base-mainnet`, `base-sepolia`, `solana-mainnet`, `polygon-mainnet`, `arbitrum-mainnet`, `ethereum-mainnet` |
| `X402_MAX_AUTO_PAY_USD` | No | `0.10` | Max USDC per auto-pay request |
| `X402_BUDGET_USD` | No | `10.00` | Total session budget in USD |
| `X402_RECEIVE_ADDRESS` | No | — | Your address for receiving payments |
| `X402_ACCESS_PASS_TIER` | No | — | Access pass tier to offer/purchase: `24h` ($1), `7d` ($5), `30d` ($25) |
| `X402_ACCESS_PASS_MAX_SPEND` | No | `25.00` | Max spend for access pass purchase |
| `X402_FACILITATOR_URL` | No | Dexter default | Custom facilitator URL |
| `SWARMS_API_KEY` | For swarms | — | Swarms API key from [swarms.world](https://swarms.world/platform/api-keys) |
| `OPENAI_API_KEY` | One LLM key | — | OpenAI API key (used directly for single-agent tasks; falls back to Swarms if absent) |
| `ANTHROPIC_API_KEY` | One LLM key | — | Anthropic API key |

### Access Passes

For data and trading endpoints called at high frequency (100-10K calls/day), per-call x402 pricing adds unacceptable latency (~200-500ms per request for the 402 negotiate/pay/retry cycle). Access passes solve this: buyers pay once for time-limited unlimited access, then all subsequent calls are served at native HTTP latency.

| Tier | Price | Duration |
|------|-------|----------|
| Day Pass | $1 | 24 hours |
| Week Pass | $5 | 7 days |
| Month Pass | $25 | 30 days |

**Selling passes (operators):** Set `X402_ACCESS_PASS_TIER` in your env to configure which tiers you offer. The Dexter SDK advertises available tiers in the 402 response and handles pass verification internally.

**Buying passes (consumers):** When your agent or bot calls a data endpoint, the 402 response includes access pass options alongside per-call pricing. The Dexter SDK can automatically purchase a pass if `X402_ACCESS_PASS_TIER` is configured (e.g., `24h`, `7d`, `30d`). After purchase, all calls from that wallet are served instantly until expiry.

Per-call pricing ($0.001-$0.10) remains the default for multi-agent AI tasks (research, analyze, debate) where the x402 latency is negligible relative to the task execution time.

See [docs/TOKENOMICS.md](docs/TOKENOMICS.md) for the full access pass economic model.

## How x402 Works

```
Agent --> GET /data --> 402 Payment Required
                         |
               { price: "$0.01", payTo: "0x...", network: "eip155:8453" }
                         |
               Dexter SDK: signs USDC transfer, checks budget
                         |
Agent --> GET /data (with payment proof) --> 200 OK + data
```

x402 is an open standard. No API keys, no subscriptions — just HTTP + stablecoins. The Dexter SDK handles the 402 -> sign -> retry flow automatically with budget controls and access pass support. Gas fees are sponsored by the Dexter facilitator.

## Swarm Architectures

The `DELEGATE_TO_SWARM` action supports these architectures (set via `swarmType`):

| Type | Use Case |
|------|----------|
| `SequentialWorkflow` | Step-by-step pipelines (research -> write -> edit) |
| `ConcurrentWorkflow` | Independent parallel tasks |
| `MixtureOfAgents` | Multiple expert perspectives, synthesized |
| `HiearchicalSwarm` | Director + workers for complex projects |
| `GroupChat` | Brainstorming or collaborative discussion |
| `HeavySwarm` | Deep research requiring thorough investigation |
| `MajorityVoting` | Decisions needing consensus |
| `DeepResearchSwarm` | Extended research pipelines |
| `AgentRearrange` | Custom DAG-based agent topology |
| `MultiAgentRouter` | Intelligent task routing to best agent |
| `AutoSwarmBuilder` | API auto-generates the right swarm |
| `auto` | Let the API pick (default) |

## LLM Routing

SwarmX uses a cost-optimized dual-backend strategy for LLM calls:

| Endpoint Type | Endpoints | Backend | Why |
|---------------|-----------|---------|-----|
| **Single-agent** | `/x402/agent`, summarize, translate, extract, sentiment | Direct OpenAI API | No orchestration overhead. ~$0.001/call, ~95% margin. |
| **Multi-agent** | `/x402/research`, `/x402/analyze`, code-review, write, debate | Swarms API | Requires multi-agent orchestration (2-4 agents). ~40-60% margin. |

- Single-agent tasks use `src/utils/llm.ts` which calls OpenAI directly with `OPENAI_API_KEY`
- Multi-agent tasks use `SwarmsService` which calls the Swarms cloud API with `SWARMS_API_KEY`
- **Fallback**: if `OPENAI_API_KEY` is not set, all tasks route through Swarms (works but costs more)

## Examples

### Basic Agent (`examples/basic-agent.ts`)

Minimal ElizaOS v2 project with x402 payments and swarm delegation. Run with `bun run example`.

### SignalHawk (`examples/signalhawk/`)

Full-featured autonomous trading intelligence agent that:
- Buys on-chain and market data via x402 micropayments
- Runs multi-analyst MajorityVoting swarms for consensus signals
- Sells structured signal cards with confidence %, analyst agreement, and cost breakdown

See `examples/signalhawk/` for the complete implementation.

## GitHub Action

Audit smart contracts on every PR with 4 AI agents. See [`github-action/`](github-action/) for full docs.

```yaml
name: Contract Audit
on:
  pull_request:
    paths:
      - 'contracts/**/*.sol'

permissions:
  contents: read
  pull-requests: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: SolTwizzy/swarmx-audit@v1
        with:
          files: 'contracts/**/*.sol'
          fail-on-critical: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The action posts a structured audit report as a PR comment (security findings, economic attack vectors, gas optimizations) and fails the check if critical issues are found. Free tier (10 calls/day) works without a wallet.

## Development

```bash
bun install          # Install dependencies
bun run build        # Compile TypeScript
bun run test         # Run unit + integration tests (162 cases)
bun run test:smoke   # Marketplace smoke tests (needs network)
bun run dev          # Watch mode
bun run example      # Run standalone demo
```

### Key Dependencies

- `@elizaos/core@2.0.0-alpha.32` — ElizaOS v2 runtime
- `@dexterai/x402@^2.0.0` — Dexter SDK for x402 payments
- `swarms-ts@^0.1.0-alpha.10` — Swarms TypeScript SDK
- `drizzle-orm@^0.45.1` — Database schemas for payment persistence
- `zod@^3.22.0` — Runtime validation

## Roadmap

See [TODO-NEXT.md](TODO-NEXT.md) for post-MVP next steps:
- CI/CD with GitHub Actions
- npm publish to registry
- Server-side x402 middleware (sell your agent's services)
- Event hooks for payment analytics
- Custom HTTP routes for wallet status

## License

MIT
