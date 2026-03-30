#!/usr/bin/env bun
/**
 * SwarmX Agent Runner — CLI Entry Point
 *
 * Usage:
 *   bun run agent-runner/cli.ts --interactive
 *   bun run agent-runner/cli.ts --prompt "Research the top DeFi protocols on Solana"
 *   bun run agent-runner/cli.ts --resume <session-id>
 *   bun run agent-runner/cli.ts --model openai --plugins swarmx-tools,file-system,web-search
 *
 * Environment variables:
 *   OPENAI_API_KEY     — Required for OpenAI model
 *   GEMINI_API_KEY     — Required for Gemini model
 *   OPENAI_MODEL       — Override OpenAI model (default: gpt-4o-mini)
 *   GEMINI_MODEL       — Override Gemini model (default: gemini-2.0-flash)
 *   SERPAPI_KEY         — Optional, for web search plugin
 *   TELEGRAM_BOT_TOKEN — Optional, for Telegram alerts hook
 *   TELEGRAM_CHAT_ID   — Optional, for Telegram alerts hook
 *
 * @module
 */

import { parseArgs } from "util";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { AgentRunner } from "./runner";
import { swarmxToolsPlugin } from "./plugins/swarmx-tools";
import { fileSystemPlugin } from "./plugins/file-system";
import { webSearchPlugin } from "./plugins/web-search";
import { sessionNotesPlugin, sessionNotesHooks } from "./plugins/session-notes";
import { telegramAlertHooks } from "./hooks/telegram-alerts";
import { costTrackerHooks } from "./hooks/cost-tracker";
import { autoSaveHooks } from "./hooks/auto-save";
import type { Plugin, Hook, ModelProvider } from "./types";

// ── Parse CLI args ──────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    model: { type: "string", short: "m", default: "gemini" },
    prompt: { type: "string", short: "p" },
    resume: { type: "string", short: "r" },
    interactive: { type: "boolean", short: "i", default: false },
    plugins: { type: "string", default: "swarmx-tools,session-notes" },
    hooks: { type: "string", default: "cost-tracker,auto-save" },
    "base-url": { type: "string", default: "https://x402-swarms-production.up.railway.app" },
    "output-dir": { type: "string", default: "./agent-runner/sessions" },
    "system-prompt": { type: "string" },
    "max-turns": { type: "string", default: "20" },
    "allowed-paths": { type: "string", default: "." },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

// ── Help ────────────────────────────────────────────────────────────────

if (values.help) {
  console.log(`
SwarmX Agent Runner — Local CLI for AI agent sessions

USAGE:
  bun run agent-runner/cli.ts [OPTIONS]

OPTIONS:
  -m, --model <model>          LLM provider: gemini | openai (default: gemini)
  -p, --prompt <text>          Run a single prompt and exit
  -r, --resume <session-id>    Resume a saved session
  -i, --interactive            Start interactive REPL mode
  --plugins <list>             Comma-separated plugins (default: swarmx-tools,session-notes)
                               Available: swarmx-tools, file-system, web-search, session-notes
  --hooks <list>               Comma-separated hooks (default: cost-tracker,auto-save)
                               Available: cost-tracker, auto-save, telegram-alerts
  --base-url <url>             SwarmX platform URL
  --output-dir <dir>           Session storage directory
  --system-prompt <text>       Custom system prompt
  --max-turns <n>              Max tool call loops per prompt (default: 20)
  --allowed-paths <paths>      Comma-separated dirs for file-system plugin (default: .)
  -h, --help                   Show this help

EXAMPLES:
  # Interactive with Gemini + SwarmX tools
  bun run agent-runner/cli.ts --interactive

  # One-shot research with OpenAI
  bun run agent-runner/cli.ts -m openai -p "Analyze the top 5 Solana DeFi protocols"

  # Resume a previous session
  bun run agent-runner/cli.ts --resume abc123-def456 --interactive

  # Full plugin stack
  bun run agent-runner/cli.ts -i --plugins swarmx-tools,file-system,web-search,session-notes

ENVIRONMENT:
  OPENAI_API_KEY      Required for --model openai
  GEMINI_API_KEY      Required for --model gemini
  SERPAPI_KEY          Optional: better web search results
  TELEGRAM_BOT_TOKEN  Optional: Telegram session alerts
  TELEGRAM_CHAT_ID    Optional: Telegram session alerts
`);
  process.exit(0);
}

// ── Validate ────────────────────────────────────────────────────────────

const model = (values.model as ModelProvider) ?? "gemini";
if (model !== "gemini" && model !== "openai") {
  console.error(`Error: --model must be "gemini" or "openai", got "${model}"`);
  process.exit(1);
}

if (model === "openai" && !process.env.OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is required for --model openai");
  process.exit(1);
}
if (model === "gemini" && !process.env.GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY is required for --model gemini");
  process.exit(1);
}

if (!values.prompt && !values.interactive && !values.resume) {
  console.error("Error: Provide --prompt, --interactive, or --resume. Use --help for usage.");
  process.exit(1);
}

// ── Build plugins ───────────────────────────────────────────────────────

const baseUrl = values["base-url"]!;
const outputDir = values["output-dir"]!;
const allowedPaths = (values["allowed-paths"] ?? ".").split(",").map((p) => resolve(p.trim()));

const pluginNames = (values.plugins ?? "").split(",").filter(Boolean);
const plugins: Plugin[] = [];

for (const name of pluginNames) {
  switch (name.trim()) {
    case "swarmx-tools":
      plugins.push(swarmxToolsPlugin({ baseUrl }));
      break;
    case "file-system":
      plugins.push(fileSystemPlugin({ allowedPaths }));
      break;
    case "web-search":
      plugins.push(webSearchPlugin());
      break;
    case "session-notes":
      plugins.push(sessionNotesPlugin({ outputDir }));
      break;
    default:
      console.warn(`Warning: Unknown plugin "${name}", skipping`);
  }
}

// ── Build hooks ─────────────────────────────────────────────────────────

const hookNames = (values.hooks ?? "").split(",").filter(Boolean);
const hooks: Hook[] = [];

for (const name of hookNames) {
  switch (name.trim()) {
    case "cost-tracker":
      hooks.push(...costTrackerHooks());
      break;
    case "auto-save":
      hooks.push(...autoSaveHooks({ interval: 5, outputDir }));
      break;
    case "telegram-alerts": {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (botToken && chatId) {
        hooks.push(...telegramAlertHooks({ botToken, chatId }));
      } else {
        console.warn("Warning: telegram-alerts requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
      }
      break;
    }
    default:
      console.warn(`Warning: Unknown hook "${name}", skipping`);
  }
}

// Add session-notes hooks if the plugin is active
if (pluginNames.includes("session-notes")) {
  hooks.push(...sessionNotesHooks({ outputDir }));
}

// ── Create or resume runner ─────────────────────────────────────────────

let runner: AgentRunner;

if (values.resume) {
  const sessionId = values.resume;
  const sessionPath = join(outputDir, `${sessionId}.json`);
  if (!existsSync(sessionPath)) {
    console.error(`Error: Session file not found: ${sessionPath}`);
    process.exit(1);
  }
  runner = AgentRunner.resume(sessionPath, { plugins, hooks, outputDir, maxTurns: parseInt(values["max-turns"] ?? "20") });
  console.log(`[SwarmX Agent] Resumed session: ${sessionId}`);
} else {
  runner = new AgentRunner({
    model,
    systemPrompt: values["system-prompt"],
    plugins,
    hooks,
    outputDir,
    maxTurns: parseInt(values["max-turns"] ?? "20"),
    baseUrl,
  });
}

// ── Run ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (values.interactive || values.resume) {
    await runner.interactive();
  } else if (values.prompt) {
    await runner.start();
    console.log();
    const response = await runner.run(values.prompt);
    console.log(`\n${response}\n`);
    await runner.end();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
