# Product Hunt Launch

## Listing Details

**Name:** SwarmX

**Tagline:** AI Agent Teams. One Payment.

**Topics:** Artificial Intelligence, Developer Tools, Crypto, APIs

**Pricing:** Free tier (5 calls/day) + pay-per-use ($0.001 - $5.00 USDC)

**Website:** https://swarmx.io

**GitHub:** https://github.com/SolTwizzy/swarms-x402

---

## Description (250 words)

SwarmX is a platform that sells AI agent services via HTTP micropayments. Instead of API keys, subscriptions, or accounts, every endpoint uses the x402 payment protocol -- HTTP 402 "Payment Required" with automatic USDC settlement.

The platform exposes 47 endpoints across 9 categories: smart contract auditing, token risk scoring, DeFi protocol ratings, research reports, code reviews, fact-checking, content generation, compliance checks, and trading data. Prices range from $0.001 for a token price lookup to $2.00 for a 6-agent DeFi protocol risk assessment.

What makes SwarmX different from other AI APIs is multi-agent orchestration. A contract audit doesn't call one LLM -- it runs 4-6 specialized agents (SecurityAuditor, EconomicAttacker, GasOptimizer, AuditReporter) in parallel and synthesizes the results. A fact-check runs 4 agents in sequence: claim extraction, evidence gathering, devil's advocate, and judge verdict. These are agent teams, not single models.

Payments happen at the HTTP protocol level via x402 (developed by Dexter/Coinbase). No signup required. Your client sends a request, gets a 402 with the price, signs a USDC transaction, retries, and gets the response. Works on Solana, Base, Ethereum, Polygon, and Arbitrum.

SwarmX also works as an MCP server (39 tools for any AI agent) and as an ElizaOS v2 plugin. It's open source, built with TypeScript and Bun, and has 668 tests.

5 free calls per day per IP. No wallet needed to try it.

---

## Key Features (5 bullets)

1. **47 AI endpoints** -- Smart contract audits, token risk scoring, DeFi ratings, research, code review, fact-checking, and more
2. **Multi-agent teams** -- Premium endpoints orchestrate 4-6 specialized agents working in parallel, not single LLM calls
3. **x402 micropayments** -- No API keys, no accounts. Pay per call in USDC. The HTTP protocol IS the billing.
4. **MCP server** -- 39 tools that any MCP-compatible AI agent (Claude, Cursor, Cline) can use natively
5. **Open source** -- TypeScript, Bun, 668 tests. Self-host with Docker or use the live API.

---

## Maker Comment Draft

Hey Product Hunt -- I'm the builder behind SwarmX.

The problem we're solving: existing AI agent platforms charge subscriptions ($25-200/mo) and require accounts, API keys, billing dashboards. If you just want to run one contract audit or one research report, you're paying for a whole month.

With x402, the payment is built into the HTTP protocol. Your client calls an endpoint, the server says "this costs $0.10 in USDC," your client signs the payment and retries. No middleware. No billing page. The protocol is the payment.

We built 47 endpoints across 9 categories. The simple ones ($0.001-$0.01) do data lookups and single-agent tasks. The premium ones ($0.25-$2.00) orchestrate 4-6 specialized AI agents working together -- a contract audit runs SecurityAuditor, EconomicAttacker, GasOptimizer, and AuditReporter in parallel.

The free tier gives you 5 calls/day with no wallet needed. The playground lets you test every endpoint interactively.

Try it: https://swarmx.io

The whole thing is open source with 668 tests. We'd love your feedback on which endpoints are most useful and what to build next.
