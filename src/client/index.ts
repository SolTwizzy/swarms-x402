/**
 * x402-swarms Client SDK
 *
 * Dead-simple one-liner access to all x402-swarms platform endpoints.
 * Handles x402 micropayments automatically — no protocol knowledge required.
 *
 * @example
 * ```ts
 * import { createClient } from "@elizaos/plugin-x402-swarms/client";
 *
 * const client = createClient({
 *   walletPrivateKey: process.env.SOLANA_PRIVATE_KEY,
 * });
 *
 * const report = await client.research("State of Solana DeFi in 2026");
 * const analysis = await client.analyze("Bitcoin ETF impact on altcoins");
 * const wallet = await client.analyzeWallet("So11...address");
 * ```
 *
 * @module
 */

import { wrapFetch, type WrapFetchOptions } from "@dexterai/x402/client";

// ── Configuration ────────────────────────────────────────────────────

/** Configuration for the x402-swarms client. */
export interface X402SwarmsClientConfig {
  /** Solana private key (base58) for automatic USDC payments. */
  walletPrivateKey?: string;
  /** EVM private key (hex) for automatic USDC payments on Base/Polygon/Arbitrum. */
  evmPrivateKey?: string;
  /** Base URL of the x402-swarms platform. Defaults to production. */
  baseUrl?: string;
  /** Maximum payment per request in atomic units (USDC has 6 decimals). Defaults to "100000" ($0.10). */
  maxAmountAtomic?: string;
  /** Preferred network in CAIP-2 format (e.g. "eip155:8453" for Base mainnet). */
  preferredNetwork?: string;
}

// ── Response Types ───────────────────────────────────────────────────

/** Payment metadata included in every paid response. */
export interface PaymentInfo {
  amount: string;
  transaction: string;
  network: string;
}

/** Response from POST /x402/research */
export interface ResearchResponse {
  result: string;
  template: string;
  payment: PaymentInfo;
}

/** Response from POST /x402/analyze */
export interface AnalyzeResponse {
  result: string;
  template: string;
  payment: PaymentInfo;
}

/** Response from POST /x402/agent */
export interface AgentResponse {
  result: string;
  payment: PaymentInfo;
}

/** A single token holding returned by the wallet analyzer. */
export interface TokenHolding {
  mint: string;
  amount: number;
  decimals: number;
  uiAmount: number;
  symbol: string;
}

/** Response from POST /x402/wallet-analyzer */
export interface WalletAnalysisResponse {
  address: string;
  solBalance: number;
  tokens: TokenHolding[];
  tokenCount: number;
  analyzedAt: string;
  payment: PaymentInfo;
}

/** A single entry in the service catalog. */
export interface CatalogEntry {
  name: string;
  description: string;
  path: string;
  method: "GET" | "POST";
  priceUsd: string;
  free?: boolean;
}

/** Response from GET /x402/health */
export interface HealthResponse {
  status: string;
  receiveAddress: string;
  network: string;
  totalRevenue: number;
  settlements: number;
}

/** Response from GET /x402/wallet-analyzer/health */
export interface WalletAnalyzerHealthResponse {
  status: string;
  heliusConfigured: boolean;
  receiveAddress: string;
  network: string;
  price: string;
}

/** Response from POST /x402/summarize */
export interface SummarizeResponse {
  summary: string;
  wordCount: number;
  payment: PaymentInfo;
}

/** Response from POST /x402/translate */
export interface TranslateResponse {
  translation: string;
  sourceLanguage: string;
  targetLanguage: string;
  payment: PaymentInfo;
}

/** Response from POST /x402/code-review */
export interface CodeReviewResponse {
  security: string;
  performance: string;
  style: string;
  overallScore: string;
  rawOutput: string;
  template: string;
  payment: PaymentInfo;
}

/** Response from POST /x402/write */
export interface WriteResponse {
  content: string;
  wordCount: number;
  template: string;
  payment: PaymentInfo;
}

/** Response from POST /x402/debate */
export interface DebateResponse {
  proArgument: string;
  conArgument: string;
  verdict: string;
  confidence: string;
  rawOutput: string;
  template: string;
  payment: PaymentInfo;
}

/** Response from POST /x402/extract */
export interface ExtractResponse {
  extracted: Record<string, string>;
  payment: PaymentInfo;
}

/** Response from POST /x402/sentiment */
export interface SentimentResponse {
  sentiment: "positive" | "negative" | "neutral";
  confidence: number;
  reasoning: string;
  payment: PaymentInfo;
}

/** Response from POST /x402/contract-audit */
export interface ContractAuditResponse {
  riskScore: number | null;
  findings: { security: string[]; economic: string[]; gas: string[] };
  summary: string;
  payment?: PaymentInfo;
}

/** Response from POST /x402/token-risk */
export interface TokenRiskResponse {
  riskScore: number | null;
  verdict: string | null;
  findings: { contract: string[]; tokenomics: string[] };
  summary: string;
  payment?: PaymentInfo;
}

/** Response from POST /x402/dao-analyze */
export interface DaoAnalyzeResponse {
  recommendation: string | null;
  confidence: number | null;
  analysis: { economic: string; technical: string; risk: string };
  summary: string;
  payment?: PaymentInfo;
}

// ── Client Error ─────────────────────────────────────────────────────

/** Error thrown when an x402-swarms API call fails. */
export class X402SwarmsError extends Error {
  /** HTTP status code from the server. */
  public readonly status: number;
  /** Raw response body (may contain `error` field). */
  public readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "X402SwarmsError";
    this.status = status;
    this.body = body;
  }
}

// ── Client ───────────────────────────────────────────────────────────

const DEFAULT_BASE_URL =
  "https://x402-swarms-production.up.railway.app";

/**
 * x402-swarms client SDK.
 *
 * Wraps every HTTP call with Dexter's `wrapFetch` so x402 payments
 * are handled automatically. Each method maps 1:1 to a platform endpoint.
 */
export class X402SwarmsClient {
  private readonly x402Fetch: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(config: X402SwarmsClientConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(
      /\/$/,
      ""
    );

    const fetchOpts: WrapFetchOptions = {
      verbose: false,
    };
    if (config.walletPrivateKey) {
      fetchOpts.walletPrivateKey = config.walletPrivateKey;
    }
    if (config.evmPrivateKey) {
      fetchOpts.evmPrivateKey = config.evmPrivateKey;
    }
    if (config.maxAmountAtomic) {
      fetchOpts.maxAmountAtomic = config.maxAmountAtomic;
    }
    if (config.preferredNetwork) {
      fetchOpts.preferredNetwork = config.preferredNetwork;
    }

    this.x402Fetch = wrapFetch(fetch, fetchOpts);
  }

  // ── Private helpers ──────────────────────────────────────────────

  /** POST JSON and return parsed response. */
  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.x402Fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data: unknown = await res.json();
    if (!res.ok) {
      const msg =
        typeof data === "object" && data !== null && "error" in data
          ? String((data as Record<string, unknown>).error)
          : `HTTP ${res.status}`;
      throw new X402SwarmsError(msg, res.status, data);
    }
    return data as T;
  }

  /** GET and return parsed response. */
  private async get<T>(path: string): Promise<T> {
    const res = await this.x402Fetch(`${this.baseUrl}${path}`);

    const data: unknown = await res.json();
    if (!res.ok) {
      const msg =
        typeof data === "object" && data !== null && "error" in data
          ? String((data as Record<string, unknown>).error)
          : `HTTP ${res.status}`;
      throw new X402SwarmsError(msg, res.status, data);
    }
    return data as T;
  }

  // ── Paid endpoints ───────────────────────────────────────────────

  /**
   * Multi-agent research pipeline ($0.05).
   *
   * Spawns Researcher, FactChecker, and Writer agents to produce
   * a verified report on any topic.
   *
   * @param query - The topic to research.
   * @param depth - Research depth: "quick" | "standard" | "deep". Defaults to "standard".
   * @returns Verified research report with payment receipt.
   *
   * @example
   * ```ts
   * const report = await client.research("Solana validator economics in 2026");
   * console.log(report.result);
   * ```
   */
  async research(query: string, depth?: "quick" | "standard" | "deep"): Promise<ResearchResponse> {
    return this.post<ResearchResponse>("/x402/research", {
      query,
      ...(depth != null && { depth }),
    });
  }

  /**
   * Multi-perspective analysis panel ($0.03).
   *
   * Technical, Economic, and Risk experts synthesize an assessment
   * of the provided text.
   *
   * @param text - The text or topic to analyze.
   * @param type - Analysis type: "comprehensive" | "technical" | "economic" | "risk". Defaults to "comprehensive".
   * @returns Multi-perspective analysis with payment receipt.
   *
   * @example
   * ```ts
   * const analysis = await client.analyze("Impact of spot Bitcoin ETFs on altcoin markets");
   * console.log(analysis.result);
   * ```
   */
  async analyze(text: string, type?: "comprehensive" | "technical" | "economic" | "risk"): Promise<AnalyzeResponse> {
    return this.post<AnalyzeResponse>("/x402/analyze", {
      text,
      ...(type != null && { type }),
    });
  }

  /**
   * Single AI agent execution ($0.02).
   *
   * Run a single agent with a custom task, model, and system prompt.
   *
   * @param task - The task for the agent to complete.
   * @param options - Optional agent configuration.
   * @param options.model - LLM model name (e.g. "gpt-5-mini", "gpt-5-mini"). Defaults to "gpt-5-mini".
   * @param options.systemPrompt - Custom system prompt for the agent.
   * @param options.agentName - Custom agent name. Defaults to "x402-agent".
   * @returns Agent output with payment receipt.
   *
   * @example
   * ```ts
   * const result = await client.runAgent("Summarize the top 5 DeFi protocols by TVL");
   * console.log(result.result);
   * ```
   */
  async runAgent(
    task: string,
    options?: {
      model?: string;
      systemPrompt?: string;
      agentName?: string;
    }
  ): Promise<AgentResponse> {
    return this.post<AgentResponse>("/x402/agent", {
      task,
      ...(options?.model != null && { model: options.model }),
      ...(options?.systemPrompt != null && { systemPrompt: options.systemPrompt }),
      ...(options?.agentName != null && { agentName: options.agentName }),
    });
  }

  /**
   * Solana wallet analyzer ($0.01).
   *
   * Returns SOL balance, token holdings with USD values, and recent activity
   * for any Solana wallet.
   *
   * @param address - Solana wallet address (base58, 32-44 chars).
   * @returns Wallet analysis with payment receipt.
   *
   * @example
   * ```ts
   * const wallet = await client.analyzeWallet("So11111111111111111111111111111112");
   * console.log(`SOL balance: ${wallet.solBalance}`);
   * console.log(`Tokens held: ${wallet.tokenCount}`);
   * ```
   */
  async analyzeWallet(address: string): Promise<WalletAnalysisResponse> {
    return this.post<WalletAnalysisResponse>("/x402/wallet-analyzer", {
      address,
    });
  }

  // ── General-purpose task endpoints ────────────────────────────────

  /**
   * AI text summarization ($0.01).
   *
   * @param text - The text to summarize.
   * @param maxLength - Maximum summary length in words. Defaults to 200.
   * @returns Summary with word count and payment receipt.
   *
   * @example
   * ```ts
   * const result = await client.summarize("Long article text here...", 100);
   * console.log(result.summary);
   * ```
   */
  async summarize(text: string, maxLength?: number): Promise<SummarizeResponse> {
    return this.post<SummarizeResponse>("/x402/summarize", {
      text,
      ...(maxLength != null && { maxLength }),
    });
  }

  /**
   * AI text translation ($0.02).
   *
   * Auto-detects source language and translates to the target language.
   *
   * @param text - The text to translate.
   * @param targetLanguage - Target language name (e.g. "Spanish", "Japanese", "French").
   * @returns Translation with detected source language and payment receipt.
   *
   * @example
   * ```ts
   * const result = await client.translate("Hello, world!", "Spanish");
   * console.log(result.translation); // "Hola, mundo!"
   * ```
   */
  async translate(text: string, targetLanguage: string): Promise<TranslateResponse> {
    return this.post<TranslateResponse>("/x402/translate", {
      text,
      targetLanguage,
    });
  }

  /**
   * Multi-agent code review ($0.03).
   *
   * Runs SecurityAuditor, PerformanceReviewer, and StyleChecker agents
   * in parallel on the provided code.
   *
   * @param code - The code to review.
   * @param language - Programming language hint (e.g. "TypeScript", "Solidity"). Auto-detected if omitted.
   * @returns Security, performance, and style findings with payment receipt.
   *
   * @example
   * ```ts
   * const review = await client.codeReview("function add(a, b) { return a + b; }", "JavaScript");
   * console.log(review.rawOutput);
   * ```
   */
  async codeReview(code: string, language?: string): Promise<CodeReviewResponse> {
    return this.post<CodeReviewResponse>("/x402/code-review", {
      code,
      ...(language != null && { language }),
    });
  }

  /**
   * Multi-agent content writing ($0.03).
   *
   * Runs a ResearchPipeline (Researcher + FactChecker + Writer) to produce
   * well-researched content on any topic.
   *
   * @param topic - The topic to write about.
   * @param options - Optional style and length settings.
   * @param options.style - Writing style (e.g. "professional", "casual", "academic"). Defaults to "professional".
   * @param options.length - Content length: "short" | "medium" | "long". Defaults to "medium".
   * @returns Written content with word count and payment receipt.
   *
   * @example
   * ```ts
   * const article = await client.write("Zero-knowledge proofs explained", { style: "casual", length: "short" });
   * console.log(article.content);
   * ```
   */
  async write(
    topic: string,
    options?: { style?: string; length?: string }
  ): Promise<WriteResponse> {
    return this.post<WriteResponse>("/x402/write", {
      topic,
      ...(options?.style != null && { style: options.style }),
      ...(options?.length != null && { length: options.length }),
    });
  }

  /**
   * Multi-agent debate ($0.03).
   *
   * Runs Proponent, Opponent, and Judge agents to debate a proposition
   * and deliver a verdict with confidence.
   *
   * @param proposition - The statement or question to debate.
   * @returns Pro/con arguments, verdict, and confidence with payment receipt.
   *
   * @example
   * ```ts
   * const result = await client.debate("Should companies adopt a 4-day work week?");
   * console.log(result.rawOutput);
   * ```
   */
  async debate(proposition: string): Promise<DebateResponse> {
    return this.post<DebateResponse>("/x402/debate", { proposition });
  }

  /**
   * Structured data extraction ($0.01).
   *
   * Extracts specified fields from unstructured text using AI.
   *
   * @param text - The unstructured text to extract data from.
   * @param fields - Array of field names to extract (e.g. ["name", "email", "company"]).
   * @returns Extracted key-value pairs and payment receipt.
   *
   * @example
   * ```ts
   * const result = await client.extract(
   *   "Contact John Smith at john@example.com, he works at Acme Corp.",
   *   ["name", "email", "company"]
   * );
   * console.log(result.extracted); // { name: "John Smith", email: "john@example.com", company: "Acme Corp." }
   * ```
   */
  async extract(text: string, fields: string[]): Promise<ExtractResponse> {
    return this.post<ExtractResponse>("/x402/extract", { text, fields });
  }

  /**
   * AI sentiment analysis ($0.01).
   *
   * Analyzes the sentiment of the given text and returns a classification
   * with confidence score and reasoning.
   *
   * @param text - The text to analyze sentiment for.
   * @returns Sentiment classification, confidence (0-1), reasoning, and payment receipt.
   *
   * @example
   * ```ts
   * const result = await client.sentiment("I absolutely love this product!");
   * console.log(result.sentiment);   // "positive"
   * console.log(result.confidence);  // 0.95
   * ```
   */
  async sentiment(text: string): Promise<SentimentResponse> {
    return this.post<SentimentResponse>("/x402/sentiment", { text });
  }

  // ── Crypto-native endpoints ─────────────────────────────────────

  /**
   * Multi-agent smart contract pre-audit ($0.10).
   *
   * Runs SecurityAuditor, EconomicAttacker, GasOptimizer, and AuditReporter agents
   * concurrently to produce a structured risk report.
   *
   * @param code - The smart contract source code to audit.
   * @param language - Contract language: "solidity" | "rust" | "anchor". Defaults to "solidity".
   * @returns Audit report with risk score, categorized findings, and payment receipt.
   *
   * @example
   * ```ts
   * const audit = await client.contractAudit("pragma solidity ^0.8.0; ...", "solidity");
   * console.log(`Risk score: ${audit.riskScore}/100`);
   * ```
   */
  async contractAudit(code: string, language?: string): Promise<ContractAuditResponse> {
    return this.post<ContractAuditResponse>("/x402/contract-audit", {
      code,
      ...(language != null && { language }),
    });
  }

  /**
   * Multi-agent token risk assessment ($0.05).
   *
   * Runs ContractScanner, TokenomicsAnalyzer, and RiskVerdict agents
   * sequentially to score a token as SAFE/CAUTION/DANGER.
   *
   * @param mint - Token mint/contract address.
   * @param chain - Blockchain: "solana" | "evm". Defaults to "solana".
   * @returns Risk verdict with score, findings, and payment receipt.
   *
   * @example
   * ```ts
   * const risk = await client.tokenRisk("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
   * console.log(`Verdict: ${risk.verdict}`);
   * ```
   */
  async tokenRisk(mint: string, chain?: string): Promise<TokenRiskResponse> {
    return this.post<TokenRiskResponse>("/x402/token-risk", {
      mint,
      ...(chain != null && { chain }),
    });
  }

  /**
   * Multi-agent DAO proposal analysis ($0.10).
   *
   * Runs EconomicAnalyst, TechnicalReviewer, RiskAssessor, and VoteSummarizer
   * agents via MixtureOfAgents to produce a voting recommendation.
   *
   * @param proposal - The DAO proposal text to analyze.
   * @param daoName - Optional DAO name for context.
   * @returns Voting recommendation with confidence, analysis breakdown, and payment receipt.
   *
   * @example
   * ```ts
   * const dao = await client.daoAnalyze("Increase staking rewards by 5%", "Jito");
   * console.log(`Recommendation: ${dao.recommendation} (${dao.confidence}% confidence)`);
   * ```
   */
  async daoAnalyze(proposal: string, daoName?: string): Promise<DaoAnalyzeResponse> {
    return this.post<DaoAnalyzeResponse>("/x402/dao-analyze", {
      proposal,
      ...(daoName != null && { daoName }),
    });
  }

  // ── Free endpoints ───────────────────────────────────────────────

  /**
   * List all available endpoints with pricing (free).
   *
   * @returns Array of service catalog entries.
   *
   * @example
   * ```ts
   * const services = await client.getCatalog();
   * services.forEach(s => console.log(`${s.name}: $${s.priceUsd}`));
   * ```
   */
  async getCatalog(): Promise<CatalogEntry[]> {
    return this.get<CatalogEntry[]>("/x402/catalog");
  }

  /**
   * Platform health check with revenue stats (free).
   *
   * @returns Health status, receive address, network, and revenue info.
   *
   * @example
   * ```ts
   * const health = await client.getHealth();
   * console.log(`Status: ${health.status}, Revenue: $${health.totalRevenue}`);
   * ```
   */
  async getHealth(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/x402/health");
  }

  /**
   * Wallet analyzer health check (free).
   *
   * @returns Wallet analyzer status and configuration.
   *
   * @example
   * ```ts
   * const health = await client.getWalletAnalyzerHealth();
   * console.log(`Helius configured: ${health.heliusConfigured}`);
   * ```
   */
  async getWalletAnalyzerHealth(): Promise<WalletAnalyzerHealthResponse> {
    return this.get<WalletAnalyzerHealthResponse>(
      "/x402/wallet-analyzer/health"
    );
  }
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create an x402-swarms client.
 *
 * Convenience factory — identical to `new X402SwarmsClient(config)`.
 *
 * @param config - Client configuration (wallet key + optional base URL).
 * @returns Configured client instance.
 *
 * @example
 * ```ts
 * import { createClient } from "@elizaos/plugin-x402-swarms/client";
 *
 * const client = createClient({
 *   walletPrivateKey: process.env.SOLANA_PRIVATE_KEY,
 * });
 *
 * // One-liner research
 * const report = await client.research("Zero-knowledge rollups comparison");
 * ```
 */
export function createClient(
  config: X402SwarmsClientConfig
): X402SwarmsClient {
  return new X402SwarmsClient(config);
}
