/**
 * SwarmX MCP server — JSON-RPC 2.0 message handler (Streamable HTTP transport).
 *
 * Pure, transport-agnostic: `handleMcpMessage()` takes a parsed JSON-RPC
 * message and returns the response object (or `null` for notifications).
 * The HTTP wiring lives in `server.ts` (`/mcp` route).
 *
 * Implements the minimal MCP surface: `initialize`, `tools/list`,
 * `tools/call`, `ping`, and the `notifications/*` no-reply messages.
 *
 * Paid tools are NOT executed without payment — they return an honest
 * `payment_required` descriptor (never a fabricated result). Callers may
 * pass a base64 `X-PAYMENT` value as `arguments._payment` to actually
 * execute a paid tool via x402.
 *
 * @module
 */

import {
  getMcpToolDefinitions,
  getMcpTool,
  executeMcpTool,
  type McpExecuteOptions,
  type McpToolResult,
} from "./index.js";

/** MCP protocol version we implement (echoes the client's if provided). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const MANIFEST = getMcpToolDefinitions();
const SERVER_INFO = { name: MANIFEST.name, version: MANIFEST.version };

/** Minimal JSON-RPC 2.0 request/notification shape. */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown> & { name?: unknown; arguments?: unknown; protocolVersion?: unknown };
}

/** JSON-RPC 2.0 response envelope. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Function that executes a tool against the live SwarmX API. */
export type ToolExecutor = (
  toolName: string,
  params: Record<string, unknown>,
  options?: McpExecuteOptions
) => Promise<McpToolResult>;

/** Options for the MCP message handler. */
export interface McpServerOptions {
  /** Base URL used to execute FREE tools against live routes (e.g. http://127.0.0.1:3000). */
  baseUrl: string;
  /** Public base URL advertised in payment-required descriptors (e.g. https://swarmx.io). */
  publicBaseUrl?: string;
  /** Injectable executor (defaults to executeMcpTool) — for testing. */
  executor?: ToolExecutor;
}

function ok(id: string | number | null | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function textContent(obj: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(obj, null, 2) };
}

/**
 * Handle a single parsed JSON-RPC message.
 * Returns the response object, or `null` when the message is a notification
 * (no reply is sent for notifications).
 */
export async function handleMcpMessage(
  msg: JsonRpcMessage,
  opts: McpServerOptions
): Promise<JsonRpcResponse | null> {
  // Envelope validation.
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id ?? null, -32600, "Invalid Request");
  }

  const { method, id } = msg;
  const isNotification = id === undefined || method.startsWith("notifications/");

  switch (method) {
    case "initialize": {
      const clientProtocol = msg.params?.protocolVersion;
      return ok(id, {
        protocolVersion: typeof clientProtocol === "string" ? clientProtocol : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "SwarmX MCP server. Free tools execute directly. Paid tools require x402 payment: call the endpoint with an X-PAYMENT header (gasless USDG on Robinhood Chain eip155:4663, or USDC on Solana), or pass the base64 X-PAYMENT as arguments._payment.",
      });
    }

    case "ping":
      return ok(id, {});

    case "tools/list": {
      const tools = MANIFEST.tools.map((t) => ({
        name: t.name,
        description: t.metadata.free
          ? t.description
          : `${t.description} [PAID: $${t.metadata.priceUsd}/call via x402]`,
        inputSchema: t.inputSchema,
      }));
      return ok(id, { tools });
    }

    case "tools/call": {
      const name = msg.params?.name;
      if (typeof name !== "string") {
        return rpcError(id, -32602, "Invalid params: 'name' (string) is required");
      }
      const rawArgs = msg.params?.arguments;
      const args: Record<string, unknown> =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? { ...(rawArgs as Record<string, unknown>) }
          : {};

      const tool = getMcpTool(name);
      if (!tool) {
        return ok(id, {
          isError: true,
          content: [textContent({ error: `Unknown tool: ${name}` })],
        });
      }

      const publicBase = (opts.publicBaseUrl ?? opts.baseUrl).replace(/\/$/, "");
      const paymentHeader = typeof args._payment === "string" ? (args._payment as string) : undefined;

      // Paid tool with no payment → honest payment-required descriptor (never fabricate).
      if (!tool.metadata.free && !paymentHeader) {
        return ok(id, {
          isError: false,
          content: [
            textContent({
              payment_required: true,
              price_usd: tool.metadata.priceUsd,
              endpoint: `${publicBase}${tool.metadata.endpoint}`,
              method: tool.metadata.method,
              protocol: "x402",
              note:
                "Paid tool. Send an X-PAYMENT header per the x402 protocol to call it (gasless USDG on Robinhood Chain eip155:4663, or USDC on Solana). To execute via MCP, pass the base64 X-PAYMENT string as arguments._payment.",
            }),
          ],
        });
      }

      // Free tool, or paid tool with payment → execute against the live route.
      delete args._payment;
      const exec = opts.executor ?? executeMcpTool;
      const execOptions: McpExecuteOptions = { baseUrl: opts.baseUrl };
      if (paymentHeader) execOptions.headers = { "X-PAYMENT": paymentHeader };

      const result = await exec(name, args, execOptions);
      return ok(id, {
        isError: !result.success,
        content: [
          textContent(
            result.success
              ? result.data
              : { error: result.error, httpStatus: result.httpStatus, data: result.data }
          ),
        ],
      });
    }

    default:
      if (isNotification) return null; // ignore unknown/known notifications
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * GET descriptor for `/mcp` (so a browser GET returns useful metadata, not 404).
 */
export function mcpDescriptor(publicBaseUrl: string): Record<string, unknown> {
  return {
    name: MANIFEST.name,
    version: MANIFEST.version,
    description: MANIFEST.description,
    protocol: "mcp",
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: "streamable-http",
    endpoint: `${publicBaseUrl.replace(/\/$/, "")}/mcp`,
    methods: ["initialize", "tools/list", "tools/call", "ping"],
    tools: MANIFEST.tools.length,
  };
}
