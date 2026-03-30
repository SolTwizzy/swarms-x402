/**
 * SwarmX Agent Runner — Core Agent Loop
 *
 * Spawns an LLM-powered agent session that can call SwarmX endpoints
 * and local tools via plugins. Supports Gemini and OpenAI as reasoning
 * LLMs with native function calling.
 *
 * The loop:
 * 1. Take user input
 * 2. Send to LLM with system prompt + history + tools
 * 3. If tool call -> run plugins.beforeTool -> execute -> plugins.afterTool -> feed back
 * 4. If text -> display -> run hooks
 * 5. Repeat until done or max turns
 *
 * @module
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type {
  AgentSession,
  Hook,
  HookContext,
  HookEvent,
  LLMResponse,
  LLMToolCall,
  Message,
  ModelProvider,
  Plugin,
  RunnerConfig,
  ToolDefinition,
  ToolResult,
} from "./types";

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are a SwarmX AI agent — an expert assistant with access to SwarmX platform tools for crypto analysis, code review, research, content generation, DeFi, and trading data.

When a user asks a question, determine if any of your available tools can help answer it. Use tools when they add value — don't call tools unnecessarily for simple questions you can answer directly.

When using tools:
- Pick the most appropriate tool for the task
- Provide all required parameters
- Summarize tool results in a clear, actionable way

Be concise and direct. Focus on delivering value.`;

const DEFAULT_MAX_TURNS = 20;

// ── LLM Callers ─────────────────────────────────────────────────────────

/**
 * Call OpenAI chat completions with function calling.
 */
async function callOpenAI(
  messages: Array<{ role: string; content: string; tool_call_id?: string; name?: string }>,
  tools: ToolDefinition[],
  systemPrompt: string
): Promise<LLMResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const openaiTools = tools.length > 0
    ? tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    : undefined;

  const apiMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      messages: apiMessages,
      tools: openaiTools,
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          function: { name: string; arguments: string };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = data.choices?.[0]?.message;
  const usage = data.usage;

  if (choice?.tool_calls && choice.tool_calls.length > 0) {
    const tc = choice.tool_calls[0];
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      args = {};
    }
    return {
      toolCall: { name: tc.function.name, args },
      text: choice.content ?? undefined,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
    };
  }

  return {
    text: choice?.content ?? "",
    inputTokens: usage?.prompt_tokens,
    outputTokens: usage?.completion_tokens,
  };
}

/**
 * Call Google Gemini with function calling.
 */
async function callGemini(
  messages: Array<{ role: string; content: string }>,
  tools: ToolDefinition[],
  systemPrompt: string
): Promise<LLMResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

  // Convert messages to Gemini format
  const geminiContents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  // Convert tools to Gemini function declarations
  const functionDeclarations = tools.length > 0
    ? tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: "OBJECT" as const,
          properties: Object.fromEntries(
            Object.entries(t.parameters.properties).map(([k, v]) => [
              k,
              {
                type: v.type.toUpperCase(),
                description: v.description,
                ...(v.enum ? { enum: v.enum } : {}),
                ...(v.type === "array" ? { items: (v as any).items ?? { type: "STRING" } } : {}),
              },
            ])
          ),
          required: t.parameters.required,
        },
      }))
    : [];

  const body: Record<string, unknown> = {
    contents: geminiContents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 4096,
    },
  };

  if (functionDeclarations.length > 0) {
    body.tools = [{ functionDeclarations }];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          functionCall?: { name: string; args: Record<string, unknown> };
        }>;
      };
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  const parts = data.candidates?.[0]?.content?.parts;
  const usage = data.usageMetadata;

  if (parts) {
    for (const part of parts) {
      if (part.functionCall) {
        return {
          toolCall: {
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
          },
          inputTokens: usage?.promptTokenCount,
          outputTokens: usage?.candidatesTokenCount,
        };
      }
    }

    const textParts = parts.filter((p) => p.text).map((p) => p.text!);
    return {
      text: textParts.join("\n"),
      inputTokens: usage?.promptTokenCount,
      outputTokens: usage?.candidatesTokenCount,
    };
  }

  return { text: "" };
}

// ── Agent Runner ────────────────────────────────────────────────────────

export class AgentRunner {
  private session: AgentSession;
  private plugins: Plugin[];
  private hooks: Hook[];
  private outputDir: string;
  private maxTurns: number;

  constructor(config: RunnerConfig) {
    this.plugins = config.plugins ?? [];
    this.hooks = config.hooks ?? [];
    this.outputDir = config.outputDir ?? "./agent-runner/sessions";
    this.maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;

    // Collect tools from all plugins
    const allTools: ToolDefinition[] = [];
    for (const plugin of this.plugins) {
      if (plugin.getTools) {
        allTools.push(...plugin.getTools());
      }
    }

    this.session = {
      id: randomUUID(),
      model: config.model,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      messages: [],
      tools: allTools,
      pluginNames: this.plugins.map((p) => p.name),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    // Ensure output directory exists
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /** Get the current session. */
  getSession(): AgentSession {
    return this.session;
  }

  /** Resume a session from a saved JSON file. */
  static resume(sessionPath: string, config: Omit<RunnerConfig, "model" | "systemPrompt">): AgentRunner {
    const data = JSON.parse(readFileSync(sessionPath, "utf-8")) as AgentSession;
    const runner = new AgentRunner({
      model: data.model,
      systemPrompt: data.systemPrompt,
      ...config,
    });
    runner.session = data;
    // Re-collect tools from plugins (not serialized)
    const allTools: ToolDefinition[] = [];
    for (const plugin of runner.plugins) {
      if (plugin.getTools) {
        allTools.push(...plugin.getTools());
      }
    }
    runner.session.tools = allTools;
    return runner;
  }

  /** Save session to disk. */
  save(): string {
    const filePath = join(this.outputDir, `${this.session.id}.json`);
    writeFileSync(filePath, JSON.stringify(this.session, null, 2), "utf-8");
    return filePath;
  }

  /** Fire hooks for an event. */
  private async fireHooks(event: HookEvent, extra: Partial<HookContext> = {}): Promise<void> {
    const ctx: HookContext = {
      session: this.session,
      event,
      ...extra,
    };
    for (const hook of this.hooks) {
      if (hook.event === event) {
        try {
          await hook.handler(ctx);
        } catch (err) {
          console.error(`[hook:${event}] Error:`, err);
        }
      }
    }
  }

  /** Execute a tool call through plugins. */
  private async executeTool(toolCall: LLMToolCall): Promise<ToolResult> {
    let args = toolCall.args;

    // Run beforeTool plugins
    for (const plugin of this.plugins) {
      if (plugin.beforeTool) {
        const result = plugin.beforeTool(toolCall.name, args);
        if (result === null) {
          return { success: false, error: `Blocked by plugin: ${plugin.name}` };
        }
        args = result;
      }
    }

    await this.fireHooks("tool:before", { toolName: toolCall.name, toolArgs: args });

    // Find a plugin that can execute this tool
    let result: ToolResult | undefined;
    for (const plugin of this.plugins) {
      if (plugin.executeTool) {
        result = await plugin.executeTool(toolCall.name, args);
        if (result !== undefined) break;
      }
    }

    if (!result) {
      result = { success: false, error: `No plugin can execute tool: ${toolCall.name}` };
    }

    // Run afterTool plugins
    let transformedData = result.data;
    for (const plugin of this.plugins) {
      if (plugin.afterTool) {
        transformedData = plugin.afterTool(toolCall.name, transformedData);
      }
    }
    result = { ...result, data: transformedData };

    await this.fireHooks("tool:after", {
      toolName: toolCall.name,
      toolArgs: args,
      toolResult: result.data ?? result.error,
    });

    return result;
  }

  /** Call the LLM with the current conversation. */
  private async callLLM(): Promise<LLMResponse> {
    const msgs = this.session.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    if (this.session.model === "gemini") {
      return callGemini(msgs, this.session.tools, this.session.systemPrompt);
    }
    return callOpenAI(msgs, this.session.tools, this.session.systemPrompt);
  }

  /** Add a message and notify plugins/hooks. */
  private addMessage(msg: Message): void {
    this.session.messages.push(msg);
    this.session.updatedAt = new Date().toISOString();

    for (const plugin of this.plugins) {
      if (plugin.onMessage) {
        try {
          plugin.onMessage(msg);
        } catch {
          // ignore plugin errors
        }
      }
    }
  }

  /**
   * Run a single user prompt through the agent loop.
   *
   * Returns the final assistant text response. Handles tool call loops
   * internally — the LLM may call multiple tools before returning text.
   */
  async run(userInput: string): Promise<string> {
    // Add user message
    const userMsg: Message = {
      role: "user",
      content: userInput,
      timestamp: new Date().toISOString(),
    };
    this.addMessage(userMsg);
    await this.fireHooks("message:user", { message: userMsg });

    let turns = 0;
    let lastToolName = "";
    let sameToolCount = 0;

    while (turns < this.maxTurns) {
      turns++;

      const llmResponse = await this.callLLM();

      // Track token usage in metadata
      if (llmResponse.inputTokens || llmResponse.outputTokens) {
        const prev = (this.session.metadata.totalTokens as { input: number; output: number } | undefined) ?? {
          input: 0,
          output: 0,
        };
        this.session.metadata.totalTokens = {
          input: prev.input + (llmResponse.inputTokens ?? 0),
          output: prev.output + (llmResponse.outputTokens ?? 0),
        };
      }

      // If tool call, execute and loop (with loop detection)
      if (llmResponse.toolCall) {
        if (llmResponse.toolCall.name === lastToolName) {
          sameToolCount++;
          if (sameToolCount >= 3) {
            const loopMsg: Message = {
              role: "assistant",
              content: `[Tool "${lastToolName}" called ${sameToolCount} times in a row — stopping to avoid loop. The tool may require x402 payment. Use --wallet-key to enable auto-pay.]`,
              timestamp: new Date().toISOString(),
            };
            this.addMessage(loopMsg);
            return loopMsg.content;
          }
        } else {
          lastToolName = llmResponse.toolCall.name;
          sameToolCount = 1;
        }
        // If there's also text, add it as assistant message
        if (llmResponse.text) {
          const textMsg: Message = {
            role: "assistant",
            content: llmResponse.text,
            timestamp: new Date().toISOString(),
          };
          this.addMessage(textMsg);
        }

        const toolResult = await this.executeTool(llmResponse.toolCall);
        const resultContent = toolResult.success
          ? JSON.stringify(toolResult.data, null, 2)
          : `Error: ${toolResult.error}`;

        const toolMsg: Message = {
          role: "tool",
          content: resultContent,
          toolCall: {
            name: llmResponse.toolCall.name,
            args: llmResponse.toolCall.args,
            result: toolResult.data ?? toolResult.error,
          },
          timestamp: new Date().toISOString(),
        };
        this.addMessage(toolMsg);
        continue;
      }

      // Text response — we're done
      const assistantText = llmResponse.text ?? "";
      const assistantMsg: Message = {
        role: "assistant",
        content: assistantText,
        timestamp: new Date().toISOString(),
      };
      this.addMessage(assistantMsg);
      await this.fireHooks("message:assistant", { message: assistantMsg });

      return assistantText;
    }

    return "[Max turns reached — stopping agent loop]";
  }

  /** Start the session (fires session:start hooks). */
  async start(): Promise<void> {
    await this.fireHooks("session:start");
    console.log(`[SwarmX Agent] Session ${this.session.id} started`);
    console.log(`[SwarmX Agent] Model: ${this.session.model}`);
    console.log(`[SwarmX Agent] Tools: ${this.session.tools.length}`);
    console.log(`[SwarmX Agent] Plugins: ${this.session.pluginNames.join(", ") || "none"}`);
  }

  /** End the session (fires session:end hooks, saves). */
  async end(): Promise<string> {
    await this.fireHooks("session:end");
    const path = this.save();
    console.log(`[SwarmX Agent] Session saved to ${path}`);
    return path;
  }

  /**
   * Run an interactive REPL session.
   * Reads from stdin, sends to agent, prints responses.
   */
  async interactive(): Promise<void> {
    await this.start();
    console.log("[SwarmX Agent] Interactive mode. Type 'exit' or 'quit' to stop.\n");

    const readline = await import("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = (): Promise<string> =>
      new Promise((resolve) => {
        rl.question("\x1b[36myou>\x1b[0m ", (answer: string) => resolve(answer));
      });

    try {
      while (true) {
        const input = await prompt();
        const trimmed = input.trim();

        if (!trimmed) continue;
        if (trimmed === "exit" || trimmed === "quit") break;

        if (trimmed === "/save") {
          const p = this.save();
          console.log(`Session saved: ${p}`);
          continue;
        }

        if (trimmed === "/session") {
          console.log(`ID: ${this.session.id}`);
          console.log(`Messages: ${this.session.messages.length}`);
          console.log(`Tokens: ${JSON.stringify(this.session.metadata.totalTokens ?? { input: 0, output: 0 })}`);
          continue;
        }

        if (trimmed === "/tools") {
          for (const t of this.session.tools) {
            console.log(`  ${t.name} — ${t.description.slice(0, 80)}...`);
          }
          continue;
        }

        try {
          console.log();
          const response = await this.run(trimmed);
          console.log(`\n\x1b[33magent>\x1b[0m ${response}\n`);
        } catch (err) {
          console.error(`\n\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    } finally {
      rl.close();
      await this.end();
    }
  }
}
