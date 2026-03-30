import type { SwarmTemplate } from "../types.js";
import {
  codeReviewTemplate,
  debateAndDecideTemplate,
  researchPipelineTemplate,
  analysisPanelTemplate,
} from "./swarmTemplates.js";

export {
  researchPipelineTemplate,
  analysisPanelTemplate,
  codeReviewTemplate,
  debateAndDecideTemplate,
} from "./swarmTemplates.js";

/**
 * Registry of all available swarm templates.
 * Ordered by specificity — more specific patterns first to avoid false matches.
 */
export const SWARM_TEMPLATES: SwarmTemplate[] = [
  codeReviewTemplate,       // Most specific triggers (code+review, audit, contract)
  debateAndDecideTemplate,  // Specific triggers (should I, pros/cons, debate)
  researchPipelineTemplate, // Broader triggers (research, report, summarize)
  analysisPanelTemplate,    // Broadest triggers (analyze, evaluate, assess)
];

/**
 * Find the first matching template based on regex trigger patterns.
 * Templates are checked in specificity order (most specific first).
 * Returns null if no template matches.
 */
export function findMatchingTemplate(text: string): SwarmTemplate | null {
  if (!text) return null;
  for (const template of SWARM_TEMPLATES) {
    if (template.triggerPatterns.some((pattern) => pattern.test(text))) {
      return template;
    }
  }
  return null;
}

/**
 * Register a custom swarm template at runtime.
 * Custom templates are appended to the end of the registry (lowest priority).
 */
export function registerSwarmTemplate(template: SwarmTemplate): void {
  SWARM_TEMPLATES.push(template);
}

/**
 * Build a classification prompt listing all available templates.
 * Used when keyword matching is ambiguous or fails.
 */
export function buildClassificationPrompt(userMessage: string): string {
  const templateList = SWARM_TEMPLATES.map(
    (t) => `- "${t.id}": ${t.description}`
  ).join("\n");

  return `Classify the user's request into one of these swarm templates, or "custom" if none fit:
${templateList}
- "custom": None of the above — needs a custom swarm configuration

Return JSON: { "templateId": "<id or custom>", "task": "<the specific task to perform>" }

User message: "${userMessage}"

Return only valid JSON, no markdown.`;
}
