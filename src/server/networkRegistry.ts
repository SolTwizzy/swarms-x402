/**
 * Canonical x402 network metadata shared by sell-side and buy-side services.
 */

export type NetworkKind = "evm" | "solana";

export interface NetworkDescriptor {
  friendlyId: string;
  caip2: string;
  kind: NetworkKind;
}

export interface NetworkConfig extends NetworkDescriptor {
  payTo: string;
}

export const NETWORK_REGISTRY: Readonly<Record<string, NetworkDescriptor>> = {
  "base-mainnet": {
    friendlyId: "base-mainnet",
    caip2: "eip155:8453",
    kind: "evm",
  },
  "base-sepolia": {
    friendlyId: "base-sepolia",
    caip2: "eip155:84532",
    kind: "evm",
  },
  "ethereum-mainnet": {
    friendlyId: "ethereum-mainnet",
    caip2: "eip155:1",
    kind: "evm",
  },
  "solana-mainnet": {
    friendlyId: "solana-mainnet",
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    kind: "solana",
  },
  "polygon-mainnet": {
    friendlyId: "polygon-mainnet",
    caip2: "eip155:137",
    kind: "evm",
  },
  "arbitrum-mainnet": {
    friendlyId: "arbitrum-mainnet",
    caip2: "eip155:42161",
    kind: "evm",
  },
};

type GetSetting = (key: string) => string | boolean | number | null;

function readSetting(getSetting: GetSetting, key: string): string | undefined {
  const value = getSetting(key);
  if (value == null) return undefined;

  const normalized = String(value).trim();
  return normalized || undefined;
}

/**
 * Resolve the ordered x402 networks and their receive addresses from settings.
 * The first returned entry is the primary network.
 */
export function resolveEnabledNetworks(getSetting: GetSetting): NetworkConfig[] {
  const configuredNetworks = readSetting(getSetting, "X402_NETWORKS");

  if (!configuredNetworks) {
    const friendlyId =
      readSetting(getSetting, "X402_NETWORK_ID") ?? "base-mainnet";
    // Legacy behavior: an unknown X402_NETWORK_ID falls back to Base mainnet
    // rather than disabling the sell-side.
    const descriptor =
      NETWORK_REGISTRY[friendlyId] ?? NETWORK_REGISTRY["base-mainnet"];
    const payTo = readSetting(getSetting, "X402_RECEIVE_ADDRESS");

    return descriptor && payTo ? [{ ...descriptor, payTo }] : [];
  }

  const globalPayTo = readSetting(getSetting, "X402_RECEIVE_ADDRESS");
  const evmPayTo =
    readSetting(getSetting, "X402_RECEIVE_ADDRESS_EVM") ?? globalPayTo;
  const solanaPayTo =
    readSetting(getSetting, "X402_RECEIVE_ADDRESS_SOLANA") ?? globalPayTo;

  return configuredNetworks
    .split(",")
    .map((friendlyId) => friendlyId.trim())
    .flatMap((friendlyId): NetworkConfig[] => {
      const descriptor = NETWORK_REGISTRY[friendlyId];
      if (!descriptor) return [];

      const payTo = descriptor.kind === "evm" ? evmPayTo : solanaPayTo;
      return payTo ? [{ ...descriptor, payTo }] : [];
    });
}

/** Resolve a friendly network ID to its CAIP-2 identifier. */
export function caip2ForFriendlyId(id: string): string | undefined {
  return NETWORK_REGISTRY[id]?.caip2;
}

/** Resolve a CAIP-2 identifier to its friendly network ID. */
export function friendlyIdForCaip2(caip2: string): string | undefined {
  return Object.values(NETWORK_REGISTRY).find(
    (descriptor) => descriptor.caip2 === caip2
  )?.friendlyId;
}
