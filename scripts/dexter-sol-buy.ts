/**
 * Dexter Solana x402 buyer — settles ONE payment on a SwarmX endpoint over the
 * Solana rail (Dexter facilitator) so the endpoint re-indexes in OpenDexter.
 *
 * OpenDexter's SDK index is settlement-driven; we fell out after moving Base off
 * Dexter. A single successful Dexter Solana settle re-adds the settled endpoint.
 *
 * Uses the repo's own Dexter client (`@dexterai/x402/client` wrapFetch) — the
 * same buy-side path the platform ships — so this exercises the real flow.
 *
 * Env:  SOLANA_BUYER_KEY = base58 Solana secret key (funded with USDC + a little SOL)
 * Usage: bun scripts/dexter-sol-buy.ts [path] ['{"json":"body"}']
 *        default: /x402/sentiment  {"text":"SwarmX re-index ping"}  ($0.01)
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { wrapFetch } from "@dexterai/x402/client";

const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE = "https://swarmx.io";

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m?.[1] || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadDotEnv();

const path = process.argv[2] ?? "/x402/sentiment";
const body = process.argv[3] ?? '{"text":"SwarmX re-index ping"}';
const key = process.env.SOLANA_BUYER_KEY;
if (!key) throw new Error("Set SOLANA_BUYER_KEY (base58 Solana secret) in .env");

const x402Fetch = wrapFetch(fetch, {
  walletPrivateKey: key,
  preferredNetwork: SOLANA_MAINNET_CAIP2,
  maxAmountAtomic: "200000", // up to $0.20 — covers any current endpoint
  verbose: true,
});

console.log(`buying ${BASE}${path} over Solana (Dexter) …`);
const res = await x402Fetch(`${BASE}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});
const text = await res.text();
let parsed: unknown = text;
try {
  parsed = JSON.parse(text);
} catch {
  /* keep raw */
}
console.log(`status=${res.status}`);
console.log(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2));

const pay = (parsed as any)?.payment;
if (pay?.transaction) {
  console.log(`\nSETTLED ✅ network=${pay.network} tx=${pay.transaction}`);
  console.log(`explorer: https://solscan.io/tx/${pay.transaction}`);
}
