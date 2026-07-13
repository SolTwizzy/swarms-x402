/**
 * viem clients for Robinhood Chain (eip155:4663).
 *
 * The public client (read-only) is created eagerly. The wallet client (which can
 * broadcast transactions and therefore spend money) is created LAZILY and only by
 * getSigner(), which is called only from the gated /settle path. This module never
 * reads EVM_PRIVATE_KEY at import time.
 */
import { defineChain, createPublicClient, createWalletClient, http, type WalletClient, type Account } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, RPC_URL } from "./config.js";

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(RPC_URL),
});

/**
 * Build the settlement signer + wallet client from EVM_PRIVATE_KEY.
 *
 * ⚠️ MONEY: The returned wallet client can broadcast transactions and spend the
 * signer's ETH (gas) and move its USDG. It is only constructed here; it is only
 * *used* by src/settle.ts after the settlement gate + funded-signer check pass.
 */
export function getSigner(): { account: Account; wallet: WalletClient } {
  const raw = process.env.EVM_PRIVATE_KEY;
  if (!raw) throw new Error("EVM_PRIVATE_KEY not set — cannot build settlement signer");
  const pk = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(RPC_URL) });
  return { account, wallet };
}
