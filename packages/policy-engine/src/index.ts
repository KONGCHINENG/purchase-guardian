/**
 * Purchase Guardian policy engine.
 *
 * Pure and deterministic: no I/O, no clock, no randomness. Given the same input it
 * always returns the same decision, which is what makes it safe to sit between an
 * LLM and a payment API. Bump POLICY_ENGINE_VERSION whenever rule semantics change;
 * the version is stored with every decision for auditability.
 */
import { formatMoney, normalizeMerchant, type Category, type Decision, type RiskSensitivity } from "@guardian/shared";

export const POLICY_ENGINE_VERSION = 1;

export const RULES = {
  AMOUNT_MISSING: "AMOUNT_MISSING",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  MERCHANT_BLOCKED: "MERCHANT_BLOCKED",
  CATEGORY_BLOCKED: "CATEGORY_BLOCKED",
  PER_PURCHASE_LIMIT_EXCEEDED: "PER_PURCHASE_LIMIT_EXCEEDED",
  MONTHLY_LIMIT_EXCEEDED: "MONTHLY_LIMIT_EXCEEDED",
  AMOUNT_ABOVE_CONFIRMATION_THRESHOLD: "AMOUNT_ABOVE_CONFIRMATION_THRESHOLD",
  LOW_AI_CONFIDENCE: "LOW_AI_CONFIDENCE",
  MERCHANT_NOT_ALLOWLISTED: "MERCHANT_NOT_ALLOWLISTED",
  AI_RISK_FLAGGED: "AI_RISK_FLAGGED",
} as const;
export type RuleId = (typeof RULES)[keyof typeof RULES];

const BLOCKING_RULES = new Set<RuleId>([
  RULES.AMOUNT_MISSING,
  RULES.CURRENCY_MISMATCH,
  RULES.MERCHANT_BLOCKED,
  RULES.CATEGORY_BLOCKED,
  RULES.PER_PURCHASE_LIMIT_EXCEEDED,
  RULES.MONTHLY_LIMIT_EXCEEDED,
]);

/** Minimum AI confidence accepted without a human in the loop. */
export const CONFIDENCE_THRESHOLDS: Record<RiskSensitivity, number> = {
  strict: 0.9,
  balanced: 0.75,
  relaxed: 0.6,
};

export type PolicySnapshot = {
  currency: string;
  monthlyLimitCents: number;
  perPurchaseLimitCents: number;
  requireApprovalAboveCents: number;
  blockedCategories: Category[] | string[];
  allowedMerchants: string[];
  blockedMerchants: string[];
  riskSensitivity: RiskSensitivity;
};

export type PolicyInput = {
  amountCents: number | null;
  currency: string;
  category: string;
  merchantName: string;
  /** Spend already committed this period (captured + in-flight orders), excluding this request. */
  monthlySpendCents: number;
  aiConfidence: number;
  riskFlags: string[];
  policy: PolicySnapshot;
};

export type TriggeredRule = { id: RuleId; outcome: Decision; message: string };

export type PolicyResult = {
  decision: Decision;
  triggeredRules: RuleId[];
  details: TriggeredRule[];
  explanation: string;
  monthlySpendCents: number;
  remainingMonthlyBudgetCents: number;
  version: number;
};

export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const { policy } = input;
  const money = (cents: number) => formatMoney(cents, policy.currency);
  const details: TriggeredRule[] = [];
  const add = (id: RuleId, message: string) =>
    details.push({ id, outcome: BLOCKING_RULES.has(id) ? "block" : "require_approval", message });

  const amount = input.amountCents;
  const remainingBefore = Math.max(0, policy.monthlyLimitCents - input.monthlySpendCents);
  const merchantKey = normalizeMerchant(input.merchantName);
  const blockedMerchants = new Set(policy.blockedMerchants.map(normalizeMerchant));
  const allowedMerchants = new Set(policy.allowedMerchants.map(normalizeMerchant));

  // ---- Blocking rules -------------------------------------------------------
  if (amount === null || amount <= 0) {
    add(RULES.AMOUNT_MISSING, "No price was given, so the purchase can't be checked against your budget.");
  }
  if (input.currency.toUpperCase() !== policy.currency.toUpperCase()) {
    add(RULES.CURRENCY_MISMATCH, `The purchase is in ${input.currency}, but your policy only allows ${policy.currency}.`);
  }
  if (merchantKey && blockedMerchants.has(merchantKey)) {
    add(RULES.MERCHANT_BLOCKED, `${input.merchantName} is on your blocked merchant list.`);
  }
  if ((policy.blockedCategories as string[]).includes(input.category)) {
    add(RULES.CATEGORY_BLOCKED, `The category "${input.category.replace("_", " ")}" is blocked by your policy.`);
  }
  if (amount !== null && amount > policy.perPurchaseLimitCents) {
    add(RULES.PER_PURCHASE_LIMIT_EXCEEDED, `${money(amount)} is over your ${money(policy.perPurchaseLimitCents)} per-purchase limit.`);
  }
  if (amount !== null && amount > 0 && input.monthlySpendCents + amount > policy.monthlyLimitCents) {
    add(
      RULES.MONTHLY_LIMIT_EXCEEDED,
      `${money(amount)} would exceed your monthly budget; only ${money(remainingBefore)} of ${money(policy.monthlyLimitCents)} is left.`,
    );
  }

  // ---- Confirmation rules ---------------------------------------------------
  if (amount !== null && amount > policy.requireApprovalAboveCents) {
    add(
      RULES.AMOUNT_ABOVE_CONFIRMATION_THRESHOLD,
      `${money(amount)} is above your ${money(policy.requireApprovalAboveCents)} confirmation threshold.`,
    );
  }
  const minConfidence = CONFIDENCE_THRESHOLDS[policy.riskSensitivity];
  if (input.aiConfidence < minConfidence) {
    add(RULES.LOW_AI_CONFIDENCE, `The assistant wasn't confident it understood the request (${Math.round(input.aiConfidence * 100)}%).`);
  }
  if (allowedMerchants.size > 0 && !allowedMerchants.has(merchantKey)) {
    add(RULES.MERCHANT_NOT_ALLOWLISTED, `${input.merchantName || "This merchant"} isn't on your allowed merchant list.`);
  }
  if (input.riskFlags.length > 0) {
    add(RULES.AI_RISK_FLAGGED, `The request was flagged for review: ${input.riskFlags.map((f) => f.replaceAll("_", " ")).join(", ")}.`);
  }

  const decision: Decision = details.some((d) => d.outcome === "block")
    ? "block"
    : details.length > 0
      ? "require_approval"
      : "approve";

  const remainingAfter = decision === "block" || amount === null ? remainingBefore : Math.max(0, remainingBefore - amount);

  return {
    decision,
    triggeredRules: details.map((d) => d.id),
    details,
    explanation: explain(decision, details, amount, remainingAfter, money),
    monthlySpendCents: input.monthlySpendCents,
    remainingMonthlyBudgetCents: remainingAfter,
    version: POLICY_ENGINE_VERSION,
  };
}

function explain(
  decision: Decision,
  details: TriggeredRule[],
  amount: number | null,
  remainingAfter: number,
  money: (c: number) => string,
): string {
  if (decision === "approve") {
    return `Approved: ${money(amount ?? 0)} passes every rule in your policy. ${money(remainingAfter)} of your monthly budget will remain.`;
  }
  const relevant = details.filter((d) => d.outcome === decision).map((d) => d.message);
  if (decision === "block") {
    return `Blocked: ${relevant.join(" ")}`;
  }
  return `Needs your approval: ${relevant.join(" ")} If you approve, ${money(remainingAfter)} of your monthly budget will remain.`;
}
