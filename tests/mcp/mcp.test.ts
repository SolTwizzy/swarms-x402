import { describe, it, expect } from "vitest";
import {
  getMcpToolDefinitions,
  getMcpTool,
  listMcpTools,
  listMcpCategories,
  validateMcpToolParams,
  executeMcpTool,
  type McpManifest,
  type McpToolDefinition,
} from "../../src/mcp/index.js";

// ── Manifest structure ────────────────────────────────────────────────────

describe("MCP Manifest", () => {
  let manifest: McpManifest;

  it("returns a valid manifest object", () => {
    manifest = getMcpToolDefinitions();
    expect(manifest.name).toBe("swarmx");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBeTruthy();
    expect(Array.isArray(manifest.tools)).toBe(true);
    expect(manifest.tools.length).toBeGreaterThan(0);
  });

  it("has at least 30 tools", () => {
    manifest = getMcpToolDefinitions();
    expect(manifest.tools.length).toBeGreaterThanOrEqual(30);
  });

  it("is JSON-serializable", () => {
    manifest = getMcpToolDefinitions();
    const json = JSON.stringify(manifest);
    const parsed = JSON.parse(json) as McpManifest;
    expect(parsed.name).toBe("swarmx");
    expect(parsed.tools.length).toBe(manifest.tools.length);
  });
});

// ── Tool definitions ──────────────────────────────────────────────────────

describe("MCP Tool Definitions", () => {
  const manifest = getMcpToolDefinitions();

  it("every tool has required fields", () => {
    for (const tool of manifest.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeTruthy();
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
      expect(tool.metadata).toBeTruthy();
      expect(tool.metadata.endpoint).toBeTruthy();
      expect(["GET", "POST"]).toContain(tool.metadata.method);
      expect(tool.metadata.priceUsd).toBeTruthy();
      expect(tool.metadata.category).toBeTruthy();
      expect(typeof tool.metadata.free).toBe("boolean");
    }
  });

  it("all tool names follow the swarmx_ prefix convention", () => {
    for (const tool of manifest.tools) {
      expect(tool.name).toMatch(/^swarmx_/);
    }
  });

  it("all tool names are unique", () => {
    const names = manifest.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all endpoint paths start with /x402/", () => {
    for (const tool of manifest.tools) {
      expect(tool.metadata.endpoint).toMatch(/^\/x402\//);
    }
  });

  it("all paid tools have price > 0", () => {
    const paid = manifest.tools.filter((t) => !t.metadata.free);
    for (const tool of paid) {
      if (tool.metadata.priceUsd === "varies") continue; // batch
      expect(parseFloat(tool.metadata.priceUsd)).toBeGreaterThan(0);
    }
  });

  it("free tools have price 0.00", () => {
    const free = manifest.tools.filter((t) => t.metadata.free);
    for (const tool of free) {
      expect(tool.metadata.priceUsd).toBe("0.00");
    }
  });

  it("required fields are listed in properties", () => {
    for (const tool of manifest.tools) {
      for (const req of tool.inputSchema.required) {
        expect(tool.inputSchema.properties[req]).toBeTruthy();
      }
    }
  });

  it("all properties have a description", () => {
    for (const tool of manifest.tools) {
      for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
        expect(prop.description).toBeTruthy();
      }
    }
  });

  it("every tool description includes the price", () => {
    for (const tool of manifest.tools) {
      if (tool.metadata.free) {
        expect(tool.description.toLowerCase()).toMatch(/free/);
      } else if (tool.metadata.priceUsd !== "varies") {
        expect(tool.description).toContain("$");
      }
    }
  });
});

// ── Tool name convention ─────────────────────────────────────────────────

describe("Tool naming convention", () => {
  it("uses underscores, not hyphens", () => {
    const tools = listMcpTools();
    for (const name of tools) {
      expect(name).not.toContain("-");
    }
  });

  it("all lowercase except prefix", () => {
    const tools = listMcpTools();
    for (const name of tools) {
      expect(name).toBe(name.toLowerCase());
    }
  });
});

// ── Lookup functions ─────────────────────────────────────────────────────

describe("getMcpTool", () => {
  it("returns tool by name", () => {
    const tool = getMcpTool("swarmx_research");
    expect(tool).toBeTruthy();
    expect(tool!.name).toBe("swarmx_research");
    expect(tool!.metadata.endpoint).toBe("/x402/research");
  });

  it("returns undefined for unknown tool", () => {
    expect(getMcpTool("swarmx_nonexistent")).toBeUndefined();
  });
});

describe("listMcpTools", () => {
  it("lists all tools", () => {
    const tools = listMcpTools();
    expect(tools.length).toBeGreaterThanOrEqual(30);
  });

  it("filters by category", () => {
    const crypto = listMcpTools("crypto");
    expect(crypto.length).toBeGreaterThan(0);
    for (const name of crypto) {
      const tool = getMcpTool(name);
      expect(tool!.metadata.category).toBe("crypto");
    }
  });

  it("returns empty array for unknown category", () => {
    expect(listMcpTools("nonexistent")).toHaveLength(0);
  });
});

describe("listMcpCategories", () => {
  it("returns all categories", () => {
    const cats = listMcpCategories();
    expect(cats).toContain("crypto");
    expect(cats).toContain("content");
    expect(cats).toContain("code");
    expect(cats).toContain("research");
    expect(cats).toContain("defi");
    expect(cats).toContain("trading");
    expect(cats).toContain("enterprise");
    expect(cats).toContain("batch");
    expect(cats).toContain("meta");
  });
});

// ── Validation ───────────────────────────────────────────────────────────

describe("validateMcpToolParams", () => {
  it("passes for valid params", () => {
    const errors = validateMcpToolParams("swarmx_research", { query: "test" });
    expect(errors).toHaveLength(0);
  });

  it("catches missing required field", () => {
    const errors = validateMcpToolParams("swarmx_research", {});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("query");
  });

  it("catches wrong type", () => {
    const errors = validateMcpToolParams("swarmx_research", { query: 42 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("string");
  });

  it("catches invalid enum value", () => {
    const errors = validateMcpToolParams("swarmx_research", {
      query: "test",
      depth: "ultra",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("depth");
  });

  it("passes with valid enum value", () => {
    const errors = validateMcpToolParams("swarmx_research", {
      query: "test",
      depth: "deep",
    });
    expect(errors).toHaveLength(0);
  });

  it("catches out-of-range number", () => {
    const errors = validateMcpToolParams("swarmx_summarize", {
      text: "hello",
      maxLength: 999999,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("maxLength");
  });

  it("returns error for unknown tool", () => {
    const errors = validateMcpToolParams("swarmx_fake", {});
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Unknown tool");
  });

  it("validates contract audit params", () => {
    expect(
      validateMcpToolParams("swarmx_contract_audit", { code: "pragma solidity ^0.8.0;" })
    ).toHaveLength(0);

    expect(
      validateMcpToolParams("swarmx_contract_audit", {})
    ).toHaveLength(1);

    expect(
      validateMcpToolParams("swarmx_contract_audit", { code: "test", language: "python" })
    ).toHaveLength(1); // python not in enum
  });

  it("validates translate params", () => {
    expect(
      validateMcpToolParams("swarmx_translate", { text: "hello", targetLanguage: "Spanish" })
    ).toHaveLength(0);

    const errors = validateMcpToolParams("swarmx_translate", { text: "hello" });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("targetLanguage");
  });

  it("validates extract params", () => {
    expect(
      validateMcpToolParams("swarmx_extract", { text: "hello", fields: ["name"] })
    ).toHaveLength(0);

    const errors = validateMcpToolParams("swarmx_extract", { text: "hello" });
    expect(errors.length).toBe(1);
  });

  it("allows extra fields", () => {
    const errors = validateMcpToolParams("swarmx_sentiment", {
      text: "happy",
      extra: "ignored",
    });
    expect(errors).toHaveLength(0);
  });
});

// ── Tool execution ───────────────────────────────────────────────────────

describe("executeMcpTool", () => {
  it("returns error for unknown tool", async () => {
    const result = await executeMcpTool("swarmx_fake", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
    expect(result.tool).toBe("swarmx_fake");
  });

  it("returns correct tool/endpoint metadata", async () => {
    // Use a nonexistent base URL so it fails fast with a network error
    const result = await executeMcpTool(
      "swarmx_catalog",
      {},
      { baseUrl: "http://localhost:1", timeoutMs: 500 }
    );
    // We expect network failure, but metadata should be correct
    expect(result.tool).toBe("swarmx_catalog");
    expect(result.endpoint).toBe("/x402/catalog");
  });
});

// ── Schema completeness: spot-check specific tools ───────────────────────

describe("Schema completeness", () => {
  it("swarmx_batch has tasks array property", () => {
    const tool = getMcpTool("swarmx_batch")!;
    expect(tool.inputSchema.properties.tasks).toBeTruthy();
    expect(tool.inputSchema.properties.tasks.type).toBe("array");
    expect(tool.inputSchema.required).toContain("tasks");
  });

  it("swarmx_seo_article has all optional fields", () => {
    const tool = getMcpTool("swarmx_seo_article")!;
    expect(tool.inputSchema.properties.topic).toBeTruthy();
    expect(tool.inputSchema.properties.keywords).toBeTruthy();
    expect(tool.inputSchema.properties.wordCount).toBeTruthy();
    expect(tool.inputSchema.properties.tone).toBeTruthy();
    expect(tool.inputSchema.required).toEqual(["topic"]);
  });

  it("swarmx_yield_optimizer has no required fields", () => {
    const tool = getMcpTool("swarmx_yield_optimizer")!;
    expect(tool.inputSchema.required).toHaveLength(0);
  });

  it("swarmx_agent has task as required", () => {
    const tool = getMcpTool("swarmx_agent")!;
    expect(tool.inputSchema.required).toEqual(["task"]);
    expect(tool.inputSchema.properties.model).toBeTruthy();
    expect(tool.inputSchema.properties.systemPrompt).toBeTruthy();
  });

  it("swarmx_token_accounts has address required + optional mint", () => {
    const tool = getMcpTool("swarmx_token_accounts")!;
    expect(tool.inputSchema.required).toEqual(["address"]);
    expect(tool.inputSchema.properties.mint).toBeTruthy();
  });

  it("swarmx_compliance_check has all expected properties", () => {
    const tool = getMcpTool("swarmx_compliance_check")!;
    expect(tool.inputSchema.required).toEqual(["document"]);
    expect(tool.inputSchema.properties.framework).toBeTruthy();
    expect(tool.inputSchema.properties.framework.enum).toBeTruthy();
    expect(tool.inputSchema.properties.jurisdiction).toBeTruthy();
    expect(tool.inputSchema.properties.industry).toBeTruthy();
  });

  it("swarmx_slot_info and swarmx_recent_blockhash have no required params", () => {
    const slot = getMcpTool("swarmx_slot_info")!;
    const bh = getMcpTool("swarmx_recent_blockhash")!;
    expect(slot.inputSchema.required).toHaveLength(0);
    expect(bh.inputSchema.required).toHaveLength(0);
  });
});

// ── Manifest JSON file validation ────────────────────────────────────────

describe("Static manifest JSON", () => {
  it("mcp-manifest.json matches runtime definitions", async () => {
    // Import the static file
    const fs = await import("node:fs");
    const path = await import("node:path");
    const manifestPath = path.resolve(
      import.meta.dirname ?? ".",
      "../../mcp-manifest.json"
    );
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const staticManifest = JSON.parse(raw) as McpManifest;
    const runtimeManifest = getMcpToolDefinitions();

    expect(staticManifest.name).toBe(runtimeManifest.name);
    expect(staticManifest.version).toBe(runtimeManifest.version);
    expect(staticManifest.tools.length).toBe(runtimeManifest.tools.length);

    // Verify every runtime tool exists in the static file
    const staticNames = new Set(staticManifest.tools.map((t) => t.name));
    for (const tool of runtimeManifest.tools) {
      expect(staticNames.has(tool.name)).toBe(true);
    }
  });
});
