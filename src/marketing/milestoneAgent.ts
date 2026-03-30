/**
 * MilestoneAgent — monitors SwarmX health endpoint for revenue/settlement
 * milestones and generates tweets for human review via Telegram.
 */

import {
  revenueMilestone,
  freeTierSpike,
  dailyStats,
  type TweetContext,
} from "./tweetTemplates.js";

export interface MilestoneAgentConfig {
  healthUrl: string;
  catalogUrl: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export interface HealthData {
  revenue?: number;
  settlements?: number;
  endpoints?: number;
  freeCallsToday?: number;
  uniqueIPs?: number;
}

interface MilestoneState {
  lastRevenue: number;
  lastSettlements: number;
  lastFreeCallsRecord: number;
  crossedRevenueMilestones: Set<number>;
  crossedSettlementMilestones: Set<number>;
}

const REVENUE_MILESTONES = [1, 5, 10, 25, 50, 100, 250, 500, 1000];
const SETTLEMENT_MILESTONES = [10, 50, 100, 500, 1000];

export class MilestoneAgent {
  private readonly config: MilestoneAgentConfig;
  private state: MilestoneState;

  constructor(config: MilestoneAgentConfig) {
    this.config = config;
    this.state = {
      lastRevenue: 0,
      lastSettlements: 0,
      lastFreeCallsRecord: 0,
      crossedRevenueMilestones: new Set(),
      crossedSettlementMilestones: new Set(),
    };
  }

  /**
   * Expose internal state for testing.
   */
  getState(): {
    lastRevenue: number;
    lastSettlements: number;
    lastFreeCallsRecord: number;
    crossedRevenueMilestones: ReadonlySet<number>;
    crossedSettlementMilestones: ReadonlySet<number>;
  } {
    return { ...this.state };
  }

  /**
   * Fetch health data from the platform.
   */
  async fetchHealth(): Promise<HealthData> {
    const res = await fetch(this.config.healthUrl);
    if (!res.ok) {
      throw new Error(`Health endpoint returned ${res.status}`);
    }
    return (await res.json()) as HealthData;
  }

  /**
   * Detect which milestones have been newly crossed.
   */
  detectMilestones(health: HealthData): string[] {
    const tweets: string[] = [];
    const revenue = health.revenue ?? 0;
    const settlements = health.settlements ?? 0;
    const freeCalls = health.freeCallsToday ?? 0;

    // Revenue milestones
    for (const threshold of REVENUE_MILESTONES) {
      if (
        revenue >= threshold &&
        !this.state.crossedRevenueMilestones.has(threshold)
      ) {
        this.state.crossedRevenueMilestones.add(threshold);
        tweets.push(
          revenueMilestone({ revenue: threshold, settlements })
        );
      }
    }

    // Settlement milestones
    for (const threshold of SETTLEMENT_MILESTONES) {
      if (
        settlements >= threshold &&
        !this.state.crossedSettlementMilestones.has(threshold)
      ) {
        this.state.crossedSettlementMilestones.add(threshold);
        tweets.push(
          revenueMilestone({ revenue, settlements: threshold })
        );
      }
    }

    // Free tier daily record
    if (freeCalls > this.state.lastFreeCallsRecord && freeCalls > 0) {
      this.state.lastFreeCallsRecord = freeCalls;
      tweets.push(
        freeTierSpike({
          freeCallsToday: freeCalls,
          uniqueIPs: health.uniqueIPs ?? 0,
        })
      );
    }

    // Update tracked values
    this.state.lastRevenue = revenue;
    this.state.lastSettlements = settlements;

    return tweets;
  }

  /**
   * Check the health endpoint and generate tweets for any new milestones.
   * Sends drafts to Telegram if configured.
   */
  async checkMilestones(): Promise<string[]> {
    const health = await this.fetchHealth();
    const tweets = this.detectMilestones(health);

    for (const tweet of tweets) {
      await this.sendToTelegram(`[SwarmX Milestone Draft]\n\n${tweet}`);
    }

    return tweets;
  }

  /**
   * Generate a daily summary tweet from current health data.
   */
  async generateDailyDigest(): Promise<string> {
    const health = await this.fetchHealth();
    const ctx: TweetContext = {
      revenue: health.revenue,
      settlements: health.settlements,
      endpoints: health.endpoints,
      freeCallsToday: health.freeCallsToday,
      uniqueIPs: health.uniqueIPs,
    };
    const tweet = dailyStats(ctx);
    await this.sendToTelegram(`[SwarmX Daily Digest]\n\n${tweet}`);
    return tweet;
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
