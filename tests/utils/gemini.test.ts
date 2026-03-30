import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callGemini } from "../../src/utils/gemini.js";

describe("callGemini", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const baseOptions = {
    apiKey: "test-gemini-key",
    systemPrompt: "You are a helpful assistant.",
    userPrompt: "Hello world",
  };

  it("returns text on success", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "Gemini response text" }] } },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await callGemini(baseOptions);
    expect(result).toBe("Gemini response text");

    // Verify fetch was called with correct URL pattern
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("generativelanguage.googleapis.com");
    expect(call[0]).toContain("key=test-gemini-key");
  });

  it("handles 429 rate limit", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("rate limited", { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(callGemini(baseOptions)).rejects.toThrow(
      "Gemini rate limit exceeded (429)",
    );
  });

  it("handles empty response (no candidates)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await callGemini(baseOptions);
    expect(result).toBe("");
  });

  it("handles empty response (no text in parts)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{}] } }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await callGemini(baseOptions);
    expect(result).toBe("");
  });

  it("uses correct model default (gemini-2.5-flash)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    await callGemini(baseOptions);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("gemini-2.5-flash");
  });

  it("uses custom model when specified", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    await callGemini({ ...baseOptions, model: "gemini-2.5-pro-preview-05-06" });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("gemini-2.5-pro-preview-05-06");
  });

  it("enables grounding when requested", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "grounded" }] } }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    await callGemini({ ...baseOptions, groundingEnabled: true });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.tools).toEqual([{ googleSearch: {} }]);
  });

  it("does not include tools when grounding is disabled", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "no grounding" }] } }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    await callGemini({ ...baseOptions, groundingEnabled: false });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.tools).toBeUndefined();
  });

  it("sends systemInstruction and generationConfig correctly", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    await callGemini({
      ...baseOptions,
      maxTokens: 2048,
      temperature: 0.7,
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.systemInstruction.parts[0].text).toBe("You are a helpful assistant.");
    expect(body.generationConfig.maxOutputTokens).toBe(2048);
    expect(body.generationConfig.temperature).toBe(0.7);
  });

  it("handles API error response with error object", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("server error", { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(callGemini(baseOptions)).rejects.toThrow(
      "Gemini API error (500)",
    );
  });
});
