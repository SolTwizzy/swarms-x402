/**
 * Determine USDG's exact EIP-712 domain `version` string by reconstructing the
 * domain separator for candidate (name, version) pairs and matching it against the
 * on-chain DOMAIN_SEPARATOR() value read from Robinhood Chain (eip155:4663).
 *
 * Read-only. No funds. Run: bun run check:domain
 */
import { keccak256, encodeAbiParameters, stringToBytes, createPublicClient, http } from "viem";
import { RPC_URL, USDG_ADDRESS, CHAIN_ID } from "../src/config.js";

const client = createPublicClient({ transport: http(RPC_URL) });

const DOMAIN_TYPEHASH = keccak256(
  stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

function domainSeparator(name: string, version: string, chainId: bigint): string {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        DOMAIN_TYPEHASH,
        keccak256(stringToBytes(name)),
        keccak256(stringToBytes(version)),
        chainId,
        USDG_ADDRESS,
      ],
    ),
  ).toLowerCase();
}

const onchain = (
  (await client.readContract({
    address: USDG_ADDRESS,
    abi: [{ name: "DOMAIN_SEPARATOR", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }],
    functionName: "DOMAIN_SEPARATOR",
  })) as string
).toLowerCase();

const onchainName = (await client.readContract({
  address: USDG_ADDRESS,
  abi: [{ name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }],
  functionName: "name",
})) as string;

console.log("on-chain name():           ", JSON.stringify(onchainName));
console.log("on-chain DOMAIN_SEPARATOR():", onchain);
console.log("chainId:                    ", CHAIN_ID);
console.log("---");

const names = [onchainName, "Global Dollar", "USDG"];
const versions = ["1", "2", "1.0", "0"];
let matched: { name: string; version: string } | null = null;
for (const n of names) {
  for (const v of versions) {
    const s = domainSeparator(n, v, BigInt(CHAIN_ID));
    const hit = s === onchain;
    if (hit) matched = { name: n, version: v };
    console.log(`${hit ? "MATCH " : "      "} name=${JSON.stringify(n).padEnd(18)} version=${JSON.stringify(v).padEnd(6)} -> ${s}`);
  }
}
console.log("---");
if (matched) {
  console.log(`RESULT: USDG EIP-712 domain = { name: ${JSON.stringify(matched.name)}, version: ${JSON.stringify(matched.version)}, chainId: ${CHAIN_ID}, verifyingContract: ${USDG_ADDRESS} }`);
} else {
  console.log("RESULT: no (name,version) candidate matched — USDG may use a non-standard domain (salt, or missing version field). Investigate further before trusting signatures.");
}
