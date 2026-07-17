/**
 * Robinhood-Chain (eip155:4663) x402 test buyer — pays USDG for an RWA endpoint
 * end-to-end through our self-hosted facilitator, producing a real on-chain
 * settlement tx hash (the Track-2 launch proof).
 *
 * Settlement mechanism: EIP-3009 `transferWithAuthorization`. USDG (Global
 * Dollar, 0x5fc5360D…) implements EIP-3009, so the buyer signs an off-chain
 * EIP-712 `TransferWithAuthorization` — NO Permit2, NO approve tx, NO gas on the
 * buyer side (our facilitator pays gas and broadcasts). The buyer wallet needs
 * ONLY USDG.
 *
 * Safety: before signing it (1) recomputes the USDG EIP-712 domain separator
 * from the challenge's extra{name,version} + chainId + asset and asserts it
 * matches the live on-chain DOMAIN_SEPARATOR() — a mismatch means the settle
 * would revert, so we abort BEFORE committing; (2) asserts the buyer holds
 * enough USDG. Read-only until both pass.
 *
 * Usage:
 *   bun scripts/rh-buy-test.ts [url] ['{"ticker":"NVDA"}']
 * Env:
 *   RH_TEST_BUYER_EVM_KEY = 0x-prefixed 32-byte buyer private key (funded USDG)
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bytesToHex,
  encodeAbiParameters,
  keccak256,
  stringToHex,
  getAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";
const RH_CHAIN_ID = 4663;
const RH_NETWORK = "eip155:4663";
const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

interface RhAccept {
  scheme: "exact";
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string };
}

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match?.[1] || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = (match[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
  }
}

async function rpcCall(to: string, data: string): Promise<string> {
  const res = await fetch(RH_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(`RPC eth_call reverted: ${json.error.message}`);
  return json.result ?? "0x";
}

/** EIP-712 domain separator for a (name, version, chainId, verifyingContract). */
function domainSeparator(name: string, version: string, chainId: number, verifyingContract: Hex): Hex {
  const typeHash = keccak256(
    stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [typeHash, keccak256(stringToHex(name)), keccak256(stringToHex(version)), BigInt(chainId), verifyingContract]
    )
  );
}

function transactionFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["transaction", "txHash", "transactionHash"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  for (const child of Object.values(record)) {
    const found = transactionFrom(child);
    if (found) return found;
  }
  return undefined;
}

loadDotEnv();

const targetUrl = process.argv[2] ?? "https://swarmx.io/x402/rwa/stock-dd";
const bodyText = process.argv[3] ?? '{"ticker":"NVDA"}';
const privateKey = process.env.RH_TEST_BUYER_EVM_KEY as Hex | undefined;

if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error("Set RH_TEST_BUYER_EVM_KEY to a 32-byte 0x private key in .env");
}
const account = privateKeyToAccount(privateKey);
console.log(`buyer=${account.address}`);

// ── 1. Fetch the 402 challenge via an empty-body discovery probe (no free-tier burn). ──
const probe = await fetch(targetUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
  signal: AbortSignal.timeout(30_000),
});
if (probe.status !== 402) {
  console.log(`Expected 402 challenge, got ${probe.status}. Body:`);
  console.log((await probe.text()).slice(0, 800));
  process.exit(1);
}
const challenge = (await probe.json()) as { accepts?: RhAccept[] };
const accept = challenge.accepts?.find((e) => e.network === RH_NETWORK && e.scheme === "exact");
if (!accept) throw new Error("402 challenge does not advertise an eip155:4663 (RH-Chain) option");

const asset = getAddress(accept.asset);
if (asset !== getAddress(USDG_ADDRESS)) throw new Error(`Unexpected asset ${accept.asset}, want USDG`);
const name = accept.extra?.name ?? "Global Dollar";
const version = accept.extra?.version ?? "1";
const value = BigInt(accept.maxAmountRequired);
const payTo = getAddress(accept.payTo);
console.log(`price=${(Number(value) / 1e6).toFixed(6)} USDG  payTo=${payTo}  name="${name}" version="${version}"`);

// ── 2. PREFLIGHT — abort before signing if anything would make the settle revert. ──
const localSep = domainSeparator(name, version, RH_CHAIN_ID, asset).toLowerCase();
const onchainSep = (await rpcCall(asset, "0x3644e515")).toLowerCase(); // DOMAIN_SEPARATOR()
if (localSep !== onchainSep) {
  console.error("ABORT: USDG EIP-712 domain mismatch — settle would revert on-chain.");
  console.error(`  local (name="${name}" version="${version}" chainId=${RH_CHAIN_ID}): ${localSep}`);
  console.error(`  onchain DOMAIN_SEPARATOR():                                    ${onchainSep}`);
  process.exit(1);
}
console.log(`domain-separator OK (matches on-chain ${onchainSep.slice(0, 12)}…)`);

// balanceOf(buyer)
const balHex = await rpcCall(asset, "0x70a08231" + account.address.slice(2).padStart(64, "0").toLowerCase());
const balance = BigInt(balHex);
console.log(`buyer USDG balance=${(Number(balance) / 1e6).toFixed(6)}`);
if (balance < value) {
  console.error(
    `ABORT: buyer holds ${(Number(balance) / 1e6).toFixed(6)} USDG but price is ${(Number(value) / 1e6).toFixed(6)}. ` +
      `Send USDG to ${account.address} on Robinhood Chain (chainId 4663), then re-run.`
  );
  process.exit(1);
}

// ── 3. Sign the EIP-3009 TransferWithAuthorization. ──
const now = BigInt(Math.floor(Date.now() / 1000));
const authorization = {
  from: account.address,
  to: payTo,
  value,
  validAfter: now - 600n,
  validBefore: now + BigInt(accept.maxTimeoutSeconds ?? 300),
  nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
};
const signature = await account.signTypedData({
  domain: { name, version, chainId: RH_CHAIN_ID, verifyingContract: asset },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: authorization,
});

const paymentPayload = {
  x402Version: 1,
  scheme: "exact",
  network: RH_NETWORK,
  payload: {
    signature,
    authorization: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
      nonce: authorization.nonce,
    },
  },
};
const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

// ── 4. Pay: real request body + payment header → facilitator settles on-chain. ──
console.log(`paying ${targetUrl} …`);
const paid = await fetch(targetUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "payment-signature": paymentHeader,
    "x-payment": paymentHeader,
  },
  body: bodyText,
  signal: AbortSignal.timeout(120_000),
});
const responseText = await paid.text();
let responseBody: unknown = responseText;
try {
  responseBody = JSON.parse(responseText);
} catch {
  /* keep raw */
}

console.log(`status=${paid.status}`);
console.log(typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody, null, 2));

let paymentResponse: unknown;
const encoded = paid.headers.get("payment-response");
if (encoded) {
  try {
    paymentResponse = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    paymentResponse = encoded;
  }
}
const tx = transactionFrom(responseBody) ?? transactionFrom(paymentResponse);
if (tx) {
  console.log(`\nSETTLED ✅  tx=${tx}`);
  console.log(`explorer: https://robinhoodchain.blockscout.com/tx/${tx}`);
} else if (paid.status === 200) {
  console.log("\n(HTTP 200 but no tx hash surfaced — check response payment field.)");
}
