# Podcast Pitch

**Target:** Lightspeed (Solana podcast), Latent Space (AI engineering podcast), Bankless, The Rollup, Unchained, or any crypto/AI crossover show.

Adapt per show. Lightspeed cares about Solana ecosystem growth and real usage. Latent Space cares about AI engineering, multi-agent architectures, and production systems. Bankless cares about crypto adoption narratives.

---

## Pitch Email

**Subject:** Pitch: agent-to-agent payments are live on Solana -- multi-agent AI platform using x402

---

Hi [producer/host name],

I'm the builder behind SwarmX, a platform that sells AI agent services via x402 micropayments on Solana. We're one of the first production deployments of the x402 protocol, and I think the topic of agent-to-agent payments is timely and underexplored.

**Who we are:**

We built a platform with 47 AI endpoints that accept USDC micropayments via x402 -- the HTTP 402 payment protocol developed by Dexter (Coinbase-backed). No API keys, no subscriptions. Agents pay agents in USDC.

**Why this matters:**

The agent-to-agent economy is coming, and the payment rail isn't credit cards or Stripe. It's programmatic USDC at the HTTP level. When Agent A needs a contract audit, it calls Agent B's endpoint, signs a $0.10 USDC payment, and gets the result. No human in the loop. No billing dashboard. The protocol handles it.

We're seeing this play out in production. Our endpoints are discoverable via MCP (Model Context Protocol) -- meaning any AI agent that supports MCP can find and pay for our services automatically. The loop is: agent discovers service -> agent pays USDC -> agent gets result -> agent uses result.

**Talking points:**

1. **x402 in practice** -- What is the x402 protocol, how does payment verification work, what was it like integrating with the Dexter SDK. First-hand production experience.

2. **Multi-agent orchestration at scale** -- Why single-LLM calls aren't enough for complex tasks. How we orchestrate 4-6 specialized agents for contract audits, token diligence, and DeFi risk scoring. Sequential vs concurrent vs mixture-of-agents architectures.

3. **The economics of AI-as-a-service** -- Pricing models for agent endpoints. Why pay-per-call with USDC beats subscriptions. Cost comparison: $0.05/research report vs $0.50 on CrewAI.

4. **MCP + x402 = agent commerce** -- How Model Context Protocol enables discovery, and x402 enables payment. The full loop from "agent needs something" to "agent pays for it and gets it."

5. **Building in public on Solana** -- Real payment data, real settlement transactions, real trade-offs. What works, what doesn't, what we'd do differently.

**What listeners will learn:**

- How x402 micropayments work at the protocol level (HTTP 402 -> sign -> retry -> settle)
- How to architect multi-agent systems for production (not just demos)
- Why USDC micropayments are the natural payment rail for agent-to-agent commerce
- How MCP server discovery + x402 payments create an agent services marketplace
- Practical lessons from building a 47-endpoint platform with 668 tests

**Stats:**
- 47 live endpoints, 39 MCP tools, 668 tests
- Real x402 payments on Solana mainnet
- Open source: https://github.com/swarmx-org/swarms-x402
- Live playground: https://swarmx.io

**Availability:** Flexible. Can do remote or in-person.

Looking forward to hearing from you.
