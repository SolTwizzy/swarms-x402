/**
 * File System Plugin
 *
 * Provides tools for reading/writing local files and listing directories.
 * Restricts access to an allowed-paths list for safety.
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import type { Plugin, ToolDefinition, ToolResult } from "../types";

interface FileSystemConfig {
  /** Directories the agent is allowed to access. Paths outside these are blocked. */
  allowedPaths: string[];
}

function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  const resolved = resolve(filePath);
  return allowedPaths.some((ap) => resolved.startsWith(resolve(ap)));
}

export function fileSystemPlugin(config: FileSystemConfig): Plugin {
  const tools: ToolDefinition[] = [
    {
      name: "read_file",
      description: "Read the contents of a file. Returns the file text.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          maxLines: { type: "number", description: "Max lines to read (default: all)" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write content to a file. Creates parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "list_directory",
      description: "List files and subdirectories in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
        },
        required: ["path"],
      },
    },
    {
      name: "search_files",
      description: "Search for files matching a pattern in a directory (simple glob: *.ts, *.md, etc).",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Directory to search in" },
          pattern: { type: "string", description: "File name pattern (e.g. '*.ts', '*.md')" },
        },
        required: ["directory", "pattern"],
      },
    },
  ];

  function matchPattern(name: string, pattern: string): boolean {
    // Simple glob: *.ext or exact match
    if (pattern.startsWith("*")) {
      return name.endsWith(pattern.slice(1));
    }
    return name === pattern;
  }

  function searchDir(dir: string, pattern: string, results: string[], maxDepth: number): void {
    if (maxDepth <= 0) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          searchDir(fullPath, pattern, results, maxDepth - 1);
        } else if (entry.isFile() && matchPattern(entry.name, pattern)) {
          results.push(fullPath);
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  return {
    name: "file-system",
    description: "Read/write local files within allowed directories",

    getTools: () => tools,

    async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
      if (toolName === "read_file") {
        const filePath = String(args.path);
        if (!isPathAllowed(filePath, config.allowedPaths)) {
          return { success: false, error: `Access denied: ${filePath} is outside allowed paths` };
        }
        if (!existsSync(filePath)) {
          return { success: false, error: `File not found: ${filePath}` };
        }
        try {
          let content = readFileSync(filePath, "utf-8");
          const maxLines = args.maxLines as number | undefined;
          if (maxLines && maxLines > 0) {
            content = content.split("\n").slice(0, maxLines).join("\n");
          }
          return { success: true, data: { path: filePath, content, size: statSync(filePath).size } };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      }

      if (toolName === "write_file") {
        const filePath = String(args.path);
        const content = String(args.content);
        if (!isPathAllowed(filePath, config.allowedPaths)) {
          return { success: false, error: `Access denied: ${filePath} is outside allowed paths` };
        }
        try {
          const dir = dirname(filePath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(filePath, content, "utf-8");
          return { success: true, data: { path: filePath, bytesWritten: content.length } };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      }

      if (toolName === "list_directory") {
        const dirPath = String(args.path);
        if (!isPathAllowed(dirPath, config.allowedPaths)) {
          return { success: false, error: `Access denied: ${dirPath} is outside allowed paths` };
        }
        if (!existsSync(dirPath)) {
          return { success: false, error: `Directory not found: ${dirPath}` };
        }
        try {
          const entries = readdirSync(dirPath, { withFileTypes: true });
          const items = entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
          }));
          return { success: true, data: { path: dirPath, entries: items } };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      }

      if (toolName === "search_files") {
        const dir = String(args.directory);
        const pattern = String(args.pattern);
        if (!isPathAllowed(dir, config.allowedPaths)) {
          return { success: false, error: `Access denied: ${dir} is outside allowed paths` };
        }
        const results: string[] = [];
        searchDir(dir, pattern, results, 5);
        return { success: true, data: { pattern, directory: dir, matches: results.slice(0, 50) } };
      }

      return undefined; // Not our tool
    },
  };
}
