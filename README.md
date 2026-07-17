# SwarmX — AI due diligence on everything tradeable

**Live at [swarmx.io](https://swarmx.io)** · [X/Twitter @swarmx_402](https://x.com/swarmx_402) · [Benchmark](https://swarmx.io/x402/benchmark) · [Gallery](https://swarmx.io/x402/gallery)

Adversarial AI swarms for anything you can trade — tokenized stocks, crypto tokens, wallets, smart contracts — plus research pipelines, audits, and live on-chain data. **45 endpoints, $0.01–$0.19 a call**, paid in USDC over the [x402 protocol](https://www.x402.org/). No account, no API key. Any human or agent with a wallet can buy a single call.

```text
$ swarmx stock-dd --ticker AAPL

POST /x402/rwa/stock-dd
402 → settle 0.10 USDC → 200 OK

bull    6-month price trend up 21.9%
bear    Position at 89.3% of range — overvaluation concerns
risk    Downside toward 6-month low of 243.42

verdict NEUTRAL · confidence 0.50
```

Three analysts — **WASP** (bull), **HORNET** (bear), **LOCUST** (risk) — argue every ticker before a judge rates it. Real market data is fetched before you're ever charged.

## Try it now (free, no wallet)

Every endpoint gives **3 free calls per day with full output** — the only gate is the count.

```bash
curl -X POST https://swarmx.io/x402/rwa/stock-dd \
  -H "Content-Type: application/json" \
  -d '{"ticker":"NVDA"}'
```

Or use the browser playground: [swarmx.io](https://swarmx.io/#playground)

## Connect your agent (MCP)

Point any MCP-speaking agent (Claude Code, OpenClaw, Hermes, …) at:

```text
https://swarmx.io/mcp
```

48 tools. Free tools execute directly; paid tools settle per call via x402 from the agent's own wallet. Agents can also pair with a human browsing swarmx.io via magic-link (**Agent Link**) — the human clicks, the agent pays, results render in both places.

## Pay per call (x402)

After the free tier, calls settle in USDC — automatically, in one retry — on any of four chains:

| Chain | Asset | Facilitator |
|-------|-------|-------------|
| Base (`eip155:8453`) | USDC | Meridian |
| Arbitrum (`eip155:42161`) | USDC | Meridian |
| Solana | USDC | Dexter |
| Robinhood Chain (`eip155:4663`) | USDG (gasless) | self-hosted |

All four rails are proven with real on-chain settlements.

```ts
import { wrapFetch } from "@dexterai/x402/client";

const payingFetch = wrapFetch(fetch, {
  evmPrivateKey: process.env.EVM_PRIVATE_KEY,
  preferredNetwork: "eip155:8453", // Base
});

const res = await payingFetch("https://swarmx.io/x402/rwa/stock-dd", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ticker: "AAPL" }),
});
console.log(await res.json());
```

## What's behind the 45 endpoints

**Equities & RWA** (the flagship line)

| Endpoint | Price | What you get |
|----------|-------|--------------|
| `POST /x402/rwa/stock-dd` | $0.10 | Full due diligence: real market data + 3-analyst debate + rated verdict |
| `POST /x402/rwa/screen` | $0.15 | Rank a watchlist of 2–8 tokenized stocks |
| `POST /x402/rwa/compare` | $0.10 | Head-to-head DD on two equities with a winner |
| `POST /x402/rwa/catalyst` | $0.05 | Real dividends, splits, notable moves |
| `POST /x402/rwa/eligibility` | $0.02 | Deterministic tokenization-eligibility screen |

**Crypto & On-chain** — contract audits (a live-tested [benchmark](https://swarmx.io/x402/benchmark) shows **93.3% detection** across 15 known-vulnerable contracts), token risk, memecoin scores, wallet forensics, DAO analysis, and $0.01 data feeds (prices, holders, transactions) at native HTTP latency.

**General Agents** — deep research, adversarial fact-checking, multi-expert analysis, writing, translation, code review, compliance checks.

Full machine-readable listing: [`/x402/catalog`](https://swarmx.io/x402/catalog) · [`/openapi.json`](https://swarmx.io/openapi.json) · human-readable: [swarmx.io/#endpoints](https://swarmx.io/#endpoints)

Every analysis returns a **shareable report page and an SVG badge** for your README:

```md
[![SwarmX Audit](https://swarmx.io/badge/<report-id>)](https://swarmx.io/report/<report-id>)
```

## Self-host

The whole platform is a standalone Bun server — no external orchestration needed.

```bash
git clone https://github.com/SolTwizzy/swarms-x402
cd swarms-x402
bun install
cp .env.example .env   # set keys — see below
bun run start:server   # or: docker build -t swarmx . && docker run -p 3000:3000 swarmx
```

| Env var | Purpose |
|---------|---------|
| `X402_RECEIVE_ADDRESS` | where your USDC revenue settles (required to sell) |
| `SOLANA_PRIVATE_KEY` / `EVM_PRIVATE_KEY` | buy-side wallet (only needed to *pay* other services) |
| `OPENAI_API_KEY` | LLM for the analyst panels |
| `SWARMS_API_KEY` | optional — routes multi-agent work through [Swarms](https://swarms.world) |
| `HELIUS_API_KEY` | Solana data endpoints |

Build and test: `bun run build` · `bun run test` (880+ tests).

## Use as an ElizaOS plugin

The same codebase exports an [ElizaOS](https://elizaos.ai) v2 plugin (registry PR in review — install from source for now):

```ts
import { x402SwarmsPlugin } from "./src/index.js";
// 5 actions (pay, discover, delegate, run-agent, delegate-with-payment),
// 4 services, x402-gated routes, budget evaluator, payment persistence
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full system design and [docs/API-REFERENCE.md](docs/API-REFERENCE.md) for every endpoint.

## Links

- Site: [swarmx.io](https://swarmx.io) · MCP: `https://swarmx.io/mcp`
- X / Twitter: [@swarmx_402](https://x.com/swarmx_402)
- Issues: [GitHub](https://github.com/SolTwizzy/swarms-x402/issues)
- Powered by [Dexter SDK](https://www.opendexter.xyz) · [Swarms](https://swarms.world) · [ElizaOS](https://elizaos.ai)

**License:** MIT · Analyses are informational only — not investment advice.
