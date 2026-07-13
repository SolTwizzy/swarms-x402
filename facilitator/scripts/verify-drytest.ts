/**
 * Dry-run end-to-end test for the RH-Chain x402 facilitator. NO FUNDS REQUIRED.
 *
 * Uses an EPHEMERAL throwaway key to produce a real EIP-3009 signature over the
 * USDG domain, then drives the Hono app in-process (app.request, no socket):
 *
 *   A. skipOnchain=true  -> a valid signed payment is ACCEPTED (isValid=true)
 *   B. skipOnchain=true  -> a tampered signature is REJECTED (signature reason)
 *   C. skipOnchain=true  -> inflated value (sig no longer matches) is REJECTED
 *   D. skipOnchain=true  -> wrong recipient is REJECTED (recipient_mismatch)
 *   E. skipOnchain=true  -> expired authorization is REJECTED (valid_before)
 *   F. skipOnchain=false -> valid payload hits the REAL RPC and returns
 *                           insufficient_funds (ephemeral payer holds 0 USDG),
 *                           proving the on-chain balanceOf/authorizationState path.
 *   G. /settle with a valid payload is GATED: success=false,
 *      errorReason=settle_disabled_no_funded_signer, transaction="" (no broadcast).
 *
 * Run: bun run verify:dry
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, toHex } from "viem";
import { eip3009Types } from "../src/usdg.js";
import {
  CHAIN_ID,
  NETWORK,
  USDG_ADDRESS,
  USDG_EIP712_NAME,
  USDG_EIP712_VERSION,
  PAY_TO,
} from "../src/config.js";
import type { PaymentPayload, PaymentRequirements, Hex } from "../src/types.js";
import app from "../src/server.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail: string) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}  (${detail})`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}  (${detail})`);
  }
}

const account = privateKeyToAccount(generatePrivateKey());
const from = getAddress(account.address);
const REQUIRED = "10000"; // 0.01 USDG (6 decimals)

function randomNonce(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function buildRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: REQUIRED,
    resource: "https://api.swarmx.io/x402/rwa/stock-dd",
    description: "SwarmX RWA stock due-diligence report",
    mimeType: "application/json",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    asset: USDG_ADDRESS,
    extra: { name: USDG_EIP712_NAME, version: USDG_EIP712_VERSION },
  };
}

async function buildValidPayload(overrides?: Partial<{ value: string; validAfter: string; validBefore: string; to: Hex }>): Promise<PaymentPayload> {
  const now = Math.floor(Date.now() / 1000);
  const value = overrides?.value ?? REQUIRED;
  const validAfter = overrides?.validAfter ?? String(now - 600);
  const validBefore = overrides?.validBefore ?? String(now + 300);
  const to = overrides?.to ?? PAY_TO;
  const nonce = randomNonce();

  const domain = { name: USDG_EIP712_NAME, version: USDG_EIP712_VERSION, chainId: CHAIN_ID, verifyingContract: USDG_ADDRESS } as const;
  const message = {
    from,
    to,
    value: BigInt(value),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  } as const;

  const signature = await account.signTypedData({ domain, types: eip3009Types, primaryType: "TransferWithAuthorization", message });

  return {
    x402Version: 1,
    scheme: "exact",
    network: NETWORK,
    payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } },
  };
}

async function postVerify(payload: PaymentPayload): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
  const res = await app.request("/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload: payload, paymentRequirements: buildRequirements() }),
  });
  return (await res.json()) as any;
}

async function postSettle(payload: PaymentPayload): Promise<any> {
  const res = await app.request("/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload: payload, paymentRequirements: buildRequirements() }),
  });
  return await res.json();
}

async function main() {
  console.log(`Facilitator dry-run test — network=${NETWORK} asset=USDG payer(ephemeral)=${from}`);
  console.log(`Domain: name="${USDG_EIP712_NAME}" version="${USDG_EIP712_VERSION}" chainId=${CHAIN_ID}\n`);

  // ── Stateless (dry) checks: no RPC, no funds ──
  process.env.FACILITATOR_SKIP_ONCHAIN = "true";
  console.log("[skipOnchain=true] signature + field validation");

  // A. valid -> accepted
  const valid = await buildValidPayload();
  const rA = await postVerify(valid);
  check("A accept-valid", rA.isValid === true && getAddress((rA.payer ?? "0x0") as Hex) === from, `isValid=${rA.isValid} payer=${rA.payer}`);

  // B. tampered signature -> rejected
  const tampered = structuredClone(valid);
  const sig = tampered.payload.signature;
  const flipIdx = 40; // inside r
  const flipped = (sig.slice(0, flipIdx) + (sig[flipIdx] === "a" ? "b" : "a") + sig.slice(flipIdx + 1)) as Hex;
  tampered.payload.signature = flipped;
  const rB = await postVerify(tampered);
  check("B reject-tampered-signature", rB.isValid === false && rB.invalidReason === "invalid_exact_evm_payload_signature", `isValid=${rB.isValid} reason=${rB.invalidReason}`);

  // C. inflated value (signature was over REQUIRED) -> rejected at signature
  const inflated = structuredClone(valid);
  inflated.payload.authorization.value = "999999999";
  const rC = await postVerify(inflated);
  check("C reject-inflated-value", rC.isValid === false && rC.invalidReason === "invalid_exact_evm_payload_signature", `isValid=${rC.isValid} reason=${rC.invalidReason}`);

  // D. wrong recipient -> rejected before signature
  const wrongTo = await buildValidPayload();
  wrongTo.payload.authorization.to = getAddress("0x000000000000000000000000000000000000dEaD");
  const rD = await postVerify(wrongTo);
  check("D reject-wrong-recipient", rD.isValid === false && rD.invalidReason === "invalid_exact_evm_payload_recipient_mismatch", `isValid=${rD.isValid} reason=${rD.invalidReason}`);

  // E. expired -> rejected on validBefore
  const now = Math.floor(Date.now() / 1000);
  const expired = await buildValidPayload({ validAfter: String(now - 1200), validBefore: String(now - 600) });
  const rE = await postVerify(expired);
  check("E reject-expired", rE.isValid === false && rE.invalidReason === "invalid_exact_evm_payload_authorization_valid_before", `isValid=${rE.isValid} reason=${rE.invalidReason}`);

  // ── On-chain integration: real RPC read against chain 4663 ──
  process.env.FACILITATOR_SKIP_ONCHAIN = "false";
  console.log("\n[skipOnchain=false] real RPC balance/authorizationState read");
  const validOnchain = await buildValidPayload();
  const rF = await postVerify(validOnchain);
  check("F onchain-insufficient-funds", rF.isValid === false && rF.invalidReason === "insufficient_funds", `isValid=${rF.isValid} reason=${rF.invalidReason} (ephemeral payer holds 0 USDG; proves RPC path)`);

  // ── Settlement gate: must NOT broadcast ──
  console.log("\n[settle] gate check (FACILITATOR_SETTLE_ENABLED unset)");
  const rG = await postSettle(validOnchain);
  check("G settle-gated-no-broadcast", rG.success === false && rG.errorReason === "settle_disabled_no_funded_signer" && rG.transaction === "", `success=${rG.success} reason=${rG.errorReason} tx="${rG.transaction}"`);

  console.log(`\n${failed === 0 ? "ALL PASS" : "SOME FAILED"} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("dry-run crashed:", e);
  process.exit(1);
});
