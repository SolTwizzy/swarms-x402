import { describe, it, expect } from "vitest";
import { x402SwarmsPlugin } from "../../src/index.js";
import { X402WalletService } from "../../src/services/x402WalletService.js";
import { SwarmsService } from "../../src/services/swarmsService.js";
import { PaymentMemoryService } from "../../src/services/paymentMemoryService.js";
import { X402ServerService } from "../../src/server/x402ServerService.js";

describe("x402SwarmsPlugin", () => {
  it("exports correct plugin shape", () => {
    expect(x402SwarmsPlugin.name).toBe("plugin-x402-swarms");
    expect(x402SwarmsPlugin.description).toBeDefined();
    expect(x402SwarmsPlugin.actions).toHaveLength(5);
    expect(x402SwarmsPlugin.providers).toHaveLength(2);
    expect(x402SwarmsPlugin.evaluators).toHaveLength(1);
    expect(x402SwarmsPlugin.services).toHaveLength(4);
  });

  it("has all expected action names", () => {
    const names = x402SwarmsPlugin.actions!.map((a) => a.name);
    expect(names).toContain("PAY_FOR_X402_SERVICE");
    expect(names).toContain("DISCOVER_X402_SERVICES");
    expect(names).toContain("DELEGATE_TO_SWARM");
    expect(names).toContain("RUN_SWARM_AGENT");
    expect(names).toContain("DELEGATE_TO_SWARM_WITH_PAYMENT");
  });

  it("registers all four services", () => {
    expect(X402WalletService.serviceType).toBe("X402_WALLET");
    expect(SwarmsService.serviceType).toBe("SWARMS");
    expect(X402ServerService.serviceType).toBe("X402_SERVER");
    expect(PaymentMemoryService.serviceType).toBe("PAYMENT_MEMORY");
  });

  it("has schema property with all three tables", () => {
    const schema = (x402SwarmsPlugin as any).schema;
    expect(schema).toBeDefined();
    expect(schema.x402PaymentHistory).toBeDefined();
    expect(schema.x402EndpointScores).toBeDefined();
    expect(schema.x402BudgetState).toBeDefined();
  });

  it("has both provider names", () => {
    const providerNames = x402SwarmsPlugin.providers!.map((p) => p.name);
    expect(providerNames).toContain("X402_PAYMENT_CONTEXT");
    expect(providerNames).toContain("X402_SERVER_CONTEXT");
  });

  it("evaluator name is PAYMENT_EVALUATOR", () => {
    expect(x402SwarmsPlugin.evaluators![0].name).toBe("PAYMENT_EVALUATOR");
  });

  it("registers x402 routes", () => {
    expect(x402SwarmsPlugin.routes).toBeDefined();
    expect(Array.isArray(x402SwarmsPlugin.routes)).toBe(true);
    expect(x402SwarmsPlugin.routes!.length).toBeGreaterThanOrEqual(5);
    expect(x402SwarmsPlugin.routes!.some((route) => route.path === "/x402/rwa/stock-dd")).toBe(true);
  });
});
