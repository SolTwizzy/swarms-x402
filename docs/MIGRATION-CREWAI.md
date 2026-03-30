# Migrate from CrewAI to SwarmX

Switching from CrewAI to SwarmX gives you the same multi-agent orchestration at a fraction of the cost, with native USDC micropayments, no accounts, and no subscriptions.

## Why Switch?

| | CrewAI | SwarmX |
|---|--------|--------|
| **Pricing model** | $25/mo subscription + $0.50/execution overage | Pay-per-use: $0.001--$0.25/call |
| **Accounts** | Required (email, billing, API key) | None. Just a wallet. |
| **Payment** | Credit card / invoice | USDC on Solana or Base (x402 protocol) |
| **Free tier** | 50 executions/month | 5 calls/day per IP, no account needed |
| **Multi-agent** | Crews with sequential/hierarchical processes | 15+ swarm architectures |
| **Self-hosted option** | Enterprise tier only | Open-source, Docker, Railway |
| **Monetization** | Build agents only | Build AND sell agents via x402 |

### Cost Comparison

| Use Case | CrewAI Cost | SwarmX Cost | Savings |
|----------|------------|-------------|---------|
| 100 research reports/month | $50 (subscription) or $50 (overage) | $5.00 (100 x $0.05) | 90% |
| 1,000 sentiment analyses/month | $500 (overage) | $10.00 (1,000 x $0.01) | 98% |
| 50 code reviews/month | $25 (overage) | $1.50 (50 x $0.03) | 94% |
| 500 single agent tasks/month | $250 (overage) | $10.00 (500 x $0.02) | 96% |
| 10 smart contract audits/month | $5 (overage) | $1.00 (10 x $0.10) | 80% |

## Concept Mapping

| CrewAI | SwarmX | Notes |
|--------|--------|-------|
| `Crew` | Swarm template | Pre-built orchestration pattern (ResearchPipeline, AnalysisPanel, CodeReview, DebateAndDecide) |
| `Agent` | `AgentSpec` | Agent config: name, model, system prompt, temperature |
| `Task` | `task` string | Plain text task description sent in request body |
| `Process.sequential` | `SequentialWorkflow` | Linear agent chain (e.g., Researcher -> FactChecker -> Writer) |
| `Process.hierarchical` | `HiearchicalSwarm` | Manager delegates to workers |
| `@tool` decorator | MCP tools | Tool integration via Model Context Protocol |
| `CrewBase` class | HTTP endpoint | Each SwarmX endpoint is a self-contained crew |
| `crew.kickoff()` | `POST /x402/research` | HTTP call replaces Python method call |
| Crew AI Studio (no-code) | `curl` / Client SDK | Code-first, API-first |
| `.env` API key | Wallet private key | USDC wallet replaces API key billing |

## Quick Start

No SDK, no account, no setup. Just `curl`:

```bash
# Research report (free tier -- no payment needed for first 5 calls/day)
curl -X POST https://api.swarmx.io/x402/research \
  -H "Content-Type: application/json" \
  -d '{"query": "State of Solana DeFi in 2026", "depth": "standard"}'

# Sentiment analysis
curl -X POST https://api.swarmx.io/x402/sentiment \
  -H "Content-Type: application/json" \
  -d '{"text": "Bitcoin ETFs have driven unprecedented institutional adoption"}'

# Multi-agent code review
curl -X POST https://api.swarmx.io/x402/code-review \
  -H "Content-Type: application/json" \
  -d '{"code": "function add(a, b) { return a + b; }", "language": "JavaScript"}'

# List all available endpoints and pricing
curl https://api.swarmx.io/x402/catalog
```

For paid access beyond the free tier, use the Client SDK with a wallet key (see below).

## Code Comparison

### CrewAI (Python)

```python
from crewai import Agent, Task, Crew, Process

# Define agents
researcher = Agent(
    role="Researcher",
    goal="Research the topic thoroughly",
    backstory="You are an expert researcher...",
    llm="gpt-4o-mini",
)

fact_checker = Agent(
    role="FactChecker",
    goal="Verify all claims",
    backstory="You are a meticulous fact-checker...",
    llm="gpt-4o-mini",
)

writer = Agent(
    role="Writer",
    goal="Write a clear report",
    backstory="You are a skilled writer...",
    llm="gpt-4o",
)

# Define tasks
research_task = Task(
    description="Research: State of Solana DeFi in 2026",
    agent=researcher,
)
check_task = Task(
    description="Verify the research findings",
    agent=fact_checker,
)
write_task = Task(
    description="Write the final report",
    agent=writer,
)

# Create crew and run
crew = Crew(
    agents=[researcher, fact_checker, writer],
    tasks=[research_task, check_task, write_task],
    process=Process.sequential,
)

result = crew.kickoff()
print(result)
```

**Lines of code:** ~40
**Dependencies:** `crewai`, `langchain`, plus API key setup and account creation
**Cost:** $0.50/execution (after 100/month free on $25/mo plan)

### SwarmX (TypeScript -- Client SDK)

```typescript
import { createClient } from "@elizaos/plugin-x402-swarms/client";

const client = createClient({
  walletPrivateKey: process.env.SOLANA_PRIVATE_KEY,
});

const report = await client.research(
  "State of Solana DeFi in 2026",
  "standard"
);
console.log(report.result);
```

**Lines of code:** 7
**Dependencies:** `@elizaos/plugin-x402-swarms` (includes Dexter SDK)
**Cost:** $0.05/call

### SwarmX (curl -- zero dependencies)

```bash
curl -X POST https://api.swarmx.io/x402/research \
  -H "Content-Type: application/json" \
  -d '{"query": "State of Solana DeFi in 2026", "depth": "standard"}'
```

**Lines of code:** 1 command
**Dependencies:** None
**Cost:** Free (first 5 calls/day) or $0.05/call

## Template Mapping

CrewAI requires you to define agents, tasks, and processes from scratch. SwarmX provides pre-built templates that handle the orchestration:

| CrewAI Pattern | SwarmX Endpoint | Price | Agents |
|---------------|-----------------|-------|--------|
| Sequential research crew | `POST /x402/research` | $0.05 | Researcher -> FactChecker -> Writer |
| Multi-perspective analysis crew | `POST /x402/analyze` | $0.03 | Technical + Economic + Risk + Synthesizer |
| Code review crew | `POST /x402/code-review` | $0.03 | SecurityAuditor + PerformanceReviewer + StyleChecker |
| Debate crew | `POST /x402/debate` | $0.03 | Proponent + Opponent + Judge |
| Content writing crew | `POST /x402/write` | $0.03 | Researcher + FactChecker + Writer |
| Contract audit crew | `POST /x402/contract-audit` | $0.10 | SecurityAuditor + EconomicAttacker + GasOptimizer + AuditReporter |
| Token analysis crew | `POST /x402/token-risk` | $0.05 | ContractScanner + TokenomicsAnalyzer + RiskVerdict |
| DAO analysis crew | `POST /x402/dao-analyze` | $0.10 | EconomicAnalyst + TechnicalReviewer + RiskAssessor + VoteSummarizer |
| Single agent task | `POST /x402/agent` | $0.02 | Any single agent with custom system prompt |

## What You Lose

Be aware of these differences:

| Feature | CrewAI | SwarmX |
|---------|--------|--------|
| No-code visual builder | Yes (CrewAI Studio) | No -- API/code only |
| Enterprise SSO/SOC2 | Yes (Enterprise tier) | Not yet |
| Built-in tool integrations | Gmail, Slack, HubSpot, Salesforce, etc. | MCP tools (growing ecosystem) |
| Agent training/fine-tuning | Yes | Not yet |
| Real-time tracing UI | Yes (CrewAI dashboard) | Revenue/health endpoints only |
| Self-hosted enterprise | Yes (Enterprise tier) | Yes (open-source, Docker) |

## What You Gain

| Feature | CrewAI | SwarmX |
|---------|--------|--------|
| Native USDC payments | No | Yes (x402 protocol) |
| Sell your agents | No | Yes -- any x402 endpoint earns USDC |
| Crypto-native endpoints | No | Contract audit, token risk, DAO analysis, wallet analysis |
| Access passes (low-latency) | No | Yes ($1/day, $5/week, $25/month) |
| 15+ swarm architectures | 2 (sequential, hierarchical) | SequentialWorkflow, ConcurrentWorkflow, MixtureOfAgents, MajorityVoting, and more |
| No account required | No | Yes -- wallet is your identity |
| Agent-to-agent commerce | No | Yes -- AI agents can discover and pay for services autonomously |

## Client SDK

Install and use the TypeScript SDK for automatic x402 payment handling:

```bash
npm install @elizaos/plugin-x402-swarms
```

```typescript
import { createClient } from "@elizaos/plugin-x402-swarms/client";

const client = createClient({
  walletPrivateKey: process.env.SOLANA_PRIVATE_KEY,
  // or: evmPrivateKey: process.env.EVM_PRIVATE_KEY,
  baseUrl: "https://api.swarmx.io",  // optional, this is the default
});

// Research (multi-agent pipeline, $0.05)
const report = await client.research("Zero-knowledge rollups comparison", "deep");

// Analysis (multi-perspective panel, $0.03)
const analysis = await client.analyze("Impact of spot Bitcoin ETFs", "comprehensive");

// Single agent ($0.02)
const result = await client.runAgent("Summarize top 5 DeFi protocols by TVL");

// Code review (multi-agent, $0.03)
const review = await client.codeReview("function add(a, b) { return a + b; }", "JavaScript");

// Contract audit (multi-agent, $0.10)
const audit = await client.contractAudit("pragma solidity ^0.8.0; ...", "solidity");

// Token risk (multi-agent, $0.05)
const risk = await client.tokenRisk("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// DAO proposal analysis (multi-agent, $0.10)
const dao = await client.daoAnalyze("Increase staking rewards by 5%", "Jito");

// Free endpoints (no payment needed)
const catalog = await client.getCatalog();
const health = await client.getHealth();
```

The SDK wraps every HTTP call with Dexter's `wrapFetch`, so x402 payments are handled automatically. When a server returns HTTP 402, the SDK signs a USDC payment, retries the request with a payment proof header, and returns the response. You never interact with the payment protocol directly.

## Migration Checklist

- [ ] Get a Solana or EVM wallet with USDC (for paid access beyond free tier)
- [ ] Install `@elizaos/plugin-x402-swarms` or use `curl` directly
- [ ] Replace `crew.kickoff()` calls with HTTP requests or SDK method calls
- [ ] Map your custom agents to the closest SwarmX template (or use `/x402/agent` for custom single-agent tasks)
- [ ] Remove CrewAI subscription and API key configuration
- [ ] Test with the free tier (5 calls/day) before connecting a wallet
