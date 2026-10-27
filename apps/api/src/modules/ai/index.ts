import { PurchaseIntentSchema, type RiskFlag } from "@guardian/shared";
import type { Config } from "../../config";
import { AnthropicAnalyzer } from "./anthropic";
import { detectRiskSignals, HEURISTIC_MAX_CONFIDENCE, HeuristicAnalyzer } from "./heuristic";
import { NvidiaAnalyzer } from "./nvidia";
import { AiRefusedError, type AiAnalysis, type AnalysisContext, type PurchaseAnalyzer } from "./types";

export * from "./types";

export function createAnalyzer(config: Config["ai"]): PurchaseAnalyzer {
  switch (config.provider) {
    case "nvidia":
      return new NvidiaAnalyzer({ ...config.nvidia, apiKey: config.nvidia.apiKey!, timeoutMs: config.timeoutMs });
    case "anthropic":
      return new AnthropicAnalyzer({ ...config.anthropic, timeoutMs: config.timeoutMs });
    default:
      return new HeuristicAnalyzer();
  }
}

/**
 * Runs the configured analyzer and hardens its output:
 * - falls back to the heuristic parser if the model is unavailable or declines,
 *   flagging the result so policy routes it to a human;
 * - re-validates/clamps every field against the strict shared schema;
 * - merges deterministic risk signals, so prompt injection is caught even if the model misses it.
 */
export async function analyzePurchase(
  analyzer: PurchaseAnalyzer,
  rawInput: string,
  ctx: AnalysisContext,
  onFallback?: (reason: string, error: unknown) => void,
): Promise<AiAnalysis> {
  let analysis: AiAnalysis;
  try {
    analysis = await analyzer.analyze(rawInput, ctx);
  } catch (error) {
    if (analyzer.provider === "heuristic") throw error;
    const flag: RiskFlag = error instanceof AiRefusedError ? "ai_refused" : "ai_unavailable";
    onFallback?.(flag, error);
    analysis = await new HeuristicAnalyzer().analyze(rawInput, ctx);
    analysis.riskFlags = [...analysis.riskFlags, flag];
    analysis.intent.confidence = Math.min(analysis.intent.confidence, HEURISTIC_MAX_CONFIDENCE);
  }

  const intent = PurchaseIntentSchema.parse({
    ...analysis.intent,
    itemName: analysis.intent.itemName.trim().slice(0, 200) || "Unspecified item",
    merchantName: analysis.intent.merchantName.trim().slice(0, 120),
    quantity: Math.min(1000, Math.max(1, Math.trunc(analysis.intent.quantity || 1))),
    confidence: Math.min(1, Math.max(0, analysis.intent.confidence)),
    amountCents:
      analysis.intent.amountCents === null ? null : Math.min(100_000_000, Math.max(0, Math.round(analysis.intent.amountCents))),
    missingFields: analysis.intent.missingFields.slice(0, 10),
  });

  const riskFlags = [...new Set<RiskFlag>([...analysis.riskFlags, ...detectRiskSignals(rawInput)])];
  return { ...analysis, intent, riskFlags, summary: analysis.summary.slice(0, 300) };
}
