import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock both LLM providers before importing callLLM
vi.mock("../../src/utils/gemini.js", () => ({
  callGemini: vi.fn(async () => "gemini response"),
}));

// We need to NOT mock llm.ts itself since we're testing it,
// but we need to mock callOpenAI's fetch calls.
// Since callLLM calls callOpenAI (which uses fetch), we mock fetch.
const originalFetch = globalThis.fetch;

import { callLLM, callOpenAI } from "../../src/utils/llm.js";
import { callGemini } from "../../src/utils/gemini.js";

function createMockRuntime(settings: Record<string, string | null> = {}) {
  return {
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  };
}

describe("callLLM — smart routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set mock implementations (mockReset clears them between tests)
    (callGemini as ReturnType<typeof vi.fn>).mockResolvedValue("gemini response");
    // Mock fetch for OpenAI calls
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "openai response" } }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("routes to OpenAI when both keys present and taskType is 'code'", async () => {
    const runtime = createMockRuntime({
      OPENAI_API_KEY: "sk-test",
      GEMINI_API_KEY: "gem-test",
    });

    const result = await callLLM(runtime, {
      systemPrompt: "You are a code reviewer.",
      userPrompt: "Review this code.",
      taskType: "code",
    });

    expect(result).toBe("openai response");
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("routes to Gemini when both keys present and taskType is 'research'", async () => {
    const runtime = createMockRuntime({
      OPENAI_API_KEY: "sk-test",
      GEMINI_API_KEY: "gem-test",
    });

    const result = await callLLM(runtime, {
      systemPrompt: "You are a researcher.",
      userPrompt: "Research this topic.",
      taskType: "research",
    });

    expect(result).toBe("gemini response");
    expect(callGemini).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "gem-test",
        systemPrompt: "You are a researcher.",
        userPrompt: "Research this topic.",
      }),
    );
  });

  it("falls back to Gemini when no OpenAI key", async () => {
    const runtime = createMockRuntime({
      GEMINI_API_KEY: "gem-test",
    });

    const result = await callLLM(runtime, {
      systemPrompt: "test",
      userPrompt: "test",
      taskType: "general",
    });

    expect(result).toBe("gemini response");
    expect(callGemini).toHaveBeenCalled();
  });

  it("falls back to OpenAI when no Gemini key", async () => {
    const runtime = createMockRuntime({
      OPENAI_API_KEY: "sk-test",
    });

    const result = await callLLM(runtime, {
      systemPrompt: "test",
      userPrompt: "test",
      taskType: "research",
    });

    // Even though taskType is research, Gemini key is missing -> OpenAI
    expect(result).toBe("openai response");
    expect(callGemini).not.toHaveBeenCalled();
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

  it("respects explicit provider='openai'", async () => {
    const runtime = createMockRuntime({
      OPENAI_API_KEY: "sk-test",
      GEMINI_API_KEY: "gem-test",
    });

    await callLLM(runtime, {
      systemPrompt: "test",
      userPrompt: "test",
      provider: "openai",
      taskType: "research", // would normally route to Gemini
    });

    expect(callGemini).not.toHaveBeenCalled();
  });

  it("respects explicit provider='gemini'", async () => {
    const runtime = createMockRuntime({
      OPENAI_API_KEY: "sk-test",
      GEMINI_API_KEY: "gem-test",
    });

    await callLLM(runtime, {
      systemPrompt: "test",
      userPrompt: "test",
      provider: "gemini",
      taskType: "code", // would normally route to OpenAI
    });

    expect(callGemini).toHaveBeenCalled();
  });

  it("throws when explicit provider='openai' but no OpenAI key", async () => {
    const runtime = createMockRuntime({
      GEMINI_API_KEY: "gem-test",
    });

    await expect(
      callLLM(runtime, {
        systemPrompt: "test",
        userPrompt: "test",
        provider: "openai",
      }),
    ).rejects.toThrow("OPENAI_API_KEY not configured");
  });

  it("throws when explicit provider='gemini' but no Gemini key", async () => {
    const runtime = createMockRuntime({
      OPENAI_API_KEY: "sk-test",
    });

    await expect(
      callLLM(runtime, {
        systemPrompt: "test",
        userPrompt: "test",
        provider: "gemini",
      }),
    ).rejects.toThrow("GEMINI_API_KEY not configured");
  });

  it("passes groundingEnabled to Gemini", async () => {
    const runtime = createMockRuntime({
      GEMINI_API_KEY: "gem-test",
    });

    await callLLM(runtime, {
      systemPrompt: "test",
      userPrompt: "test",
      provider: "gemini",
      groundingEnabled: true,
    });

    expect(callGemini).toHaveBeenCalledWith(
      expect.objectContaining({
        groundingEnabled: true,
      }),
    );
  });

  it("defaults taskType to 'general' (routes to OpenAI)", async () => {
    const runtime = createMockRuntime({
      OPENAI_API_KEY: "sk-test",
      GEMINI_API_KEY: "gem-test",
    });

    await callLLM(runtime, {
      systemPrompt: "test",
      userPrompt: "test",
      // no taskType — defaults to "general"
    });

    // "general" should go to OpenAI, not Gemini
    expect(callGemini).not.toHaveBeenCalled();
  });
});
