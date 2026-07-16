import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytesToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

interface MeridianAccept {
  scheme: "exact";
  network: string;
  asset: Hex;
  payTo: Hex;
  maxAmountRequired: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match?.[1] || process.env[match[1]] !== undefined) continue;
    const value = (match[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
}

function transactionFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["transaction", "txHash", "transactionHash"]) {
    if (typeof record[key] === "string") return record[key];
  }
  for (const child of Object.values(record)) {
    const found = transactionFrom(child);
    if (found) return found;
  }
  return undefined;
}

loadDotEnv();

const targetUrl = process.argv[2];
const method = (process.argv[3] ?? "GET").toUpperCase();
const bodyText = process.argv[4];
const privateKey = process.env.X402_TEST_BUYER_EVM_KEY as Hex | undefined;

if (!targetUrl || !["GET", "POST"].includes(method)) {
  throw new Error(
    "Usage: bun scripts/meridian-buy-test.ts <url> [GET|POST] ['{\"key\":\"value\"}']"
  );
}
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error("Set X402_TEST_BUYER_EVM_KEY to a 32-byte 0x private key");
}

const requestInit: RequestInit = {
  method,
  headers: bodyText ? { "Content-Type": "application/json" } : undefined,
  body: method === "POST" ? bodyText ?? "{}" : undefined,
};
const challengeResponse = await fetch(targetUrl, requestInit);
if (challengeResponse.status !== 402) {
  console.log(`status=${challengeResponse.status}`);
  console.log(await challengeResponse.text());
  process.exit(challengeResponse.ok ? 0 : 1);
}

const challenge = (await challengeResponse.json()) as {
  accepts?: MeridianAccept[];
};
const requirement = challenge.accepts?.find(
  (entry) => entry.network === "base" && entry.scheme === "exact"
);
if (!requirement) {
  throw new Error("The 402 challenge does not advertise Meridian Base");
}

const account = privateKeyToAccount(privateKey);
const now = BigInt(Math.floor(Date.now() / 1_000));
const authorization = {
  from: account.address,
  to: requirement.payTo,
  value: BigInt(requirement.maxAmountRequired),
  validAfter: now - 600n,
  validBefore: now + BigInt(requirement.maxTimeoutSeconds),
  nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
};
const signature = await account.signTypedData({
  domain: {
    name: requirement.extra.name,
    version: requirement.extra.version,
    chainId: 8453,
    verifyingContract: requirement.asset,
  },
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
  network: "base",
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
const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString(
  "base64"
);
const paidResponse = await fetch(targetUrl, {
  ...requestInit,
  headers: {
    ...(requestInit.headers as Record<string, string> | undefined),
    "payment-signature": paymentHeader,
    "x-payment": paymentHeader,
  },
});
const responseText = await paidResponse.text();
let responseBody: unknown = responseText;
try {
  responseBody = JSON.parse(responseText);
} catch {
  // Keep non-JSON response text intact.
}

let paymentResponse: unknown;
const encodedPaymentResponse = paidResponse.headers.get("payment-response");
if (encodedPaymentResponse) {
  try {
    paymentResponse = JSON.parse(
      Buffer.from(encodedPaymentResponse, "base64").toString("utf8")
    );
  } catch {
    paymentResponse = encodedPaymentResponse;
  }
}

console.log(`status=${paidResponse.status}`);
console.log(
  typeof responseBody === "string"
    ? responseBody
    : JSON.stringify(responseBody, null, 2)
);
const transaction =
  transactionFrom(responseBody) ?? transactionFrom(paymentResponse);
if (transaction) console.log(`transaction=${transaction}`);
