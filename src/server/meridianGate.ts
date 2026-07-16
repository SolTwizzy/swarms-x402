import type { IAgentRuntime } from "@elizaos/core";
import { X402ServerService } from "./x402ServerService.js";

export const MERIDIAN_API_BASE = "https://api.mrdn.finance/v1";
export const MERIDIAN_FACILITATOR =
  "0x8E7769D440b3460b92159Dd9C6D17302b036e2d6";

export interface MeridianNetworkConfig {
  chainId: number;
  meridianName: "base" | "arbitrum" | "bsc";
  token: string;
  tokenName: string;
  tokenVersion: string;
  decimals: number;
  facilitator: string;
  caip2: string;
  paymentType: "eip3009" | "permit2";
}

/** Meridian mainnet constants from its EIP-3009 and Permit2 guides. */
export const MERIDIAN_NETWORKS = {
  base: {
    chainId: 8453,
    meridianName: "base",
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokenName: "USD Coin",
    tokenVersion: "2",
    decimals: 6,
    facilitator: MERIDIAN_FACILITATOR,
    caip2: "eip155:8453",
    paymentType: "eip3009",
  },
  arbitrum: {
    chainId: 42161,
    meridianName: "arbitrum",
    token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    tokenName: "USD Coin",
    tokenVersion: "2",
    decimals: 6,
    facilitator: MERIDIAN_FACILITATOR,
    caip2: "eip155:42161",
    paymentType: "eip3009",
  },
  bsc: {
    chainId: 56,
    meridianName: "bsc",
    token: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    tokenName: "USDC",
    tokenVersion: "1",
    decimals: 18,
    facilitator: MERIDIAN_FACILITATOR,
    caip2: "eip155:56",
    paymentType: "permit2",
  },
} as const satisfies Readonly<Record<string, MeridianNetworkConfig>>;

// TODO: Enable BSC after SwarmX implements the Meridian Permit2 buyer flow.
export const DEFAULT_MERIDIAN_NETWORKS = ["base", "arbitrum"] as const;

export interface MeridianRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: "application/json";
  maxTimeoutSeconds: 300;
  extra: {
    name: string;
    version: string;
    creditedRecipient: string;
  };
}

export interface MeridianSettlementResult {
  success: boolean;
  transaction?: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

interface DexterRequirementsEnvelope {
  x402Version: number;
  resource: unknown;
  accepts: object[];
}

export interface PublicAcceptsResult {
  accepts: object[];
  dexterRequirements?: DexterRequirementsEnvelope;
  meridianEnabled: boolean;
}

let loggedDisabled = false;

function readSetting(
  runtime: IAgentRuntime,
  key: string
): string | undefined {
  const value = runtime.getSetting(key);
  if (value == null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

/** Read the backend-only Meridian API key and log its absence once. */
export function getMeridianApiKey(
  runtime: IAgentRuntime
): string | undefined {
  const apiKey = readSetting(runtime, "MERIDIAN_API_KEY");
  if (!apiKey && !loggedDisabled) {
    loggedDisabled = true;
    runtime.logger.info(
      "[Meridian] MERIDIAN_API_KEY not set. Meridian EVM rail disabled."
    );
  }
  return apiKey;
}

/** Resolve the EVM payout wallet used as Meridian's credited recipient. */
export function getMeridianCreditedRecipient(
  runtime: IAgentRuntime
): string | undefined {
  return (
    readSetting(runtime, "X402_RECEIVE_ADDRESS_EVM") ??
    readSetting(runtime, "X402_RECEIVE_ADDRESS")
  );
}

function networkByCaip2(caip2: string): MeridianNetworkConfig | undefined {
  return Object.values(MERIDIAN_NETWORKS).find(
    (network) => network.caip2 === caip2
  );
}

/** Find a Meridian network by its standard friendly name. */
export function getMeridianNetwork(
  meridianName: string
): MeridianNetworkConfig | undefined {
  return Object.values(MERIDIAN_NETWORKS).find(
    (network) => network.meridianName === meridianName
  );
}

/** Find a Meridian network by either its CAIP-2 id or friendly name. */
export function getMeridianNetworkByAny(
  networkName: string
): MeridianNetworkConfig | undefined {
  return getMeridianNetwork(networkName) ?? networkByCaip2(networkName);
}

/** Build one standard x402 v1 Meridian `accepts` entry. */
export function buildMeridianRequirements({
  caip2,
  amountAtomic,
  resourceUrl,
  description,
  creditedRecipient,
}: {
  caip2: string;
  amountAtomic: string;
  resourceUrl: string;
  description: string;
  creditedRecipient: string;
}): MeridianRequirements {
  const network = networkByCaip2(caip2);
  if (!network) {
    throw new Error(`Unsupported Meridian network: ${caip2}`);
  }

  return {
    scheme: "exact",
    network: network.caip2,
    asset: network.token,
    payTo: network.facilitator,
    maxAmountRequired: amountAtomic,
    resource: resourceUrl,
    description,
    mimeType: "application/json",
    maxTimeoutSeconds: 300,
    extra: {
      name: network.tokenName,
      version: network.tokenVersion,
      creditedRecipient,
    },
  };
}

/** Decode a base64 x402 payment payload. */
export function decodeMeridianPaymentHeader(
  header: string
): Record<string, any> | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(header, "base64").toString("utf8")
    );
    return decoded && typeof decoded === "object" ? decoded : null;
  } catch {
    return null;
  }
}

/** Detect standard Meridian v1 payment payloads without claiming Dexter v2. */
export function isMeridianPayment(header: string): boolean {
  const payment = decodeMeridianPaymentHeader(header);
  if (!payment || payment.x402Version !== 1) return false;

  if (
    typeof payment.network === "string" &&
    getMeridianNetworkByAny(payment.network)
  ) {
    return true;
  }

  const authorizationTo = payment.payload?.authorization?.to;
  return (
    typeof authorizationTo === "string" &&
    Object.values(MERIDIAN_NETWORKS).some(
      (network) =>
        network.facilitator.toLowerCase() === authorizationTo.toLowerCase()
    )
  );
}

/** Settle a standard x402 v1 payment through Meridian. */
export async function settleMeridianPayment(
  header: string,
  requirements: MeridianRequirements,
  apiKey: string
): Promise<MeridianSettlementResult> {
  const paymentPayload = decodeMeridianPaymentHeader(header);
  if (!paymentPayload) {
    return {
      success: false,
      network: requirements.network,
      errorReason: "invalid_payment_header",
    };
  }

  const network = getMeridianNetworkByAny(requirements.network);
  if (!network) {
    return {
      success: false,
      network: requirements.network,
      errorReason: "unsupported_meridian_network",
    };
  }

  const outboundPaymentPayload = JSON.parse(
    JSON.stringify(paymentPayload)
  ) as Record<string, any>;
  const outboundRequirements = JSON.parse(
    JSON.stringify(requirements)
  ) as MeridianRequirements;
  outboundPaymentPayload.network = network.meridianName;
  outboundRequirements.network = network.meridianName;

  try {
    const response = await fetch(`${MERIDIAN_API_BASE}/settle`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paymentPayload: outboundPaymentPayload,
        paymentRequirements: outboundRequirements,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = (await response.json()) as Partial<MeridianSettlementResult>;

    if (!response.ok || result.success !== true) {
      return {
        success: false,
        transaction: result.transaction || undefined,
        network: requirements.network,
        payer: result.payer,
        errorReason:
          result.errorReason ?? `meridian_http_${response.status}`,
      };
    }

    return {
      success: true,
      transaction: result.transaction || undefined,
      network: requirements.network,
      payer: result.payer,
    };
  } catch (error) {
    return {
      success: false,
      network: requirements.network,
      errorReason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build public payment accepts with the Meridian-for-Dexter EVM substitution.
 * Extra rails remain first, Dexter Solana remains unchanged, and Meridian's
 * default EIP-3009 networks replace every Dexter CAIP-2 EVM entry.
 */
export async function buildPublicAccepts(
  runtime: IAgentRuntime,
  {
    amountAtomic,
    resourceUrl,
    description,
    extraAccepts = [],
  }: {
    amountAtomic: string;
    resourceUrl: string;
    description?: string;
    extraAccepts?: ReadonlyArray<object>;
  }
): Promise<PublicAcceptsResult> {
  const apiKey = getMeridianApiKey(runtime);
  const meridianEnabled = Boolean(apiKey);
  const serverService = runtime.getService<X402ServerService>(
    "X402_SERVER" as any
  );
  let dexterRequirements: DexterRequirementsEnvelope | undefined;

  if (serverService?.isAvailable()) {
    dexterRequirements = await serverService.buildAllRequirements({
      amountAtomic,
      resourceUrl,
      description,
    });
  }

  const rawDexterAccepts = dexterRequirements?.accepts ?? [];
  const publicDescription = description ?? "Paid endpoint";
  const publicDexterAccepts = rawDexterAccepts
    .filter((entry) => {
      if (!meridianEnabled) return true;
      const network = (entry as { network?: unknown }).network;
      return typeof network !== "string" || !network.startsWith("eip155:");
    })
    .map((entry) => ({
      resource: resourceUrl,
      description: publicDescription,
      mimeType: "application/json",
      ...entry,
    }));

  if (dexterRequirements && meridianEnabled) {
    dexterRequirements = {
      ...dexterRequirements,
      accepts: rawDexterAccepts.filter((entry) => {
        const network = (entry as { network?: unknown }).network;
        return typeof network !== "string" || !network.startsWith("eip155:");
      }),
    };
  }

  const creditedRecipient = getMeridianCreditedRecipient(runtime);
  const meridianAccepts =
    meridianEnabled && creditedRecipient
      ? DEFAULT_MERIDIAN_NETWORKS.map((name) =>
          buildMeridianRequirements({
            caip2: MERIDIAN_NETWORKS[name].caip2,
            amountAtomic,
            resourceUrl,
            description: publicDescription,
            creditedRecipient,
          })
        )
      : [];

  return {
    accepts: [...extraAccepts, ...publicDexterAccepts, ...meridianAccepts],
    dexterRequirements,
    meridianEnabled,
  };
}
