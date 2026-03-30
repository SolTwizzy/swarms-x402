# ElizaOS v2.0.0 Architecture Reference

Latest: **v2.0.0-alpha.109** (daily releases, no stable v2 yet). `latest` dist-tag: alpha.77. `next`: alpha.32. Node 23.3.0, Bun 1.3.5.

## Package Restructuring

```
packages/
  @schemas/        → Protobuf .proto schemas for cross-language type generation
  typescript/      → @elizaos/core (was packages/core/)
    src/
      advanced-capabilities/  → Extended agent capabilities
      advanced-memory/        → Advanced memory systems
      advanced-planning/      → Multi-step planning
      autonomy/               → Autonomous agent operations
      basic-capabilities/     → Core providers, actions, services
      bootstrap/              → Bootstrap plugin (moved FROM packages/plugin-bootstrap/)
      database/               → DB adapters (includes InMemoryAdapter)
      generated/              → Auto-generated code (action-docs, spec-helpers)
      schemas/                → Character schemas
      services/               → Message service, trajectory logger
      testing/                → Test framework
      types/                  → 26 type definition files
      utils/                  → buffer, environment, node, streaming
  python/          → Python runtime/SDK
  rust/            → Rust runtime/SDK
  interop/         → @elizaos/interop: cross-language plugin interop (TS/Python/Rust)
  elizaos/         → CLI binary (renamed from @elizaos/cli)
  computeruse/     → Computer use capabilities
  sweagent/        → Software engineering agent
  prompts/         → Standalone prompt templates
  docs/            → Documentation (Mintlify)

plugins/           → 45+ plugins at root level (moved from packages/plugin-*)
```

## Type System (26 files in packages/typescript/src/types/)

### Primitives (types/primitives.ts)
- **UUID**: String type
- **ChannelType**: SELF, DM, GROUP, VOICE_DM, VOICE_GROUP, FEED, THREAD, WORLD, FORUM, API (deprecated)
- **Content**: text, thoughts?, actions?, attachments?, channel?, metadata?, responseMessageId?
- **MentionContext**: isMention, isReply, isThread
- **Media**: id, url, title, source, description, contentType
- **ContentType**: IMAGE, VIDEO, AUDIO, DOCUMENT, LINK

### Agent (types/agent.ts)
```typescript
interface Character {
  id?: UUID; name: string; username?: string; system?: string;
  templates?: { [key: string]: TemplateType };
  bio: string | string[];
  messageExamples?: MessageExample[][];
  postExamples?: string[];
  topics?: string[]; adjectives?: string[];
  knowledge?: (string | { path: string; shared?: boolean } | DirectoryItem)[];
  plugins?: string[];
  settings?: CharacterSettings;
  secrets?: { [key: string]: string | boolean | number };
  style?: { all?: string[]; chat?: string[]; post?: string[] };
}

interface CharacterSettings {
  ENABLE_AUTONOMY?: boolean;
  DISABLE_BASIC_CAPABILITIES?: boolean;
  ENABLE_EXTENDED_CAPABILITIES?: boolean;
  ADVANCED_CAPABILITIES?: string[];
  secrets?: Record<string, string>;
}
```

### Memory (types/memory.ts)
```typescript
enum MemoryType { DOCUMENT, FRAGMENT, MESSAGE, DESCRIPTION, CUSTOM }
type MemoryScope = 'shared' | 'private' | 'room';

interface Memory {
  id?: UUID; createdAt?: string; embedding?: number[];
  metadata?: DocumentMetadata | FragmentMetadata | MessageMetadata | DescriptionMetadata | CustomMetadata;
  content: Content;
}
```

### Components (types/components.ts)
```typescript
interface Action {
  name: string; description: string; similes?: string[];
  examples?: ActionExample[][]; suppressInitialMessage?: boolean;
  relevanceKeywords?: string[];  // NEW alpha.109 — fast keyword-based filtering
  validate(runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean>;
  handler(runtime: IAgentRuntime, message: Memory, state?: State,
    options?: HandlerOptions, callback?: HandlerCallback): Promise<ActionResult>;
}

interface Provider {
  name: string; description?: string; dynamic?: boolean;
  position?: number; private?: boolean;
  get(runtime: IAgentRuntime, message: Memory, state?: State): Promise<ProviderResult>;
}

interface Evaluator {
  name: string; description: string; similes?: string[];
  alwaysRun?: boolean; examples?: EvaluatorExample[];
  validate(runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean>;
  handler(runtime: IAgentRuntime, message: Memory, state?: State): Promise<any>;
}

interface ActionResult { success: boolean; text?: string; error?: string;
  values?: Record<string, any>; data?: Record<string, any>; }

// HandlerCallback — note optional actionName (NEW alpha.109)
type HandlerCallback = (response: Content, actionName?: string) => Promise<Memory[]>;

interface HandlerOptions {
  actionContext?: { previousResults: ActionResult[]; currentStep: number; totalSteps: number; };
  actionPlan?: ActionPlan;
}
```

### Plugin (types/plugin.ts)
```typescript
interface Plugin {
  name: string; description?: string; priority?: number;
  dependencies?: string[]; testDependencies?: string[];
  init?(config: Record<string, string>, runtime: IAgentRuntime): Promise<void>;
  actions?: Action[]; providers?: Provider[]; evaluators?: Evaluator[];
  services?: ServiceClass[]; routes?: Route[]; events?: Record<string, Function[]>;
  tests?: TestSuite; config?: Record<string, any>; schema?: Record<string, any>;
  adapter?: AdapterFactory;  // BREAKING: was IDatabaseAdapter, now factory function
  models?: Record<string, ModelHandler[]>;
}

// NEW: AdapterFactory replaces direct adapter instance
type AdapterFactory = (agentId: UUID, settings: Record<string, string>) =>
  IDatabaseAdapter | Promise<IDatabaseAdapter>;

interface Project { agents: ProjectAgent[] }
interface ProjectAgent { character: Character; init?(runtime: IAgentRuntime): Promise<void>;
  plugins?: (string | Plugin)[]; tests?: TestSuite; }
```

### Events (types/events.ts)
```
World: WORLD_JOINED, WORLD_CONNECTED, WORLD_LEFT
Entity: ENTITY_JOINED, ENTITY_LEFT, ENTITY_UPDATED
Room: ROOM_JOINED, ROOM_LEFT
Message: MESSAGE_RECEIVED, MESSAGE_SENT, MESSAGE_DELETED
Channel: CHANNEL_CLEARED
Voice: VOICE_MESSAGE_RECEIVED, VOICE_MESSAGE_SENT
Interaction: REACTION_RECEIVED, POST_GENERATED, INTERACTION_RECEIVED
Run: RUN_STARTED, RUN_ENDED, RUN_TIMEOUT
Action: ACTION_STARTED, ACTION_COMPLETED
Evaluator: EVALUATOR_STARTED, EVALUATOR_COMPLETED
Model: MODEL_USED
Embedding: EMBEDDING_GENERATION_REQUESTED/COMPLETED/FAILED
Control: CONTROL_MESSAGE
Form: FORM_FIELD_CONFIRMED, FORM_FIELD_CANCELLED
Hook: HOOK_COMMAND_NEW/RESET/STOP, HOOK_SESSION_START/END,
      HOOK_AGENT_BASIC_CAPABILITIES/START/END, HOOK_GATEWAY_START/STOP,
      HOOK_COMPACTION_BEFORE/AFTER, HOOK_TOOL_BEFORE/AFTER/PERSIST,
      HOOK_MESSAGE_SENDING
```

### Models (types/model.ts)
```typescript
const ModelType = {
  TEXT_SMALL, TEXT_LARGE, TEXT_COMPLETION,
  TEXT_REASONING_SMALL, TEXT_REASONING_LARGE,
  TEXT_EMBEDDING, TEXT_TOKENIZER_ENCODE, TEXT_TOKENIZER_DECODE,
  IMAGE, IMAGE_DESCRIPTION, TRANSCRIPTION, TEXT_TO_SPEECH,
  AUDIO, VIDEO, OBJECT_SMALL, OBJECT_LARGE,
  RESEARCH,  // deep research with web/file/code/MCP tools
} as const;

type LLMMode = 'DEFAULT' | 'SMALL' | 'LARGE';
```

### Services (types/service.ts)
```typescript
abstract class Service {
  runtime!: IAgentRuntime;
  static serviceType: string;
  capabilityDescription?: string;
  static start(runtime: IAgentRuntime): Promise<Service>;
  stop?(): Promise<void>;
}

const ServiceType = {
  transcription, video, browser, pdf, aws_s3, web_search, email, tee,
  task, wallet, lp_pool, token_data, message_service, message, post,
  approval, tool_policy, hooks, pairing, agent_event, voice_cache, unknown
} as const;
```

ServiceBuilder fluent API:
```typescript
createService<T>(serviceType).withDescription(desc).withStart(fn).withStop(fn).build()
defineService({ serviceType, description, start, stop })  // declarative
```

### State (types/state.ts)
```typescript
interface State {
  values: { agentName: string; actionNames: string; providers: string; [key: string]: unknown };
  data: StateData;
  text: string;
}

interface StateData {
  room?: Room; world?: World; entity?: Entity;
  providers?: Record<string, Record<string, unknown>>;
  actionPlan?: ActionPlan;
  actionResults?: ActionResult[];
  workingMemory?: WorkingMemory;  // NEW: intermediate results without DB
  [key: string]: unknown;
}

type WorkingMemory = Record<string, WorkingMemoryEntry>;
interface WorkingMemoryEntry {
  result: ActionResult;
  timestamp: number;
}

interface ActionPlan {
  thought: string; totalSteps: number; currentStep: number;
  steps: ActionPlanStep[];
}
```

### Tasks (types/task.ts)
```typescript
interface TaskWorker {
  name: string;
  execute(runtime, options, task): Promise<undefined | { nextInterval?: number }>;
  shouldRun?(runtime, task): Promise<boolean>;       // NEW: scheduler gate
  canExecute?(runtime, message, state): Promise<boolean>;  // NEW: authorization gate
  validate?(message, state): Promise<boolean>;        // @deprecated — use shouldRun/canExecute
}

interface TaskMetadata {
  priority?: number; updateInterval?: number;
  scheduledAt?: string; completedAt?: string;
  baseInterval?: number; notBefore?: string; notAfter?: string;
  paused?: boolean; failureCount?: number; maxFailures?: number;
  lastError?: string; blocking?: boolean;
  trigger?: TriggerConfig; triggerRuns?: TriggerRunRecord[];
}

type TriggerType = 'interval' | 'once' | 'cron';
type TriggerWakeMode = 'inject_now' | 'next_autonomy_cycle';
interface TriggerConfig {
  type: TriggerType; interval?: number; cronExpression?: string;
  timezone?: string; wakeMode?: TriggerWakeMode; maxRuns?: number; dedupeKey?: string;
}
```

### Database (types/database.ts)
```typescript
// IDatabaseAdapter — batch-first redesign in alpha.109
// init() REMOVED — initialization is now implicit
// NEW: PatchOp for atomic JSONB field updates
type PatchOp = { op: 'set' | 'push' | 'remove' | 'increment'; path: string; value?: any };
```

### Runtime (types/runtime.ts)
```typescript
class AgentRuntime implements IAgentRuntime {
  agentId: UUID; character: Character;
  adapter: IDatabaseAdapter;  // REQUIRED in constructor (not registered post-construction)
  serverless?: boolean;       // NEW: TaskService no timer
  promptBatcher?: PromptBatcher;  // NEW: batch LLM dispatcher
  companionUrl?: string;      // NEW: companion runtime URL

  // Action filtering (NEW)
  getFilteredActions(context?): Action[];
  isActionAllowed(actionName, context?): { allowed: boolean; reason: string };

  // Structured LLM calls (NEW)
  dynamicPromptExecFromState(args): Promise<any>;

  // Security (NEW)
  redactSecrets(text): string;

  // Entity/Room helpers (NEW on runtime)
  getEntitiesForRoom(roomId, includeComponents?): Promise<Entity[]>;
  getParticipantsForRoom(roomId): Promise<Participant[]>;
  getRooms(worldId): Promise<Room[]>;

  // Agent CRUD (NEW on runtime)
  getAgent / createAgent / updateAgent / deleteAgent;
  getWorld / createWorld / deleteWorld;
  createTask / getTask / updateTask / deleteTask;

  // Component CRUD (NEW)
  getComponents / getComponent / createComponent / patchComponent /
  updateComponent / deleteComponent / upsertComponent / patchComponentField /
  getComponentsByType;

  // Pairing (NEW)
  createPairingRequest / updatePairingRequest / deletePairingRequest /
  createPairingAllowlistEntry / deletePairingAllowlistEntry;

  // Existing
  processActions, composeState, evaluate, ensureConnection;
  getService<T>, useModel<T>, registerModel, getModel;
  registerSendHandler, sendMessageToTarget;
  startRun, endRun, getCurrentRunId;
  registerEvent<T>, emitEvent<T>;
  getSetting, setSetting;
}
```

## New Features (alpha.20+)

### Working Memory (alpha.20+)
Intermediate action results stored in state without DB round-trips.

### Tool Policy System (alpha.70+)
```typescript
interface ToolPolicyConfig {
  allow?: string[]; alsoAllow?: string[]; deny?: string[];
  profile?: 'minimal' | 'coding' | 'messaging' | 'full';
}
runtime.getFilteredActions(context);
runtime.isActionAllowed('SWAP_TOKEN', context);
```

### Approval Service (alpha.50+)
```typescript
const approval = runtime.getService<ApprovalService>('approval');
const result = await approval.requestApproval({
  title: 'Execute swap?', options: STANDARD_OPTIONS.APPROVE_DENY,
  timeout: 60000, allowedRoles: ['OWNER'],
});
```

### Hook System (alpha.60+)
HookService with priority-ordered event hooks. Hook events listed in Events section above.

### Prompt Batcher (alpha.80+)
Batch LLM calls with schema-based output, caching, stale-while-revalidate.

### Plugin Store (alpha.85+)
```typescript
interface IPluginStore {
  query<T>(table, filters?, options?): Promise<T[]>;
  getById<T>(table, id): Promise<T | null>;
  insert(table, data): Promise<any>;
  update(table, id, data): Promise<any>;
  delete(table, id): Promise<void>;
  count(table, filters?): Promise<number>;
}
```

### Trigger System (alpha.55+)
cron/interval/once task triggers with history tracking. See Tasks section.

### Session Compaction (alpha.109)
compactSessionAction — LLM-summarizes conversation history.

### Pairing System (alpha.65+)
Structured DM sender verification across telegram, discord, whatsapp, signal, slack, etc.

### Runtime Composition API (alpha.80+)
```typescript
import { loadCharacters, createRuntimes, provisionAgent } from '@elizaos/core';
const runtimes = await createRuntimes(characters, { autoStart: true });
```

## Bootstrap Plugin — Capability Tiers

**Basic:** Core providers + REPLY/IGNORE/NONE + TaskService + EmbeddingGenerationService + TrajectoryLoggerService.

**Extended (ENABLE_EXTENDED_CAPABILITIES):** +knowledge, facts, contacts, relationships + addContact, choice, generateImage, sendMessage, etc. + reflection, relationshipExtraction + RolodexService, FollowUpService.

**Autonomy (ENABLE_AUTONOMY):** +adminChat, autonomyStatus + sendToAdmin + AutonomyService + autonomyRoutes.

## Breaking Changes from v1 to v2

1. Package restructuring (packages/core → packages/typescript)
2. CLI renamed: @elizaos/cli → elizaos package
3. Bootstrap integrated into core
4. Memory types: 7 → 5
5. Memory scope added (shared, private, room)
6. Protobuf base types
7. Entity component system
8. New events (embedding, form, channel, hook)
9. Server/Client packages removed as top-level
10. Plugins moved to root-level plugins/
11. ServiceBuilder fluent API
12. Multi-language SDKs (Python, Rust)

## Breaking Changes from alpha.2 to alpha.109

1. **Plugin.adapter**: Instance → AdapterFactory `(agentId, settings) => IDatabaseAdapter`
2. **registerDatabaseAdapter()**: REMOVED — adapter required in constructor
3. **IDatabaseAdapter.init()**: REMOVED — implicit
4. **HandlerCallback**: Now `(response, actionName?) => Promise<Memory[]>`
5. **TaskWorker.execute**: Returns `undefined | { nextInterval? }`
6. **TaskWorker.validate**: DEPRECATED — use shouldRun + canExecute
7. **PluginManifest**: REMOVED from exports
8. **Database adapter**: Batch-first redesign with PatchOp
9. **New ServiceTypes**: approval, tool_policy, hooks, pairing, agent_event, voice_cache
10. **Action.relevanceKeywords**: New field for fast filtering
