import { describe, expect, it } from "vitest";
import { evaluatePolicy, RULES, type PolicyInput } from "./index";

const base: PolicyInput = {
  amountCents: 2_000,
  currency: "USD",
  category: "household",
  merchantName: "Target",
  monthlySpendCents: 0,
  aiConfidence: 0.95,
  riskFlags: [],
  policy: {
    currency: "USD",
    monthlyLimitCents: 100_000,
    perPurchaseLimitCents: 25_000,
    requireApprovalAboveCents: 5_000,
    blockedCategories: ["gambling"],
    allowedMerchants: [],
    blockedMerchants: ["Shady Deals Inc."],
    riskSensitivity: "balanced",
  },
};

const run = (overrides: Partial<PolicyInput> = {}, policy: Partial<PolicyInput["policy"]> = {}) =>
  evaluatePolicy({ ...base, ...overrides, policy: { ...base.policy, ...policy } });

describe("evaluatePolicy", () => {
  it("approves a small, in-policy purchase and reports remaining budget", () => {
    const r = run();
    expect(r.decision).toBe("approve");
    expect(r.triggeredRules).toEqual([]);
    expect(r.remainingMonthlyBudgetCents).toBe(98_000);
    expect(r.explanation).toMatch(/^Approved/);
  });

  it("requires approval above the confirmation threshold (doc example: $65 gift)", () => {
    const r = run({ amountCents: 6_500, category: "gifts", merchantName: "Amazon" });
    expect(r.decision).toBe("require_approval");
    expect(r.triggeredRules).toEqual([RULES.AMOUNT_ABOVE_CONFIRMATION_THRESHOLD]);
    expect(r.explanation).toContain("$50.00 confirmation threshold");
  });

  it("blocks merchants on the block list using normalized names", () => {
    const r = run({ merchantName: "shady deals" });
    expect(r.decision).toBe("block");
    expect(r.triggeredRules).toContain(RULES.MERCHANT_BLOCKED);
  });

  it("blocks blocked categories", () => {
    expect(run({ category: "gambling" }).decision).toBe("block");
  });

  it("blocks currency mismatches", () => {
    expect(run({ currency: "EUR" }).triggeredRules).toContain(RULES.CURRENCY_MISMATCH);
  });

  it("blocks amounts over the per-purchase limit", () => {
    const r = run({ amountCents: 30_000 });
    expect(r.decision).toBe("block");
    expect(r.triggeredRules).toContain(RULES.PER_PURCHASE_LIMIT_EXCEEDED);
  });

  it("blocks when committed spend plus this purchase exceeds the monthly limit", () => {
    const r = run({ amountCents: 4_000, monthlySpendCents: 97_000 });
    expect(r.decision).toBe("block");
    expect(r.triggeredRules).toContain(RULES.MONTHLY_LIMIT_EXCEEDED);
    expect(r.remainingMonthlyBudgetCents).toBe(3_000);
  });

  it("allows spending exactly up to the monthly limit", () => {
    expect(run({ amountCents: 3_000, monthlySpendCents: 97_000 }).decision).toBe("approve");
  });

  it("blocks when the amount is missing or zero", () => {
    expect(run({ amountCents: null }).decision).toBe("block");
    expect(run({ amountCents: 0 }).decision).toBe("block");
  });

  it("requires approval when AI confidence is below the sensitivity threshold", () => {
    expect(run({ aiConfidence: 0.7 }).decision).toBe("require_approval");
    expect(run({ aiConfidence: 0.7 }, { riskSensitivity: "relaxed" }).decision).toBe("approve");
    expect(run({ aiConfidence: 0.85 }, { riskSensitivity: "strict" }).decision).toBe("require_approval");
  });

  it("requires approval for merchants outside a non-empty allowlist", () => {
    const r = run({}, { allowedMerchants: ["Costco", "Walmart"] });
    expect(r.decision).toBe("require_approval");
    expect(r.triggeredRules).toContain(RULES.MERCHANT_NOT_ALLOWLISTED);
    expect(run({ merchantName: "costco.com" }, { allowedMerchants: ["Costco"] }).decision).toBe("approve");
  });

  it("never lets risk flags auto-approve (prompt injection)", () => {
    const r = run({ riskFlags: ["possible_prompt_injection"] });
    expect(r.decision).toBe("require_approval");
    expect(r.triggeredRules).toContain(RULES.AI_RISK_FLAGGED);
  });

  it("block outranks approval rules and explanations only cite the deciding rules", () => {
    const r = run({ amountCents: 30_000, aiConfidence: 0.1 });
    expect(r.decision).toBe("block");
    expect(r.triggeredRules).toEqual(
      expect.arrayContaining([RULES.PER_PURCHASE_LIMIT_EXCEEDED, RULES.LOW_AI_CONFIDENCE]),
    );
    expect(r.explanation).not.toContain("confident");
  });

  it("is deterministic", () => {
    expect(run({ amountCents: 6_500 })).toEqual(run({ amountCents: 6_500 }));
  });
});
