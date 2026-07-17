import type { Route } from "@elizaos/core";
import { x402Gate } from "../server/x402Gate.js";
import { SwarmsService } from "../services/swarmsService.js";
import {
  codeReviewTemplate,
  researchPipelineTemplate,
  analysisPanelTemplate,
  debateAndDecideTemplate,
} from "../templates/swarmTemplates.js";
import type { X402ServiceEndpoint } from "../types.js";
import { callOpenAI } from "../utils/llm.js";

// ── Price map: endpoint slug -> USD price ────────────────────────────────

const PRICE_MAP: Record<string, number> = {
  summarize: 0.01,
  translate: 0.02,
  extract: 0.01,
  sentiment: 0.01,
  "code-review": 0.03,
  write: 0.03,
  debate: 0.03,
  "contract-audit": 0.10,
  "token-risk": 0.05,
  "dao-analyze": 0.10,
  research: 0.05,
  analyze: 0.03,
  agent: 0.02,
};

// ── Catalog ──────────────────────────────────────────────────────────────

export const BATCH_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "Batch Tasks",
    description:
      "Run up to 10 tasks in parallel with a single x402 payment — 20% discount on the sum of individual prices",
    path: "/x402/batch",
    method: "POST",
    priceUsd: "varies",
  },
];

// ── Input validation helpers ─────────────────────────────────────────────

function requireString(
  body: Record<string, unknown>,
  field: string,
  maxLen = 100_000
): string | null {
  const val = body[field];
  if (!val || typeof val !== "string" || val.trim().length === 0) return null;
  return val.slice(0, maxLen);
}

function requireStringArray(
  body: Record<string, unknown>,
  field: string,
  maxItems = 50
): string[] | null {
  const val = body[field];
  if (!Array.isArray(val) || val.length === 0) return null;
  const filtered = val
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .slice(0, maxItems);
  return filtered.length > 0 ? filtered : null;
}

// ── Helper: get SwarmsService or null ────────────────────────────────────

function getSwarmsService(runtime: any): SwarmsService | null {
  const svc = runtime.getService("SWARMS" as any) as SwarmsService | null;
  return svc?.isAvailable() ? svc : null;
}

// ── Task executors: endpoint slug -> async function(params, runtime) ─────
// Each executor encapsulates the core logic of the corresponding endpoint
// handler, without the HTTP layer (no req/res, no x402Gate).

type TaskExecutor = (
  params: Record<string, unknown>,
  runtime: any
) => Promise<Record<string, unknown>>;

const EXECUTORS: Record<string, TaskExecutor> = {
  summarize: async (params, runtime) => {
    const text = typeof params.text === "string" && params.text.trim() ? params.text : null;
    if (!text) throw new Error("Missing required field: text");
    const maxLength =
      typeof params.maxLength === "number"
        ? Math.max(10, Math.min(params.maxLength, 10000))
        : 200;

    const systemPrompt =
      "You are a precise summarizer. Produce a clear, concise summary of the input text. " +
      "Return ONLY the summary — no preamble, no labels, no extra commentary.";
    const userPrompt = `Summarize the following text in at most ${maxLength} words:\n\n${text}`;

    const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");
    let summary: string;

    if (openaiKey) {
      summary = await callOpenAI({ apiKey: openaiKey, systemPrompt, userPrompt, maxTokens: 4096, temperature: 0.3 });
    } else {
      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) throw new Error("Neither OPENAI_API_KEY nor Swarms service available");
      const result = await swarmsService.runAgent(
        { agent_name: "summarizer", model_name: "gpt-5-mini", system_prompt: systemPrompt, max_loops: 1, max_tokens: 4096, temperature: 0.3, role: "worker" },
        userPrompt
      );
      summary = String(result.outputs ?? result);
    }

    return { summary, wordCount: summary.split(/\s+/).filter(Boolean).length };
  },

  translate: async (params, runtime) => {
    const text = typeof params.text === "string" && params.text.trim() ? params.text : null;
    if (!text) throw new Error("Missing required field: text");
    const targetLanguage = typeof params.targetLanguage === "string" && params.targetLanguage.trim() ? params.targetLanguage : null;
    if (!targetLanguage) throw new Error("Missing required field: targetLanguage");

    const systemPrompt =
      "You are an expert translator. Translate the given text to the target language accurately, " +
      "preserving tone and meaning. Respond with ONLY a JSON object: " +
      '{ "translation": "<translated text>", "sourceLanguage": "<detected source language>" }. ' +
      "No extra text outside the JSON.";
    const userPrompt = `Translate to ${targetLanguage}:\n\n${text}`;

    const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");
    let raw: string;

    if (openaiKey) {
      raw = await callOpenAI({ apiKey: openaiKey, systemPrompt, userPrompt, maxTokens: 8192, temperature: 0.2 });
    } else {
      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) throw new Error("Neither OPENAI_API_KEY nor Swarms service available");
      const result = await swarmsService.runAgent(
        { agent_name: "translator", model_name: "gpt-5-mini", system_prompt: systemPrompt, max_loops: 1, max_tokens: 8192, temperature: 0.2, role: "worker" },
        userPrompt
      );
      raw = String(result.outputs ?? result);
    }

    let translation = raw;
    let sourceLanguage = "unknown";
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        if (typeof parsed.translation === "string") translation = parsed.translation;
        if (typeof parsed.sourceLanguage === "string") sourceLanguage = parsed.sourceLanguage;
      }
    } catch { /* fallback to raw */ }

    return { translation, sourceLanguage, targetLanguage };
  },

  extract: async (params, runtime) => {
    const text = typeof params.text === "string" && params.text.trim() ? params.text : null;
    if (!text) throw new Error("Missing required field: text");
    const fields = Array.isArray(params.fields) ? params.fields.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : null;
    if (!fields || fields.length === 0) throw new Error("Missing required field: fields");

    const systemPrompt =
      "You are a data extraction specialist. Extract the requested fields from the input text. " +
      "Respond with ONLY a JSON object where keys are the requested field names and values are " +
      'the extracted data (use "" if not found). No extra text outside the JSON.';
    const fieldList = fields.join(", ");
    const userPrompt = `Extract the following fields: [${fieldList}]\n\nFrom this text:\n${text}`;

    const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");
    let raw: string;

    if (openaiKey) {
      raw = await callOpenAI({ apiKey: openaiKey, systemPrompt, userPrompt, maxTokens: 4096, temperature: 0.1 });
    } else {
      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) throw new Error("Neither OPENAI_API_KEY nor Swarms service available");
      const result = await swarmsService.runAgent(
        { agent_name: "extractor", model_name: "gpt-5-mini", system_prompt: systemPrompt, max_loops: 1, max_tokens: 4096, temperature: 0.1, role: "worker" },
        userPrompt
      );
      raw = String(result.outputs ?? result);
    }

    const extracted: Record<string, string> = {};
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        for (const f of fields) {
          extracted[f] = typeof parsed[f] === "string" ? parsed[f] as string : String(parsed[f] ?? "");
        }
      } else {
        for (const f of fields) extracted[f] = raw;
      }
    } catch {
      for (const f of fields) extracted[f] = raw;
    }

    return { extracted };
  },

  sentiment: async (params, runtime) => {
    const text = typeof params.text === "string" && params.text.trim() ? params.text : null;
    if (!text) throw new Error("Missing required field: text");

    const systemPrompt =
      "You are a sentiment analysis expert. Analyze the sentiment of the given text. " +
      "Respond with ONLY a JSON object: " +
      '{ "sentiment": "positive"|"negative"|"neutral", "confidence": <0.0-1.0>, "reasoning": "<brief explanation>" }. ' +
      "No extra text outside the JSON.";
    const userPrompt = `Analyze the sentiment of the following text:\n\n${text}`;

    const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");
    let raw: string;

    if (openaiKey) {
      raw = await callOpenAI({ apiKey: openaiKey, systemPrompt, userPrompt, maxTokens: 1024, temperature: 0.1 });
    } else {
      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) throw new Error("Neither OPENAI_API_KEY nor Swarms service available");
      const result = await swarmsService.runAgent(
        { agent_name: "sentiment-analyst", model_name: "gpt-5-mini", system_prompt: systemPrompt, max_loops: 1, max_tokens: 1024, temperature: 0.1, role: "worker" },
        userPrompt
      );
      raw = String(result.outputs ?? result);
    }

    let sentiment: "positive" | "negative" | "neutral" = "neutral";
    let confidence = 0.5;
    let reasoning = raw;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        if (parsed.sentiment === "positive" || parsed.sentiment === "negative" || parsed.sentiment === "neutral") {
          sentiment = parsed.sentiment;
        }
        if (typeof parsed.confidence === "number") confidence = parsed.confidence;
        if (typeof parsed.reasoning === "string") reasoning = parsed.reasoning;
      }
    } catch { /* fallback */ }

    return { sentiment, confidence, reasoning };
  },

  "code-review": async (params, runtime) => {
    const code = typeof params.code === "string" && params.code.trim() ? params.code : null;
    if (!code) throw new Error("Missing required field: code");
    const language = typeof params.language === "string" ? params.language : "auto-detect";

    const swarmsService = getSwarmsService(runtime);
    if (!swarmsService) throw new Error("Swarms service unavailable");

    const result = await swarmsService.runSwarm({
      name: `code-review-${Date.now()}`,
      description: `Code review (${language})`,
      agents: codeReviewTemplate.agents,
      swarm_type: codeReviewTemplate.swarmType as any,
      task:
        `Review the following ${language} code. Each reviewer should output a JSON block with their findings.\n\n` +
        "```\n" + code + "\n```",
      max_loops: codeReviewTemplate.maxLoops ?? 1,
    });

    return { output: String(result.output ?? result) };
  },

  write: async (params, runtime) => {
    const topic = typeof params.topic === "string" && params.topic.trim() ? params.topic : null;
    if (!topic) throw new Error("Missing required field: topic");
    const style = typeof params.style === "string" ? params.style : "professional";
    const length = typeof params.length === "string" ? params.length : "medium";

    const swarmsService = getSwarmsService(runtime);
    if (!swarmsService) throw new Error("Swarms service unavailable");

    const result = await swarmsService.runSwarm({
      name: `write-${Date.now()}`,
      description: `Write about: ${topic.slice(0, 100)}`,
      agents: researchPipelineTemplate.agents,
      swarm_type: researchPipelineTemplate.swarmType as any,
      task:
        `Write a ${length}-length article about: ${topic}\n` +
        `Style: ${style}\n` +
        "The Researcher gathers information, the FactChecker verifies it, and the Writer produces the final piece.",
      max_loops: researchPipelineTemplate.maxLoops ?? 1,
      rules: researchPipelineTemplate.rules,
    });

    const content = String(result.output ?? result);
    return { content, wordCount: content.split(/\s+/).filter(Boolean).length };
  },

  debate: async (params, runtime) => {
    const proposition = typeof params.proposition === "string" && params.proposition.trim() ? params.proposition : null;
    if (!proposition) throw new Error("Missing required field: proposition");

    const swarmsService = getSwarmsService(runtime);
    if (!swarmsService) throw new Error("Swarms service unavailable");

    const result = await swarmsService.runSwarm({
      name: `debate-${Date.now()}`,
      description: `Debate: ${proposition.slice(0, 100)}`,
      agents: debateAndDecideTemplate.agents,
      swarm_type: debateAndDecideTemplate.swarmType as any,
      task: `Debate the following proposition: ${proposition}`,
      max_loops: debateAndDecideTemplate.maxLoops ?? 1,
    });

    return { output: String(result.output ?? result) };
  },

  "contract-audit": async (params, runtime) => {
    const code = typeof params.code === "string" && params.code.trim() ? params.code : null;
    if (!code) throw new Error("Missing required field: code");

    const swarmsService = getSwarmsService(runtime);
    if (!swarmsService) throw new Error("Swarms service unavailable");

    const result = await swarmsService.runSwarm({
      name: `contract-audit-batch-${Date.now()}`,
      description: "Smart contract audit (batch)",
      agents: [
        {
          agent_name: "SecurityAuditor",
          system_prompt: "You are an expert smart contract security auditor. Analyze the code for security vulnerabilities.",
          model_name: "gpt-5-mini",
          role: "worker" as const,
          max_loops: 1,
          max_tokens: 4096,
          temperature: 0.2,
        },
      ],
      swarm_type: "ConcurrentWorkflow",
      task: `Audit the following smart contract code:\n\n\`\`\`\n${code}\n\`\`\``,
      max_loops: 1,
    });

    return { output: String(result.output ?? result) };
  },

  "token-risk": async (params, runtime) => {
    const mint = typeof params.mint === "string" && params.mint.trim() ? params.mint : null;
    if (!mint) throw new Error("Missing required field: mint");

    const swarmsService = getSwarmsService(runtime);
    if (!swarmsService) throw new Error("Swarms service unavailable");

    const result = await swarmsService.runSwarm({
      name: `token-risk-batch-${Date.now()}`,
      description: `Token risk assessment: ${mint}`,
      agents: [
        {
          agent_name: "TokenAnalyst",
          system_prompt: "You are a token risk analyst. Assess the given token for rug pull indicators and risk factors.",
          model_name: "gpt-5-mini",
          role: "worker" as const,
          max_loops: 1,
          max_tokens: 4096,
          temperature: 0.2,
        },
      ],
      swarm_type: "SequentialWorkflow",
      task: `Assess the risk for token mint: ${mint}`,
      max_loops: 1,
    });

    return { output: String(result.output ?? result) };
  },

  "dao-analyze": async (params, runtime) => {
    const proposal = typeof params.proposal === "string" && params.proposal.trim() ? params.proposal : null;
    if (!proposal) throw new Error("Missing required field: proposal");

    const swarmsService = getSwarmsService(runtime);
    if (!swarmsService) throw new Error("Swarms service unavailable");

    const result = await swarmsService.runSwarm({
      name: `dao-analyze-batch-${Date.now()}`,
      description: `DAO analysis: ${proposal.slice(0, 100)}`,
      agents: analysisPanelTemplate.agents,
      swarm_type: analysisPanelTemplate.swarmType as any,
      task: `Analyze the following DAO proposal: ${proposal}`,
      max_loops: analysisPanelTemplate.maxLoops ?? 1,
    });

    return { output: String(result.output ?? result) };
  },

  research: async (params, runtime) => {
    const query = typeof params.query === "string" && params.query.trim() ? params.query : null;
    if (!query) throw new Error("Missing required field: query");
    const depth = typeof params.depth === "string" ? params.depth : "standard";

    const swarmsService = getSwarmsService(runtime);
    if (!swarmsService) throw new Error("Swarms service unavailable");

    const result = await swarmsService.runSwarm({
      name: `research-batch-${Date.now()}`,
      description: `Research: ${query}`,
      agents: researchPipelineTemplate.agents,
      swarm_type: researchPipelineTemplate.swarmType as any,
      task: `Research the following topic (depth: ${depth}): ${query}`,
      max_loops: researchPipelineTemplate.maxLoops ?? 1,
      rules: researchPipelineTemplate.rules,
    });

    return { output: String(result.output ?? result) };
  },

  analyze: async (params, runtime) => {
    const text = typeof params.text === "string" && params.text.trim() ? params.text : null;
    if (!text) throw new Error("Missing required field: text");
    const analysisType = typeof params.type === "string" ? params.type : "comprehensive";

    const swarmsService = getSwarmsService(runtime);
    if (!swarmsService) throw new Error("Swarms service unavailable");

    const result = await swarmsService.runSwarm({
      name: `analysis-batch-${Date.now()}`,
      description: `Analysis: ${text.slice(0, 100)}`,
      agents: analysisPanelTemplate.agents,
      swarm_type: analysisPanelTemplate.swarmType as any,
      task: `Perform a ${analysisType} analysis of the following: ${text}`,
      max_loops: analysisPanelTemplate.maxLoops ?? 1,
    });

    return { output: String(result.output ?? result) };
  },

  agent: async (params, runtime) => {
    const task = typeof params.task === "string" && params.task.trim() ? params.task : null;
    if (!task) throw new Error("Missing required field: task");

    const systemPrompt =
      typeof params.systemPrompt === "string"
        ? params.systemPrompt
        : "You are a helpful AI agent. Complete the given task thoroughly and concisely.";
    const model = typeof params.model === "string" ? params.model : "gpt-5-mini";

    const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");
    let output: string;

    if (openaiKey) {
      output = await callOpenAI({ apiKey: openaiKey, model, systemPrompt, userPrompt: task, maxTokens: 4096, temperature: 0.5 });
    } else {
      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) throw new Error("Neither OPENAI_API_KEY nor Swarms service available");
      const result = await swarmsService.runAgent(
        { agent_name: "x402-agent", model_name: model, system_prompt: systemPrompt, max_loops: 1, max_tokens: 4096, temperature: 0.5, role: "worker" },
        task
      );
      output = String(result.outputs ?? result);
    }

    return { output };
  },
};

// ── Batch task item types ────────────────────────────────────────────────

interface BatchTaskInput {
  endpoint: string;
  params: Record<string, unknown>;
}

interface BatchTaskResult {
  endpoint: string;
  status: "success" | "error";
  data?: Record<string, unknown>;
  error?: string;
}

// ── Discount ─────────────────────────────────────────────────────────────

const BATCH_DISCOUNT = 0.20; // 20%

/**
 * Calculate the discounted total price for a batch of tasks.
 * Returns { discountedTotal, originalTotal } both as strings with 2 decimal places.
 */
export function calculateBatchPrice(endpoints: string[]): {
  discountedTotal: string;
  originalTotal: string;
} {
  let total = 0;
  for (const ep of endpoints) {
    const price = PRICE_MAP[ep];
    if (price === undefined) throw new Error(`Unknown endpoint: ${ep}`);
    total += price;
  }
  const discounted = total * (1 - BATCH_DISCOUNT);
  return {
    originalTotal: total.toFixed(2),
    discountedTotal: discounted.toFixed(2),
  };
}

// ── Route ────────────────────────────────────────────────────────────────

export const batchRoutes: Route[] = [
  {
    type: "POST",
    path: "/x402/batch",
    handler: async (req, res, runtime) => {
      const body = (req as any).body ?? {};

      // ── Validate tasks array ────────────────────────────────────────
      if (!Array.isArray(body.tasks)) {
        res.status(400).json({ error: "Missing required field: tasks (array)" });
        return;
      }
      if (body.tasks.length === 0) {
        res.status(400).json({ error: "Tasks array must not be empty" });
        return;
      }
      if (body.tasks.length > 10) {
        res.status(400).json({ error: "Too many tasks: maximum 10 per batch" });
        return;
      }

      // ── Validate each task references a known endpoint ──────────────
      const tasks: BatchTaskInput[] = body.tasks;
      for (const task of tasks) {
        if (!task.endpoint || typeof task.endpoint !== "string") {
          res.status(400).json({ error: "Each task must have an 'endpoint' string" });
          return;
        }
        if (!(task.endpoint in PRICE_MAP)) {
          res.status(400).json({ error: `Unknown endpoint: ${task.endpoint}` });
          return;
        }
        if (!task.params || typeof task.params !== "object") {
          res.status(400).json({ error: `Task for endpoint '${task.endpoint}' must have a 'params' object` });
          return;
        }
      }

      // ── Calculate discounted price ──────────────────────────────────
      const { discountedTotal, originalTotal } = calculateBatchPrice(
        tasks.map((t) => t.endpoint)
      );

      // ── x402 gate with discounted total ─────────────────────────────
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: discountedTotal,
        description: `Batch: ${tasks.length} tasks (20% discount)`,
      });
      if (!gate.paid) return;

      // ── Execute all tasks in parallel ───────────────────────────────
      const settled = await Promise.allSettled(
        tasks.map(async (task): Promise<BatchTaskResult> => {
          const executor = EXECUTORS[task.endpoint];
          if (!executor) {
            return { endpoint: task.endpoint, status: "error", error: `No executor for endpoint: ${task.endpoint}` };
          }
          try {
            const data = await executor(task.params, runtime);
            return { endpoint: task.endpoint, status: "success", data };
          } catch (err) {
            return {
              endpoint: task.endpoint,
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })
      );

      // ── Build results array ─────────────────────────────────────────
      const results: BatchTaskResult[] = settled.map((s) => {
        if (s.status === "fulfilled") return s.value;
        return {
          endpoint: "unknown",
          status: "error" as const,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        };
      });

      res.json({
        results,
        payment: {
          amount: discountedTotal,
          discount: "20%",
          originalAmount: originalTotal,
          transaction: gate.transaction,
          network: gate.network,
        },
        template: "Batch",
      });
    },
  },
];
