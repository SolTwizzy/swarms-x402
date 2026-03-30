/**
 * Auto-Save Hook
 *
 * Periodically saves the session state to disk so progress
 * is not lost if the process crashes.
 *
 * @module
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { Hook, HookContext } from "../types";

interface AutoSaveConfig {
  /** Save every N messages. Default: 5 */
  interval: number;
  /** Directory for session files. */
  outputDir: string;
}

export function autoSaveHooks(config: AutoSaveConfig): Hook[] {
  const interval = config.interval ?? 5;
  let messageCount = 0;

  function saveSession(ctx: HookContext): void {
    if (!existsSync(config.outputDir)) {
      mkdirSync(config.outputDir, { recursive: true });
    }
    const filePath = join(config.outputDir, `${ctx.session.id}.json`);
    writeFileSync(filePath, JSON.stringify(ctx.session, null, 2), "utf-8");
  }

  return [
    {
      event: "message:assistant",
      handler: (ctx: HookContext) => {
        messageCount++;
        if (messageCount % interval === 0) {
          saveSession(ctx);
          console.log(`  [auto-save] Session saved (${messageCount} messages)`);
        }
      },
    },
    {
      event: "message:user",
      handler: () => {
        messageCount++;
      },
    },
    {
      event: "session:end",
      handler: (ctx: HookContext) => {
        saveSession(ctx);
      },
    },
  ];
}
