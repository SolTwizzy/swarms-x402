import type { Plugin } from "@elizaos/core";
import { SignalService } from "./services/signalService.js";
import { generateSignal } from "./actions/generateSignal.js";
import { getLatestSignal } from "./actions/getLatestSignal.js";
import { signalRoutes } from "./routes/signalRoutes.js";

/**
 * SignalHawk plugin — adds signal generation actions, the SignalService,
 * and x402-protected routes on top of the base x402-swarms plugin.
 */
export const signalHawkPlugin: Plugin = {
  name: "plugin-signalhawk",
  description:
    "Trading signal generation via multi-analyst MajorityVoting swarms with x402-paid market data. Exposes paid REST endpoints for signal generation and retrieval.",
  actions: [generateSignal, getLatestSignal],
  services: [SignalService as any],
  routes: signalRoutes,
};
