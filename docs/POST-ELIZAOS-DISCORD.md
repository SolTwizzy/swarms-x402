# ElizaOS Community Discord Introduction

**Channel:** ElizaOS Discord (likely #plugins or #showcase)

---

We built an ElizaOS v2 plugin that adds x402 micropayments + Swarms multi-agent orchestration to any ElizaOS agent. PR #322 is open in the elizaos-plugins registry.

**Plugin:** `swarms-x402`

**What it adds to your agent:**

- **5 actions:** PAY_FOR_X402_SERVICE, DISCOVER_X402_SERVICES, DELEGATE_TO_SWARM, RUN_SWARM_AGENT, DELEGATE_TO_SWARM_WITH_PAYMENT
- **4 services:** X402WalletService (buy-side USDC payments), SwarmsService (multi-agent orchestration), X402ServerService (sell-side revenue), PaymentMemoryService (payment persistence)
- **2 providers:** x402Provider (wallet context for buy-side), x402ServerProvider (revenue context for sell-side)
- **1 evaluator:** paymentEvaluator (budget monitoring + LLM quality scoring)
- **47 routes:** AI agent endpoints with x402 payment gating
- **4 templates:** ResearchPipeline, AnalysisPanel, CodeReview, DebateAndDecide

**What this means for your agent:**

1. **Buy-side:** Your agent can discover and pay for x402-protected services automatically. Set a budget, and the agent handles payment decisions, USDC signing, and retry logic.

2. **Sell-side:** Your agent can sell its own services for USDC. Wrap any route handler with `x402Gate()` and it returns 402 with payment requirements. Revenue settles directly to your wallet.

3. **Multi-agent:** Delegate complex tasks to Swarms. A user asks "research Solana DeFi" and the plugin spins up 3 agents (Researcher, FactChecker, Writer) in a sequential pipeline.

**Installation:**

```typescript
import { x402SwarmsPlugin } from "swarms-x402";

// Add to your ElizaOS agent
const agent = new Agent({
  plugins: [x402SwarmsPlugin],
  // ...
});
```

**Env vars:**
```
SOLANA_PRIVATE_KEY=...    # or EVM_PRIVATE_KEY
SWARMS_API_KEY=...
OPENAI_API_KEY=...
X402_RECEIVE_ADDRESS=...  # for sell-side
```

**Registry PR:** elizaos-plugins/registry #322 (CodeRabbit checks passing)

**Compatibility:** Built against `@elizaos/core@2.0.0-alpha.32`. Follows all v2 API patterns -- action handlers return `{ success, text, error }`, services array takes classes not instances, state is optional.

**GitHub:** https://github.com/swarmx-org/swarms-x402
**Live API (standalone mode):** https://swarmx.io

The plugin also works standalone (without ElizaOS) as a Bun HTTP server. Same routes, same payment logic, just without the ElizaOS runtime.

Questions welcome -- especially about v2 API patterns. We hit a few gotchas during development (callback content must be ContentValue-compatible, don't name a property `config` in Service subclasses, etc.) and documented them all.
