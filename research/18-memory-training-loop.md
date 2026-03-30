# Research 18: Memory, Training Loop & Self-Improving SwarmX

**Date:** 2026-03-29
**Focus:** ElizaOS memory system, knowledge bases, learning loops, and how SwarmX can feed training data back into agents to create a self-improving system.

---

## 1. ElizaOS v2 Memory Architecture

### 1.1 Core Memory Interface

ElizaOS provides a unified memory API through `IAgentRuntime` with three foundational operations:

- **`createMemory(memory, tableName, unique?)`** — Store any piece of information with optional deduplication
- **`getMemories({ roomId, entityId, count, start, end })`** — Retrieve by recency, entity, room, or time window
- **`searchMemories({ embedding, query, match_threshold, count, roomId })`** — Semantic vector search via cosine similarity

Every memory has: `id`, `entityId`, `agentId`, `roomId`, `content` (text + metadata), `embedding` (number[]), `createdAt`, and optional `similarity` score.

### 1.2 Memory Types

ElizaOS implements three cognitive memory types mirroring human cognition:

| Type | Description | Storage | Retrieval |
|------|-------------|---------|-----------|
| **Short-term / Working** | Current conversation buffer (default 32 messages) | In-memory ring buffer | Recency-based |
| **Long-term** | Important facts consolidated from interactions | PostgreSQL + pgvector | Semantic search + importance decay |
| **Knowledge** | Static (character config) + dynamic (learned facts) | `knowledge` table with embeddings | Topic-based search (threshold 0.7) |

### 1.3 Embedding Pipeline

- Automatic embedding generation on `createMemory()` via configurable embedding models
- Supports OpenAI (1536-dim), Ollama (1024-dim), GaiaNet, and custom models
- Batch embedding via `embedBatch()` for bulk operations
- In-memory LRU cache prevents redundant embedding API calls
- `VectorIndex` class with Annoy (Approximate Nearest Neighbor) for fast search

### 1.4 PostgreSQL Adapter (adapter-postgres)

The official PostgreSQL adapter provides the persistence layer:

- **memories table**: messages with pgvector embeddings, indexed for cosine similarity
- **knowledge table**: agent knowledge base with vector + Levenshtein text search
- **accounts, rooms, cache**: supporting infrastructure
- `searchMemoriesByEmbedding()` — cosine similarity with configurable thresholds
- `searchKnowledge()` — hybrid vector + text search
- Auto-schema initialization on first connection

### 1.5 How Plugins Write to Memory

Any plugin can write to memory through the runtime:

```typescript
// Dynamic knowledge learning
async function learnFact(runtime: IAgentRuntime, fact: string) {
  await runtime.createMemory({
    content: { text: fact, metadata: { type: 'knowledge', learned: true, confidence: 0.9 } },
    roomId: 'knowledge-base',
    entityId: runtime.agentId
  }, 'knowledge');
}

// Retrieval by topic
const results = await runtime.searchMemories({
  query: topic,
  filter: { 'metadata.type': 'knowledge' },
  match_threshold: 0.7
});
```

Evaluators can extract facts from conversations and write them to the memory system, creating a learning loop. The `paymentEvaluator` in SwarmX already does this pattern for quality scoring.

### 1.6 Advanced: Multi-Agent Shared Memory

ElizaOS supports shared memory spaces between agents with permission-based access (read/write/delete per agent). This enables:

- Collaborative knowledge building across agent swarms
- Memory synchronization between agents
- Memory graph structures (causes, effects, related, references)

**Sources:**
- [ElizaOS Memory and State Documentation](https://docs.elizaos.ai/agents/memory-and-state)
- [ElizaOS Runtime Memory API](https://docs.elizaos.ai/runtime/memory)
- [adapter-postgres](https://github.com/elizaos-plugins/adapter-postgres)
- [ElizaOS Knowledge Repository](https://github.com/elizaOS/knowledge)

---

## 2. Industry State: Agent Memory Systems (2026)

### 2.1 Major Players Compared

| System | Architecture | Best For | Pricing | TypeScript? |
|--------|-------------|----------|---------|-------------|
| **Mem0** | Vector + Knowledge Graph (Pro) | Managed SaaS, enterprise | Free-$249/mo | Yes (SDK) |
| **Zep** | Temporal Knowledge Graph (Graphiti) | Entity relationships over time | Credit-based ($25/mo) | Yes (SDK) |
| **LangMem** | Pluggable backends (LangGraph) | LangGraph-native teams | Free (self-hosted) | Python only |
| **MemoClaw** | Vector + importance scoring | Crypto-native, simple API | $0.001/op | HTTP API |
| **pgvector** | PostgreSQL extension | Already-using-Postgres teams | Free (self-hosted) | Yes (Drizzle/Prisma) |

### 2.2 Key Insight for SwarmX

**pgvector is the pragmatic choice** because:
1. We already use Drizzle ORM + PostgreSQL for payment persistence
2. Zero new infrastructure — add pgvector extension to existing Railway Postgres
3. Drizzle has native pgvector support (cosine distance operator `<=>`)
4. ElizaOS adapter-postgres already uses pgvector — our plugin mode gets it free
5. Cost: $0 incremental (vs $70-300/mo for Pinecone)

For standalone mode (no ElizaOS), we supplement with JSONL append-only logs (already proven in `reportStore.ts`) that can be batch-embedded later.

**Sources:**
- [Mem0 vs Zep vs LangMem vs MemoClaw Comparison 2026](https://dev.to/anajuliabit/mem0-vs-zep-vs-langmem-vs-memoclaw-ai-agent-memory-comparison-2026-1l1k)
- [Vector Database Comparison 2026](https://4xxi.com/articles/vector-database-comparison/)
- [Drizzle ORM pgvector guide](https://orm.drizzle.team/docs/guides/vector-similarity-search)

---

## 3. Self-Improving Agent Architectures

### 3.1 The Five Axes of Self-Improvement

Research from the ICLR 2026 Workshop on AI with Recursive Self-Improvement identifies five axes:

1. **Change targets**: parameters, memory/context, tools/workflows, or agent architecture
2. **Adaptation timing**: within-task vs between-task vs between-deployment
3. **Adaptation mechanisms**: reward-based, critique-based, imitation, evolutionary
4. **Operating contexts**: web, robotics, enterprise, scientific discovery
5. **Evidence/assurance**: benchmarks, human eval, automated testing

SwarmX operates primarily on axes 2 (between-task) and 1 (memory/context), making RAG-based improvement the natural fit.

### 3.2 OpenAI Self-Evolving Agents Cookbook

The OpenAI Cookbook describes three optimization strategies with increasing automation:

1. **Manual prompt optimization** — Human reviews outputs, adjusts prompts (our current state)
2. **Static metaprompt optimization** — Automated loop with 4 graders, iterative improvement
3. **GEPA optimization** — Samples agent trajectories, reflects in natural language, proposes prompt revisions, evolves iteratively

Key pattern: **Trajectory Storage** — successful task completions are stored as few-shot examples for future similar tasks (73% to 89% performance gain reported).

### 3.3 Practical Implementation Phases

From Yohei Nakajima's research on self-improving agents:

| Phase | What Changes | SwarmX Equivalent |
|-------|-------------|-------------------|
| **1. Reflection loops** | Add critique-and-retry to existing agents | Already have: paymentEvaluator scores quality |
| **2. Exemplar generation** | Store successful outputs as few-shot examples | **Proposed**: Store high-scoring audit results |
| **3. Self-training** | Generate outputs → filter for correctness → fine-tune | Future: JSONL export for fine-tuning |
| **4. Persistent skills** | Executable artifact library | Future: Reusable analysis templates |
| **5. Safety gating** | Tests + constraints on self-modifications | Validation before promoting to production prompts |

### 3.4 The ACE Pattern (Agentic Context Engineering)

A three-agent self-improving loop producing +10.6% on benchmarks without model fine-tuning:

1. **Generator** — Produces the response (our swarm agents)
2. **Reflector** — Evaluates, detects errors, adds context (our paymentEvaluator)
3. **Curator** — Extracts learnings into reusable "context playbook" (**not yet built**)

This is the missing piece in SwarmX — the Curator that distills paid outputs into reusable knowledge.

**Sources:**
- [OpenAI Self-Evolving Agents Cookbook](https://cookbook.openai.com/examples/partners/self_evolving_agents/autonomous_agent_retraining)
- [Better Ways to Build Self-Improving AI Agents (Yohei Nakajima)](https://yoheinakajima.com/better-ways-to-build-self-improving-ai-agents/)
- [ICLR 2026 Workshop on AI with Recursive Self-Improvement](https://openreview.net/pdf?id=OsPQ6zTQXV)
- [7 Tips for Self-Improving AI Agents (Datagrid)](https://datagrid.com/blog/7-tips-build-self-improving-ai-agents-feedback-loops)
- [AI Agent Memory Types & Best Practices 2026](https://47billion.com/blog/ai-agent-memory-types-implementation-best-practices/)

---

## 4. The Data Moat Thesis

### 4.1 Why This Matters

AI models are commodities in 2026. Foundation models are interchangeable. The one thing competitors cannot buy, borrow, or replicate is **proprietary data generated through usage**.

Modern data moats work as learning flywheels:
- Interaction improves performance
- Performance attracts more usage
- Usage deepens learning
- The cycle compounds exponentially

### 4.2 SwarmX's Unique Position

Every paid SwarmX call generates structured, domain-specific data that no one else has:

| Endpoint | Data Generated | Moat Value |
|----------|---------------|------------|
| `/swarm/token-diligence` | Structured audit: contract score, tokenomics score, team credibility, market analysis, final verdict | Historical token assessments with outcomes |
| `/swarm/defi-risk-score` | AAA-to-D credit ratings with detailed breakdowns | DeFi protocol risk database |
| `/swarm/fact-check` | Claim extraction, evidence, adversarial review, judge verdict | Verified/disputed claim corpus |
| `/crypto/memecoin-score` | Risk scores with pattern detection | Memecoin pattern database |
| `/crypto/token-risk` | Risk assessments with on-chain data | Token risk intelligence |
| `/audit/contract` | Security findings with severity levels | Smart contract vulnerability database |

This data is:
- **Structured** (JSON with scores, findings, verdicts)
- **Time-stamped** (market conditions at analysis time)
- **Paid-for** (only real users pay $0.25-$2.00 per call, filtering noise)
- **Multi-perspective** (3-6 agent viewpoints per analysis)
- **Domain-specific** (crypto/DeFi focus)

### 4.3 The Compound Effect

After 1,000 paid token diligence calls, SwarmX would have:
- 1,000 structured audit reports with scores across 5 dimensions
- Historical comparison data for similar tokens
- Pattern recognition across rug pulls vs successful launches
- Distribution curves for what "normal" looks like

A new user asking about Token Y gets better analysis because SwarmX has already analyzed 50 similar tokens and can say: "Tokens with this holder concentration pattern historically scored X on average."

**Sources:**
- [The New Moat: Proprietary Data (AI Ireland)](https://aiireland.ie/2026/03/25/the-new-moat-why-proprietary-data-is-your-only-durable-competitive-advantage-in-ai/)
- [The AI Flywheel (Hampton Global Business Review)](https://hgbr.org/research_articles/the-ai-flywheel-how-data-network-effects-drive-competitive-advantage/)
- [AI Data Strategy 2026: Proprietary Data Moats](https://thestrategystack.substack.com/p/how-to-create-proprietary-data-moats)

---

## 5. Current SwarmX State: What We Already Have

### 5.1 Existing Memory Infrastructure

| Component | File | What It Does |
|-----------|------|-------------|
| `PaymentMemoryService` | `src/services/paymentMemoryService.ts` | Records payments, maintains unscored buffer, spending analytics |
| `paymentEvaluator` | `src/evaluators/paymentEvaluator.ts` | LLM-based quality scoring (1-5) of API responses |
| `reportStore` | `src/utils/reportStore.ts` | JSONL append-only log of audit reports (1000 in-memory cap) |
| `x402PaymentHistory` | `src/schemas/paymentHistory.ts` | Drizzle schema: payments with quality scores |
| `x402EndpointScores` | `src/schemas/endpointScores.ts` | Aggregate endpoint quality (avg score, response time, error rate) |
| `x402BudgetState` | `src/schemas/budgetState.ts` | Cross-session budget tracking |
| TTL Caches | Various route files | Short-lived caches (30s-10min) for de-duplication |

### 5.2 What's Missing

1. **No embeddings** — We store text but never embed it for semantic search
2. **No cross-call learning** — Each API call starts fresh, no context from past calls
3. **No knowledge extraction** — We store raw outputs but never distill them into facts
4. **No similarity retrieval** — No way to find "previous calls about similar tokens"
5. **No feedback into prompts** — Past results never improve future system prompts
6. **No ElizaOS memory integration** — We don't use `runtime.createMemory()` or `runtime.searchMemories()`

### 5.3 What We Already Have That's Good

1. **Structured JSON outputs** — Swarm agents already output parsed JSON with scores
2. **Quality scoring loop** — The evaluator already grades responses 1-5
3. **JSONL persistence** — `reportStore.ts` already persists reports to disk
4. **Drizzle ORM** — Already configured with PostgreSQL schemas
5. **Report types** — Already categorized (contract-audit, token-risk, token-diligence, etc.)

---

## 6. Technical Design: The SwarmX Training Loop

### 6.1 Architecture Overview

```
User pays $1.00 for /swarm/token-diligence (Token X)
        |
        v
  [5 Swarm Agents] --> Structured JSON Output
        |
        v
  [Quality Evaluator] --> Score 1-5
        |
        v
  [Knowledge Extractor] --> Extract facts, patterns, metrics    <-- NEW
        |
        v
  [Knowledge Store] --> pgvector embeddings + JSONL             <-- NEW
        |
        v
  Next user asks about Token Y (similar to X)
        |
        v
  [RAG Retrieval] --> Find past analyses of similar tokens      <-- NEW
        |
        v
  [Prompt Injection] --> Enrich agent system prompts            <-- NEW
        |
        v
  [Better Analysis] --> Agents have historical context
```

### 6.2 New Schema: Knowledge Store

```typescript
// src/schemas/knowledgeStore.ts — NEW
import { pgTable, varchar, text, real, integer, timestamp, index, json } from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core"; // pgvector

export const swarmxKnowledge = pgTable(
  "swarmx_knowledge",
  {
    id: varchar("id", { length: 36 }).primaryKey(),

    // Classification
    category: text("category").notNull(),
      // "token-audit" | "defi-risk" | "fact-check" | "contract-audit" | "market-analysis"
    subcategory: text("subcategory"),
      // "holder-concentration" | "mint-authority" | "liquidity" | etc.

    // Content
    summary: text("summary").notNull(),          // 1-3 sentence distilled finding
    fullContent: text("full_content"),            // Complete agent output (for re-analysis)
    structuredData: json("structured_data"),       // Parsed JSON scores/metrics

    // Embedding for semantic search
    embedding: vector("embedding", { dimensions: 1536 }),  // OpenAI text-embedding-3-small

    // Provenance
    sourceEndpoint: text("source_endpoint").notNull(),  // "/swarm/token-diligence"
    sourceReportId: varchar("source_report_id", { length: 36 }),
    inputMint: text("input_mint"),               // Token mint if applicable
    inputChain: text("input_chain"),             // "solana" | "base" | "ethereum"

    // Quality signals
    qualityScore: real("quality_score"),          // From evaluator (1-5)
    confidenceScore: real("confidence_score"),    // Self-assessed confidence
    wasUsefulCount: integer("was_useful_count").default(0),  // Times retrieved and used
    feedbackScore: real("feedback_score"),        // User feedback if provided

    // Temporal
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),  // Some knowledge decays
  },
  (table) => [
    index("idx_sk_category").on(table.category),
    index("idx_sk_mint").on(table.inputMint),
    index("idx_sk_quality").on(table.qualityScore),
    index("idx_sk_created").on(table.createdAt),
    // pgvector HNSW index for fast similarity search
    // CREATE INDEX idx_sk_embedding ON swarmx_knowledge USING hnsw (embedding vector_cosine_ops);
  ]
);
```

### 6.3 New Schema: Analysis Patterns

```typescript
// src/schemas/analysisPatterns.ts — NEW
import { pgTable, varchar, text, real, integer, timestamp, json } from "drizzle-orm/pg-core";

export const swarmxPatterns = pgTable(
  "swarmx_patterns",
  {
    id: varchar("id", { length: 36 }).primaryKey(),

    // Pattern definition
    patternName: text("pattern_name").notNull(),
      // e.g. "high-concentration-rug-risk", "healthy-distribution-pattern"
    patternType: text("pattern_type").notNull(),
      // "risk-signal" | "positive-signal" | "neutral-observation"
    description: text("description").notNull(),

    // Matching criteria (JSON for flexibility)
    criteria: json("criteria").notNull(),
      // e.g. { "topHolderPct": { "min": 50 }, "mintAuthorityRevoked": false }

    // Statistics
    timesObserved: integer("times_observed").default(1).notNull(),
    avgOutcomeScore: real("avg_outcome_score"),   // Average verdict for tokens matching this pattern
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),

    // Versioning
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  }
);
```

### 6.4 Knowledge Extraction Service

```typescript
// src/services/knowledgeExtractorService.ts — NEW (conceptual)

interface ExtractedKnowledge {
  summary: string;
  category: string;
  subcategory: string;
  structuredData: Record<string, unknown>;
  confidence: number;
}

/**
 * Extracts reusable knowledge from swarm outputs.
 *
 * Called after every paid swarm call that scores >= 3/5 quality.
 * Uses a lightweight LLM call to distill findings into atomic facts.
 */
async function extractKnowledge(
  swarmOutput: string,
  endpoint: string,
  inputData: Record<string, unknown>
): Promise<ExtractedKnowledge[]> {

  const extractionPrompt = `
You are a knowledge curator for a crypto analysis platform.
Given this analysis output, extract 2-5 atomic facts that would be useful
for future analyses of similar tokens/protocols.

Each fact should be:
- Self-contained (understandable without the original context)
- Specific (include numbers, addresses, patterns)
- Categorized (holder-concentration, contract-security, liquidity, team, market)

Output JSON array: [{ "summary": "...", "category": "...", "subcategory": "...",
"structuredData": {...}, "confidence": 0.0-1.0 }]
`;

  // Use gpt-4o-mini for extraction (~$0.0003 per call)
  const result = await callOpenAI({
    systemPrompt: extractionPrompt,
    userPrompt: `Endpoint: ${endpoint}\nInput: ${JSON.stringify(inputData)}\nOutput: ${swarmOutput}`,
    model: "gpt-4o-mini",
    maxTokens: 2048,
    temperature: 0.2,
  });

  return JSON.parse(result);
}
```

### 6.5 RAG Retrieval for Prompt Enrichment

```typescript
// Conceptual: How RAG enriches future swarm calls

async function enrichPromptWithHistory(
  runtime: any,
  mint: string,
  category: string
): Promise<string> {

  // 1. Direct lookup: have we analyzed this exact token before?
  const directMatch = await db.select()
    .from(swarmxKnowledge)
    .where(eq(swarmxKnowledge.inputMint, mint))
    .orderBy(desc(swarmxKnowledge.createdAt))
    .limit(3);

  // 2. Semantic search: find similar analyses
  const queryEmbedding = await embed(`${category} analysis for token ${mint}`);
  const similar = await db.select()
    .from(swarmxKnowledge)
    .where(and(
      eq(swarmxKnowledge.category, category),
      gte(swarmxKnowledge.qualityScore, 3)
    ))
    .orderBy(cosineDistance(swarmxKnowledge.embedding, queryEmbedding))
    .limit(5);

  // 3. Pattern matching: what patterns does this token match?
  const patterns = await db.select()
    .from(swarmxPatterns)
    .where(gte(swarmxPatterns.timesObserved, 3))
    .orderBy(desc(swarmxPatterns.timesObserved))
    .limit(10);

  // 4. Compose context block for injection into agent system prompts
  let context = "";

  if (directMatch.length > 0) {
    context += "\n\n--- PREVIOUS ANALYSIS OF THIS TOKEN ---\n";
    context += directMatch.map(k => k.summary).join("\n");
    context += "\n--- END PREVIOUS ---\n";
  }

  if (similar.length > 0) {
    context += "\n\n--- SIMILAR TOKEN ANALYSES ---\n";
    context += similar.map(k =>
      `[${k.inputMint?.slice(0,8)}...] ${k.summary} (score: ${k.qualityScore})`
    ).join("\n");
    context += "\n--- END SIMILAR ---\n";
  }

  if (patterns.length > 0) {
    context += "\n\n--- KNOWN PATTERNS ---\n";
    context += patterns.map(p =>
      `${p.patternName}: ${p.description} (observed ${p.timesObserved}x, avg outcome: ${p.avgOutcomeScore})`
    ).join("\n");
    context += "\n--- END PATTERNS ---\n";
  }

  return context;
}
```

### 6.6 Integration Points in Existing Routes

The enrichment plugs into existing routes with minimal changes:

```typescript
// In swarmRoutes.ts /swarm/token-diligence handler:

// BEFORE running swarm agents:
const historicalContext = await enrichPromptWithHistory(runtime, mint, "token-audit");

// Inject into each agent's system prompt:
agents[0].system_prompt += historicalContext;
// ... (each agent gets relevant historical context)

// AFTER getting results and saving report:
if (qualityScore >= 3) {
  await extractAndStoreKnowledge(swarmOutput, "/swarm/token-diligence", { mint });
}
```

### 6.7 ElizaOS Plugin Mode Integration

When running as an ElizaOS plugin, we leverage the native memory system:

```typescript
// In plugin mode, use runtime.createMemory() instead of direct DB:
await runtime.createMemory({
  content: {
    text: extractedFact.summary,
    metadata: {
      type: 'knowledge',
      source: 'swarmx-analysis',
      category: extractedFact.category,
      mint: inputMint,
      qualityScore: 4,
      confidence: extractedFact.confidence
    }
  },
  roomId: 'swarmx-knowledge-base',
  entityId: runtime.agentId,
  embedding: await runtime.embed(extractedFact.summary)
}, 'knowledge', true); // unique=true for dedup

// Retrieval:
const relevant = await runtime.searchMemories({
  query: `token analysis ${mint} holder concentration`,
  match_threshold: 0.7,
  count: 5
});
```

This means:
- **Standalone mode**: Direct pgvector + Drizzle (our schemas)
- **ElizaOS plugin mode**: `runtime.createMemory()` + `runtime.searchMemories()` (native integration)
- Both produce the same flywheel effect

---

## 7. Storage Strategy: Three Tiers

### Tier 1: Hot (In-Memory)
- **What**: TTL caches (already exist), recent knowledge entries
- **Size**: ~100 entries per category
- **Purpose**: Sub-millisecond retrieval for active analyses
- **Implementation**: Existing `TTLCache` class

### Tier 2: Warm (PostgreSQL + pgvector)
- **What**: Knowledge store, patterns, payment history
- **Size**: Unlimited (pgvector handles millions efficiently)
- **Purpose**: Semantic search, pattern matching, structured queries
- **Implementation**: New Drizzle schemas + pgvector extension on Railway Postgres
- **Cost**: $0 incremental (pgvector is free extension)

### Tier 3: Cold (JSONL Append-Only)
- **What**: Complete raw swarm outputs, full audit reports
- **Size**: Append-only, compress monthly
- **Purpose**: Re-analysis, fine-tuning data export, compliance audit trail
- **Implementation**: Extend existing `reportStore.ts` pattern
- **Format**: One JSON object per line, streamable for ML training

### Tier 3b: Future (Fine-Tuning Export)
- **What**: Curated (prompt, response, score) tuples from Tier 3
- **Format**: OpenAI JSONL fine-tuning format
- **Purpose**: Fine-tune smaller models on SwarmX's proprietary analysis style
- **When**: After 10,000+ paid calls with quality scores

---

## 8. How to Feed Back Into Agents

### 8.1 System Prompt Injection (Immediate, No Training Required)

The fastest path to improvement. Before each swarm call:

1. Query knowledge store for relevant past analyses
2. Append as a context block in the agent's system prompt
3. Agent naturally incorporates historical data

**Cost**: One embedding call (~$0.0001) + one DB query per request
**Latency**: ~50ms additional
**Effectiveness**: High for factual grounding, prevents contradicting past findings

### 8.2 Few-Shot Examples (Medium-Term)

Store the top-scoring (quality >= 4) complete analysis outputs as exemplars:

1. For each endpoint, maintain a library of 5-10 "gold standard" outputs
2. Include 1-2 few-shot examples in the system prompt
3. Agents learn the expected output format and depth

**Cost**: Increases prompt tokens by ~500-1000 per example
**Effectiveness**: Dramatically improves output consistency and quality

### 8.3 Pattern-Based Rules (Medium-Term)

As the pattern database grows, convert frequently-observed patterns into explicit rules:

```
"When analyzing a token where top holder holds >50% AND mint authority is NOT revoked,
always flag as HIGH_RISK regardless of other factors. This pattern has been observed
47 times with an average outcome score of 1.2/5 (mostly rug pulls)."
```

These become deterministic rules injected into agent prompts, not requiring retrieval.

### 8.4 Fine-Tuning (Long-Term, 10K+ Calls)

After accumulating sufficient data:

1. Export JSONL from Tier 3: `{ "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "Analyze token X..." }, { "role": "assistant", "content": "<high-quality-output>" }] }`
2. Filter for quality >= 4/5
3. Fine-tune gpt-4o-mini on SwarmX's analysis style
4. Deploy as custom model, reducing per-call cost while maintaining quality

**When**: After 10,000 paid calls with quality data
**Cost**: ~$25 per fine-tuning run
**Benefit**: Proprietary model that encodes SwarmX's analytical approach

### 8.5 RLHF / RLAIF (Long-Term)

Use the quality scoring pipeline as a reward signal:

1. Generate multiple analyses for the same input
2. Use the evaluator to score each
3. Train a reward model on the scoring distribution
4. Use GRPO (Group Relative Policy Optimization) to improve the base model

This is the most ambitious approach but creates the deepest moat.

---

## 9. Implementation Roadmap

### Phase 1: Foundation (1-2 weeks)
- [ ] Add pgvector extension to Railway PostgreSQL
- [ ] Create `swarmx_knowledge` Drizzle schema with vector column
- [ ] Create `KnowledgeStoreService` (extends Service for both standalone and plugin modes)
- [ ] Wire up: after `saveReport()`, also store knowledge entries with embeddings
- [ ] Basic retrieval: query similar past analyses before swarm calls

### Phase 2: RAG Enrichment (2-3 weeks)
- [ ] Implement `enrichPromptWithHistory()` for all swarm endpoints
- [ ] Add knowledge extraction LLM call after quality-scored outputs
- [ ] Create `swarmx_patterns` schema for observed patterns
- [ ] Pattern detection: auto-identify recurring risk signals across analyses
- [ ] Add `wasUsefulCount` tracking (increment when retrieved knowledge is used)

### Phase 3: Few-Shot Library (1-2 weeks)
- [ ] Curate top 5-10 exemplar outputs per endpoint category
- [ ] Build few-shot selection logic (most relevant to current query)
- [ ] A/B test: with-history vs without-history analysis quality
- [ ] Add user feedback endpoint (`POST /feedback/:reportId`)

### Phase 4: ElizaOS Integration (1-2 weeks)
- [ ] Implement `runtime.createMemory()` path for plugin mode
- [ ] Implement `runtime.searchMemories()` retrieval for plugin mode
- [ ] Shared knowledge base across multiple ElizaOS agents
- [ ] Memory synchronization between standalone and plugin modes

### Phase 5: Training Data Pipeline (4+ weeks, after scale)
- [ ] JSONL export tool: filtered by quality, category, time range
- [ ] Fine-tuning pipeline: OpenAI JSONL format generation
- [ ] Evaluation harness: compare fine-tuned vs base model quality
- [ ] Deploy custom model as option for cost-sensitive endpoints

---

## 10. Cost Analysis

| Operation | Cost | Frequency | Monthly (1K calls/day) |
|-----------|------|-----------|----------------------|
| Embedding generation (text-embedding-3-small) | $0.00002/1K tokens | Per knowledge entry (~3 per call) | ~$1.80 |
| Knowledge extraction LLM (gpt-4o-mini) | $0.0003/call | Per quality call (70% of calls) | ~$6.30 |
| RAG retrieval embedding | $0.00002/1K tokens | Per incoming call | ~$0.60 |
| pgvector storage | $0 incremental | N/A | $0 |
| JSONL storage | ~1KB per entry | Per call | ~30MB/month |
| **Total overhead** | | | **~$8.70/month** |

At $0.25-$2.00 per paid call, 1K calls/day = $250-2000/day revenue. The $8.70/month overhead is negligible (<0.1% of revenue) while building a proprietary knowledge base worth exponentially more over time.

---

## 11. The Flywheel Narrative

> **"Every paid call makes SwarmX smarter."**

1. User pays for `/swarm/token-diligence` on Token X
2. 5 agents analyze: contract, tokenomics, team, market, liquidity
3. Result stored: mint, scores, findings, verdict, timestamp
4. Knowledge extracted: atomic facts with embeddings
5. Next user asks about Token Y (similar holder distribution to X)
6. RAG retrieves: "We've seen this pattern 12 times before. 8 were rug pulls."
7. Agents produce **better** analysis with historical comparison data
8. User gets more value per dollar spent
9. More users pay for SwarmX analysis
10. More data compounds the knowledge base
11. Goto 1

This is the same flywheel that made Google Search, Amazon recommendations, and Tesla's self-driving better with scale. SwarmX's version is: **paid crypto intelligence that improves with every analysis.**

---

## 12. Key Technical Decisions

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Vector DB | pgvector (not Pinecone/ChromaDB) | Already use PostgreSQL + Drizzle, $0 cost, Drizzle native support |
| Embedding model | text-embedding-3-small (1536-dim) | Best cost/quality ratio, same as ElizaOS adapter-postgres default |
| Cold storage | JSONL append-only | Proven pattern (reportStore.ts), streamable, ML-ready format |
| Knowledge extraction | gpt-4o-mini | $0.0003/call, fast, sufficient for fact extraction |
| Plugin mode memory | runtime.createMemory() | Native ElizaOS integration, gets pgvector free via adapter-postgres |
| Standalone mode memory | Direct Drizzle + pgvector | No ElizaOS dependency, same schemas |
| Pattern detection | Threshold-based (3+ observations) | Simple, explainable, no ML training required initially |
| Feedback signal | Quality score (1-5) from evaluator | Already implemented, provides immediate signal |
| Prompt enrichment | System prompt injection | Zero training cost, immediate effect, easily auditable |

---

## 13. Risk Factors

| Risk | Mitigation |
|------|-----------|
| Stale knowledge (crypto moves fast) | `expiresAt` field, temporal decay scoring, prioritize recent |
| Garbage in (low-quality analysis stored) | Only store quality >= 3/5, confidence filtering |
| Embedding model changes | Store raw text alongside embeddings, re-embed on model change |
| Prompt bloat (too much context) | Cap RAG context to 2000 tokens, rank by relevance |
| Privacy concerns (user inputs stored) | Hash/anonymize wallet addresses, no PII in knowledge entries |
| Knowledge conflicts (contradictory findings) | Temporal precedence (newer wins), confidence weighting |
| Cost creep (embedding + extraction calls) | Monitor via existing budget tracking, cap at % of revenue |

---

## 14. Competitive Positioning

With this system, SwarmX becomes:

1. **Not just an API** — A knowledge-accumulating intelligence platform
2. **Not just multi-agent** — Multi-agent with institutional memory
3. **Not just crypto analysis** — Crypto analysis that gets smarter with every call
4. **Defensible** — Proprietary knowledge base cannot be replicated without matching usage volume

The pitch evolves from:
> "Pay $1 for AI agent teams to analyze your token"

To:
> "Pay $1 to tap into SwarmX's growing intelligence — built from thousands of paid analyses, with historical pattern recognition no single agent can match"

---

## Appendix A: ElizaOS Memory API Quick Reference

```typescript
// Create memory with embedding
await runtime.createMemory(memory: Memory, tableName: string, unique?: boolean): Promise<UUID>

// Get memories by filters
await runtime.getMemories({ roomId, entityId, count, start, end, offset }): Promise<Memory[]>

// Semantic search
await runtime.searchMemories({ embedding, query, match_threshold, count, roomId }): Promise<Memory[]>

// Generate embedding
await runtime.embed(text: string): Promise<number[]>

// Batch embedding
await runtime.embedBatch(texts: string[]): Promise<number[][]>

// Delete memory
await runtime.deleteMemory(id: UUID): Promise<void>

// Compose state (includes memory retrieval)
await runtime.composeState(message: Memory): Promise<State>
```

## Appendix B: Vector DB Quick Comparison for Our Use Case

| Criterion | pgvector | ChromaDB | Pinecone |
|-----------|----------|----------|----------|
| Already in our stack | Yes (Drizzle) | No | No |
| Cost at 1M vectors | $0 incremental | $30/mo (self-hosted) | $70-300/mo |
| TypeScript support | Native (Drizzle) | Python-first | Yes (SDK) |
| Handles 1M+ vectors | Yes (with HNSW) | Yes | Yes |
| Self-hosted | Yes (Railway PG) | Yes | No (managed only) |
| ElizaOS compatible | Yes (adapter-postgres) | No | No |
| ACID transactions | Yes | No | No |
| **Winner for SwarmX** | **Yes** | No | No |
