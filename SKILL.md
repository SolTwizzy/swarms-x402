---
name: elizaos
description: >
  Expert-level knowledge of the ElizaOS framework and ecosystem for building autonomous AI agents.
  Use when working with ElizaOS projects — creating agents, developing plugins (actions, providers,
  evaluators, services), configuring characters, integrating platforms (Discord, Telegram, Twitter,
  Farcaster), blockchain/DeFi (Solana, EVM), knowledge/RAG systems, memory management, database
  schemas, REST APIs, WebSocket, CLI commands, deployment (Eliza Cloud, Docker, Railway, TEE),
  background tasks, event systems, model providers (OpenAI, Anthropic, Ollama, OpenRouter), or
  any code using @elizaos/core, @elizaos/cli, @elizaos/plugin-*, or the elizaos GitHub repos.
  Also use when discussing AI agent architecture, multi-agent orchestration, or the elizaos ecosystem.
  Covers the v2.0.0 branch (alpha.109+) with Python/Rust SDKs, protobuf schemas, cross-language
  interop, capability tiers, autonomy system, ServiceBuilder API, tool policies, approval service,
  hook system, prompt batching, pairing workflow, and plugin store.
  When invoked with a question argument (/elizaos <question>), answer the question using the
  reference files below. When invoked without arguments, load as context for the current task.
---

# ElizaOS Expert Skill

## Question Mode

When invoked with a question (e.g., `/elizaos how do I create a provider?`), follow this workflow:

1. **Route to the right reference** based on the question topic:
   - Plugin development (actions, providers, evaluators, services, routes, events, schemas) → read **[Plugin Development](references/plugin-development.md)**
   - v2 architecture (types, runtime, breaking changes, new features, capability tiers) → read **[v2 Architecture](references/v2-architecture.md)**
   - Platform integrations (Discord, Telegram, Twitter, Solana, EVM, LLM providers) → read **[Platform Integrations](references/platform-integrations.md)**
   - REST API, WebSocket, messaging → read **[API Reference](references/api-reference.md)**
   - Ecosystem repos, starters, tools → read **[Ecosystem](references/ecosystem.md)**
   - Integration patterns (embedded vs external, production deployment) → read **[Integration Patterns](references/integration-patterns.md)**
2. **Answer the question** directly using the reference content + this skill's knowledge.
3. **Include code examples** when the question is about implementation.
4. **Flag gotchas** relevant to the answer (see Gotchas section below).

If the question spans multiple topics, read multiple references as needed.

## Architecture Overview

ElizaOS is a TypeScript framework (Node.js v23+, Bun) for autonomous AI agents. Latest: **v2.0.0-alpha.109** (daily releases, no stable v2 yet).

```
ElizaOS (multi-agent manager, extends EventTarget)
  └── AgentRuntime instances (implements IAgentRuntime extends IDatabaseAdapter)
       ├── Character     — personality, knowledge, style
       ├── Plugins       — modular capability bundles
       │    ├── Actions     — what agents DO (VERB_NOUN)
       │    ├── Providers   — what agents SEE (context injection)
       │    ├── Evaluators  — what agents LEARN (post-processing)
       │    └── Services    — what agents CONNECT to (singletons)
       ├── Memory        — persistent vector DB (5 types)
       ├── Events        — 30+ async event types + hooks
       ├── Models        — provider-agnostic with priority routing
       ├── Tasks         — background workers with triggers + scheduling
       ├── Tool Policy   — per-channel/world action filtering
       └── Database      — Drizzle ORM + PostgreSQL/PGLite
```

### Message Processing Pipeline

```
Message In → Store in Memory → Compose State (all Providers) → shouldRespond Decision
  → LLM generates thought + actions + response → Validate & Execute Actions
  → Run Evaluators → Store Response → Deliver via Client
```

Two processing modes: **Single-Shot** (one LLM call) and **Multi-Step** (iterative with accumulated context + working memory).

### Monorepo Packages

| Package | Purpose |
|---------|---------|
| `@elizaos/core` | Runtime, types, interfaces, utilities (v2: `packages/typescript/`) |
| `@elizaos/server` | Express.js backend, REST API, WebSocket |
| `@elizaos/client` | React web dashboard |
| `@elizaos/cli` | CLI tool (`elizaos` command, v2: `packages/elizaos/`) |
| `@elizaos/plugin-bootstrap` | Core message handler (v2: integrated into core) |
| `@elizaos/plugin-sql` | Database adapter (required, priority 0) |

### v2.0.0 Package Restructuring

```
packages/
  @schemas/     → Protobuf .proto schemas (cross-language types)
  typescript/   → @elizaos/core
  python/       → Python runtime/SDK
  rust/         → Rust runtime/SDK
  interop/      → Cross-language plugin interop
  elizaos/      → CLI binary
  computeruse/  → Computer use capabilities
  sweagent/     → SWE Agent
  prompts/      → Standalone prompt templates
plugins/        → 45+ plugins at root level
```

For full v2 details, read **[v2 Architecture](references/v2-architecture.md)**.

## Quick Start

```bash
bun install -g @elizaos/cli
elizaos create my-agent          # Scaffold project
elizaos env edit-local           # Set API keys
elizaos start                    # Run (web UI at localhost:3000)
elizaos dev                      # Dev mode with hot reload
```

## CLI Reference

| Command | Purpose |
|---------|---------|
| `elizaos create [name]` | New project/plugin/agent (`--type project\|plugin\|agent\|tee`) |
| `elizaos start` | Production mode (`--character <paths>`, `-p <port>`) |
| `elizaos dev` | Dev with hot reload (`-b` to build first) |
| `elizaos test` | Run tests (`--type component\|e2e\|all`, `--name <pattern>`) |
| `elizaos deploy` | Deploy to Eliza Cloud |
| `elizaos plugins list\|add\|remove` | Manage plugins |
| `elizaos agent list\|start\|stop\|get\|remove\|clear-memories` | Manage agents |
| `elizaos env list\|edit-local\|reset` | Environment config |
| `elizaos publish` | Publish plugin to registry |
| `elizaos update` | Update CLI and packages |

## Project Structure

```
my-project/
├── src/
│   ├── index.ts           # Entry: exports Project with agents
│   ├── character.ts       # Character definition
│   ├── plugins/           # Custom plugins
│   └── __tests__/         # Tests (Bun test runner)
├── .env                   # API keys (gitignored)
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── .eliza/                # Runtime data, PGLite DB
```

### Entry Point

```typescript
import { type Project, type ProjectAgent } from '@elizaos/core';
import { character } from './character';

const agent: ProjectAgent = {
  character,
  init: async (runtime) => { /* post-init logic — DB is ready here */ },
  plugins: [],
};

const project: Project = { agents: [agent] };
export default project;
```

## Character Configuration

```typescript
const character: Character = {
  name: 'TradingBot',
  bio: ['Expert DeFi trader', 'Monitors on-chain activity 24/7'],
  username: 'defi_bot',
  adjectives: ['analytical', 'precise', 'risk-aware'],
  topics: ['DeFi', 'yield farming', 'MEV', 'liquidity'],
  style: {
    all: ['Be concise, data-driven', 'Include numbers when relevant'],
    chat: ['Ask about risk tolerance before suggesting trades'],
    post: ['Include relevant token tickers', 'Keep under 280 chars'],
  },
  messageExamples: [[
    { name: 'user', content: { text: 'Should I buy ETH?' } },
    { name: 'TradingBot', content: { text: 'ETH is at $3,200, up 4.2% today. RSI at 62. What is your time horizon?' } },
  ]],
  knowledge: ['DeFi protocol mechanics', { path: './docs/strategies.md', shared: false }],
  plugins: ['@elizaos/plugin-sql', '@elizaos/plugin-openai', '@elizaos/plugin-solana'],
  settings: {
    model: 'gpt-4o',
    secrets: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  },
};
```

## Database Architecture

### Storage Backends

ElizaOS uses **PGLite** (embedded PostgreSQL in Node.js) by default. For production, set `POSTGRES_URL`.

Both backends extend `BaseDrizzleAdapter` and implement `IDatabaseAdapter`.

### Core Tables (auto-created by plugin-sql)

`agents`, `memories`, `entities`, `relationships`, `rooms`, `participants`, `messages`, `embeddings`, `cache`, `logs`, `tasks`

### Embedding Dimensions

**Default: 384** (NOT 1536). `VECTOR_DIMS: SMALL(384), MEDIUM(512), LARGE(768), XL(1024), XXL(1536), XXXL(3072)`.

### Plugin Schema System (Drizzle ORM)

```typescript
import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const myDataTable = pgTable('my_plugin_data', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull(),
  content: text('content').notNull(),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const myPlugin: Plugin = {
  name: 'my-plugin',
  schema: { myDataTable },  // Enables auto-migration
};
```

Schema namespacing: `@company/my-plugin` → PostgreSQL schema `company_my_plugin`. Migrations are additive only (no drops, no column type changes).

### Database Access

```typescript
const db = runtime.databaseAdapter.db;
// Or use IPluginStore (new in v2 alpha.85+) for adapter-agnostic CRUD
```

## Key Interfaces (v2)

### Memory System

5 types: `DOCUMENT`, `FRAGMENT`, `MESSAGE`, `DESCRIPTION`, `CUSTOM`. Scopes: `shared`, `private`, `room`.

```typescript
await runtime.createMemory({ type: MemoryType.DOCUMENT, content: { text: 'User prefers ETH' },
  metadata: { confidence: 0.9 }, roomId, entityId });

const results = await runtime.searchMemories({ type: MemoryType.DOCUMENT,
  query: 'user token preferences', limit: 10, threshold: 0.7 });
```

### Model Types & Priority Routing

```
TEXT_SMALL, TEXT_LARGE, TEXT_COMPLETION, TEXT_REASONING_SMALL, TEXT_REASONING_LARGE,
TEXT_EMBEDDING, TEXT_TOKENIZER_ENCODE/DECODE, IMAGE, IMAGE_DESCRIPTION,
TRANSCRIPTION, TEXT_TO_SPEECH, AUDIO, VIDEO, OBJECT_SMALL, OBJECT_LARGE, RESEARCH
```

Usage: `await runtime.useModel(ModelType.TEXT_LARGE, { prompt, temperature: 0.7 })`

### Event Types (30+)

World: WORLD_JOINED/CONNECTED/LEFT | Entity: ENTITY_JOINED/LEFT/UPDATED
Room: ROOM_JOINED/LEFT | Message: MESSAGE_RECEIVED/SENT/DELETED
Voice: VOICE_MESSAGE_RECEIVED/SENT | Run: RUN_STARTED/ENDED/TIMEOUT
Action: ACTION_STARTED/COMPLETED | Evaluator: EVALUATOR_STARTED/COMPLETED
Model: MODEL_USED | Embedding: EMBEDDING_GENERATION_* | Control: CONTROL_MESSAGE
Form: FORM_FIELD_CONFIRMED/CANCELLED | Hook: HOOK_COMMAND_*/HOOK_SESSION_*/HOOK_AGENT_*

### Service Types

```
transcription, video, browser, pdf, aws_s3, web_search, email, tee, task,
wallet, lp_pool, token_data, message_service, message, post, approval,
tool_policy, hooks, pairing, agent_event, voice_cache, unknown
```

### New in v2 (alpha.20+)

- **Working Memory**: `State.data.workingMemory` — intermediate action results without DB round-trips
- **Tool Policy**: Per-channel/world/room action filtering with profiles (minimal, coding, messaging, full)
- **Approval Service**: Human-in-the-loop approval flows with role gating and timeouts
- **Hook System**: Priority-ordered event hooks (command, session, agent lifecycle, tool, compaction)
- **Prompt Batcher**: Batch LLM calls with schema-based output, caching, stale-while-revalidate
- **Pairing System**: Structured DM sender verification across platforms
- **Plugin Store**: Generic CRUD adapter (`IPluginStore`) — no Drizzle casting needed
- **Trigger System**: cron/interval/once task triggers with history tracking
- **Session Compaction**: LLM-summarized conversation history management
- **`Action.relevanceKeywords`**: Fast keyword-based action filtering without LLM

## Bootstrap Plugin — Capability Tiers

**Basic (default):** Core providers + REPLY/IGNORE/NONE actions + TaskService + EmbeddingGenerationService + TrajectoryLoggerService.

**Extended (ENABLE_EXTENDED_CAPABILITIES):** +knowledge, facts, contacts, relationships + addContact, choice, generateImage, sendMessage, etc. + reflection, relationshipExtraction evaluators + RolodexService, FollowUpService.

**Autonomy (ENABLE_AUTONOMY):** +adminChat, autonomyStatus providers + sendToAdmin action + AutonomyService + autonomyRoutes.

## Background Tasks

```typescript
const worker: TaskWorker = {
  name: 'PRICE_ALERT',
  shouldRun: async (runtime, task) => !task.metadata?.paused,  // NEW: scheduler gate
  canExecute: async (runtime, message, state) => true,         // NEW: authorization gate
  execute: async (runtime, options, task) => {
    const price = await checkPrice(task.metadata.token);
    if (price > task.metadata.threshold) await notify(runtime, task);
    return { nextInterval: 60000 };  // NEW: dynamic interval
  },
};

await runtime.createTask({
  name: 'PRICE_ALERT',
  metadata: { token: 'ETH', threshold: 4000, updateInterval: 60000,
    trigger: { type: 'interval', interval: 60000 } },  // NEW: trigger config
  tags: ['repeat'],
});
```

## Common Environment Variables

```env
OPENAI_API_KEY=sk-...              # Or ANTHROPIC_API_KEY
POSTGRES_URL=postgresql://...       # Or use PGLite (default)
SERVER_PORT=3000
ELIZA_SERVER_AUTH_TOKEN=            # REST API auth (X-API-KEY header)
DISCORD_APPLICATION_ID= / DISCORD_API_TOKEN=
TELEGRAM_BOT_TOKEN=
SOLANA_PRIVATE_KEY= / SOLANA_RPC_URL=
EVM_PRIVATE_KEY= / ETHEREUM_PROVIDER_MAINNET=
LOAD_DOCS_ON_STARTUP=true
CTX_KNOWLEDGE_ENABLED=true         # 50% better retrieval via contextual embeddings
```

## Key Gotchas & Troubleshooting

- **Default embedding dimension is 384**: NOT 1536. Both adapters default to `DIMENSION_MAP[384]`.
- **Anthropic has no embedding model**: Always include OpenAI or Ollama as fallback for embeddings.
- **Plugin init timing**: `plugin.init()` is called during `registerPlugin()`. DB may NOT be ready. Defer DB work to Service `start()` or `ProjectAgent.init()`.
- **plugin-sql priority 0**: Must load first. All other plugins should have priority 10+.
- **Schema auto-migration is additive only**: No drops, no column type changes, no rollbacks.
- **Never throw from handlers**: Return `{ success: false, error }` from actions; return empty result from providers.
- **Plugin.adapter is now a factory (v2 alpha.109)**: Must be `(agentId, settings) => IDatabaseAdapter`, not an instance.
- **registerDatabaseAdapter() removed (v2 alpha.109)**: Adapter is set in constructor, not registered post-construction.
- **HandlerCallback now has optional actionName**: `(response, actionName?) => Promise<Memory[]>`. Backward-compatible.
- **TaskWorker.validate deprecated**: Use `shouldRun` (scheduler gate) and `canExecute` (authorization gate) instead.
- **WebSocket clients must listen to `messageBroadcast`**: NOT `message`. Must emit ROOM_JOINING first.
- **TELEGRAM_ALLOWED_CHATS**: Must be JSON stringified array, not comma-separated.
- **Do NOT name a property `config` in Service subclasses**: Conflicts with `Service.config?: Metadata`.

## Reference Files

Read these reference files as needed for deeper information:

- **[v2 Architecture](references/v2-architecture.md)** — v2.0.0 alpha.109: full type system, IAgentRuntime, breaking changes from v1/alpha.2, new features (working memory, tool policy, approval, hooks, prompt batcher, pairing, plugin store, triggers, session compaction). Read when working with v2 code.
- **[Plugin Development](references/plugin-development.md)** — Full Action/Provider/Evaluator/Service interfaces, handler signatures, patterns, schemas, routes, events, AdapterFactory. Read when writing or debugging plugins.
- **[Platform Integrations](references/platform-integrations.md)** — All platform plugins (Discord, Twitter, Telegram, Farcaster), blockchain (Solana, EVM), LLM providers, Knowledge/RAG. Read when configuring integrations.
- **[API Reference](references/api-reference.md)** — REST API endpoints, WebSocket events, Socket.IO. Read when building API integrations.
- **[Integration Patterns](references/integration-patterns.md)** — Embedded vs External Server, production deployment patterns. Read when planning architecture.
- **[Ecosystem](references/ecosystem.md)** — GitHub repos, starters, showcase agents, Python toolkit. Read when exploring the ecosystem.
