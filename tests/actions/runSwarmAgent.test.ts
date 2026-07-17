import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMockRuntime,
  createMockCallback,
  createMockMessage,
} from "../setup.js";
import { runSwarmAgent } from "../../src/actions/runSwarmAgent.js";

function createMockSwarmsService(overrides?: {
  available?: boolean;
  runAgentResult?: Record<string, unknown>;
  runAgentError?: Error;
}) {
  return {
    isAvailable: vi.fn(() => overrides?.available ?? true),
    runAgent: overrides?.runAgentError
      ? vi.fn(async () => { throw overrides.runAgentError; })
      : vi.fn(async () =>
          overrides?.runAgentResult ?? {
            id: "agent-1",
            success: true,
            name: "GeneralAgent",
            outputs: { content: "Task completed successfully.", role: "assistant" },
            usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
            timestamp: new Date().toISOString(),
          }
        ),
    getClient: vi.fn(),
  };
}

describe("runSwarmAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validate()", () => {
    it("returns true with SWARMS_API_KEY", async () => {
      const runtime = createMockRuntime({ settings: { SWARMS_API_KEY: "sk-test" } });
      expect(await runSwarmAgent.validate(runtime, createMockMessage("test"))).toBe(true);
    });

    it("returns false without SWARMS_API_KEY", async () => {
      const runtime = createMockRuntime({ settings: {} });
      expect(await runSwarmAgent.validate(runtime, createMockMessage("test"))).toBe(false);
    });
  });

  describe("handler()", () => {
    it("returns error when service not available", async () => {
      const runtime = createMockRuntime();
      const callback = createMockCallback();

      await runSwarmAgent.handler(
        runtime, createMockMessage("test"), undefined, undefined, callback
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ error: true })
      );
    });

    it("calls runAgent with extracted config", async () => {
      const swarmsService = createMockSwarmsService();
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: JSON.stringify({
          task: "Review this code for vulnerabilities",
          agentName: "SecurityAuditor",
          modelName: "gpt-5-mini",
          temperature: 0.3,
        }),
      });
      const callback = createMockCallback();

      await runSwarmAgent.handler(
        runtime, createMockMessage("review code"), undefined, undefined, callback
      );

      expect(swarmsService.runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_name: "SecurityAuditor",
          model_name: "gpt-5-mini",
          temperature: 0.3,
        }),
        "Review this code for vulnerabilities"
      );
    });

    it("uses defaults on invalid extraction", async () => {
      const swarmsService = createMockSwarmsService();
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: "not json",
      });
      const callback = createMockCallback();

      await runSwarmAgent.handler(
        runtime, createMockMessage("do something"), undefined, undefined, callback
      );

      expect(swarmsService.runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_name: "GeneralAgent",
          model_name: "gpt-5-mini",
        }),
        "do something"
      );
    });

    it("formats successful agent result", async () => {
      const swarmsService = createMockSwarmsService({
        runAgentResult: {
          id: "agent-42",
          success: true,
          outputs: { content: "Found 3 vulnerabilities in the smart contract." },
        },
      });
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: '{"task":"audit","agentName":"Auditor"}',
      });
      const callback = createMockCallback();

      await runSwarmAgent.handler(
        runtime, createMockMessage("audit"), undefined, undefined, callback
      );

      const calls = (callback as any).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.text).toContain("Found 3 vulnerabilities");
      expect(lastCall.content.agentName).toBe("Auditor");
    });

    it("handles string output", async () => {
      const swarmsService = createMockSwarmsService({
        runAgentResult: {
          id: "agent-1",
          success: true,
          outputs: "Plain string output from agent",
        },
      });
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: '{"task":"test"}',
      });
      const callback = createMockCallback();

      await runSwarmAgent.handler(
        runtime, createMockMessage("test"), undefined, undefined, callback
      );

      const calls = (callback as any).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.text).toContain("Plain string output");
    });

    it("handles agent error gracefully", async () => {
      const swarmsService = createMockSwarmsService({
        runAgentError: new Error("Model not available"),
      });
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: '{"task":"test"}',
      });
      const callback = createMockCallback();

      await runSwarmAgent.handler(
        runtime, createMockMessage("test"), undefined, undefined, callback
      );

      const calls = (callback as any).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.error).toBe(true);
      expect(lastCall.text).toContain("Model not available");
    });
  });
});
