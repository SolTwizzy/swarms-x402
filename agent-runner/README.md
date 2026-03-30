# SwarmX Agent Runner

Local CLI agent runner that spawns AI agent sessions with plugins, hooks, and access to SwarmX endpoints.

## Quick Start

```bash
# Interactive session with Gemini (default)
GEMINI_API_KEY=your-key bun run agent-runner/cli.ts --interactive

# One-shot prompt with OpenAI
OPENAI_API_KEY=your-key bun run agent-runner/cli.ts -m openai -p "Analyze Solana DeFi protocols"

# Full plugin stack
bun run agent-runner/cli.ts -i --plugins swarmx-tools,file-system,web-search,session-notes
```

## Architecture

```
CLI (cli.ts)
  -> Runner (runner.ts)
    -> LLM (Gemini or OpenAI via raw fetch, native function calling)
    -> Plugins (provide tools, transform calls, observe messages)
    -> Hooks (observe session lifecycle events)
    -> Tools (SwarmX endpoints via HTTP, local files, web search)
    -> Session Storage (JSON files in sessions/)
```

### Agent Loop

1. Take user input (CLI arg or interactive prompt)
2. Send to LLM with system prompt + conversation history + available tools
3. If LLM returns a tool call: run `plugin.beforeTool` -> execute tool -> run `plugin.afterTool` -> feed result back to LLM
4. If LLM returns text: display to user -> run hooks
5. Repeat until done or max turns reached

## Plugins

### `swarmx-tools` (default)
Loads all SwarmX endpoints from `mcp-manifest.json` as callable tools. The agent can call any of the 30+ SwarmX endpoints (contract audit, token risk, research, code review, etc.) by name.

### `file-system`
Read/write/search local files within allowed directories. Enable with `--plugins file-system` and control access with `--allowed-paths ./my-project`.

### `web-search`
Search the web using SerpAPI (best), Gemini grounding (good), or DuckDuckGo (fallback). No API key required for basic search.

### `session-notes`
Auto-saves tool results to markdown and generates a session summary on exit. Files saved to the output directory alongside session JSON.

## Hooks

### `cost-tracker` (default)
Prints a running total of token usage and estimated LLM costs after each call.

### `auto-save` (default)
Saves session state every 5 messages and on exit, preventing data loss on crashes.

### `telegram-alerts`
Sends session start/end notifications to Telegram. Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` env vars.

## Interactive Commands

While in interactive mode:

| Command    | Description                     |
|------------|---------------------------------|
| `/save`    | Save session to disk            |
| `/session` | Show session ID, message count  |
| `/tools`   | List available tools            |
| `exit`     | End session and save            |

## Session Management

Sessions are saved as JSON in `agent-runner/sessions/`:

```bash
# Resume a previous session
bun run agent-runner/cli.ts --resume <session-id> --interactive

# Sessions include full conversation history, tool calls, and token usage
```

## Environment Variables

| Variable           | Required For      | Description                        |
|--------------------|-------------------|------------------------------------|
| `OPENAI_API_KEY`   | `--model openai`  | OpenAI API key                     |
| `GEMINI_API_KEY`   | `--model gemini`  | Google Gemini API key              |
| `OPENAI_MODEL`     | Optional          | Override model (default: gpt-4o-mini) |
| `GEMINI_MODEL`     | Optional          | Override model (default: gemini-2.0-flash) |
| `SERPAPI_KEY`      | Optional          | Better web search results          |
| `TELEGRAM_BOT_TOKEN` | telegram-alerts | Telegram bot token               |
| `TELEGRAM_CHAT_ID`   | telegram-alerts | Telegram chat ID                 |

## CLI Reference

```
bun run agent-runner/cli.ts [OPTIONS]

OPTIONS:
  -m, --model <model>          gemini | openai (default: gemini)
  -p, --prompt <text>          Run single prompt and exit
  -r, --resume <session-id>    Resume a saved session
  -i, --interactive            Interactive REPL mode
  --plugins <list>             Comma-separated (default: swarmx-tools,session-notes)
  --hooks <list>               Comma-separated (default: cost-tracker,auto-save)
  --base-url <url>             SwarmX platform URL
  --output-dir <dir>           Session storage directory
  --system-prompt <text>       Custom system prompt
  --max-turns <n>              Max tool loops per prompt (default: 20)
  --allowed-paths <paths>      Dirs for file-system plugin (default: .)
  -h, --help                   Show help
```

## File Structure

```
agent-runner/
  cli.ts              CLI entry point
  runner.ts           Core agent loop + LLM callers
  types.ts            Shared type definitions
  plugins/
    swarmx-tools.ts   SwarmX endpoint tools
    file-system.ts    Local file operations
    web-search.ts     Web search (SerpAPI/Gemini/DDG)
    session-notes.ts  Auto-save research notes
    index.ts          Re-exports
  hooks/
    telegram-alerts.ts  Telegram notifications
    cost-tracker.ts     Token/cost tracking
    auto-save.ts        Periodic session saves
    index.ts            Re-exports
  sessions/            Session storage (gitignored)
  README.md            This file
```
