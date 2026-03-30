import type { Route } from "@elizaos/core";
import { x402Gate } from "../server/x402Gate.js";
import { X402ServerService } from "../server/x402ServerService.js";
import type { X402ServiceEndpoint } from "../types.js";
import { TTLCache } from "../utils/cache.js";
import { SOLANA_ADDR_RE, heliusRpcUrl, rpcCall } from "./heliusDataRoutes.js";

// ── Per-endpoint caches with aggressive TTLs for HFT ────────────────────────
const priceCache = new TTLCache<any>(5_000); // 5s — bots need fresh prices
const supplyCache = new TTLCache<any>(30_000); // 30s — supply rarely changes
const slotCache = new TTLCache<any>(2_000); // 2s — network health
const tokenAccountsCache = new TTLCache<any>(10_000); // 10s — portfolio
const blockhashCache = new TTLCache<any>(5_000); // 5s — tx building

// ── Rate limit error cache (1s TTL) — prevents hammering Helius on 429s ────
const errorCache = new TTLCache<string>(1_000);
const HELIUS_ERROR_KEY = "helius:rate-limit";

/**
 * Check if a trading data endpoint should short-circuit with 503.
 * Returns a reason string if unavailable, or null if OK to proceed.
 */
function tradingUnavailableReason(runtime: any): string | null {
  // Check if Helius API key is configured
  const heliusKey = runtime.getSetting("HELIUS_API_KEY");
  if (!heliusKey) {
    return "Trading data endpoints temporarily unavailable — HELIUS_API_KEY not configured. Use access passes for high-frequency data access.";
  }
  // Check if we recently hit a rate limit
  const cached = errorCache.get(HELIUS_ERROR_KEY);
  if (cached) {
    return "Trading data endpoints temporarily unavailable due to rate limiting. Use access passes for high-frequency data access.";
  }
  return null;
}

/**
 * Record a rate-limit error so subsequent requests short-circuit for 1s.
 */
function recordRateLimitError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (/rate.limit|429|max.usage|too.many/i.test(msg)) {
    errorCache.set(HELIUS_ERROR_KEY, msg);
  }
}

// ── Catalog entries ─────────────────────────────────────────────────────────
export const TRADING_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "Token Price",
    description:
      "Real-time token price in USD via Jupiter — sub-second cached, designed for HFT bot loops",
    path: "/x402/token-price",
    method: "POST",
    priceUsd: "0.001",
  },
  {
    name: "Token Supply",
    description:
      "Get total supply and decimals for any SPL token mint via Solana RPC",
    path: "/x402/token-supply",
    method: "POST",
    priceUsd: "0.001",
  },
  {
    name: "Slot Info",
    description:
      "Current Solana slot and block time — network health monitoring for trading bots",
    path: "/x402/slot-info",
    method: "POST",
    priceUsd: "0.001",
  },
  {
    name: "Token Accounts",
    description:
      "List all SPL token accounts for a wallet — portfolio monitoring with optional mint filter",
    path: "/x402/token-accounts",
    method: "POST",
    priceUsd: "0.002",
  },
  {
    name: "Recent Blockhash",
    description:
      "Get latest blockhash for transaction building — every bot needs this before submitting a tx",
    path: "/x402/recent-blockhash",
    method: "POST",
    priceUsd: "0.001",
  },
];

// ── Helius DAS Price helper ────────────────────────────────────────────────

async function fetchHeliusPrice(
  mint: string,
  rpcUrl: string
): Promise<{ priceUsd: number; confidence: string } | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAsset",
        params: { id: mint, displayOptions: { showFungible: true } },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const result = json?.result;
    if (!result) return null;

    // Helius DAS returns token_info.price_info for fungible tokens
    const priceInfo = result?.token_info?.price_info;
    if (priceInfo?.price_per_token) {
      return {
        priceUsd: priceInfo.price_per_token,
        confidence: priceInfo.confidence ?? "high",
      };
    }

    // Fallback: check content metadata for NFT floor price
    const floorPrice = result?.content?.metadata?.price;
    if (floorPrice) {
      return { priceUsd: parseFloat(floorPrice), confidence: "low" };
    }

    return null;
  } catch {
    return null;
  }
}

// ── Route definitions ───────────────────────────────────────────────────────

export const tradingRoutes: Route[] = [
  // ── POST /x402/token-price — $0.001 ──────────────────────────────────
  {
    type: "POST",
    path: "/x402/token-price",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.001",
        description: "Real-time token price via Helius DAS",
      });
      if (!gate.paid) return;

      const unavailable = tradingUnavailableReason(runtime);
      if (unavailable) {
        (res as any).status(503).json({ error: unavailable });
        return;
      }

      const body = (req as any).body ?? {};
      const mint: unknown = body.mint;
      if (!mint || typeof mint !== "string") {
        (res as any).status(400).json({ error: "Missing required field: mint (SPL token mint address)" });
        return;
      }
      if (!SOLANA_ADDR_RE.test(mint)) {
        (res as any).status(400).json({ error: "Invalid mint address format" });
        return;
      }

      try {
        const cacheKey = `price:${mint}`;
        const cached = priceCache.get(cacheKey);
        if (cached) {
          (res as any).json({
            ...cached,
            cached: true,
            payment: {
              amount: "0.001",
              transaction: gate.transaction,
              network: gate.network,
            },
          });
          return;
        }

        const heliusKey = String(runtime.getSetting("HELIUS_API_KEY") ?? "");
        const rpcUrl = heliusRpcUrl(heliusKey);
        const result = await fetchHeliusPrice(mint, rpcUrl);
        if (!result) {
          (res as any).status(404).json({ error: "Price not available for this token" });
          return;
        }

        const payload = {
          mint,
          priceUsd: result.priceUsd,
          confidence: result.confidence,
          source: "helius",
          timestamp: Date.now(),
          queriedAt: new Date().toISOString(),
        };
        priceCache.set(cacheKey, payload);

        (res as any).json({
          ...payload,
          cached: false,
          payment: {
            amount: "0.001",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        recordRateLimitError(err);
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[token-price] Fetch failed"
        );
        (res as any).status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/token-supply — $0.001 ─────────────────────────────────
  {
    type: "POST",
    path: "/x402/token-supply",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.001",
        description: "Token supply via Solana RPC",
      });
      if (!gate.paid) return;

      const unavailable = tradingUnavailableReason(runtime);
      if (unavailable) {
        (res as any).status(503).json({ error: unavailable });
        return;
      }

      const body = (req as any).body ?? {};
      const mint: unknown = body.mint;
      if (!mint || typeof mint !== "string") {
        (res as any).status(400).json({ error: "Missing required field: mint (SPL token mint address)" });
        return;
      }
      if (!SOLANA_ADDR_RE.test(mint)) {
        (res as any).status(400).json({ error: "Invalid mint address format" });
        return;
      }

      try {
        const cacheKey = `supply:${mint}`;
        const cached = supplyCache.get(cacheKey);
        if (cached) {
          (res as any).json({
            ...cached,
            cached: true,
            payment: {
              amount: "0.001",
              transaction: gate.transaction,
              network: gate.network,
            },
          });
          return;
        }

        const rpcUrl = heliusRpcUrl(String(runtime.getSetting("HELIUS_API_KEY")));
        const result = await rpcCall(rpcUrl, "getTokenSupply", [mint]);
        const value = result?.value;
        if (!value) {
          (res as any).status(404).json({ error: "Token mint not found" });
          return;
        }

        const payload = {
          mint,
          supply: value.uiAmountString ?? String(value.uiAmount),
          rawSupply: value.amount,
          decimals: value.decimals,
          timestamp: Date.now(),
          queriedAt: new Date().toISOString(),
        };
        supplyCache.set(cacheKey, payload);

        (res as any).json({
          ...payload,
          cached: false,
          payment: {
            amount: "0.001",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        recordRateLimitError(err);
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[token-supply] Fetch failed"
        );
        (res as any).status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/slot-info — $0.001 ────────────────────────────────────
  {
    type: "POST",
    path: "/x402/slot-info",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.001",
        description: "Current Solana slot and block time",
      });
      if (!gate.paid) return;

      const unavailable = tradingUnavailableReason(runtime);
      if (unavailable) {
        (res as any).status(503).json({ error: unavailable });
        return;
      }

      try {
        const cacheKey = "slot-info";
        const cached = slotCache.get(cacheKey);
        if (cached) {
          (res as any).json({
            ...cached,
            cached: true,
            payment: {
              amount: "0.001",
              transaction: gate.transaction,
              network: gate.network,
            },
          });
          return;
        }

        const rpcUrl = heliusRpcUrl(String(runtime.getSetting("HELIUS_API_KEY")));

        // Parallel fetch: slot + epoch info
        const [slot, epochInfo] = await Promise.all([
          rpcCall(rpcUrl, "getSlot", []),
          rpcCall(rpcUrl, "getEpochInfo", []),
        ]);

        // Get block time for current slot (may fail for very recent slots)
        let blockTime: number | null = null;
        try {
          blockTime = await rpcCall(rpcUrl, "getBlockTime", [slot]);
        } catch {
          // Block time not yet available for the latest slot — normal
        }

        const payload = {
          slot,
          blockTime,
          blockTimeIso: blockTime ? new Date(blockTime * 1000).toISOString() : null,
          epoch: epochInfo?.epoch ?? null,
          slotIndex: epochInfo?.slotIndex ?? null,
          slotsInEpoch: epochInfo?.slotsInEpoch ?? null,
          timestamp: Date.now(),
          queriedAt: new Date().toISOString(),
        };
        slotCache.set(cacheKey, payload);

        (res as any).json({
          ...payload,
          cached: false,
          payment: {
            amount: "0.001",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        recordRateLimitError(err);
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[slot-info] Fetch failed"
        );
        (res as any).status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/token-accounts — $0.002 ───────────────────────────────
  {
    type: "POST",
    path: "/x402/token-accounts",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.002",
        description: "Token accounts for a wallet",
      });
      if (!gate.paid) return;

      const unavailable = tradingUnavailableReason(runtime);
      if (unavailable) {
        (res as any).status(503).json({ error: unavailable });
        return;
      }

      const body = (req as any).body ?? {};
      const address: unknown = body.address;
      if (!address || typeof address !== "string") {
        (res as any).status(400).json({ error: "Missing required field: address (Solana wallet address)" });
        return;
      }
      if (!SOLANA_ADDR_RE.test(address)) {
        (res as any).status(400).json({ error: "Invalid Solana address format" });
        return;
      }

      const mintFilter: string | undefined =
        typeof body.mint === "string" && SOLANA_ADDR_RE.test(body.mint)
          ? body.mint
          : undefined;

      try {
        const cacheKey = `accounts:${address}:${mintFilter ?? "all"}`;
        const cached = tokenAccountsCache.get(cacheKey);
        if (cached) {
          (res as any).json({
            ...cached,
            cached: true,
            payment: {
              amount: "0.002",
              transaction: gate.transaction,
              network: gate.network,
            },
          });
          return;
        }

        const rpcUrl = heliusRpcUrl(String(runtime.getSetting("HELIUS_API_KEY")));

        // Build filter: by specific mint or all SPL tokens
        const filter = mintFilter
          ? { mint: mintFilter }
          : { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" };

        const result = await rpcCall(rpcUrl, "getTokenAccountsByOwner", [
          address,
          filter,
          { encoding: "jsonParsed" },
        ]);

        const accounts = (result?.value ?? []).map((account: any) => {
          const info = account.account.data.parsed.info;
          return {
            mint: info.mint,
            amount: info.tokenAmount.uiAmountString ?? String(info.tokenAmount.uiAmount ?? 0),
            rawAmount: info.tokenAmount.amount,
            decimals: info.tokenAmount.decimals,
          };
        });

        // Sort by raw amount descending (largest holdings first)
        accounts.sort(
          (a: any, b: any) =>
            parseFloat(b.rawAmount) - parseFloat(a.rawAmount)
        );

        const payload = {
          address,
          mintFilter: mintFilter ?? null,
          accounts,
          accountCount: accounts.length,
          timestamp: Date.now(),
          queriedAt: new Date().toISOString(),
        };
        tokenAccountsCache.set(cacheKey, payload);

        (res as any).json({
          ...payload,
          cached: false,
          payment: {
            amount: "0.002",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        recordRateLimitError(err);
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[token-accounts] Fetch failed"
        );
        (res as any).status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/recent-blockhash — $0.001 ─────────────────────────────
  {
    type: "POST",
    path: "/x402/recent-blockhash",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.001",
        description: "Latest blockhash for transaction building",
      });
      if (!gate.paid) return;

      const unavailable = tradingUnavailableReason(runtime);
      if (unavailable) {
        (res as any).status(503).json({ error: unavailable });
        return;
      }

      try {
        const cacheKey = "recent-blockhash";
        const cached = blockhashCache.get(cacheKey);
        if (cached) {
          (res as any).json({
            ...cached,
            cached: true,
            payment: {
              amount: "0.001",
              transaction: gate.transaction,
              network: gate.network,
            },
          });
          return;
        }

        const rpcUrl = heliusRpcUrl(String(runtime.getSetting("HELIUS_API_KEY")));
        const result = await rpcCall(rpcUrl, "getLatestBlockhash", []);
        const value = result?.value;
        if (!value) {
          (res as any).status(500).json({ error: "Service temporarily unavailable" });
          return;
        }

        const payload = {
          blockhash: value.blockhash,
          lastValidBlockHeight: value.lastValidBlockHeight,
          timestamp: Date.now(),
          queriedAt: new Date().toISOString(),
        };
        blockhashCache.set(cacheKey, payload);

        (res as any).json({
          ...payload,
          cached: false,
          payment: {
            amount: "0.001",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        recordRateLimitError(err);
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[recent-blockhash] Fetch failed"
        );
        (res as any).status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── GET /x402/trading/health — FREE ──────────────────────────────────
  {
    type: "GET",
    path: "/x402/trading/health",
    name: "trading-health",
    public: true,
    handler: async (_req, res, runtime) => {
      const hasHelius = !!runtime.getSetting("HELIUS_API_KEY");
      const serverService = runtime.getService<X402ServerService>("X402_SERVER" as any);

      (res as any).json({
        status: hasHelius ? "ok" : "degraded",
        heliusConfigured: hasHelius,
        receiveAddress: serverService?.getReceiveAddress() ?? "",
        network: serverService?.getNetwork() ?? "",
        endpoints: TRADING_CATALOG.map((e) => ({
          path: e.path,
          price: `$${e.priceUsd}/call`,
          method: e.method,
        })),
        cacheTtls: {
          "token-price": "5s",
          "token-supply": "30s",
          "slot-info": "2s",
          "token-accounts": "10s",
          "recent-blockhash": "5s",
        },
        designedFor: "High-frequency trading bots — low price, short cache TTLs, fast responses",
      });
    },
  },
];
