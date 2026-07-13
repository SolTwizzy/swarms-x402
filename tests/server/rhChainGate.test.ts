import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRhChainRequirements,
  isRhChainPayment,
  RH_FACILITATOR_URL,
  settleRhChainPayment,
  usdToUsdgAtomic,
} from "../../src/server/rhChainGate.js";

const originalFetch = globalThis.fetch;

function encodePayment(network: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network,
      payload: {
        signature: "0xsigned",
        authorization: {
          from: "0xpayer",
          to: "0xpayee",
          value: "290000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: "0xnonce",
        },
      },
    })
  ).toString("base64");
}

const requirements = buildRhChainRequirements({
  amountAtomic: "290000",
  resourceUrl: "/x402/rwa/stock-dd",
  description: "Stock DD",
});

describe("Robinhood Chain payment gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("verifies then settles a valid RH-Chain payment", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ isValid: true, payer: "0xpayer" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            transaction: "0xtransaction",
            network: "eip155:4663",
            payer: "0xpayer",
          }),
          { status: 200 }
        )
      ) as unknown as typeof fetch;

    const result = await settleRhChainPayment(encodePayment("eip155:4663"), requirements);

    expect(result).toEqual({
      paid: true,
      transaction: "0xtransaction",
      payer: "0xpayer",
      reason: undefined,
    });
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      `${RH_FACILITATOR_URL}/verify`,
      expect.objectContaining({ method: "POST" })
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      `${RH_FACILITATOR_URL}/settle`,
      expect.objectContaining({ method: "POST" })
    );
  });

  it("does not settle when facilitator verification fails", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ isValid: false, invalidReason: "bad_signature" }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await settleRhChainPayment(encodePayment("eip155:4663"), requirements);

    expect(result).toEqual({ paid: false, reason: "bad_signature" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns unpaid when facilitator settlement fails", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ isValid: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, errorReason: "reverted" }), { status: 200 })
      ) as unknown as typeof fetch;

    const result = await settleRhChainPayment(encodePayment("eip155:4663"), requirements);

    expect(result).toEqual({
      paid: false,
      transaction: undefined,
      payer: undefined,
      reason: "reverted",
    });
  });

  it("identifies only eip155:4663 payment payloads", () => {
    expect(isRhChainPayment(encodePayment("eip155:4663"))).toBe(true);
    expect(isRhChainPayment(encodePayment("solana:mainnet"))).toBe(false);
  });

  it("converts USD to six-decimal USDG atomic units", () => {
    expect(usdToUsdgAtomic("0.29")).toBe("290000");
  });
});
