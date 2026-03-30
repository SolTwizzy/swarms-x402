# Show HN Post

**Title:** Show HN: SwarmX -- 47 AI agent endpoints with x402 micropayments (pay per call with USDC)

---

**Body:**

SwarmX is a platform that exposes 47 AI endpoints as a paid HTTP API. Instead of API keys, accounts, or subscriptions, it uses x402 -- the HTTP 402 payment protocol built by Coinbase/Dexter. When a client hits a paid endpoint, the server returns 402 with a payment requirement. The client signs a USDC transaction, retries, and gets the response. No signup, no billing dashboard.

The endpoints range from simple ($0.001 for a token price lookup) to complex ($2.00 for a 6-agent DeFi protocol risk assessment). The multi-agent endpoints use Swarms for orchestration -- multiple specialized LLM agents working in parallel or sequence. A contract audit, for example, runs SecurityAuditor, EconomicAttacker, GasOptimizer, and AuditReporter concurrently and synthesizes the output into a structured risk report.

Single-agent tasks (summarize, translate, sentiment) call OpenAI directly to avoid orchestration overhead. Multi-agent tasks (research, code review, fact-checking) route through Swarms. The routing is per-endpoint, not per-request.

Built with TypeScript, Bun, and 668 tests across 36 files. Also works as an MCP server (39 tools) and as an ElizaOS v2 plugin. 5 free calls/day per IP.

Live playground: https://swarmx.io
GitHub: https://github.com/swarmx-org/swarms-x402
API docs: https://github.com/swarmx-org/swarms-x402/blob/master/docs/API-REFERENCE.md
