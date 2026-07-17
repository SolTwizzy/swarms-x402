import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  ModelType,
} from "@elizaos/core";
import { z } from "zod";
import { searchAPIs, type DiscoveredAPI } from "@dexterai/x402/client";
import { SwarmsService } from "../services/swarmsService.js";
import { X402WalletService } from "../services/x402WalletService.js";
import { findMatchingTemplate, SWARM_TEMPLATES } from "../templates/index.js";
import type { X402DataFetch } from "../types.js";

const MAX_PREFETCH_SERVICES = 3;
const MAX_DATA_PER_SOURCE = 4000;
const MAX_RERUN = 1;

const TaskAndKeywordsSchema = z.object({
  task: z.string().min(1),
  keywords: z.array(z.string()).optional().default([]),
  category: z.string().optional(),
});

const DataRequestSchema = z.array(
  z.object({
    query: z.string(),
    reason: z.string().optional(),
  })
);

/**
 * Delegate a task to a Swarms multi-agent system with x402-funded data.
 * Pre-fetches paid data from OpenDexter, injects it into the swarm prompt,
 * and optionally re-runs if the swarm needs more data.
 */
export const delegateToSwarmWithPayment: Action = {
  name: "DELEGATE_TO_SWARM_WITH_PAYMENT",
  description:
    "Delegate a complex task to a Swarms multi-agent system, automatically discovering and paying for relevant data via x402 before running the swarm. Combines marketplace discovery, micropayments, and multi-agent orchestration in one action.",
  similes: [
    "RESEARCH_AND_SWARM",
    "PAID_SWARM_TASK",
    "X402_SWARM",
    "BUY_DATA_AND_ANALYZE",
    "FUNDED_MULTI_AGENT",
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => {
    const hasSwarms = !!runtime.getSetting("SWARMS_API_KEY");
    const hasWallet =
      !!runtime.getSetting("SOLANA_PRIVATE_KEY") ||
      !!runtime.getSetting("EVM_PRIVATE_KEY");
    return hasSwarms && hasWallet;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<{ success: boolean; text?: string; error?: string } | undefined> => {
    const swarmsService = runtime.getService<SwarmsService>("SWARMS" as any);
    const walletService = runtime.getService<X402WalletService>("X402_WALLET" as any);

    if (!swarmsService?.isAvailable()) {
      await callback?.({ text: "Swarms service not available. Set SWARMS_API_KEY.", error: true });
      return { success: false, error: "Swarms not available" };
    }
    if (!walletService?.getBudgetAccount()) {
      await callback?.({ text: "Wallet not configured. Set SOLANA_PRIVATE_KEY or EVM_PRIVATE_KEY.", error: true });
      return { success: false, error: "Wallet not configured" };
    }

    const userText = message.content.text ?? "";

    // Step 1: Extract task + data keywords
    const extraction = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `Extract the task and data keywords from the user message.
Return JSON: { "task": "<what needs to be done>", "keywords": ["<search terms for finding relevant paid data APIs>"], "category": "<optional: defi, ai, data, social>" }

User message: "${userText}"

Return only valid JSON, no markdown.`,
    });

    let params: z.infer<typeof TaskAndKeywordsSchema>;
    try {
      params = TaskAndKeywordsSchema.parse(JSON.parse(String(extraction)));
    } catch {
      params = { task: userText, keywords: userText.split(/\s+/).slice(0, 5) };
    }

    // Step 2: Discover relevant x402 services
    await callback?.({ text: `Searching OpenDexter for data services matching: ${params.keywords.join(", ")}...` });

    let discoveredApis: DiscoveredAPI[] = [];
    try {
      const searchQueries = [
        params.keywords.join(" "),
        ...(params.category ? [params.category] : []),
      ];
      for (const query of searchQueries) {
        const results = await searchAPIs({
          query,
          limit: 5,
          maxPrice: walletService.getConfig().maxAutoPayUsd,
          sort: "quality_score",
        });
        discoveredApis.push(...results);
      }
      // Deduplicate by URL
      const seen = new Set<string>();
      discoveredApis = discoveredApis.filter((api) => {
        if (seen.has(api.url)) return false;
        seen.add(api.url);
        return true;
      });
    } catch {
      // Marketplace unavailable — continue without pre-fetched data
    }

    // Step 3: Pre-fetch data from top services
    const dataFetches: X402DataFetch[] = [];
    const servicesToFetch = discoveredApis.slice(0, MAX_PREFETCH_SERVICES);

    if (servicesToFetch.length > 0) {
      await callback?.({
        text: `Found ${discoveredApis.length} service(s). Paying for data from ${servicesToFetch.length}...`,
      });

      for (const api of servicesToFetch) {
        try {
          const result = await walletService.payForResource(api.url);
          const responseText = await result.response.text().catch(() => "");
          dataFetches.push({
            serviceName: api.name,
            endpoint: api.url,
            amountUsd: result.amountUsd,
            txHash: result.txHash,
            network: result.network,
            data: responseText.slice(0, MAX_DATA_PER_SOURCE),
            fetchedAt: Date.now(),
            phase: "prefetch",
          });
        } catch {
          // Payment failed for this service — skip and continue
        }
      }
    }

    const prefetchSpend = dataFetches.reduce((sum, d) => sum + d.amountUsd, 0);
    const budgetAccount = walletService.getBudgetAccount()!;

    // Step 4: Build augmented task prompt
    const augmentedTask = buildAugmentedTask(params.task, dataFetches);

    // Step 5: Select swarm template or use default
    const template = findMatchingTemplate(userText);
    const swarmType = template?.swarmType ?? "SequentialWorkflow";
    const agents = template?.agents ?? [
      {
        agent_name: "Researcher",
        system_prompt: "You are a thorough researcher. Analyze the provided data and task. Produce detailed findings.",
        model_name: "gpt-5-mini",
        role: "worker",
        max_loops: 1,
        max_tokens: 4096,
        temperature: 0.5,
      },
      {
        agent_name: "Analyst",
        system_prompt: "You are an expert analyst. Take the research and produce actionable insights and recommendations.",
        model_name: "gpt-5-mini",
        role: "worker",
        max_loops: 1,
        max_tokens: 4096,
        temperature: 0.3,
      },
    ];

    const templateLabel = template ? ` [${template.name}]` : "";
    await callback?.({
      text: `Running swarm (${swarmType})${templateLabel} with ${agents.length} agent(s)...\nPre-fetched: ${dataFetches.length} source(s), $${prefetchSpend.toFixed(4)} spent`,
    });

    // Step 5: Run swarm
    let swarmOutput: string;
    let swarmJobId = "";
    let executionTime = 0;
    let rounds = 1;

    try {
      const result = await swarmsService.runSwarm({
        name: `x402-bridge-${Date.now()}`,
        agents,
        task: augmentedTask,
        swarm_type: swarmType as any,
        max_loops: template?.maxLoops ?? 1,
        rules: template?.rules,
      });

      swarmJobId = result.job_id ?? "";
      executionTime = result.execution_time ?? 0;
      swarmOutput = typeof result.output === "string"
        ? result.output
        : JSON.stringify(result.output, null, 2);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `Swarm failed: ${msg}`, error: true });
      return { success: false, error: msg };
    }

    // Step 6: Check for DATA_REQUESTS and optionally re-run
    if (rounds <= MAX_RERUN) {
      const additionalData = await fetchRequestedData(
        swarmOutput,
        runtime,
        walletService,
        dataFetches
      );

      if (additionalData.length > 0) {
        rounds = 2;
        const allFetches = [...dataFetches, ...additionalData];
        const rerunTask = buildAugmentedTask(params.task, allFetches);

        await callback?.({
          text: `Swarm requested ${additionalData.length} more data source(s). Re-running with additional data...`,
        });

        try {
          const rerunResult = await swarmsService.runSwarm({
            name: `x402-bridge-rerun-${Date.now()}`,
            agents,
            task: rerunTask,
            swarm_type: swarmType as any,
            max_loops: template?.maxLoops ?? 1,
            rules: template?.rules,
          });

          swarmJobId = rerunResult.job_id ?? swarmJobId;
          executionTime += rerunResult.execution_time ?? 0;
          swarmOutput = typeof rerunResult.output === "string"
            ? rerunResult.output
            : JSON.stringify(rerunResult.output, null, 2);
        } catch {
          // Re-run failed — use the original output
        }
      }
    }

    // Step 7: Return results with payment transparency
    const allFetches = dataFetches;
    const totalSpend = allFetches.reduce((sum, d) => sum + d.amountUsd, 0);

    const paymentLines = allFetches.map(
      (d) => `  - ${d.serviceName}: $${d.amountUsd.toFixed(4)} (${d.phase})`
    );

    const text = `Swarm completed (${swarmType})${templateLabel}
Agents: ${agents.length} | Execution time: ${executionTime.toFixed(1)}s | Rounds: ${rounds}

x402 Payments:
${paymentLines.length > 0 ? paymentLines.join("\n") : "  (no paid data used)"}
Total x402 spend: $${totalSpend.toFixed(4)} | Budget remaining: ${budgetAccount.remaining}

Result:
${swarmOutput.slice(0, 1500)}`;

    await callback?.({
      text,
      content: {
        swarmJobId,
        swarmType,
        executionTime: String(executionTime),
        rounds: String(rounds),
        totalX402Spend: String(totalSpend),
        dataSourceCount: String(allFetches.length),
      },
    });

    return { success: true, text };
  },

  examples: [
    [
      {
        name: "user",
        content: { text: "Research the top DeFi protocols by TVL using paid data sources and give me a full analysis" },
      },
      {
        name: "agent",
        content: {
          text: "Swarm completed (SequentialWorkflow)\nAgents: 3 | Rounds: 1\n\nx402 Payments:\n  - CoinGecko: $0.01 (prefetch)\n  - DeFi Risk DB: $0.03 (prefetch)\nTotal: $0.04\n\nResult: [detailed analysis]...",
          actions: ["DELEGATE_TO_SWARM_WITH_PAYMENT"],
        },
      },
    ],
  ],
};

/** Build the augmented task prompt with fetched data injected */
function buildAugmentedTask(task: string, fetches: X402DataFetch[]): string {
  if (fetches.length === 0) {
    return `TASK: ${task}

NOTE: No external data was available for pre-fetching. Complete the task using your built-in knowledge. If you need specific external data, list what you need in a section titled "DATA_REQUESTS:" at the end of your response. Format each as a bullet with the data type and why you need it.`;
  }

  const dataSections = fetches.map(
    (d) => `--- Source: ${d.serviceName} (${d.endpoint}) ---
${d.data}
--- End Source ---`
  );

  return `TASK: ${task}

AVAILABLE DATA (pre-fetched from paid x402 APIs):
${dataSections.join("\n\n")}

INSTRUCTIONS: Use the above data to complete the task. If you need additional data not provided above, list what you need in a section titled "DATA_REQUESTS:" at the end of your response. Format each as a bullet with the data type and why you need it.`;
}

/** Parse swarm output for DATA_REQUESTS and fetch additional data */
async function fetchRequestedData(
  swarmOutput: string,
  runtime: IAgentRuntime,
  walletService: X402WalletService,
  existingFetches: X402DataFetch[]
): Promise<X402DataFetch[]> {
  // Look for DATA_REQUESTS section
  const requestMatch = swarmOutput.match(/DATA_REQUESTS:\s*([\s\S]*?)(?:$|---|\n\n(?=[A-Z]))/i);
  if (!requestMatch) return [];

  // Parse the requests via LLM
  let requests: z.infer<typeof DataRequestSchema>;
  try {
    const parsed = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `Extract data requests from this text. Return a JSON array of { query: string, reason: string }.

Text:
${requestMatch[1].slice(0, 1000)}

Return only valid JSON array, no markdown.`,
    });
    requests = DataRequestSchema.parse(JSON.parse(String(parsed)));
  } catch {
    return [];
  }

  if (requests.length === 0) return [];

  // Fetch each requested data source
  const additionalFetches: X402DataFetch[] = [];
  const existingUrls = new Set(existingFetches.map((d) => d.endpoint));

  for (const req of requests.slice(0, MAX_PREFETCH_SERVICES)) {
    try {
      const apis = await searchAPIs({
        query: req.query,
        limit: 1,
        maxPrice: walletService.getConfig().maxAutoPayUsd,
        sort: "quality_score",
      });

      if (apis.length === 0 || existingUrls.has(apis[0].url)) continue;

      const result = await walletService.payForResource(apis[0].url);
      const responseText = await result.response.text().catch(() => "");

      additionalFetches.push({
        serviceName: apis[0].name,
        endpoint: apis[0].url,
        amountUsd: result.amountUsd,
        txHash: result.txHash,
        network: result.network,
        data: responseText.slice(0, MAX_DATA_PER_SOURCE),
        fetchedAt: Date.now(),
        phase: "swarm-requested",
      });
    } catch {
      // Skip failed fetches
    }
  }

  return additionalFetches;
}
