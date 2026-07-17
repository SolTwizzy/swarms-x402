import { describe, it, expect, afterEach } from "vitest";
import {
  findMatchingTemplate,
  registerSwarmTemplate,
  buildClassificationPrompt,
  SWARM_TEMPLATES,
} from "../../src/templates/index.js";
import type { SwarmTemplate } from "../../src/types.js";

describe("findMatchingTemplate", () => {
  it("returns CodeReview for 'review this code'", () => {
    const result = findMatchingTemplate("review this code");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("code-review");
  });

  it("returns CodeReview for 'audit this smart contract'", () => {
    const result = findMatchingTemplate("audit this smart contract");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("code-review");
  });

  it("returns DebateAndDecide for 'should I invest in ETH?'", () => {
    const result = findMatchingTemplate("should I invest in ETH?");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("debate-and-decide");
  });

  it("returns ResearchPipeline for 'research the latest DeFi trends'", () => {
    const result = findMatchingTemplate("research the latest DeFi trends");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("research-pipeline");
  });

  it("returns AnalysisPanel for 'evaluate this proposal'", () => {
    const result = findMatchingTemplate("evaluate this proposal");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("analysis-panel");
  });

  it("returns null for inputs that match no template", () => {
    expect(findMatchingTemplate("hello there")).toBeNull();
    expect(findMatchingTemplate("send 5 ETH to Bob")).toBeNull();
    expect(findMatchingTemplate("what time is it")).toBeNull();
    expect(findMatchingTemplate("")).toBeNull();
  });

  it("prioritizes CodeReview over AnalysisPanel for 'analyze this code for vulnerabilities'", () => {
    // "analyze" matches AnalysisPanel, but "vulnerabilit" matches CodeReview
    // CodeReview is earlier in the registry (higher priority)
    const result = findMatchingTemplate("analyze this code for vulnerabilities");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("code-review");
  });

  it("prioritizes CodeReview over AnalysisPanel for ambiguous 'code review and analysis'", () => {
    // "code review" matches CodeReview, "analysis" could match AnalysisPanel
    // CodeReview is first in registry
    const result = findMatchingTemplate("code review and analysis");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("code-review");
  });

  it("returns ResearchPipeline for 'write a report about BTC'", () => {
    const result = findMatchingTemplate("write a report about BTC");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("research-pipeline");
  });

  it("handles null/undefined-like input", () => {
    expect(findMatchingTemplate("")).toBeNull();
  });
});

describe("registerSwarmTemplate", () => {
  const originalLength = SWARM_TEMPLATES.length;

  afterEach(() => {
    // Clean up any templates added during tests
    while (SWARM_TEMPLATES.length > originalLength) {
      SWARM_TEMPLATES.pop();
    }
  });

  it("adds a custom template to the registry", () => {
    const custom: SwarmTemplate = {
      id: "test-custom",
      name: "TestCustom",
      description: "A test custom template",
      swarmType: "GroupChat",
      triggerPatterns: [/\bbrainstorm\b/i],
      triggerExamples: ["brainstorm ideas"],
      agents: [
        {
          agent_name: "Idea1",
          system_prompt: "Generate ideas",
          model_name: "gpt-5-mini",
          temperature: 0.8,
        },
      ],
    };

    registerSwarmTemplate(custom);
    expect(SWARM_TEMPLATES).toHaveLength(originalLength + 1);
    expect(SWARM_TEMPLATES[SWARM_TEMPLATES.length - 1].id).toBe("test-custom");
  });

  it("custom template is found by findMatchingTemplate", () => {
    const custom: SwarmTemplate = {
      id: "test-brainstorm",
      name: "TestBrainstorm",
      description: "Brainstorm ideas",
      swarmType: "GroupChat",
      triggerPatterns: [/\bbrainstorm\b/i],
      triggerExamples: ["brainstorm ideas"],
      agents: [
        {
          agent_name: "IdeaGen",
          system_prompt: "Generate ideas",
          model_name: "gpt-5-mini",
          temperature: 0.9,
        },
      ],
    };

    registerSwarmTemplate(custom);
    const result = findMatchingTemplate("brainstorm some ideas for the project");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("test-brainstorm");
  });
});

describe("buildClassificationPrompt", () => {
  it("includes all template IDs", () => {
    const prompt = buildClassificationPrompt("test message");
    for (const t of SWARM_TEMPLATES) {
      expect(prompt).toContain(t.id);
    }
  });

  it("includes the user message", () => {
    const prompt = buildClassificationPrompt("analyze DeFi risks");
    expect(prompt).toContain("analyze DeFi risks");
  });

  it("includes 'custom' as a fallback option", () => {
    const prompt = buildClassificationPrompt("test");
    expect(prompt).toContain('"custom"');
  });

  it("includes template descriptions", () => {
    const prompt = buildClassificationPrompt("test");
    for (const t of SWARM_TEMPLATES) {
      expect(prompt).toContain(t.description);
    }
  });

  it("requests JSON output format", () => {
    const prompt = buildClassificationPrompt("test");
    expect(prompt).toContain("templateId");
    expect(prompt).toContain("JSON");
  });
});
