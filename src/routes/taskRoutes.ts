import type { Route } from "@elizaos/core";
import { x402Gate } from "../server/x402Gate.js";
import { SwarmsService } from "../services/swarmsService.js";
import {
  codeReviewTemplate,
  researchPipelineTemplate,
  debateAndDecideTemplate,
} from "../templates/swarmTemplates.js";
import type { X402ServiceEndpoint } from "../types.js";
import { callOpenAI } from "../utils/llm.js";
import { saveReport } from "../utils/reportStore.js";

// ── Input validation helpers ───────────────────────────────────────────

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

// ── Catalog entries for the 7 new task endpoints ───────────────────────

export const TASK_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "Summarize",
    description:
      "AI-powered text summarization — any content, any length, concise output",
    path: "/x402/summarize",
    method: "POST",
    priceUsd: "0.01",
  },
  {
    name: "Translate",
    description:
      "AI translation to any language — auto-detects source language",
    path: "/x402/translate",
    method: "POST",
    priceUsd: "0.02",
  },
  {
    name: "Code Review",
    description:
      "Multi-agent code review — security audit, performance analysis, and style check in parallel",
    path: "/x402/code-review",
    method: "POST",
    priceUsd: "0.03",
  },
  {
    name: "Write",
    description:
      "Multi-agent content writing — research, fact-check, and write on any topic",
    path: "/x402/write",
    method: "POST",
    priceUsd: "0.03",
  },
  {
    name: "Debate",
    description:
      "Multi-agent debate — pro and con agents argue, a judge delivers a verdict",
    path: "/x402/debate",
    method: "POST",
    priceUsd: "0.03",
  },
  {
    name: "Extract",
    description:
      "Structured data extraction — pull specific fields from unstructured text",
    path: "/x402/extract",
    method: "POST",
    priceUsd: "0.01",
  },
  {
    name: "Sentiment",
    description:
      "Sentiment analysis — positive/negative/neutral classification with confidence and reasoning",
    path: "/x402/sentiment",
    method: "POST",
    priceUsd: "0.01",
  },
];

// ── Helper: get SwarmsService or 503 ──────────────────────────────────

function getSwarmsService(runtime: any): SwarmsService | null {
  const svc = runtime.getService("SWARMS" as any) as SwarmsService | null;
  return svc?.isAvailable() ? svc : null;
}

// ── Routes ─────────────────────────────────────────────────────────────

export const taskRoutes: Route[] = [
  // ── POST /x402/summarize — $0.01 ──────────────────────────────────
  {
    type: "POST",
    path: "/x402/summarize",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.01",
        description: "AI text summarization",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const text = requireString(body, "text");
      if (!text) {
        res.status(400).json({ error: "Missing required field: text (non-empty string)" });
        return;
      }
      const maxLength = typeof body.maxLength === "number" ? Math.max(10, Math.min(body.maxLength, 10000)) : 200;

      const systemPrompt =
        "You are a precise summarizer. Produce a clear, concise summary of the input text. " +
        "Return ONLY the summary — no preamble, no labels, no extra commentary.";
      const userPrompt = `Summarize the following text in at most ${maxLength} words:\n\n${text}`;

      try {
        let summary: string;
        const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");

        if (openaiKey) {
          // Direct OpenAI — single agent, no Swarms overhead
          summary = await callOpenAI({
            apiKey: openaiKey,
            systemPrompt,
            userPrompt,
            maxTokens: 4096,
            temperature: 0.3,
          });
        } else {
          // Fallback: Swarms API
          const swarmsService = getSwarmsService(runtime);
          if (!swarmsService) {
            res.status(503).json({ error: "Neither OPENAI_API_KEY nor Swarms service available" });
            return;
          }
          const result = await swarmsService.runAgent(
            {
              agent_name: "summarizer",
              model_name: "gpt-4o-mini",
              system_prompt: systemPrompt,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.3,
              role: "worker",
            },
            userPrompt
          );
          summary = String(result.outputs ?? result);
        }

        const wordCount = summary.split(/\s+/).filter(Boolean).length;

        res.json({
          summary,
          wordCount,
          payment: { amount: "0.01", transaction: gate.transaction, network: gate.network },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/summarize] Agent execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/translate — $0.02 ──────────────────────────────────
  {
    type: "POST",
    path: "/x402/translate",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.02",
        description: "AI text translation",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const text = requireString(body, "text");
      if (!text) {
        res.status(400).json({ error: "Missing required field: text (non-empty string)" });
        return;
      }
      const targetLanguage = requireString(body, "targetLanguage", 100);
      if (!targetLanguage) {
        res.status(400).json({ error: "Missing required field: targetLanguage (e.g. 'Spanish', 'Japanese')" });
        return;
      }

      const systemPrompt =
        "You are an expert translator. Translate the given text to the target language accurately, " +
        "preserving tone and meaning. Respond with ONLY a JSON object: " +
        '{ "translation": "<translated text>", "sourceLanguage": "<detected source language>" }. ' +
        "No extra text outside the JSON.";
      const userPrompt = `Translate to ${targetLanguage}:\n\n${text}`;

      try {
        let raw: string;
        const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");

        if (openaiKey) {
          // Direct OpenAI — single agent, no Swarms overhead
          raw = await callOpenAI({
            apiKey: openaiKey,
            systemPrompt,
            userPrompt,
            maxTokens: 8192,
            temperature: 0.2,
          });
        } else {
          // Fallback: Swarms API
          const swarmsService = getSwarmsService(runtime);
          if (!swarmsService) {
            res.status(503).json({ error: "Neither OPENAI_API_KEY nor Swarms service available" });
            return;
          }
          const result = await swarmsService.runAgent(
            {
              agent_name: "translator",
              model_name: "gpt-4o-mini",
              system_prompt: systemPrompt,
              max_loops: 1,
              max_tokens: 8192,
              temperature: 0.2,
              role: "worker",
            },
            userPrompt
          );
          raw = String(result.outputs ?? result);
        }

        let translation = raw;
        let sourceLanguage = "unknown";

        // Attempt to parse structured JSON from agent output
        try {
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
            if (typeof parsed.translation === "string") translation = parsed.translation;
            if (typeof parsed.sourceLanguage === "string") sourceLanguage = parsed.sourceLanguage;
          }
        } catch {
          // Fallback: use raw output as translation
        }

        res.json({
          translation,
          sourceLanguage,
          targetLanguage,
          payment: { amount: "0.02", transaction: gate.transaction, network: gate.network },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/translate] Agent execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/code-review — $0.03 ────────────────────────────────
  {
    type: "POST",
    path: "/x402/code-review",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.03",
        description: "Multi-agent code review (security + performance + style)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const code = requireString(body, "code");
      if (!code) {
        res.status(400).json({ error: "Missing required field: code (non-empty string)" });
        return;
      }
      const language = typeof body.language === "string" ? body.language : "auto-detect";

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `code-review-${Date.now()}`,
          description: `Code review (${language})`,
          agents: codeReviewTemplate.agents,
          swarm_type: codeReviewTemplate.swarmType as any,
          task:
            `Review the following ${language} code. Each reviewer should output a JSON block with their findings.\n\n` +
            "```\n" +
            code +
            "\n```",
          max_loops: codeReviewTemplate.maxLoops ?? 1,
        });

        const output = String(result.output ?? result);

        // Save report for shareable link + badge
        const base =
          process.env.SWARMX_BASE_URL
            ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "https://api.swarmx.io");
        const reportId = saveReport({
          type: "code-review",
          createdAt: new Date().toISOString(),
          input: { code: code.slice(0, 2000), language },
          result: { output },
          riskScore: null,
          paid: gate.amountUsd > 0,
        });

        res.json({
          security: output,
          performance: output,
          style: output,
          overallScore: output,
          rawOutput: output,
          reportUrl: `${base}/report/${reportId}`,
          badgeUrl: `${base}/badge/${reportId}`,
          badgeMarkdown: `[![SwarmX Audit](${base}/badge/${reportId})](${base}/report/${reportId})`,
          template: "CodeReview",
          payment: { amount: "0.03", transaction: gate.transaction, network: gate.network },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/code-review] Swarm execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/write — $0.03 ──────────────────────────────────────
  {
    type: "POST",
    path: "/x402/write",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.03",
        description: "Multi-agent content writing (research + fact-check + write)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const topic = requireString(body, "topic", 10_000);
      if (!topic) {
        res.status(400).json({ error: "Missing required field: topic (non-empty string)" });
        return;
      }
      const style = typeof body.style === "string" ? body.style : "professional";
      const length = typeof body.length === "string" ? body.length : "medium";

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      try {
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
        const wordCount = content.split(/\s+/).filter(Boolean).length;

        res.json({
          content,
          wordCount,
          template: "ResearchPipeline",
          payment: { amount: "0.03", transaction: gate.transaction, network: gate.network },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/write] Swarm execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/debate — $0.03 ─────────────────────────────────────
  {
    type: "POST",
    path: "/x402/debate",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.03",
        description: "Multi-agent debate (pro + con + judge verdict)",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const proposition = requireString(body, "proposition", 10_000);
      if (!proposition) {
        res.status(400).json({ error: "Missing required field: proposition (non-empty string)" });
        return;
      }

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      try {
        const result = await swarmsService.runSwarm({
          name: `debate-${Date.now()}`,
          description: `Debate: ${proposition.slice(0, 100)}`,
          agents: debateAndDecideTemplate.agents,
          swarm_type: debateAndDecideTemplate.swarmType as any,
          task: `Debate the following proposition: ${proposition}`,
          max_loops: debateAndDecideTemplate.maxLoops ?? 1,
        });

        const output = String(result.output ?? result);

        res.json({
          proArgument: output,
          conArgument: output,
          verdict: output,
          confidence: output,
          rawOutput: output,
          template: "DebateAndDecide",
          payment: { amount: "0.03", transaction: gate.transaction, network: gate.network },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/debate] Swarm execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/extract — $0.01 ────────────────────────────────────
  {
    type: "POST",
    path: "/x402/extract",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.01",
        description: "Structured data extraction from unstructured text",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const text = requireString(body, "text");
      if (!text) {
        res.status(400).json({ error: "Missing required field: text (non-empty string)" });
        return;
      }
      const fields = requireStringArray(body, "fields");
      if (!fields) {
        res.status(400).json({ error: "Missing required field: fields (non-empty string array)" });
        return;
      }

      const systemPrompt =
        "You are a data extraction specialist. Extract the requested fields from the input text. " +
        "Respond with ONLY a JSON object where keys are the requested field names and values are " +
        'the extracted data (use "" if not found). No extra text outside the JSON.';
      const fieldList = fields.join(", ");
      const userPrompt = `Extract the following fields: [${fieldList}]\n\nFrom this text:\n${text}`;

      try {
        let raw: string;
        const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");

        if (openaiKey) {
          // Direct OpenAI — single agent, no Swarms overhead
          raw = await callOpenAI({
            apiKey: openaiKey,
            systemPrompt,
            userPrompt,
            maxTokens: 4096,
            temperature: 0.1,
          });
        } else {
          // Fallback: Swarms API
          const swarmsService = getSwarmsService(runtime);
          if (!swarmsService) {
            res.status(503).json({ error: "Neither OPENAI_API_KEY nor Swarms service available" });
            return;
          }
          const result = await swarmsService.runAgent(
            {
              agent_name: "extractor",
              model_name: "gpt-4o-mini",
              system_prompt: systemPrompt,
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.1,
              role: "worker",
            },
            userPrompt
          );
          raw = String(result.outputs ?? result);
        }

        let extracted: Record<string, string> = {};

        // Attempt to parse structured JSON
        try {
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
            for (const f of fields) {
              extracted[f] = typeof parsed[f] === "string" ? parsed[f] as string : String(parsed[f] ?? "");
            }
          } else {
            // Fallback: set all fields to raw output
            for (const f of fields) extracted[f] = raw;
          }
        } catch {
          for (const f of fields) extracted[f] = raw;
        }

        res.json({
          extracted,
          payment: { amount: "0.01", transaction: gate.transaction, network: gate.network },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/extract] Agent execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/sentiment — $0.01 ──────────────────────────────────
  {
    type: "POST",
    path: "/x402/sentiment",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.01",
        description: "AI sentiment analysis",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const text = requireString(body, "text");
      if (!text) {
        res.status(400).json({ error: "Missing required field: text (non-empty string)" });
        return;
      }

      const systemPrompt =
        "You are a sentiment analysis expert. Analyze the sentiment of the given text. " +
        "Respond with ONLY a JSON object: " +
        '{ "sentiment": "positive"|"negative"|"neutral", "confidence": <0.0-1.0>, "reasoning": "<brief explanation>" }. ' +
        "No extra text outside the JSON.";
      const userPrompt = `Analyze the sentiment of the following text:\n\n${text}`;

      try {
        let raw: string;
        const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");

        if (openaiKey) {
          // Direct OpenAI — single agent, no Swarms overhead
          raw = await callOpenAI({
            apiKey: openaiKey,
            systemPrompt,
            userPrompt,
            maxTokens: 1024,
            temperature: 0.1,
          });
        } else {
          // Fallback: Swarms API
          const swarmsService = getSwarmsService(runtime);
          if (!swarmsService) {
            res.status(503).json({ error: "Neither OPENAI_API_KEY nor Swarms service available" });
            return;
          }
          const result = await swarmsService.runAgent(
            {
              agent_name: "sentiment-analyst",
              model_name: "gpt-4o-mini",
              system_prompt: systemPrompt,
              max_loops: 1,
              max_tokens: 1024,
              temperature: 0.1,
              role: "worker",
            },
            userPrompt
          );
          raw = String(result.outputs ?? result);
        }

        let sentiment: "positive" | "negative" | "neutral" = "neutral";
        let confidence = 0.5;
        let reasoning = raw;

        // Attempt to parse structured JSON
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
        } catch {
          // Fallback: raw output as reasoning
        }

        res.json({
          sentiment,
          confidence,
          reasoning,
          payment: { amount: "0.01", transaction: gate.transaction, network: gate.network },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/sentiment] Agent execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },
];
