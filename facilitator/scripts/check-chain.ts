/**
 * Read-only on-chain evidence for the RH-Chain facilitator. NO FUNDS, NO WRITES.
 * Reproduces the facts the facilitator relies on. Run: bun run check:chain
 */
import { createPublicClient, http, getAddress } from "viem";
import { RPC_URL, USDG_ADDRESS, PERMIT2_ADDRESS, CHAIN_ID, PAY_TO } from "../src/config.js";
import { usdgAbi } from "../src/usdg.js";

const client = createPublicClient({ transport: http(RPC_URL) });

// selector probe: returns "returns" | "reverts:<data>" so we can tell routed vs unknown
async function probe(to: `0x${string}`, data: `0x${string}`): Promise<string> {
  try {
    const r = await client.request({ method: "eth_call", params: [{ to, data }, "latest"] as any });
    return `returns ${String(r).slice(0, 18)}…`;
  } catch (e: any) {
    const d = e?.cause?.data ?? e?.data ?? e?.details ?? "";
    return `reverts ${d || "0x"}`;
  }
}

async function codeSize(addr: `0x${string}`): Promise<number> {
  const code = await client.getBytecode({ address: addr });
  return code ? (code.length - 2) / 2 : 0;
}

const chainId = await client.getChainId();
const name = (await client.readContract({ address: USDG_ADDRESS, abi: usdgAbi, functionName: "name" })) as string;
const decimals = (await client.readContract({ address: USDG_ADDRESS, abi: usdgAbi, functionName: "decimals" })) as number;
const domainSep = (await client.readContract({ address: USDG_ADDRESS, abi: usdgAbi, functionName: "DOMAIN_SEPARATOR" })) as string;
const permit2Size = await codeSize(PERMIT2_ADDRESS);
const usdgSize = await codeSize(USDG_ADDRESS);
const gasPrice = await client.getGasPrice();
const ethBal = await client.getBalance({ address: getAddress(PAY_TO) });
const usdgBal = (await client.readContract({ address: USDG_ADDRESS, abi: usdgAbi, functionName: "balanceOf", args: [getAddress(PAY_TO)] })) as bigint;

console.log("=== Robinhood Chain x402 facilitator — on-chain evidence ===");
console.log(`chainId (eth_chainId):        ${chainId}  (config ${CHAIN_ID})  ${chainId === CHAIN_ID ? "OK" : "MISMATCH"}`);
console.log(`USDG ${USDG_ADDRESS}`);
console.log(`  name():                     "${name}"`);
console.log(`  decimals():                 ${decimals}`);
console.log(`  DOMAIN_SEPARATOR():         ${domainSep}`);
console.log(`  bytecode size:              ${usdgSize} bytes (proxy)`);
console.log(`Permit2 ${PERMIT2_ADDRESS}`);
console.log(`  bytecode size:              ${permit2Size} bytes  ${permit2Size > 0 ? "DEPLOYED" : "MISSING"}`);
console.log(`gasPrice:                     ${gasPrice} wei (${Number(gasPrice) / 1e9} gwei)`);
console.log("--- USDG interface probes (via proxy) ---");
console.log(`  random 0xdeadbeef:          ${await probe(USDG_ADDRESS, "0xdeadbeef")}`);
console.log(`  authorizationState (3009):  ${await probe(USDG_ADDRESS, "0xe94a01020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000")}`);
console.log(`  nonces (2612):              ${await probe(USDG_ADDRESS, "0x7ecebe000000000000000000000000000000000000000000000000000000000000000000")}`);
console.log(`  PERMIT_TYPEHASH (2612):     ${await probe(USDG_ADDRESS, "0x30adf81f")}`);
console.log("--- signer funding (read-only) ---");
console.log(`  payTo/signer ${getAddress(PAY_TO)}`);
console.log(`  ETH balance:                ${ethBal} wei`);
console.log(`  USDG balance:               ${usdgBal} (atomic, ${Number(usdgBal) / 10 ** decimals} USDG)`);
