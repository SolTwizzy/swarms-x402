import { Service, type IAgentRuntime } from "@elizaos/core";
import { createX402Server, type X402Server } from "@dexterai/x402/server";
import type { X402RevenueRecord, X402ServiceEndpoint } from "../types.js";

/**
 * Server-side x402 service for SELLING agent capabilities.
 * Manages payment verification and settlement for incoming requests.
 */
export class X402ServerService extends Service {
  static serviceType = "X402_SERVER";
  capabilityDescription =
    "Accepts x402 payments for agent services — verifies and settles incoming USDC payments";

  private x402Server: X402Server | null = null;
  private revenueHistory: X402RevenueRecord[] = [];
  private receiveAddress: string = "";
  private network: string = "";

  static async start(runtime: IAgentRuntime): Promise<X402ServerService> {
    const instance = new X402ServerService(runtime);
    await instance.initialize(runtime);
    return instance;
  }

  async stop(): Promise<void> {
    this.x402Server = null;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    const receiveAddr = runtime.getSetting("X402_RECEIVE_ADDRESS");
    if (!receiveAddr) {
      runtime.logger.info(
        "[X402ServerService] X402_RECEIVE_ADDRESS not set. Sell-side features disabled."
      );
      return;
    }

    this.receiveAddress = String(receiveAddr);

    const networkRaw = runtime.getSetting("X402_NETWORK_ID");
    const facilitatorRaw = runtime.getSetting("X402_FACILITATOR_URL");

    // Map friendly network ID to CAIP-2
    const networkMap: Record<string, string> = {
      "base-mainnet": "eip155:8453",
      "base-sepolia": "eip155:84532",
      "ethereum-mainnet": "eip155:1",
      "solana-mainnet": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "polygon-mainnet": "eip155:137",
      "arbitrum-mainnet": "eip155:42161",
    };
    this.network = networkMap[String(networkRaw ?? "base-mainnet")] ?? "eip155:8453";

    this.x402Server = createX402Server({
      payTo: this.receiveAddress,
      network: this.network,
      facilitatorUrl: facilitatorRaw ? String(facilitatorRaw) : undefined,
    });

    runtime.logger.info(
      { receiveAddress: this.receiveAddress, network: this.network },
      "[X402ServerService] Initialized — accepting x402 payments"
    );
  }

  isAvailable(): boolean {
    return this.x402Server !== null;
  }

  getServer(): X402Server {
    if (!this.x402Server) {
      throw new Error("X402 server not initialized — set X402_RECEIVE_ADDRESS");
    }
    return this.x402Server;
  }

  getReceiveAddress(): string {
    return this.receiveAddress;
  }

  getNetwork(): string {
    return this.network;
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
