# Reference: How to Monetize Your Agents with Swarms and X402

> Source: https://medium.com/@kyeg/how-to-monetize-your-agents-with-swarms-and-x402-a-simple-step-by-step-tutorial-e56bacc2daf2
> Author: Kye Gomez (Swarms creator)
> Fetched: 2026-03-26

This is the official Swarms tutorial for x402 integration. Our project (`@elizaos/plugin-x402-swarms`) implements this same pattern in TypeScript/ElizaOS instead of Python/FastAPI.

## What the Tutorial Covers

A step-by-step guide to integrating **Swarms** (Python multi-agent framework) with **x402** (cryptocurrency micropayment protocol) to create revenue-generating AI agent APIs.

## Architecture (Python/FastAPI)

```
FastAPI Server
  + x402 Payment Middleware (intercepts requests, validates blockchain payments)
  + Swarms ResearchAgent (multi-agent orchestration)
  + Exa Search Tool (data retrieval)
  = Paid API endpoint that charges USDC per request
```

## Stack

- **Python 3.11+**, FastAPI, uvicorn
- **Swarms** (`pip install swarms`) — multi-agent orchestration
- **x402** (`pip install x402`) — Coinbase x402 payment middleware for FastAPI
- **Exa Search** — AI-native web search tool
- **Coinbase Developer Platform** — wallet + x402 credentials

## Environment Variables

```
OPENAI_API_KEY=         # LLM access
EXA_API_KEY=            # Search integration
COINBASE_WALLET_ADDRESS= # Payment destination
COINBASE_API_KEY=        # CDP credentials
COINBASE_API_SECRET=
COINBASE_NETWORK=base    # base, ethereum, polygon
```

## Key Pattern: x402 Payment Middleware

The middleware intercepts HTTP requests, checks for payment proof, and only executes the endpoint after payment confirmation:

```python
# Python/FastAPI pattern:
from x402.fastapi.middleware import require_payment

app.middleware("http")(
    require_payment(
        path="/research",
        price="$0.01",
        pay_to_address="0xYourWallet",
        network_id="base-sepolia"
    )
)
```

**Our TypeScript equivalent:**
```typescript
// Our pattern (ElizaOS + Dexter SDK):
import { x402Gate } from "./server/x402Gate.js";

// In route handler:
const gate = await x402Gate(runtime, req, res, {
  amountUsd: "0.01",
  description: "Research endpoint",
});
if (!gate.paid) return; // 402 already sent
// Payment verified — proceed
```

## Key Pattern: Paid Research Endpoint

```python
# Python/FastAPI:
@app.post("/research")
async def research(request: ResearchRequest):
    agent = Agent(agent_name="Research-Agent", model_name="gpt-4o-mini")
    result = agent.run(request.query)
    return {"result": result}
```

**Our TypeScript equivalent:**
```typescript
// Our route (src/routes/x402Routes.ts):
{
  type: "POST",
  path: "/x402/research",
  handler: async (req, res, runtime) => {
    const gate = await x402Gate(runtime, req, res, { amountUsd: "0.05" });
    if (!gate.paid) return;
    const result = await swarmsService.runSwarm({
      agents: researchPipelineTemplate.agents,
      task: query,
      swarm_type: "SequentialWorkflow",
    });
    res.json({ result: result.output });
  },
}
```

## How Our Project Extends This

The tutorial shows a **single Python endpoint**. Our project provides:

| Tutorial (Python) | Our Project (TypeScript/ElizaOS) |
|---|---|
| 1 research endpoint | 7 x402-gated endpoints |
| Single agent | 15+ swarm architectures via templates |
| Coinbase x402 SDK | Dexter SDK (more chains, access passes, budget controls) |
| Manual deployment | Dockerfile + Railway deployment |
| No persistence | Drizzle ORM schemas for payment history + quality scoring |
| FastAPI only | ElizaOS plugin + standalone platform |
| Buy-side only | Buy AND sell-side (agents earn revenue) |

## Production Deployment Notes (from tutorial)

- Replace test wallet addresses with production wallets
- Deploy to hosting: Fly.io, AWS, or **Railway** (what we use)
- Enable HTTPS via reverse proxy
- Monitor payment settlement on-chain

## Why This Matters

This tutorial by the Swarms creator validates our exact architecture: **x402 payment middleware + Swarms multi-agent orchestration = monetizable agent APIs**. We're the TypeScript/ElizaOS implementation of this pattern, with additional features (templates, persistence, budget controls, sell-side).
