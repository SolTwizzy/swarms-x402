export const RH_FACILITATOR_URL =
  process.env.RH_FACILITATOR_URL ?? "http://rh-facilitator:4021";
export const RH_PAY_TO =
  process.env.X402_RH_RECEIVE_ADDRESS ?? "0xD421e2Cb3dF59F25AB1574E271a8b291665Ba439";
export const RH_USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const RH_NETWORK = "eip155:4663";

export interface RhChainRequirements {
  scheme: "exact";
  network: typeof RH_NETWORK;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: "application/json";
  payTo: string;
  maxTimeoutSeconds: 300;
  asset: typeof RH_USDG_ADDRESS;
  extra: {
    name: "Global Dollar";
    version: "1";
  };
}

interface RhVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

interface RhSettleResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
}

export interface RhSettlementResult {
  paid: boolean;
  transaction?: string;
  payer?: string;
  reason?: string;
}

/** Convert a decimal USD amount to six-decimal USDG atomic units. */
export function usdToUsdgAtomic(usd: string): string {
  const match = usd.trim().match(/^(\d+)(?:\.(\d{0,6}))?$/);
  if (!match) return "0";

  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0"));
  return (whole * 1_000_000n + fraction).toString();
}

export function buildRhChainRequirements({
  amountAtomic,
  resourceUrl,
  description,
}: {
  amountAtomic: string;
  resourceUrl: string;
  description: string;
}): RhChainRequirements {
  return {
    scheme: "exact",
    network: RH_NETWORK,
    maxAmountRequired: amountAtomic,
    resource: resourceUrl,
    description,
    mimeType: "application/json",
    payTo: RH_PAY_TO,
    maxTimeoutSeconds: 300,
    asset: RH_USDG_ADDRESS,
    extra: { name: "Global Dollar", version: "1" },
  };
}

export function decodePaymentHeader(header: string): any | null {
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function isRhChainPayment(header: string): boolean {
  return decodePaymentHeader(header)?.network === RH_NETWORK;
}

export async function settleRhChainPayment(
  header: string,
  requirements: RhChainRequirements
): Promise<RhSettlementResult> {
  try {
    const paymentPayload = decodePaymentHeader(header);
    if (!paymentPayload) {
      return { paid: false, reason: "invalid_payment_header" };
    }

    const body = JSON.stringify({ paymentPayload, paymentRequirements: requirements });
    const verifyResponse = await fetch(`${RH_FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const verify = (await verifyResponse.json()) as RhVerifyResponse;
    if (!verify.isValid) {
      return { paid: false, reason: verify.invalidReason };
    }

    const settleResponse = await fetch(`${RH_FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const settle = (await settleResponse.json()) as RhSettleResponse;
    return {
      paid: settle.success,
      transaction: settle.transaction,
      payer: settle.payer,
      reason: settle.errorReason,
    };
  } catch {
    return { paid: false, reason: "facilitator_error" };
  }
}
