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
import {
  startLink,
  pollJobs,
  completeJob,
  getSessionByAgentToken,
  sessionSummary,
} from "../server/agentLink.js";

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

// ── Agent Link tools (session plumbing, always free) ─────────────────────────
//
// These pair a running agent with a human's browser on the SwarmX Markets UI
// (Moltbook-style magic link). They are handled in-process — they never touch
// the paid-route executor.

const AGENT_LINK_TOOLS = [
  {
    name: "swarmx_link_start",
    description:
      "Start a SwarmX Agent Link session. Returns a one-time claim_url — give it to your human " +
      "to open in their browser — plus an agent_token you MUST keep to poll and complete jobs. " +
      "After the human clicks pay on swarmx.io, fetch jobs with swarmx_poll_requests, pay the " +
      "endpoint with your own wallet via x402, then report back with swarmx_complete_request.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Display name shown to the human in the UI (e.g. 'hermes').",
        },
      },
    },
  },
  {
    name: "swarmx_link_status",
    description:
      "Check a SwarmX Agent Link session: whether the human has claimed the link and how many jobs are pending.",
    inputSchema: {
      type: "object",
      properties: {
        agent_token: { type: "string", description: "Token from swarmx_link_start." },
      },
      required: ["agent_token"],
    },
  },
  {
    name: "swarmx_poll_requests",
    description:
      "List pending paid jobs the linked human queued from the SwarmX UI. For each job: call the " +
      "endpoint unauthenticated to get the x402 402 challenge, pay it with your wallet (X-PAYMENT " +
      "header), then submit the full JSON result via swarmx_complete_request.",
    inputSchema: {
      type: "object",
      properties: {
        agent_token: { type: "string", description: "Token from swarmx_link_start." },
      },
      required: ["agent_token"],
    },
  },
  {
    name: "swarmx_complete_request",
    description:
      "Report a finished SwarmX Agent Link job. Pass the full JSON body returned by the paid " +
      "endpoint as `result` (it includes the payment receipt), or `error` if payment/execution failed.",
    inputSchema: {
      type: "object",
      properties: {
        agent_token: { type: "string", description: "Token from swarmx_link_start." },
        job_id: { type: "string", description: "Job id from swarmx_poll_requests." },
        result: { description: "Full JSON result from the paid endpoint (object or JSON string)." },
        error: { type: "string", description: "Failure reason, when the job could not be completed." },
      },
      required: ["agent_token", "job_id"],
    },
  },
] as const;

/** Parse a `result` argument that may arrive as an object or a JSON string. */
function parseResultArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Handle agent-link tool calls. Returns null when `name` is not one of them. */
function handleAgentLinkTool(
  name: string,
  args: Record<string, unknown>,
  publicBase: string
): Record<string, unknown> | null {
  const agentToken = typeof args.agent_token === "string" ? args.agent_token : undefined;

  switch (name) {
    case "swarmx_link_start": {
      const started = startLink(
        typeof args.agent_name === "string" ? args.agent_name : undefined
      );
      return {
        claim_url: `${publicBase}/link/${started.claimCode}`,
        agent_token: started.agentToken,
        expires_in_seconds: started.expiresInSeconds,
        next_steps:
          "1) Send claim_url to your human — opening it links their browser to you. " +
          "2) Keep agent_token. 3) Poll swarmx_poll_requests for jobs they queue.",
      };
    }
    case "swarmx_link_status": {
      const session = getSessionByAgentToken(agentToken);
      if (!session) return { error: "Invalid or expired agent_token" };
      const pending = [...session.jobs.values()].filter((j) => j.status === "pending").length;
      return { ...sessionSummary(session), pending_jobs: pending };
    }
    case "swarmx_poll_requests": {
      const polled = pollJobs(agentToken);
      if (!polled) return { error: "Invalid or expired agent_token" };
      return {
        claimed: polled.claimed,
        jobs: polled.jobs.map((j) => ({
          job_id: j.jobId,
          endpoint: `${publicBase}${j.endpoint}`,
          method: j.method,
          body: j.body,
          price_usd: j.priceUsd,
          description: j.description,
        })),
        how_to_pay:
          "POST the endpoint with no body to receive the 402 challenge (accepts[] lists rails: " +
          "USDC on Base/Arbitrum via EIP-3009, USDC on Solana). Sign and retry with the base64 " +
          "X-PAYMENT header and the job body, then call swarmx_complete_request with the JSON result.",
      };
    }
    case "swarmx_complete_request": {
      const jobId = typeof args.job_id === "string" ? args.job_id : "";
      const errorText = typeof args.error === "string" ? args.error : undefined;
      const completed = completeJob(agentToken, {
        jobId,
        ok: !errorText,
        result: parseResultArg(args.result),
        error: errorText,
      });
      return completed.ok
        ? { recorded: true, job_id: jobId }
        : { error: completed.error };
    }
    default:
      return null;
  }
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
          "SwarmX MCP server. Free tools execute directly. Paid tools require x402 payment: call the endpoint with an X-PAYMENT header (USDC on Base/Arbitrum via EIP-3009, USDC on Solana, or gasless USDG on Robinhood Chain eip155:4663), or pass the base64 X-PAYMENT as arguments._payment. To pair with a human browsing swarmx.io, call swarmx_link_start and give them the claim_url — they can then queue paid jobs for you from the Markets UI (swarmx_poll_requests / swarmx_complete_request).",
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
      const linkTools = AGENT_LINK_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return ok(id, { tools: [...tools, ...linkTools] });
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

      const publicBase = (opts.publicBaseUrl ?? opts.baseUrl).replace(/\/$/, "");

      // Agent Link session tools are handled in-process, never via the executor.
      const linkResult = handleAgentLinkTool(name, args, publicBase);
      if (linkResult !== null) {
        return ok(id, {
          isError: "error" in linkResult,
          content: [textContent(linkResult)],
        });
      }

      const tool = getMcpTool(name);
      if (!tool) {
        return ok(id, {
          isError: true,
          content: [textContent({ error: `Unknown tool: ${name}` })],
        });
      }
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
    tools: MANIFEST.tools.length + AGENT_LINK_TOOLS.length,
  };
}
