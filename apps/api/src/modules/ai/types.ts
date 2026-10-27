import type { Currency, PurchaseIntent, RiskFlag } from "@guardian/shared";

export type AnalysisContext = { defaultCurrency: Currency };

export type AiAnalysis = {
  intent: PurchaseIntent;
  riskFlags: RiskFlag[];
  /** One-sentence restatement of what the user asked for, shown in the UI. */
  summary: string;
  provider: "anthropic" | "heuristic";
  model: string;
};

/**
 * The AI boundary. Implementations only *describe* a purchase; they cannot approve,
 * change policy, or reach PayPal. Their output is re-validated before policy runs.
 */
export interface PurchaseAnalyzer {
  readonly provider: AiAnalysis["provider"];
  analyze(rawInput: string, ctx: AnalysisContext): Promise<AiAnalysis>;
}

export class AiUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AiUnavailableError";
  }
}

export class AiRefusedError extends Error {
  constructor(readonly category: string | null) {
    super(`Model declined the request${category ? ` (${category})` : ""}`);
    this.name = "AiRefusedError";
  }
}
