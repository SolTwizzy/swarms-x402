/**
 * Entry point. `bun run src/index.ts` starts the facilitator HTTP server.
 * Bun serves the default export { port, fetch }.
 */
import app from "./server.js";
import { PORT, NETWORK, CHAIN_ID, USDG_ADDRESS, settleEnabled } from "./config.js";

console.log(
  `[facilitator] swarmx-rh-facilitator listening on :${PORT} | network=${NETWORK} chainId=${CHAIN_ID} asset=${USDG_ADDRESS} | settle=${settleEnabled() ? "ENABLED" : "disabled"}`,
);

export default { port: PORT, fetch: app.fetch };
