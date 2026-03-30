import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  revenueMilestone,
  newEndpoint,
  freeTierSpike,
  dailyStats,
  competitorComparison,
  type TweetContext,
} from "../../src/marketing/tweetTemplates.js";
import { MilestoneAgent } from "../../src/marketing/milestoneAgent.js";
import { XMonitor, type XPost } from "../../src/marketing/xMonitor.js";

const MAX_TWEET = 280;

// ---------------------------------------------------------------------------
// Tweet Templates
// ---------------------------------------------------------------------------

describe("tweetTemplates", () => {
  describe("revenueMilestone", () => {
    it("returns a string under 280 chars", () => {
      const tweet = revenueMilestone({ revenue: 100, settlements: 42 });
      expect(tweet.length).toBeLessThanOrEqual(MAX_TWEET);
    });

    it("includes the revenue amount", () => {
      const tweet = revenueMilestone({ revenue: 25, settlements: 10 });
      expect(tweet).toContain("$25.00");
    });

    it("includes settlement count", () => {
      const tweet = revenueMilestone({ revenue: 5, settlements: 77 });
      expect(tweet).toContain("77");
    });

    it("includes the SwarmX URL", () => {
      const tweet = revenueMilestone({ revenue: 1, settlements: 1 });
      expect(tweet).toContain("https://api.swarmx.io");
    });

    it("handles missing values with defaults", () => {
      const tweet = revenueMilestone({});
      expect(tweet.length).toBeLessThanOrEqual(MAX_TWEET);
      expect(tweet).toContain("$0.00");
    });
  });

  describe("newEndpoint", () => {
    it("returns a string under 280 chars for short inputs", () => {
      const tweet = newEndpoint("contract-audit", "$0.05", "Audit Solidity contracts");
      expect(tweet.length).toBeLessThanOrEqual(MAX_TWEET);
    });

    it("includes the endpoint name", () => {
      const tweet = newEndpoint("token-risk", "$0.02", "Analyze token risk");
      expect(tweet).toContain("token-risk");
    });

    it("includes the price", () => {
      const tweet = newEndpoint("dao-analysis", "$0.03", "Analyze DAO governance");
      expect(tweet).toContain("$0.03");
    });

    it("truncates long descriptions gracefully", () => {
      const longDesc = "A".repeat(300);
      const tweet = newEndpoint("test", "$0.01", longDesc);
      expect(tweet.length).toBeLessThanOrEqual(MAX_TWEET);
    });
  });

  describe("freeTierSpike", () => {
    it("returns a string under 280 chars", () => {
      const tweet = freeTierSpike({ freeCallsToday: 150, uniqueIPs: 42 });
      expect(tweet.length).toBeLessThanOrEqual(MAX_TWEET);
    });

    it("includes call count and IP count", () => {
      const tweet = freeTierSpike({ freeCallsToday: 200, uniqueIPs: 35 });
      expect(tweet).toContain("200");
      expect(tweet).toContain("35");
    });

    it("handles zero values", () => {
      const tweet = freeTierSpike({});
      expect(tweet.length).toBeLessThanOrEqual(MAX_TWEET);
    });
  });

  describe("dailyStats", () => {
    it("returns a string under 280 chars", () => {
      const ctx: TweetContext = {
        revenue: 50,
        settlements: 120,
        endpoints: 15,
        freeCallsToday: 80,
        uniqueIPs: 25,
      };
      const tweet = dailyStats(ctx);
      expect(tweet.length).toBeLessThanOrEqual(MAX_TWEET);
    });

    it("includes all provided metrics", () => {
      const ctx: TweetContext = {
        revenue: 12.5,
        settlements: 33,
        endpoints: 10,
      };
      const tweet = dailyStats(ctx);
      expect(tweet).toContain("$12.50");
      expect(tweet).toContain("33");
      expect(tweet).toContain("10");
    });

    it("handles empty context", () => {
      const tweet = dailyStats({});
      expect(tweet.length).toBeLessThanOrEqual(MAX_TWEET);
      expect(tweet).toContain("SwarmX daily stats");
    });
  });

  describe("competitorComparison", () => {
    it("returns an array of strings", () => {
      const variants = competitorComparison();
      expect(Array.isArray(variants)).toBe(true);
      expect(variants.length).toBeGreaterThanOrEqual(2);
    });

    it("all variants are under 280 chars", () => {
      const variants = competitorComparison();
      for (const v of variants) {
        expect(v.length).toBeLessThanOrEqual(MAX_TWEET);
      }
    });

    it("first variant mentions CrewAI pricing comparison", () => {
      const variants = competitorComparison();
      expect(variants[0]).toContain("CrewAI");
      expect(variants[0]).toContain("$0.01");
    });
  });
});

// ---------------------------------------------------------------------------
// MilestoneAgent
// ---------------------------------------------------------------------------

describe("MilestoneAgent", () => {
  let agent: MilestoneAgent;

  beforeEach(() => {
    agent = new MilestoneAgent({
      healthUrl: "https://api.swarmx.io/x402/health",
      catalogUrl: "https://api.swarmx.io/x402/catalog",
    });
  });

  describe("detectMilestones", () => {
    it("detects $1 revenue milestone", () => {
      const tweets = agent.detectMilestones({ revenue: 1.5, settlements: 3 });
      expect(tweets.length).toBe(1);
      expect(tweets[0]).toContain("$1.00");
    });

    it("detects multiple revenue milestones at once", () => {
      const tweets = agent.detectMilestones({ revenue: 30, settlements: 5 });
      // Should cross $1, $5, $10, $25
      expect(tweets.length).toBe(4);
    });

    it("does not re-trigger already crossed milestones", () => {
      agent.detectMilestones({ revenue: 10, settlements: 5 });
      const tweets = agent.detectMilestones({ revenue: 12, settlements: 8 });
      // $1, $5, $10 already crossed; $12 < $25 so no new revenue milestones
      // No free tier spike (0 calls both times)
      expect(tweets.length).toBe(0);
    });

    it("detects settlement milestones", () => {
      const tweets = agent.detectMilestones({ revenue: 0.5, settlements: 55 });
      // Revenue: none crossed (0.5 < 1)
      // Settlements: 10 and 50 crossed
      expect(tweets.length).toBe(2);
    });

    it("detects free tier daily record", () => {
      const tweets = agent.detectMilestones({
        revenue: 0,
        settlements: 0,
        freeCallsToday: 50,
        uniqueIPs: 20,
      });
      expect(tweets.length).toBe(1);
      expect(tweets[0]).toContain("50");
      expect(tweets[0]).toContain("20");
    });

    it("does not trigger free tier if calls did not increase", () => {
      agent.detectMilestones({ freeCallsToday: 50, uniqueIPs: 10 });
      const tweets = agent.detectMilestones({ freeCallsToday: 50, uniqueIPs: 10 });
      expect(tweets.filter((t) => t.includes("free trial"))).toHaveLength(0);
    });

    it("triggers free tier again when record is broken", () => {
      agent.detectMilestones({ freeCallsToday: 50, uniqueIPs: 10 });
      const tweets = agent.detectMilestones({ freeCallsToday: 75, uniqueIPs: 15 });
      const freeTrialTweets = tweets.filter((t) => t.includes("free trial"));
      expect(freeTrialTweets.length).toBe(1);
      expect(freeTrialTweets[0]).toContain("75");
    });

    it("handles empty health data", () => {
      const tweets = agent.detectMilestones({});
      expect(tweets.length).toBe(0);
    });

    it("all generated tweets are under 280 chars", () => {
      const tweets = agent.detectMilestones({
        revenue: 1000,
        settlements: 1000,
        freeCallsToday: 500,
        uniqueIPs: 100,
      });
      for (const t of tweets) {
        expect(t.length).toBeLessThanOrEqual(MAX_TWEET);
      }
    });
  });

  describe("checkMilestones", () => {
    it("fetches health and returns milestone tweets", async () => {
      const mockHealth = { revenue: 5.5, settlements: 12 };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockHealth), { status: 200 })
      );

      const tweets = await agent.checkMilestones();
      // $1 + $5 revenue + 10 settlements = 3
      expect(tweets.length).toBe(3);

      vi.restoreAllMocks();
    });

    it("throws on non-ok health response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("error", { status: 500 })
      );

      await expect(agent.checkMilestones()).rejects.toThrow("Health endpoint returned 500");

      vi.restoreAllMocks();
    });
  });

  describe("generateDailyDigest", () => {
    it("returns a daily stats tweet", async () => {
      const mockHealth = {
        revenue: 42,
        settlements: 200,
        endpoints: 15,
        freeCallsToday: 100,
        uniqueIPs: 30,
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockHealth), { status: 200 })
      );

      const tweet = await agent.generateDailyDigest();
      expect(tweet).toContain("SwarmX daily stats");
      expect(tweet).toContain("$42.00");
      expect(tweet.length).toBeLessThanOrEqual(MAX_TWEET);

      vi.restoreAllMocks();
    });
  });

  describe("getState", () => {
    it("exposes tracked milestone state", () => {
      agent.detectMilestones({ revenue: 10, settlements: 50 });
      const state = agent.getState();
      expect(state.lastRevenue).toBe(10);
      expect(state.lastSettlements).toBe(50);
      expect(state.crossedRevenueMilestones.has(1)).toBe(true);
      expect(state.crossedRevenueMilestones.has(5)).toBe(true);
      expect(state.crossedRevenueMilestones.has(10)).toBe(true);
      expect(state.crossedSettlementMilestones.has(10)).toBe(true);
      expect(state.crossedSettlementMilestones.has(50)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// XMonitor
// ---------------------------------------------------------------------------

describe("XMonitor", () => {
  let monitor: XMonitor;

  beforeEach(() => {
    monitor = new XMonitor();
  });

  describe("constructor", () => {
    it("uses default search terms", () => {
      expect(monitor.searchTerms).toContain("x402 payment");
      expect(monitor.searchTerms).toContain("CrewAI pricing");
    });

    it("accepts custom search terms", () => {
      const custom = new XMonitor({ searchTerms: ["custom term"] });
      expect(custom.searchTerms).toEqual(["custom term"]);
    });
  });

  describe("categorize", () => {
    it("detects x402 mentions", () => {
      const post: XPost = { id: "1", author: "user1", text: "Just learned about x402 payment protocol" };
      expect(monitor.categorize(post)).toBe("x402_mention");
    });

    it("detects competitor mentions", () => {
      const post: XPost = { id: "2", author: "user2", text: "CrewAI pricing is getting expensive" };
      expect(monitor.categorize(post)).toBe("competitor_mention");
    });

    it("detects AutoGen as competitor", () => {
      const post: XPost = { id: "3", author: "user3", text: "AutoGen is hard to self-host" };
      expect(monitor.categorize(post)).toBe("competitor_mention");
    });

    it("detects LangGraph as competitor", () => {
      const post: XPost = { id: "4", author: "user4", text: "LangGraph state management is painful" };
      expect(monitor.categorize(post)).toBe("competitor_mention");
    });

    it("detects agent payment discussions", () => {
      const post: XPost = { id: "5", author: "user5", text: "How do you handle agent micropayments?" };
      expect(monitor.categorize(post)).toBe("agent_payments");
    });

    it("detects swarms ecosystem mentions", () => {
      const post: XPost = { id: "6", author: "user6", text: "Swarms AI framework is interesting for multi-agent" };
      expect(monitor.categorize(post)).toBe("swarms_ecosystem");
    });

    it("returns unknown for unrelated posts", () => {
      const post: XPost = { id: "7", author: "user7", text: "I love pancakes" };
      expect(monitor.categorize(post)).toBe("unknown");
    });

    it("is case insensitive", () => {
      const post: XPost = { id: "8", author: "user8", text: "CREWAI IS TOO EXPENSIVE" };
      expect(monitor.categorize(post)).toBe("competitor_mention");
    });
  });

  describe("generateReplyDrafts", () => {
    it("generates drafts for matching posts", () => {
      const posts: XPost[] = [
        { id: "a1", author: "alice", text: "x402 is the future of agent payments" },
        { id: "b2", author: "bob", text: "CrewAI costs are killing my budget" },
      ];
      const drafts = monitor.generateReplyDrafts(posts);
      expect(drafts).toHaveLength(2);
      expect(drafts[0].category).toBe("x402_mention");
      expect(drafts[1].category).toBe("competitor_mention");
    });

    it("skips posts with unknown category", () => {
      const posts: XPost[] = [
        { id: "c3", author: "charlie", text: "I love pancakes" },
        { id: "d4", author: "dave", text: "x402 payment rail is cool" },
      ];
      const drafts = monitor.generateReplyDrafts(posts);
      expect(drafts).toHaveLength(1);
      expect(drafts[0].postId).toBe("d4");
    });

    it("returns empty array when no posts match", () => {
      const posts: XPost[] = [
        { id: "e5", author: "eve", text: "Beautiful weather today" },
      ];
      const drafts = monitor.generateReplyDrafts(posts);
      expect(drafts).toHaveLength(0);
    });

    it("includes post metadata in drafts", () => {
      const posts: XPost[] = [
        { id: "f6", author: "frank", text: "Is there a Swarms multi-agent TypeScript SDK?" },
      ];
      const drafts = monitor.generateReplyDrafts(posts);
      expect(drafts[0].postId).toBe("f6");
      expect(drafts[0].postAuthor).toBe("frank");
      expect(drafts[0].postText).toContain("Swarms multi-agent");
    });

    it("reply text contains swarmx.io URL", () => {
      const posts: XPost[] = [
        { id: "g7", author: "grace", text: "How to monetize agents with x402?" },
      ];
      const drafts = monitor.generateReplyDrafts(posts);
      expect(drafts[0].reply).toContain("swarmx.io");
    });

    it("same post ID always gets the same reply variant", () => {
      const posts: XPost[] = [
        { id: "h8", author: "hank", text: "x402 payment standard" },
      ];
      const first = monitor.generateReplyDrafts(posts);
      const second = monitor.generateReplyDrafts(posts);
      expect(first[0].reply).toBe(second[0].reply);
    });
  });

  describe("pickReply", () => {
    it("returns a string for each category", () => {
      const categories = [
        "x402_mention",
        "competitor_mention",
        "agent_payments",
        "swarms_ecosystem",
      ] as const;
      for (const cat of categories) {
        const reply = monitor.pickReply(cat, "test-id");
        expect(typeof reply).toBe("string");
        expect(reply.length).toBeGreaterThan(0);
      }
    });
  });
});
