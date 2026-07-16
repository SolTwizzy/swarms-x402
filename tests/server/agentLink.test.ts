import { describe, it, expect, beforeEach } from "vitest";
import {
  startLink,
  claimLink,
  createJob,
  pollJobs,
  completeJob,
  getJob,
  getSessionByAgentToken,
  getSessionByBrowserToken,
  sessionSummary,
  sweepSessions,
  resetAgentLinkStore,
  type AllowedEndpoint,
} from "../../src/server/agentLink.js";

const ALLOWED: AllowedEndpoint[] = [
  { endpoint: "/x402/rwa/stock-dd", method: "POST", priceUsd: "0.29", description: "Stock DD" },
  { endpoint: "/x402/rwa/catalyst", method: "POST", priceUsd: "0.29", description: "Catalyst" },
];

function pair() {
  const started = startLink("hermes");
  const claimed = claimLink(started.claimCode)!;
  return { started, claimed };
}

beforeEach(() => resetAgentLinkStore());

describe("agentLink — pairing", () => {
  it("startLink mints distinct tokens and a formatted claim code", () => {
    const a = startLink("hermes");
    const b = startLink();
    expect(a.agentToken).not.toBe(b.agentToken);
    expect(a.claimCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(a.expiresInSeconds).toBe(900);
  });

  it("claimLink is single-use and case-insensitive", () => {
    const started = startLink("hermes");
    const claimed = claimLink(started.claimCode.toLowerCase());
    expect(claimed).not.toBeNull();
    expect(claimed!.agentName).toBe("hermes");
    expect(claimLink(started.claimCode)).toBeNull(); // second claim fails
  });

  it("claimLink rejects unknown codes", () => {
    expect(claimLink("ZZZZ-ZZZZ")).toBeNull();
  });

  it("sanitizes hostile agent names", () => {
    const started = startLink("<script>alert(1)</script>");
    const claimed = claimLink(started.claimCode)!;
    expect(claimed.agentName).not.toContain("<");
    expect(claimed.agentName).not.toContain(">");
  });

  it("unclaimed links expire after 15 minutes (via sweep)", () => {
    const started = startLink("hermes");
    sweepSessions(Date.now() + 16 * 60_000);
    expect(claimLink(started.claimCode)).toBeNull();
    expect(getSessionByAgentToken(started.agentToken)).toBeNull();
  });

  it("claimed sessions survive the claim TTL but expire after 24h", () => {
    const { started } = pair();
    sweepSessions(Date.now() + 16 * 60_000);
    expect(getSessionByAgentToken(started.agentToken)).not.toBeNull();
    sweepSessions(Date.now() + 25 * 60 * 60_000);
    expect(getSessionByAgentToken(started.agentToken)).toBeNull();
  });

  it("sessionSummary never leaks tokens", () => {
    const { started } = pair();
    const summary = sessionSummary(getSessionByAgentToken(started.agentToken)!);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(started.agentToken);
    expect(summary.linked).toBe(true);
    expect(summary.agentName).toBe("hermes");
  });
});

describe("agentLink — jobs", () => {
  it("createJob requires a claimed browser token", () => {
    const created = createJob("nope", { endpoint: ALLOWED[0]!.endpoint, body: {} }, ALLOWED);
    expect(created.ok).toBe(false);
  });

  it("createJob rejects endpoints outside the whitelist", () => {
    const { claimed } = pair();
    const created = createJob(
      claimed.browserToken,
      { endpoint: "https://evil.example/steal", body: {} },
      ALLOWED
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error).toBe("Unknown endpoint");
  });

  it("createJob rejects oversized bodies", () => {
    const { claimed } = pair();
    const created = createJob(
      claimed.browserToken,
      { endpoint: ALLOWED[0]!.endpoint, body: { blob: "x".repeat(5000) } },
      ALLOWED
    );
    expect(created.ok).toBe(false);
  });

  it("caps concurrent pending jobs at 3", () => {
    const { claimed } = pair();
    for (let i = 0; i < 3; i++) {
      const created = createJob(
        claimed.browserToken,
        { endpoint: ALLOWED[0]!.endpoint, body: { ticker: "AAPL" } },
        ALLOWED
      );
      expect(created.ok).toBe(true);
    }
    const fourth = createJob(
      claimed.browserToken,
      { endpoint: ALLOWED[0]!.endpoint, body: { ticker: "AAPL" } },
      ALLOWED
    );
    expect(fourth.ok).toBe(false);
  });

  it("pollJobs returns pending jobs and requires the agent token", () => {
    const { started, claimed } = pair();
    createJob(claimed.browserToken, { endpoint: ALLOWED[0]!.endpoint, body: { ticker: "TSLA" } }, ALLOWED);
    expect(pollJobs("bogus")).toBeNull();
    const polled = pollJobs(started.agentToken)!;
    expect(polled.claimed).toBe(true);
    expect(polled.jobs).toHaveLength(1);
    expect(polled.jobs[0]!.priceUsd).toBe("0.29");
  });

  it("completeJob stores the result + payment receipt and is idempotent-guarded", () => {
    const { started, claimed } = pair();
    const created = createJob(
      claimed.browserToken,
      { endpoint: ALLOWED[0]!.endpoint, body: { ticker: "NVDA" } },
      ALLOWED
    );
    const jobId = created.ok ? created.job.jobId : "";
    const result = { verdict: "neutral", payment: { transaction: "0xdead", network: "base" } };

    const done = completeJob(started.agentToken, { jobId, ok: true, result });
    expect(done.ok).toBe(true);

    const job = getJob(claimed.browserToken, jobId)!;
    expect(job.status).toBe("done");
    expect(job.result).toEqual(result);
    expect(job.payment).toEqual({ transaction: "0xdead", network: "base" });

    // A second completion is rejected.
    const again = completeJob(started.agentToken, { jobId, ok: true, result });
    expect(again.ok).toBe(false);
  });

  it("completeJob rejects a token from a different session", () => {
    const a = pair();
    const b = pair();
    const created = createJob(
      a.claimed.browserToken,
      { endpoint: ALLOWED[0]!.endpoint, body: {} },
      ALLOWED
    );
    const jobId = created.ok ? created.job.jobId : "";
    const crossed = completeJob(b.started.agentToken, { jobId, ok: true, result: {} });
    expect(crossed.ok).toBe(false);
  });

  it("getJob is scoped to the owning browser", () => {
    const a = pair();
    const b = pair();
    const created = createJob(
      a.claimed.browserToken,
      { endpoint: ALLOWED[0]!.endpoint, body: {} },
      ALLOWED
    );
    const jobId = created.ok ? created.job.jobId : "";
    expect(getJob(b.claimed.browserToken, jobId)).toBeNull();
    expect(getJob(a.claimed.browserToken, jobId)).not.toBeNull();
  });

  it("failed jobs carry the agent's error", () => {
    const { started, claimed } = pair();
    const created = createJob(
      claimed.browserToken,
      { endpoint: ALLOWED[0]!.endpoint, body: {} },
      ALLOWED
    );
    const jobId = created.ok ? created.job.jobId : "";
    completeJob(started.agentToken, { jobId, ok: false, error: "wallet empty" });
    const job = getJob(claimed.browserToken, jobId)!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("wallet empty");
    expect(getSessionByBrowserToken(claimed.browserToken)).not.toBeNull();
  });
});
