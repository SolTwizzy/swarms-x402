export interface AnalystVerdict {
  verdict: "LONG" | "SHORT" | "HOLD";
  confidence: number;
  reasoning: string;
}

export interface TradingSignal {
  asset: string;
  signal: "LONG" | "SHORT" | "HOLD";
  confidence: number;
  timeframe: string;
  analysts: {
    technical: AnalystVerdict;
    sentiment: AnalystVerdict;
    onchain: AnalystVerdict;
  };
  consensus: string;
  costToGenerate: string;
  generatedAt: string;
}

export interface SignalRequest {
  asset: string;
  timeframe?: string;
}
