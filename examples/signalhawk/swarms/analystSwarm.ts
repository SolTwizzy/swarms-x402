import type { SwarmRunParams } from "swarms-ts/resources";

/**
 * Build a MajorityVoting swarm with 3 specialist analyst agents.
 * Each analyst independently evaluates the data and returns a verdict.
 */
export function buildAnalystSwarm(
  asset: string,
  timeframe: string,
  priceData: string,
  sentimentData: string
): SwarmRunParams {
  const dataContext = `
ASSET: ${asset}
TIMEFRAME: ${timeframe}

PRICE DATA:
${priceData || "(no price data available)"}

SENTIMENT/NEWS DATA:
${sentimentData || "(no sentiment data available)"}
`.trim();

  return {
    name: `SignalHawk-${asset}-${timeframe}-${Date.now()}`,
    description: `Trading signal analysis for ${asset} on ${timeframe} timeframe`,
    swarm_type: "MajorityVoting",
    max_loops: 1,
    task: `Analyze the following market data and provide your trading verdict for ${asset} on the ${timeframe} timeframe.

${dataContext}

IMPORTANT: You MUST end your response with a structured verdict in exactly this format:
VERDICT: LONG|SHORT|HOLD
CONFIDENCE: <number 0-100>
REASONING: <one sentence>`,
    agents: [
      {
        agent_name: "TechnicalAnalyst",
        system_prompt: `You are an expert technical analyst specializing in crypto markets. Given price data, identify:
- Support and resistance levels
- Momentum indicators (RSI, MACD concepts)
- Volume patterns and trends
- Chart patterns (breakouts, reversals, consolidation)
- Moving average relationships

Be data-driven and specific. Reference actual numbers from the data. End with your structured VERDICT.`,
        model_name: "gpt-4o-mini",
        role: "worker",
        max_loops: 1,
        max_tokens: 4096,
        temperature: 0.3,
      },
      {
        agent_name: "SentimentAnalyst",
        system_prompt: `You are an expert sentiment analyst specializing in crypto markets. Given news and social data, evaluate:
- Overall market sentiment (fear/greed)
- Narrative momentum (is the story strengthening or fading?)
- Institutional vs retail sentiment divergence
- Key catalysts (regulatory, technical upgrades, partnerships)
- Contrarian indicators (extreme sentiment often precedes reversals)

Focus on actionable sentiment signals, not just summarizing news. End with your structured VERDICT.`,
        model_name: "gpt-4o-mini",
        role: "worker",
        max_loops: 1,
        max_tokens: 4096,
        temperature: 0.4,
      },
      {
        agent_name: "OnChainAnalyst",
        system_prompt: `You are an expert on-chain analyst specializing in crypto markets. Given available data, evaluate:
- Whale wallet activity (accumulation vs distribution)
- Exchange inflow/outflow patterns
- TVL trends for DeFi protocols
- Network activity metrics (transactions, active addresses)
- Stablecoin flows as a proxy for buying pressure

If on-chain data is limited, extrapolate from price action and general market conditions. End with your structured VERDICT.`,
        model_name: "gpt-4o-mini",
        role: "worker",
        max_loops: 1,
        max_tokens: 4096,
        temperature: 0.3,
      },
    ],
  };
}

/**
 * Parse the MajorityVoting swarm output to extract individual verdicts.
 */
export function parseSwarmVerdicts(output: string): {
  technical: { verdict: string; confidence: number; reasoning: string };
  sentiment: { verdict: string; confidence: number; reasoning: string };
  onchain: { verdict: string; confidence: number; reasoning: string };
} {
  const defaultVerdict = { verdict: "HOLD", confidence: 50, reasoning: "Unable to parse verdict" };

  function extractVerdict(text: string) {
    const verdictMatch = text.match(/VERDICT:\s*(LONG|SHORT|HOLD)/i);
    const confidenceMatch = text.match(/CONFIDENCE:\s*(\d+)/i);
    const reasoningMatch = text.match(/REASONING:\s*(.+?)(?:\n|$)/i);

    return {
      verdict: verdictMatch?.[1]?.toUpperCase() ?? "HOLD",
      confidence: confidenceMatch ? parseInt(confidenceMatch[1]) : 50,
      reasoning: reasoningMatch?.[1]?.trim() ?? "No reasoning provided",
    };
  }

  // Try to split output by agent sections
  const sections = output.split(/(?:TechnicalAnalyst|SentimentAnalyst|OnChainAnalyst|Agent\s*\d+)/i);

  if (sections.length >= 4) {
    return {
      technical: extractVerdict(sections[1] ?? ""),
      sentiment: extractVerdict(sections[2] ?? ""),
      onchain: extractVerdict(sections[3] ?? ""),
    };
  }

  // Fallback: try to find all verdicts in the full text
  const allVerdicts = output.match(/VERDICT:\s*(LONG|SHORT|HOLD)/gi) ?? [];
  const allConfidences = output.match(/CONFIDENCE:\s*(\d+)/gi) ?? [];
  const allReasonings = output.match(/REASONING:\s*(.+?)(?:\n|$)/gi) ?? [];

  return {
    technical: allVerdicts[0]
      ? extractVerdict(`${allVerdicts[0]}\n${allConfidences[0] ?? ""}\n${allReasonings[0] ?? ""}`)
      : defaultVerdict,
    sentiment: allVerdicts[1]
      ? extractVerdict(`${allVerdicts[1]}\n${allConfidences[1] ?? ""}\n${allReasonings[1] ?? ""}`)
      : defaultVerdict,
    onchain: allVerdicts[2]
      ? extractVerdict(`${allVerdicts[2]}\n${allConfidences[2] ?? ""}\n${allReasonings[2] ?? ""}`)
      : defaultVerdict,
  };
}

/**
 * Compute consensus from 3 analyst verdicts.
 */
export function computeConsensus(verdicts: {
  technical: { verdict: string; confidence: number };
  sentiment: { verdict: string; confidence: number };
  onchain: { verdict: string; confidence: number };
}): { signal: "LONG" | "SHORT" | "HOLD"; confidence: number; consensus: string } {
  const votes = [verdicts.technical.verdict, verdicts.sentiment.verdict, verdicts.onchain.verdict];
  const counts: Record<string, number> = {};
  for (const v of votes) {
    counts[v] = (counts[v] ?? 0) + 1;
  }

  // Find majority
  let majority = "HOLD";
  let majorityCount = 0;
  for (const [verdict, count] of Object.entries(counts)) {
    if (count > majorityCount) {
      majority = verdict;
      majorityCount = count;
    }
  }

  // Weighted average confidence of agreeing analysts
  const allConfidences = [
    verdicts.technical.confidence,
    verdicts.sentiment.confidence,
    verdicts.onchain.confidence,
  ];
  const avgConfidence = Math.round(
    allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length
  );

  return {
    signal: majority as "LONG" | "SHORT" | "HOLD",
    confidence: avgConfidence,
    consensus: `${majorityCount}/3 ${majority}`,
  };
}
