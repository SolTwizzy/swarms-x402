import type { Route } from "@elizaos/core";
import { x402Gate } from "../server/x402Gate.js";
import type { X402GateResult } from "../server/x402Gate.js";
import { SwarmsService } from "../services/swarmsService.js";
import type { X402ServiceEndpoint } from "../types.js";
import { callOpenAI } from "../utils/llm.js";

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

function optionalStringArray(
  body: Record<string, unknown>,
  field: string,
  maxItems: number
): string[] | undefined {
  const val = body[field];
  if (!Array.isArray(val)) return undefined;
  const filtered = val
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .slice(0, maxItems);
  return filtered.length > 0 ? filtered : undefined;
}

const VALID_TONES = ["professional", "casual", "academic", "conversational", "authoritative"] as const;
type Tone = (typeof VALID_TONES)[number];

const VALID_FORMATS = ["json", "table"] as const;
type ExtractFormat = (typeof VALID_FORMATS)[number];

// ── Catalog entries ───────────────────────────────────────────────────

export const CONTENT_CATALOG: X402ServiceEndpoint[] = [
  {
    name: "SEO Article",
    description:
      "Multi-agent SEO article generation — research, write, and edit with keyword optimization",
    path: "/x402/seo-article",
    method: "POST",
    priceUsd: "0.10",
  },
  {
    name: "Document Extract",
    description:
      "AI document data extraction — pull structured fields from unstructured text",
    path: "/x402/document-extract",
    method: "POST",
    priceUsd: "0.05",
  },
];

// ── Helper: get SwarmsService or null ──────────────────────────────────

function getSwarmsService(runtime: any): SwarmsService | null {
  const svc = runtime.getService("SWARMS" as any) as SwarmsService | null;
  return svc?.isAvailable() ? svc : null;
}

// ── JSON parse helper ──────────────────────────────────────────────────

function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as Record<string, unknown>;
    }
  } catch {
    // not valid JSON
  }
  return null;
}

// ── Swarm output extraction ────────────────────────────────────────────

function extractSwarmOutput(result: Record<string, unknown>): string {
  const output = result.output;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((item: unknown) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const role = obj.role ?? obj.agent_name ?? "agent";
          const content = obj.content ?? obj.text ?? obj.output ?? "";
          return `[${role}]\n${content}`;
        }
        return String(item);
      })
      .join("\n\n");
  }
  if (output && typeof output === "object") {
    const nested = output as Record<string, unknown>;
    if (typeof nested.output === "string") return nested.output;
    if (typeof nested.content === "string") return nested.content;
    return JSON.stringify(output);
  }
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

// ── Free tier truncation helpers ───────────────────────────────────────

function truncateSeoArticleForFreeTier(
  result: {
    article: string;
    title: string;
    metaDescription: string;
    wordCount: number;
    readabilityScore: number | null;
    keywordDensity: Record<string, number> | null;
    editsApplied: string[];
  },
  gate: X402GateResult
): Record<string, unknown> {
  if (gate.amountUsd > 0) return result as any; // paid — full output
  return {
    title: result.title,
    metaDescription: result.metaDescription,
    wordCount: result.wordCount,
    articlePreview: result.article.slice(0, 200),
    _preview: true,
    _message: `Article "${result.title}" (${result.wordCount} words) generated. Pay $0.10 to see full article.`,
  };
}

function truncateDocumentExtractForFreeTier(
  result: {
    extracted: Record<string, unknown>;
    confidence: number;
    fieldsFound: number;
    fieldsRequested: number | string;
    notes: string[];
  },
  gate: X402GateResult
): Record<string, unknown> {
  if (gate.amountUsd > 0) return result as any; // paid — full output
  const fieldNames = Object.keys(result.extracted);
  return {
    fieldsFound: result.fieldsFound,
    confidence: result.confidence,
    fieldNames,
    _preview: true,
    _message: `Extracted ${result.fieldsFound} fields (confidence: ${result.confidence}). Pay $0.05 to see values.`,
  };
}

// ── Routes ─────────────────────────────────────────────────────────────

export const contentRoutes: Route[] = [
  // ── POST /x402/seo-article — $0.10 ───────────────────────────────
  {
    type: "POST",
    path: "/x402/seo-article",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.10",
        description: "Multi-agent SEO article generation",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const topic = requireString(body, "topic", 500);
      if (!topic) {
        res.status(400).json({ error: "Missing required field: topic (non-empty string, max 500 chars)" });
        return;
      }

      const keywords = optionalStringArray(body, "keywords", 10);
      const wordCount =
        typeof body.wordCount === "number"
          ? Math.max(500, Math.min(body.wordCount, 5000))
          : 1500;
      const tone: Tone =
        typeof body.tone === "string" && (VALID_TONES as readonly string[]).includes(body.tone)
          ? (body.tone as Tone)
          : "professional";

      const swarmsService = getSwarmsService(runtime);
      if (!swarmsService) {
        res.status(503).json({ error: "Swarms service unavailable" });
        return;
      }

      try {
        const keywordInstruction = keywords
          ? `\nPrimary keywords to target: ${keywords.join(", ")}`
          : "";

        const result = await swarmsService.runSwarm({
          name: `seo-article-${Date.now()}`,
          description: `SEO article about: ${topic.slice(0, 100)}`,
          agents: [
            {
              agent_name: "SEOResearcher",
              model_name: "gpt-5-mini",
              system_prompt:
                "You are an SEO research specialist. Given a topic and optional keywords, create a detailed article outline. " +
                "Output ONLY valid JSON with this structure: " +
                '{ "title": "string", "metaDescription": "string (max 160 chars)", "primaryKeyword": "string", ' +
                '"secondaryKeywords": ["string"], "outline": [{ "heading": "string", "subpoints": ["string"], "targetWordCount": number }] }. ' +
                "No extra text outside the JSON.",
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.4,
              role: "worker",
            },
            {
              agent_name: "ContentWriter",
              model_name: "gpt-5-mini",
              system_prompt:
                `You are an expert content writer. Given an SEO outline (from the previous agent), write a full article in markdown. ` +
                `Target approximately ${wordCount} words. Use a ${tone} tone. ` +
                "Do NOT include an H1 heading (the title will be added separately). " +
                "Follow the outline sections exactly, using H2/H3 headings. " +
                "Output raw markdown only — no JSON wrapping, no code fences.",
              max_loops: 1,
              max_tokens: 8192,
              temperature: 0.6,
              role: "worker",
            },
            {
              agent_name: "Editor",
              model_name: "gpt-5-mini",
              system_prompt:
                "You are a professional editor. Polish the article from the previous agent. Fix grammar, improve flow, " +
                "ensure keyword density is natural (1-3%). " +
                "Output ONLY valid JSON: " +
                '{ "article": "the polished markdown article", "title": "string", "metaDescription": "string", ' +
                '"wordCount": number, "readabilityScore": number (1-100), ' +
                '"keywordDensity": { "keyword": percentage }, "editsApplied": ["string"] }. ' +
                "No extra text outside the JSON.",
              max_loops: 1,
              max_tokens: 8192,
              temperature: 0.3,
              role: "worker",
            },
          ],
          swarm_type: "SequentialWorkflow",
          task:
            `Write an SEO-optimized article about: ${topic}` +
            keywordInstruction +
            `\nTarget word count: ${wordCount}` +
            `\nTone: ${tone}`,
          max_loops: 1,
        });

        const rawOutput = extractSwarmOutput(result);

        // Try to parse Editor's JSON output
        let article = rawOutput;
        let title = topic;
        let metaDescription = "";
        let finalWordCount = rawOutput.split(/\s+/).filter(Boolean).length;
        let readabilityScore: number | null = null;
        let keywordDensity: Record<string, number> | null = null;
        let editsApplied: string[] = [];

        const parsed = tryParseJson(rawOutput);
        if (parsed) {
          if (typeof parsed.article === "string") article = parsed.article;
          if (typeof parsed.title === "string") title = parsed.title;
          if (typeof parsed.metaDescription === "string") metaDescription = parsed.metaDescription;
          if (typeof parsed.wordCount === "number") finalWordCount = parsed.wordCount;
          if (typeof parsed.readabilityScore === "number") readabilityScore = parsed.readabilityScore;
          if (parsed.keywordDensity && typeof parsed.keywordDensity === "object") {
            keywordDensity = parsed.keywordDensity as Record<string, number>;
          }
          if (Array.isArray(parsed.editsApplied)) {
            editsApplied = parsed.editsApplied.filter((e): e is string => typeof e === "string");
          }
        }

        const seoResult = {
          article,
          title,
          metaDescription,
          wordCount: finalWordCount,
          readabilityScore,
          keywordDensity,
          editsApplied,
        };

        const truncated = truncateSeoArticleForFreeTier(seoResult, gate);

        res.json({
          ...truncated,
          topic,
          tone,
          freeRemaining: gate.freeRemaining,
          payment: {
            amount: "0.10",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/seo-article] Swarm execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },

  // ── POST /x402/document-extract — $0.05 ──────────────────────────
  {
    type: "POST",
    path: "/x402/document-extract",
    handler: async (req, res, runtime) => {
      const gate = await x402Gate(runtime, req, res, {
        amountUsd: "0.05",
        description: "AI document data extraction",
      });
      if (!gate.paid) return;

      const body = (req as any).body ?? {};
      const text = requireString(body, "text", 100_000);
      if (!text) {
        res.status(400).json({ error: "Missing required field: text (non-empty string, max 100,000 chars)" });
        return;
      }

      const fields = optionalStringArray(body, "fields", 50);
      const format: ExtractFormat =
        typeof body.format === "string" && (VALID_FORMATS as readonly string[]).includes(body.format)
          ? (body.format as ExtractFormat)
          : "json";

      const formatInstruction =
        format === "table"
          ? 'If format=table, use { "extracted": { "headers": [...], "rows": [[...]] }, "confidence": 0.0-1.0, "fieldsFound": number, "fieldsRequested": number_or_"auto", "notes": ["strings"] }.'
          : '{ "extracted": { "field": "value_or_null" }, "confidence": 0.0-1.0, "fieldsFound": number, "fieldsRequested": number_or_"auto", "notes": ["strings"] }.';

      const systemPrompt =
        "You are a document data extraction specialist. Extract ONLY information explicitly present in the text. " +
        `Output JSON: ${formatInstruction} ` +
        "Do NOT hallucinate data. Output ONLY JSON.";

      const fieldInstruction = fields
        ? `Extract these specific fields: [${fields.join(", ")}]`
        : "Auto-detect and extract all relevant fields from the text";
      const userPrompt = `${fieldInstruction}\n\nFormat: ${format}\n\nText:\n${text}`;

      try {
        let raw: string;
        const openaiKey = String(runtime.getSetting("OPENAI_API_KEY") ?? "");

        if (openaiKey) {
          raw = await callOpenAI({
            apiKey: openaiKey,
            model: "gpt-5-mini",
            systemPrompt,
            userPrompt,
            maxTokens: 4096,
            temperature: 0.1,
          });
        } else {
          const swarmsService = getSwarmsService(runtime);
          if (!swarmsService) {
            res.status(503).json({ error: "Neither OPENAI_API_KEY nor Swarms service available" });
            return;
          }
          const result = await swarmsService.runAgent(
            {
              agent_name: "document-extractor",
              model_name: "gpt-5-mini",
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

        // Parse extraction result
        let extracted: Record<string, unknown> = {};
        let confidence = 0.5;
        let fieldsFound = 0;
        let fieldsRequested: number | string = fields ? fields.length : "auto";
        let notes: string[] = [];

        const parsed = tryParseJson(raw);
        if (parsed) {
          if (parsed.extracted && typeof parsed.extracted === "object") {
            extracted = parsed.extracted as Record<string, unknown>;
          }
          if (typeof parsed.confidence === "number") confidence = parsed.confidence;
          if (typeof parsed.fieldsFound === "number") fieldsFound = parsed.fieldsFound;
          if (parsed.fieldsRequested !== undefined) fieldsRequested = parsed.fieldsRequested as number | string;
          if (Array.isArray(parsed.notes)) {
            notes = parsed.notes.filter((n): n is string => typeof n === "string");
          }
        } else {
          // Fallback: couldn't parse JSON
          extracted = { raw };
          fieldsFound = 1;
        }

        const extractResult = {
          extracted,
          confidence,
          fieldsFound,
          fieldsRequested,
          notes,
        };

        const truncated = truncateDocumentExtractForFreeTier(extractResult, gate);

        res.json({
          ...truncated,
          format,
          freeRemaining: gate.freeRemaining,
          payment: {
            amount: "0.05",
            transaction: gate.transaction,
            network: gate.network,
          },
        });
      } catch (err) {
        runtime.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "[x402/document-extract] Agent execution failed"
        );
        res.status(500).json({ error: "Service temporarily unavailable" });
      }
    },
  },
];
