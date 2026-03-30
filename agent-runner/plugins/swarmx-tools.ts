/**
 * SwarmX Tools Plugin
 *
 * Loads all SwarmX endpoints from mcp-manifest.json or /x402/catalog
 * and exposes them as callable tools. Each tool maps to an HTTP call
 * to the SwarmX platform.
 *
 * @module
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { Plugin, ToolDefinition, ToolResult } from "../types";

interface ManifestTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: { type: string };
      minimum?: number;
      maximum?: number;
    }>;
    required: string[];
  };
  metadata: {
    endpoint: string;
    method: string;
    priceUsd: string;
    category: string;
    free: boolean;
  };
}

interface Manifest {
  tools: ManifestTool[];
}

interface SwarmXToolsConfig {
  /** Base URL of the SwarmX platform. */
  baseUrl: string;
  /** Path to mcp-manifest.json (falls back to fetching /x402/catalog). */
  manifestPath?: string;
  /** Wallet private key for x402 payments (optional — unpaid calls get 402). */
  walletKey?: string;
  /** Request timeout in ms. Default: 120000 */
  timeoutMs?: number;
}

/** Cached tool definitions + metadata */
interface LoadedTool {
  definition: ToolDefinition;
  endpoint: string;
  method: string;
  priceUsd: string;
  free: boolean;
}

function loadToolsFromManifest(manifestPath: string): LoadedTool[] {
  const raw = readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(raw) as Manifest;
  return manifest.tools.map((t) => ({
    definition: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object" as const,
        properties: t.inputSchema.properties,
        required: t.inputSchema.required,
      },
    },
    endpoint: t.metadata.endpoint,
    method: t.metadata.method,
    priceUsd: t.metadata.priceUsd,
    free: t.metadata.free,
  }));
}

async function loadToolsFromCatalog(baseUrl: string): Promise<LoadedTool[]> {
  const res = await fetch(`${baseUrl}/x402/catalog`);
  if (!res.ok) throw new Error(`Failed to fetch catalog: ${res.status}`);

  const catalog = (await res.json()) as Array<{
    name: string;
    description: string;
    path: string;
    method: string;
    priceUsd: string;
    free?: boolean;
  }>;

  return catalog.map((entry) => ({
    definition: {
      name: entry.name.replace(/[^a-zA-Z0-9_]/g, "_"),
      description: `${entry.description} ($${entry.priceUsd}/call)`,
      parameters: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    endpoint: entry.path,
    method: entry.method,
    priceUsd: entry.priceUsd,
    free: entry.free ?? false,
  }));
}

export function swarmxToolsPlugin(config: SwarmXToolsConfig): Plugin {
  let tools: LoadedTool[] = [];
  let loaded = false;

  const ensureLoaded = async () => {
    if (loaded) return;

    // Try manifest first
    const manifestPath = config.manifestPath ?? join(process.cwd(), "mcp-manifest.json");
    if (existsSync(manifestPath)) {
      try {
        tools = loadToolsFromManifest(manifestPath);
        loaded = true;
        return;
      } catch (err) {
        console.warn(`[swarmx-tools] Failed to load manifest: ${err}`);
      }
    }

    // Fallback to catalog API
    try {
      tools = await loadToolsFromCatalog(config.baseUrl);
      loaded = true;
    } catch (err) {
      console.error(`[swarmx-tools] Failed to load from catalog: ${err}`);
      tools = [];
      loaded = true;
    }
  };

  // Eagerly load on creation
  const manifestPath = config.manifestPath ?? join(process.cwd(), "mcp-manifest.json");
  if (existsSync(manifestPath)) {
    try {
      tools = loadToolsFromManifest(manifestPath);
      loaded = true;
    } catch {
      // will try catalog at runtime
    }
  }

  const toolMap = new Map<string, LoadedTool>();

  return {
    name: "swarmx-tools",
    description: "SwarmX platform endpoints as callable tools",

    getTools(): ToolDefinition[] {
      // Rebuild map
      toolMap.clear();
      for (const t of tools) {
        toolMap.set(t.definition.name, t);
      }
      return tools.map((t) => t.definition);
    },

    async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
      await ensureLoaded();

      const tool = toolMap.get(toolName);
      if (!tool) return undefined; // Not our tool

      const url = `${config.baseUrl.replace(/\/$/, "")}${tool.endpoint}`;
      const timeoutMs = config.timeoutMs ?? 120_000;

      try {
        const fetchOptions: RequestInit = {
          method: tool.method,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(timeoutMs),
        };

        if (tool.method === "POST") {
          fetchOptions.body = JSON.stringify(args);
        }

        const res = await fetch(url, fetchOptions);

        // Handle 402 — payment required
        if (res.status === 402) {
          return {
            success: false,
            error: `Payment required ($${tool.priceUsd}). Set SOLANA_PRIVATE_KEY or EVM_PRIVATE_KEY for automatic x402 payments.`,
          };
        }

        const data: unknown = await res.json();

        if (!res.ok) {
          const errMsg =
            typeof data === "object" && data !== null && "error" in data
              ? String((data as Record<string, unknown>).error)
              : `HTTP ${res.status}`;
          return { success: false, error: errMsg, data };
        }

        return { success: true, data };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    beforeTool(toolName: string, args: Record<string, unknown>): Record<string, unknown> | null {
      const tool = toolMap.get(toolName);
      if (tool && !tool.free) {
        console.log(`  [swarmx] Calling ${toolName} ($${tool.priceUsd}) → ${tool.endpoint}`);
      }
      return args;
    },
  };
}
