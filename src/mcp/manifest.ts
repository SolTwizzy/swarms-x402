/**
 * Static MCP manifest generator.
 *
 * Run with: bun run src/mcp/manifest.ts
 *
 * Reads the tool definitions from ./index.ts and writes
 * mcp-manifest.json to the project root.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getMcpToolDefinitions } from "./index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const manifest = getMcpToolDefinitions();
const outPath = resolve(__dirname, "../../mcp-manifest.json");

writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

const toolCount = manifest.tools.length;
const paid = manifest.tools.filter((t) => !t.metadata.free).length;
const free = manifest.tools.filter((t) => t.metadata.free).length;
const categories = [...new Set(manifest.tools.map((t) => t.metadata.category))];

console.log(`MCP manifest written to ${outPath}`);
console.log(`  Tools: ${toolCount} (${paid} paid, ${free} free)`);
console.log(`  Categories: ${categories.join(", ")}`);
