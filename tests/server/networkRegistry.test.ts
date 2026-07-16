import { describe, expect, it } from "vitest";
import {
  caip2ForFriendlyId,
  friendlyIdForCaip2,
  resolveEnabledNetworks,
} from "../../src/server/networkRegistry.js";

type SettingValue = string | boolean | number | null;

function settings(values: Record<string, SettingValue>) {
  return (key: string): SettingValue => values[key] ?? null;
}

describe("networkRegistry", () => {
  it("parses multiple networks in priority order", () => {
    const networks = resolveEnabledNetworks(
      settings({
        X402_NETWORKS:
          "base-mainnet, solana-mainnet, arbitrum-mainnet",
        X402_RECEIVE_ADDRESS_EVM: "0xevm",
        X402_RECEIVE_ADDRESS_SOLANA: "solana-wallet",
      })
    );

    expect(networks).toEqual([
      {
        friendlyId: "base-mainnet",
        caip2: "eip155:8453",
        kind: "evm",
        payTo: "0xevm",
      },
      {
        friendlyId: "solana-mainnet",
        caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        kind: "solana",
        payTo: "solana-wallet",
      },
      {
        friendlyId: "arbitrum-mainnet",
        caip2: "eip155:42161",
        kind: "evm",
        payTo: "0xevm",
      },
    ]);
  });

  it("uses per-kind receive addresses before the global fallback", () => {
    const networks = resolveEnabledNetworks(
      settings({
        X402_NETWORKS: "base-mainnet,solana-mainnet",
        X402_RECEIVE_ADDRESS: "global-wallet",
        X402_RECEIVE_ADDRESS_EVM: "0xevm",
        X402_RECEIVE_ADDRESS_SOLANA: "solana-wallet",
      })
    );

    expect(networks.map(({ payTo }) => payTo)).toEqual([
      "0xevm",
      "solana-wallet",
    ]);
  });

  it("falls back to the global receive address for either network kind", () => {
    const networks = resolveEnabledNetworks(
      settings({
        X402_NETWORKS: "base-mainnet,solana-mainnet",
        X402_RECEIVE_ADDRESS: "global-wallet",
      })
    );

    expect(networks.map(({ payTo }) => payTo)).toEqual([
      "global-wallet",
      "global-wallet",
    ]);
  });

  it("uses the back-compatible X402_NETWORK_ID path", () => {
    const networks = resolveEnabledNetworks(
      settings({
        X402_NETWORK_ID: "polygon-mainnet",
        X402_RECEIVE_ADDRESS: "0xlegacy",
        X402_RECEIVE_ADDRESS_EVM: "0xignored",
      })
    );

    expect(networks).toEqual([
      {
        friendlyId: "polygon-mainnet",
        caip2: "eip155:137",
        kind: "evm",
        payTo: "0xlegacy",
      },
    ]);
  });

  it("defaults the back-compatible network to Base mainnet", () => {
    const networks = resolveEnabledNetworks(
      settings({ X402_RECEIVE_ADDRESS: "0xlegacy" })
    );

    expect(networks[0]?.friendlyId).toBe("base-mainnet");
  });

  it("skips unknown friendly IDs without throwing", () => {
    const networks = resolveEnabledNetworks(
      settings({
        X402_NETWORKS: "unknown-network,arbitrum-mainnet",
        X402_RECEIVE_ADDRESS_EVM: "0xevm",
      })
    );

    expect(networks.map(({ friendlyId }) => friendlyId)).toEqual([
      "arbitrum-mainnet",
    ]);
    // Legacy path: unknown X402_NETWORK_ID falls back to Base mainnet
    // (matches pre-registry behavior instead of disabling the sell-side).
    expect(
      resolveEnabledNetworks(
        settings({
          X402_NETWORK_ID: "unknown-network",
          X402_RECEIVE_ADDRESS: "0xlegacy",
        })
      )
    ).toEqual([
      {
        friendlyId: "base-mainnet",
        caip2: "eip155:8453",
        kind: "evm",
        payTo: "0xlegacy",
      },
    ]);
  });

  it("skips networks whose receive address is missing", () => {
    const networks = resolveEnabledNetworks(
      settings({
        X402_NETWORKS: "base-mainnet,solana-mainnet",
        X402_RECEIVE_ADDRESS_SOLANA: "solana-wallet",
      })
    );

    expect(networks.map(({ friendlyId }) => friendlyId)).toEqual([
      "solana-mainnet",
    ]);
    expect(
      resolveEnabledNetworks(settings({ X402_NETWORK_ID: "base-mainnet" }))
    ).toEqual([]);
  });

  it("resolves friendly and CAIP-2 identifiers in both directions", () => {
    expect(caip2ForFriendlyId("ethereum-mainnet")).toBe("eip155:1");
    expect(friendlyIdForCaip2("eip155:42161")).toBe(
      "arbitrum-mainnet"
    );
    expect(caip2ForFriendlyId("unknown-network")).toBeUndefined();
    expect(friendlyIdForCaip2("eip155:999999")).toBeUndefined();
  });
});
