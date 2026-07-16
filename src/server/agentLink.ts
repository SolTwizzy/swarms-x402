/**
 * SwarmX Agent Link — pair a browser session with a wallet-holding agent.
 *
 * Moltbook-style flow: the agent (OpenClaw, Hermes, Claude Code, any MCP or
 * HTTP client) calls `startLink()` and receives a one-time magic claim URL to
 * hand to its human. The human opens it in the browser, which binds the
 * browser (cookie token) to the agent (bearer token). The browser then queues
 * paid-endpoint jobs; the agent polls, pays the endpoint with ITS OWN wallet
 * via x402, and posts the result back. SwarmX never touches the agent's keys.
 *
 * Storage is in-memory by design (the VPS deploy is stateless, no DB):
 * sessions die on redeploy, which is acceptable for v1 pairing sessions.
 *
 * @module
 */

import { randomBytes } from "node:crypto";

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Unclaimed links expire after 15 minutes. */
const CLAIM_TTL_MS = 15 * 60_000;
/** Claimed sessions live for 24 hours. */
const SESSION_TTL_MS = 24 * 60 * 60_000;
/** Agent is shown as "online" if it polled within this window. */
const ONLINE_WINDOW_MS = 60_000;
/** Max concurrent pending jobs per session. */
const MAX_PENDING_JOBS = 3;
/** Max jobs per session lifetime. */
const MAX_JOBS_PER_SESSION = 50;
/** Max tracked sessions (oldest evicted first). */
const MAX_SESSIONS = 500;
/** Max serialized job body size in bytes. */
const MAX_BODY_BYTES = 4096;

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentJobStatus = "pending" | "done" | "failed";

export interface AgentJob {
  jobId: string;
  endpoint: string;
  method: "GET" | "POST";
  body: Record<string, unknown>;
  priceUsd: string;
  description: string;
  status: AgentJobStatus;
  createdAt: number;
  completedAt: number | null;
  /** Full JSON result from the paid endpoint (set by the agent on complete). */
  result: unknown;
  error: string | null;
  /** Payment receipt extracted from the result (transaction/network/payer). */
  payment: Record<string, unknown> | null;
}

export interface AgentSession {
  sessionId: string;
  agentToken: string;
  browserToken: string | null;
  claimCode: string | null;
  agentName: string;
  createdAt: number;
  claimedAt: number | null;
  lastAgentSeen: number;
  jobsCreated: number;
  jobs: Map<string, AgentJob>;
}

/** A paid endpoint the browser is allowed to queue jobs for. */
export interface AllowedEndpoint {
  endpoint: string;
  method: "GET" | "POST";
  priceUsd: string;
  description: string;
}

// ── Store ────────────────────────────────────────────────────────────────────

const sessionsById = new Map<string, AgentSession>();
const sessionsByClaim = new Map<string, AgentSession>();
const sessionsByAgentToken = new Map<string, AgentSession>();
const sessionsByBrowserToken = new Map<string, AgentSession>();

function token(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** Short, unambiguous, URL-friendly claim code like "K7QF-3MHP". */
function claimCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1
  const raw = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[raw[i]! % alphabet.length];
    if (i === 3) out += "-";
  }
  return out;
}

function now(): number {
  return Date.now();
}

function isExpired(session: AgentSession, at: number): boolean {
  if (session.claimedAt === null) {
    return at - session.createdAt > CLAIM_TTL_MS;
  }
  return at - session.claimedAt > SESSION_TTL_MS;
}

function dropSession(session: AgentSession): void {
  sessionsById.delete(session.sessionId);
  if (session.claimCode) sessionsByClaim.delete(session.claimCode);
  sessionsByAgentToken.delete(session.agentToken);
  if (session.browserToken) sessionsByBrowserToken.delete(session.browserToken);
}

/** Remove expired sessions; evict oldest when over capacity. */
export function sweepSessions(at: number = now()): void {
  for (const session of sessionsById.values()) {
    if (isExpired(session, at)) dropSession(session);
  }
  if (sessionsById.size > MAX_SESSIONS) {
    const oldest = [...sessionsById.values()].sort(
      (a, b) => a.createdAt - b.createdAt
    );
    for (const session of oldest.slice(0, sessionsById.size - MAX_SESSIONS)) {
      dropSession(session);
    }
  }
}

/** Test-only: clear all sessions. */
export function resetAgentLinkStore(): void {
  sessionsById.clear();
  sessionsByClaim.clear();
  sessionsByAgentToken.clear();
  sessionsByBrowserToken.clear();
}

// ── Pairing ──────────────────────────────────────────────────────────────────

export interface StartLinkResult {
  sessionId: string;
  agentToken: string;
  claimCode: string;
  expiresInSeconds: number;
}

/** Agent-side: mint a new link session and its one-time claim code. */
export function startLink(agentName?: string): StartLinkResult {
  sweepSessions();
  const session: AgentSession = {
    sessionId: token(9),
    agentToken: token(24),
    browserToken: null,
    claimCode: claimCode(),
    agentName: sanitizeName(agentName) || "agent",
    createdAt: now(),
    claimedAt: null,
    lastAgentSeen: now(),
    jobsCreated: 0,
    jobs: new Map(),
  };
  sessionsById.set(session.sessionId, session);
  sessionsByClaim.set(session.claimCode!, session);
  sessionsByAgentToken.set(session.agentToken, session);
  return {
    sessionId: session.sessionId,
    agentToken: session.agentToken,
    claimCode: session.claimCode!,
    expiresInSeconds: Math.floor(CLAIM_TTL_MS / 1000),
  };
}

function sanitizeName(name: unknown): string {
  if (typeof name !== "string") return "";
  return name.replace(/[^\w .-]/g, "").trim().slice(0, 40);
}

/** Browser-side: claim a magic link. Single-use; returns the cookie token. */
export function claimLink(
  code: string
): { browserToken: string; agentName: string } | null {
  const normalized = code.trim().toUpperCase();
  const session = sessionsByClaim.get(normalized);
  if (!session || isExpired(session, now()) || session.claimedAt !== null) {
    return null;
  }
  session.claimedAt = now();
  session.browserToken = token(24);
  sessionsByClaim.delete(normalized);
  session.claimCode = null;
  sessionsByBrowserToken.set(session.browserToken, session);
  return { browserToken: session.browserToken, agentName: session.agentName };
}

function liveSession(
  map: Map<string, AgentSession>,
  key: string | undefined | null
): AgentSession | null {
  if (!key) return null;
  const session = map.get(key);
  if (!session) return null;
  if (isExpired(session, now())) {
    dropSession(session);
    return null;
  }
  return session;
}

export function getSessionByAgentToken(t: string | null | undefined): AgentSession | null {
  return liveSession(sessionsByAgentToken, t);
}

export function getSessionByBrowserToken(t: string | null | undefined): AgentSession | null {
  return liveSession(sessionsByBrowserToken, t);
}

/** Browser-facing session summary (never leaks tokens). */
export function sessionSummary(session: AgentSession): Record<string, unknown> {
  return {
    linked: session.claimedAt !== null,
    agentName: session.agentName,
    agentOnline: now() - session.lastAgentSeen < ONLINE_WINDOW_MS,
    lastAgentSeenSecondsAgo: Math.floor((now() - session.lastAgentSeen) / 1000),
  };
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export interface CreateJobInput {
  endpoint: string;
  body: Record<string, unknown>;
}

export type CreateJobResult =
  | { ok: true; job: AgentJob }
  | { ok: false; error: string };

/**
 * Browser-side: queue a paid job for the linked agent.
 * The endpoint must be one of the platform's own paid endpoints.
 */
export function createJob(
  browserToken: string | null | undefined,
  input: CreateJobInput,
  allowedEndpoints: ReadonlyArray<AllowedEndpoint>
): CreateJobResult {
  const session = getSessionByBrowserToken(browserToken);
  if (!session) return { ok: false, error: "Not linked to an agent" };

  const allowed = allowedEndpoints.find((e) => e.endpoint === input.endpoint);
  if (!allowed) return { ok: false, error: "Unknown endpoint" };

  const body =
    input.body && typeof input.body === "object" && !Array.isArray(input.body)
      ? input.body
      : {};
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return { ok: false, error: "Request body too large" };
  }

  const pending = [...session.jobs.values()].filter(
    (j) => j.status === "pending"
  ).length;
  if (pending >= MAX_PENDING_JOBS) {
    return { ok: false, error: "Too many pending jobs — wait for your agent" };
  }
  if (session.jobsCreated >= MAX_JOBS_PER_SESSION) {
    return { ok: false, error: "Session job limit reached — relink your agent" };
  }

  const job: AgentJob = {
    jobId: token(9),
    endpoint: allowed.endpoint,
    method: allowed.method,
    body,
    priceUsd: allowed.priceUsd,
    description: allowed.description,
    status: "pending",
    createdAt: now(),
    completedAt: null,
    result: null,
    error: null,
    payment: null,
  };
  session.jobs.set(job.jobId, job);
  session.jobsCreated++;
  return { ok: true, job };
}

/** Agent-side: list pending jobs (marks the agent as seen). */
export function pollJobs(
  agentToken: string | null | undefined
): { claimed: boolean; jobs: AgentJob[] } | null {
  const session = getSessionByAgentToken(agentToken);
  if (!session) return null;
  session.lastAgentSeen = now();
  return {
    claimed: session.claimedAt !== null,
    jobs: [...session.jobs.values()].filter((j) => j.status === "pending"),
  };
}

export interface CompleteJobInput {
  jobId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Agent-side: post the paid result (or failure) for a job. */
export function completeJob(
  agentToken: string | null | undefined,
  input: CompleteJobInput
): { ok: true } | { ok: false; error: string } {
  const session = getSessionByAgentToken(agentToken);
  if (!session) return { ok: false, error: "Invalid agent token" };
  session.lastAgentSeen = now();
  const job = session.jobs.get(input.jobId);
  if (!job) return { ok: false, error: "Unknown job" };
  if (job.status !== "pending") return { ok: false, error: "Job already completed" };

  job.completedAt = now();
  if (input.ok) {
    job.status = "done";
    job.result = input.result ?? null;
    const payment = (input.result as Record<string, unknown> | null)?.[
      "payment"
    ];
    job.payment =
      payment && typeof payment === "object"
        ? (payment as Record<string, unknown>)
        : null;
  } else {
    job.status = "failed";
    job.error =
      typeof input.error === "string" && input.error.trim()
        ? input.error.slice(0, 500)
        : "Agent reported failure";
  }
  return { ok: true };
}

/** Browser-side: read one job's status/result. */
export function getJob(
  browserToken: string | null | undefined,
  jobId: string
): AgentJob | null {
  const session = getSessionByBrowserToken(browserToken);
  if (!session) return null;
  return session.jobs.get(jobId) ?? null;
}

// ── Periodic sweep ───────────────────────────────────────────────────────────

const sweepTimer = setInterval(() => sweepSessions(), 60_000);
// Never keep the process alive just for the sweeper (also calms test runners).
if (typeof (sweepTimer as { unref?: () => void }).unref === "function") {
  (sweepTimer as unknown as { unref: () => void }).unref();
}
