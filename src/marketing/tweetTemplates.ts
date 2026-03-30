/**
 * SwarmX tweet templates — generate tweet-length strings from platform metrics.
 */

export interface TweetContext {
  revenue?: number;
  settlements?: number;
  endpoints?: number;
  freeCallsToday?: number;
  uniqueIPs?: number;
  benchmarkRate?: number;
}

const MAX_TWEET_LENGTH = 280;

function truncate(text: string): string {
  if (text.length <= MAX_TWEET_LENGTH) return text;
  return text.slice(0, MAX_TWEET_LENGTH - 1) + "\u2026";
}

/**
 * Revenue milestone tweet — crossed a $ threshold.
 */
export function revenueMilestone(ctx: TweetContext): string {
  const revenue = ctx.revenue?.toFixed(2) ?? "0.00";
  const settlements = ctx.settlements ?? 0;
  return truncate(
    `SwarmX just crossed $${revenue} in x402 revenue. ${settlements} settlements. AI agents paying AI agents.\n\nNo subscriptions. No accounts. Just USDC.\n\nhttps://api.swarmx.io`
  );
}

/**
 * New endpoint launched tweet.
 */
export function newEndpoint(
  name: string,
  price: string,
  description: string
): string {
  return truncate(
    `New SwarmX endpoint live: ${name}\n\n${description}\n\n${price} per call. Pay with USDC. No account needed.\n\nhttps://api.swarmx.io`
  );
}

/**
 * Free tier usage spike tweet.
 */
export function freeTierSpike(ctx: TweetContext): string {
  const calls = ctx.freeCallsToday ?? 0;
  const ips = ctx.uniqueIPs ?? 0;
  return truncate(
    `${calls} free trial calls today from ${ips} unique IPs.\n\nThe demand for pay-per-call AI agent teams is real.\n\nTry it free: https://api.swarmx.io`
  );
}

/**
 * Daily stats digest tweet.
 */
export function dailyStats(ctx: TweetContext): string {
  const parts: string[] = [];
  if (ctx.revenue !== undefined) parts.push(`Revenue: $${ctx.revenue.toFixed(2)}`);
  if (ctx.settlements !== undefined) parts.push(`Settlements: ${ctx.settlements}`);
  if (ctx.endpoints !== undefined) parts.push(`Endpoints: ${ctx.endpoints}`);
  if (ctx.freeCallsToday !== undefined) parts.push(`Free calls: ${ctx.freeCallsToday}`);
  if (ctx.uniqueIPs !== undefined) parts.push(`Unique IPs: ${ctx.uniqueIPs}`);

  const statsBlock = parts.join("\n");
  return truncate(
    `SwarmX daily stats:\n\n${statsBlock}\n\nAI Agent Teams. One Payment.\nhttps://api.swarmx.io`
  );
}

/**
 * Competitor comparison tweets — returns multiple variants.
 */
export function competitorComparison(): string[] {
  return [
    truncate(
      `CrewAI: $0.50/execution, subscription required.\nSwarmX: $0.01/call, pay with USDC, no account needed.\n\nSame multi-agent orchestration. 50x cheaper.\n\nAI Agent Teams. One Payment.`
    ),
    truncate(
      `AutoGen: self-host GPT-4 agents, manage infra, pay OpenAI directly.\nSwarmX: one USDC payment, hosted multi-agent teams, zero infra.\n\nWhy run your own when you can pay per call?\n\nhttps://api.swarmx.io`
    ),
    truncate(
      `LangGraph: build agent graphs in Python, manage state yourself.\nSwarmX: 15+ swarm architectures, pay-per-call, TypeScript-native.\n\nShip in minutes, not weeks.\n\nhttps://api.swarmx.io`
    ),
  ];
}
