import { CURRENCIES, type Category, type Currency, type RiskFlag } from "@guardian/shared";
import type { AiAnalysis, AnalysisContext, PurchaseAnalyzer } from "./types";

/**
 * Deterministic, offline analyzer. Used when no LLM is configured and as the fallback
 * when the LLM is unavailable. Its confidence is deliberately capped below every policy
 * threshold, so a heuristic parse can never auto-approve a purchase.
 */
export const HEURISTIC_MAX_CONFIDENCE = 0.55;

const CATEGORY_KEYWORDS: [Category, RegExp][] = [
  ["gambling", /\b(casino|bet|betting|poker|lottery|slots?)\b/i],
  ["alcohol", /\b(wine|beer|vodka|whisk(e)?y|liquor|champagne|gin|rum)\b/i],
  ["gifts", /\b(gift|present|birthday|anniversary)\b/i],
  ["groceries", /\b(grocer(y|ies)|milk|eggs|bread|vegetables?|fruit|rice)\b/i],
  ["household", /\b(soap|detergent|paper towels?|toilet paper|cleaning|trash bags?|sponges?)\b/i],
  ["electronics", /\b(laptop|phone|headphones?|earbuds|charger|monitor|keyboard|tablet|camera|tv)\b/i],
  ["clothing", /\b(shirt|shoes|sneakers|jacket|dress|jeans|socks|hoodie)\b/i],
  ["travel", /\b(flight|hotel|airbnb|train ticket|bus ticket|car rental)\b/i],
  ["food_delivery", /\b(pizza|burger|takeout|delivery|uber ?eats|doordash|grubhub|lunch|dinner)\b/i],
  ["entertainment", /\b(movie|concert|tickets?|game|netflix|spotify)\b/i],
  ["software", /\b(subscription|license|saas|app|software|domain)\b/i],
  ["health", /\b(vitamins?|medicine|pharmacy|supplements?|bandages?)\b/i],
];

const CURRENCY_SYMBOLS: Record<string, Currency> = { $: "USD", "€": "EUR", "£": "GBP" };

export function detectRiskSignals(text: string): RiskFlag[] {
  const flags = new Set<RiskFlag>();
  if (/\b(ignore|disregard|override|bypass|forget)\b.{0,40}\b(rules?|polic(y|ies)|instructions?|limits?|guardian|previous)\b/i.test(text)) {
    flags.add("possible_prompt_injection");
  }
  if (/\b(system prompt|you are now|developer mode|jailbreak)\b/i.test(text)) flags.add("possible_prompt_injection");
  if (/\b(urgent(ly)?|immediately|right now|asap|before it'?s too late|no questions)\b/i.test(text)) flags.add("urgency_pressure");
  return [...flags];
}

export class HeuristicAnalyzer implements PurchaseAnalyzer {
  readonly provider = "heuristic" as const;

  async analyze(rawInput: string, ctx: AnalysisContext): Promise<AiAnalysis> {
    const text = rawInput.replace(/\s+/g, " ").trim();
    const missing: string[] = [];

    // Amount: "$65", "65.50 USD", "€20", "20 dollars"
    let amountCents: number | null = null;
    let currency: Currency = ctx.defaultCurrency;
    const symbol = /([$€£])\s?(\d{1,7}(?:[.,]\d{1,2})?)/.exec(text);
    const coded = /(\d{1,7}(?:[.,]\d{1,2})?)\s?(usd|eur|gbp|dollars?|euros?|pounds?)\b/i.exec(text);
    if (symbol) {
      amountCents = toCents(symbol[2]!);
      currency = CURRENCY_SYMBOLS[symbol[1]!] ?? currency;
    } else if (coded) {
      amountCents = toCents(coded[1]!);
      const unit = coded[2]!.toUpperCase();
      currency = (CURRENCIES as readonly string[]).includes(unit)
        ? (unit as Currency)
        : unit.startsWith("EURO") ? "EUR" : unit.startsWith("POUND") ? "GBP" : "USD";
    } else {
      missing.push("amount");
    }

    const quantityMatch = /\b(\d{1,3})\s?(?:x|pcs|packs?|units?|of)\b/i.exec(text) ?? /\bbuy (\d{1,3})\b/i.exec(text);
    const quantity = quantityMatch ? Math.max(1, Number(quantityMatch[1])) : 1;

    // Capitalized words after "from/at/on/via"; a sentence-ending period stops the name ("Target. Ignore…").
    const merchantMatch = /\b(?:from|at|on|via)\s+([A-Z0-9][\w&'-]*(?:\.[a-z]{2,4}\b)?(?:\s+[A-Z][\w&'-]*){0,2})/.exec(text);
    const merchantName = merchantMatch?.[1]?.trim() ?? "";
    if (!merchantName) missing.push("merchant");

    const category = CATEGORY_KEYWORDS.find(([, re]) => re.test(text))?.[0] ?? "other";

    const itemMatch = /\b(?:buy|get|order|purchase|grab)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?(.+?)(?=\s+(?:from|at|on|via|for|under|with|to)\b|[.,!]|$)/i.exec(text);
    const itemName = (itemMatch?.[1] ?? text)
      .replace(/([$€£])\s?\d+(?:[.,]\d{1,2})?/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "Unspecified item";

    const confidence = Math.min(HEURISTIC_MAX_CONFIDENCE, 0.25 + (amountCents ? 0.15 : 0) + (merchantName ? 0.1 : 0) + (category !== "other" ? 0.05 : 0));

    return {
      intent: { itemName, merchantName, category, amountCents, currency, quantity, confidence, missingFields: missing },
      riskFlags: detectRiskSignals(text),
      summary: `${itemName}${merchantName ? ` from ${merchantName}` : ""}`,
      provider: "heuristic",
      model: "heuristic-v1",
    };
  }
}

function toCents(value: string): number {
  return Math.round(Number(value.replace(",", ".")) * 100);
}
