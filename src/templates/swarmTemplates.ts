import type { SwarmTemplate } from "../types.js";

/**
 * ResearchPipeline — Sequential chain: Researcher → FactChecker → Writer
 * Use for: research tasks, report writing, investigation, summarization
 */
export const researchPipelineTemplate: SwarmTemplate = {
  id: "research-pipeline",
  name: "ResearchPipeline",
  description: "Research, fact-check, and write a report on a topic",
  swarmType: "SequentialWorkflow",
  triggerPatterns: [
    /\bresearch\b/i,
    /\breport\b/i,
    /\bwrite\s.*\babout\b/i,
    /\bsummar(y|ize)\b/i,
    /\binvestigat/i,
    /\bdeep\s*dive\b/i,
  ],
  triggerExamples: [
    "research X",
    "write a report on X",
    "investigate X and summarize findings",
    "deep dive into X",
  ],
  agents: [
    {
      agent_name: "Researcher",
      system_prompt:
        "You are a thorough researcher. Gather comprehensive information about the topic. Identify key facts, data points, and sources. Be exhaustive in your coverage. Structure your findings clearly with headings.",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 4096,
      temperature: 0.7,
    },
    {
      agent_name: "FactChecker",
      system_prompt:
        "You are a meticulous fact-checker. Review the research provided by the previous agent. Verify claims, flag unsubstantiated assertions, correct errors, and rate confidence levels for each key finding. Mark each claim as [VERIFIED], [UNVERIFIED], or [DISPUTED].",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 4096,
      temperature: 0.2,
    },
    {
      agent_name: "Writer",
      system_prompt:
        "You are a skilled writer. Take the verified research and produce a clear, well-structured report. Include an executive summary, key findings, and recommendations. Use the fact-checker's confidence ratings to qualify claims appropriately. Write in a professional, concise style.",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 8192,
      temperature: 0.5,
    },
  ],
  maxLoops: 1,
  rules:
    "Each agent builds on the previous agent's output. The Researcher gathers raw information, the FactChecker verifies it, and the Writer produces the final deliverable.",
};

/**
 * AnalysisPanel — MixtureOfAgents: 3 domain experts + 1 synthesizer
 * Use for: multi-perspective analysis, evaluation, assessment
 */
export const analysisPanelTemplate: SwarmTemplate = {
  id: "analysis-panel",
  name: "AnalysisPanel",
  description: "Analyze a topic from multiple expert perspectives and synthesize",
  swarmType: "MixtureOfAgents",
  triggerPatterns: [
    /\banalyz/i,
    /\bperspective/i,
    /\bmulti.*angle/i,
    /\bassess\b/i,
    /\bevaluat/i,
  ],
  triggerExamples: [
    "analyze X from multiple perspectives",
    "give me a multi-angle assessment of X",
    "evaluate X comprehensively",
  ],
  agents: [
    {
      agent_name: "TechnicalExpert",
      system_prompt:
        "You are a technical expert. Analyze the topic from a technical/engineering perspective. Focus on feasibility, implementation details, technical risks, architecture, and scalability. Be specific about technical tradeoffs.",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 4096,
      temperature: 0.4,
    },
    {
      agent_name: "EconomicExpert",
      system_prompt:
        "You are an economic analyst. Analyze the topic from an economic/financial perspective. Focus on costs, ROI, market dynamics, incentive structures, competitive landscape, and revenue potential. Quantify where possible.",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 4096,
      temperature: 0.4,
    },
    {
      agent_name: "RiskExpert",
      system_prompt:
        "You are a risk management specialist. Analyze the topic from a risk perspective. Identify threats, vulnerabilities, worst-case scenarios, regulatory concerns, and mitigation strategies. Rate each risk as Critical/High/Medium/Low.",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 4096,
      temperature: 0.3,
    },
    {
      agent_name: "Synthesizer",
      system_prompt:
        "You are an expert synthesizer. You receive analyses from three domain experts (Technical, Economic, Risk). Synthesize their findings into a unified assessment. Highlight areas of agreement, disagreement, and uncertainty. Provide a clear overall recommendation with confidence level.",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 8192,
      temperature: 0.5,
    },
  ],
  maxLoops: 1,
};

/**
 * CodeReview — ConcurrentWorkflow: 3 parallel reviewers
 * Use for: code review, smart contract audit, security check
 */
export const codeReviewTemplate: SwarmTemplate = {
  id: "code-review",
  name: "CodeReview",
  description: "Review or audit code for security, performance, and style",
  swarmType: "ConcurrentWorkflow",
  triggerPatterns: [
    /\breview\s.*code/i,
    /\bcode\s.*review/i,
    /\baudit\b/i,
    /\bsecurity\s.*check/i,
    /\bcontract\b.*\b(review|audit|check)/i,
    /\bvulnerabilit/i,
  ],
  triggerExamples: [
    "review this code",
    "audit this smart contract",
    "security check on this contract",
    "check for vulnerabilities",
  ],
  agents: [
    {
      agent_name: "SecurityAuditor",
      system_prompt:
        "You are a security auditor. Perform a thorough security review focusing on: vulnerabilities (reentrancy, overflow, access control, front-running, injection), authentication/authorization flaws, data exposure risks. Rate each finding as Critical/High/Medium/Low/Info. Provide specific line references and remediation steps.",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 4096,
      temperature: 0.2,
    },
    {
      agent_name: "PerformanceReviewer",
      system_prompt:
        "You are a performance engineer. Review the code for: gas optimization (if Solidity), computational efficiency, unnecessary allocations, N+1 patterns, caching opportunities, storage patterns. Suggest concrete improvements with estimated impact.",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 4096,
      temperature: 0.3,
    },
    {
      agent_name: "StyleChecker",
      system_prompt:
        "You are a code quality reviewer. Review for: naming conventions, documentation quality, code organization, DRY violations, error handling patterns, test coverage gaps, adherence to language-specific best practices and style guides. Suggest improvements for maintainability.",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 4096,
      temperature: 0.3,
    },
  ],
  maxLoops: 1,
};

/**
 * DebateAndDecide — MajorityVoting: Proponent + Opponent + Judge
 * Use for: decision-making, pros/cons analysis, should-I questions
 */
export const debateAndDecideTemplate: SwarmTemplate = {
  id: "debate-and-decide",
  name: "DebateAndDecide",
  description: "Debate pros and cons of a decision and reach a verdict",
  swarmType: "MajorityVoting",
  triggerPatterns: [
    /\bshould\s+(i|we)\b/i,
    /\bdebate\b/i,
    /\bpros?\s*(and|&|vs)\s*cons?\b/i,
    /\bdecide\b/i,
    /\bweigh\b.*\b(option|choice|decision)/i,
    /\bworth\s+(it|doing|investing)/i,
  ],
  triggerExamples: [
    "should I do X?",
    "debate whether X is a good idea",
    "weigh the pros and cons of X",
    "is X worth it?",
  ],
  agents: [
    {
      agent_name: "Proponent",
      system_prompt:
        "You are arguing IN FAVOR of the proposition. Present the strongest possible case with evidence, data, and reasoning. Be persuasive but honest. Acknowledge weaknesses only to preemptively address them. Structure your argument clearly with numbered points.",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 4096,
      temperature: 0.6,
    },
    {
      agent_name: "Opponent",
      system_prompt:
        "You are arguing AGAINST the proposition. Present the strongest counterarguments with evidence, data, and reasoning. Play devil's advocate thoroughly. Identify hidden risks, unstated assumptions, and potential failure modes. Structure your argument clearly with numbered points.",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 4096,
      temperature: 0.6,
    },
    {
      agent_name: "Judge",
      system_prompt:
        "You are an impartial judge. Evaluate both the Proponent's and Opponent's arguments. Weigh the evidence, identify the stronger position, and deliver a clear verdict. Structure your response as: 1) Summary of Pro arguments, 2) Summary of Con arguments, 3) Analysis of key disagreements, 4) Verdict with confidence percentage, 5) Recommended action.",
      model_name: "gpt-5-mini",
      role: "worker",
      max_loops: 1,
      max_tokens: 4096,
      temperature: 0.3,
    },
  ],
  maxLoops: 1,
};
