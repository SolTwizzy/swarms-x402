import type { IAgentRuntime } from "@elizaos/core";
import type { PaymentRequired } from "@dexterai/x402/server";
import { X402ServerService } from "./x402ServerService.js";
import {
  buildMeridianRequirements,
  buildPublicAccepts,
  decodeMeridianPaymentHeader,
  getMeridianApiKey,
  getMeridianCreditedRecipient,
  getMeridianNetworkByAny,
  isMeridianPayment,
  settleMeridianPayment,
} from "./meridianGate.js";

/**
 * Result of the x402 payment gate check.
 */
export interface X402GateResult {
  paid: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  amountUsd: number;
  /** Remaining free tier calls (only set when free tier is used). */
  freeRemaining?: number;
}

/**
 * Options for the x402 payment gate.
 */
export interface X402GateOptions {
  /** Amount in USD (e.g. "0.05") */
  amountUsd: string;
  /** Human-readable description of the endpoint */
  description?: string;
  /** Full resource URL (constructed from request if not provided) */
  resourceUrl?: string;
  /** Enable free tier (3 calls/day per IP + cookie). Default: true in production. */
  freeTierEnabled?: boolean;
  /** Additional payment options to advertise alongside the Dexter requirement. */
  extraAccepts?: ReadonlyArray<object>;
}

/**
 * Convert USD to USDC atomic units (6 decimals).
 */
function usdToAtomic(usd: string): string {
  const parsed = parseFloat(usd);
  if (Number.isNaN(parsed) || parsed < 0) {
    return "0";
  }
  return String(Math.round(parsed * 1_000_000));
}

/**
 * x402 payment gate for ElizaOS route handlers.
 *
 * Checks for payment in the request. If absent, sends a 402 response.
 * If present, verifies and settles the payment.
 *
 * Usage in a route handler:
 * ```
 * const gate = await x402Gate(runtime, req, { amountUsd: "0.05" });
 * if (!gate.paid) return; // 402 already sent
 * // Payment verified — proceed with response
 * ```
 */
// ── Free Tier: 3 calls/day per IP + cookie ───────────────────────────────────

const FREE_TIER_LIMIT = 3;
const freeTierMap = new Map<string, { count: number; resetAt: number }>();

/** Running total of free tier calls (resets when all IPs expire). */
let freeTierGlobalCount = 0;
/** Last milestone that triggered an alert (e.g. 100, 200, 300...). */
let lastAlertMilestone = 0;

/**
 * Optional callback invoked every 100 free tier calls.
 * Registered by the server to send Telegram alerts without circular imports.
 */
let onMilestoneCallback: ((stats: FreeTierStats) => void) | null = null;

/**
 * Register a callback that fires every 100 free tier calls.
 * Call this from server.ts after import.
 */
export function onFreeTierMilestone(cb: (stats: FreeTierStats) => void): void {
  onMilestoneCallback = cb;
}

// Reset daily
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of freeTierMap) {
    if (now >= entry.resetAt) freeTierMap.delete(ip);
  }
}, 300_000); // clean every 5 min

/**
 * Free tier usage statistics.
 */
export interface FreeTierStats {
  totalFreeCallsToday: number;
  uniqueIPs: number;
  topIPs: Array<{ ip: string; calls: number }>;
}

/**
 * Returns current free tier usage stats across all tracked IPs.
 */
export function getFreeTierStats(): FreeTierStats {
  let totalFreeCallsToday = 0;
  const entries: Array<{ ip: string; calls: number }> = [];

  for (const [ip, entry] of freeTierMap) {
    totalFreeCallsToday += entry.count;
    entries.push({ ip, calls: entry.count });
  }

  // Sort descending by calls, take top 20
  entries.sort((a, b) => b.calls - a.calls);
  const topIPs = entries.slice(0, 20);

  return {
    totalFreeCallsToday,
    uniqueIPs: freeTierMap.size,
    topIPs,
  };
}

/**
 * Parse the swarmx_usage cookie from the cookie header string.
 * Returns the usage count from the cookie, or 0 if not present.
 */
function parseCookieUsage(req: { headers?: Record<string, string | string[] | undefined> }): number {
  const headers = req.headers ?? {};
  const cookieHeader = headers["cookie"];
  if (!cookieHeader || typeof cookieHeader !== "string") return 0;
  const match = cookieHeader.match(/swarmx_usage=(\d+)/);
  if (!match?.[1]) return 0;
  const val = parseInt(match[1], 10);
  return Number.isNaN(val) ? 0 : val;
}

/**
 * Check free tier eligibility using MAX(cookie_count, ip_count).
 * Returns remaining calls (>= 0) if allowed, or -1 if exhausted.
 * When allowed, increments both counters.
 */
function checkFreeTier(req: { headers?: Record<string, string | string[] | undefined> }): number {
  const headers = req.headers ?? {};
  const forwarded = headers["x-forwarded-for"];
  const ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "unknown";

  const now = Date.now();
  const dayMs = 86_400_000;
  let entry = freeTierMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + dayMs };
    freeTierMap.set(ip, entry);
  }

  // Use MAX(cookie_count, ip_count) — both must be under limit
  const cookieCount = parseCookieUsage(req);
  const effectiveCount = Math.max(cookieCount, entry.count);

  if (effectiveCount < FREE_TIER_LIMIT) {
    entry.count = effectiveCount + 1;
    freeTierGlobalCount++;

    // Fire milestone callback every 100 free tier calls
    const currentMilestone = Math.floor(freeTierGlobalCount / 100) * 100;
    if (currentMilestone > 0 && currentMilestone > lastAlertMilestone) {
      lastAlertMilestone = currentMilestone;
      if (onMilestoneCallback) {
        try {
          onMilestoneCallback(getFreeTierStats());
        } catch {
          // never block the request flow
        }
      }
    }

    const remaining = FREE_TIER_LIMIT - entry.count;
    return remaining; // >= 0, free call allowed
  }
  return -1; // free tier exhausted
}

export async function x402Gate(
  runtime: IAgentRuntime,
  req: { headers?: Record<string, string | string[] | undefined>; url?: string; method?: string },
  res: { status?: (code: number) => any; json?: (body: any) => void; setHeader?: (name: string, value: string) => void },
  options: X402GateOptions
): Promise<X402GateResult> {
  // Step 1: Check if sell-side x402 server is configured
  const serverService = runtime.getService<X402ServerService>("X402_SERVER" as any);

  if (!serverService?.isAvailable()) {
    // No server configured — let request through for free (graceful degradation)
    return { paid: false, amountUsd: 0 };
  }

  // Step 2: Look for payment signature in request headers
  const server = serverService.getServer();
  const headers = req.headers ?? {};

  // Check for payment signature header (case-insensitive)
  const paymentHeader =
    (headers["payment-signature"] as string) ??
    (headers["PAYMENT-SIGNATURE"] as string) ??
    (headers["x-payment"] as string) ??
    null;

  // Discovery probes (x402scan, Bazaar indexers) send unauthenticated requests
  // with an empty body — they must reach the 402 challenge, never a free-tier
  // 200 or a handler-level 400. All paid routes are POST with required fields,
  // so "no payment + no body" is never a legitimate free-tier call.
  const probeBody = (req as { body?: unknown }).body;
  const hasRequestInput =
    probeBody !== null &&
    typeof probeBody === "object" &&
    Object.keys(probeBody as Record<string, unknown>).length > 0;

  // Step 2a: Free tier — 3 calls/day per IP + cookie without payment
  // Enabled by default in production. Disable with freeTierEnabled: false in tests.
  const freeTierOn = options.freeTierEnabled ?? (typeof process !== "undefined" && process.env.NODE_ENV !== "test");
  if (!paymentHeader && freeTierOn && hasRequestInput) {
    const remaining = checkFreeTier(req);
    if (remaining >= 0) {
      // Set cookie and remaining-count header so clients can track usage
      const newCount = FREE_TIER_LIMIT - remaining;
      if (res.setHeader) {
        res.setHeader("Set-Cookie", `swarmx_usage=${newCount}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
        res.setHeader("X-SwarmX-Free-Remaining", String(remaining));
      }
      return { paid: true, amountUsd: 0, freeRemaining: remaining }; // free call — no payment needed
    }
  }

  // Step 3: No payment and free tier exhausted — send 402
  if (!paymentHeader) {
    // No payment — send 402 with requirements
    try {
      // Proxy-terminated TLS means req.url arrives http:// — the advertised
      // resource must be the public https URL.
      const resourceUrl = (options.resourceUrl ?? req.url ?? "/unknown").replace(
        /^http:\/\//,
        "https://"
      );
      const publicRequirements = await buildPublicAccepts(runtime, {
        amountAtomic: usdToAtomic(options.amountUsd),
        resourceUrl,
        description: options.description,
        extraAccepts: options.extraAccepts,
      });
      const requirements = publicRequirements.dexterRequirements;
      if (!requirements) {
        throw new Error("Dexter payment requirements unavailable");
      }

      // Dexter's encoder is shape-agnostic base64 JSON at runtime, but its
      // public signature requires the SDK's stricter PaymentRequired type.
      const encoded = server.encodeRequirements(requirements as PaymentRequired);

      if (res.setHeader) {
        res.setHeader("PAYMENT-REQUIRED", encoded);
      }
      if (res.status && res.json) {
        // x402 v1 challenge body — discovery validators (x402scan, Bazaar)
        // require a non-empty `accepts` array in the JSON body, not just
        // the encoded PAYMENT-REQUIRED header.
        // Backfill v1 fields (resource/description/mimeType) that strict
        // schema validators require — same shape as /discovery/resources.
        const body: Record<string, unknown> = {
          x402Version: 1,
          error: "Payment required",
          description: options.description,
          amount: options.amountUsd,
          network: serverService.getNetwork(),
          payTo: serverService.getReceiveAddress(),
          accepts: publicRequirements.accepts,
        };
        res.status(402).json(body);
      }
    } catch (err) {
      runtime.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "[x402Gate] Failed to build payment requirements"
      );
      if (res.status && res.json) {
        res.status(500).json({ error: "Payment gate error" });
      }
    }

    return { paid: false, amountUsd: 0 };
  }

  // Meridian uses the standard x402 v1 payload dialect. It replaces Dexter
  // only for EVM; all other headers fall through.
  if (isMeridianPayment(paymentHeader)) {
    const paymentPayload = decodeMeridianPaymentHeader(paymentHeader);
    const apiKey = getMeridianApiKey(runtime);
    const creditedRecipient = getMeridianCreditedRecipient(runtime);
    const meridianNetwork =
      typeof paymentPayload?.network === "string"
        ? getMeridianNetworkByAny(paymentPayload.network)
        : undefined;

    if (
      !apiKey ||
      !creditedRecipient ||
      !meridianNetwork ||
      meridianNetwork.paymentType !== "eip3009"
    ) {
      const reason = !apiKey
        ? "meridian_disabled"
        : !creditedRecipient
          ? "missing_credited_recipient"
          : "unsupported_meridian_network";
      if (res.status && res.json) {
        res.status(402).json({
          error: "Meridian payment settlement failed",
          reason,
        });
      }
      return { paid: false, amountUsd: 0 };
    }

    const resourceUrl = (options.resourceUrl ?? req.url ?? "/unknown").replace(
      /^http:\/\//,
      "https://"
    );
    const requirements = buildMeridianRequirements({
      caip2: meridianNetwork.caip2,
      amountAtomic: usdToAtomic(options.amountUsd),
      resourceUrl,
      description: options.description ?? "Paid endpoint",
      creditedRecipient,
    });
    const settlement = await settleMeridianPayment(
      paymentHeader,
      requirements,
      apiKey
    );

    if (!settlement.success) {
      if (res.status && res.json) {
        res.status(402).json({
          error: "Meridian payment settlement failed",
          reason: settlement.errorReason ?? "Unknown",
        });
      }
      return { paid: false, amountUsd: 0 };
    }

    const amountUsd = parseFloat(options.amountUsd);
    serverService.recordRevenue({
      endpoint: req.url ?? "/unknown",
      amountUsd,
      txHash: settlement.transaction ?? "",
      network: settlement.network,
      payer: settlement.payer ?? "",
      timestamp: Date.now(),
    });

    return {
      paid: true,
      transaction: settlement.transaction,
      network: settlement.network,
      payer: settlement.payer,
      amountUsd,
    };
  }

  // Payment header present — verify and settle
  let paymentNetwork: string | undefined;
  try {
    const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString());
    paymentNetwork =
      typeof decoded?.accepted?.network === "string"
        ? decoded.accepted.network
        : undefined;
  } catch {
    // Unknown/legacy payment header shape — use the primary server.
  }
  const paymentServer = paymentNetwork
    ? serverService.getServerFor(paymentNetwork) ?? server
    : server;

  try {
    const accept = await paymentServer.getPaymentAccept({
      amountAtomic: usdToAtomic(options.amountUsd),
      resourceUrl: options.resourceUrl ?? req.url ?? "/unknown",
      description: options.description,
    });

    const verifyResult = await paymentServer.verifyPayment(paymentHeader, accept);
    if (!(verifyResult as any).isValid && !(verifyResult as any).valid) {
      if (res.status && res.json) {
        res.status(402).json({
          error: "Payment verification failed",
          reason: (verifyResult as any).invalidReason ?? "Unknown",
        });
      }
      return { paid: false, amountUsd: 0 };
    }

    const settleResult = await paymentServer.settlePayment(paymentHeader, accept);
    if (!settleResult.success) {
      if (res.status && res.json) {
        res.status(402).json({
          error: "Payment settlement failed",
          reason: (settleResult as any).errorReason ?? "Unknown",
        });
      }
      return { paid: false, amountUsd: 0 };
    }

    const amountUsd = parseFloat(options.amountUsd);

    // Record revenue
    serverService.recordRevenue({
      endpoint: req.url ?? "/unknown",
      amountUsd,
      txHash: settleResult.transaction ?? "",
      network: settleResult.network ?? paymentNetwork ?? serverService.getNetwork(),
      payer: (settleResult as any).payer ?? "",
      timestamp: Date.now(),
    });

    return {
      paid: true,
      transaction: settleResult.transaction ?? undefined,
      network: settleResult.network ?? undefined,
      payer: (settleResult as any).payer ?? undefined,
      amountUsd,
    };
  } catch (err) {
    runtime.logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "[x402Gate] Payment verification/settlement error"
    );
    if (res.status && res.json) {
      res.status(500).json({ error: "Payment processing error" });
    }
    return { paid: false, amountUsd: 0 };
  }
}
