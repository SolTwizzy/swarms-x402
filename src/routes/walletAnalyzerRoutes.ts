import type { Route } from "@elizaos/core";
import { x402Gate } from "../server/x402Gate.js";
import { X402ServerService } from "../server/x402ServerService.js";
import type { X402ServiceEndpoint } from "../types.js";
import { TTLCache } from "../utils/cache.js";
import {
  heliusRpcUrl,
  rpcCall,
  heliusCache,
  DEFI_PROTOCOL_MINTS,
  SOLANA_ADDR_RE,
} from "./heliusDataRoutes.js";

// ── Shared response cache (30 s TTL) ─────────────────────────────────
const cache = new TTLCache<any>(30_000);

/**
 * Catalog entry for the wallet analyzer.
 */
export const WALLET_ANALYZER_CATALOG: X402ServiceEndpoint = {
  name: "Solana Wallet Analyzer",
  description:
    "Analyze any Solana wallet — returns SOL balance, token holdings with USD values, and recent activity",
  path: "/x402/wallet-analyzer",
  method: "POST",
  priceUsd: "0.01",
};

export const WALLET_REPORT_CATALOG: X402ServiceEndpoint = {
  name: "Wallet Report Bundle",
  description:
    "Full wallet report — SOL balance, token holdings, top-token holder concentration, and DeFi positions in one call",
  path: "/x402/wallet-report",
  method: "POST",
  priceUsd: "0.03",
};

/**
 * Fetch wallet data via Helius RPC (JSON-RPC methods).
 */
async function fetchWalletData(
  address: string,
  heliusApiKey: string
): Promise<{
  solBalance: number;
  tokens: Array<{
    mint: string;
    amount: number;
    decimals: number;
    uiAmount: number;
  }>;
}> {
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;

  // SOL balance
  const solRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [address],
    }),
  });
  const solData: any = await solRes.json();
  const solBalance = (solData.result?.value ?? 0) / 1e9;

  // Token accounts (USDC and others)
  const tokenRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "getTokenAccountsByOwner",
      params: [
        address,
        { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { encoding: "jsonParsed" },
      ],
    }),
  });
  const tokenData: any = await tokenRes.json();

  const tokens = (tokenData.result?.value ?? []).map((account: any) => {
    const info = account.account.data.parsed.info;
    return {
      mint: info.mint,
      amount: parseInt(info.tokenAmount.amount),
      decimals: info.tokenAmount.decimals,
      uiAmount: info.tokenAmount.uiAmount,
    };
  });

  return { solBalance, tokens };
}

/**
 * Wallet analyzer x402 routes.
 */
export const walletAnalyzerRoutes: Route[] = [
  // ── POST /x402/wallet-analyzer — $0.01 ─────────────────────────
  {
    type: "POST",
    path: "/x402/wallet-analyzer",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.01",
        description: "Solana wallet analysis — SOL balance, token holdings",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const address = body.address;
      if (!address || typeof address !== "string") {
        (res as any).status(400).json({ error: "Missing required field: address (Solana wallet address)" });
        return;
      }

      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        (res as any).status(400).json({ error: "Invalid Solana address format" });
        return;
      }

      const heliusKey = runtime.getSetting("HELIUS_API_KEY");
      if (!heliusKey) {
        (res as any).status(503).json({ error: "HELIUS_API_KEY not configured" });
        return;
      }

      try {
        const cacheKey = `wallet:${address}`;
        let data = cache.get(cacheKey) as Awaited<ReturnType<typeof fetchWalletData>> | undefined;
        if (!data) {
          data = await fetchWalletData(address, String(heliusKey));
          cache.set(cacheKey, data);
        }

        // Known token labels
        const KNOWN_TOKENS: Record<string, string> = {
          EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
          Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
          So11111111111111111111111111111111111111112: "wSOL",
          mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
          J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "jitoSOL",
        };

        const enrichedTokens = data.tokens.map((t) => ({
          ...t,
          symbol: KNOWN_TOKENS[t.mint] ?? t.mint.slice(0, 8) + "...",
        }));

        (res as any).json({
          address,
          solBalance: data.solBalance,
          tokens: enrichedTokens,
          tokenCount: enrichedTokens.length,
          analyzedAt: new Date().toISOString(),
          payment: {
            amount: "0.01",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[wallet-analyzer] Analysis failed"
        );
        (res as any).status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/wallet-report — $0.03 (bundle) ────────────────
  {
    type: "POST",
    path: "/x402/wallet-report",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.03",
        description: "Wallet report bundle — balance, top-token holders, DeFi positions",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const address = body.address;
      if (!address || typeof address !== "string") {
        (res as any).status(400).json({ error: "Missing required field: address (Solana wallet address)" });
        return;
      }
      if (!SOLANA_ADDR_RE.test(address)) {
        (res as any).status(400).json({ error: "Invalid Solana address format" });
        return;
      }

      const heliusKey = runtime.getSetting("HELIUS_API_KEY");
      if (!heliusKey) {
        (res as any).status(503).json({ error: "HELIUS_API_KEY not configured" });
        return;
      }

      try {
        const apiKey = String(heliusKey);
        const rpcUrl = heliusRpcUrl(apiKey);

        const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const errors: string[] = [];

        // ── 1. Wallet balance (reuse wallet-analyzer cache) ──────────
        const walletCacheKey = `wallet:${address}`;
        let walletData = cache.get(walletCacheKey) as Awaited<ReturnType<typeof fetchWalletData>> | undefined;
        if (!walletData) {
          walletData = await fetchWalletData(address, apiKey);
          cache.set(walletCacheKey, walletData);
        }

        // Small delay between Helius calls to avoid rate limiting
        await delay(100);

        // ── 2. Token holders (sequential, not parallel) ──────────────
        const sortedTokens = [...walletData.tokens]
          .filter((t) => t.uiAmount > 0)
          .sort((a, b) => b.uiAmount - a.uiAmount);
        const topMint = sortedTokens[0]?.mint;

        let holdersResult: { mint: string; accounts: any[] } | null = null;
        if (topMint) {
          try {
            const holdersCacheKey = `holders:${topMint}`;
            const cached = heliusCache.get(holdersCacheKey);
            if (cached) {
              holdersResult = { mint: topMint, accounts: cached };
            } else {
              const result = await rpcCall(rpcUrl, "getTokenLargestAccounts", [topMint]);
              const accounts = result?.value ?? [];
              heliusCache.set(holdersCacheKey, accounts);
              holdersResult = { mint: topMint, accounts };
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push("token-holders: temporarily unavailable");
            runtime.logger.warn(
              { error: msg },
              "[wallet-report] Token holders sub-query failed, returning partial results"
            );
          }
        }

        // Small delay between Helius calls
        await delay(100);

        // ── 3. DeFi positions (sequential) ───────────────────────────
        let defiResult: {
          address: string;
          defiPositions: any[];
          defiPositionCount: number;
          totalTokenAccounts: number;
        } | null = null;
        try {
          const defiCacheKey = `defi:${address}`;
          const cached = heliusCache.get(defiCacheKey);
          if (cached) {
            defiResult = cached;
          } else {
            const result = await rpcCall(rpcUrl, "getTokenAccountsByOwner", [
              address,
              { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
              { encoding: "jsonParsed" },
            ]);
            const allTokens: Array<{
              mint: string;
              amount: string;
              decimals: number;
              uiAmount: number;
            }> = (result?.value ?? []).map((account: any) => {
              const info = account.account.data.parsed.info;
              return {
                mint: info.mint,
                amount: info.tokenAmount.amount,
                decimals: info.tokenAmount.decimals,
                uiAmount: info.tokenAmount.uiAmount ?? 0,
              };
            });
            const defiPositions = allTokens
              .filter((t) => t.uiAmount > 0 && DEFI_PROTOCOL_MINTS[t.mint])
              .map((t) => {
                const proto = DEFI_PROTOCOL_MINTS[t.mint]!;
                return {
                  protocol: proto.protocol,
                  symbol: proto.symbol,
                  mint: t.mint,
                  amount: t.uiAmount,
                  rawAmount: t.amount,
                  decimals: t.decimals,
                };
              });
            defiResult = {
              address,
              defiPositions,
              defiPositionCount: defiPositions.length,
              totalTokenAccounts: allTokens.length,
            };
            heliusCache.set(defiCacheKey, defiResult);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push("defi-positions: temporarily unavailable");
          runtime.logger.warn(
            { error: msg },
            "[wallet-report] DeFi positions sub-query failed, returning partial results"
          );
        }

        // ── Build top-token holders array ──────────────────────────
        let topTokenHolders: any[] = [];
        if (holdersResult) {
          const totalRaw = holdersResult.accounts.reduce(
            (sum: number, a: any) => sum + parseFloat(a.amount),
            0
          );
          topTokenHolders = holdersResult.accounts.slice(0, 10).map((a: any, i: number) => {
            const raw = parseFloat(a.amount);
            return {
              rank: i + 1,
              address: a.address,
              amount: a.uiAmountString ?? String(raw / Math.pow(10, a.decimals)),
              concentrationPct: totalRaw > 0 ? parseFloat(((raw / totalRaw) * 100).toFixed(4)) : 0,
            };
          });
        }

        (res as any).json({
          wallet: {
            address,
            solBalance: walletData.solBalance,
            tokens: walletData.tokens.map((t) => ({
              ...t,
              symbol: t.mint.slice(0, 8) + "...",
            })),
            tokenCount: walletData.tokens.length,
          },
          topTokenHolders: topTokenHolders.length > 0
            ? { mint: holdersResult!.mint, holders: topTokenHolders }
            : null,
          defiPositions: defiResult?.defiPositions ?? [],
          ...(errors.length > 0 ? { warnings: errors } : {}),
          analyzedAt: new Date().toISOString(),
          payment: {
            amount: "0.03",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[wallet-report] Bundle analysis failed"
        );
        (res as any).status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── GET /x402/wallet-analyzer/health — FREE ────────────────────
  {
    type: "GET",
    path: "/x402/wallet-analyzer/health",
    name: "wallet-analyzer-health",
    public: true,
    handler: async (_req, res, runtime) => {
      const hasHelius = !!runtime.getSetting("HELIUS_API_KEY");
      const serverService = runtime.getService<X402ServerService>("X402_SERVER" as any);

      (res as any).json({
        status: hasHelius ? "ok" : "degraded",
        heliusConfigured: hasHelius,
        receiveAddress: serverService?.getReceiveAddress() ?? "",
        network: serverService?.getNetwork() ?? "",
        price: "$0.01/analysis",
      });
    },
  },
];
