import { describe, it, expect } from "vitest";
import {
  handleMcpMessage,
  mcpDescriptor,
  MCP_PROTOCOL_VERSION,
  type JsonRpcMessage,
  type ToolExecutor,
} from "../../src/mcp/mcpServer.js";
import { getMcpToolDefinitions } from "../../src/mcp/index.js";

const OPTS = { baseUrl: "http://127.0.0.1:3000", publicBaseUrl: "https://swarmx.io" };
const MANIFEST = getMcpToolDefinitions();

/** An executor that never touches the network — asserts free-path wiring. */
function fakeExecutor(captured: { name?: string; params?: unknown; opts?: unknown }): ToolExecutor {
  return async (name, params, opts) => {
    captured.name = name;
    captured.params = params;
    captured.opts = opts;
    return { success: true, data: { echoed: params }, httpStatus: 200, tool: name, endpoint: "/x" };
  };
}

describe("MCP server — initialize", () => {
  it("returns serverInfo and echoes the client protocol version", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      OPTS
    );
    expect(res).not.toBeNull();
    expect(res!.id).toBe(1);
    const result = res!.result as Record<string, any>;
    expect(result.serverInfo.name).toBe("swarmx");
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.tools).toBeDefined();
  });

  it("falls back to the server protocol version when the client omits it", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "initialize" }, OPTS);
    expect((res!.result as any).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });
});

describe("MCP server — notifications", () => {
  it("returns null (no reply) for notifications/initialized", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, OPTS);
    expect(res).toBeNull();
  });
});

describe("MCP server — tools/list", () => {
  it("lists every tool with name/description/inputSchema", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, OPTS);
    const tools = (res!.result as any).tools as any[];
    expect(tools.length).toBe(MANIFEST.tools.length);
    expect(tools.length).toBe(40);
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema.type).toBe("object");
    }
    // Paid tools advertise the price in the description.
    const paid = tools.find((t) => t.description.includes("[PAID:"));
    expect(paid).toBeDefined();
  });
});

describe("MCP server — tools/call", () => {
  it("returns an honest payment_required for a PAID tool with no payment (no network call)", async () => {
    const paidTool = MANIFEST.tools.find((t) => !t.metadata.free)!;
    const captured: Record<string, unknown> = {};
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: paidTool.name, arguments: { foo: "bar" } } },
      { ...OPTS, executor: fakeExecutor(captured) }
    );
    const result = res!.result as any;
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.payment_required).toBe(true);
    expect(payload.price_usd).toBe(paidTool.metadata.priceUsd);
    expect(payload.endpoint).toBe(`https://swarmx.io${paidTool.metadata.endpoint}`);
    // Executor must NOT have run — no fabricated result.
    expect(captured.name).toBeUndefined();
  });

  it("executes a FREE tool via the injected executor and strips _payment", async () => {
    const freeTool = MANIFEST.tools.find((t) => t.metadata.free)!;
    const captured: Record<string, unknown> = {};
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: freeTool.name, arguments: { q: "hello", _payment: "SHOULD_BE_STRIPPED" } },
      },
      { ...OPTS, executor: fakeExecutor(captured) }
    );
    const result = res!.result as any;
    expect(result.isError).toBe(false);
    expect(captured.name).toBe(freeTool.name);
    // _payment is a paid-tool passthrough; on a free tool it is stripped from args.
    expect((captured.params as Record<string, unknown>)._payment).toBeUndefined();
    expect((captured.params as Record<string, unknown>).q).toBe("hello");
  });

  it("executes a PAID tool when a payment header is supplied via _payment", async () => {
    const paidTool = MANIFEST.tools.find((t) => !t.metadata.free)!;
    const captured: Record<string, unknown> = {};
    await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: paidTool.name, arguments: { code: "x", _payment: "BASE64PAYMENT" } },
      },
      { ...OPTS, executor: fakeExecutor(captured) }
    );
    expect(captured.name).toBe(paidTool.name);
    expect((captured.opts as any).headers["X-PAYMENT"]).toBe("BASE64PAYMENT");
    expect((captured.params as Record<string, unknown>)._payment).toBeUndefined();
  });

  it("returns isError for an unknown tool", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "swarmx_does_not_exist" } },
      OPTS
    );
    const result = res!.result as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("returns -32602 when name is missing", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: {} },
      OPTS
    );
    expect(res!.error!.code).toBe(-32602);
  });
});

describe("MCP server — errors", () => {
  it("returns -32601 for an unknown method", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 9, method: "no/such/method" }, OPTS);
    expect(res!.error!.code).toBe(-32601);
  });

  it("returns -32600 for an invalid envelope", async () => {
    const res = await handleMcpMessage({ id: 10, method: "initialize" } as JsonRpcMessage, OPTS);
    expect(res!.error!.code).toBe(-32600);
  });
});

describe("MCP server — descriptor", () => {
  it("advertises the endpoint, transport, and tool count", () => {
    const d = mcpDescriptor("https://swarmx.io");
    expect(d.name).toBe("swarmx");
    expect(d.transport).toBe("streamable-http");
    expect(d.endpoint).toBe("https://swarmx.io/mcp");
    expect(d.tools).toBe(MANIFEST.tools.length);
  });
});
