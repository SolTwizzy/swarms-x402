import { Service, type IAgentRuntime } from "@elizaos/core";
import type {
  AgentSpec,
  SwarmRunParams,
} from "swarms-ts/resources";

export type SwarmType = NonNullable<SwarmRunParams["swarm_type"]>;

// The swarms-ts SDK has outdated endpoints. We call the API directly.
const SWARMS_API_BASE = "https://api.swarms.world";

/**
 * Response from /v1/agent/completions
 */
export interface AgentRunResponse {
  job_id?: string;
  success?: boolean;
  name?: string;
  outputs?: Array<{ role?: string; content?: string }>;
  output?: string;
  usage?: { total_tokens?: number; total_cost?: number };
  [key: string]: unknown;
}

/**
 * Response from /v1/swarm/completions
 */
export interface SwarmRunResponse {
  job_id?: string;
  status?: string;
  swarm_name?: string;
  swarm_type?: string;
  output?: unknown;
  number_of_agents?: number;
  execution_time?: number;
  usage?: { total_cost?: number };
  [key: string]: unknown;
}

/**
 * Wraps the Swarms API for multi-agent orchestration.
 * Uses direct fetch to api.swarms.world/v1/* endpoints.
 */
export class SwarmsService extends Service {
  static serviceType = "SWARMS";
  capabilityDescription =
    "Multi-agent orchestration via Swarms API — sequential, concurrent, hierarchical, mixture-of-agents, and 15+ swarm architectures";

  private apiKey: string | null = null;

  static async start(runtime: IAgentRuntime): Promise<SwarmsService> {
    const instance = new SwarmsService(runtime);
    await instance.initialize(runtime);
    return instance;
  }

  async stop(): Promise<void> {
    this.apiKey = null;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    const apiKey = runtime.getSetting("SWARMS_API_KEY");

    if (!apiKey) {
      runtime.logger.warn(
        "[SwarmsService] SWARMS_API_KEY not set. Swarm features disabled."
      );
      return;
    }

    this.apiKey = String(apiKey);
    runtime.logger.info("[SwarmsService] Initialized with Swarms API (direct)");
  }

  isAvailable(): boolean {
    return this.apiKey !== null;
  }

  private async apiCall(path: string, body: unknown): Promise<any> {
    if (!this.apiKey) {
      throw new Error("Swarms client not initialized — set SWARMS_API_KEY");
    }

    const res = await fetch(`${SWARMS_API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Swarms API ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json();
  }

  /**
   * Run a single agent with the Swarms API.
   * Endpoint: POST /v1/agent/completions
   */
  async runAgent(
    config: AgentSpec,
    task: string
  ): Promise<AgentRunResponse> {
    const startTime = Date.now();
    const result = await this.apiCall("/v1/agent/completions", {
      agent_config: config,
      task,
    });
    const elapsed = Date.now() - startTime;
    if (elapsed > 30000) {
      console.warn(`[SwarmsService] runAgent slow: ${elapsed}ms for "${config.agent_name}"`);
    }
    return result;
  }

  /**
   * Run a multi-agent swarm.
   * Endpoint: POST /v1/swarm/completions
   */
  async runSwarm(params: SwarmRunParams): Promise<SwarmRunResponse> {
    const agentCount = params.agents?.length ?? 0;
    const startTime = Date.now();
    const result = await this.apiCall("/v1/swarm/completions", params);
    const elapsed = Date.now() - startTime;
    if (elapsed > 60000) {
      console.warn(`[SwarmsService] runSwarm slow: ${elapsed}ms, ${agentCount} agents, type=${params.swarm_type}`);
    }
    return result;
  }

  /**
   * List available swarm types from the API.
   */
  async getAvailableSwarmTypes(): Promise<string[]> {
    if (!this.apiKey) return [];
    try {
      const res = await fetch(`${SWARMS_API_BASE}/v1/swarms/available`, {
        headers: { "x-api-key": this.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const data: any = await res.json();
      return Array.isArray(data.swarm_types) ? data.swarm_types : [];
    } catch {
      return [];
    }
  }
}
