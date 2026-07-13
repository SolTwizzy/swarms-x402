import type { Plugin } from "@elizaos/core";
import { payForService } from "./actions/payForService.js";
import { discoverServices } from "./actions/discoverServices.js";
import { delegateToSwarm } from "./actions/delegateToSwarm.js";
import { runSwarmAgent } from "./actions/runSwarmAgent.js";
import { delegateToSwarmWithPayment } from "./actions/delegateToSwarmWithPayment.js";
import { x402Provider } from "./providers/x402Provider.js";
import { x402ServerProvider } from "./providers/x402ServerProvider.js";
import { paymentEvaluator } from "./evaluators/paymentEvaluator.js";
import { X402WalletService } from "./services/x402WalletService.js";
import { SwarmsService } from "./services/swarmsService.js";
import { PaymentMemoryService } from "./services/paymentMemoryService.js";
import { X402ServerService } from "./server/index.js";
import { x402Routes } from "./routes/x402Routes.js";
import { taskRoutes } from "./routes/taskRoutes.js";
import { walletAnalyzerRoutes } from "./routes/walletAnalyzerRoutes.js";
import { heliusDataRoutes } from "./routes/heliusDataRoutes.js";
import { tradingRoutes } from "./routes/tradingRoutes.js";
import { cryptoRoutes } from "./routes/cryptoRoutes.js";
import { batchRoutes } from "./routes/batchRoutes.js";
import { contentRoutes } from "./routes/contentRoutes.js";
import { codeAuditRoutes } from "./routes/codeAuditRoutes.js";
import { advancedRoutes } from "./routes/advancedRoutes.js";
import { cryptoAnalysisRoutes } from "./routes/cryptoAnalysisRoutes.js";
import { swarmRoutes } from "./routes/swarmRoutes.js";
import { swarmPremiumRoutes } from "./routes/swarmPremiumRoutes.js";
import { rwaRoutes } from "./routes/rwaRoutes.js";
import { x402PaymentHistory, x402EndpointScores, x402BudgetState, x402Knowledge } from "./schemas/index.js";

export { payForService, discoverServices, delegateToSwarm, runSwarmAgent, delegateToSwarmWithPayment } from "./actions/index.js";
export { x402Provider } from "./providers/x402Provider.js";
export { x402ServerProvider } from "./providers/x402ServerProvider.js";
export { paymentEvaluator } from "./evaluators/paymentEvaluator.js";
export { X402WalletService } from "./services/x402WalletService.js";
export { SwarmsService } from "./services/swarmsService.js";
export { PaymentMemoryService } from "./services/paymentMemoryService.js";
export { X402ServerService, x402Gate } from "./server/index.js";
export { x402Routes } from "./routes/x402Routes.js";
export { taskRoutes, TASK_CATALOG } from "./routes/taskRoutes.js";
export { walletAnalyzerRoutes, WALLET_REPORT_CATALOG } from "./routes/walletAnalyzerRoutes.js";
export { heliusDataRoutes } from "./routes/heliusDataRoutes.js";
export { tradingRoutes, TRADING_CATALOG } from "./routes/tradingRoutes.js";
export { cryptoRoutes, CRYPTO_CATALOG } from "./routes/cryptoRoutes.js";
export { batchRoutes, BATCH_CATALOG } from "./routes/batchRoutes.js";
export { contentRoutes, CONTENT_CATALOG } from "./routes/contentRoutes.js";
export { codeAuditRoutes, CODE_AUDIT_CATALOG } from "./routes/codeAuditRoutes.js";
export { cryptoAnalysisRoutes, CRYPTO_ANALYSIS_CATALOG } from "./routes/cryptoAnalysisRoutes.js";
export { advancedRoutes, ADVANCED_CATALOG } from "./routes/advancedRoutes.js";
export { swarmRoutes, SWARM_ROUTE_CATALOG } from "./routes/swarmRoutes.js";
export { swarmPremiumRoutes, SWARM_PREMIUM_CATALOG } from "./routes/swarmPremiumRoutes.js";
export { rwaRoutes, RWA_CATALOG } from "./routes/rwaRoutes.js";
export { TTLCache } from "./utils/cache.js";
export { callOpenAI, callLLM, callSwarmsAgent } from "./utils/llm.js";
export type { LLMProvider, SmartLLMOptions, CallOpenAIOptions, SwarmsAgentOptions } from "./utils/llm.js";
export * from "./types.js";
export { X402SwarmsClient, createClient, X402SwarmsError } from "./client/index.js";
export type {
  X402SwarmsClientConfig,
  ResearchResponse,
  AnalyzeResponse,
  AgentResponse,
  WalletAnalysisResponse,
  CatalogEntry,
  HealthResponse,
  WalletAnalyzerHealthResponse,
  PaymentInfo,
  TokenHolding,
  SummarizeResponse,
  TranslateResponse,
  CodeReviewResponse,
  WriteResponse,
  DebateResponse,
  ExtractResponse,
  SentimentResponse,
  ContractAuditResponse,
  TokenRiskResponse,
  DaoAnalyzeResponse,
} from "./client/index.js";
export {
  SWARM_TEMPLATES,
  findMatchingTemplate,
  registerSwarmTemplate,
} from "./templates/index.js";
export {
  KnowledgeStore,
  VectorKnowledgeStore,
  createKnowledgeStore,
  extractKnowledge,
  buildRAGContext,
  getKnowledgeStore,
  initKnowledgeStore,
  getRAGContext,
  recordAndEnrich,
} from "./knowledge/index.js";
export type { KnowledgeEntry, KnowledgeType, KnowledgeStats, AnyKnowledgeStore } from "./knowledge/index.js";

export const x402SwarmsPlugin: Plugin = {
  name: "plugin-x402-swarms",
  description:
    "ElizaOS plugin for x402 micropayments (Dexter SDK) and Swarms multi-agent orchestration (15+ architectures: sequential, concurrent, hierarchical, mixture-of-agents, group chat, and more).",
  actions: [payForService, discoverServices, delegateToSwarm, runSwarmAgent, delegateToSwarmWithPayment],
  providers: [x402Provider, x402ServerProvider],
  evaluators: [paymentEvaluator],
  services: [X402WalletService, SwarmsService, X402ServerService, PaymentMemoryService],
  routes: [...x402Routes, ...taskRoutes, ...walletAnalyzerRoutes, ...heliusDataRoutes, ...tradingRoutes, ...cryptoRoutes, ...batchRoutes, ...contentRoutes, ...codeAuditRoutes, ...advancedRoutes, ...cryptoAnalysisRoutes, ...swarmRoutes, ...swarmPremiumRoutes, ...rwaRoutes],
  schema: { x402PaymentHistory, x402EndpointScores, x402BudgetState, x402Knowledge },
};

export default x402SwarmsPlugin;
