/**
 * Example: ElizaOS v2 agent with x402 + Swarms plugin (Dexter SDK)
 *
 * Run: bun run example
 * Requires: EVM_PRIVATE_KEY (or SOLANA_PRIVATE_KEY), OPENAI_API_KEY in .env
 */
import "dotenv/config";
import { type Project, type ProjectAgent, stringToUuid } from "@elizaos/core";
import { x402SwarmsPlugin } from "../src/index.js";
import { searchAPIs } from "@dexterai/x402/client";

const character = {
  id: stringToUuid("x402-demo-agent"),
  name: "PayAgent",
  bio: [
    "An autonomous AI agent that can pay for x402-protected APIs and delegate to Swarms.",
  ],
  system:
    "You are PayAgent, an autonomous agent capable of accessing paid APIs via x402 micropayments on multiple chains (Base, Solana, Polygon, Arbitrum). You can pay up to $0.10 per API call automatically. Use DISCOVER_X402_SERVICES to find services on OpenDexter, PAY_FOR_X402_SERVICE to access them, or DELEGATE_TO_SWARM for complex multi-agent tasks.",
  plugins: [],
  settings: {
    X402_NETWORK_ID: process.env.X402_NETWORK_ID ?? "base-sepolia",
    X402_MAX_AUTO_PAY_USD: process.env.X402_MAX_AUTO_PAY_USD ?? "0.10",
    X402_BUDGET_USD: process.env.X402_BUDGET_USD ?? "10.00",
    X402_RECEIVE_ADDRESS: process.env.X402_RECEIVE_ADDRESS ?? "",
    EVM_PRIVATE_KEY: process.env.EVM_PRIVATE_KEY ?? "",
    SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY ?? "",
    SWARMS_API_KEY: process.env.SWARMS_API_KEY ?? "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  },
};

// v2 Project/ProjectAgent export (for use with `elizaos start`)
const agent: ProjectAgent = {
  character,
  plugins: [x402SwarmsPlugin],
};
export const project: Project = { agents: [agent] };
export default project;

// --- Standalone demo (runs when executed directly) ---

async function demo() {
  console.log("=== eliza-x402-swarms Demo ===\n");

  // 1. Plugin info
  console.log(`Plugin: ${x402SwarmsPlugin.name}`);
  console.log(`Actions: ${x402SwarmsPlugin.actions?.map((a) => a.name).join(", ")}`);
  console.log(`Services: ${x402SwarmsPlugin.services?.map((s) => (s as any).serviceType).join(", ")}`);
  console.log();

  // 2. Check wallet keys
  const hasEvm = !!process.env.EVM_PRIVATE_KEY;
  const hasSolana = !!process.env.SOLANA_PRIVATE_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasSwarms = !!process.env.SWARMS_API_KEY;
  console.log(`Wallets: EVM=${hasEvm ? "yes" : "MISSING"}, Solana=${hasSolana ? "yes" : "MISSING"}`);
  console.log(`LLM: OpenAI=${hasOpenAI ? "yes" : "MISSING"}`);
  console.log(`Swarms: ${hasSwarms ? "yes" : "not configured (optional)"}`);
  console.log();

  // 3. Test OpenDexter marketplace discovery
  console.log("--- OpenDexter Marketplace Discovery ---");
  try {
    const apis = await searchAPIs({ limit: 5, sort: "quality_score" });
    if (apis.length === 0) {
      console.log("No APIs found on marketplace.");
    } else {
      for (const api of apis) {
        console.log(
          `  ${api.verified ? "[verified]" : "         "} ${api.name} — ${api.price}/call — ${api.category} — ${api.url.slice(0, 60)}`
        );
      }
    }
    console.log(`  Found ${apis.length} API(s) on OpenDexter.\n`);
  } catch (err) {
    console.log(`  Marketplace error: ${err instanceof Error ? err.message : err}\n`);
  }

  // 4. Test x402 wallet initialization
  console.log("--- X402 Wallet Service ---");
  if (hasEvm || hasSolana) {
    const { X402WalletService } = await import("../src/services/x402WalletService.js");
    // Create a minimal mock runtime for standalone testing
    const mockRuntime = {
      getSetting: (key: string) => process.env[key] ?? character.settings[key as keyof typeof character.settings] ?? null,
      logger: { info: console.log, warn: console.warn, error: console.error },
    } as any;

    try {
      const service = await X402WalletService.start(mockRuntime);
      const config = service.getConfig();
      const budget = service.getBudgetAccount();
      console.log(`  Network: ${config.networkId}`);
      console.log(`  Auto-pay limit: $${config.maxAutoPayUsd}/request`);
      console.log(`  Budget: ${budget?.remaining ?? "not available"}`);
      console.log(`  Wallet ready.\n`);
      await service.stop();
    } catch (err) {
      console.log(`  Wallet init error: ${err instanceof Error ? err.message : err}\n`);
    }
  } else {
    console.log("  Skipped — no wallet keys configured.\n");
  }

  console.log("=== Demo complete. Use `elizaos start` with this project for full agent runtime. ===");
}

// Run demo if executed directly (not imported)
demo().catch(console.error);
