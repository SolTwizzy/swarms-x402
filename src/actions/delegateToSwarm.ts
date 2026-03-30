import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  ModelType,
} from "@elizaos/core";
import { z } from "zod";
import { SwarmsService, type SwarmType } from "../services/swarmsService.js";
import type { AgentSpec } from "swarms-ts/resources";
import type { SwarmTemplate } from "../types.js";
import {
  findMatchingTemplate,
  SWARM_TEMPLATES,
  buildClassificationPrompt,
} from "../templates/index.js";

const VALID_SWARM_TYPES = [
  "SequentialWorkflow",
  "ConcurrentWorkflow",
  "MixtureOfAgents",
  "AgentRearrange",
  "HiearchicalSwarm",
  "GroupChat",
  "MultiAgentRouter",
  "AutoSwarmBuilder",
  "MajorityVoting",
  "HeavySwarm",
  "DeepResearchSwarm",
  "auto",
] as const;

const DelegateSchema = z.object({
  task: z.string().min(1),
  swarmType: z.enum(VALID_SWARM_TYPES).optional().default("auto"),
  agents: z
    .array(
      z.object({
        agent_name: z.string(),
        system_prompt: z.string().optional(),
        model_name: z.string().optional(),
        role: z.string().optional(),
      })
    )
    .optional(),
  maxLoops: z.number().positive().optional(),
});

/** Schema for LLM classification when no keyword match */
const ClassificationSchema = z.object({
  templateId: z.string(),
  task: z.string().min(1),
});

/** Schema for minimal task extraction when template is pre-matched */
const TaskExtractionSchema = z.object({
  task: z.string().min(1),
});

/**
 * Build SwarmRunParams from a matched template and extracted task string.
 */
function buildParamsFromTemplate(
  template: SwarmTemplate,
  task: string
): {
  task: string;
  swarmType: string;
  agents: AgentSpec[];
  maxLoops: number;
  rules?: string;
} {
  return {
    task,
    swarmType: template.swarmType,
    agents: template.agents.map((a) => ({
      agent_name: a.agent_name,
      system_prompt: a.system_prompt ?? null,
      model_name: a.model_name ?? "gpt-4o-mini",
      role: a.role ?? "worker",
      max_loops: a.max_loops ?? 1,
      max_tokens: a.max_tokens ?? 4096,
      temperature: a.temperature ?? 0.5,
    })),
    maxLoops: template.maxLoops ?? 1,
    rules: template.rules,
  };
}

/**
 * Delegate a task to a Swarms multi-agent system.
 * Supports 15+ swarm architectures: sequential, concurrent, hierarchical, mixture-of-agents, etc.
 * Uses pre-built templates for common patterns, with full LLM extraction as fallback.
 */
export const delegateToSwarm: Action = {
  name: "DELEGATE_TO_SWARM",
  description:
    "Delegate a complex task to a Swarms multi-agent system. Supports sequential pipelines, concurrent processing, mixture-of-agents, hierarchical delegation, group chat, and more. Set swarm_type to control the architecture.",
  similes: [
    "RUN_SWARM_TASK",
    "USE_SWARM_AGENT",
    "MULTI_AGENT_TASK",
    "SWARMS_PAY_AND_RUN",
    "RUN_MULTI_AGENT",
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

    const userText = message.content.text ?? "";
    let task: string | undefined;
    let swarmType: string;
    let agents: AgentSpec[];
    let maxLoops: number;
    let templateName: string | null = null;

    // --- Step 1: Try keyword pre-filter for fast template matching ---
    let matchedTemplate = findMatchingTemplate(userText);

    // --- Step 2: If no keyword match, use LLM classification ---
    if (!matchedTemplate) {
      const classificationPrompt = buildClassificationPrompt(userText);
      const classificationResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: classificationPrompt,
      });

      try {
        const parsed = ClassificationSchema.parse(
          JSON.parse(String(classificationResult))
        );
        if (parsed.templateId !== "custom") {
          matchedTemplate =
            SWARM_TEMPLATES.find((t) => t.id === parsed.templateId) ?? null;
        }
        // Use the LLM-extracted task if we got one (useful for both template and custom paths)
        if (parsed.task) {
          task = parsed.task;
        }
      } catch {
        // Classification failed — fall through to custom path
      }
    }

    // --- Step 3: Build params from template or fall back to full custom extraction ---
    if (matchedTemplate) {
      // Template matched — only need to extract the task string if not already set
      if (!task) {
        const taskExtraction = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: `Extract the specific task the user wants performed from their message. Return JSON: { "task": "<the task>" }

User message: "${userText}"

Return only valid JSON, no markdown.`,
        });
        try {
          const parsed = TaskExtractionSchema.parse(
            JSON.parse(String(taskExtraction))
          );
          task = parsed.task;
        } catch {
          task = userText;
        }
      }

      const templateParams = buildParamsFromTemplate(matchedTemplate, task);
      swarmType = templateParams.swarmType;
      agents = templateParams.agents;
      maxLoops = templateParams.maxLoops;
      templateName = matchedTemplate.name;
    } else {
      // Custom path — full LLM extraction with VALID_SWARM_TYPES and DelegateSchema
      const extraction = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: `Extract swarm task details from the user message. Return JSON with:
- task: string (the task description)
- swarmType: one of ${VALID_SWARM_TYPES.join(", ")} (default "auto" if unclear)
- agents: optional array of { agent_name, system_prompt?, model_name?, role? }
  Only include agents if the user specifies specific agent roles.
- maxLoops: optional number (default 1)

Guidelines for swarmType selection:
- "SequentialWorkflow" for step-by-step pipelines (research -> write -> edit)
- "ConcurrentWorkflow" for independent parallel tasks
- "MixtureOfAgents" for getting multiple expert perspectives synthesized
- "HiearchicalSwarm" for complex projects needing a director + workers
- "GroupChat" for brainstorming or collaborative discussion
- "HeavySwarm" for deep research requiring thorough investigation
- "MajorityVoting" for decisions needing consensus
- "auto" when unsure — the API picks the best architecture

User message: "${userText}"

Return only valid JSON, no markdown.`,
      });

      let params: z.infer<typeof DelegateSchema>;
      try {
        params = DelegateSchema.parse(JSON.parse(String(extraction)));
      } catch {
        params = { task: userText || "unspecified task", swarmType: "auto" };
      }

      task = params.task;
      swarmType = params.swarmType;
      maxLoops = params.maxLoops ?? 1;

      // Build agent specs — use extracted agents or sensible defaults
      agents =
        params.agents && params.agents.length > 0
          ? params.agents.map((a) => ({
              agent_name: a.agent_name,
              system_prompt: a.system_prompt ?? null,
              model_name: a.model_name ?? "gpt-4o-mini",
              role: a.role ?? "worker",
              max_loops: 1,
              max_tokens: 4096,
              temperature: 0.5,
            }))
          : [
              {
                agent_name: "Researcher",
                system_prompt:
                  "You are a thorough researcher. Analyze the task, gather key information, and provide detailed findings.",
                model_name: "gpt-4o-mini",
                role: "worker",
                max_loops: 1,
                max_tokens: 4096,
                temperature: 0.5,
              },
              {
                agent_name: "Analyst",
                system_prompt:
                  "You are an expert analyst. Take the research findings and produce actionable insights and recommendations.",
                model_name: "gpt-4o-mini",
                role: "worker",
                max_loops: 1,
                max_tokens: 4096,
                temperature: 0.3,
              },
            ];
    }

    const templateLabel = templateName
      ? ` [${templateName}]`
      : "";
    await callback?.({
      text: `Delegating to swarm (${swarmType})${templateLabel} with ${agents.length} agent(s)...\nAgents: ${agents.map((a) => a.agent_name).join(", ")}`,
    });

    try {
      const result = await swarmsService.runSwarm({
        name: `ElizaOS-x402-${Date.now()}`,
        description: `Task delegated from ElizaOS agent`,
        agents,
        task,
        swarm_type: swarmType as SwarmType,
        max_loops: maxLoops,
      });

      // Extract output — can be string, object, or nested
      let output: string;
      if (typeof result.output === "string") {
        output = result.output;
      } else if (result.output != null) {
        output = JSON.stringify(result.output, null, 2);
      } else {
        output = "(no output)";
      }

      const text = `Swarm completed (${result.swarm_type ?? swarmType})${templateLabel}

Agents: ${result.number_of_agents ?? agents.length}
Execution time: ${result.execution_time != null ? `${result.execution_time.toFixed(1)}s` : "unknown"}
Job ID: ${result.job_id ?? "unknown"}

Result:
${output.slice(0, 1000)}`;

      await callback?.({
        text,
        content: {
          jobId: result.job_id ?? "",
          swarmType: result.swarm_type ?? swarmType,
          templateName: templateName ?? undefined,
          executionTime: String(result.execution_time ?? 0),
          agentCount: String(result.number_of_agents ?? agents.length),
        },
      });
      return { success: true, text };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({
        text: `Swarm delegation failed: ${msg}`,
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
          text: "Use the swarm to analyze top DeFi protocols and summarize risks",
        },
      },
      {
        name: "agent",
        content: {
          text: "Swarm completed (SequentialWorkflow)\n\nAgents: 2\nExecution time: 12.3s\n\nResult: [detailed analysis]...",
          actions: ["DELEGATE_TO_SWARM"],
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Run a concurrent swarm with 3 agents to research Bitcoin, Ethereum, and Solana simultaneously",
        },
      },
      {
        name: "agent",
        content: {
          text: "Swarm completed (ConcurrentWorkflow)\n\nAgents: 3\nExecution time: 8.1s\n\nResult: [parallel research results]...",
          actions: ["DELEGATE_TO_SWARM"],
        },
      },
    ],
  ],
};
