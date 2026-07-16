import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMeridianRequirements,
  isMeridianPayment,
  MERIDIAN_FACILITATOR,
  MERIDIAN_NETWORKS,
  settleMeridianPayment,
} from "../../src/server/meridianGate.js";

const originalFetch = globalThis.fetch;
const creditedRecipient = "0x1111111111111111111111111111111111111111";

function paymentHeader(
  network = "base",
  to = MERIDIAN_FACILITATOR
): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network,
      payload: {
        signature: "0x1234",
        authorization: {
          from: "0x2222222222222222222222222222222222222222",
          to,
          value: "50000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"01".repeat(32)}`,
        },
      },
    })
  ).toString("base64");
}

function baseRequirements() {
  return buildMeridianRequirements({
    caip2: MERIDIAN_NETWORKS.base.caip2,
    amountAtomic: "50000",
    resourceUrl: "https://swarmx.io/x402/research",
    description: "Research",
    creditedRecipient,
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("buildMeridianRequirements", () => {
  it.each([
    ["base", "eip155:8453"],
    ["arbitrum", "eip155:42161"],
    ["bsc", "eip155:56"],
  ] as const)("builds the standard %s v1 accepts shape", (name, caip2) => {
    const config = MERIDIAN_NETWORKS[name];
    const requirement = buildMeridianRequirements({
      caip2,
      amountAtomic: "290000",
      resourceUrl: "https://swarmx.io/x402/rwa/stock-dd",
      description: "Stock DD",
      creditedRecipient,
    });

    expect(requirement).toEqual({
      scheme: "exact",
      network: name,
      asset: config.token,
      payTo: MERIDIAN_FACILITATOR,
      maxAmountRequired: "290000",
      resource: "https://swarmx.io/x402/rwa/stock-dd",
      description: "Stock DD",
      mimeType: "application/json",
      maxTimeoutSeconds: 300,
      extra: {
        name: config.tokenName,
        version: config.tokenVersion,
        creditedRecipient,
      },
    });
    expect(requirement.payTo).not.toBe(creditedRecipient);
  });
});

describe("isMeridianPayment", () => {
  it("detects a friendly Meridian network", () => {
    expect(isMeridianPayment(paymentHeader("base"))).toBe(true);
  });

  it("detects a known facilitator even when the friendly name is unknown", () => {
    expect(isMeridianPayment(paymentHeader("future-network"))).toBe(true);
  });

  it("does not claim Dexter or malformed headers", () => {
    const dexter = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: { network: "eip155:8453" },
      })
    ).toString("base64");
    expect(isMeridianPayment(dexter)).toBe(false);
    expect(isMeridianPayment("not-base64-json")).toBe(false);
  });
});

describe("settleMeridianPayment", () => {
  it("posts the decoded payload and server requirements with Bearer auth", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          transaction: "0xsettled",
          network: "base",
          payer: "0x2222222222222222222222222222222222222222",
        }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;
    const requirements = baseRequirements();
    const header = paymentHeader();

    const result = await settleMeridianPayment(header, requirements, "pk_live");

    expect(result).toEqual({
      success: true,
      transaction: "0xsettled",
      network: "base",
      payer: "0x2222222222222222222222222222222222222222",
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe("https://api.mrdn.finance/v1/settle");
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer pk_live",
          "Content-Type": "application/json",
        },
      })
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      paymentPayload: JSON.parse(Buffer.from(header, "base64").toString("utf8")),
      paymentRequirements: requirements,
    });
  });

  it("returns Meridian's failure reason for a rejected settlement", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: false,
          transaction: "",
          network: "base",
          errorReason: "insufficient_funds",
        }),
        { status: 400 }
      )
    ) as unknown as typeof fetch;

    await expect(
      settleMeridianPayment(paymentHeader(), baseRequirements(), "pk_live")
    ).resolves.toEqual({
      success: false,
      transaction: undefined,
      network: "base",
      payer: undefined,
      errorReason: "insufficient_funds",
    });
  });
});
