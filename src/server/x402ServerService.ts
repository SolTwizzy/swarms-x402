import { Service, type IAgentRuntime } from "@elizaos/core";
import { createX402Server, type X402Server } from "@dexterai/x402/server";
import type { X402RevenueRecord, X402ServiceEndpoint } from "../types.js";
import {
  resolveEnabledNetworks,
  type NetworkConfig,
} from "./networkRegistry.js";

interface X402ServerInstance {
  config: NetworkConfig;
  server: X402Server;
}

interface BuildAllRequirementsOptions {
  amountAtomic: string;
  resourceUrl: string;
  description?: string;
}

/**
 * Server-side x402 service for SELLING agent capabilities.
 * Manages payment verification and settlement for incoming requests.
 */
export class X402ServerService extends Service {
  static serviceType = "X402_SERVER";
  capabilityDescription =
    "Accepts x402 payments for agent services — verifies and settles incoming USDC payments";

  private instances: X402ServerInstance[] = [];
  private instanceIndexByNetwork = new Map<string, number>();
  private revenueHistory: X402RevenueRecord[] = [];

  static async start(runtime: IAgentRuntime): Promise<X402ServerService> {
    const instance = new X402ServerService(runtime);
    await instance.initialize(runtime);
    return instance;
  }

  async stop(): Promise<void> {
    this.instances = [];
    this.instanceIndexByNetwork.clear();
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    const configs = resolveEnabledNetworks((key) => runtime.getSetting(key));
    if (configs.length === 0) {
      runtime.logger.info(
        "[X402ServerService] X402_RECEIVE_ADDRESS not set. Sell-side features disabled."
      );
      return;
    }

    const facilitatorRaw = runtime.getSetting("X402_FACILITATOR_URL");
    const facilitatorUrl = facilitatorRaw ? String(facilitatorRaw) : undefined;

    this.instances = configs.map((config) => ({
      config,
      server: createX402Server({
        payTo: config.payTo,
        network: config.caip2,
        facilitatorUrl,
      }),
    }));
    this.instanceIndexByNetwork = new Map(
      this.instances.map(({ config }, index) => [config.caip2, index])
    );

    const primary = this.instances[0];
    runtime.logger.info(
      {
        receiveAddress: primary.config.payTo,
        network: primary.config.caip2,
        networks: configs.map((config) => config.caip2),
      },
      "[X402ServerService] Initialized — accepting x402 payments"
    );
  }

  private getPrimaryInstance(): X402ServerInstance {
    const primary = this.instances[0];
    if (!primary) {
      throw new Error("X402 server not initialized — set X402_RECEIVE_ADDRESS");
    }
    return primary;
  }

  isAvailable(): boolean {
    return this.instances.length > 0;
  }

  /** Get all enabled network configurations in priority order. */
  getNetworks(): NetworkConfig[] {
    return this.instances.map(({ config }) => ({ ...config }));
  }

  /** Get the primary network configuration. */
  getPrimaryNetwork(): NetworkConfig {
    return { ...this.getPrimaryInstance().config };
  }

  /** Get the x402 server configured for a CAIP-2 network. */
  getServerFor(caip2: string): X402Server | undefined {
    const index = this.instanceIndexByNetwork.get(caip2);
    return index === undefined ? undefined : this.instances[index]?.server;
  }

  /** Get the payment receive address for a CAIP-2 network. */
  getPayToFor(caip2: string): string | undefined {
    const index = this.instanceIndexByNetwork.get(caip2);
    return index === undefined ? undefined : this.instances[index]?.config.payTo;
  }

  /** Build and merge payment requirements for every enabled network. */
  async buildAllRequirements(
    opts: BuildAllRequirementsOptions
  ): Promise<{
    x402Version: number;
    resource: unknown;
    accepts: object[];
  }> {
    this.getPrimaryInstance();

    const requirements = await Promise.all(
      this.instances.map(({ server }) => server.buildRequirements(opts))
    );
    const primaryRequirements = requirements[0];

    return {
      x402Version: primaryRequirements.x402Version,
      resource: primaryRequirements.resource,
      accepts: requirements.flatMap((requirement) => requirement.accepts),
    };
  }

  /** Get the primary x402 server. */
  getServer(): X402Server {
    return this.getPrimaryInstance().server;
  }

  /** Get the primary payment receive address. */
  getReceiveAddress(): string {
    return this.instances[0]?.config.payTo ?? "";
  }

  /** Get the primary CAIP-2 network identifier. */
  getNetwork(): string {
    return this.instances[0]?.config.caip2 ?? "";
  }

  /**
   * Record a successful incoming payment.
   */
  recordRevenue(record: X402RevenueRecord): void {
    this.revenueHistory.push(record);
  }

  getRevenueHistory(): X402RevenueRecord[] {
    return [...this.revenueHistory];
  }

  getTotalRevenueUsd(): number {
    return this.revenueHistory.reduce((sum, r) => sum + r.amountUsd, 0);
  }

  getSettlementCount(): number {
    return this.revenueHistory.length;
  }
}
