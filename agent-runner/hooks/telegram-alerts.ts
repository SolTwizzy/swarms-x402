/**
 * Telegram Alerts Hook
 *
 * Sends session events (start, end, errors) to a Telegram chat
 * via the Bot API. Useful for monitoring long-running agent sessions.
 *
 * @module
 */

import type { Hook, HookContext } from "../types";

interface TelegramAlertConfig {
  /** Telegram bot token (from @BotFather). */
  botToken: string;
  /** Chat ID to send messages to. */
  chatId: string;
}

async function sendTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error(`[telegram-alerts] Failed to send: ${err}`);
  }
}

export function telegramAlertHooks(config: TelegramAlertConfig): Hook[] {
  const { botToken, chatId } = config;

  return [
    {
      event: "session:start",
      handler: async (ctx: HookContext) => {
        await sendTelegram(
          botToken,
          chatId,
          `*SwarmX Agent Started*\nSession: \`${ctx.session.id}\`\nModel: ${ctx.session.model}\nTools: ${ctx.session.tools.length}\nPlugins: ${ctx.session.pluginNames.join(", ") || "none"}`
        );
      },
    },
    {
      event: "session:end",
      handler: async (ctx: HookContext) => {
        const msgs = ctx.session.messages.length;
        const toolCalls = ctx.session.messages.filter((m) => m.toolCall).length;
        const tokens = ctx.session.metadata.totalTokens as
          | { input: number; output: number }
          | undefined;

        await sendTelegram(
          botToken,
          chatId,
          `*SwarmX Agent Ended*\nSession: \`${ctx.session.id}\`\nMessages: ${msgs}\nTool calls: ${toolCalls}${
            tokens ? `\nTokens: ${tokens.input + tokens.output}` : ""
          }`
        );
      },
    },
  ];
}
