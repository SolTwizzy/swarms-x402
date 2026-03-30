/**
 * XMonitor — matches X/Twitter posts against reply templates and
 * generates draft replies for human review.
 */

export interface XPost {
  id: string;
  author: string;
  text: string;
  url?: string;
}

export interface ReplyDraft {
  postId: string;
  postAuthor: string;
  postText: string;
  category: ReplyCategory;
  reply: string;
}

export type ReplyCategory =
  | "x402_mention"
  | "competitor_mention"
  | "agent_payments"
  | "swarms_ecosystem"
  | "unknown";

export interface XMonitorConfig {
  searchTerms?: string[];
  telegramBotToken?: string;
  telegramChatId?: string;
}

const DEFAULT_SEARCH_TERMS = [
  "x402 payment",
  "agent micropayments",
  "CrewAI pricing",
  "multi-agent framework x402",
  "swarms AI monetize",
];

/** Keyword patterns for categorization (case-insensitive). */
const CATEGORY_PATTERNS: Array<{ category: ReplyCategory; pattern: RegExp }> = [
  {
    category: "x402_mention",
    pattern: /\bx402\b/i,
  },
  {
    category: "competitor_mention",
    pattern: /\b(crewai|autogen|langgraph|langchain agents?|chatdev)\b/i,
  },
  {
    category: "agent_payments",
    pattern: /\bagent\s+(?:payments?|micropayments?|monetiz\w*|pay[- ]per[- ]call)\b/i,
  },
  {
    category: "swarms_ecosystem",
    pattern: /\b(swarms?\s+(?:ai|framework|orchestrat|multi[- ]agent))\b/i,
  },
];

/** Reply templates per category. */
const REPLY_TEMPLATES: Record<Exclude<ReplyCategory, "unknown">, string[]> = {
  x402_mention: [
    "We built SwarmX on x402 -- 15+ multi-agent swarm architectures, pay-per-call with USDC, no accounts needed. Live on mainnet today.\n\nhttps://api.swarmx.io",
    "x402 is the rails. SwarmX is the product. AI agent teams you pay for with a single USDC transaction.\n\nhttps://api.swarmx.io",
  ],
  competitor_mention: [
    "Worth checking out SwarmX -- same multi-agent orchestration, but pay-per-call with USDC instead of subscriptions. $0.01/call vs $0.50/execution.\n\nhttps://api.swarmx.io",
    "We moved from subscriptions to x402 micropayments. 50x cheaper than CrewAI, no account needed, same swarm architectures.\n\nhttps://api.swarmx.io",
  ],
  agent_payments: [
    "This is exactly what we built SwarmX for. x402 lets AI agents pay for other AI agents -- USDC micropayments, no accounts, automatic 402 -> pay -> retry.\n\nhttps://api.swarmx.io",
    "SwarmX solves this. Expose any agent team as an HTTP endpoint, price it in USDC, let other agents pay per call via x402. Live today.\n\nhttps://api.swarmx.io",
  ],
  swarms_ecosystem: [
    "We built the TypeScript implementation of Swarms + x402 monetization. 15+ swarm architectures, x402 payment rail, ElizaOS plugin.\n\nhttps://api.swarmx.io",
    "SwarmX is the TS/ElizaOS side of the Swarms ecosystem. Same multi-agent power, x402 payments baked in, deploy standalone or as a plugin.\n\nhttps://api.swarmx.io",
  ],
};

export class XMonitor {
  readonly searchTerms: string[];
  private readonly config: XMonitorConfig;

  constructor(config: XMonitorConfig = {}) {
    this.config = config;
    this.searchTerms = config.searchTerms ?? DEFAULT_SEARCH_TERMS;
  }

  /**
   * Classify a post into a reply category.
   */
  categorize(post: XPost): ReplyCategory {
    for (const { category, pattern } of CATEGORY_PATTERNS) {
      if (pattern.test(post.text)) {
        return category;
      }
    }
    return "unknown";
  }

  /**
   * Pick a reply template for a category. Uses a deterministic index
   * derived from the post ID so the same post always gets the same variant.
   */
  pickReply(category: Exclude<ReplyCategory, "unknown">, postId: string): string {
    const templates = REPLY_TEMPLATES[category];
    // Simple hash: sum char codes of postId, mod template count
    let hash = 0;
    for (let i = 0; i < postId.length; i++) {
      hash += postId.charCodeAt(i);
    }
    return templates[hash % templates.length];
  }

  /**
   * Generate reply drafts for a batch of posts.
   * Skips posts that don't match any category.
   */
  generateReplyDrafts(posts: XPost[]): ReplyDraft[] {
    const drafts: ReplyDraft[] = [];

    for (const post of posts) {
      const category = this.categorize(post);
      if (category === "unknown") continue;

      drafts.push({
        postId: post.id,
        postAuthor: post.author,
        postText: post.text,
        category,
        reply: this.pickReply(category, post.id),
      });
    }

    return drafts;
  }

  /**
   * Generate reply drafts and send them to Telegram for review.
   */
  async reviewOnTelegram(posts: XPost[]): Promise<ReplyDraft[]> {
    const drafts = this.generateReplyDrafts(posts);

    for (const draft of drafts) {
      const message = [
        `[SwarmX Reply Draft]`,
        ``,
        `Post by @${draft.postAuthor}:`,
        `"${draft.postText}"`,
        ``,
        `Category: ${draft.category}`,
        ``,
        `Draft reply:`,
        draft.reply,
      ].join("\n");

      await this.sendToTelegram(message);
    }

    return drafts;
  }

  /**
   * Send a message to Telegram for human review.
   */
  private async sendToTelegram(text: string): Promise<void> {
    const { telegramBotToken, telegramChatId } = this.config;
    if (!telegramBotToken || !telegramChatId) return;

    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        parse_mode: "HTML",
      }),
    });
  }
}
