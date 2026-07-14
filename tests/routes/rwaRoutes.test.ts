import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../setup.js";

vi.mock("../../src/server/x402Gate.js", () => ({
  x402Gate: vi.fn(),
}));

vi.mock("../../src/utils/llm.js", () => ({
  callSwarmsAgent: vi.fn(),
}));

import { rwaRoutes } from "../../src/routes/rwaRoutes.js";
import { x402Gate } from "../../src/server/x402Gate.js";
import { callSwarmsAgent } from "../../src/utils/llm.js";

const originalFetch = globalThis.fetch;
const route = rwaRoutes.find(
  (candidate) => candidate.path === "/x402/rwa/stock-dd" && candidate.type === "POST",
);

function createMockRes() {
  const res: any = {
    status: vi.fn(() => res),
    json: vi.fn(),
    setHeader: vi.fn(),
  };
  return res;
}

function yahooResponse(status = 200): Response {
  if (status !== 200) return new Response("upstream error", { status });
  return new Response(
    JSON.stringify({
      chart: {
        result: [
          {
            meta: {
              regularMarketPrice: 110,
              previousClose: 100,
              regularMarketPreviousClose: 99,
              chartPreviousClose: 50,
              currency: "USD",
              fullExchangeName: "NasdaqGS",
              regularMarketTime: 1_700_000_000,
            },
            indicators: {
              quote: [
                {
                  close: [50, 100, 110],
                  high: [55, 105, 112],
                  low: [48, 95, 108],
                  volume: [1_000, 1_100, 1_200],
                },
              ],
            },
          },
        ],
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function defaultSwarmResult() {
  return {
    output: [
      {
        agent_name: "BullAnalyst",
        content: "Bullish buy case: strong upside and an undervalued setup.",
      },
      {
        agent_name: "BearAnalyst",
        content: "Bearish risk: downside remains possible.",
      },
      {
        role: "judge",
        content: "Final verdict: bullish with measured confidence.",
      },
    ],
    swarm_type: "DebateWithJudge",
    number_of_agents: 3,
    execution_time: 1.25,
    usage: { total_cost: 0.01 },
  };
}

function rhPaymentHeader(): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: "eip155:4663",
      payload: {
        signature: "0xsigned",
        authorization: {
          from: "0xpayer",
          to: "0xpayee",
          value: "290000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: "0xnonce",
        },
      },
    })
  ).toString("base64");
}

function runtimeWithSwarm(settings: Record<string, string | null> = {}) {
  const runSwarm = vi.fn(async () => defaultSwarmResult());
  const service = {
    isAvailable: vi.fn(() => true),
    runSwarm,
  };
  const runtime = createMockRuntime({
    settings,
    services: { SWARMS: service },
  });
  return { runtime, service, runSwarm };
}

describe("POST /x402/rwa/stock-dd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async () => yahooResponse()) as unknown as typeof fetch;
    vi.mocked(x402Gate).mockResolvedValue({
      paid: true,
      amountUsd: 0.29,
      transaction: "tx-rwa-paid",
      network: "base-mainnet",
    });
    vi.mocked(callSwarmsAgent).mockRejectedValue(new Error("structurer unavailable"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers the route", () => {
    expect(route).toBeDefined();
  });

  it("rejects an invalid ticker before market fetch or payment gate", async () => {
    const { runtime, runSwarm } = runtimeWithSwarm();
    const res = createMockRes();

    await route!.handler({ body: { ticker: "NVDA1" } } as any, res, runtime);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(x402Gate).not.toHaveBeenCalled();
    expect(runSwarm).not.toHaveBeenCalled();
  });

  it("returns 503 for an unavailable Swarms service without fetching or charging", async () => {
    const runtime = createMockRuntime();
    const res = createMockRes();

    await route!.handler({ body: { ticker: "NVDA" } } as any, res, runtime);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(x402Gate).not.toHaveBeenCalled();
  });

  it.each([
    [404, 400],
    [429, 502],
    [500, 502],
  ])("handles Yahoo %i as %i without charging", async (yahooStatus, expectedStatus) => {
    globalThis.fetch = vi.fn(async () => yahooResponse(yahooStatus)) as unknown as typeof fetch;
    const { runtime, runSwarm } = runtimeWithSwarm();
    const res = createMockRes();

    await route!.handler({ body: { ticker: "NVDA" } } as any, res, runtime);

    expect(res.status).toHaveBeenCalledWith(expectedStatus);
    expect(x402Gate).not.toHaveBeenCalled();
    expect(runSwarm).not.toHaveBeenCalled();
  });

  it("advertises RH-Chain USDG in the unpaid 402 accepts", async () => {
    vi.mocked(x402Gate).mockImplementationOnce(async (_runtime, _req, res, options) => {
      res.status?.(402).json?.({
        error: "Payment required",
        amount: options.amountUsd,
        accepts: options.extraAccepts,
      });
      return { paid: false, amountUsd: 0 };
    });
    const { runtime, runSwarm } = runtimeWithSwarm();
    const res = createMockRes();

    await route!.handler(
      { body: { ticker: "NVDA" }, url: "/x402/rwa/stock-dd" } as any,
      res,
      runtime
    );

    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(res.status).toHaveBeenCalledWith(402);
    expect(response.accepts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          network: "eip155:4663",
          asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        }),
      ])
    );
    expect(runSwarm).not.toHaveBeenCalled();
  });

  it("settles a valid RH-Chain payment without calling the Dexter gate", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(yahooResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ isValid: true, payer: "0xpayer" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            transaction: "0xrh-transaction",
            network: "eip155:4663",
            payer: "0xpayer",
          }),
          { status: 200 }
        )
      ) as unknown as typeof fetch;
    const { runtime, runSwarm } = runtimeWithSwarm();
    const res = createMockRes();

    await route!.handler(
      {
        body: { ticker: "NVDA" },
        url: "/x402/rwa/stock-dd",
        headers: { "x-payment": rhPaymentHeader() },
      } as any,
      res,
      runtime
    );

    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.payment).toEqual({
      network: "eip155:4663",
      asset: "USDG",
      amount: "0.29",
      listPriceUsd: "0.29",
      transaction: "0xrh-transaction",
      payer: "0xpayer",
    });
    expect(x402Gate).not.toHaveBeenCalled();
    expect(runSwarm).toHaveBeenCalledTimes(1);
  });

  it("rejects a failed RH-Chain payment without falling through to Dexter", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(yahooResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ isValid: false, invalidReason: "bad_signature" }), {
          status: 200,
        })
      ) as unknown as typeof fetch;
    const { runtime, runSwarm } = runtimeWithSwarm();
    const res = createMockRes();

    await route!.handler(
      {
        body: { ticker: "NVDA" },
        url: "/x402/rwa/stock-dd",
        headers: { "PAYMENT-SIGNATURE": rhPaymentHeader() },
      } as any,
      res,
      runtime
    );

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      error: "RH-Chain payment failed",
      reason: "bad_signature",
    });
    expect(x402Gate).not.toHaveBeenCalled();
    expect(runSwarm).not.toHaveBeenCalled();
  });

  it("uses the prior-session close for daily change, not chartPreviousClose", async () => {
    const { runtime } = runtimeWithSwarm();
    const res = createMockRes();

    await route!.handler({ body: { ticker: "NVDA" } } as any, res, runtime);

    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.market.prevClose).toBe(100);
    expect(response.market.pctChange).toBe(10);
  });

  it("returns 502 instead of fabricating a verdict from job metadata", async () => {
    const { runtime, runSwarm } = runtimeWithSwarm({ SWARMS_API_KEY: "swarms-test" });
    runSwarm.mockResolvedValue({
      job_id: "job-123",
      status: "completed",
      swarm_type: "DebateWithJudge",
      number_of_agents: 3,
    });
    const res = createMockRes();

    await route!.handler({ body: { ticker: "NVDA" } } as any, res, runtime);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      error: "Swarms returned no usable analyst or judge transcript",
    });
    expect(callSwarmsAgent).not.toHaveBeenCalled();
  });

  it("uses a structured verdict when the structuring agent returns valid JSON", async () => {
    vi.mocked(callSwarmsAgent).mockResolvedValue(
      JSON.stringify({
        rating: "bearish",
        confidence: 0.82,
        summary: "The judge sees downside risk outweighing the upside case.",
        bull_points: ["Strong recent momentum"],
        bear_points: ["Elevated downside risk"],
        risks: ["High volatility"],
      }),
    );
    const { runtime } = runtimeWithSwarm({ SWARMS_API_KEY: "swarms-test" });
    const res = createMockRes();

    await route!.handler({ body: { ticker: "NVDA" } } as any, res, runtime);

    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.verdictVia).toBe("swarms");
    expect(response.verdict).toEqual(
      expect.objectContaining({ rating: "bearish", confidence: 0.82 }),
    );
  });

  it("falls back to a transcript-grounded heuristic verdict", async () => {
    const { runtime } = runtimeWithSwarm();
    const res = createMockRes();

    await route!.handler({ body: { ticker: "NVDA" } } as any, res, runtime);

    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.verdictVia).toBe("heuristic");
    expect(response.verdict.rating).toBe("bullish");
    expect(response.verdict.summary).toContain("keyword sentiment");
  });

  it.each([
    {
      name: "free",
      gate: { paid: true, amountUsd: 0, freeRemaining: 4 },
      expectedAmount: 0,
      expectedRaw: undefined,
    },
    {
      name: "paid",
      gate: {
        paid: true,
        amountUsd: 0.29,
        transaction: "tx-rwa-paid",
        network: "base-mainnet",
      },
      expectedAmount: 0.29,
      expectedRaw: expect.stringContaining("BullAnalyst"),
    },
  ])("reports $name payment metadata accurately", async ({ gate, expectedAmount, expectedRaw }) => {
    vi.mocked(x402Gate).mockResolvedValue(gate);
    const { runtime, runSwarm } = runtimeWithSwarm();
    const res = createMockRes();

    await route!.handler({ body: { ticker: "NVDA" } } as any, res, runtime);

    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.payment).toEqual(
      expect.objectContaining({ amount: expectedAmount, listPriceUsd: "0.29" }),
    );
    expect(response.raw).toEqual(expectedRaw);
    expect(runSwarm).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(x402Gate).toHaveBeenCalledTimes(1);
  });
});

// ── RWA suite: screen / compare / eligibility / catalyst ─────────────────

const screenRoute = rwaRoutes.find((r) => r.path === "/x402/rwa/screen" && r.type === "POST");
const compareRoute = rwaRoutes.find((r) => r.path === "/x402/rwa/compare" && r.type === "POST");
const eligibilityRoute = rwaRoutes.find(
  (r) => r.path === "/x402/rwa/eligibility" && r.type === "POST"
);
const catalystRoute = rwaRoutes.find((r) => r.path === "/x402/rwa/catalyst" && r.type === "POST");

function catalystYahooResponse(): Response {
  const now = Math.floor(Date.now() / 1000);
  const recentDiv = now - 30 * 24 * 3600; // within the trailing year
  return new Response(
    JSON.stringify({
      chart: {
        result: [
          {
            meta: {
              regularMarketPrice: 200,
              currency: "USD",
              fullExchangeName: "NasdaqGS",
              regularMarketTime: now,
            },
            timestamp: [now - 2 * 86400, now - 86400, now],
            events: {
              dividends: { [String(recentDiv)]: { amount: 0.24, date: recentDiv } },
              splits: {
                "1680000000": { date: 1680000000, numerator: 4, denominator: 1, splitRatio: "4:1" },
              },
            },
            indicators: { quote: [{ close: [100, 100, 120] }] },
          },
        ],
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("POST /x402/rwa/screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async () => yahooResponse()) as unknown as typeof fetch;
    vi.mocked(x402Gate).mockResolvedValue({ paid: true, amountUsd: 0.49, transaction: "tx", network: "base-mainnet" });
    vi.mocked(callSwarmsAgent).mockRejectedValue(new Error("structurer unavailable"));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers the route", () => {
    expect(screenRoute).toBeDefined();
  });

  it("rejects fewer than 2 tickers before fetch or payment", async () => {
    const { runtime, runSwarm } = runtimeWithSwarm();
    const res = createMockRes();
    await screenRoute!.handler({ body: { tickers: ["NVDA"] } } as any, res, runtime);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(x402Gate).not.toHaveBeenCalled();
    expect(runSwarm).not.toHaveBeenCalled();
  });

  it("rejects more than 8 tickers", async () => {
    const { runtime } = runtimeWithSwarm();
    const res = createMockRes();
    const nine = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III"];
    await screenRoute!.handler({ body: { tickers: nine } } as any, res, runtime);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(x402Gate).not.toHaveBeenCalled();
  });

  it("returns 503 for an unavailable Swarms service without charging", async () => {
    const runtime = createMockRuntime();
    const res = createMockRes();
    await screenRoute!.handler({ body: { tickers: ["NVDA", "AAPL"] } } as any, res, runtime);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(x402Gate).not.toHaveBeenCalled();
  });

  it("returns 400 without charging when fewer than 2 tickers resolve", async () => {
    globalThis.fetch = vi.fn(async () => yahooResponse(404)) as unknown as typeof fetch;
    const { runtime, runSwarm } = runtimeWithSwarm();
    const res = createMockRes();
    await screenRoute!.handler({ body: { tickers: ["NVDA", "AAPL"] } } as any, res, runtime);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(x402Gate).not.toHaveBeenCalled();
    expect(runSwarm).not.toHaveBeenCalled();
  });

  it("returns a swarm-structured ranking when the structurer returns valid JSON", async () => {
    vi.mocked(callSwarmsAgent).mockResolvedValue(
      JSON.stringify({
        ranking: [
          { ticker: "NVDA", rating: "bullish", rationale: "strongest momentum" },
          { ticker: "AAPL", rating: "neutral", rationale: "steady" },
        ],
        summary: "NVDA leads the screen.",
      })
    );
    const { runtime } = runtimeWithSwarm({ SWARMS_API_KEY: "swarms-test" });
    const res = createMockRes();
    await screenRoute!.handler({ body: { tickers: ["NVDA", "AAPL"] } } as any, res, runtime);
    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.via).toBe("swarms");
    expect(response.ranking).toHaveLength(2);
    expect(response.ranking[0]).toEqual(
      expect.objectContaining({ ticker: "NVDA", rank: 1, rating: "bullish" })
    );
    expect(typeof response.ranking[0].score).toBe("number");
    expect(response.payment.listPriceUsd).toBe("0.49");
  });

  it("falls back to a deterministic ranking when structuring fails", async () => {
    const { runtime } = runtimeWithSwarm({ SWARMS_API_KEY: "swarms-test" });
    const res = createMockRes();
    await screenRoute!.handler({ body: { tickers: ["NVDA", "AAPL"] } } as any, res, runtime);
    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.via).toBe("heuristic");
    expect(response.ranking).toHaveLength(2);
    expect(response.ranking[0].rationale).toContain("momentum/positioning");
  });
});

describe("POST /x402/rwa/compare", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async () => yahooResponse()) as unknown as typeof fetch;
    vi.mocked(x402Gate).mockResolvedValue({ paid: true, amountUsd: 0.39, transaction: "tx", network: "base-mainnet" });
    vi.mocked(callSwarmsAgent).mockRejectedValue(new Error("structurer unavailable"));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects identical tickers", async () => {
    const { runtime } = runtimeWithSwarm();
    const res = createMockRes();
    await compareRoute!.handler({ body: { tickerA: "NVDA", tickerB: "nvda" } } as any, res, runtime);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(x402Gate).not.toHaveBeenCalled();
  });

  it("rejects an invalid ticker before fetch or payment", async () => {
    const { runtime } = runtimeWithSwarm();
    const res = createMockRes();
    await compareRoute!.handler({ body: { tickerA: "NVDA", tickerB: "BAD1" } } as any, res, runtime);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(x402Gate).not.toHaveBeenCalled();
  });

  it("returns 400 without charging when the second ticker is not found", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(yahooResponse())
      .mockResolvedValueOnce(yahooResponse(404)) as unknown as typeof fetch;
    const { runtime, runSwarm } = runtimeWithSwarm();
    const res = createMockRes();
    await compareRoute!.handler({ body: { tickerA: "NVDA", tickerB: "AAPL" } } as any, res, runtime);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(x402Gate).not.toHaveBeenCalled();
    expect(runSwarm).not.toHaveBeenCalled();
  });

  it("returns a swarm-structured comparison when JSON is valid", async () => {
    vi.mocked(callSwarmsAgent).mockResolvedValue(
      JSON.stringify({
        winner: "NVDA",
        rating_a: "bullish",
        rating_b: "neutral",
        summary: "NVDA edges ahead on momentum.",
        a_points: ["momentum"],
        b_points: ["stability"],
        risks: ["volatility"],
      })
    );
    const { runtime } = runtimeWithSwarm({ SWARMS_API_KEY: "swarms-test" });
    const res = createMockRes();
    await compareRoute!.handler({ body: { tickerA: "NVDA", tickerB: "AAPL" } } as any, res, runtime);
    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.via).toBe("swarms");
    expect(response.comparison.winner).toBe("NVDA");
    expect(response.comparison.summary).toContain("NVDA");
  });

  it("falls back to a deterministic comparison when structuring fails", async () => {
    const { runtime } = runtimeWithSwarm({ SWARMS_API_KEY: "swarms-test" });
    const res = createMockRes();
    await compareRoute!.handler({ body: { tickerA: "NVDA", tickerB: "AAPL" } } as any, res, runtime);
    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.via).toBe("heuristic");
    expect(response.comparison.summary).toContain("deterministic");
  });
});

describe("POST /x402/rwa/eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async () => yahooResponse()) as unknown as typeof fetch;
    vi.mocked(x402Gate).mockResolvedValue({ paid: true, amountUsd: 0.19, transaction: "tx", network: "base-mainnet" });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects an invalid ticker before fetch or payment", async () => {
    const res = createMockRes();
    await eligibilityRoute!.handler({ body: { ticker: "BAD1" } } as any, res, createMockRuntime());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(x402Gate).not.toHaveBeenCalled();
  });

  it("marks US persons ineligible and never invokes an LLM", async () => {
    const res = createMockRes();
    await eligibilityRoute!.handler({ body: { ticker: "NVDA" } } as any, res, createMockRuntime());
    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.eligibility.status).toBe("no");
    expect(response.eligibility.usPerson).toBe(true);
    expect(response.chain.chainId).toBe("eip155:4663");
    expect(callSwarmsAgent).not.toHaveBeenCalled();
  });

  it("marks a non-US jurisdiction as conditional", async () => {
    const res = createMockRes();
    await eligibilityRoute!.handler(
      { body: { ticker: "NVDA", jurisdiction: "Germany" } } as any,
      res,
      createMockRuntime()
    );
    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.eligibility.status).toBe("conditional");
    expect(response.eligibility.usPerson).toBe(false);
    expect(response.jurisdiction).toBe("Germany");
  });
});

describe("POST /x402/rwa/catalyst", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async () => catalystYahooResponse()) as unknown as typeof fetch;
    vi.mocked(x402Gate).mockResolvedValue({ paid: true, amountUsd: 0.29, transaction: "tx", network: "base-mainnet" });
    vi.mocked(callSwarmsAgent).mockRejectedValue(new Error("brief unavailable"));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects an invalid ticker before fetch or payment", async () => {
    const res = createMockRes();
    await catalystRoute!.handler({ body: { ticker: "BAD1" } } as any, res, createMockRuntime());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(x402Gate).not.toHaveBeenCalled();
  });

  it("returns real dividend/split data with an AI brief when available", async () => {
    vi.mocked(callSwarmsAgent).mockResolvedValue(
      JSON.stringify({ brief: "Pays a modest dividend; a 4:1 split occurred; one notable +20% move." })
    );
    const res = createMockRes();
    await catalystRoute!.handler(
      { body: { ticker: "AAPL" } } as any,
      res,
      createMockRuntime({ settings: { SWARMS_API_KEY: "swarms-test" } })
    );
    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.via).toBe("swarms");
    expect(response.ttmDividend).toBe(0.24);
    expect(response.dividendYieldPct).toBe(0.12);
    expect(response.dividends).toHaveLength(1);
    expect(response.recentMoves[0].changePct).toBe(20);
    expect(response.nextEarningsDate).toBeNull();
  });

  it("falls back to a deterministic brief and never fabricates earnings dates", async () => {
    const res = createMockRes();
    await catalystRoute!.handler(
      { body: { ticker: "AAPL" } } as any,
      res,
      createMockRuntime({ settings: { SWARMS_API_KEY: "swarms-test" } })
    );
    const response = vi.mocked(res.json).mock.calls[0][0];
    expect(response.via).toBe("deterministic");
    expect(response.brief).toContain("dividend");
    expect(response.brief).toContain("earnings dates are not available");
    expect(response.nextEarningsDate).toBeNull();
  });
});
