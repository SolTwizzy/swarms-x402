import type { Route } from "@elizaos/core";
import { x402Gate } from "../../../src/server/x402Gate.js";
import { SignalService } from "../services/signalService.js";

/**
 * SignalHawk x402-protected routes.
 *
 * POST /api/signals/generate — $0.10 — runs full analyst swarm pipeline
 * GET  /api/signals/latest   — $0.02 — returns cached signal for an asset
 * GET  /api/signals/health   — FREE  — service status and cost summary
 */
export const signalRoutes: Route[] = [
  // ── POST /api/signals/generate — $0.10 ──────────────────────────
  {
    type: "POST",
    path: "/api/signals/generate",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.10",
        description: "Generate multi-analyst trading signal",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const asset = body.asset;
      const timeframe = body.timeframe ?? "4h";

      if (!asset || typeof asset !== "string") {
        res.status(400).json({ error: "Missing required field: asset" });
        return;
      }

      const signalService = runtime.getService<SignalService>("SIGNAL" as any);
      if (!signalService) {
        res.status(503).json({ error: "SignalService unavailable" });
        return;
      }

      try {
        const signal = await signalService.generateSignal(asset, timeframe);
        res.json({
          signal,
          payment: {
            amount: "0.10",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[signals/generate] Signal generation failed"
        );
        res.status(500).json({ error: "Signal generation failed" });
      }
    },
  },

  // ── GET /api/signals/latest — $0.02 ─────────────────────────────
  {
    type: "GET",
    path: "/api/signals/latest",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.02",
        description: "Retrieve latest cached trading signal",
      });
      if (!gate.paid) return;

      const asset =
        (req as any).query?.asset ?? (req as any).params?.asset ?? "";
      if (!asset || typeof asset !== "string") {
        res.status(400).json({ error: "Missing required query param: asset" });
        return;
      }

      const signalService = runtime.getService<SignalService>("SIGNAL" as any);
      if (!signalService) {
        res.status(503).json({ error: "SignalService unavailable" });
        return;
      }

      const signal = signalService.getLatestSignal(asset);
      if (!signal) {
        res.status(404).json({
          error: `No cached signal for ${asset.toUpperCase()}`,
        });
        return;
      }

      res.json({
        signal,
        payment: {
          amount: "0.02",
          transaction: gate.transaction,
          network: gate.network,
        },
      });
    },
  },

  // ── GET /api/signals/health — FREE ──────────────────────────────
  {
    type: "GET",
    path: "/api/signals/health",
    name: "signalhawk-health",
    public: true,
    handler: async (_req, res, runtime) => {
      const signalService = runtime.getService<SignalService>(
        "SIGNAL" as any
      );
      const summary = signalService?.getCostSummary() ?? {
        signalsGenerated: 0,
        totalBuySpend: 0,
      };

      res.json({
        status: "ok",
        signalsGenerated: summary.signalsGenerated,
        totalBuySpend: `$${summary.totalBuySpend.toFixed(4)}`,
      });
    },
  },
];
