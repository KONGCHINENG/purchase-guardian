import { formatMoney } from "@guardian/shared";

export { formatMoney };

export const money = (cents: number | null | undefined, currency: string | null | undefined = "USD") =>
  cents === null || cents === undefined ? "—" : formatMoney(cents, currency ?? "USD");

export const dollarsToCents = (value: string) => Math.round(Number.parseFloat(value || "0") * 100);
export const centsToDollars = (cents: number) => (cents / 100).toFixed(2);

export function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.round(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const humanize = (s: string) => s.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());

/** Rules that block outright (mirrors the policy engine); the rest only require approval. */
export const BLOCKING_RULES = new Set([
  "AMOUNT_MISSING",
  "CURRENCY_MISMATCH",
  "MERCHANT_BLOCKED",
  "CATEGORY_BLOCKED",
  "PER_PURCHASE_LIMIT_EXCEEDED",
  "MONTHLY_LIMIT_EXCEEDED",
]);

export const RULE_LABELS: Record<string, string> = {
  AMOUNT_MISSING: "No price given",
  CURRENCY_MISMATCH: "Currency mismatch",
  MERCHANT_BLOCKED: "Blocked merchant",
  CATEGORY_BLOCKED: "Blocked category",
  PER_PURCHASE_LIMIT_EXCEEDED: "Over per-purchase limit",
  MONTHLY_LIMIT_EXCEEDED: "Over monthly budget",
  AMOUNT_ABOVE_CONFIRMATION_THRESHOLD: "Above approval threshold",
  LOW_AI_CONFIDENCE: "Low AI confidence",
  MERCHANT_NOT_ALLOWLISTED: "Merchant not allowlisted",
  AI_RISK_FLAGGED: "Risk flag raised",
};
