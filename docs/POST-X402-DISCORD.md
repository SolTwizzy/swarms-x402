# x402 Discord Introduction

**Channel:** x402 community Discord (likely #showcase or #introductions)

---

Hey -- we built SwarmX, a multi-agent AI platform that uses x402 for all payments.

**What we built:** 47 HTTP endpoints that sell AI agent services for USDC micropayments. Smart contract audits, token risk scoring, DeFi protocol ratings, research reports, code reviews, and more. Pricing ranges from $0.001 (data queries) to $2.00 (6-agent orchestration).

**How we use x402:** Every paid endpoint returns HTTP 402 with payment requirements. The Dexter SDK on the client side handles signing and retry automatically. We use `createX402Server` from `@dexterai/x402/server` for verification and settlement. We've processed real payments on Solana mainnet.

**Tech details:**
- TypeScript + Bun runtime
- 12 route files, 668 tests
- x402 gate function wraps every handler -- checks free tier (5/day per IP), then falls back to 402 payment
- Also an MCP server (39 tools) and ElizaOS v2 plugin
- Deployed on Railway: https://swarmx.io

**What we'd love feedback on:**
- Our x402 integration pattern (gate function approach vs middleware)
- Access pass tiers for high-frequency trading endpoints (1h/24h/7d/30d pricing)
- Any edge cases we should handle in payment verification

GitHub: https://github.com/SolTwizzy/swarms-x402
API docs: https://github.com/SolTwizzy/swarms-x402/blob/master/docs/API-REFERENCE.md

This is one of the first production deployments using x402 for agent-to-agent payments. Happy to share what we learned.
