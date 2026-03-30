import { Service, type IAgentRuntime } from "@elizaos/core";
import { searchAPIs, type DiscoveredAPI } from "@dexterai/x402/client";
import { X402WalletService } from "../../../src/services/x402WalletService.js";
import { SwarmsService } from "../../../src/services/swarmsService.js";
import {
  buildAnalystSwarm,
  parseSwarmVerdicts,
  computeConsensus,
} from "../swarms/analystSwarm.js";
import type { TradingSignal } from "../types.js";

interface CostTracker {
  totalBuySpend: number;
  totalSellRevenue: number;
  signalsGenerated: number;
}

/**
 * SignalService — discovers market data via x402 marketplace,
 * runs a multi-analyst swarm, and caches trading signals.
 */
export class SignalService extends Service {
  static serviceType = "SIGNAL";
  capabilityDescription =
    "Generates trading signals by orchestrating analyst swarms with x402-paid market data";

  private runtime!: IAgentRuntime;
  private cache = new Map<string, TradingSignal>();
  private costTracker: CostTracker = {
    totalBuySpend: 0,
    totalSellRevenue: 0,
    signalsGenerated: 0,
  };

  static async start(runtime: IAgentRuntime): Promise<SignalService> {
    const instance = new SignalService(runtime);
    instance.runtime = runtime;
    return instance;
  }

  async stop(): Promise<void> {
    this.cache.clear();
  }

  /**
   * Generate a trading signal for the given asset and timeframe.
   */
  async generateSignal(
    asset: string,
    timeframe: string
  ): Promise<TradingSignal> {
    const cacheKey = `${asset.toLowerCase()}-${timeframe.toLowerCase()}`;

    // 1. Discover price data APIs via OpenDexter marketplace
    let priceApis: DiscoveredAPI[] = [];
    let sentimentApis: DiscoveredAPI[] = [];
    try {
      [priceApis, sentimentApis] = await Promise.all([
        searchAPIs({ query: `${asset} price`, category: "defi", limit: 2 }),
        searchAPIs({ query: `${asset} news sentiment`, limit: 2 }),
      ]);
    } catch (err) {
      this.runtime.logger.warn(
        { error: err },
        "[SignalService] Failed to discover APIs, proceeding with no market data"
      );
    }

    // 2. Pay for top results (up to 2 total) via x402
    let priceData = "";
    let sentimentData = "";

    const walletService = this.runtime.getService<X402WalletService>(
      "X402_WALLET" as any
    );

    const topApis = [...priceApis, ...sentimentApis].slice(0, 2);

    if (walletService && topApis.length > 0) {
      for (const api of topApis) {
        try {
          const result = await walletService.payForResource(api.url);
          const text = await result.response.text().catch(() => "");
          this.costTracker.totalBuySpend += result.amountUsd;

          if (priceApis.includes(api)) {
            priceData += text + "\n";
          } else {
            sentimentData += text + "\n";
          }

          this.runtime.logger.info(
            { api: api.name, cost: result.amountUsd },
            "[SignalService] Paid for market data"
          );
        } catch (err) {
          this.runtime.logger.warn(
            { api: api.name, error: err },
            "[SignalService] Failed to pay for API, skipping"
          );
        }
      }
    }

    // 3. Build the analyst swarm
    const swarmParams = buildAnalystSwarm(
      asset,
      timeframe,
      priceData.trim(),
      sentimentData.trim()
    );

    // 4. Run the swarm via SwarmsService
    const swarmsService = this.runtime.getService<SwarmsService>(
      "SWARMS" as any
    );
    if (!swarmsService) {
      throw new Error("SwarmsService not available — set SWARMS_API_KEY");
    }

    const swarmResult = await swarmsService.runSwarm(swarmParams);
    const output =
      typeof swarmResult.output === "string"
        ? swarmResult.output
        : JSON.stringify(swarmResult.output);

    // 5. Parse verdicts and compute consensus
    const verdicts = parseSwarmVerdicts(output);
    const consensus = computeConsensus(verdicts);

    // 6. Construct signal
    const signal: TradingSignal = {
      asset: asset.toUpperCase(),
      signal: consensus.signal,
      confidence: consensus.confidence,
      timeframe,
      analysts: {
        technical: verdicts.technical as TradingSignal["analysts"]["technical"],
        sentiment: verdicts.sentiment as TradingSignal["analysts"]["sentiment"],
        onchain: verdicts.onchain as TradingSignal["analysts"]["onchain"],
      },
      consensus: consensus.consensus,
      costToGenerate: `$${this.costTracker.totalBuySpend.toFixed(4)}`,
      generatedAt: new Date().toISOString(),
    };

    // 7. Cache and track
    this.cache.set(cacheKey, signal);
    this.costTracker.signalsGenerated++;

    this.runtime.logger.info(
      {
        asset,
        signal: signal.signal,
        confidence: signal.confidence,
        consensus: signal.consensus,
      },
      "[SignalService] Signal generated"
    );

    return signal;
  }

  /**
   * Get the latest cached signal for an asset.
   */
  getLatestSignal(asset: string): TradingSignal | null {
    for (const [key, signal] of this.cache) {
      if (key.startsWith(asset.toLowerCase() + "-")) {
        return signal;
      }
    }
    return null;
  }

  /**
   * Get cost summary for this session.
   */
  getCostSummary(): { totalBuySpend: number; signalsGenerated: number } {
    return {
      totalBuySpend: this.costTracker.totalBuySpend,
      signalsGenerated: this.costTracker.signalsGenerated,
    };
  }
}
