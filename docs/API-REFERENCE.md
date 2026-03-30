# SwarmX API Reference

Base URLs:
- **Production:** `https://api.swarmx.io`
- **Railway:** `https://swarmx.io`

## Authentication

SwarmX uses the x402 payment protocol for authentication. There are no API keys or accounts.

### Free Tier

The first 5 calls per day per IP address are free. No wallet or payment required.

Free tier responses include:
- `X-SwarmX-Free-Remaining` header with remaining free calls
- `Set-Cookie: swarmx_usage=N` for client-side tracking
- `freeRemaining` field in the response body

Multi-agent endpoint responses are truncated to 300 characters on the free tier. Pay to see the full output.

### Paid Access

For calls beyond the free tier, the server returns HTTP 402 with payment requirements. The Dexter SDK (used by the Client SDK) handles this automatically:

1. Server responds with `402` + `PAYMENT-REQUIRED` header
2. Client signs a USDC payment and retries with `payment-signature` header
3. Server verifies payment, settles on-chain, and returns the response

Supported payment networks: Solana, Base, Ethereum, Polygon, Arbitrum (all USDC).

### 402 Response Format

When payment is required, the server returns:

```json
{
  "error": "Payment required",
  "description": "Multi-agent research pipeline",
  "amount": "0.05",
  "network": "solana-mainnet",
  "payTo": "H1ooMkPx8uXoPS5WYz5JMY7dnYacqGLD3ZfEEku5caAZ"
}
```

---

## Endpoints

### Multi-Agent AI Endpoints

---

#### POST /x402/research

Multi-agent research pipeline. Researcher, FactChecker, and Writer agents produce a verified report.

**Price:** $0.05
**Template:** ResearchPipeline (SequentialWorkflow, 3 agents)

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | `string` | Yes | -- | Topic to research |
| `depth` | `string` | No | `"standard"` | `"quick"`, `"standard"`, or `"deep"` |

```bash
curl -X POST https://api.swarmx.io/x402/research \
  -H "Content-Type: application/json" \
  -d '{"query": "State of Solana DeFi in 2026", "depth": "standard"}'
```

**Response:**

```json
{
  "result": "...",
  "template": "ResearchPipeline",
  "freeRemaining": 4,
  "payment": {
    "amount": "0.05",
    "transaction": "5abc...",
    "network": "solana-mainnet"
  }
}
```

---

#### POST /x402/analyze

Multi-perspective analysis. Technical, Economic, and Risk experts synthesize an assessment.

**Price:** $0.03
**Template:** AnalysisPanel (MixtureOfAgents, 4 agents)

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | `string` | Yes | -- | Text or topic to analyze |
| `type` | `string` | No | `"comprehensive"` | `"comprehensive"`, `"technical"`, `"economic"`, or `"risk"` |

```bash
curl -X POST https://api.swarmx.io/x402/analyze \
  -H "Content-Type: application/json" \
  -d '{"text": "Impact of spot Bitcoin ETFs on altcoin markets", "type": "economic"}'
```

**Response:**

```json
{
  "result": "...",
  "template": "AnalysisPanel",
  "freeRemaining": 3,
  "payment": {
    "amount": "0.03",
    "transaction": "...",
    "network": "..."
  }
}
```

---

#### POST /x402/agent

Single AI agent execution with custom configuration.

**Price:** $0.02
**Backend:** Direct OpenAI (falls back to Swarms if OPENAI_API_KEY not set)

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `task` | `string` | Yes | -- | Task for the agent |
| `model` | `string` | No | `"gpt-4o-mini"` | LLM model name |
| `systemPrompt` | `string` | No | Generic helpful assistant | Custom system prompt |
| `agentName` | `string` | No | `"x402-agent"` | Agent name |

```bash
curl -X POST https://api.swarmx.io/x402/agent \
  -H "Content-Type: application/json" \
  -d '{"task": "List the top 5 DeFi protocols by TVL", "model": "gpt-4o-mini"}'
```

**Response:**

```json
{
  "result": "...",
  "freeRemaining": 2,
  "payment": {
    "amount": "0.02",
    "transaction": "...",
    "network": "..."
  }
}
```

---

#### POST /x402/code-review

Multi-agent code review. SecurityAuditor, PerformanceReviewer, and StyleChecker run in parallel.

**Price:** $0.03
**Template:** CodeReview (ConcurrentWorkflow, 3 agents)

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `code` | `string` | Yes | -- | Code to review |
| `language` | `string` | No | `"auto-detect"` | Language hint |

```bash
curl -X POST https://api.swarmx.io/x402/code-review \
  -H "Content-Type: application/json" \
  -d '{"code": "function add(a, b) { return a + b; }", "language": "JavaScript"}'
```

**Response:**

```json
{
  "security": "...",
  "performance": "...",
  "style": "...",
  "overallScore": "...",
  "rawOutput": "...",
  "reportUrl": "https://api.swarmx.io/report/abc123",
  "badgeUrl": "https://api.swarmx.io/badge/abc123",
  "badgeMarkdown": "[![SwarmX Audit](https://api.swarmx.io/badge/abc123)](https://api.swarmx.io/report/abc123)",
  "template": "CodeReview",
  "payment": { "amount": "0.03", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/write

Multi-agent content writing. Researcher, FactChecker, and Writer produce researched content.

**Price:** $0.03
**Template:** ResearchPipeline (SequentialWorkflow, 3 agents)

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `topic` | `string` | Yes | -- | Topic to write about |
| `style` | `string` | No | `"professional"` | Writing style (e.g., "casual", "academic") |
| `length` | `string` | No | `"medium"` | `"short"`, `"medium"`, or `"long"` |

```bash
curl -X POST https://api.swarmx.io/x402/write \
  -H "Content-Type: application/json" \
  -d '{"topic": "Zero-knowledge proofs explained", "style": "casual", "length": "short"}'
```

**Response:**

```json
{
  "content": "...",
  "wordCount": 450,
  "template": "ResearchPipeline",
  "payment": { "amount": "0.03", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/debate

Multi-agent debate. Proponent, Opponent, and Judge argue a proposition.

**Price:** $0.03
**Template:** DebateAndDecide (MajorityVoting, 3 agents)

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `proposition` | `string` | Yes | -- | Statement or question to debate |

```bash
curl -X POST https://api.swarmx.io/x402/debate \
  -H "Content-Type: application/json" \
  -d '{"proposition": "Should companies adopt a 4-day work week?"}'
```

**Response:**

```json
{
  "proArgument": "...",
  "conArgument": "...",
  "verdict": "...",
  "confidence": "...",
  "rawOutput": "...",
  "template": "DebateAndDecide",
  "payment": { "amount": "0.03", "transaction": "...", "network": "..." }
}
```

---

### Single-Agent Task Endpoints

These endpoints call OpenAI directly for cost efficiency (~$0.001 LLM cost per call).

---

#### POST /x402/summarize

AI text summarization.

**Price:** $0.01

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | `string` | Yes | -- | Text to summarize |
| `maxLength` | `number` | No | `200` | Max summary length in words (10--10,000) |

```bash
curl -X POST https://api.swarmx.io/x402/summarize \
  -H "Content-Type: application/json" \
  -d '{"text": "Long article text here...", "maxLength": 100}'
```

**Response:**

```json
{
  "summary": "...",
  "wordCount": 95,
  "payment": { "amount": "0.01", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/translate

AI translation with auto-detected source language.

**Price:** $0.02

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | `string` | Yes | -- | Text to translate |
| `targetLanguage` | `string` | Yes | -- | Target language (e.g., "Spanish", "Japanese", "French") |

```bash
curl -X POST https://api.swarmx.io/x402/translate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, world!", "targetLanguage": "Spanish"}'
```

**Response:**

```json
{
  "translation": "Hola, mundo!",
  "sourceLanguage": "English",
  "targetLanguage": "Spanish",
  "payment": { "amount": "0.02", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/extract

Structured data extraction from unstructured text.

**Price:** $0.01

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | `string` | Yes | -- | Unstructured text |
| `fields` | `string[]` | Yes | -- | Field names to extract (max 50) |

```bash
curl -X POST https://api.swarmx.io/x402/extract \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Contact John Smith at john@example.com, he works at Acme Corp.",
    "fields": ["name", "email", "company"]
  }'
```

**Response:**

```json
{
  "extracted": {
    "name": "John Smith",
    "email": "john@example.com",
    "company": "Acme Corp."
  },
  "payment": { "amount": "0.01", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/sentiment

Sentiment analysis with confidence score.

**Price:** $0.01

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | `string` | Yes | -- | Text to analyze |

```bash
curl -X POST https://api.swarmx.io/x402/sentiment \
  -H "Content-Type: application/json" \
  -d '{"text": "I absolutely love this product!"}'
```

**Response:**

```json
{
  "sentiment": "positive",
  "confidence": 0.95,
  "reasoning": "Strong positive language with emphasis (absolutely, love).",
  "payment": { "amount": "0.01", "transaction": "...", "network": "..." }
}
```

---

### Crypto-Native Endpoints

Specialized blockchain and DeFi analysis endpoints.

---

#### POST /x402/contract-audit

Multi-agent smart contract pre-audit. SecurityAuditor, EconomicAttacker, GasOptimizer, and AuditReporter agents run concurrently.

**Price:** $0.10
**Architecture:** ConcurrentWorkflow (4 agents)

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `code` | `string` | Yes | -- | Smart contract source code |
| `language` | `string` | No | `"solidity"` | `"solidity"`, `"rust"`, or `"anchor"` |

```bash
curl -X POST https://api.swarmx.io/x402/contract-audit \
  -H "Content-Type: application/json" \
  -d '{"code": "pragma solidity ^0.8.0; contract MyToken { ... }", "language": "solidity"}'
```

**Response:**

```json
{
  "riskScore": 35,
  "verdict": "CAUTION",
  "findings": {
    "security": [...],
    "economic": [...],
    "gas": [...]
  },
  "strengths": ["Uses OpenZeppelin SafeMath", ...],
  "weaknesses": ["No reentrancy guard on withdraw()", ...],
  "redFlags": [],
  "copyLikelihoodScore": 15,
  "complexityScore": 60,
  "summary": "...",
  "reportUrl": "https://api.swarmx.io/report/abc123",
  "badgeUrl": "https://api.swarmx.io/badge/abc123",
  "badgeMarkdown": "[![SwarmX Audit](...)](...)",
  "payment": { "amount": "0.10", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/contract-audit/quick

Single-agent quick security scan. Fast, cheap -- covers major security vulnerabilities only.

**Price:** $0.03
**Architecture:** Single agent (SecurityAuditor)

**Request Body:** Same as `/x402/contract-audit`.

---

#### POST /x402/contract-audit/deep

Comprehensive 6-agent deep audit with additional verification pass. GasOptimizer and CopyDetector cross-checks.

**Price:** $0.25
**Architecture:** ConcurrentWorkflow (6 agents)

**Request Body:** Same as `/x402/contract-audit`.

---

#### POST /x402/token-risk

Multi-agent token risk scoring. Rug pull detection, timeline anomalies, and SAFE/CAUTION/DANGER verdict.

**Price:** $0.05
**Architecture:** SequentialWorkflow (3 agents: ContractScanner, TokenomicsAnalyzer, RiskVerdict)

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mint` | `string` | Yes | -- | Token mint/contract address |
| `chain` | `string` | No | `"solana"` | `"solana"` or `"evm"` |

```bash
curl -X POST https://api.swarmx.io/x402/token-risk \
  -H "Content-Type: application/json" \
  -d '{"mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}'
```

**Response:**

```json
{
  "riskScore": 12,
  "verdict": "SAFE",
  "findings": {
    "contract": [...],
    "tokenomics": [...]
  },
  "copyLikelihoodScore": 0,
  "timelineAnomalies": [],
  "summary": "...",
  "reportUrl": "https://api.swarmx.io/report/def456",
  "badgeUrl": "https://api.swarmx.io/badge/def456",
  "payment": { "amount": "0.05", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/dao-analyze

Multi-agent DAO proposal analysis. EconomicAnalyst, TechnicalReviewer, RiskAssessor, and VoteSummarizer produce a voting recommendation.

**Price:** $0.10
**Architecture:** MixtureOfAgents (4 agents)

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `proposal` | `string` | Yes | -- | DAO proposal text |
| `daoName` | `string` | No | `"Unknown DAO"` | DAO name for context |

```bash
curl -X POST https://api.swarmx.io/x402/dao-analyze \
  -H "Content-Type: application/json" \
  -d '{"proposal": "Increase staking rewards by 5%", "daoName": "Jito"}'
```

**Response:**

```json
{
  "recommendation": "FOR",
  "confidence": 72,
  "analysis": {
    "economic": "...",
    "technical": "...",
    "risk": "..."
  },
  "summary": "...",
  "reportUrl": "https://api.swarmx.io/report/ghi789",
  "payment": { "amount": "0.10", "transaction": "...", "network": "..." }
}
```

---

### Solana Data Endpoints

On-chain data from Helius RPC. Requires HELIUS_API_KEY on the server.

---

#### POST /x402/wallet-analyzer

Analyze any Solana wallet. Returns SOL balance, token holdings with USD values.

**Price:** $0.01

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `address` | `string` | Yes | -- | Solana wallet address (base58) |

```bash
curl -X POST https://api.swarmx.io/x402/wallet-analyzer \
  -H "Content-Type: application/json" \
  -d '{"address": "H1ooMkPx8uXoPS5WYz5JMY7dnYacqGLD3ZfEEku5caAZ"}'
```

**Response:**

```json
{
  "address": "H1oo...",
  "solBalance": 1.234,
  "tokens": [
    { "mint": "EPjF...", "amount": 13320000, "decimals": 6, "uiAmount": 13.32, "symbol": "USDC" }
  ],
  "tokenCount": 3,
  "analyzedAt": "2026-03-27T12:00:00.000Z",
  "payment": { "amount": "0.01", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/wallet-report

Full wallet report bundle -- SOL balance, token holdings, top-token holder concentration, and DeFi positions in one call.

**Price:** $0.03

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `address` | `string` | Yes | -- | Solana wallet address (base58) |

---

#### POST /x402/token-holders

Top holders for any SPL token with amounts, percentages, and concentration analysis.

**Price:** $0.01

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mint` | `string` | Yes | -- | SPL token mint address |
| `limit` | `number` | No | `20` | Number of holders to return (1--20) |

```bash
curl -X POST https://api.swarmx.io/x402/token-holders \
  -H "Content-Type: application/json" \
  -d '{"mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "limit": 10}'
```

**Response:**

```json
{
  "mint": "EPjF...",
  "holders": [
    { "rank": 1, "address": "...", "amount": "1000000", "rawAmount": "1000000000000", "decimals": 6, "concentrationPct": 12.5 }
  ],
  "holderCount": 10,
  "topConcentrationPct": 85.2,
  "queriedAt": "2026-03-27T12:00:00.000Z",
  "payment": { "amount": "0.01", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/tx-history

Recent transaction history for any Solana address.

**Price:** $0.01

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `address` | `string` | Yes | -- | Solana address |
| `limit` | `number` | No | `10` | Number of transactions (1--10) |

```bash
curl -X POST https://api.swarmx.io/x402/tx-history \
  -H "Content-Type: application/json" \
  -d '{"address": "H1ooMkPx8uXoPS5WYz5JMY7dnYacqGLD3ZfEEku5caAZ", "limit": 5}'
```

**Response:**

```json
{
  "address": "H1oo...",
  "transactions": [
    {
      "signature": "...",
      "slot": 123456789,
      "blockTime": 1711540000,
      "timestamp": "2026-03-27T12:00:00.000Z",
      "success": true,
      "type": "token-transfer",
      "solChange": -0.000005,
      "fee": 0.000005,
      "programIds": ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]
    }
  ],
  "transactionCount": 5,
  "queriedAt": "2026-03-27T12:00:00.000Z",
  "payment": { "amount": "0.01", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/defi-positions

Scan a Solana wallet for DeFi positions -- Marinade (mSOL), Jito (jitoSOL), Raydium LP tokens, and more.

**Price:** $0.02

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `address` | `string` | Yes | -- | Solana wallet address (base58) |

---

### Trading Data Endpoints

Low-latency data endpoints designed for high-frequency trading bots. Short cache TTLs and minimal pricing.

---

#### POST /x402/token-price

Real-time token price in USD via Jupiter aggregator.

**Price:** $0.001
**Cache TTL:** 5 seconds

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mint` | `string` | Yes | -- | SPL token mint address |

```bash
curl -X POST https://api.swarmx.io/x402/token-price \
  -H "Content-Type: application/json" \
  -d '{"mint": "So11111111111111111111111111111111111111112"}'
```

**Response:**

```json
{
  "mint": "So11...",
  "priceUsd": 178.52,
  "confidence": "high",
  "source": "jupiter",
  "timestamp": 1711540000000,
  "queriedAt": "2026-03-27T12:00:00.000Z",
  "cached": false,
  "payment": { "amount": "0.001", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/token-supply

Total supply and decimals for any SPL token mint.

**Price:** $0.001
**Cache TTL:** 30 seconds

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mint` | `string` | Yes | -- | SPL token mint address |

**Response:**

```json
{
  "mint": "EPjF...",
  "supply": "10000000000",
  "rawSupply": "10000000000000000",
  "decimals": 6,
  "timestamp": 1711540000000,
  "queriedAt": "...",
  "cached": false,
  "payment": { "amount": "0.001", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/slot-info

Current Solana slot and block time. Network health monitoring.

**Price:** $0.001
**Cache TTL:** 2 seconds

**Request Body:** None required (empty object `{}` is fine).

**Response:**

```json
{
  "slot": 310000000,
  "blockTime": 1711540000,
  "blockTimeIso": "2026-03-27T12:00:00.000Z",
  "epoch": 620,
  "slotIndex": 200000,
  "slotsInEpoch": 432000,
  "timestamp": 1711540000000,
  "queriedAt": "...",
  "cached": false,
  "payment": { "amount": "0.001", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/token-accounts

List all SPL token accounts for a wallet. Portfolio monitoring with optional mint filter.

**Price:** $0.002
**Cache TTL:** 10 seconds

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `address` | `string` | Yes | -- | Solana wallet address |
| `mint` | `string` | No | -- | Filter by specific token mint |

**Response:**

```json
{
  "address": "H1oo...",
  "mintFilter": null,
  "accounts": [
    { "mint": "EPjF...", "amount": "13.32", "rawAmount": "13320000", "decimals": 6 }
  ],
  "accountCount": 5,
  "timestamp": 1711540000000,
  "queriedAt": "...",
  "cached": false,
  "payment": { "amount": "0.002", "transaction": "...", "network": "..." }
}
```

---

#### POST /x402/recent-blockhash

Latest blockhash for transaction building.

**Price:** $0.001
**Cache TTL:** 5 seconds

**Request Body:** None required.

**Response:**

```json
{
  "blockhash": "...",
  "lastValidBlockHeight": 310000200,
  "timestamp": 1711540000000,
  "queriedAt": "...",
  "cached": false,
  "payment": { "amount": "0.001", "transaction": "...", "network": "..." }
}
```

---

### Free Endpoints

These endpoints require no payment.

---

#### GET /x402/catalog

List all available endpoints with pricing.

```bash
curl https://api.swarmx.io/x402/catalog
```

**Response:** Array of `CatalogEntry` objects:

```json
[
  {
    "name": "SwarmX Research Pipeline",
    "description": "Multi-agent research: Researcher, FactChecker, and Writer produce a verified report on any topic",
    "path": "/x402/research",
    "method": "POST",
    "priceUsd": "0.05"
  },
  ...
]
```

---

#### GET /x402/health

Platform health check with revenue stats.

```bash
curl https://api.swarmx.io/x402/health
```

**Response:**

```json
{
  "status": "ok",
  "receiveAddress": "H1ooMkPx8uXoPS5WYz5JMY7dnYacqGLD3ZfEEku5caAZ",
  "network": "solana-mainnet",
  "totalRevenue": 1.25,
  "settlements": 42,
  "freeTierCallsToday": 150,
  "freeTierUniqueIPs": 30
}
```

---

#### GET /x402/trading/health

Trading data endpoints health check.

```bash
curl https://api.swarmx.io/x402/trading/health
```

**Response:**

```json
{
  "status": "ok",
  "heliusConfigured": true,
  "receiveAddress": "...",
  "network": "...",
  "endpoints": [
    { "path": "/x402/token-price", "price": "$0.001/call", "method": "POST" },
    ...
  ],
  "cacheTtls": {
    "token-price": "5s",
    "token-supply": "30s",
    "slot-info": "2s",
    "token-accounts": "10s",
    "recent-blockhash": "5s"
  },
  "designedFor": "High-frequency trading bots — low price, short cache TTLs, fast responses"
}
```

---

## Complete Endpoint Summary

| Endpoint | Method | Price | Category | Agents |
|----------|--------|-------|----------|--------|
| `/x402/research` | POST | $0.05 | Multi-agent AI | 3 (SequentialWorkflow) |
| `/x402/analyze` | POST | $0.03 | Multi-agent AI | 4 (MixtureOfAgents) |
| `/x402/agent` | POST | $0.02 | Single-agent AI | 1 (Direct OpenAI) |
| `/x402/code-review` | POST | $0.03 | Multi-agent AI | 3 (ConcurrentWorkflow) |
| `/x402/write` | POST | $0.03 | Multi-agent AI | 3 (SequentialWorkflow) |
| `/x402/debate` | POST | $0.03 | Multi-agent AI | 3 (MajorityVoting) |
| `/x402/summarize` | POST | $0.01 | Single-agent AI | 1 (Direct OpenAI) |
| `/x402/translate` | POST | $0.02 | Single-agent AI | 1 (Direct OpenAI) |
| `/x402/extract` | POST | $0.01 | Single-agent AI | 1 (Direct OpenAI) |
| `/x402/sentiment` | POST | $0.01 | Single-agent AI | 1 (Direct OpenAI) |
| `/x402/contract-audit` | POST | $0.10 | Crypto | 4 (ConcurrentWorkflow) |
| `/x402/contract-audit/quick` | POST | $0.03 | Crypto | 1 (SecurityAuditor) |
| `/x402/contract-audit/deep` | POST | $0.25 | Crypto | 6 (ConcurrentWorkflow) |
| `/x402/token-risk` | POST | $0.05 | Crypto | 3 (SequentialWorkflow) |
| `/x402/dao-analyze` | POST | $0.10 | Crypto | 4 (MixtureOfAgents) |
| `/x402/wallet-analyzer` | POST | $0.01 | Solana Data | -- |
| `/x402/wallet-report` | POST | $0.03 | Solana Data | -- |
| `/x402/token-holders` | POST | $0.01 | Solana Data | -- |
| `/x402/tx-history` | POST | $0.01 | Solana Data | -- |
| `/x402/defi-positions` | POST | $0.02 | Solana Data | -- |
| `/x402/token-price` | POST | $0.001 | Trading Data | -- |
| `/x402/token-supply` | POST | $0.001 | Trading Data | -- |
| `/x402/slot-info` | POST | $0.001 | Trading Data | -- |
| `/x402/token-accounts` | POST | $0.002 | Trading Data | -- |
| `/x402/recent-blockhash` | POST | $0.001 | Trading Data | -- |
| `/x402/catalog` | GET | FREE | Meta | -- |
| `/x402/health` | GET | FREE | Meta | -- |
| `/x402/trading/health` | GET | FREE | Meta | -- |

## Error Responses

All endpoints return errors in a consistent format:

```json
{
  "error": "Human-readable error message"
}
```

| Status | Meaning | When |
|--------|---------|------|
| 400 | Bad Request | Missing or invalid fields in request body |
| 402 | Payment Required | Free tier exhausted, no payment header |
| 404 | Not Found | Token/address not found (trading endpoints) |
| 500 | Internal Server Error | LLM execution failed, upstream error |
| 503 | Service Unavailable | Required backend not configured (Swarms, Helius, OpenAI) |

## Rate Limits

- **Free tier:** 5 calls/day per IP (all endpoints share the same counter)
- **Paid:** No rate limit from SwarmX. Upstream rate limits may apply (Helius, Swarms API)
- **Trading endpoints:** Aggressive caching (2--30s TTL) to minimize upstream calls. If Helius returns 429, subsequent requests short-circuit with 503 for 1 second.
