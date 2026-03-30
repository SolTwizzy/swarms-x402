import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMockRuntime,
  createMockCallback,
  createMockMessage,
} from "../setup.js";
import { delegateToSwarm } from "../../src/actions/delegateToSwarm.js";

function createMockSwarmsService(overrides?: {
  available?: boolean;
  runSwarmResult?: Record<string, unknown>;
  runSwarmError?: Error;
}) {
  return {
    isAvailable: vi.fn(() => overrides?.available ?? true),
    runSwarm: overrides?.runSwarmError
      ? vi.fn(async () => { throw overrides.runSwarmError; })
      : vi.fn(async () =>
          overrides?.runSwarmResult ?? {
            job_id: "job-123",
            status: "success",
            swarm_name: "TestSwarm",
            swarm_type: "SequentialWorkflow",
            number_of_agents: 2,
            output: "Analysis complete: DeFi protocols show moderate risk.",
            execution_time: 12.3,
            service_tier: "standard",
            usage: {},
          }
        ),
    runAgent: vi.fn(async () => ({
      id: "agent-1",
      success: true,
      outputs: { content: "Agent output here" },
    })),
    getClient: vi.fn(),
    getAvailableSwarmTypes: vi.fn(async () => ["SequentialWorkflow", "ConcurrentWorkflow"]),
  };
}

describe("delegateToSwarm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validate()", () => {
    it("returns true with SWARMS_API_KEY", async () => {
      const runtime = createMockRuntime({ settings: { SWARMS_API_KEY: "sk-test" } });
      expect(await delegateToSwarm.validate(runtime, createMockMessage("test"))).toBe(true);
    });

    it("returns false without SWARMS_API_KEY", async () => {
      const runtime = createMockRuntime({ settings: {} });
      expect(await delegateToSwarm.validate(runtime, createMockMessage("test"))).toBe(false);
    });
  });

  describe("handler()", () => {
    it("returns error when swarms service not available", async () => {
      const runtime = createMockRuntime();
      const callback = createMockCallback();

      await delegateToSwarm.handler(
        runtime, createMockMessage("analyze defi"), undefined, undefined, callback
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ error: true, text: expect.stringContaining("not initialized") })
      );
    });

    it("returns error when service reports unavailable", async () => {
      const swarmsService = createMockSwarmsService({ available: false });
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: '{"task":"test"}',
      });
      const callback = createMockCallback();

      await delegateToSwarm.handler(
        runtime, createMockMessage("test"), undefined, undefined, callback
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ error: true })
      );
    });

    it("calls runSwarm with template agents when keyword matches", async () => {
      const swarmsService = createMockSwarmsService();
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: JSON.stringify({
          task: "Analyze DeFi risks",
        }),
      });
      const callback = createMockCallback();

      // "analyze defi" matches AnalysisPanel template via \banalyz/i keyword
      await delegateToSwarm.handler(
        runtime, createMockMessage("analyze defi"), undefined, undefined, callback
      );

      expect(swarmsService.runSwarm).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Analyze DeFi risks",
          swarm_type: "MixtureOfAgents",
          agents: expect.arrayContaining([
            expect.objectContaining({ agent_name: "TechnicalExpert" }),
            expect.objectContaining({ agent_name: "EconomicExpert" }),
            expect.objectContaining({ agent_name: "RiskExpert" }),
            expect.objectContaining({ agent_name: "Synthesizer" }),
          ]),
        })
      );
    });

    it("uses custom agents when specified in extraction (no template match)", async () => {
      const swarmsService = createMockSwarmsService();
      // LLM classification returns "custom", then full extraction returns custom agents
      // First call: classification (returns "custom"), second call: full extraction
      let callCount = 0;
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: "",  // overridden below
      });
      (runtime.useModel as any).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Classification call — returns "custom"
          return JSON.stringify({ templateId: "custom", task: "Run a brainstorm session" });
        }
        // Full extraction call
        return JSON.stringify({
          task: "Run a brainstorm session",
          swarmType: "GroupChat",
          agents: [
            { agent_name: "Facilitator", system_prompt: "Moderate the brainstorm" },
            { agent_name: "Ideator", system_prompt: "Generate wild ideas" },
            { agent_name: "Critic", system_prompt: "Stress-test ideas" },
          ],
        });
      });
      const callback = createMockCallback();

      // "run a brainstorm session" doesn't match any template keywords
      await delegateToSwarm.handler(
        runtime, createMockMessage("run a brainstorm session"), undefined, undefined, callback
      );

      const callArgs = swarmsService.runSwarm.mock.calls[0][0];
      expect(callArgs.agents).toHaveLength(3);
      expect(callArgs.agents[0].agent_name).toBe("Facilitator");
      expect(callArgs.swarm_type).toBe("GroupChat");
    });

    it("falls back to auto swarm type on invalid extraction", async () => {
      const swarmsService = createMockSwarmsService();
      // All LLM calls return invalid JSON — both classification and extraction fail
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: "not valid json",
      });
      const callback = createMockCallback();

      // "do something" doesn't match any template keywords
      await delegateToSwarm.handler(
        runtime, createMockMessage("do something"), undefined, undefined, callback
      );

      const callArgs = swarmsService.runSwarm.mock.calls[0][0];
      expect(callArgs.swarm_type).toBe("auto");
      expect(callArgs.task).toBe("do something");
    });

    it("formats successful swarm result", async () => {
      const swarmsService = createMockSwarmsService({
        runSwarmResult: {
          job_id: "job-456",
          status: "success",
          swarm_type: "MixtureOfAgents",
          number_of_agents: 3,
          output: "Comprehensive analysis of DeFi protocols",
          execution_time: 8.5,
          usage: {},
        },
      });
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: '{"task":"analyze","swarmType":"MixtureOfAgents"}',
      });
      const callback = createMockCallback();

      await delegateToSwarm.handler(
        runtime, createMockMessage("analyze"), undefined, undefined, callback
      );

      const calls = (callback as any).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.text).toContain("MixtureOfAgents");
      expect(lastCall.text).toContain("Comprehensive analysis");
      expect(lastCall.text).toContain("8.5s");
      expect(lastCall.content.jobId).toBe("job-456");
    });

    it("handles object output from swarm", async () => {
      const swarmsService = createMockSwarmsService({
        runSwarmResult: {
          job_id: "job-789",
          output: { findings: ["risk1", "risk2"], summary: "Two risks found" },
          execution_time: 5,
          number_of_agents: 2,
          swarm_type: "SequentialWorkflow",
          status: "success",
          usage: {},
        },
      });
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: '{"task":"find risks"}',
      });
      const callback = createMockCallback();

      await delegateToSwarm.handler(
        runtime, createMockMessage("find risks"), undefined, undefined, callback
      );

      const calls = (callback as any).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.text).toContain("risk1");
      expect(lastCall.text).toContain("Two risks found");
    });

    it("keyword-matched template skips full LLM extraction (only task extraction)", async () => {
      const swarmsService = createMockSwarmsService();
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: JSON.stringify({ task: "Research Solana ecosystem" }),
      });
      const callback = createMockCallback();

      // "research Solana" matches ResearchPipeline via \bresearch\b/i
      await delegateToSwarm.handler(
        runtime, createMockMessage("research Solana ecosystem"), undefined, undefined, callback
      );

      // useModel should be called once for task extraction, NOT for full swarm config
      expect(runtime.useModel).toHaveBeenCalledTimes(1);
      // The runSwarm call should use template agents (Researcher, FactChecker, Writer)
      const callArgs = swarmsService.runSwarm.mock.calls[0][0];
      expect(callArgs.swarm_type).toBe("SequentialWorkflow");
      expect(callArgs.agents).toHaveLength(3);
      expect(callArgs.agents.map((a: any) => a.agent_name)).toEqual([
        "Researcher",
        "FactChecker",
        "Writer",
      ]);
    });

    it("custom fallback when no template matches uses default agents", async () => {
      const swarmsService = createMockSwarmsService();
      // Classification returns "custom", then full extraction returns invalid JSON -> defaults
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: "not valid json",
      });
      const callback = createMockCallback();

      // "hello world" doesn't match any template keywords
      await delegateToSwarm.handler(
        runtime, createMockMessage("hello world"), undefined, undefined, callback
      );

      const callArgs = swarmsService.runSwarm.mock.calls[0][0];
      expect(callArgs.swarm_type).toBe("auto");
      // Default agents when everything fails
      expect(callArgs.agents.map((a: any) => a.agent_name)).toEqual([
        "Researcher",
        "Analyst",
      ]);
    });

    it("handles swarm API error gracefully", async () => {
      const swarmsService = createMockSwarmsService({
        runSwarmError: new Error("Rate limit exceeded"),
      });
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService },
        useModelReturn: '{"task":"test"}',
      });
      const callback = createMockCallback();

      await delegateToSwarm.handler(
        runtime, createMockMessage("test"), undefined, undefined, callback
      );

      const calls = (callback as any).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.error).toBe(true);
      expect(lastCall.text).toContain("Rate limit exceeded");
    });
  });
});
