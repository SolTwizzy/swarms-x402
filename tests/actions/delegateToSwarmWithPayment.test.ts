import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMockRuntime,
  createMockCallback,
  createMockMessage,
  createMockWalletService,
  createMockBudgetAccount,
} from "../setup.js";
import { MOCK_APIS } from "../fixtures.js";

vi.mock("@dexterai/x402/client", () => ({
  searchAPIs: vi.fn(async () => []),
}));

import { delegateToSwarmWithPayment } from "../../src/actions/delegateToSwarmWithPayment.js";
import { searchAPIs } from "@dexterai/x402/client";

const mockedSearchAPIs = vi.mocked(searchAPIs);

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

describe("delegateToSwarmWithPayment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validate()", () => {
    it("returns true when both SWARMS_API_KEY and EVM_PRIVATE_KEY set", async () => {
      const runtime = createMockRuntime({
        settings: { SWARMS_API_KEY: "sk-test", EVM_PRIVATE_KEY: "0xabc" },
      });
      expect(
        await delegateToSwarmWithPayment.validate(runtime, createMockMessage("test"))
      ).toBe(true);
    });

    it("returns false when only SWARMS_API_KEY set (no wallet)", async () => {
      const runtime = createMockRuntime({
        settings: { SWARMS_API_KEY: "sk-test" },
      });
      expect(
        await delegateToSwarmWithPayment.validate(runtime, createMockMessage("test"))
      ).toBe(false);
    });

    it("returns false when only EVM_PRIVATE_KEY set (no swarms)", async () => {
      const runtime = createMockRuntime({
        settings: { EVM_PRIVATE_KEY: "0xabc" },
      });
      expect(
        await delegateToSwarmWithPayment.validate(runtime, createMockMessage("test"))
      ).toBe(false);
    });

    it("returns false when neither set", async () => {
      const runtime = createMockRuntime({ settings: {} });
      expect(
        await delegateToSwarmWithPayment.validate(runtime, createMockMessage("test"))
      ).toBe(false);
    });
  });

  describe("handler()", () => {
    it("returns error when swarms service unavailable", async () => {
      const walletService = createMockWalletService();
      const runtime = createMockRuntime({
        services: { X402_WALLET: walletService },
      });
      const callback = createMockCallback();

      await delegateToSwarmWithPayment.handler(
        runtime, createMockMessage("research defi"), undefined, undefined, callback
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ error: true, text: expect.stringContaining("not available") })
      );
    });

    it("returns error when wallet not configured", async () => {
      const swarmsService = createMockSwarmsService();
      const walletService = createMockWalletService({ budgetAccount: null });
      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService, X402_WALLET: walletService },
        useModelReturn: '{"task":"test","keywords":["test"]}',
      });
      const callback = createMockCallback();

      await delegateToSwarmWithPayment.handler(
        runtime, createMockMessage("test"), undefined, undefined, callback
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ error: true, text: expect.stringContaining("Wallet") })
      );
    });

    it("calls searchAPIs with extracted keywords", async () => {
      const swarmsService = createMockSwarmsService();
      const walletService = createMockWalletService();
      mockedSearchAPIs.mockResolvedValue([]);

      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService, X402_WALLET: walletService },
        useModelReturn: JSON.stringify({
          task: "Analyze DeFi risks",
          keywords: ["defi", "risk"],
          category: "defi",
        }),
      });
      const callback = createMockCallback();

      await delegateToSwarmWithPayment.handler(
        runtime, createMockMessage("analyze defi risks"), undefined, undefined, callback
      );

      // searchAPIs called with keyword query and category query
      expect(mockedSearchAPIs).toHaveBeenCalledWith(
        expect.objectContaining({ query: "defi risk" })
      );
      expect(mockedSearchAPIs).toHaveBeenCalledWith(
        expect.objectContaining({ query: "defi" })
      );
    });

    it("calls payForResource for discovered services", async () => {
      const swarmsService = createMockSwarmsService();
      const walletService = createMockWalletService({
        payForResourceResult: {
          txHash: "0xtx1",
          network: "eip155:84532",
          payer: "0x1234",
          amountUsd: 0.05,
          receipt: { success: true },
          response: new Response('{"data":"api-response-1"}', { status: 200 }),
        },
      });
      mockedSearchAPIs.mockResolvedValue(MOCK_APIS);

      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService, X402_WALLET: walletService },
        useModelReturn: JSON.stringify({
          task: "Get price data",
          keywords: ["price"],
        }),
      });
      const callback = createMockCallback();

      await delegateToSwarmWithPayment.handler(
        runtime, createMockMessage("get price data"), undefined, undefined, callback
      );

      // payForResource called for each discovered API (up to MAX_PREFETCH_SERVICES=3)
      expect(walletService.payForResource).toHaveBeenCalledWith(MOCK_APIS[0].url);
      expect(walletService.payForResource).toHaveBeenCalledWith(MOCK_APIS[1].url);
      expect(walletService.payForResource).toHaveBeenCalledTimes(2);
    });

    it("passes augmented task to runSwarm containing AVAILABLE DATA section", async () => {
      const swarmsService = createMockSwarmsService();
      const walletService = createMockWalletService({
        payForResourceResult: {
          txHash: "0xtx1",
          network: "eip155:84532",
          payer: "0x1234",
          amountUsd: 0.05,
          receipt: { success: true },
          response: new Response('{"price":"42000"}', { status: 200 }),
        },
      });
      mockedSearchAPIs.mockResolvedValue([MOCK_APIS[0]]);

      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService, X402_WALLET: walletService },
        useModelReturn: JSON.stringify({
          task: "Analyze BTC price",
          keywords: ["btc", "price"],
        }),
      });
      const callback = createMockCallback();

      await delegateToSwarmWithPayment.handler(
        runtime, createMockMessage("analyze btc price"), undefined, undefined, callback
      );

      const swarmCallArgs = swarmsService.runSwarm.mock.calls[0][0];
      expect(swarmCallArgs.task).toContain("AVAILABLE DATA");
      expect(swarmCallArgs.task).toContain("Exa Search");
      expect(swarmCallArgs.task).toContain('{"price":"42000"}');
    });

    it("handles pre-fetch failure gracefully (swarm still runs without data)", async () => {
      const swarmsService = createMockSwarmsService();
      const walletService = createMockWalletService();
      // payForResource throws for all calls
      (walletService.payForResource as any).mockRejectedValue(new Error("Payment failed"));
      mockedSearchAPIs.mockResolvedValue([MOCK_APIS[0]]);

      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService, X402_WALLET: walletService },
        useModelReturn: JSON.stringify({
          task: "Analyze market",
          keywords: ["market"],
        }),
      });
      const callback = createMockCallback();

      await delegateToSwarmWithPayment.handler(
        runtime, createMockMessage("analyze market"), undefined, undefined, callback
      );

      // Swarm should still have been called despite payment failure
      expect(swarmsService.runSwarm).toHaveBeenCalled();
      // Task should NOT contain AVAILABLE DATA since all fetches failed
      const swarmCallArgs = swarmsService.runSwarm.mock.calls[0][0];
      expect(swarmCallArgs.task).not.toContain("AVAILABLE DATA");
      expect(swarmCallArgs.task).toContain("No external data");
    });

    it("handles empty marketplace results (no APIs found, swarm runs with no data)", async () => {
      const swarmsService = createMockSwarmsService();
      const walletService = createMockWalletService();
      mockedSearchAPIs.mockResolvedValue([]);

      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService, X402_WALLET: walletService },
        useModelReturn: JSON.stringify({
          task: "Do analysis",
          keywords: ["analysis"],
        }),
      });
      const callback = createMockCallback();

      await delegateToSwarmWithPayment.handler(
        runtime, createMockMessage("do analysis"), undefined, undefined, callback
      );

      // Swarm still runs
      expect(swarmsService.runSwarm).toHaveBeenCalled();
      // No payForResource calls since no APIs discovered
      expect(walletService.payForResource).not.toHaveBeenCalled();
      // Task should indicate no data
      const swarmCallArgs = swarmsService.runSwarm.mock.calls[0][0];
      expect(swarmCallArgs.task).toContain("No external data");
    });

    it("includes payment summary in result (service names, amounts, total spend)", async () => {
      const swarmsService = createMockSwarmsService({
        runSwarmResult: {
          job_id: "job-pay",
          status: "success",
          swarm_type: "SequentialWorkflow",
          number_of_agents: 2,
          output: "Results with paid data",
          execution_time: 5.0,
          usage: {},
        },
      });
      const walletService = createMockWalletService({
        payForResourceResult: {
          txHash: "0xtx-pay",
          network: "eip155:84532",
          payer: "0x1234",
          amountUsd: 0.05,
          receipt: { success: true },
          response: new Response('{"data":"result"}', { status: 200 }),
        },
      });
      mockedSearchAPIs.mockResolvedValue([MOCK_APIS[0]]);

      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService, X402_WALLET: walletService },
        useModelReturn: JSON.stringify({
          task: "Get data",
          keywords: ["data"],
        }),
      });
      const callback = createMockCallback();

      await delegateToSwarmWithPayment.handler(
        runtime, createMockMessage("get data"), undefined, undefined, callback
      );

      const calls = (callback as any).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      // Should contain service name and amount
      expect(lastCall.text).toContain("Exa Search");
      expect(lastCall.text).toContain("$0.0500");
      // Total spend in the content metadata
      expect(lastCall.content.totalX402Spend).toBe("0.05");
      expect(lastCall.content.dataSourceCount).toBe("1");
    });

    it("uses template when keyword matches (e.g. research X uses ResearchPipeline)", async () => {
      const swarmsService = createMockSwarmsService();
      const walletService = createMockWalletService();
      mockedSearchAPIs.mockResolvedValue([]);

      const runtime = createMockRuntime({
        services: { SWARMS: swarmsService, X402_WALLET: walletService },
        useModelReturn: JSON.stringify({
          task: "Research Solana ecosystem",
          keywords: ["solana"],
        }),
      });
      const callback = createMockCallback();

      // "research Solana" matches ResearchPipeline via \bresearch\b/i
      await delegateToSwarmWithPayment.handler(
        runtime, createMockMessage("research Solana ecosystem"), undefined, undefined, callback
      );

      const swarmCallArgs = swarmsService.runSwarm.mock.calls[0][0];
      expect(swarmCallArgs.swarm_type).toBe("SequentialWorkflow");
      expect(swarmCallArgs.agents).toHaveLength(3);
      expect(swarmCallArgs.agents.map((a: any) => a.agent_name)).toEqual([
        "Researcher",
        "FactChecker",
        "Writer",
      ]);
    });
  });
});
