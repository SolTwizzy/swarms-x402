# OpenDexter Web UI Listing -- Outreach Message

## Target

- **Platform:** Telegram
- **Contact:** https://t.me/dexterdao
- **Goal:** Request inclusion in the curated web UI feed at dexter.cash/opendexter

---

## Message (Telegram DM to @dexterdao)

```
Hi Dexter team,

I'm the developer behind SwarmX (api.swarmx.io) -- a multi-agent AI orchestration platform built on the Dexter x402 SDK.

Requesting inclusion in the OpenDexter curated web UI feed.

What SwarmX does:
- 28 x402-gated endpoints on Solana mainnet
- Multi-agent AI tasks: smart contract audits (4-6 agents), token risk scoring, DAO analysis, research pipelines, code review, wallet analytics, and trading data
- 15+ swarm architectures (Sequential, Concurrent, MixtureOfAgents, etc.)
- $0.001-$0.25 USDC per call
- Free tier (10 calls/day) with truncated output to drive paid conversion

Current status:
- All 28 endpoints are live and indexed in the Dexter SDK/MCP programmatic index
- First settlement completed (tx 48HXBQNS... on Solana mainnet)
- 392 tests passing, deployed on Railway
- Built with @dexterai/x402@2.0.0

Technical details:
- TypeScript, Bun runtime, ElizaOS v2 plugin
- Uses createX402Server from @dexterai/x402/server for payment gating
- Uses wrapFetch + searchAPIs from @dexterai/x402/client for buy-side
- Implements access passes for high-frequency data endpoints

This is the TypeScript production implementation of Kye Gomez's "Monetize Agents with Swarms and x402" tutorial. We're extending the pattern with templates, persistence, budget controls, and sell-side revenue tracking.

Links:
- Live API: https://api.swarmx.io
- Catalog (free): https://api.swarmx.io/x402/catalog
- GitHub: https://github.com/SolTwizzy/swarms-x402
- Health: https://api.swarmx.io/x402/health

Happy to provide any additional information needed for the curation process. Thanks for building the SDK -- it made x402 integration straightforward.
```

---

## Follow-Up Notes

- If no response after 48 hours, follow up once with a shorter message referencing the original
- Offer to do a joint tweet/announcement if they add us
- Mention settlement data as proof of real usage (not just a test deployment)
- Be prepared to share the receive address for verification: `H1ooMkPx8uXoPS5WYz5JMY7dnYacqGLD3ZfEEku5caAZ`
