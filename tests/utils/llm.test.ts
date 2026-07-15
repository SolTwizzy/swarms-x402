import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test llm.ts itself (do NOT mock it). Swarms + OpenAI both go through
// fetch, so we mock fetch and route by URL:
//   - api.swarms.world  -> Swarms /v1/agent/completions shape
//   - api.openai.com    -> OpenAI chat/completions shape
const originalFetch = globalThis.fetch;

import { callLLM, callOpenAI, callSwarmsAgent, runLocalPanel } from "../../src/utils/llm.js";

function mockFetchByUrl() {
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("api.swarms.world")) {
      return new Response(
        JSON.stringify({ outputs: [{ role: "assistant", content: "swarms response" }] }),
        { status: 200 },
      );
    }
    // default: OpenAI
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "openai response" } }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

function createMockRuntime(settings: Record<string, string | null> = {}) {
  return {
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  };
}

describe("callLLM — smart routing (Swarms → OpenAI)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchByUrl();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("prefers Swarms when SWARMS_API_KEY is set (over OpenAI)", async () => {
    const runtime = createMockRuntime({
      SWARMS_API_KEY: "swarms-test",
      OPENAI_API_KEY: "sk-test",
    });

    const result = await callLLM(runtime, {
      systemPrompt: "You are helpful.",
      userPrompt: "Do the task.",
    });

    expect(result).toBe("swarms response");
  });

  it("falls back to OpenAI when only OpenAI key is present", async () => {
    const runtime = createMockRuntime({
      OPENAI_API_KEY: "sk-test",
    });

    const result = await callLLM(runtime, {
      systemPrompt: "test",
      userPrompt: "test",
    });

    expect(result).toBe("openai response");
  });

  it("cascades Swarms → OpenAI when Swarms fails", async () => {
    // Swarms 500s → cascade to OpenAI.
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("api.swarms.world")) {
        return new Response("upstream error", { status: 500 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "openai response" } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const runtime = createMockRuntime({
      SWARMS_API_KEY: "swarms-test",
      OPENAI_API_KEY: "sk-test",
    });

    const result = await callLLM(runtime, { systemPrompt: "test", userPrompt: "test" });
    expect(result).toBe("openai response");
  });

  it("throws when no keys available", async () => {
    const runtime = createMockRuntime({});

    await expect(
      callLLM(runtime, {
        systemPrompt: "test",
        userPrompt: "test",
      }),
    ).rejects.toThrow("No LLM API key configured");
  });

  it("respects explicit provider='openai' (no cascade, no Swarms)", async () => {
    const runtime = createMockRuntime({
      SWARMS_API_KEY: "swarms-test",
      OPENAI_API_KEY: "sk-test",
    });

    const result = await callLLM(runtime, {
      systemPrompt: "test",
      userPrompt: "test",
      provider: "openai",
    });

    expect(result).toBe("openai response");
  });

  it("throws when explicit provider='openai' returns empty output", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "   " } }] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const runtime = createMockRuntime({ OPENAI_API_KEY: "sk-test" });

    await expect(
      callLLM(runtime, {
        systemPrompt: "test",
        userPrompt: "test",
        provider: "openai",
      }),
    ).rejects.toThrow("OpenAI API returned empty output");
  });

  it("applies a 60-second abort signal to explicit OpenAI calls", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "openai response" } }] }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const runtime = createMockRuntime({ OPENAI_API_KEY: "sk-test" });

    await callLLM(runtime, {
      systemPrompt: "test",
      userPrompt: "test",
      provider: "openai",
    });

    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
    timeoutSpy.mockRestore();
  });

  it("respects explicit provider='swarms'", async () => {
    const runtime = createMockRuntime({
      SWARMS_API_KEY: "swarms-test",
      OPENAI_API_KEY: "sk-test",
    });

    const result = await callLLM(runtime, {
      systemPrompt: "test",
      userPrompt: "test",
      provider: "swarms",
    });

    expect(result).toBe("swarms response");
  });

  it("throws when explicit provider='openai' but no OpenAI key", async () => {
    const runtime = createMockRuntime({
      SWARMS_API_KEY: "swarms-test",
    });

    await expect(
      callLLM(runtime, {
        systemPrompt: "test",
        userPrompt: "test",
        provider: "openai",
      }),
    ).rejects.toThrow("OPENAI_API_KEY not configured");
  });

  it("throws when explicit provider='swarms' but no Swarms key", async () => {
    const runtime = createMockRuntime({
      OPENAI_API_KEY: "sk-test",
    });

    await expect(
      callLLM(runtime, {
        systemPrompt: "test",
        userPrompt: "test",
        provider: "swarms",
      }),
    ).rejects.toThrow("SWARMS_API_KEY not configured");
  });
});

describe("callOpenAI — Swarms-first cascade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchByUrl();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses Swarms first when swarmsApiKey is provided", async () => {
    const result = await callOpenAI({
      apiKey: "sk-test",
      swarmsApiKey: "swarms-test",
      systemPrompt: "test",
      userPrompt: "test",
    });

    expect(result).toBe("swarms response");
  });

  it("cascades to OpenAI when Swarms fails", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("api.swarms.world")) {
        return new Response("boom", { status: 500 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "openai response" } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await callOpenAI({
      apiKey: "sk-test",
      swarmsApiKey: "swarms-test",
      systemPrompt: "test",
      userPrompt: "test",
    });

    expect(result).toBe("openai response");
  });

  it("falls through to OpenAI when only apiKey is provided (no swarms)", async () => {
    const result = await callOpenAI({
      apiKey: "sk-test",
      swarmsApiKey: "",
      systemPrompt: "test",
      userPrompt: "test",
    });

    expect(result).toBe("openai response");
  });

  it("throws after both Swarms and OpenAI return empty output", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("api.swarms.world")) {
        return new Response(JSON.stringify({ outputs: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "" } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await expect(
      callOpenAI({
        apiKey: "sk-test",
        swarmsApiKey: "swarms-test",
        systemPrompt: "test",
        userPrompt: "test",
      }),
    ).rejects.toThrow(/All LLM providers failed.*Swarms agent returned empty output.*OpenAI API returned empty output/);
  });
});

describe("callSwarmsAgent", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /v1/agent/completions with x-api-key and extracts outputs[].content", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ outputs: [{ role: "assistant", content: "swarms response" }] }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await callSwarmsAgent({
      swarmsApiKey: "swarms-test",
      systemPrompt: "sys",
      userPrompt: "task",
    });

    expect(result).toBe("swarms response");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/agent/completions");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("swarms-test");
    const body = JSON.parse(init.body as string);
    expect(body.task).toBe("task");
    expect(body.agent_config.system_prompt).toBe("sys");
    expect(body.agent_config.max_loops).toBe(1);
  });

  it("extracts a plain string `output`", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ output: "plain output" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await callSwarmsAgent({
      swarmsApiKey: "swarms-test",
      systemPrompt: "sys",
      userPrompt: "task",
    });
    expect(result).toBe("plain output");
  });

  it("throws on non-2xx", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("nope", { status: 402 }),
    ) as unknown as typeof fetch;

    await expect(
      callSwarmsAgent({ swarmsApiKey: "swarms-test", systemPrompt: "s", userPrompt: "t" }),
    ).rejects.toThrow("Swarms agent API error (402)");
  });

  it("throws on empty output", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ outputs: [] }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      callSwarmsAgent({ swarmsApiKey: "swarms-test", systemPrompt: "s", userPrompt: "t" }),
    ).rejects.toThrow("empty output");
  });
});

describe("runLocalPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns a transcript with each agent that produced output", async () => {
    const runtime = createMockRuntime({ OPENAI_API_KEY: "test-key" });
    // OpenAI echoes a per-agent line so we can see all three in the transcript.
    let n = 0;
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: `analysis-${++n}` } }] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await runLocalPanel(runtime as any, {
      agents: [
        { name: "Bull", systemPrompt: "bull" },
        { name: "Bear", systemPrompt: "bear" },
        { name: "Risk", systemPrompt: "risk" },
      ],
      task: "analyze",
    });

    expect(result.agentCount).toBe(3);
    expect(result.transcript).toContain("[Bull]");
    expect(result.transcript).toContain("[Bear]");
    expect(result.transcript).toContain("[Risk]");
  });

  it("drops prompt-scaffolding output (never passes it off as analysis)", async () => {
    const runtime = createMockRuntime({ OPENAI_API_KEY: "test-key" });
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: "Present your argument in favor of: is NVDA a buy?" } },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await runLocalPanel(runtime as any, {
      agents: [
        { name: "Bull", systemPrompt: "bull" },
        { name: "Bear", systemPrompt: "bear" },
      ],
      task: "analyze",
    });

    expect(result.agentCount).toBe(0);
    expect(result.transcript).toBe("");
  });
});
