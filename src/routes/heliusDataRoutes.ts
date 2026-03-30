import type { Route } from "@elizaos/core";
import { x402Gate } from "../server/x402Gate.js";
import { X402ServerService } from "../server/x402ServerService.js";
import type { X402ServiceEndpoint } from "../types.js";
import { TTLCache } from "../utils/cache.js";

// ── Shared response cache (30 s TTL) ─────────────────────────────────
export const heliusCache = new TTLCache<any>(30_000);

// ── Solana address regex ────────────────────────────────────────────
export const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── Known DeFi protocol token mints ─────────────────────────────────
export const DEFI_PROTOCOL_MINTS: Record<string, { protocol: string; symbol: string }> = {
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { protocol: "Marinade", symbol: "mSOL" },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { protocol: "Jito", symbol: "jitoSOL" },
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": { protocol: "Raydium", symbol: "stSOL" },
  RLBxxFkseAZ4RgJH3Sqn8jXxhmGoz9jWxDNJMh8pL7a: { protocol: "Raydium", symbol: "RAY-USDC LP" },
  FbC6K13MzHvN42bXrtGaWsvZY9fxrackRSZcBGfjPc7m: { protocol: "Raydium", symbol: "RAY-SOL LP" },
  "7Q2afV64in6N6SeZsAAB81TJzwpeLmhBJoGn9Ey6epMu": { protocol: "Raydium", symbol: "RAY-SRM LP" },
  So11111111111111111111111111111111111111112: { protocol: "Wrapped SOL", symbol: "wSOL" },
  "7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT": { protocol: "Orca", symbol: "UXD-USDC LP" },
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: { protocol: "BlazeStake", symbol: "bSOL" },
  "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm": { protocol: "Infinity / Socean", symbol: "scnSOL" },
  LSTxxxnJzKDFSLr4dUkPcmCf5VyryEqzPLz5j4bpxFp: { protocol: "Liquid Staking", symbol: "LST" },
};

// ── Catalog entries ─────────────────────────────────────────────────
export const HELIUS_DATA_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "Token Holders",
    description:
      "Get top holders for any SPL token — amounts, percentages, concentration analysis",
    path: "/x402/token-holders",
    method: "POST",
    priceUsd: "0.01",
  },
  {
    name: "Transaction History",
    description:
      "Get recent transaction history for any Solana address — signatures, types, timestamps",
    path: "/x402/tx-history",
    method: "POST",
    priceUsd: "0.01",
  },
  {
    name: "DeFi Positions",
    description:
      "Scan a Solana wallet for DeFi positions — Marinade, Jito, Raydium LP tokens and more",
    path: "/x402/defi-positions",
    method: "POST",
    priceUsd: "0.02",
  },
];

// ── Helpers ─────────────────────────────────────────────────────────

export function heliusRpcUrl(apiKey: string): string {
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

export async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
  id: number = 1
): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const data: any = await res.json();
  if (data.error) {
    throw new Error(`RPC ${method}: ${data.error.message ?? JSON.stringify(data.error)}`);
  }
  return data.result;
}

// ── Route definitions ───────────────────────────────────────────────

export const heliusDataRoutes: Route[] = [
  // ── POST /x402/token-holders — $0.01 ────────────────────────────
  {
    type: "POST",
    path: "/x402/token-holders",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.01",
        description: "Token holders — top accounts by balance for any SPL token",
      });
      if (!gate.paid) return;

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

      const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 20);

      const heliusKey = runtime.getSetting("HELIUS_API_KEY");
      if (!heliusKey) {
        (res as any).status(503).json({ error: "HELIUS_API_KEY not configured" });
        return;
      }

      try {
        const rpcUrl = heliusRpcUrl(String(heliusKey));
        const holdersCacheKey = `holders:${mint}`;
        let accounts: Array<{ address: string; amount: string; decimals: number; uiAmount: number | null; uiAmountString: string }>;
        const cachedHolders = heliusCache.get(holdersCacheKey);
        if (cachedHolders) {
          accounts = cachedHolders;
        } else {
          const result = await rpcCall(rpcUrl, "getTokenLargestAccounts", [mint]);
          accounts = result?.value ?? [];
          heliusCache.set(holdersCacheKey, accounts);
        }

        // Compute total to derive concentration percentages
        const totalRaw = accounts.reduce(
          (sum: number, a: any) => sum + parseFloat(a.amount),
          0
        );

        const holders = accounts.slice(0, limit).map((a: any, i: number) => {
          const raw = parseFloat(a.amount);
          return {
            rank: i + 1,
            address: a.address,
            amount: a.uiAmountString ?? String(raw / Math.pow(10, a.decimals)),
            rawAmount: a.amount,
            decimals: a.decimals,
            concentrationPct: totalRaw > 0 ? parseFloat(((raw / totalRaw) * 100).toFixed(4)) : 0,
          };
        });

        const topConcentration = holders.reduce((s: number, h: any) => s + h.concentrationPct, 0);

        (res as any).json({
          mint,
          holders,
          holderCount: holders.length,
          topConcentrationPct: parseFloat(topConcentration.toFixed(4)),
          queriedAt: new Date().toISOString(),
          payment: {
            amount: "0.01",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[token-holders] Fetch failed"
        );
        (res as any).status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/tx-history — $0.01 ───────────────────────────────
  {
    type: "POST",
    path: "/x402/tx-history",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.01",
        description: "Transaction history — recent transactions for any Solana address",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const address: unknown = body.address;
      if (!address || typeof address !== "string") {
        (res as any).status(400).json({ error: "Missing required field: address (Solana address)" });
        return;
      }
      if (!SOLANA_ADDR_RE.test(address)) {
        (res as any).status(400).json({ error: "Invalid Solana address format" });
        return;
      }

      const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 10);

      const heliusKey = runtime.getSetting("HELIUS_API_KEY");
      if (!heliusKey) {
        (res as any).status(503).json({ error: "HELIUS_API_KEY not configured" });
        return;
      }

      try {
        const txCacheKey = `tx:${address}:${limit}`;
        const cachedTx = heliusCache.get(txCacheKey);
        if (cachedTx) {
          (res as any).json({
            ...cachedTx,
            payment: {
              amount: "0.01",
              transaction: gate.transaction,
              network: gate.network,
            },
          });
          return;
        }

        const rpcUrl = heliusRpcUrl(String(heliusKey));

        // Step 1: get recent signatures
        const sigs = await rpcCall(rpcUrl, "getSignaturesForAddress", [
          address,
          { limit },
        ]);

        const signatures: Array<{
          signature: string;
          slot: number;
          blockTime: number | null;
          err: any;
          memo: string | null;
        }> = sigs ?? [];

        // Step 2: fetch basic transaction info for each signature
        const transactions = await Promise.all(
          signatures.map(async (sig: any, idx: number) => {
            try {
              const tx = await rpcCall(
                rpcUrl,
                "getTransaction",
                [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
                10 + idx
              );

              // Extract basic info
              const meta = tx?.meta ?? {};
              const msg = tx?.transaction?.message ?? {};
              const accountKeys: string[] = (msg.accountKeys ?? []).map(
                (k: any) => (typeof k === "string" ? k : k.pubkey)
              );

              // Compute SOL change for the queried address
              const addrIndex = accountKeys.indexOf(address);
              let solChange = 0;
              if (addrIndex >= 0 && meta.preBalances && meta.postBalances) {
                solChange =
                  ((meta.postBalances[addrIndex] ?? 0) - (meta.preBalances[addrIndex] ?? 0)) / 1e9;
              }

              // Detect transaction type from inner instructions
              const programIds: string[] = (msg.instructions ?? []).map(
                (ix: any) => ix.programId ?? ix.program ?? ""
              );
              let txType = "unknown";
              if (programIds.includes("11111111111111111111111111111111")) txType = "transfer";
              if (programIds.includes("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")) txType = "token-transfer";
              if (programIds.some((p: string) => p.includes("Swap") || p.includes("swap"))) txType = "swap";
              if (programIds.includes("ComputeBudget111111111111111111111111111111")) {
                if (txType === "unknown") txType = "compute-budget";
              }

              return {
                signature: sig.signature,
                slot: sig.slot,
                blockTime: sig.blockTime,
                timestamp: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null,
                success: sig.err === null,
                type: txType,
                solChange: parseFloat(solChange.toFixed(9)),
                fee: meta.fee ? meta.fee / 1e9 : 0,
                programIds: programIds.filter(Boolean).slice(0, 5),
              };
            } catch {
              // If individual tx fetch fails, still return signature info
              return {
                signature: sig.signature,
                slot: sig.slot,
                blockTime: sig.blockTime,
                timestamp: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null,
                success: sig.err === null,
                type: "unknown",
                solChange: 0,
                fee: 0,
                programIds: [],
              };
            }
          })
        );

        const txResult = {
          address,
          transactions,
          transactionCount: transactions.length,
          queriedAt: new Date().toISOString(),
        };
        heliusCache.set(txCacheKey, txResult);

        (res as any).json({
          ...txResult,
          payment: {
            amount: "0.01",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[tx-history] Fetch failed"
        );
        (res as any).status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/defi-positions — $0.02 ───────────────────────────
  {
    type: "POST",
    path: "/x402/defi-positions",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.02",
        description: "DeFi positions — scan wallet for Marinade, Jito, Raydium LP and other DeFi tokens",
      });
      if (!gate.paid) return;

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

      const heliusKey = runtime.getSetting("HELIUS_API_KEY");
      if (!heliusKey) {
        (res as any).status(503).json({ error: "HELIUS_API_KEY not configured" });
        return;
      }

      try {
        const defiCacheKey = `defi:${address}`;
        const cachedDefi = heliusCache.get(defiCacheKey);
        if (cachedDefi) {
          (res as any).json({
            ...cachedDefi,
            payment: {
              amount: "0.02",
              transaction: gate.transaction,
              network: gate.network,
            },
          });
          return;
        }

        const rpcUrl = heliusRpcUrl(String(heliusKey));

        // Get all token accounts for the wallet
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

        // Filter to known DeFi protocol tokens with non-zero balance
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

        // Also list unknown tokens with non-zero balance as "unclassified"
        const unclassifiedTokens = allTokens
          .filter((t) => t.uiAmount > 0 && !DEFI_PROTOCOL_MINTS[t.mint])
          .map((t) => ({
            mint: t.mint,
            amount: t.uiAmount,
            rawAmount: t.amount,
            decimals: t.decimals,
          }));

        const defiResult = {
          address,
          defiPositions,
          defiPositionCount: defiPositions.length,
          unclassifiedTokens,
          unclassifiedTokenCount: unclassifiedTokens.length,
          totalTokenAccounts: allTokens.length,
          queriedAt: new Date().toISOString(),
        };
        heliusCache.set(defiCacheKey, defiResult);

        (res as any).json({
          ...defiResult,
          payment: {
            amount: "0.02",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[defi-positions] Fetch failed"
        );
        (res as any).status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── GET /x402/helius-data/health — FREE ─────────────────────────
  {
    type: "GET",
    path: "/x402/helius-data/health",
    name: "helius-data-health",
    public: true,
    handler: async (_req, res, runtime) => {
      const hasHelius = !!runtime.getSetting("HELIUS_API_KEY");
      const serverService = runtime.getService<X402ServerService>("X402_SERVER" as any);

      (res as any).json({
        status: hasHelius ? "ok" : "degraded",
        heliusConfigured: hasHelius,
        receiveAddress: serverService?.getReceiveAddress() ?? "",
        network: serverService?.getNetwork() ?? "",
        endpoints: [
          { path: "/x402/token-holders", price: "$0.01/call" },
          { path: "/x402/tx-history", price: "$0.01/call" },
          { path: "/x402/defi-positions", price: "$0.02/call" },
        ],
      });
    },
  },
];
