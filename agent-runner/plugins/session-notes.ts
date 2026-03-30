/**
 * Session Notes Plugin
 *
 * Automatically saves tool results to markdown notes and generates
 * a session summary when the session ends.
 *
 * @module
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type { Plugin, Message } from "../types";

interface SessionNotesConfig {
  /** Directory to save notes. Default: ./agent-runner/sessions */
  outputDir: string;
}

export function sessionNotesPlugin(config: SessionNotesConfig): Plugin {
  const notes: string[] = [];
  const toolResults: Array<{ tool: string; timestamp: string; summary: string }> = [];
  let sessionId = "unknown";

  function ensureDir(): void {
    if (!existsSync(config.outputDir)) {
      mkdirSync(config.outputDir, { recursive: true });
    }
  }

  function saveNotes(): void {
    ensureDir();
    const filePath = join(config.outputDir, `${sessionId}-notes.md`);
    const content = [
      `# Session Notes: ${sessionId}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "## Tool Results",
      "",
      ...toolResults.map(
        (r) => `### ${r.tool} (${r.timestamp})\n${r.summary}\n`
      ),
      "## Key Findings",
      "",
      ...notes.map((n) => `- ${n}`),
      "",
    ].join("\n");

    writeFileSync(filePath, content, "utf-8");
    console.log(`  [session-notes] Notes saved: ${filePath}`);
  }

  return {
    name: "session-notes",
    description: "Auto-saves tool results and key findings to markdown",

    afterTool(toolName: string, result: unknown): unknown {
      const timestamp = new Date().toISOString().slice(0, 19);
      let summary: string;

      if (typeof result === "string") {
        summary = result.slice(0, 500);
      } else if (result && typeof result === "object") {
        summary = JSON.stringify(result, null, 2).slice(0, 500);
      } else {
        summary = String(result);
      }

      toolResults.push({ tool: toolName, timestamp, summary });

      // Append incrementally to a log file
      ensureDir();
      const logPath = join(config.outputDir, `${sessionId}-log.md`);
      appendFileSync(
        logPath,
        `\n### ${toolName} — ${timestamp}\n\`\`\`json\n${summary}\n\`\`\`\n`,
        "utf-8"
      );

      return result;
    },

    onMessage(message: Message): void {
      // Track session ID from first message
      if (message.role === "user" && notes.length === 0) {
        notes.push(`Initial query: "${message.content.slice(0, 100)}"`);
      }

      // Extract key findings from assistant messages
      if (message.role === "assistant" && message.content.length > 50) {
        // Simple heuristic: first sentence of substantive responses
        const firstSentence = message.content.split(/[.!?]\s/)[0];
        if (firstSentence && firstSentence.length > 20 && firstSentence.length < 200) {
          notes.push(firstSentence);
        }
      }
    },

    /**
     * Hook into session lifecycle.
     * This plugin also acts as pseudo-hook by checking message patterns.
     * The real hook integration happens via the runner's hook system.
     */
    beforeTool(_toolName: string, args: Record<string, unknown>): Record<string, unknown> {
      return args; // passthrough
    },
  };

  // Note: The actual session:end hook that calls saveNotes() is registered
  // separately in the hooks/auto-save.ts or by the CLI. The plugin exposes
  // saveNotes via a closure the CLI can call.
}

/**
 * Create a session notes hook that saves on session end.
 * Call this alongside the plugin for full integration.
 */
export function sessionNotesHooks(config: SessionNotesConfig): Array<{ event: "session:end"; handler: (ctx: { session: { id: string; messages: Message[] } }) => void }> {
  return [
    {
      event: "session:end" as const,
      handler: (ctx) => {
        const sessionId = ctx.session.id;
        const outputDir = config.outputDir;

        if (!existsSync(outputDir)) {
          mkdirSync(outputDir, { recursive: true });
        }

        // Generate summary
        const messageCount = ctx.session.messages.length;
        const toolCalls = ctx.session.messages.filter((m) => m.toolCall).length;
        const summary = [
          `# Session Summary: ${sessionId}`,
          `Completed: ${new Date().toISOString()}`,
          `Messages: ${messageCount}`,
          `Tool Calls: ${toolCalls}`,
          "",
          "## Conversation",
          "",
          ...ctx.session.messages.map((m) => {
            if (m.role === "user") return `**User:** ${m.content.slice(0, 200)}`;
            if (m.role === "assistant") return `**Agent:** ${m.content.slice(0, 200)}`;
            if (m.toolCall) return `**Tool (${m.toolCall.name}):** ${m.content.slice(0, 150)}`;
            return `**${m.role}:** ${m.content.slice(0, 150)}`;
          }),
          "",
        ].join("\n");

        const filePath = join(outputDir, `${sessionId}-summary.md`);
        writeFileSync(filePath, summary, "utf-8");
        console.log(`  [session-notes] Summary saved: ${filePath}`);
      },
    },
  ];
}
