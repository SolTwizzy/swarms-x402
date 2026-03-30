import { describe, it, expect } from "vitest";
import {
  researchPipelineTemplate,
  analysisPanelTemplate,
  codeReviewTemplate,
  debateAndDecideTemplate,
  SWARM_TEMPLATES,
} from "../../src/templates/index.js";

const ALL_TEMPLATES = [
  researchPipelineTemplate,
  analysisPanelTemplate,
  codeReviewTemplate,
  debateAndDecideTemplate,
];

describe("swarmTemplates", () => {
  it("exports exactly 4 templates in the registry", () => {
    expect(SWARM_TEMPLATES).toHaveLength(4);
  });

  it("registry contains all 4 named templates", () => {
    const ids = SWARM_TEMPLATES.map((t) => t.id);
    expect(ids).toContain("research-pipeline");
    expect(ids).toContain("analysis-panel");
    expect(ids).toContain("code-review");
    expect(ids).toContain("debate-and-decide");
  });

  describe.each(ALL_TEMPLATES)("template '$id'", (template) => {
    it("has required string fields", () => {
      expect(typeof template.id).toBe("string");
      expect(template.id.length).toBeGreaterThan(0);
      expect(typeof template.name).toBe("string");
      expect(template.name.length).toBeGreaterThan(0);
      expect(typeof template.description).toBe("string");
      expect(template.description.length).toBeGreaterThan(0);
      expect(typeof template.swarmType).toBe("string");
      expect(template.swarmType.length).toBeGreaterThan(0);
    });

    it("has triggerPatterns array of RegExps", () => {
      expect(Array.isArray(template.triggerPatterns)).toBe(true);
      expect(template.triggerPatterns.length).toBeGreaterThan(0);
      for (const p of template.triggerPatterns) {
        expect(p).toBeInstanceOf(RegExp);
      }
    });

    it("has at least one agent with required fields", () => {
      expect(Array.isArray(template.agents)).toBe(true);
      expect(template.agents.length).toBeGreaterThan(0);
      for (const agent of template.agents) {
        expect(typeof agent.agent_name).toBe("string");
        expect(agent.agent_name.length).toBeGreaterThan(0);
        expect(typeof agent.system_prompt).toBe("string");
        expect(typeof agent.model_name).toBe("string");
        expect(typeof agent.temperature).toBe("number");
      }
    });
  });

  describe("ResearchPipeline", () => {
    it("has 3 agents in correct order", () => {
      const names = researchPipelineTemplate.agents.map((a) => a.agent_name);
      expect(names).toEqual(["Researcher", "FactChecker", "Writer"]);
    });

    it("uses SequentialWorkflow swarm type", () => {
      expect(researchPipelineTemplate.swarmType).toBe("SequentialWorkflow");
    });

    it("triggers match research-related phrases", () => {
      const patterns = researchPipelineTemplate.triggerPatterns;
      const match = (text: string) => patterns.some((p) => p.test(text));
      expect(match("research the latest AI trends")).toBe(true);
      expect(match("write a report on DeFi")).toBe(true);
      expect(match("summarize the findings")).toBe(true);
      expect(match("deep dive into tokenomics")).toBe(true);
      expect(match("investigate the hack")).toBe(true);
    });

    it("triggers do NOT match unrelated phrases", () => {
      const patterns = researchPipelineTemplate.triggerPatterns;
      const match = (text: string) => patterns.some((p) => p.test(text));
      expect(match("buy some tokens")).toBe(false);
      expect(match("swap ETH for USDC")).toBe(false);
    });
  });

  describe("AnalysisPanel", () => {
    it("has 4 agents including a Synthesizer", () => {
      expect(analysisPanelTemplate.agents).toHaveLength(4);
      const names = analysisPanelTemplate.agents.map((a) => a.agent_name);
      expect(names).toContain("Synthesizer");
    });

    it("uses MixtureOfAgents swarm type", () => {
      expect(analysisPanelTemplate.swarmType).toBe("MixtureOfAgents");
    });

    it("triggers match analysis-related phrases", () => {
      const patterns = analysisPanelTemplate.triggerPatterns;
      const match = (text: string) => patterns.some((p) => p.test(text));
      expect(match("analyze the market")).toBe(true);
      expect(match("evaluate this proposal")).toBe(true);
      expect(match("assess the risks")).toBe(true);
      expect(match("multi-angle review")).toBe(true);
    });
  });

  describe("CodeReview", () => {
    it("has 3 parallel review agents", () => {
      expect(codeReviewTemplate.agents).toHaveLength(3);
      const names = codeReviewTemplate.agents.map((a) => a.agent_name);
      expect(names).toContain("SecurityAuditor");
      expect(names).toContain("PerformanceReviewer");
      expect(names).toContain("StyleChecker");
    });

    it("uses ConcurrentWorkflow swarm type", () => {
      expect(codeReviewTemplate.swarmType).toBe("ConcurrentWorkflow");
    });

    it("triggers match code review phrases", () => {
      const patterns = codeReviewTemplate.triggerPatterns;
      const match = (text: string) => patterns.some((p) => p.test(text));
      expect(match("review this code")).toBe(true);
      expect(match("audit this smart contract")).toBe(true);
      expect(match("security check on the contract")).toBe(true);
      expect(match("check for vulnerabilities")).toBe(true);
      expect(match("code review please")).toBe(true);
    });

    it("triggers do NOT match unrelated phrases", () => {
      const patterns = codeReviewTemplate.triggerPatterns;
      const match = (text: string) => patterns.some((p) => p.test(text));
      expect(match("send some tokens")).toBe(false);
      expect(match("what is the weather")).toBe(false);
    });
  });

  describe("DebateAndDecide", () => {
    it("has 3 agents: Proponent, Opponent, Judge", () => {
      const names = debateAndDecideTemplate.agents.map((a) => a.agent_name);
      expect(names).toEqual(["Proponent", "Opponent", "Judge"]);
    });

    it("uses MajorityVoting swarm type", () => {
      expect(debateAndDecideTemplate.swarmType).toBe("MajorityVoting");
    });

    it("triggers match decision-related phrases", () => {
      const patterns = debateAndDecideTemplate.triggerPatterns;
      const match = (text: string) => patterns.some((p) => p.test(text));
      expect(match("should I invest in BTC?")).toBe(true);
      expect(match("debate whether this is a good idea")).toBe(true);
      expect(match("weigh the pros and cons")).toBe(true);
      expect(match("is it worth investing?")).toBe(true);
      expect(match("decide between option A and B")).toBe(true);
    });

    it("triggers do NOT match unrelated phrases", () => {
      const patterns = debateAndDecideTemplate.triggerPatterns;
      const match = (text: string) => patterns.some((p) => p.test(text));
      expect(match("transfer funds")).toBe(false);
      expect(match("hello there")).toBe(false);
    });
  });
});
