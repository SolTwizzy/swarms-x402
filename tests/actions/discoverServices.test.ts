import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime, createMockCallback, createMockMessage } from "../setup.js";
import { MOCK_APIS } from "../fixtures.js";

vi.mock("@dexterai/x402/client", () => ({
  searchAPIs: vi.fn(async () => []),
}));

import { discoverServices } from "../../src/actions/discoverServices.js";
import { searchAPIs } from "@dexterai/x402/client";

const mockedSearchAPIs = vi.mocked(searchAPIs);

describe("discoverServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validate()", () => {
    it("always returns true", async () => {
      const runtime = createMockRuntime();
      const message = createMockMessage("test");
      expect(await discoverServices.validate(runtime, message)).toBe(true);
    });
  });

  describe("handler()", () => {
    it("returns formatted list when APIs found", async () => {
      mockedSearchAPIs.mockResolvedValue(MOCK_APIS);
      const runtime = createMockRuntime();
      const message = createMockMessage("search for AI APIs");
      const callback = createMockCallback();

      await discoverServices.handler(runtime, message, undefined, undefined, callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Exa Search"),
          content: expect.objectContaining({
            serviceCount: "2",
            serviceNames: expect.stringContaining("Exa Search"),
          }),
        })
      );
    });

    it("passes query from message text to searchAPIs", async () => {
      mockedSearchAPIs.mockResolvedValue([]);
      const runtime = createMockRuntime();
      const message = createMockMessage("sentiment analysis");
      const callback = createMockCallback();

      await discoverServices.handler(runtime, message, undefined, undefined, callback);

      expect(mockedSearchAPIs).toHaveBeenCalledWith(
        expect.objectContaining({
          query: "sentiment analysis",
          limit: 10,
          sort: "quality_score",
        })
      );
    });

    it("passes undefined query for empty message", async () => {
      mockedSearchAPIs.mockResolvedValue([]);
      const runtime = createMockRuntime();
      const message = createMockMessage("");
      const callback = createMockCallback();

      await discoverServices.handler(runtime, message, undefined, undefined, callback);

      expect(mockedSearchAPIs).toHaveBeenCalledWith(
        expect.objectContaining({ query: undefined })
      );
    });

    it("returns no services found message for empty results", async () => {
      mockedSearchAPIs.mockResolvedValue([]);
      const runtime = createMockRuntime();
      const message = createMockMessage("nonexistent");
      const callback = createMockCallback();

      await discoverServices.handler(runtime, message, undefined, undefined, callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("No x402 services found"),
        })
      );
    });

    it("handles searchAPIs error gracefully", async () => {
      mockedSearchAPIs.mockRejectedValue(new Error("Network error"));
      const runtime = createMockRuntime();
      const message = createMockMessage("test");
      const callback = createMockCallback();

      await discoverServices.handler(runtime, message, undefined, undefined, callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Network error"),
          error: true,
        })
      );
    });

    it("does not throw when callback is undefined", async () => {
      mockedSearchAPIs.mockResolvedValue(MOCK_APIS);
      const runtime = createMockRuntime();
      const message = createMockMessage("test");

      await expect(
        discoverServices.handler(runtime, message, undefined, undefined, undefined)
      ).resolves.not.toThrow();
    });

    it("shows verified badge for verified APIs", async () => {
      mockedSearchAPIs.mockResolvedValue([MOCK_APIS[0]]);
      const runtime = createMockRuntime();
      const message = createMockMessage("test");
      const callback = createMockCallback();

      await discoverServices.handler(runtime, message, undefined, undefined, callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("[verified]"),
        })
      );
    });
  });
});
