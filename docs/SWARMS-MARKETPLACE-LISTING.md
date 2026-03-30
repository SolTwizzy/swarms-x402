# Swarms Marketplace Listing

## Title

**SwarmX -- Multi-Agent AI Teams with x402 Payments**

---

## Description

SwarmX is the production TypeScript implementation of Kye Gomez's [x402 agent monetization tutorial](https://medium.com/@kyeg/how-to-monetize-your-agents-with-swarms-and-x402-a-simple-step-by-step-tutorial-e56bacc2daf2). It bridges Swarms multi-agent orchestration with x402 micropayments, letting any developer deploy AI agent teams that earn USDC per task -- no subscriptions, no API keys, no accounts.

28 live endpoints. 15+ swarm architectures. $0.001-$0.25 per call. Built on Swarms + Dexter x402 + ElizaOS.

---

## Feature List

### Multi-Agent Orchestration
- **15+ swarm architectures**: SequentialWorkflow, ConcurrentWorkflow, MixtureOfAgents, GraphWorkflow, HeavySwarm, Debate, and more
- **Pre-built templates**: ResearchPipeline (3 agents), AnalysisPanel (3 agents), CodeReview (3 agents), DebateAndDecide (3 agents)
- **Smart routing**: Single-agent tasks call OpenAI directly (~$0.001/call, ~95% margin); multi-agent tasks use Swarms API for orchestration
- **LLM fallback**: If OpenAI key is absent, all tasks gracefully route through Swarms

### Crypto-Native Endpoints
- **Smart Contract Audit**: 4-6 agents (security, economic, gas, copy detection) -- $0.03-$0.25
- **Token Risk Assessment**: 3 agents (rug pull detection, timeline analysis, tokenomics) -- $0.05
- **DAO Proposal Analysis**: 4 agents (economic, technical, risk, recommendation) -- $0.10
- **Wallet Analytics**: SOL balance, token holdings, DeFi positions, transaction history -- $0.01-$0.03

### AI Task Endpoints
- **Research Pipeline**: Researcher + FactChecker + Writer produce verified reports -- $0.05
- **Analysis Panel**: Technical + Economic + Risk experts synthesize assessments -- $0.03
- **Code Review**: Security + Performance + Style agents review code in parallel -- $0.03
- **Debate**: Pro + Con agents argue, Judge delivers verdict -- $0.03
- **Write / Summarize / Translate / Extract / Sentiment** -- $0.01-$0.02

### Trading Data (Solana)
- Token Price (Jupiter), Token Supply, Slot Info, Token Accounts, Recent Blockhash -- $0.001-$0.002
- Sub-second caching designed for HFT bot loops

### Payment Infrastructure
- **x402 native**: HTTP 402 -> sign USDC -> retry. Zero friction.
- **Access passes**: $1/day, $5/week, $25/month for unlimited access (ideal for data endpoints)
- **Free tier**: 10 calls/day per IP with truncated output to drive conversion
- **Sell-side revenue tracking**: Dashboard with per-endpoint revenue stats
- **Dexter SDK**: Auto-indexed on OpenDexter for programmatic discovery

### Developer Experience
- **TypeScript-first**: Strict types, ESM, Bun runtime
- **ElizaOS v2 plugin**: Drop into any ElizaOS agent with `import { x402SwarmsPlugin }`
- **Standalone mode**: No ElizaOS dependency -- deploy as HTTP API via Docker/Railway
- **392 tests passing**: Comprehensive test coverage with Vitest

---

## Pricing Summary

| Category | Endpoints | Price Range (USDC) |
|----------|-----------|-------------------|
| Trading Data | 5 | $0.001-$0.002 |
| AI Tasks (single-agent) | 4 | $0.01-$0.02 |
| AI Tasks (multi-agent) | 5 | $0.03-$0.05 |
| Wallet Analytics | 5 | $0.01-$0.03 |
| Crypto Intelligence | 5 | $0.03-$0.25 |
| Utility (catalog, health) | 2 | Free |
| **Total** | **28** | **$0.001-$0.25** |

**Access Passes** (time-limited unlimited access):
- 24-hour pass: $1.00
- 7-day pass: $5.00
- 30-day pass: $25.00

---

## Links

| Resource | URL |
|----------|-----|
| Live API | https://api.swarmx.io |
| Service Catalog | https://api.swarmx.io/x402/catalog |
| Health / Revenue | https://api.swarmx.io/x402/health |
| GitHub | https://github.com/SolTwizzy/swarms-x402 |
| Reference Tutorial | [Kye Gomez: Monetize Agents with Swarms and x402](https://medium.com/@kyeg/how-to-monetize-your-agents-with-swarms-and-x402-a-simple-step-by-step-tutorial-e56bacc2daf2) |

---

## Badges / Screenshots Section

### Badges (for marketplace listing)

```markdown
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![x402](https://img.shields.io/badge/x402-USDC_Payments-4F46E5?style=flat)
![Solana](https://img.shields.io/badge/Solana-mainnet-9945FF?style=flat&logo=solana&logoColor=white)
![ElizaOS](https://img.shields.io/badge/ElizaOS-v2_Plugin-FF6B35?style=flat)
![Endpoints](https://img.shields.io/badge/Endpoints-28_Live-22C55E?style=flat)
![Tests](https://img.shields.io/badge/Tests-392_passing-22C55E?style=flat)
```

### Rendered Badges

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![x402](https://img.shields.io/badge/x402-USDC_Payments-4F46E5?style=flat)
![Solana](https://img.shields.io/badge/Solana-mainnet-9945FF?style=flat&logo=solana&logoColor=white)
![ElizaOS](https://img.shields.io/badge/ElizaOS-v2_Plugin-FF6B35?style=flat)
![Endpoints](https://img.shields.io/badge/Endpoints-28_Live-22C55E?style=flat)
![Tests](https://img.shields.io/badge/Tests-392_passing-22C55E?style=flat)

### Screenshot Suggestions

1. **Catalog response** -- Screenshot of `GET /x402/catalog` JSON showing all 28 endpoints with pricing
2. **Contract audit output** -- Example response from `/x402/contract-audit` showing multi-agent structured report
3. **Health dashboard** -- Screenshot of `/x402/health` showing revenue stats and endpoint counts
4. **Architecture diagram** -- Mermaid diagram showing Swarms + x402 + Dexter payment flow

---

## Tags / Categories

- `multi-agent`
- `x402`
- `micropayments`
- `smart-contract-audit`
- `token-risk`
- `solana`
- `typescript`
- `elizaos`
- `defi`
- `orchestration`

---

## One-Liner (for directory/search)

> Multi-agent AI teams that earn USDC per task via x402 -- 28 endpoints, 15+ swarm architectures, $0.001-$0.25/call. TypeScript/ElizaOS.
