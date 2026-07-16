import { describe, it, expect, beforeEach } from "vitest";
import {
  handleMcpMessage,
  mcpDescriptor,
  MCP_PROTOCOL_VERSION,
  type JsonRpcMessage,
  type ToolExecutor,
} from "../../src/mcp/mcpServer.js";
import { getMcpToolDefinitions } from "../../src/mcp/index.js";
import {
  claimLink,
  createJob,
  getJob,
  resetAgentLinkStore,
} from "../../src/server/agentLink.js";

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
    // Catalog tools + the 4 agent-link session tools.
    expect(tools.length).toBe(MANIFEST.tools.length + 4);
    expect(tools.length).toBe(48);
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
    expect(d.tools).toBe(MANIFEST.tools.length + 4);
  });
});

describe("MCP server — agent link tools", () => {
  beforeEach(() => resetAgentLinkStore());

  async function call(name: string, args: Record<string, unknown>) {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name, arguments: args } },
      OPTS
    );
    const result = res!.result as any;
    return { isError: result.isError as boolean, payload: JSON.parse(result.content[0].text) };
  }

  it("swarmx_link_start returns a claim_url on the public origin and an agent_token", async () => {
    const { isError, payload } = await call("swarmx_link_start", { agent_name: "hermes" });
    expect(isError).toBe(false);
    expect(payload.claim_url).toMatch(/^https:\/\/swarmx\.io\/link\/[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(typeof payload.agent_token).toBe("string");
  });

  it("full round-trip: start → claim → queue job → poll → complete", async () => {
    const start = await call("swarmx_link_start", { agent_name: "hermes" });
    const token = start.payload.agent_token as string;
    const code = (start.payload.claim_url as string).split("/link/")[1]!;

    // Before the human claims, the session reports unclaimed.
    let status = await call("swarmx_link_status", { agent_token: token });
    expect(status.payload.linked).toBe(false);

    const claimed = claimLink(code)!;
    expect(claimed.agentName).toBe("hermes");

    // Human queues a job (store-level, as the HTTP route does).
    const created = createJob(
      claimed.browserToken,
      { endpoint: "/x402/rwa/stock-dd", body: { ticker: "AAPL" } },
      [{ endpoint: "/x402/rwa/stock-dd", method: "POST", priceUsd: "0.29", description: "Stock DD" }]
    );
    expect(created.ok).toBe(true);

    // Agent polls and sees the job with an absolute endpoint URL.
    const polled = await call("swarmx_poll_requests", { agent_token: token });
    expect(polled.payload.claimed).toBe(true);
    expect(polled.payload.jobs).toHaveLength(1);
    const job = polled.payload.jobs[0];
    expect(job.endpoint).toBe("https://swarmx.io/x402/rwa/stock-dd");
    expect(job.body.ticker).toBe("AAPL");
    expect(job.price_usd).toBe("0.29");

    // Agent completes with the paid result (accepts a JSON string too).
    const done = await call("swarmx_complete_request", {
      agent_token: token,
      job_id: job.job_id,
      result: JSON.stringify({ verdict: "bullish", payment: { transaction: "0xabc", network: "base" } }),
    });
    expect(done.isError).toBe(false);
    expect(done.payload.recorded).toBe(true);

    // Browser sees the completed job with the payment receipt extracted.
    const stored = getJob(claimed.browserToken, job.job_id)!;
    expect(stored.status).toBe("done");
    expect(stored.payment).toEqual({ transaction: "0xabc", network: "base" });

    // Completed jobs no longer appear in the poll.
    const repoll = await call("swarmx_poll_requests", { agent_token: token });
    expect(repoll.payload.jobs).toHaveLength(0);
  });

  it("rejects an invalid agent_token", async () => {
    const polled = await call("swarmx_poll_requests", { agent_token: "bogus" });
    expect(polled.isError).toBe(true);
    expect(polled.payload.error).toContain("Invalid");
  });

  it("records agent-reported failures", async () => {
    const start = await call("swarmx_link_start", {});
    const token = start.payload.agent_token as string;
    const code = (start.payload.claim_url as string).split("/link/")[1]!;
    const claimed = claimLink(code)!;
    const created = createJob(
      claimed.browserToken,
      { endpoint: "/x402/rwa/stock-dd", body: { ticker: "NVDA" } },
      [{ endpoint: "/x402/rwa/stock-dd", method: "POST", priceUsd: "0.29", description: "Stock DD" }]
    );
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.job.jobId : "";

    const done = await call("swarmx_complete_request", {
      agent_token: token,
      job_id: jobId,
      error: "insufficient USDC",
    });
    expect(done.payload.recorded).toBe(true);
    const stored = getJob(claimed.browserToken, jobId)!;
    expect(stored.status).toBe("failed");
    expect(stored.error).toBe("insufficient USDC");
  });
});
