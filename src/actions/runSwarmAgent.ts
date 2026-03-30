import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  ModelType,
} from "@elizaos/core";
import { z } from "zod";
import { SwarmsService } from "../services/swarmsService.js";

const AgentSchema = z.object({
  task: z.string().min(1),
  agentName: z.string().optional().default("GeneralAgent"),
  systemPrompt: z.string().optional(),
  modelName: z.string().optional().default("gpt-4o-mini"),
  maxTokens: z.number().optional().default(4096),
  temperature: z.number().optional().default(0.5),
});

/**
 * Run a single specialized agent via the Swarms API.
 * For quick single-agent tasks that don't need multi-agent orchestration.
 */
export const runSwarmAgent: Action = {
  name: "RUN_SWARM_AGENT",
  description:
    "Run a single specialized AI agent via the Swarms cloud API. Use for focused tasks that need a specific agent role or model. For multi-agent tasks, use DELEGATE_TO_SWARM instead.",
  similes: [
    "CALL_SWARM_AGENT",
    "USE_SINGLE_AGENT",
    "SWARM_AGENT_RUN",
    "ASK_SWARM_AGENT",
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => {
    return !!runtime.getSetting("SWARMS_API_KEY");
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<{ success: boolean; text?: string; error?: string } | undefined> => {
    const swarmsService = runtime.getService<SwarmsService>("SWARMS" as any);
    if (!swarmsService || !swarmsService.isAvailable()) {
      await callback?.({
        text: "Swarms service not initialized. Set SWARMS_API_KEY in your environment.",
        error: true,
      });
      return { success: false, error: "Swarms service not initialized" };
    }

    // Extract agent config from message
    const extraction = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: `Extract agent task details from the user message. Return JSON with:
- task: string (what the agent should do)
- agentName: string (a descriptive name like "CodeReviewer", "DataAnalyst", "Writer")
- systemPrompt: optional string (specific instructions for the agent)
- modelName: optional string (e.g. "gpt-4o", "gpt-4o-mini", "claude-3-sonnet-20240229")
- maxTokens: optional number (default 4096)
- temperature: optional number (0.0-1.0, default 0.5)

User message: "${message.content.text ?? ""}"

Return only valid JSON, no markdown.`,
    });

    let params: z.infer<typeof AgentSchema>;
    try {
      params = AgentSchema.parse(JSON.parse(String(extraction)));
    } catch {
      params = {
        task: message.content.text ?? "unspecified task",
        agentName: "GeneralAgent",
        modelName: "gpt-4o-mini",
        maxTokens: 4096,
        temperature: 0.5,
      };
    }

    await callback?.({
      text: `Running agent "${params.agentName}" (${params.modelName})...`,
    });

    try {
      const result = await swarmsService.runAgent(
        {
          agent_name: params.agentName,
          system_prompt: params.systemPrompt ?? null,
          model_name: params.modelName,
          max_tokens: params.maxTokens,
          temperature: params.temperature,
          max_loops: 1,
        },
        params.task
      );

      // Extract output
      let output: string;
      if (typeof result.outputs === "string") {
        output = result.outputs;
      } else if (
        result.outputs != null &&
        typeof result.outputs === "object" &&
        "content" in (result.outputs as any)
      ) {
        output = (result.outputs as any).content;
      } else if (result.outputs != null) {
        output = JSON.stringify(result.outputs, null, 2);
      } else {
        output = "(no output)";
      }

      const text = `Agent "${params.agentName}" completed.

${output.slice(0, 1500)}`;

      await callback?.({
        text,
        content: {
          agentId: String(result.job_id ?? ""),
          agentName: params.agentName,
          success: String(result.success ?? true),
        },
      });
      return { success: true, text };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({
        text: `Agent run failed: ${msg}`,
        error: true,
      });
      return { success: false, error: msg };
    }
  },

  examples: [
    [
      {
        name: "user",
        content: {
          text: "Use a code review agent to review this smart contract for vulnerabilities",
        },
      },
      {
        name: "agent",
        content: {
          text: 'Agent "CodeReviewer" completed.\n\n[detailed review]...',
          actions: ["RUN_SWARM_AGENT"],
        },
      },
    ],
  ],
};
