/**
 * x402 protocol v1 "exact" scheme wire types (EVM / EIP-3009).
 * Field names/types match the reference `x402@1.2.0` Zod schemas so standard
 * x402 clients interoperate with this facilitator unchanged.
 */

export type Hex = `0x${string}`;

/** EIP-3009 authorization signed by the payer (values are decimal strings on the wire). */
export interface Eip3009Authorization {
  from: Hex;
  to: Hex;
  value: string; // uint256 atomic units
  validAfter: string; // unix seconds
  validBefore: string; // unix seconds
  nonce: Hex; // bytes32
}

export interface ExactEvmPayload {
  signature: Hex; // 65-byte EOA signature
  authorization: Eip3009Authorization;
}

/** Decoded X-PAYMENT header. */
export interface PaymentPayload {
  x402Version: number;
  scheme: string; // "exact"
  network: string; // "eip155:4663"
  payload: ExactEvmPayload;
}

/** One entry of the 402 response `accepts[]` array. */
export interface PaymentRequirements {
  scheme: string; // "exact"
  network: string; // "eip155:4663"
  maxAmountRequired: string; // atomic units
  resource: string;
  description: string;
  mimeType: string;
  payTo: Hex;
  maxTimeoutSeconds: number;
  asset: Hex; // token contract
  outputSchema?: unknown;
  extra?: { name?: string; version?: string } | null; // EIP-712 domain name/version
}

/**
 * x402 v1 error reasons (subset used here) + a couple of facilitator-local reasons
 * for states the v1 enum doesn't name (replay, settle disabled, unfunded signer).
 */
export type InvalidReason =
  | "insufficient_funds"
  | "invalid_exact_evm_payload_authorization_valid_after"
  | "invalid_exact_evm_payload_authorization_valid_before"
  | "invalid_exact_evm_payload_authorization_value"
  | "invalid_exact_evm_payload_signature"
  | "invalid_exact_evm_payload_recipient_mismatch"
  | "invalid_network"
  | "invalid_payload"
  | "invalid_payment_requirements"
  | "invalid_scheme"
  | "invalid_payment"
  | "unsupported_scheme"
  // facilitator-local:
  | "authorization_already_used"
  | "settle_disabled_no_funded_signer"
  | "signer_unfunded_no_gas"
  | "unexpected_verify_error"
  | "unexpected_settle_error";

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: InvalidReason;
  payer?: Hex;
  /** true if on-chain reads (balanceOf, authorizationState) were performed. */
  onchainChecked: boolean;
}

export interface SettleResult {
  success: boolean;
  transaction: string; // tx hash, or "" on failure
  network: string;
  payer?: Hex;
  errorReason?: InvalidReason;
}
