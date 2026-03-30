import { type UUID } from "@elizaos/core";

export interface X402PaymentConfig {
  networkId:
    | "base-mainnet"
    | "base-sepolia"
    | "ethereum-mainnet"
    | "solana-mainnet"
    | "polygon-mainnet"
    | "arbitrum-mainnet";
  receiveAddress: string;
  maxAutoPayUsd: number;
  /** Solana private key (base58) for Dexter payments */
  solanaPrivateKey?: string;
  /** EVM private key (hex) for Base/Polygon/Arbitrum payments */
  evmPrivateKey?: string;
  /** Access Pass tier (e.g. "1h", "24h") for time-limited unlimited access */
  accessPassTier?: string;
  /** Max spend for Access Pass purchase (e.g. "2.00") */
  accessPassMaxSpend?: string;
}

export interface X402ServiceListing {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  priceUsd: number;
  category: "ai" | "data" | "compute" | "oracle" | "swarm" | "defi" | "social";
  network: string;
  payToAddress: string;
  qualityScore?: number | null;
  verified?: boolean;
}

export interface PaymentRecord {
  id: UUID;
  timestamp: number;
  endpoint: string;
  amountUsd: number;
  txHash: string;
  network?: string;
  payer?: string;
  status: "pending" | "confirmed" | "failed";
  agentId: string;
}

export interface SwarmTaskRequest {
  taskId: string;
  agentName: string;
  prompt: string;
  paymentRequired: boolean;
  estimatedCostUsd?: number;
}

export interface SwarmTaskResult {
  taskId: string;
  output: string;
  tokensUsed: number;
  costUsd: number;
  completedAt: number;
}

export interface SwarmAPIResponse {
  id?: string;
  output?: string;
  response?: string;
  text?: string;
  agent_name?: string;
  tokens_used?: number;
  status?: string;
}

export interface X402SwarmsPluginConfig {
  payment: X402PaymentConfig;
  autoPayThresholdUsd?: number;
  enableServiceRegistration?: boolean;
  swarmServicePort?: number;
}

/**
 * Pre-built swarm template — maps user intent to a specific swarm
 * architecture, agent configuration, and execution parameters.
 */
export interface SwarmTemplate {
  /** Unique identifier, e.g. "research-pipeline" */
  id: string;
  /** Human-readable name, e.g. "ResearchPipeline" */
  name: string;
  /** One-line description for LLM classification */
  description: string;
  /** Which swarm architecture to use */
  swarmType: string;
  /** Regex patterns for fast keyword pre-filter */
  triggerPatterns: RegExp[];
  /** Example phrases that trigger this template (used in LLM classification prompt) */
  triggerExamples: string[];
  /** Fully specified agent configurations */
  agents: Array<{
    agent_name: string;
    system_prompt?: string | null;
    model_name?: string | null;
    role?: string | null;
    max_loops?: number | null;
    max_tokens?: number | null;
    temperature?: number | null;
  }>;
  /** Max loops for the swarm (default 1) */
  maxLoops?: number;
  /** Swarm-level rules injected into all agents */
  rules?: string;
}

/**
 * A single x402 data fetch — records what was paid for and what was received.
 */
export interface X402DataFetch {
  serviceName: string;
  endpoint: string;
  amountUsd: number;
  txHash: string;
  network?: string;
  data: string;
  fetchedAt: number;
  phase: "prefetch" | "swarm-requested";
}

/**
 * Result of a swarm run with x402-funded data.
 */
export interface SwarmWithPaymentResult {
  swarmOutput: string;
  swarmJobId: string;
  swarmType: string;
  executionTime: number;
  dataFetches: X402DataFetch[];
  totalX402Spend: number;
  rounds: number;
}

/**
 * Server-side x402 endpoint definition for selling services.
 */
export interface X402ServiceEndpoint {
  name: string;
  description: string;
  path: string;
  method: "GET" | "POST";
  priceUsd: string;
  free?: boolean;
}

/**
 * Revenue record for an incoming x402 payment.
 */
export interface X402RevenueRecord {
  endpoint: string;
  amountUsd: number;
  txHash: string;
  network: string;
  payer: string;
  timestamp: number;
}

/**
 * Persistent payment history record (stored in DB).
 */
export interface PaymentHistoryRecord {
  id: string;
  agentId: string;
  endpoint: string;
  domain: string;
  method: string;
  amountUsd: number;
  txHash: string;
  network?: string;
  payer?: string;
  status: "pending" | "confirmed" | "failed";
  responseStatus?: number;
  responseTimeMs?: number;
  qualityScore?: number;
  qualityReason?: string;
  responsePreview?: string;
  createdAt: number;
}

/**
 * Aggregate endpoint quality score (materialized in DB).
 */
export interface EndpointScore {
  agentId: string;
  domain: string;
  totalCalls: number;
  totalSpentUsd: number;
  avgQualityScore: number;
  avgResponseTimeMs: number;
  errorCount: number;
  lastCallAt: number;
}

/**
 * Cross-session budget state (persisted in DB).
 */
export interface BudgetState {
  agentId: string;
  dailySpentUsd: number;
  dailyResetAt: number;
  weeklySpentUsd: number;
  weeklyResetAt: number;
  monthlySpentUsd: number;
  monthlyResetAt: number;
  lifetimeSpentUsd: number;
  lifetimePayments: number;
  dailyBudgetUsd: number;
  weeklyBudgetUsd: number;
  monthlyBudgetUsd: number;
}
