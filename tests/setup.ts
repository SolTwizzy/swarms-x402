import { vi } from "vitest";
import type {
  IAgentRuntime,
  Memory,
  HandlerCallback,
} from "@elizaos/core";
import type { BudgetAccount } from "@dexterai/x402/client";

/**
 * Create a mock IAgentRuntime with configurable settings and services.
 */
export function createMockRuntime(overrides?: {
  settings?: Record<string, string | null>;
  services?: Record<string, unknown>;
  useModelReturn?: string;
}) {
  const settings = overrides?.settings ?? {};
  const services = overrides?.services ?? {};

  const runtime = {
    agentId: "test-agent-id",
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    getService: vi.fn((type: string) => services[type] ?? null),
    useModel: vi.fn(async () => overrides?.useModelReturn ?? "{}"),
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      success: vi.fn(),
      progress: vi.fn(),
      log: vi.fn(),
      clear: vi.fn(),
      child: vi.fn(() => runtime.logger),
      level: "info",
    },
    composeState: vi.fn(async () => ({
      values: {},
      data: {},
      text: "",
    })),
  } as unknown as IAgentRuntime;

  return runtime;
}

/**
 * Create a mock BudgetAccount with controllable state.
 */
export function createMockBudgetAccount(overrides?: {
  spentAmount?: number;
  remainingAmount?: number;
  payments?: number;
  ledger?: Array<{ amount: number; domain: string; network: string; timestamp: number }>;
  hourlySpend?: number;
  fetchResponse?: Response;
}): BudgetAccount {
  const spentAmount = overrides?.spentAmount ?? 0;
  const remainingAmount = overrides?.remainingAmount ?? 10;
  const payments = overrides?.payments ?? 0;
  const ledger = overrides?.ledger ?? [];
  const hourlySpend = overrides?.hourlySpend ?? 0;

  return {
    fetch: vi.fn(async () => overrides?.fetchResponse ?? new Response("ok", { status: 200 })),
    get spent() { return `$${spentAmount.toFixed(2)}`; },
    get remaining() { return `$${remainingAmount.toFixed(2)}`; },
    get payments() { return payments; },
    get spentAmount() { return spentAmount; },
    get remainingAmount() { return remainingAmount; },
    get ledger() { return ledger; },
    get hourlySpend() { return hourlySpend; },
    reset: vi.fn(),
  } as unknown as BudgetAccount;
}

/**
 * Create a mock X402WalletService.
 */
export function createMockWalletService(overrides?: {
  budgetAccount?: BudgetAccount | null;
  x402Fetch?: typeof globalThis.fetch;
  config?: Record<string, unknown>;
  payForResourceResult?: {
    txHash: string;
    network?: string;
    payer?: string;
    amountUsd: number;
    receipt?: unknown;
    response: Response;
  };
  paymentHistory?: Array<{ amount: number; domain: string; network: string; timestamp: number }>;
  hourlySpend?: number;
}) {
  const budgetAccount = overrides?.budgetAccount ?? createMockBudgetAccount();

  return {
    getBudgetAccount: vi.fn(() => overrides?.budgetAccount !== undefined ? overrides.budgetAccount : budgetAccount),
    getX402Fetch: vi.fn(() => overrides?.x402Fetch ?? vi.fn(async () => new Response("ok"))),
    payForResource: vi.fn(async () =>
      overrides?.payForResourceResult ?? {
        txHash: "5abc123",
        network: "eip155:84532",
        payer: "0x1234",
        amountUsd: 0.01,
        receipt: { success: true, transaction: "5abc123", network: "eip155:84532" },
        response: new Response('{"result":"success"}', { status: 200 }),
      }
    ),
    getPaymentHistory: vi.fn(() => overrides?.paymentHistory ?? []),
    getTotalSpentUsd: vi.fn(() => budgetAccount?.spentAmount ?? 0),
    getRemainingBudget: vi.fn(() => budgetAccount?.remainingAmount ?? 10),
    getHourlySpend: vi.fn(() => overrides?.hourlySpend ?? 0),
    getConfig: vi.fn(() => ({
      networkId: "base-sepolia",
      receiveAddress: "",
      maxAutoPayUsd: 0.1,
      accessPassTier: overrides?.config?.accessPassTier,
      ...(overrides?.config ?? {}),
    })),
  };
}

/**
 * Create a mock HandlerCallback.
 */
export function createMockCallback(): HandlerCallback {
  return vi.fn(async () => []) as unknown as HandlerCallback;
}

/**
 * Create a mock Memory with given text.
 */
export function createMockMessage(text: string): Memory {
  return {
    id: "msg-1" as any,
    entityId: "user-1" as any,
    agentId: "agent-1" as any,
    roomId: "room-1" as any,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}
