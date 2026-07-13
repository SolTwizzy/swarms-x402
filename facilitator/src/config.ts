/**
 * Facilitator configuration for Robinhood Chain (eip155:4663) + USDG.
 *
 * All values here were confirmed by on-chain reads against the RH Chain RPC
 * (see facilitator/README.md "On-chain evidence"). Addresses are literals so the
 * facilitator cannot be accidentally pointed at the wrong token/chain.
 *
 * Money-safety: this module never loads or exposes a private key. The signer used
 * for /settle is read lazily (and only when settle is explicitly enabled) in
 * src/chain.ts from process.env.EVM_PRIVATE_KEY.
 */

/** CAIP-2 chain id number for RH Chain (eth_chainId => 0x1237). */
export const CHAIN_ID = 4663 as const;

/** CAIP-2 network identifier used on the x402 wire (network field). */
export const NETWORK = "eip155:4663" as const;

/** RH Chain JSON-RPC endpoint. Overridable for a private/failover RPC. */
export const RPC_URL = process.env.RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";

/** USDG (Global Dollar, Paxos) — the settlement token. ERC-1967 proxy. */
export const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

/** USDG decimals — confirmed on-chain (decimals() => 6). */
export const USDG_DECIMALS = 6 as const;

/**
 * USDG EIP-712 domain, confirmed by matching DOMAIN_SEPARATOR() on-chain
 * (scripts/check-domain.ts). USDG implements EIP-3009 transferWithAuthorization
 * AND EIP-2612 permit; we use the EIP-3009 path for x402 "exact" settlement.
 */
export const USDG_EIP712_NAME = process.env.USDG_EIP712_NAME ?? "Global Dollar";
export const USDG_EIP712_VERSION = process.env.USDG_EIP712_VERSION ?? "1";

/** Canonical Uniswap Permit2 (deployed on 4663, 9152 bytes). Fallback path only. */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/** Address that receives USDG payments (sell-side). Our EVM wallet by default. */
export const PAY_TO = (process.env.X402_RECEIVE_ADDRESS ?? "0xD421e2Cb3dF59F25AB1574E271a8b291665Ba439") as `0x${string}`;

/** Clock-skew buffer (seconds) required between now and validBefore. */
export const VALID_BEFORE_BUFFER_SECONDS = 6;

/** HTTP port for the facilitator server. */
export const PORT = Number(process.env.PORT ?? 4021);

/**
 * Dry-run switch: when true, /verify skips on-chain reads (balanceOf,
 * authorizationState) and validates only the signature + payload fields.
 * Used by the dry-run test to demonstrate "accept valid / reject tampered"
 * without any funded account. NEVER enable in production.
 */
export function skipOnchain(): boolean {
  return process.env.FACILITATOR_SKIP_ONCHAIN === "true";
}

/**
 * Settlement gate. /settle NEVER broadcasts a transaction unless this is true.
 * Default false => the settle code path returns before touching any key or RPC
 * write. Enabling requires an explicitly funded signer (checked at call time).
 */
export function settleEnabled(): boolean {
  return process.env.FACILITATOR_SETTLE_ENABLED === "true";
}
