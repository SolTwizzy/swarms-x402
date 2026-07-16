import { Service, type IAgentRuntime } from "@elizaos/core";
import {
  wrapFetch,
  createBudgetAccount,
  getPaymentReceipt,
  X402Error,
  type BudgetAccount,
  type WrapFetchOptions,
  type PaymentReceipt,
} from "@dexterai/x402/client";
import type { X402PaymentConfig, PaymentHistoryRecord } from "../types.js";
import { caip2ForFriendlyId } from "../server/networkRegistry.js";
import type { PaymentMemoryService } from "./paymentMemoryService.js";

export interface PayForResourceOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface PayForResourceResult {
  txHash: string;
  network: string | undefined;
  payer: string | undefined;
  amountUsd: number;
  receipt: PaymentReceipt | undefined;
  response: Response;
}

/**
 * Manages the agent's x402 payment wallet via the Dexter SDK.
 * Uses BudgetAccount for automatic spending controls and payment tracking.
 */
export class X402WalletService extends Service {
  static serviceType = "X402_WALLET";
  capabilityDescription =
    "Manages x402 micropayments via Dexter SDK with budget controls, access passes, and marketplace discovery";

  private paymentConfig!: X402PaymentConfig;
  private budgetAccount: BudgetAccount | null = null;
  private x402Fetch: typeof globalThis.fetch | null = null;
  private agentRuntime: IAgentRuntime | null = null;

  static async start(runtime: IAgentRuntime): Promise<X402WalletService> {
    const instance = new X402WalletService(runtime);
    await instance.initialize(runtime);
    return instance;
  }

  async stop(): Promise<void> {
    this.budgetAccount = null;
    this.x402Fetch = null;
    this.agentRuntime = null;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.agentRuntime = runtime;

    const networkRaw = runtime.getSetting("X402_NETWORK_ID");
    const networksRaw = runtime.getSetting("X402_NETWORKS");
    const receiveRaw = runtime.getSetting("X402_RECEIVE_ADDRESS");
    const maxPayRaw = runtime.getSetting("X402_MAX_AUTO_PAY_USD");
    const solanaKey = runtime.getSetting("SOLANA_PRIVATE_KEY");
    const evmKey = runtime.getSetting("EVM_PRIVATE_KEY");
    const budgetRaw = runtime.getSetting("X402_BUDGET_USD");
    const facilitatorRaw = runtime.getSetting("X402_FACILITATOR_URL");
    const accessTierRaw = runtime.getSetting("X402_ACCESS_PASS_TIER");
    const accessMaxSpendRaw = runtime.getSetting("X402_ACCESS_PASS_MAX_SPEND");

    this.paymentConfig = {
      networkId:
        (networkRaw as X402PaymentConfig["networkId"]) ?? "base-mainnet",
      receiveAddress: receiveRaw != null ? String(receiveRaw) : "",
      maxAutoPayUsd: parseFloat(maxPayRaw != null ? String(maxPayRaw) : "0.10"),
      solanaPrivateKey: solanaKey != null ? String(solanaKey) : undefined,
      evmPrivateKey: evmKey != null ? String(evmKey) : undefined,
      accessPassTier: accessTierRaw != null ? String(accessTierRaw) : undefined,
      accessPassMaxSpend:
        accessMaxSpendRaw != null ? String(accessMaxSpendRaw) : undefined,
    };

    const hasWallet =
      !!this.paymentConfig.solanaPrivateKey ||
      !!this.paymentConfig.evmPrivateKey;

    if (!hasWallet) {
      runtime.logger.warn(
        "[X402WalletService] No wallet key configured (SOLANA_PRIVATE_KEY or EVM_PRIVATE_KEY). Payment features disabled."
      );
      return;
    }

    // Build wrapFetch options
    const fetchOpts: WrapFetchOptions = {
      verbose: false,
    };

    if (this.paymentConfig.solanaPrivateKey) {
      fetchOpts.walletPrivateKey = this.paymentConfig.solanaPrivateKey;
    }
    if (this.paymentConfig.evmPrivateKey) {
      fetchOpts.evmPrivateKey = this.paymentConfig.evmPrivateKey;
    }
    if (facilitatorRaw) {
      fetchOpts.facilitatorUrl = String(facilitatorRaw);
    }

    // Access Pass configuration
    if (this.paymentConfig.accessPassTier) {
      fetchOpts.accessPass = {
        preferTier: this.paymentConfig.accessPassTier,
        maxSpend: this.paymentConfig.accessPassMaxSpend ?? "2.00",
        autoRenew: true,
      };
    }

    // Determine preferred network from config
    const firstConfiguredNetwork = networksRaw != null
      ? String(networksRaw).split(",")[0]?.trim()
      : undefined;
    const preferred =
      (firstConfiguredNetwork
        ? caip2ForFriendlyId(firstConfiguredNetwork)
        : undefined) ??
      caip2ForFriendlyId(String(networkRaw ?? "base-mainnet"));
    if (preferred) {
      fetchOpts.preferredNetwork = preferred;
    }

    // Create BudgetAccount for spending controls
    const totalBudget = budgetRaw != null ? String(budgetRaw) : "10.00";
    const perRequest = String(this.paymentConfig.maxAutoPayUsd.toFixed(2));

    this.budgetAccount = createBudgetAccount({
      ...fetchOpts,
      budget: {
        total: totalBudget,
        perRequest,
        perHour: String(
          Math.min(
            parseFloat(totalBudget),
            this.paymentConfig.maxAutoPayUsd * 100
          ).toFixed(2)
        ),
      },
    });

    // Also create a plain wrapFetch for direct use
    this.x402Fetch = wrapFetch(fetch, fetchOpts);

    runtime.logger.info(
      {
        network: this.paymentConfig.networkId,
        maxAutoPayUsd: this.paymentConfig.maxAutoPayUsd,
        totalBudget,
        hasSolana: !!this.paymentConfig.solanaPrivateKey,
        hasEvm: !!this.paymentConfig.evmPrivateKey,
        accessPass: !!this.paymentConfig.accessPassTier,
      },
      "[X402WalletService] Initialized with Dexter SDK"
    );
  }

  /**
   * Get the x402-wrapped fetch that auto-pays for 402 responses.
   */
  getX402Fetch(): typeof globalThis.fetch {
    if (!this.x402Fetch) {
      throw new Error("X402 wallet not initialized — no wallet key configured");
    }
    return this.x402Fetch;
  }

  /**
   * Get the budget-controlled fetch for autonomous agent spending.
   */
  getBudgetAccount(): BudgetAccount | null {
    return this.budgetAccount;
  }

  /**
   * Pay for an x402-protected resource using the budget account.
   * The Dexter SDK handles the 402 → sign → retry flow automatically.
   * Supports arbitrary HTTP methods and bodies.
   */
  async payForResource(
    endpoint: string,
    options?: PayForResourceOptions
  ): Promise<PayForResourceResult> {
    if (!this.budgetAccount) {
      throw new Error("X402 wallet not initialized — no wallet key configured");
    }

    // Capture local references so that stop() during an in-flight payment
    // doesn't null them out from under us.
    const budgetAccount = this.budgetAccount;
    const runtime = this.agentRuntime;

    const spentBefore = budgetAccount.spentAmount;

    let response: Response;
    const startTime = Date.now();
    try {
      const init: RequestInit = {};
      if (options?.method) init.method = options.method;
      if (options?.headers) init.headers = options.headers;
      if (options?.body) init.body = options.body;

      response = await budgetAccount.fetch(
        endpoint,
        Object.keys(init).length > 0 ? init : undefined
      );
    } catch (err) {
      if (err instanceof X402Error) {
        const friendly = this.mapX402Error(err);
        throw new Error(friendly);
      }
      throw err;
    }
    const responseTimeMs = Date.now() - startTime;

    const spentAfter = budgetAccount.spentAmount;
    const amountPaid = spentAfter - spentBefore;

    // Extract real on-chain receipt from response
    const receipt = getPaymentReceipt(response);

    const result: PayForResourceResult = {
      txHash: receipt?.transaction ?? "no-payment-required",
      network: receipt?.network,
      payer: receipt?.payer,
      amountUsd: amountPaid,
      receipt,
      response,
    };

    // Log payment details
    if (amountPaid > 0 && runtime) {
      runtime.logger.info(
        {
          endpoint,
          txHash: result.txHash,
          network: result.network,
          payer: result.payer,
          amountUsd: amountPaid,
          remainingBudget: budgetAccount.remainingAmount,
        },
        "[X402WalletService] Payment completed"
      );
    }

    // Record payment in persistent memory (fire-and-forget)
    try {
      const memoryService = runtime?.getService("PAYMENT_MEMORY") as
        | PaymentMemoryService
        | undefined;
      if (memoryService) {
        let domain: string;
        try {
          domain = new URL(endpoint).hostname;
        } catch {
          domain = "unknown";
        }
        const responsePreview = await response
          .clone()
          .text()
          .catch(() => "")
          .then((t) => t.slice(0, 200));

        const record: PaymentHistoryRecord = {
          id: crypto.randomUUID(),
          agentId: runtime?.agentId ?? "unknown",
          endpoint,
          domain,
          method: options?.method ?? "GET",
          amountUsd: amountPaid,
          txHash: result.txHash,
          network: result.network,
          payer: result.payer,
          status: "confirmed",
          responseStatus: response.status,
          responseTimeMs,
          responsePreview,
          createdAt: Date.now(),
        };

        // Catch async rejection so it never becomes an unhandled promise rejection
        void memoryService.recordPayment(record).catch(() => {});
      }
    } catch {
      // Recording failure must never break the payment flow
    }

    return result;
  }

  private mapX402Error(err: X402Error): string {
    switch (err.code) {
      case "insufficient_balance":
        return `Insufficient USDC balance. Fund your wallet. ${err.message}`;
      case "amount_exceeds_max":
        return `Payment exceeds per-request limit ($${this.paymentConfig.maxAutoPayUsd}). ${err.message}`;
      case "payment_rejected":
        return `Payment rejected (budget exhausted or domain blocked). ${err.message}`;
      case "facilitator_settle_failed":
        return `On-chain settlement failed. ${err.message}`;
      case "facilitator_timeout":
      case "rpc_timeout":
        return `Network timeout during payment. Retry may succeed. ${err.message}`;
      case "user_rejected_signature":
        return `Payment signature rejected. ${err.message}`;
      case "access_pass_expired":
        return `Access pass expired. A new one will be purchased on next call. ${err.message}`;
      default:
        return `x402 error [${err.code}]: ${err.message}`;
    }
  }

  getPaymentHistory(): Array<{
    amount: number;
    domain: string;
    network: string;
    timestamp: number;
  }> {
    if (!this.budgetAccount) return [];
    return [...this.budgetAccount.ledger];
  }

  getTotalSpentUsd(): number {
    return this.budgetAccount?.spentAmount ?? 0;
  }

  getRemainingBudget(): number {
    return this.budgetAccount?.remainingAmount ?? 0;
  }

  getHourlySpend(): number {
    return this.budgetAccount?.hourlySpend ?? 0;
  }

  getConfig(): X402PaymentConfig {
    return { ...this.paymentConfig };
  }
}
