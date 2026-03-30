# SwarmX Client SDK

TypeScript SDK for the SwarmX platform. Handles x402 micropayments automatically -- no protocol knowledge required.

## Installation

```bash
npm install @elizaos/plugin-x402-swarms
```

## Quick Start

```typescript
import { createClient } from "@elizaos/plugin-x402-swarms/client";

const client = createClient({
  walletPrivateKey: process.env.SOLANA_PRIVATE_KEY,
});

// One-liner research
const report = await client.research("Zero-knowledge rollups comparison");
console.log(report.result);
```

## Configuration

```typescript
import { createClient, X402SwarmsClient } from "@elizaos/plugin-x402-swarms/client";

// Using the factory function (recommended)
const client = createClient({
  walletPrivateKey: process.env.SOLANA_PRIVATE_KEY,
});

// Or using the class directly
const client = new X402SwarmsClient({
  walletPrivateKey: process.env.SOLANA_PRIVATE_KEY,
});
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `walletPrivateKey` | `string` | -- | Solana private key (base58) for USDC payments |
| `evmPrivateKey` | `string` | -- | EVM private key (hex) for Base/Polygon/Arbitrum payments |
| `baseUrl` | `string` | `https://swarmx.io` | Platform base URL |
| `maxAmountAtomic` | `string` | `"100000"` ($0.10) | Max payment per request in USDC atomic units (6 decimals) |
| `preferredNetwork` | `string` | -- | Preferred network in CAIP-2 format (e.g., `"eip155:8453"` for Base) |

You must provide either `walletPrivateKey` (Solana) or `evmPrivateKey` (EVM) for paid endpoints. For free-tier-only usage (5 calls/day), neither is required.

### Raising the Per-Request Limit

The default `maxAmountAtomic` is `"100000"` ($0.10). Some endpoints cost more (e.g., contract audit deep at $0.25). To use those endpoints, increase the limit:

```typescript
const client = createClient({
  walletPrivateKey: process.env.SOLANA_PRIVATE_KEY,
  maxAmountAtomic: "500000", // $0.50 max per request
});
```

## How Payments Work

Every method call is an HTTP request. When the server returns HTTP 402 (Payment Required), the Dexter SDK automatically:

1. Reads the payment requirements from the response headers
2. Signs a USDC transfer from your wallet
3. Retries the request with a `payment-signature` header
4. Returns the response to your code

You never interact with the payment protocol directly. Gas fees are sponsored by the Dexter facilitator -- your wallet only needs USDC.

### Free Tier

The first 5 calls per day (per IP) are free. No wallet required. The server sets a `X-SwarmX-Free-Remaining` header and a `swarmx_usage` cookie to track usage.

---

## Methods

### Multi-Agent Endpoints

These endpoints use the Swarms API to orchestrate multiple AI agents.

#### `research(query, depth?)`

Multi-agent research pipeline. Spawns Researcher, FactChecker, and Writer agents to produce a verified report.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | -- | The topic to research |
| `depth` | `"quick" \| "standard" \| "deep"` | No | `"standard"` | Research depth |

**Price:** $0.05
**Template:** ResearchPipeline (SequentialWorkflow)

```typescript
const report = await client.research("Solana validator economics in 2026");
console.log(report.result);
console.log(report.template);  // "ResearchPipeline"
console.log(report.payment);   // { amount: "0.05", transaction: "...", network: "..." }
```

**Response type: `ResearchResponse`**

```typescript
interface ResearchResponse {
  result: string;
  template: string;
  payment: PaymentInfo;
}
```

---

#### `analyze(text, type?)`

Multi-perspective analysis panel. Technical, Economic, and Risk experts synthesize an assessment.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | `string` | Yes | -- | The text or topic to analyze |
| `type` | `"comprehensive" \| "technical" \| "economic" \| "risk"` | No | `"comprehensive"` | Analysis focus |

**Price:** $0.03
**Template:** AnalysisPanel (MixtureOfAgents)

```typescript
const analysis = await client.analyze("Impact of spot Bitcoin ETFs on altcoin markets");
console.log(analysis.result);
```

**Response type: `AnalyzeResponse`**

```typescript
interface AnalyzeResponse {
  result: string;
  template: string;
  payment: PaymentInfo;
}
```

---

#### `codeReview(code, language?)`

Multi-agent code review. Runs SecurityAuditor, PerformanceReviewer, and StyleChecker in parallel.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `code` | `string` | Yes | -- | The code to review |
| `language` | `string` | No | `"auto-detect"` | Language hint (e.g., "TypeScript", "Solidity") |

**Price:** $0.03
**Template:** CodeReview (ConcurrentWorkflow)

```typescript
const review = await client.codeReview(
  "function add(a, b) { return a + b; }",
  "JavaScript"
);
console.log(review.rawOutput);
```

**Response type: `CodeReviewResponse`**

```typescript
interface CodeReviewResponse {
  security: string;
  performance: string;
  style: string;
  overallScore: string;
  rawOutput: string;
  template: string;
  payment: PaymentInfo;
}
```

---

#### `write(topic, options?)`

Multi-agent content writing. Runs a ResearchPipeline (Researcher + FactChecker + Writer).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `topic` | `string` | Yes | -- | The topic to write about |
| `options.style` | `string` | No | `"professional"` | Writing style (e.g., "casual", "academic") |
| `options.length` | `string` | No | `"medium"` | Content length: "short", "medium", or "long" |

**Price:** $0.03
**Template:** ResearchPipeline (SequentialWorkflow)

```typescript
const article = await client.write("Zero-knowledge proofs explained", {
  style: "casual",
  length: "short",
});
console.log(article.content);
console.log(article.wordCount);
```

**Response type: `WriteResponse`**

```typescript
interface WriteResponse {
  content: string;
  wordCount: number;
  template: string;
  payment: PaymentInfo;
}
```

---

#### `debate(proposition)`

Multi-agent debate. Proponent, Opponent, and Judge agents argue a proposition and deliver a verdict.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `proposition` | `string` | Yes | -- | The statement or question to debate |

**Price:** $0.03
**Template:** DebateAndDecide (MajorityVoting)

```typescript
const result = await client.debate("Should companies adopt a 4-day work week?");
console.log(result.verdict);
console.log(result.confidence);
```

**Response type: `DebateResponse`**

```typescript
interface DebateResponse {
  proArgument: string;
  conArgument: string;
  verdict: string;
  confidence: string;
  rawOutput: string;
  template: string;
  payment: PaymentInfo;
}
```

---

### Single-Agent Endpoints

These endpoints call OpenAI directly for cost efficiency. If `OPENAI_API_KEY` is not configured on the server, they fall back to the Swarms API.

#### `runAgent(task, options?)`

Run a single AI agent with a custom task.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `task` | `string` | Yes | -- | The task for the agent |
| `options.model` | `string` | No | `"gpt-4o-mini"` | LLM model name |
| `options.systemPrompt` | `string` | No | Generic helpful assistant | Custom system prompt |
| `options.agentName` | `string` | No | `"x402-agent"` | Custom agent name |

**Price:** $0.02

```typescript
const result = await client.runAgent("Summarize the top 5 DeFi protocols by TVL");
console.log(result.result);
```

**Response type: `AgentResponse`**

```typescript
interface AgentResponse {
  result: string;
  payment: PaymentInfo;
}
```

---

#### `summarize(text, maxLength?)`

AI text summarization.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | `string` | Yes | -- | The text to summarize |
| `maxLength` | `number` | No | `200` | Maximum summary length in words (10--10,000) |

**Price:** $0.01

```typescript
const result = await client.summarize("Long article text here...", 100);
console.log(result.summary);
console.log(result.wordCount);
```

**Response type: `SummarizeResponse`**

```typescript
interface SummarizeResponse {
  summary: string;
  wordCount: number;
  payment: PaymentInfo;
}
```

---

#### `translate(text, targetLanguage)`

AI text translation with auto-detected source language.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | `string` | Yes | -- | The text to translate |
| `targetLanguage` | `string` | Yes | -- | Target language (e.g., "Spanish", "Japanese") |

**Price:** $0.02

```typescript
const result = await client.translate("Hello, world!", "Spanish");
console.log(result.translation);       // "Hola, mundo!"
console.log(result.sourceLanguage);     // "English"
console.log(result.targetLanguage);     // "Spanish"
```

**Response type: `TranslateResponse`**

```typescript
interface TranslateResponse {
  translation: string;
  sourceLanguage: string;
  targetLanguage: string;
  payment: PaymentInfo;
}
```

---

#### `extract(text, fields)`

Structured data extraction from unstructured text.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | `string` | Yes | -- | The unstructured text |
| `fields` | `string[]` | Yes | -- | Field names to extract (max 50) |

**Price:** $0.01

```typescript
const result = await client.extract(
  "Contact John Smith at john@example.com, he works at Acme Corp.",
  ["name", "email", "company"]
);
console.log(result.extracted);
// { name: "John Smith", email: "john@example.com", company: "Acme Corp." }
```

**Response type: `ExtractResponse`**

```typescript
interface ExtractResponse {
  extracted: Record<string, string>;
  payment: PaymentInfo;
}
```

---

#### `sentiment(text)`

Sentiment analysis with confidence score and reasoning.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | `string` | Yes | -- | The text to analyze |

**Price:** $0.01

```typescript
const result = await client.sentiment("I absolutely love this product!");
console.log(result.sentiment);    // "positive"
console.log(result.confidence);   // 0.95
console.log(result.reasoning);    // "Strong positive language..."
```

**Response type: `SentimentResponse`**

```typescript
interface SentimentResponse {
  sentiment: "positive" | "negative" | "neutral";
  confidence: number;
  reasoning: string;
  payment: PaymentInfo;
}
```

---

### Crypto-Native Endpoints

Specialized endpoints for blockchain and DeFi analysis, using multi-agent orchestration.

#### `contractAudit(code, language?)`

Multi-agent smart contract pre-audit. Runs SecurityAuditor, EconomicAttacker, GasOptimizer, and AuditReporter concurrently.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `code` | `string` | Yes | -- | Smart contract source code |
| `language` | `string` | No | `"solidity"` | Contract language: "solidity", "rust", or "anchor" |

**Price:** $0.10 (standard), $0.03 (quick), $0.25 (deep)

Note: The SDK method calls the standard $0.10 audit. For quick ($0.03) or deep ($0.25) audits, use the HTTP endpoints directly: `POST /x402/contract-audit/quick` or `POST /x402/contract-audit/deep`.

```typescript
const audit = await client.contractAudit(
  "pragma solidity ^0.8.0; contract MyToken { ... }",
  "solidity"
);
console.log(`Risk score: ${audit.riskScore}/100`);
console.log(audit.findings.security);
console.log(audit.summary);
```

**Response type: `ContractAuditResponse`**

```typescript
interface ContractAuditResponse {
  riskScore: number | null;
  findings: { security: string[]; economic: string[]; gas: string[] };
  summary: string;
  payment?: PaymentInfo;
}
```

---

#### `tokenRisk(mint, chain?)`

Multi-agent token risk assessment. Runs ContractScanner, TokenomicsAnalyzer, and RiskVerdict agents sequentially.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `mint` | `string` | Yes | -- | Token mint/contract address |
| `chain` | `string` | No | `"solana"` | Blockchain: "solana" or "evm" |

**Price:** $0.05

```typescript
const risk = await client.tokenRisk("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
console.log(`Verdict: ${risk.verdict}`);  // "SAFE", "CAUTION", or "DANGER"
console.log(`Risk score: ${risk.riskScore}`);
```

**Response type: `TokenRiskResponse`**

```typescript
interface TokenRiskResponse {
  riskScore: number | null;
  verdict: string | null;
  findings: { contract: string[]; tokenomics: string[] };
  summary: string;
  payment?: PaymentInfo;
}
```

---

#### `daoAnalyze(proposal, daoName?)`

Multi-agent DAO proposal analysis. Runs EconomicAnalyst, TechnicalReviewer, RiskAssessor, and VoteSummarizer via MixtureOfAgents.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `proposal` | `string` | Yes | -- | DAO proposal text |
| `daoName` | `string` | No | `"Unknown DAO"` | DAO name for context |

**Price:** $0.10

```typescript
const dao = await client.daoAnalyze("Increase staking rewards by 5%", "Jito");
console.log(`Recommendation: ${dao.recommendation}`);  // "FOR", "AGAINST", or "ABSTAIN"
console.log(`Confidence: ${dao.confidence}%`);
console.log(dao.analysis.economic);
console.log(dao.analysis.technical);
console.log(dao.analysis.risk);
```

**Response type: `DaoAnalyzeResponse`**

```typescript
interface DaoAnalyzeResponse {
  recommendation: string | null;
  confidence: number | null;
  analysis: { economic: string; technical: string; risk: string };
  summary: string;
  payment?: PaymentInfo;
}
```

---

#### `analyzeWallet(address)`

Solana wallet analyzer. Returns SOL balance, token holdings, and activity.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `address` | `string` | Yes | -- | Solana wallet address (base58, 32-44 chars) |

**Price:** $0.01

```typescript
const wallet = await client.analyzeWallet("So11111111111111111111111111111112");
console.log(`SOL balance: ${wallet.solBalance}`);
console.log(`Tokens held: ${wallet.tokenCount}`);
wallet.tokens.forEach(t => console.log(`  ${t.symbol}: ${t.uiAmount}`));
```

**Response type: `WalletAnalysisResponse`**

```typescript
interface WalletAnalysisResponse {
  address: string;
  solBalance: number;
  tokens: TokenHolding[];
  tokenCount: number;
  analyzedAt: string;
  payment: PaymentInfo;
}

interface TokenHolding {
  mint: string;
  amount: number;
  decimals: number;
  uiAmount: number;
  symbol: string;
}
```

---

### Free Endpoints

These endpoints require no payment and no wallet.

#### `getCatalog()`

List all available endpoints with pricing.

```typescript
const services = await client.getCatalog();
services.forEach(s => console.log(`${s.name}: $${s.priceUsd} — ${s.path}`));
```

**Response type: `CatalogEntry[]`**

```typescript
interface CatalogEntry {
  name: string;
  description: string;
  path: string;
  method: "GET" | "POST";
  priceUsd: string;
  free?: boolean;
}
```

---

#### `getHealth()`

Platform health check with revenue stats.

```typescript
const health = await client.getHealth();
console.log(`Status: ${health.status}`);
console.log(`Revenue: $${health.totalRevenue}`);
console.log(`Settlements: ${health.settlements}`);
```

**Response type: `HealthResponse`**

```typescript
interface HealthResponse {
  status: string;
  receiveAddress: string;
  network: string;
  totalRevenue: number;
  settlements: number;
}
```

---

#### `getWalletAnalyzerHealth()`

Wallet analyzer health check.

```typescript
const health = await client.getWalletAnalyzerHealth();
console.log(`Helius configured: ${health.heliusConfigured}`);
```

**Response type: `WalletAnalyzerHealthResponse`**

```typescript
interface WalletAnalyzerHealthResponse {
  status: string;
  heliusConfigured: boolean;
  receiveAddress: string;
  network: string;
  price: string;
}
```

---

## Error Handling

All methods throw `X402SwarmsError` on failure:

```typescript
import { X402SwarmsError } from "@elizaos/plugin-x402-swarms/client";

try {
  const result = await client.research("topic");
} catch (err) {
  if (err instanceof X402SwarmsError) {
    console.error(`Status: ${err.status}`);   // HTTP status code
    console.error(`Message: ${err.message}`); // Error description
    console.error(`Body: ${err.body}`);       // Raw response body
  }
}
```

### Common Error Codes

| Status | Meaning | Cause |
|--------|---------|-------|
| 400 | Bad Request | Missing or invalid request body fields |
| 402 | Payment Required | Free tier exhausted, wallet not configured or insufficient USDC |
| 500 | Internal Server Error | LLM or service temporarily unavailable |
| 503 | Service Unavailable | Required backend (Swarms, Helius, OpenAI) not configured |

## PaymentInfo

Every paid response includes a `payment` object:

```typescript
interface PaymentInfo {
  amount: string;      // Price in USD (e.g., "0.05")
  transaction: string; // On-chain transaction hash
  network: string;     // Network identifier (e.g., "solana-mainnet")
}
```

Free tier responses include `payment` with empty `transaction` and `network` values, plus `freeRemaining` indicating how many free calls remain for the day.
