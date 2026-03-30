import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
} from "@elizaos/core";
import { searchAPIs, type DiscoveredAPI } from "@dexterai/x402/client";

export const discoverServices: Action = {
  name: "DISCOVER_X402_SERVICES",
  description:
    "Discover available x402-protected services on the OpenDexter marketplace. Returns a list of services with their prices and endpoints.",
  similes: [
    "LIST_X402_SERVICES",
    "FIND_PAID_APIS",
    "BROWSE_X402_MARKETPLACE",
    "SEARCH_SERVICES",
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => true,

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<{ success: boolean; text?: string; error?: string } | undefined> => {
    const query = (message.content.text ?? "").toLowerCase();

    let apis: DiscoveredAPI[];
    try {
      apis = await searchAPIs({
        query: query || undefined,
        limit: 10,
        sort: "quality_score",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({
        text: `Failed to search OpenDexter marketplace: ${msg}`,
        error: true,
      });
      return { success: false, error: msg };
    }

    if (apis.length === 0) {
      await callback?.({
        text: "No x402 services found matching your query on OpenDexter.",
      });
      return { success: true, text: "No services found" };
    }

    const lines = apis.map(
      (s) =>
        `**${s.name}** (${s.category})${s.verified ? " [verified]" : ""}\n  ${s.description}\n  Price: ${s.price}/call | Network: ${s.network ?? "multi"}\n  Endpoint: ${s.url}`
    );

    const text = `Found ${apis.length} x402 service(s) on OpenDexter:\n\n${lines.join("\n\n")}`;

    await callback?.({
      text,
      content: {
        serviceCount: String(apis.length),
        serviceNames: apis.map((a) => a.name).join(", "),
      },
    });
    return { success: true, text };
  },

  examples: [
    [
      {
        name: "user",
        content: { text: "What x402 services are available?" },
      },
      {
        name: "agent",
        content: {
          text: "Found 3 x402 service(s) on OpenDexter:\n\n**Exa Search** ...",
          actions: ["DISCOVER_X402_SERVICES"],
        },
      },
    ],
  ],
};
