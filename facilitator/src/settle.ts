/**
 * x402 "exact" (EIP-3009) settlement for USDG on Robinhood Chain.
 *
 * ⚠️⚠️ MONEY GATE ⚠️⚠️
 * This is the ONLY code path in the facilitator that can spend on-chain funds.
 * It is triple-gated and DOES NOTHING by default:
 *   1. settleEnabled() must be true (env FACILITATOR_SETTLE_ENABLED=true).
 *   2. The signer (EVM_PRIVATE_KEY) must hold ETH for gas on chain 4663.
 *   3. The payment must re-verify on-chain (balance + unused nonce).
 * Only after all three does it broadcast transferWithAuthorization. With the
 * default env (settlement disabled) it returns at gate #1 without loading the
 * key, touching the signer, or sending anything.
 *
 * Settlement mechanism: EIP-3009 `transferWithAuthorization(from,to,value,
 * validAfter,validBefore,nonce,v,r,s)` — USDG implements EIP-3009, so no prior
 * approve and no Permit2 are needed. (Permit2 `permitTransferFrom` is the
 * documented fallback for tokens lacking EIP-3009; see README.)
 */
import { getAddress, parseSignature } from "viem";
import type { PaymentPayload, PaymentRequirements, SettleResult, Hex } from "./types.js";
import { usdgAbi } from "./usdg.js";
import { publicClient, getSigner, robinhoodChain } from "./chain.js";
import { NETWORK, USDG_ADDRESS, settleEnabled } from "./config.js";
import { verifyPayment } from "./verify.js";

function settleFail(errorReason: SettleResult["errorReason"], payer?: Hex): SettleResult {
  return { success: false, transaction: "", network: NETWORK, payer, errorReason };
}

export async function settlePayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResult> {
  // ── GATE #1: settlement must be explicitly enabled. Default path stops here. ──
  if (!settleEnabled()) {
    return settleFail("settle_disabled_no_funded_signer");
  }

  try {
    // Re-verify WITH on-chain checks (never trust a stale /verify).
    const v = await verifyPayment(paymentPayload, paymentRequirements, { skipOnchain: false });
    if (!v.isValid) return settleFail(v.invalidReason, v.payer);

    const auth = paymentPayload.payload.authorization;
    const from = getAddress(auth.from);

    // ── GATE #2: the signer must be funded with ETH for gas. ──
    // vvv  BELOW THIS LINE REQUIRES REAL FUNDS ON CHAIN 4663  vvv
    const { account, wallet } = getSigner();
    const gasBalance = await publicClient.getBalance({ address: account.address });
    if (gasBalance === 0n) return settleFail("signer_unfunded_no_gas", from);

    // Split the 65-byte EOA signature for the (v,r,s) EIP-3009 overload.
    const { r, s, v: sv, yParity } = parseSignature(paymentPayload.payload.signature);
    const vByte = sv !== undefined ? Number(sv) : (yParity ?? 0) + 27;

    // ── BROADCAST: spends gas; moves USDG from payer to payTo. ──
    const hash = await wallet.writeContract({
      account,
      chain: robinhoodChain,
      address: USDG_ADDRESS,
      abi: usdgAbi,
      functionName: "transferWithAuthorization",
      args: [
        from,
        getAddress(auth.to),
        BigInt(auth.value),
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        auth.nonce,
        vByte,
        r,
        s,
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") return settleFail("invalid_payment", from);

    return { success: true, transaction: hash, network: NETWORK, payer: from };
  } catch (err) {
    console.error("[settle] unexpected error:", err instanceof Error ? err.message : err);
    return settleFail("unexpected_settle_error");
  }
}
