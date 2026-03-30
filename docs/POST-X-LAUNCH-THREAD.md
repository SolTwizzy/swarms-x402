# X/Twitter Launch Thread

Post each tweet separately. Wait for engagement between tweets 1-3 before posting the rest.

---

**Tweet 1 (Hook):**

We built 47 AI agent endpoints that get paid via x402 micropayments.

No subscriptions. No API keys. Just USDC.

A thread on what SwarmX is, how it works, and why agent-to-agent payments matter:

---

**Tweet 2 (What is SwarmX):**

SwarmX is AI-as-an-API where every call is a micropayment.

- Smart contract audits ($0.10)
- Token risk scoring ($0.05)
- DeFi protocol ratings ($2.00)
- Research reports ($0.05)
- Code reviews ($0.03)
- Fact-checking ($0.25)

47 endpoints. 9 categories. $0.001 to $5.00 per call.

---

**Tweet 3 (How it works):**

How it works in 3 steps:

1. You call an endpoint (e.g. POST /x402/contract-audit)
2. Server returns HTTP 402 with the price ($0.10) and USDC address
3. Your client signs the payment, retries, and gets the response

No signup. No billing page. The protocol IS the payment.

This is x402 -- HTTP 402 "Payment Required" actually working.

---

**Tweet 4 (Premium endpoints):**

The premium endpoints are where it gets interesting.

Token Due Diligence ($1.00): 5 agents run in parallel -- contract audit, tokenomics, team credibility, market analysis, liquidity check. Returns APEWORTHY / PROMISING / CAUTION / HIGH_RISK / RUG_LIKELY.

DeFi Risk Score ($2.00): 5 agents produce an AAA-to-D credit rating for any protocol.

These aren't single LLM calls. They're multi-agent teams.

---

**Tweet 5 (Numbers):**

Some numbers:

- 47 endpoints live in production
- 39 MCP tools (any AI agent can use us)
- 668 tests across 36 files
- 12 route files, 15+ swarm architectures
- First real x402 payment settled on Solana mainnet
- 5 free calls/day, no wallet needed

---

**Tweet 6 (vs competitors):**

Cost comparison:

CrewAI charges $25/mo + $0.50/execution overage.

SwarmX:
- Research report: $0.05 (vs $0.50)
- Sentiment analysis: $0.01 (vs $0.50)
- Code review: $0.03 (vs $0.50)
- 100 research reports/month: $5.00 vs $50.00

90-98% cheaper. No subscription. No account. Just pay per call.

---

**Tweet 7 (Built on):**

Built on:

- @KyeGomezB's Swarms for multi-agent orchestration (15+ architectures)
- @dexteraisol's x402 for micropayments (HTTP 402 protocol)
- Helius for on-chain Solana data
- Jupiter for token prices
- OpenAI for single-agent tasks

Standing on the shoulders of builders.

---

**Tweet 8 (Try it free):**

Try it right now. No wallet. No signup.

Playground (interactive, all 47 endpoints):
https://swarmx.io

Or just curl:

curl -X POST https://swarmx.io/x402/sentiment \
  -H "Content-Type: application/json" \
  -d '{"text": "x402 is the future of agent payments"}'

5 free calls/day per IP.

---

**Tweet 9 (MCP server):**

SwarmX is also an MCP server.

Any AI agent that supports MCP can use our 39 tools natively. Connect it to Claude, Cursor, Cline, or any MCP-compatible client:

```json
{
  "mcpServers": {
    "swarmx": {
      "url": "https://swarmx.io/mcp"
    }
  }
}
```

Your agent gets contract audits, DeFi scoring, research, and more.

---

**Tweet 10 (CTA):**

SwarmX is open source.

GitHub: https://github.com/swarmx-org/swarms-x402

If you're building agents that need to pay for services (or sell services), x402 is how.

Star the repo. Try the playground. Tell us what endpoints to add next.

AI Agent Teams. One Payment.
