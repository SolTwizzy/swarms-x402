# Plugin Development Reference

## Plugin Interface

```typescript
const plugin: Plugin = {
  name: 'my-plugin',
  description: 'What this plugin does',
  priority: 10,                    // Loading order (lower = loads first, plugin-sql uses 0)
  dependencies: ['@elizaos/plugin-sql'],
  init: async (config, runtime) => { /* setup — called during registerPlugin() */ },
  actions: [],
  providers: [],
  evaluators: [],
  services: [],
  routes: [],                      // HTTP endpoints
  events: {},                      // Event handlers
  tests: [],
  config: {},
  schema: {},                      // Drizzle ORM table definitions for auto-migration
  adapter: undefined,              // AdapterFactory (alpha.109): (agentId, settings) => IDatabaseAdapter
  models: {},                      // Model handler registrations
};
```

### Plugin Init Timing (CRITICAL)

`plugin.init(config, runtime)` is called during `registerPlugin()`. DB may NOT be ready (plugin-sql has priority 0).

**Do NOT** in `init()`: `runtime.createTask()`, `runtime.createMemory()`, `runtime.databaseAdapter.db`

**Instead**, defer to: Service `start(runtime)`, `ProjectAgent.init(runtime)`, or TaskWorker `execute()`.

### Plugin.adapter — AdapterFactory (BREAKING in alpha.109)

```typescript
// OLD (alpha.2) — direct instance
adapter: myDatabaseAdapter,

// NEW (alpha.109) — factory function
adapter: (agentId: UUID, settings: Record<string, string>) => {
  return new MyDatabaseAdapter(agentId, settings);
},
```

## Actions

Name them `VERB_NOUN`. Always return `ActionResult`.

```typescript
const myAction: Action = {
  name: 'SWAP_TOKEN',
  description: 'Swap one token for another on DEX',
  similes: ['exchange token', 'trade token'],
  relevanceKeywords: ['swap', 'exchange', 'trade', 'dex'],  // NEW alpha.109
  examples: [[
    { name: 'user', content: 'Swap 1 ETH for USDC' },
    { name: 'agent', content: 'Executing swap of 1 ETH for USDC...' },
  ]],
  validate: async (runtime, message) => {
    return message.content?.text?.toLowerCase().includes('swap') ?? false;
  },
  handler: async (runtime, message, state?, options?, callback?) => {
    // Access working memory (NEW alpha.20+)
    const workingMemory = state?.data?.workingMemory;
    // Previous step results
    const previousResults = state?.data?.actionResults || [];

    if (callback) {
      await callback({ text: 'Finding best route...' });
    }

    try {
      const result = await executeSwap(/* ... */);
      return {
        success: true,
        text: `Swapped 1 ETH for ${result.amount} USDC`,
        data: { txHash: result.hash, amount: result.amount },
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },
};
```

### Action Best Practices

- Never throw — return `{ success: false, error }`
- Use `relevanceKeywords` for fast filtering (alpha.109+)
- Store structured `data` for downstream actions
- Be idempotent — safe to retry

## Providers

Inject context into LLM prompts — agent "senses."

```typescript
const walletProvider: Provider = {
  name: 'WALLET_BALANCE',
  description: 'Current wallet balances',
  dynamic: true, position: -50, private: false,
  get: async (runtime, message, state?) => {
    try {
      const balances = await fetchBalances(runtime.getSetting('WALLET_ADDRESS'));
      return {
        text: `Wallet: ${balances.total} USD`,
        values: { totalBalance: balances.total.toString() },
        data: { balances: balances.detailed },
      };
    } catch (error) {
      return { text: '', values: {}, data: {} }; // Never throw
    }
  },
};
```

Position: -100 (first) to 100 (last). `dynamic: true` = re-fetch every call.

## Evaluators

Post-processors for response analysis.

```typescript
const sentimentEvaluator: Evaluator = {
  name: 'SENTIMENT_TRACKER',
  description: 'Track conversation sentiment',
  alwaysRun: false,
  validate: async (runtime, message) => true,
  handler: async (runtime, message, state?) => {
    const sentiment = await analyzeSentiment(message.content.text);
    if (sentiment) {
      await runtime.createMemory({
        type: MemoryType.CUSTOM,
        content: { text: `User sentiment: ${sentiment.label}` },
      });
    }
    return { sentiment };
  },
};
```

## Services

Long-running singletons.

```typescript
class PriceService extends Service {
  static serviceType = 'price-feed';
  capabilityDescription = 'Real-time token price data';

  static async start(runtime: IAgentRuntime): Promise<PriceService> {
    const service = new PriceService(runtime);
    const apiKey = runtime.getSetting('PRICE_API_KEY');
    if (!apiKey) { runtime.logger.warn('No API key'); return service; }
    await service.connect(String(apiKey));
    return service;
  }

  async stop(): Promise<void> { /* cleanup */ }
}
```

### ServiceBuilder Fluent API (v2)

```typescript
const myService = createService<MyInterface>('my-service')
  .withDescription('Does something useful')
  .withStart(async (runtime) => instance)
  .withStop(async () => {})
  .build();
```

### Service Types

```
TRANSCRIPTION, VIDEO, BROWSER, PDF, REMOTE_FILES, WEB_SEARCH, EMAIL, TEE, TASK,
WALLET, LP_POOL, TOKEN_DATA, MESSAGE_SERVICE, APPROVAL, TOOL_POLICY, HOOKS,
PAIRING, AGENT_EVENT, VOICE_CACHE
```

Do NOT name a property `config` — conflicts with `Service.config?: Metadata`.

## Routes (HTTP Endpoints)

```typescript
const routes: Route[] = [
  { type: 'GET', path: '/api/data', public: false,
    handler: async (req, res, runtime) => { res.json({ data }); } },
  { type: 'POST', path: '/api/upload', isMultipart: true,
    handler: async (req, res, runtime) => { /* upload */ } },
  { type: 'STATIC', path: '/dashboard', filePath: './public' },
];
```

## Event Handlers

```typescript
events: {
  MESSAGE_RECEIVED: [async (runtime, event) => { /* ... */ }],
  ACTION_COMPLETED: [async (runtime, event) => { /* ... */ }],
},
```

## Background Tasks (alpha.109)

```typescript
const worker: TaskWorker = {
  name: 'PRICE_ALERT',
  shouldRun: async (runtime, task) => !task.metadata?.paused,     // scheduler gate
  canExecute: async (runtime, message, state) => true,            // authorization gate
  execute: async (runtime, options, task) => {
    await checkAndNotify(task);
    return { nextInterval: 60000 };  // dynamic interval
  },
};

await runtime.createTask({
  name: 'PRICE_ALERT',
  metadata: {
    trigger: { type: 'interval', interval: 60000 },
    maxFailures: 3, notBefore: '2026-04-01T00:00:00Z',
  },
  tags: ['repeat'],
});
```

## Database Schemas

```typescript
export const trades = pgTable('trades', {
  id: uuid('id').primaryKey().defaultRandom(),
  pair: text('pair').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index('idx_trades_pair').on(table.pair)]);

export const plugin: Plugin = { name: 'trading', schema: { trades } };
```

### IPluginStore (alpha.85+ — adapter-agnostic CRUD)

```typescript
const store = runtime.getPluginStore('my-plugin');
const items = await store.query<Trade>('trades', { pair: 'ETH/USDC' });
await store.insert('trades', { pair: 'ETH/USDC', amount: '1.0' });
// Filter operators: equality, $in, $gt, $lt, $gte, $lte
```

## Tool Policy Integration (alpha.70+)

```typescript
const { allowed, reason } = runtime.isActionAllowed('SWAP_TOKEN', { channelType: 'DM' });
const actions = runtime.getFilteredActions({ channelType: 'GROUP', roomId });
```

## Approval Service (alpha.50+)

```typescript
const approval = runtime.getService<ApprovalService>('approval');
const result = await approval.requestApproval({
  title: 'Execute swap?',
  options: STANDARD_OPTIONS.APPROVE_DENY,
  timeout: 120000, allowedRoles: ['OWNER'],
});
if (!result.approved) return { success: false, error: 'Denied' };
```

## Plugin Patterns

### Conditional Loading
```typescript
const plugins = [
  '@elizaos/plugin-bootstrap', '@elizaos/plugin-sql',
  ...(process.env.ANTHROPIC_API_KEY ? ['@elizaos/plugin-anthropic'] : []),
];
```

### Action Chaining
Return `data` from each action; next actions access via `state?.data?.actionResults`.

### Service Integration
```typescript
const service = runtime.getService<PriceService>('price-feed');
if (!service) return { success: false, error: 'Service unavailable' };
```
