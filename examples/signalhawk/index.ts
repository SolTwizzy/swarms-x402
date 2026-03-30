/**
 * SignalHawk — ElizaOS v2 project entry point.
 *
 * Run with ElizaOS:  elizaos start
 * Standalone demo:   tsx examples/signalhawk/index.ts
 */
import "dotenv/config";
import type { Project, ProjectAgent } from "@elizaos/core";
import { signalHawkCharacter } from "./character.js";
import { x402SwarmsPlugin } from "../../src/index.js";
import { signalHawkPlugin } from "./plugin.js";

// ── ElizaOS v2 Project export ────────────────────────────────────
const agent: ProjectAgent = {
  character: signalHawkCharacter,
  plugins: [x402SwarmsPlugin, signalHawkPlugin],
};

export const project: Project = { agents: [agent] };
export default project;

// ── Standalone demo ──────────────────────────────────────────────

async function demo() {
  console.log("=== SignalHawk Demo ===\n");

  // 1. Plugin info
  console.log(`Base plugin: ${x402SwarmsPlugin.name}`);
  console.log(
    `  Actions: ${x402SwarmsPlugin.actions?.map((a) => a.name).join(", ")}`
  );
  console.log(
    `  Services: ${x402SwarmsPlugin.services?.map((s) => (s as any).serviceType).join(", ")}`
  );
  console.log();

  console.log(`SignalHawk plugin: ${signalHawkPlugin.name}`);
  console.log(
    `  Actions: ${signalHawkPlugin.actions?.map((a) => a.name).join(", ")}`
  );
  console.log(
    `  Services: ${signalHawkPlugin.services?.map((s) => (s as any).serviceType).join(", ")}`
  );
  console.log(
    `  Routes: ${signalHawkPlugin.routes?.map((r) => `${r.type} ${r.path}`).join(", ")}`
  );
  console.log();

  // 2. Check required keys
  const hasEvm = !!process.env.EVM_PRIVATE_KEY;
  const hasSolana = !!process.env.SOLANA_PRIVATE_KEY;
  const hasSwarms = !!process.env.SWARMS_API_KEY;
  const hasLLM =
    !!process.env.OPENAI_API_KEY || !!process.env.ANTHROPIC_API_KEY;

  console.log("--- Environment ---");
  console.log(
    `Wallets: EVM=${hasEvm ? "yes" : "MISSING"}, Solana=${hasSolana ? "yes" : "MISSING"}`
  );
  console.log(`Swarms: ${hasSwarms ? "yes" : "MISSING"}`);
  console.log(`LLM: ${hasLLM ? "yes" : "MISSING"}`);
  console.log();

  // 3. Signal service status
  console.log("--- Signal Service ---");
  console.log(
    "SignalService will be started by ElizaOS runtime at boot."
  );
  console.log(
    "Routes available: POST /api/signals/generate ($0.10), GET /api/signals/latest ($0.02), GET /api/signals/health (free)"
  );
  console.log();

  if (!hasSwarms) {
    console.log(
      "WARNING: SWARMS_API_KEY not set. Signal generation requires the Swarms API."
    );
  }
  if (!hasEvm && !hasSolana) {
    console.log(
      "WARNING: No wallet key set. x402 payments require EVM_PRIVATE_KEY or SOLANA_PRIVATE_KEY."
    );
  }

  console.log(
    "\n=== Demo complete. Use `elizaos start` with this project for the full agent runtime. ==="
  );
}

// Run demo if executed directly
demo().catch(console.error);
