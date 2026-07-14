/**
 * SwarmX MCP (Model Context Protocol) Server
 *
 * Exposes all SwarmX endpoints as MCP-compatible tools that any
 * MCP-capable agent (Claude, Cursor, etc.) can discover and call.
 *
 * Two main exports:
 *   - `getMcpToolDefinitions()` — returns the full MCP manifest object
 *   - `executeMcpTool(toolName, params, options)` — calls the live SwarmX API
 *
 * @module
 */

// ── Types ────────────────────────────────────────────────────────────────

/** JSON Schema property definition. */
export interface McpSchemaProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

/** JSON Schema for a tool's input. */
export interface McpInputSchema {
  type: "object";
  properties: Record<string, McpSchemaProperty>;
  required: string[];
}

/** A single MCP tool definition. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: McpInputSchema;
  metadata: {
    endpoint: string;
    method: "GET" | "POST";
    priceUsd: string;
    category: string;
    free: boolean;
  };
}

/** The full MCP manifest. */
export interface McpManifest {
  name: string;
  version: string;
  description: string;
  tools: McpToolDefinition[];
}

/** Options for executeMcpTool. */
export interface McpExecuteOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** Result from executeMcpTool. */
export interface McpToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  httpStatus?: number;
  tool: string;
  endpoint: string;
}

// ── Tool Definitions ─────────────────────────────────────────────────────

/**
 * All SwarmX endpoint tool definitions. Each entry maps a tool name to its
 * schema, endpoint path, method, price, and category.
 */
const TOOL_DEFINITIONS: McpToolDefinition[] = [
  // ── Crypto ─────────────────────────────────────────────────────────────
  {
    name: "swarmx_contract_audit",
    description:
      "Multi-agent smart contract pre-audit. 4 AI agents analyze security vulnerabilities, economic risks, copy/clone detection, and gas optimization. Returns structured risk report with EXCELLENT/GOOD/NEEDS_WORK/POOR verdict. $0.10/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Smart contract source code to audit",
        },
        language: {
          type: "string",
          enum: ["solidity", "rust", "anchor"],
          description:
            "Contract language. Defaults to 'solidity' if not specified.",
        },
      },
      required: ["code"],
    },
    metadata: {
      endpoint: "/x402/contract-audit",
      method: "POST",
      priceUsd: "0.10",
      category: "crypto",
      free: false,
    },
  },
  {
    name: "swarmx_contract_audit_quick",
    description:
      "Single-agent quick security scan for smart contracts. Fast and cheap, covers major security vulnerabilities only. $0.03/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Smart contract source code to scan",
        },
        language: {
          type: "string",
          enum: ["solidity", "rust", "anchor"],
          description: "Contract language. Defaults to 'solidity'.",
        },
      },
      required: ["code"],
    },
    metadata: {
      endpoint: "/x402/contract-audit/quick",
      method: "POST",
      priceUsd: "0.03",
      category: "crypto",
      free: false,
    },
  },
  {
    name: "swarmx_contract_audit_deep",
    description:
      "Comprehensive 6-agent deep smart contract audit. Security, economic, gas, copy/clone detection, plus additional verification pass. $0.25/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Smart contract source code for deep audit",
        },
        language: {
          type: "string",
          enum: ["solidity", "rust", "anchor"],
          description: "Contract language. Defaults to 'solidity'.",
        },
      },
      required: ["code"],
    },
    metadata: {
      endpoint: "/x402/contract-audit/deep",
      method: "POST",
      priceUsd: "0.25",
      category: "crypto",
      free: false,
    },
  },
  {
    name: "swarmx_token_risk",
    description:
      "Multi-agent token risk assessment. 3 agents score a token for rug pull indicators, timeline anomalies, copy/clone detection, and tokenomics issues. Returns SAFE/CAUTION/DANGER verdict. $0.05/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        mint: {
          type: "string",
          description: "Token mint/contract address",
        },
        chain: {
          type: "string",
          enum: ["solana", "evm"],
          description: "Blockchain. Defaults to 'solana'.",
        },
      },
      required: ["mint"],
    },
    metadata: {
      endpoint: "/x402/token-risk",
      method: "POST",
      priceUsd: "0.05",
      category: "crypto",
      free: false,
    },
  },
  {
    name: "swarmx_dao_analyze",
    description:
      "Multi-agent DAO proposal analysis. 4 agents assess economic impact, technical feasibility, risk, and produce FOR/AGAINST/ABSTAIN recommendation with confidence. $0.10/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        proposal: {
          type: "string",
          description: "The DAO proposal text to analyze",
        },
        daoName: {
          type: "string",
          description: "Optional DAO name for context",
        },
      },
      required: ["proposal"],
    },
    metadata: {
      endpoint: "/x402/dao-analyze",
      method: "POST",
      priceUsd: "0.10",
      category: "crypto",
      free: false,
    },
  },
  {
    name: "swarmx_memecoin_score",
    description:
      "Multi-agent memecoin risk scoring. 3 agents check contract authorities, holder concentration, and produce SAFE/CAUTION/DANGER/SCAM verdict. $0.05/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        mint: {
          type: "string",
          description: "SPL token mint address (Solana base58)",
        },
      },
      required: ["mint"],
    },
    metadata: {
      endpoint: "/x402/memecoin-score",
      method: "POST",
      priceUsd: "0.05",
      category: "crypto",
      free: false,
    },
  },
  {
    name: "swarmx_wallet_risk_score",
    description:
      "Multi-agent wallet risk assessment. 2 agents analyze transaction patterns and produce a risk level (low/moderate/elevated/high/critical). $0.05/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Solana wallet address (base58)",
        },
      },
      required: ["address"],
    },
    metadata: {
      endpoint: "/x402/wallet-risk-score",
      method: "POST",
      priceUsd: "0.05",
      category: "crypto",
      free: false,
    },
  },
  {
    name: "swarmx_tx_explainer",
    description:
      "Explain any Solana transaction in plain English. Returns type classification, participants, tokens involved, and summary. $0.03/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        signature: {
          type: "string",
          description: "Solana transaction signature (base58, 64-88 chars)",
        },
      },
      required: ["signature"],
    },
    metadata: {
      endpoint: "/x402/tx-explainer",
      method: "POST",
      priceUsd: "0.03",
      category: "crypto",
      free: false,
    },
  },

  // ── Content ────────────────────────────────────────────────────────────
  {
    name: "swarmx_summarize",
    description:
      "AI-powered text summarization. Produces a clear, concise summary of any content. $0.01/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to summarize",
        },
        maxLength: {
          type: "number",
          description: "Maximum summary length in words. Defaults to 200.",
          minimum: 10,
          maximum: 10000,
        },
      },
      required: ["text"],
    },
    metadata: {
      endpoint: "/x402/summarize",
      method: "POST",
      priceUsd: "0.01",
      category: "content",
      free: false,
    },
  },
  {
    name: "swarmx_translate",
    description:
      "AI translation to any language. Auto-detects source language. $0.02/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to translate",
        },
        targetLanguage: {
          type: "string",
          description:
            "Target language name (e.g. 'Spanish', 'Japanese', 'French')",
        },
      },
      required: ["text", "targetLanguage"],
    },
    metadata: {
      endpoint: "/x402/translate",
      method: "POST",
      priceUsd: "0.02",
      category: "content",
      free: false,
    },
  },
  {
    name: "swarmx_extract",
    description:
      "Structured data extraction from unstructured text. Pull specific fields using AI. $0.01/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The unstructured text to extract data from",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of field names to extract (e.g. ['name', 'email', 'company'])",
        },
      },
      required: ["text", "fields"],
    },
    metadata: {
      endpoint: "/x402/extract",
      method: "POST",
      priceUsd: "0.01",
      category: "content",
      free: false,
    },
  },
  {
    name: "swarmx_sentiment",
    description:
      "AI sentiment analysis. Returns positive/negative/neutral classification with confidence score (0-1) and reasoning. $0.01/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to analyze sentiment for",
        },
      },
      required: ["text"],
    },
    metadata: {
      endpoint: "/x402/sentiment",
      method: "POST",
      priceUsd: "0.01",
      category: "content",
      free: false,
    },
  },
  {
    name: "swarmx_write",
    description:
      "Multi-agent content writing. Research, fact-check, and write on any topic. 3 agents collaborate. $0.03/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The topic to write about",
        },
        style: {
          type: "string",
          description:
            "Writing style (e.g. 'professional', 'casual', 'academic'). Defaults to 'professional'.",
        },
        length: {
          type: "string",
          enum: ["short", "medium", "long"],
          description: "Content length. Defaults to 'medium'.",
        },
      },
      required: ["topic"],
    },
    metadata: {
      endpoint: "/x402/write",
      method: "POST",
      priceUsd: "0.03",
      category: "content",
      free: false,
    },
  },
  {
    name: "swarmx_seo_article",
    description:
      "Multi-agent SEO article generation. 3 agents (SEOResearcher, ContentWriter, Editor) produce a keyword-optimized article with meta description and readability score. $0.25/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The article topic (max 500 chars)",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Target SEO keywords (max 10)",
        },
        wordCount: {
          type: "number",
          description: "Target word count (500-5000). Defaults to 1500.",
          minimum: 500,
          maximum: 5000,
        },
        tone: {
          type: "string",
          enum: [
            "professional",
            "casual",
            "academic",
            "conversational",
            "authoritative",
          ],
          description: "Writing tone. Defaults to 'professional'.",
        },
      },
      required: ["topic"],
    },
    metadata: {
      endpoint: "/x402/seo-article",
      method: "POST",
      priceUsd: "0.25",
      category: "content",
      free: false,
    },
  },
  {
    name: "swarmx_document_extract",
    description:
      "AI document data extraction. Pull structured fields from unstructured text with confidence scoring. Supports auto-detect or specific field extraction. $0.05/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The document text to extract data from (max 100,000 chars)",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            "Specific fields to extract. Omit for auto-detection (max 50 fields).",
        },
        format: {
          type: "string",
          enum: ["json", "table"],
          description: "Output format. Defaults to 'json'.",
        },
      },
      required: ["text"],
    },
    metadata: {
      endpoint: "/x402/document-extract",
      method: "POST",
      priceUsd: "0.05",
      category: "content",
      free: false,
    },
  },

  // ── Code ───────────────────────────────────────────────────────────────
  {
    name: "swarmx_code_review",
    description:
      "Multi-agent code review. SecurityAuditor, PerformanceReviewer, and StyleChecker agents analyze code in parallel. $0.03/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The code to review",
        },
        language: {
          type: "string",
          description:
            "Programming language hint (e.g. 'TypeScript', 'Solidity'). Auto-detected if omitted.",
        },
      },
      required: ["code"],
    },
    metadata: {
      endpoint: "/x402/code-review",
      method: "POST",
      priceUsd: "0.03",
      category: "code",
      free: false,
    },
  },
  {
    name: "swarmx_code_audit",
    description:
      "Multi-agent code audit for ANY programming language. 3 agents (SecurityReviewer, PerformanceAnalyst, BestPracticesChecker) run concurrently. Returns scored findings and EXCELLENT/GOOD/NEEDS_WORK/POOR verdict. $0.10/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The source code to audit",
        },
        language: {
          type: "string",
          description:
            "Programming language. Auto-detected from code if omitted.",
        },
      },
      required: ["code"],
    },
    metadata: {
      endpoint: "/x402/code-audit",
      method: "POST",
      priceUsd: "0.10",
      category: "code",
      free: false,
    },
  },

  // ── Research ───────────────────────────────────────────────────────────
  {
    name: "swarmx_research",
    description:
      "Multi-agent research pipeline. Researcher, FactChecker, and Writer produce a verified report on any topic. $0.05/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The topic to research",
        },
        depth: {
          type: "string",
          enum: ["quick", "standard", "deep"],
          description: "Research depth. Defaults to 'standard'.",
        },
      },
      required: ["query"],
    },
    metadata: {
      endpoint: "/x402/research",
      method: "POST",
      priceUsd: "0.05",
      category: "research",
      free: false,
    },
  },
  {
    name: "swarmx_analyze",
    description:
      "Multi-perspective analysis panel. Technical, Economic, and Risk experts synthesize an assessment. $0.03/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text or topic to analyze",
        },
        type: {
          type: "string",
          enum: ["comprehensive", "technical", "economic", "risk"],
          description: "Analysis type. Defaults to 'comprehensive'.",
        },
      },
      required: ["text"],
    },
    metadata: {
      endpoint: "/x402/analyze",
      method: "POST",
      priceUsd: "0.03",
      category: "research",
      free: false,
    },
  },
  {
    name: "swarmx_agent",
    description:
      "Single AI agent execution. Run a custom task with configurable model and system prompt. $0.02/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task for the agent to complete",
        },
        model: {
          type: "string",
          description:
            "LLM model name (e.g. 'gpt-4o-mini', 'gpt-4o'). Defaults to 'gpt-4o-mini'.",
        },
        systemPrompt: {
          type: "string",
          description: "Custom system prompt for the agent",
        },
        agentName: {
          type: "string",
          description: "Custom agent name. Defaults to 'x402-agent'.",
        },
      },
      required: ["task"],
    },
    metadata: {
      endpoint: "/x402/agent",
      method: "POST",
      priceUsd: "0.02",
      category: "research",
      free: false,
    },
  },
  {
    name: "swarmx_research_report",
    description:
      "4-agent fact-checked research report. Researcher, FactChecker (VERIFIED/UNVERIFIED/DISPUTED/OUTDATED/FABRICATED), Analyst, and Writer produce a rigorous report. $0.50/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The research topic (max 500 chars)",
        },
        depth: {
          type: "string",
          enum: ["brief", "standard", "deep"],
          description: "Research depth. Defaults to 'standard'.",
        },
        focus: {
          type: "string",
          description:
            "Optional focus area to narrow the research scope",
        },
      },
      required: ["topic"],
    },
    metadata: {
      endpoint: "/x402/research-report",
      method: "POST",
      priceUsd: "0.50",
      category: "research",
      free: false,
    },
  },
  {
    name: "swarmx_debate",
    description:
      "Multi-agent debate. Proponent, Opponent, and Judge agents argue a proposition and deliver a verdict with confidence. $0.03/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        proposition: {
          type: "string",
          description: "The statement or question to debate",
        },
      },
      required: ["proposition"],
    },
    metadata: {
      endpoint: "/x402/debate",
      method: "POST",
      priceUsd: "0.03",
      category: "research",
      free: false,
    },
  },

  // ── DeFi ───────────────────────────────────────────────────────────────
  {
    name: "swarmx_yield_optimizer",
    description:
      "3-agent DeFi yield optimizer. Scans DeFiLlama yields, evaluates protocol risk, recommends allocation strategy. $0.10/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "number",
          description:
            "Investment amount in USD. Optional — strategy works without it.",
        },
        riskTolerance: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Risk tolerance level. Defaults to 'medium'.",
        },
        chains: {
          type: "array",
          items: { type: "string" },
          description:
            "Blockchains to scan (e.g. ['ethereum', 'solana']). Defaults to ['ethereum', 'solana', 'arbitrum', 'base'].",
        },
      },
      required: [],
    },
    metadata: {
      endpoint: "/x402/yield-optimizer",
      method: "POST",
      priceUsd: "0.10",
      category: "defi",
      free: false,
    },
  },
  {
    name: "swarmx_wallet_analyzer",
    description:
      "Solana wallet analyzer. Returns SOL balance, token holdings with USD values, NFTs, and recent transactions. $0.01/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Solana wallet address (base58, 32-44 chars)",
        },
      },
      required: ["address"],
    },
    metadata: {
      endpoint: "/x402/wallet-analyzer",
      method: "POST",
      priceUsd: "0.01",
      category: "defi",
      free: false,
    },
  },
  {
    name: "swarmx_wallet_report",
    description:
      "Full Solana wallet report bundle. SOL balance, token holdings, top-token holder concentration, and DeFi positions in one call. $0.03/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Solana wallet address (base58)",
        },
      },
      required: ["address"],
    },
    metadata: {
      endpoint: "/x402/wallet-report",
      method: "POST",
      priceUsd: "0.03",
      category: "defi",
      free: false,
    },
  },
  {
    name: "swarmx_defi_positions",
    description:
      "Scan a Solana wallet for DeFi positions. Detects Marinade, Jito, Raydium LP tokens and more. $0.02/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Solana wallet address (base58)",
        },
      },
      required: ["address"],
    },
    metadata: {
      endpoint: "/x402/defi-positions",
      method: "POST",
      priceUsd: "0.02",
      category: "defi",
      free: false,
    },
  },
  {
    name: "swarmx_token_holders",
    description:
      "Get top holders for any SPL token. Returns amounts, percentages, and concentration analysis. $0.01/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        mint: {
          type: "string",
          description: "SPL token mint address (Solana base58)",
        },
        limit: {
          type: "number",
          description: "Number of top holders to return (1-20). Defaults to 20.",
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["mint"],
    },
    metadata: {
      endpoint: "/x402/token-holders",
      method: "POST",
      priceUsd: "0.01",
      category: "defi",
      free: false,
    },
  },
  {
    name: "swarmx_tx_history",
    description:
      "Get recent transaction history for any Solana address. Returns signatures, types, and timestamps. $0.01/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Solana address (base58)",
        },
        limit: {
          type: "number",
          description: "Number of transactions to return (1-10). Defaults to 10.",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["address"],
    },
    metadata: {
      endpoint: "/x402/tx-history",
      method: "POST",
      priceUsd: "0.01",
      category: "defi",
      free: false,
    },
  },

  // ── Trading ────────────────────────────────────────────────────────────
  {
    name: "swarmx_token_price",
    description:
      "Real-time token price in USD via Jupiter. Sub-second cached, designed for HFT bot loops. $0.001/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        mint: {
          type: "string",
          description: "SPL token mint address (Solana base58)",
        },
      },
      required: ["mint"],
    },
    metadata: {
      endpoint: "/x402/token-price",
      method: "POST",
      priceUsd: "0.001",
      category: "trading",
      free: false,
    },
  },
  {
    name: "swarmx_token_supply",
    description:
      "Get total supply and decimals for any SPL token mint via Solana RPC. $0.001/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        mint: {
          type: "string",
          description: "SPL token mint address (Solana base58)",
        },
      },
      required: ["mint"],
    },
    metadata: {
      endpoint: "/x402/token-supply",
      method: "POST",
      priceUsd: "0.001",
      category: "trading",
      free: false,
    },
  },
  {
    name: "swarmx_slot_info",
    description:
      "Current Solana slot and block time. Network health monitoring for trading bots. $0.001/call via x402.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    metadata: {
      endpoint: "/x402/slot-info",
      method: "POST",
      priceUsd: "0.001",
      category: "trading",
      free: false,
    },
  },
  {
    name: "swarmx_token_accounts",
    description:
      "List all SPL token accounts for a wallet. Portfolio monitoring with optional mint filter. $0.002/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Solana wallet address (base58)",
        },
        mint: {
          type: "string",
          description:
            "Optional mint filter. Only return accounts for this specific token.",
        },
      },
      required: ["address"],
    },
    metadata: {
      endpoint: "/x402/token-accounts",
      method: "POST",
      priceUsd: "0.002",
      category: "trading",
      free: false,
    },
  },
  {
    name: "swarmx_recent_blockhash",
    description:
      "Get latest blockhash for transaction building. Every bot needs this before submitting a tx. $0.001/call via x402.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    metadata: {
      endpoint: "/x402/recent-blockhash",
      method: "POST",
      priceUsd: "0.001",
      category: "trading",
      free: false,
    },
  },

  // ── Enterprise ─────────────────────────────────────────────────────────
  {
    name: "swarmx_compliance_check",
    description:
      "3-agent compliance analysis. Auto-detects or targets GDPR/SOC2/HIPAA/MiCA/AML/PCI-DSS/CCPA. Returns gap analysis and remediation roadmap. $0.50/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        document: {
          type: "string",
          description:
            "The document, policy, or system description to check for compliance (max 100,000 chars)",
        },
        framework: {
          type: "string",
          enum: [
            "GDPR",
            "SOC2",
            "HIPAA",
            "MiCA",
            "AML",
            "PCI-DSS",
            "CCPA",
          ],
          description:
            "Target compliance framework. Omit for auto-detection.",
        },
        jurisdiction: {
          type: "string",
          description: "Optional jurisdiction context (e.g. 'EU', 'US', 'UK')",
        },
        industry: {
          type: "string",
          description: "Optional industry context (e.g. 'fintech', 'healthcare')",
        },
      },
      required: ["document"],
    },
    metadata: {
      endpoint: "/x402/compliance-check",
      method: "POST",
      priceUsd: "0.50",
      category: "enterprise",
      free: false,
    },
  },
  {
    name: "swarmx_investment_dd",
    description:
      "5-agent investment due diligence. Concurrent analysis of team, tokenomics, tech, community, and market. Returns STRONG_BUY/BUY/HOLD/AVOID/STRONG_AVOID recommendation. $5.00/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name or description (max 500 chars)",
        },
        projectType: {
          type: "string",
          enum: ["token", "protocol", "dao", "nft"],
          description: "Project type. Defaults to 'token'.",
        },
        context: {
          type: "string",
          description:
            "Additional context (whitepaper excerpts, links, etc., max 5000 chars)",
        },
      },
      required: ["project"],
    },
    metadata: {
      endpoint: "/x402/investment-dd",
      method: "POST",
      priceUsd: "5.00",
      category: "enterprise",
      free: false,
    },
  },

  // ── RWA / Tokenized Equities ───────────────────────────────────────────
  {
    name: "swarmx_stock_dd",
    description:
      "Tokenized-stock due diligence. Fetches real market data (price, 6-month range, trend, volatility) then runs an adversarial 3-agent Swarm debate (bull / bear / risk) judged into a bullish/neutral/bearish verdict with confidence and supporting points. $0.29/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: {
          type: "string",
          description:
            "Equity ticker to analyze: 1-6 uppercase letters A-Z (e.g. NVDA, AAPL, TSLA).",
        },
      },
      required: ["ticker"],
    },
    metadata: {
      endpoint: "/x402/rwa/stock-dd",
      method: "POST",
      priceUsd: "0.29",
      category: "rwa",
      free: false,
    },
  },
  {
    name: "swarmx_stock_screen",
    description:
      "Screen and rank a watchlist of 2-8 tokenized stocks. Fetches real market data for each, then a multi-agent Swarm ranks them best-to-worst with per-ticker rating, score, and rationale. $0.49/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        tickers: {
          type: "array",
          items: { type: "string" },
          description: "2-8 equity tickers, each 1-6 uppercase letters (e.g. [\"NVDA\",\"AAPL\",\"TSLA\"]).",
        },
      },
      required: ["tickers"],
    },
    metadata: {
      endpoint: "/x402/rwa/screen",
      method: "POST",
      priceUsd: "0.49",
      category: "rwa",
      free: false,
    },
  },
  {
    name: "swarmx_stock_compare",
    description:
      "Head-to-head due diligence on two tokenized equities. Fetches real market data for both and runs an adversarial Swarm debate judged into a winner, per-ticker ratings, key points, and risks. $0.39/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        tickerA: { type: "string", description: "First equity ticker (1-6 uppercase letters)." },
        tickerB: { type: "string", description: "Second equity ticker (1-6 uppercase letters)." },
      },
      required: ["tickerA", "tickerB"],
    },
    metadata: {
      endpoint: "/x402/rwa/compare",
      method: "POST",
      priceUsd: "0.39",
      category: "rwa",
      free: false,
    },
  },
  {
    name: "swarmx_rwa_eligibility",
    description:
      "Compliance screen for a tokenized equity: identifies the underlying (name/exchange via real data) and returns a deterministic Robinhood-Chain access assessment by jurisdiction (US persons are not eligible). Informational only, not legal advice. $0.19/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Equity ticker (1-6 uppercase letters)." },
        jurisdiction: {
          type: "string",
          description: "Country/jurisdiction to assess (e.g. 'US', 'Germany'). Defaults to 'US'.",
        },
      },
      required: ["ticker"],
    },
    metadata: {
      endpoint: "/x402/rwa/eligibility",
      method: "POST",
      priceUsd: "0.19",
      category: "rwa",
      free: false,
    },
  },
  {
    name: "swarmx_stock_catalyst",
    description:
      "Corporate-actions and catalyst brief for an equity: real dividend history + trailing yield, stock splits, and notable recent single-day moves from Yahoo Finance, summarized by an AI analyst. Future earnings dates are not fabricated when unavailable. $0.29/call via x402.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Equity ticker (1-6 uppercase letters, e.g. AAPL)." },
      },
      required: ["ticker"],
    },
    metadata: {
      endpoint: "/x402/rwa/catalyst",
      method: "POST",
      priceUsd: "0.29",
      category: "rwa",
      free: false,
    },
  },

  // ── Batch ──────────────────────────────────────────────────────────────
  {
    name: "swarmx_batch",
    description:
      "Run up to 10 tasks in parallel with a single x402 payment. 20% discount on the sum of individual prices. Each task specifies an endpoint slug and params.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "object" },
          description:
            'Array of tasks. Each task: { "endpoint": "<slug>", "params": { ... } }. Valid slugs: summarize, translate, extract, sentiment, code-review, write, debate, contract-audit, token-risk, dao-analyze, research, analyze, agent.',
        },
      },
      required: ["tasks"],
    },
    metadata: {
      endpoint: "/x402/batch",
      method: "POST",
      priceUsd: "varies",
      category: "batch",
      free: false,
    },
  },

  // ── Free endpoints ─────────────────────────────────────────────────────
  {
    name: "swarmx_catalog",
    description:
      "List all available SwarmX paid endpoints with pricing. Free, no payment required.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    metadata: {
      endpoint: "/x402/catalog",
      method: "GET",
      priceUsd: "0.00",
      category: "meta",
      free: true,
    },
  },
  {
    name: "swarmx_health",
    description:
      "SwarmX service health, revenue stats, and network info. Free, no payment required.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    metadata: {
      endpoint: "/x402/health",
      method: "GET",
      priceUsd: "0.00",
      category: "meta",
      free: true,
    },
  },
  {
    name: "swarmx_revenue",
    description:
      "Detailed revenue breakdown — totals, time-period stats, top buyers, conversion rate. Free, no payment required.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    metadata: {
      endpoint: "/x402/revenue",
      method: "GET",
      priceUsd: "0.00",
      category: "meta",
      free: true,
    },
  },
];

// ── Name-to-tool lookup ──────────────────────────────────────────────────

const TOOL_MAP = new Map<string, McpToolDefinition>();
for (const tool of TOOL_DEFINITIONS) {
  TOOL_MAP.set(tool.name, tool);
}

// ── Public API ───────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://swarmx.io";

/**
 * Returns the full MCP manifest for SwarmX.
 *
 * This manifest can be serialized to JSON and served as a static file,
 * or consumed directly by any MCP-compatible client.
 */
export function getMcpToolDefinitions(): McpManifest {
  return {
    name: "swarmx",
    version: "0.1.0",
    description:
      "SwarmX — AI Agent Teams with x402 Micropayments. Multi-agent crypto analysis, code audit, research, content, DeFi, trading, and more.",
    tools: TOOL_DEFINITIONS,
  };
}

/**
 * Look up a single tool definition by name.
 *
 * @param toolName - The MCP tool name (e.g. "swarmx_contract_audit")
 * @returns The tool definition, or undefined if not found.
 */
export function getMcpTool(toolName: string): McpToolDefinition | undefined {
  return TOOL_MAP.get(toolName);
}

/**
 * List all tool names, optionally filtered by category.
 *
 * @param category - If provided, only return tools in this category.
 * @returns Array of tool names.
 */
export function listMcpTools(category?: string): string[] {
  if (!category) return TOOL_DEFINITIONS.map((t) => t.name);
  return TOOL_DEFINITIONS.filter((t) => t.metadata.category === category).map(
    (t) => t.name
  );
}

/**
 * List all available categories.
 */
export function listMcpCategories(): string[] {
  const cats = new Set<string>();
  for (const t of TOOL_DEFINITIONS) cats.add(t.metadata.category);
  return [...cats];
}

/**
 * Execute an MCP tool by calling the live SwarmX API.
 *
 * This function performs an HTTP request to the SwarmX platform,
 * passing the tool parameters as the request body.
 *
 * Note: Paid endpoints require x402 payment. If calling without
 * a payment-enabled fetch (wrapFetch from @dexterai/x402/client),
 * paid endpoints will return HTTP 402.
 *
 * @param toolName - The MCP tool name (e.g. "swarmx_contract_audit")
 * @param params - The tool input parameters
 * @param options - Optional configuration (baseUrl, headers, timeout)
 * @returns Structured result with success/error status and response data
 */
export async function executeMcpTool(
  toolName: string,
  params: Record<string, unknown>,
  options?: McpExecuteOptions
): Promise<McpToolResult> {
  const tool = TOOL_MAP.get(toolName);
  if (!tool) {
    return {
      success: false,
      error: `Unknown tool: ${toolName}. Use listMcpTools() to see available tools.`,
      tool: toolName,
      endpoint: "",
    };
  }

  const baseUrl = (options?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const url = `${baseUrl}${tool.metadata.endpoint}`;
  const timeoutMs = options?.timeoutMs ?? 120_000;

  try {
    const fetchOptions: RequestInit = {
      method: tool.metadata.method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options?.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (tool.metadata.method === "POST") {
      fetchOptions.body = JSON.stringify(params);
    }

    const res = await fetch(url, fetchOptions);
    const data: unknown = await res.json();

    if (!res.ok) {
      const errorMsg =
        typeof data === "object" && data !== null && "error" in data
          ? String((data as Record<string, unknown>).error)
          : `HTTP ${res.status}`;
      return {
        success: false,
        error: errorMsg,
        httpStatus: res.status,
        data,
        tool: toolName,
        endpoint: tool.metadata.endpoint,
      };
    }

    return {
      success: true,
      data,
      httpStatus: res.status,
      tool: toolName,
      endpoint: tool.metadata.endpoint,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      tool: toolName,
      endpoint: tool.metadata.endpoint,
    };
  }
}

/**
 * Validate parameters against a tool's input schema.
 *
 * Performs basic validation: checks required fields are present
 * and types roughly match. This is NOT a full JSON Schema validator
 * but catches the most common mistakes.
 *
 * @param toolName - The MCP tool name
 * @param params - The parameters to validate
 * @returns Array of error strings (empty = valid)
 */
export function validateMcpToolParams(
  toolName: string,
  params: Record<string, unknown>
): string[] {
  const tool = TOOL_MAP.get(toolName);
  if (!tool) return [`Unknown tool: ${toolName}`];

  const errors: string[] = [];
  const schema = tool.inputSchema;

  // Check required fields
  for (const field of schema.required) {
    if (!(field in params) || params[field] === undefined || params[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Check types for provided fields
  for (const [field, value] of Object.entries(params)) {
    const prop = schema.properties[field];
    if (!prop) continue; // extra fields are OK

    if (value === undefined || value === null) continue;

    // Type checks
    if (prop.type === "string" && typeof value !== "string") {
      errors.push(`Field '${field}' must be a string, got ${typeof value}`);
    }
    if (prop.type === "number" && typeof value !== "number") {
      errors.push(`Field '${field}' must be a number, got ${typeof value}`);
    }
    if (prop.type === "array" && !Array.isArray(value)) {
      errors.push(`Field '${field}' must be an array, got ${typeof value}`);
    }

    // Enum checks
    if (prop.enum && typeof value === "string" && !prop.enum.includes(value)) {
      errors.push(
        `Field '${field}' must be one of [${prop.enum.join(", ")}], got '${value}'`
      );
    }

    // Range checks
    if (prop.minimum !== undefined && typeof value === "number" && value < prop.minimum) {
      errors.push(`Field '${field}' must be >= ${prop.minimum}, got ${value}`);
    }
    if (prop.maximum !== undefined && typeof value === "number" && value > prop.maximum) {
      errors.push(`Field '${field}' must be <= ${prop.maximum}, got ${value}`);
    }
  }

  return errors;
}
