import { describe, it, expect } from "vitest";
import { searchAPIs } from "@dexterai/x402/client";

const RUN_SMOKE = process.env.RUN_SMOKE === "true" || process.env.CI === "true";

describe.skipIf(!RUN_SMOKE)("OpenDexter Marketplace (smoke)", () => {
  it("searchAPIs returns an array", async () => {
    const result = await searchAPIs();
    expect(Array.isArray(result)).toBe(true);
  });

  it("searchAPIs with query returns relevant results", async () => {
    const result = await searchAPIs({ query: "ai", limit: 5 });
    expect(Array.isArray(result)).toBe(true);
    for (const api of result) {
      expect(api).toHaveProperty("name");
      expect(api).toHaveProperty("url");
      expect(api).toHaveProperty("price");
    }
  });

  it("searchAPIs respects limit", async () => {
    const result = await searchAPIs({ limit: 3 });
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("searchAPIs verifiedOnly returns only verified", async () => {
    const result = await searchAPIs({ verifiedOnly: true, limit: 5 });
    for (const api of result) {
      expect(api.verified).toBe(true);
    }
  });

  it("DiscoveredAPI has expected shape", async () => {
    const result = await searchAPIs({ limit: 1 });
    if (result.length > 0) {
      const api = result[0];
      expect(typeof api.name).toBe("string");
      expect(typeof api.url).toBe("string");
      expect(typeof api.price).toBe("string");
      expect(typeof api.category).toBe("string");
      expect(typeof api.verified).toBe("boolean");
      expect(typeof api.totalCalls).toBe("number");
    }
  });
});
