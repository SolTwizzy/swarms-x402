/**
 * Web Search Plugin
 *
 * Provides a web_search tool using either:
 * - Gemini grounding (free with Gemini API key)
 * - SerpAPI (requires SERPAPI_KEY)
 * - Fallback: DuckDuckGo HTML scraping (no key needed)
 *
 * @module
 */

import type { Plugin, ToolDefinition, ToolResult } from "../types";

const tools: ToolDefinition[] = [
  {
    name: "web_search",
    description:
      "Search the web for current information. Returns relevant results with titles, URLs, and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        maxResults: { type: "number", description: "Max results to return (default: 5)" },
      },
      required: ["query"],
    },
  },
];

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchWithSerpAPI(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return [];

  const params = new URLSearchParams({
    q: query,
    api_key: apiKey,
    engine: "google",
    num: String(maxResults),
  });

  const res = await fetch(`https://serpapi.com/search?${params}`);
  if (!res.ok) return [];

  const data = (await res.json()) as {
    organic_results?: Array<{
      title: string;
      link: string;
      snippet?: string;
    }>;
  };

  return (data.organic_results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet ?? "",
  }));
}

async function searchWithGemini(query: string, maxResults: number): Promise<SearchResult[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  const model = "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Search the web for: "${query}". Return the top ${maxResults} results as a JSON array of objects with fields: title, url, snippet. Output only valid JSON, no markdown.`,
            },
          ],
        },
      ],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0 },
    }),
  });

  if (!res.ok) return [];

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: {
        webSearchQueries?: string[];
        searchEntryPoint?: { renderedContent?: string };
        groundingChunks?: Array<{
          web?: { uri: string; title: string };
        }>;
      };
    }>;
  };

  // Extract from grounding chunks if available
  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (chunks && chunks.length > 0) {
    return chunks.slice(0, maxResults).map((c) => ({
      title: c.web?.title ?? "",
      url: c.web?.uri ?? "",
      snippet: "",
    }));
  }

  // Try to parse text response as JSON
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const results = JSON.parse(jsonMatch[0]) as SearchResult[];
      return results.slice(0, maxResults);
    }
  } catch {
    // Not parseable
  }

  return [];
}

async function searchWithDDG(query: string, maxResults: number): Promise<SearchResult[]> {
  // DuckDuckGo instant answer API (limited but no key needed)
  const params = new URLSearchParams({ q: query, format: "json", no_html: "1" });
  const res = await fetch(`https://api.duckduckgo.com/?${params}`);
  if (!res.ok) return [];

  const data = (await res.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: Array<{
      Text?: string;
      FirstURL?: string;
    }>;
  };

  const results: SearchResult[] = [];

  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.Heading ?? query,
      url: data.AbstractURL,
      snippet: data.AbstractText,
    });
  }

  for (const topic of data.RelatedTopics ?? []) {
    if (results.length >= maxResults) break;
    if (topic.Text && topic.FirstURL) {
      results.push({
        title: topic.Text.slice(0, 80),
        url: topic.FirstURL,
        snippet: topic.Text,
      });
    }
  }

  return results;
}

export function webSearchPlugin(): Plugin {
  return {
    name: "web-search",
    description: "Web search via SerpAPI, Gemini grounding, or DuckDuckGo",

    getTools: () => tools,

    async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
      if (toolName !== "web_search") return undefined;

      const query = String(args.query ?? "");
      const maxResults = (args.maxResults as number) ?? 5;

      if (!query) {
        return { success: false, error: "Query is required" };
      }

      console.log(`  [web-search] Searching: "${query}"`);

      // Try providers in order of quality
      let results: SearchResult[] = [];

      if (process.env.SERPAPI_KEY) {
        results = await searchWithSerpAPI(query, maxResults);
        if (results.length > 0) {
          return { success: true, data: { query, provider: "serpapi", results } };
        }
      }

      if (process.env.GEMINI_API_KEY) {
        results = await searchWithGemini(query, maxResults);
        if (results.length > 0) {
          return { success: true, data: { query, provider: "gemini", results } };
        }
      }

      results = await searchWithDDG(query, maxResults);
      if (results.length > 0) {
        return { success: true, data: { query, provider: "duckduckgo", results } };
      }

      return {
        success: true,
        data: {
          query,
          provider: "none",
          results: [],
          note: "No results found. Set SERPAPI_KEY or GEMINI_API_KEY for better search results.",
        },
      };
    },
  };
}
