/**
 * Hono HTTP app exposing the x402 facilitator contract:
 *   GET  /health     — liveness + config summary
 *   GET  /supported  — advertised x402 kinds (Coinbase facilitator shape)
 *   POST /verify      — { paymentPayload, paymentRequirements } -> VerifyResponse
 *   POST /settle      — { paymentPayload, paymentRequirements } -> SettleResponse (gated)
 *
 * Exported as `app` so tests can drive it via app.request() without a socket.
 */
import { Hono } from "hono";
import { verifyPayment } from "./verify.js";
import { settlePayment } from "./settle.js";
import { NETWORK, CHAIN_ID, USDG_ADDRESS, USDG_EIP712_NAME, USDG_EIP712_VERSION, PAY_TO, settleEnabled, skipOnchain } from "./config.js";

export const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "swarmx-rh-facilitator",
    network: NETWORK,
    chainId: CHAIN_ID,
    asset: USDG_ADDRESS,
    payTo: PAY_TO,
    settleEnabled: settleEnabled(),
    skipOnchain: skipOnchain(),
  }),
);

app.get("/supported", (c) =>
  c.json({
    kinds: [
      {
        x402Version: 1,
        scheme: "exact",
        network: NETWORK,
        extra: { name: USDG_EIP712_NAME, version: USDG_EIP712_VERSION, asset: USDG_ADDRESS },
      },
    ],
  }),
);

app.post("/verify", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.paymentPayload || !body?.paymentRequirements) {
    return c.json({ isValid: false, invalidReason: "invalid_payload" }, 400);
  }
  const r = await verifyPayment(body.paymentPayload, body.paymentRequirements);
  return c.json({ isValid: r.isValid, invalidReason: r.invalidReason, payer: r.payer });
});

app.post("/settle", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.paymentPayload || !body?.paymentRequirements) {
    return c.json({ success: false, transaction: "", network: NETWORK, errorReason: "invalid_payload" }, 400);
  }
  const r = await settlePayment(body.paymentPayload, body.paymentRequirements);
  return c.json(r);
});

export default app;
