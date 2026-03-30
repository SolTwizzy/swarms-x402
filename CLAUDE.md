# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
bun install              # Install dependencies
bun run build            # Compile TypeScript (tsc)
bun run test             # Run all unit + integration tests (vitest)
bun run test:smoke       # Run marketplace smoke tests (needs network, RUN_SMOKE=true)
bun run dev              # Watch mode (tsc --watch)
bun run example          # Run standalone demo (tsx examples/basic-agent.ts)
```

Run a single test file: `bunx vitest run tests/actions/payForService.test.ts`
Run tests matching a pattern: `bunx vitest run --testPathPattern templates`

## Architecture

This is a **standalone x402+Swarms platform AND ElizaOS v2 plugin** that bridges two systems:
- **x402 payments** via the Dexter SDK (`@dexterai/x402`) — automatic HTTP 402 → pay → retry
- **Multi-agent orchestration** via Swarms (`swarms-ts`) — 15+ swarm architectures

**Two deployment modes:**
- **Standalone platform**: `bun run start:server` or Docker — exposes all routes as HTTP API, no ElizaOS needed
- **ElizaOS plugin**: `import { x402SwarmsPlugin }` — integrates into any ElizaOS v2 agent

**LLM routing**: Single-agent tasks (summarize, translate, extract, sentiment, agent) call OpenAI directly via `src/utils/llm.ts` — no Swarms overhead. Multi-agent tasks (research, analyze, code-review, write, debate) use Swarms API for orchestration. Fallback: if `OPENAI_API_KEY` is not set, all tasks route through Swarms.

### Plugin Registration (src/index.ts)

The plugin exports `x402SwarmsPlugin` with:
- **5 actions**: PAY_FOR_X402_SERVICE, DISCOVER_X402_SERVICES, DELEGATE_TO_SWARM, RUN_SWARM_AGENT, DELEGATE_TO_SWARM_WITH_PAYMENT
- **4 services**: X402WalletService, SwarmsService, X402ServerService, PaymentMemoryService
- **2 providers**: x402Provider (buy-side wallet context), x402ServerProvider (sell-side revenue)
- **1 evaluator**: paymentEvaluator (budget monitoring + LLM quality scoring)
- **5 routes**: x402-protected HTTP endpoints for selling agent services
- **4 templates**: Pre-built swarm configs (ResearchPipeline, AnalysisPanel, CodeReview, DebateAndDecide)
- **3 DB schemas**: Drizzle ORM tables for payment persistence

### Key Patterns

**ElizaOS v2 API requirements:**
- Action handlers must return `{ success: boolean; text?: string; error?: string } | undefined` (not `void`)
- Callback `content` fields must be `ContentValue`-compatible (JSON-serializable strings, not arbitrary objects)
- Plugin `services` array takes **classes** (`[MyService]`), not instances
- `state` parameter is optional in all handlers (`State | undefined`)
- `runtime.getSetting()` returns `string | boolean | number | null` — cast with `String(val)`
- Logger is Pino-style: `runtime.logger.info(obj, message)` — object first, string second
- Do NOT name a property `config` in Service subclasses — conflicts with `Service.config?: Metadata`

**Two payment systems (independent auth):**
- x402 (Dexter): wallet key auth (`SOLANA_PRIVATE_KEY` or `EVM_PRIVATE_KEY`), pays USDC automatically
- Swarms: API key auth (`SWARMS_API_KEY` via `x-api-key` header), charges per-token + per-agent

**Swarm templates** (src/templates/): Keyword regex pre-filter → LLM classification fallback → "custom" preserves legacy behavior. Templates are ordered by specificity in `SWARM_TEMPLATES` array.

**Server-side x402** (src/server/): Uses `createX402Server()` from `@dexterai/x402/server` directly (not Express middleware). The `x402Gate()` function adapts this for ElizaOS route handlers.

**Payment persistence** (src/schemas/, src/services/paymentMemoryService.ts): Dual storage — Drizzle ORM for structured queries, in-memory fallback when no DB. Fire-and-forget recording in X402WalletService never blocks payment flow.

**LLM routing strategy** (src/utils/llm.ts): Single-agent endpoints call OpenAI directly for cost efficiency (~$0.001/call). Multi-agent endpoints use the Swarms API which orchestrates multiple LLM calls server-side. The routing decision is per-endpoint, not per-request. If `OPENAI_API_KEY` is absent, all tasks gracefully fall back to Swarms.

**Access passes** (Dexter SDK): Per-call x402 pricing adds ~200-500ms latency (402 → sign → retry), which is fine for multi-agent tasks but unacceptable for high-frequency data/trading endpoints. Access passes let buyers pay once ($1/day, $5/week, $25/month) for time-limited unlimited access at native HTTP latency. Configured via `X402_ACCESS_PASS_TIER` env var. The Dexter SDK handles pass purchase, verification, and expiry internally — no custom code needed.

### Import Conventions

- Dexter client: `import { wrapFetch, searchAPIs } from "@dexterai/x402/client"`
- Dexter server: `import { createX402Server } from "@dexterai/x402/server"`
- Swarms types: `import type { AgentSpec } from "swarms-ts/resources"` (NOT from `"swarms-ts"`)
- All local `.ts` imports use `.js` extensions (ESM output with bundler moduleResolution)

### Module Configuration

- ESM (`"type": "module"` in package.json)
- `tsconfig.json`: `module: ES2022`, `moduleResolution: bundler`, `strict: true`
- `examples/` excluded from tsconfig — SignalHawk example won't break main build

## Project Identity

**Brand: SwarmX** — a platform for AI agent tasks powered by x402 micropayments and Swarms multi-agent orchestration.

This project implements the pattern described in the official Swarms x402 tutorial:
https://medium.com/@kyeg/how-to-monetize-your-agents-with-swarms-and-x402-a-simple-step-by-step-tutorial-e56bacc2daf2

We are the **TypeScript/ElizaOS implementation** of "monetize your agents with Swarms and x402" — extending the Python/FastAPI tutorial pattern with templates, persistence, budget controls, sell-side revenue, and ElizaOS plugin integration.

**Dual distribution:** standalone platform (server.ts + Dockerfile → Railway) AND ElizaOS plugin (npm package → elizaos-plugins registry PR).

See `docs/REFERENCE-swarms-x402-tutorial.md` for the full tutorial comparison.

## OpenDexter Discovery

Endpoints are discoverable via the Dexter SDK (`searchAPIs()`) and the OpenDexter MCP URL (`https://open.dexter.cash/mcp`). The web UI at `dexter.cash/opendexter` shows a **curated "Approved" subset** — not all indexed endpoints appear there.

- **Programmatic discovery** (SDK/MCP): Our endpoints show up immediately after settlement. Any agent calling `searchAPIs({ query: "x402-swarms" })` finds them.
- **Web UI feed** (`dexter.cash/opendexter`): Curated. Requires Dexter team approval to appear. Contact: https://t.me/dexterdao
- **Facilitator URL**: `https://x402.dexter.cash` (default, no config needed)
- **Onboarding page**: `https://dexter.cash/onboard` — no API keys or accounts needed for selling, just return proper 402 responses
- **Settlement triggers indexing**: First successful x402 settlement on an endpoint auto-adds it to the SDK/MCP index (not the web UI)

## Env Vars

Required for payments: `SOLANA_PRIVATE_KEY` or `EVM_PRIVATE_KEY`
Required for swarms: `SWARMS_API_KEY`
Required for LLM: `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`
Required for selling: `X402_RECEIVE_ADDRESS`
Network: `X402_NETWORK_ID` (default: `base-mainnet`)
Budget: `X402_BUDGET_USD` (default: `10.00`), `X402_MAX_AUTO_PAY_USD` (default: `0.10`)
Access passes: `X402_ACCESS_PASS_TIER` (e.g. `24h`, `7d`, `30d`) — time-limited unlimited access for data endpoints

## Memory System

This project uses the Itachi Memory System for persistent context across Claude Code sessions.

### How It Works

- All file edits are automatically synced to a cloud database
- Memories are searchable using semantic search (OpenAI embeddings)
- Context persists across sessions, computers, and time

### Commands

- /recall <query> - Search memories semantically
- /recent [limit] - Show recent changes (default: 10)
- /itachi-init - Add memory docs to CLAUDE.md

### Memory Categories

Changes are auto-categorized:
- code_change - Default for code files
- test - Test/spec files
- documentation - README, .md files
- dependencies - package.json, requirements.txt, etc.

### Disable Memory

To disable memory for this project, create a file called .no-memory in the project root.
