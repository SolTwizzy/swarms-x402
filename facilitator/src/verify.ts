/**
 * x402 "exact" (EIP-3009) payment verification for USDG on Robinhood Chain.
 *
 * verify() requires NO funds and (in skipOnchain mode) NO RPC — it recovers the
 * EIP-712 signer and validates the authorization fields. When skipOnchain is off
 * it additionally reads balanceOf + authorizationState from the chain (read-only).
 *
 * EOA signatures only. Smart-wallet (ERC-1271 / ERC-6492) signatures are not yet
 * supported here — the x402 test buyer is an EOA. Documented in README.
 */
import { getAddress, recoverTypedDataAddress } from "viem";
import type { PaymentPayload, PaymentRequirements, VerifyResult, InvalidReason, Hex } from "./types.js";
import { eip3009Types, usdgAbi } from "./usdg.js";
import { publicClient } from "./chain.js";
import {
  CHAIN_ID,
  NETWORK,
  USDG_ADDRESS,
  USDG_EIP712_NAME,
  USDG_EIP712_VERSION,
  VALID_BEFORE_BUFFER_SECONDS,
  skipOnchain as skipOnchainDefault,
} from "./config.js";

function fail(reason: InvalidReason, payer?: Hex, onchainChecked = false): VerifyResult {
  return { isValid: false, invalidReason: reason, payer, onchainChecked };
}

export async function verifyPayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  opts?: { skipOnchain?: boolean },
): Promise<VerifyResult> {
  const skip = opts?.skipOnchain ?? skipOnchainDefault();
  try {
    // 1. scheme + network must be the exact/EIP-3009 path on our chain.
    if (paymentPayload.scheme !== "exact" || paymentRequirements.scheme !== "exact") return fail("unsupported_scheme");
    if (paymentPayload.network !== NETWORK || paymentRequirements.network !== NETWORK) return fail("invalid_network");

    // 2. asset must be USDG (we only settle USDG on this facilitator).
    let assetAddr: Hex;
    try {
      assetAddr = getAddress(paymentRequirements.asset);
    } catch {
      return fail("invalid_payment_requirements");
    }
    if (assetAddr !== getAddress(USDG_ADDRESS)) return fail("invalid_payment_requirements");

    const auth = paymentPayload.payload?.authorization;
    const signature = paymentPayload.payload?.signature;
    if (!auth || !signature) return fail("invalid_payload");

    let from: Hex, to: Hex, payTo: Hex;
    try {
      from = getAddress(auth.from);
      to = getAddress(auth.to);
      payTo = getAddress(paymentRequirements.payTo);
    } catch {
      return fail("invalid_payload");
    }

    let value: bigint, validAfter: bigint, validBefore: bigint, required: bigint;
    try {
      value = BigInt(auth.value);
      validAfter = BigInt(auth.validAfter);
      validBefore = BigInt(auth.validBefore);
      required = BigInt(paymentRequirements.maxAmountRequired);
    } catch {
      return fail("invalid_payload");
    }

    // 3. recipient must be the resource server's payTo.
    if (to !== payTo) return fail("invalid_exact_evm_payload_recipient_mismatch", from);

    // 4. authorized value must cover the price.
    if (value < required) return fail("invalid_exact_evm_payload_authorization_value", from);

    // 5. validity window.
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (validAfter > now) return fail("invalid_exact_evm_payload_authorization_valid_after", from);
    if (validBefore <= now + BigInt(VALID_BEFORE_BUFFER_SECONDS))
      return fail("invalid_exact_evm_payload_authorization_valid_before", from);

    // 6. signature: recover the EIP-712 signer and require it == from.
    const name = paymentRequirements.extra?.name ?? USDG_EIP712_NAME;
    const version = paymentRequirements.extra?.version ?? USDG_EIP712_VERSION;
    const domain = { name, version, chainId: CHAIN_ID, verifyingContract: assetAddr } as const;
    const message = { from, to, value, validAfter, validBefore, nonce: auth.nonce } as const;

    let recovered: Hex;
    try {
      recovered = await recoverTypedDataAddress({
        domain,
        types: eip3009Types,
        primaryType: "TransferWithAuthorization",
        message,
        signature,
      });
    } catch {
      return fail("invalid_exact_evm_payload_signature", from);
    }
    if (getAddress(recovered) !== from) return fail("invalid_exact_evm_payload_signature", from);

    // 7. on-chain liveness checks (skipped in dry-run mode).
    if (!skip) {
      const [balance, used] = await Promise.all([
        publicClient.readContract({ address: USDG_ADDRESS, abi: usdgAbi, functionName: "balanceOf", args: [from] }) as Promise<bigint>,
        publicClient.readContract({ address: USDG_ADDRESS, abi: usdgAbi, functionName: "authorizationState", args: [from, auth.nonce] }) as Promise<boolean>,
      ]);
      if (used) return fail("authorization_already_used", from, true);
      if (balance < value) return fail("insufficient_funds", from, true);
      return { isValid: true, payer: from, onchainChecked: true };
    }

    return { isValid: true, payer: from, onchainChecked: false };
  } catch (err) {
    console.error("[verify] unexpected error:", err instanceof Error ? err.message : err);
    return fail("unexpected_verify_error");
  }
}
