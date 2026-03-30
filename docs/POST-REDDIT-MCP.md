# r/mcp Post

**Subreddit:** r/mcp (102K subscribers)

**Title:** swarms-x402: 39 MCP tools for AI agent tasks -- contract audits, DeFi risk scoring, research reports, fact-checking ($0.001-$5/call via x402)

---

**Body:**

We built an MCP server that exposes 39 tools across 9 categories. Each tool is an AI agent endpoint -- some use a single LLM call, others orchestrate 4-6 agents working together. Payments are handled via x402 (HTTP 402 payment protocol), so there are no API keys or accounts. You just connect and call.

**What's in there:**

- **Crypto analysis** -- contract audit (quick/standard/deep), token risk scoring, DAO proposal analysis, memecoin scoring
- **DeFi** -- yield optimization, defi-positions scanning, protocol risk scoring (AAA-to-D rating)
- **Trading data** -- token price, supply, slot info, recent blockhash (2-5s cache, $0.001/call)
- **Wallet analysis** -- balance, token holdings, tx history, holder concentration, full wallet reports
- **Code audit** -- multi-agent code review (security + performance + style, parallel agents)
- **Research** -- multi-agent research pipeline (researcher + fact-checker + writer)
- **Content** -- SEO articles, document extraction, translation, summarization
- **Compliance** -- regulatory compliance checks, investment due diligence
- **General AI** -- sentiment analysis, data extraction, debate/argumentation

**How to connect:**

Add this to your MCP client config:

```json
{
  "mcpServers": {
    "swarmx": {
      "url": "https://swarmx.io/mcp"
    }
  }
}
```

Manifest: https://swarmx.io/mcp-manifest.json

**Pricing:**

- 5 free calls/day per IP, no wallet needed
- After that: $0.001 for data queries, $0.01-$0.05 for single-agent tasks, $0.25-$2.00 for multi-agent orchestration
- Payment is in USDC (Solana, Base, or any EVM chain) via the x402 protocol -- your client handles it automatically with the Dexter SDK

**Tech stack:**

TypeScript, Bun runtime, 12 route files, 668 tests. Multi-agent tasks use the Swarms API (sequential/concurrent/mixture-of-agents workflows). Single-agent tasks call OpenAI directly for cost efficiency. On-chain data comes from Helius RPC + Jupiter price API.

**Links:**

- GitHub: https://github.com/swarmx-org/swarms-x402
- Live API: https://swarmx.io
- Playground: https://swarmx.io (interactive, no login)
- API Reference: https://github.com/swarmx-org/swarms-x402/blob/master/docs/API-REFERENCE.md

The multi-agent endpoints are the interesting ones from an MCP perspective. The contract-audit tool, for example, runs 4 agents in parallel (SecurityAuditor, EconomicAttacker, GasOptimizer, AuditReporter) and returns a structured risk report with findings, scores, and a shareable report URL. The deep audit tier runs 6 agents with cross-verification.

Happy to answer questions about the architecture or how x402 payments work in practice with MCP.
