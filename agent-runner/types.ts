/**
 * SwarmX Agent Runner — Shared Types
 *
 * All type definitions for the agent runner: sessions, messages,
 * tools, plugins, hooks, and LLM provider interfaces.
 *
 * @module
 */

// ── Tool Definitions ────────────────────────────────────────────────────

/** JSON Schema property for a tool parameter. */
export interface ToolSchemaProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
  minimum?: number;
  maximum?: number;
}

/** A callable tool the agent can use. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolSchemaProperty>;
    required: string[];
  };
}

/** Result of executing a tool. */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ── Messages ────────────────────────────────────────────────────────────

/** A tool call embedded in a message. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
}

/** A single message in the conversation. */
export interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCall?: ToolCall;
  timestamp: string;
}

// ── Plugins ─────────────────────────────────────────────────────────────

/**
 * Plugins can transform tool calls, observe messages, and provide tools.
 *
 * - `beforeTool`: Runs before a tool call. Return transformed args, or null to block the call.
 * - `afterTool`: Runs after a tool call. Return transformed result.
 * - `onMessage`: Observe each message (user, assistant, or tool).
 * - `getTools`: Provide additional tools the agent can call.
 * - `executeTool`: Execute a tool by name. Return undefined if not handled.
 */
export interface Plugin {
  name: string;
  description: string;
  beforeTool?: (toolName: string, args: Record<string, unknown>) => Record<string, unknown> | null;
  afterTool?: (toolName: string, result: unknown) => unknown;
  onMessage?: (message: Message) => void;
  getTools?: () => ToolDefinition[];
  executeTool?: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult | undefined>;
}

// ── Hooks ───────────────────────────────────────────────────────────────

/** Events that hooks can listen to. */
export type HookEvent =
  | "session:start"
  | "session:end"
  | "tool:before"
  | "tool:after"
  | "message:user"
  | "message:assistant";

/** Context passed to hook handlers. */
export interface HookContext {
  session: AgentSession;
  event: HookEvent;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  message?: Message;
}

/** A hook that reacts to session events. */
export interface Hook {
  event: HookEvent;
  handler: (context: HookContext) => void | Promise<void>;
}

// ── Sessions ────────────────────────────────────────────────────────────

/** LLM model provider. */
export type ModelProvider = "gemini" | "openai";

/** Full agent session state, serializable to JSON. */
export interface AgentSession {
  id: string;
  model: ModelProvider;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  pluginNames: string[];
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

// ── LLM Types ───────────────────────────────────────────────────────────

/** A tool call returned by an LLM. */
export interface LLMToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** An LLM response: either text or a tool call. */
export interface LLMResponse {
  text?: string;
  toolCall?: LLMToolCall;
  inputTokens?: number;
  outputTokens?: number;
}

// ── Runner Config ───────────────────────────────────────────────────────

/** Configuration for creating an agent runner. */
export interface RunnerConfig {
  model: ModelProvider;
  systemPrompt?: string;
  plugins?: Plugin[];
  hooks?: Hook[];
  baseUrl?: string;
  outputDir?: string;
  maxTurns?: number;
}
