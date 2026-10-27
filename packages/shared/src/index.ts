import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const CURRENCIES = ["USD", "EUR", "GBP"] as const;
export const CurrencySchema = z.enum(CURRENCIES);
export type Currency = z.infer<typeof CurrencySchema>;

export const CATEGORIES = [
  "groceries",
  "household",
  "electronics",
  "gifts",
  "clothing",
  "travel",
  "food_delivery",
  "entertainment",
  "software",
  "health",
  "alcohol",
  "gambling",
  "other",
] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const RISK_SENSITIVITIES = ["strict", "balanced", "relaxed"] as const;
export const RiskSensitivitySchema = z.enum(RISK_SENSITIVITIES);
export type RiskSensitivity = z.infer<typeof RiskSensitivitySchema>;

export const DECISIONS = ["approve", "require_approval", "block"] as const;
export type Decision = (typeof DECISIONS)[number];

export const PURCHASE_REQUEST_STATUSES = [
  "analyzing",
  "blocked",
  "pending_approval",
  "approved",
  "checkout_created",
  "completed",
  "rejected",
  "expired",
  "failed",
] as const;
export type PurchaseRequestStatus = (typeof PURCHASE_REQUEST_STATUSES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const ORDER_STATUSES = ["creating", "created", "approved", "completed", "failed", "voided"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const AUDIT_ACTORS = ["user", "ai", "policy_engine", "system", "paypal"] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

/* -------------------------------------------------------------------------- */
/* AI contract                                                                */
/* -------------------------------------------------------------------------- */

/** The only shape the AI layer may hand to the policy engine. */
export const PurchaseIntentSchema = z.object({
  itemName: z.string().trim().min(1).max(200),
  merchantName: z.string().trim().max(120),
  category: CategorySchema,
  /** Total price for all units, in minor units. null when the user gave no price. */
  amountCents: z.number().int().nonnegative().max(100_000_000).nullable(),
  currency: CurrencySchema,
  quantity: z.number().int().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  missingFields: z.array(z.string()).max(10),
});
export type PurchaseIntent = z.infer<typeof PurchaseIntentSchema>;

export const RISK_FLAGS = [
  "possible_prompt_injection",
  "urgency_pressure",
  "unusual_quantity",
  "ambiguous_merchant",
  "ai_unavailable",
  "ai_refused",
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

/* -------------------------------------------------------------------------- */
/* Request bodies                                                             */
/* -------------------------------------------------------------------------- */

const email = z.string().trim().toLowerCase().email().max(254);

export const RegisterInputSchema = z.object({
  email,
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
  fullName: z.string().trim().min(1).max(120).optional(),
});
export type RegisterInput = z.infer<typeof RegisterInputSchema>;

export const LoginInputSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

const merchantList = z
  .array(z.string().trim().min(1).max(120))
  .max(200)
  .transform((list) => [...new Set(list.map(normalizeMerchant).filter(Boolean))]);

export const UpdatePolicyInputSchema = z
  .object({
    currency: CurrencySchema,
    monthlyLimitCents: z.number().int().min(0).max(100_000_000),
    perPurchaseLimitCents: z.number().int().min(0).max(100_000_000),
    requireApprovalAboveCents: z.number().int().min(0).max(100_000_000),
    blockedCategories: z.array(CategorySchema).max(CATEGORIES.length).transform((l) => [...new Set(l)]),
    allowedMerchants: merchantList,
    blockedMerchants: merchantList,
    riskSensitivity: RiskSensitivitySchema,
  })
  .refine((p) => p.perPurchaseLimitCents <= p.monthlyLimitCents, {
    message: "Per-purchase limit cannot exceed the monthly limit",
    path: ["perPurchaseLimitCents"],
  });
export type UpdatePolicyInput = z.infer<typeof UpdatePolicyInputSchema>;

export const CreatePurchaseRequestInputSchema = z.object({
  rawInput: z.string().trim().min(3).max(2000),
});

export const CreateOrderInputSchema = z.object({
  purchaseRequestId: z.string().uuid(),
});

export const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

/* -------------------------------------------------------------------------- */
/* Response DTOs                                                              */
/* -------------------------------------------------------------------------- */

export type UserDto = { id: string; email: string; fullName: string | null; createdAt: string };

export type AuthResponse = { accessToken: string; expiresIn: number; user: UserDto };

export type PolicyDto = {
  currency: Currency;
  monthlyLimitCents: number;
  perPurchaseLimitCents: number;
  requireApprovalAboveCents: number;
  blockedCategories: Category[];
  allowedMerchants: string[];
  blockedMerchants: string[];
  riskSensitivity: RiskSensitivity;
  version: number;
  updatedAt: string;
};

export type UsageDto = {
  currency: Currency;
  monthlyLimitCents: number;
  spentCents: number;
  reservedCents: number;
  remainingCents: number;
  periodStart: string;
  pendingApprovals: number;
};

export type PolicyDecisionDto = {
  decision: Decision;
  triggeredRules: string[];
  explanation: string;
  monthlySpendCents: number;
  remainingMonthlyBudgetCents: number;
  policyVersion: number;
  createdAt: string;
};

export type ApprovalDto = {
  id: string;
  purchaseRequestId: string;
  status: ApprovalStatus;
  expiresAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
};

export type OrderDto = {
  id: string;
  purchaseRequestId: string;
  paypalOrderId: string | null;
  approvalUrl: string | null;
  status: OrderStatus;
  currency: Currency;
  amountCents: number;
  captureId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuditEventDto = {
  id: string;
  actor: AuditActor;
  action: string;
  outcome: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type PurchaseRequestDto = {
  id: string;
  rawInput: string;
  status: PurchaseRequestStatus;
  extracted: {
    itemName: string | null;
    merchantName: string | null;
    category: Category | null;
    amountCents: number | null;
    currency: Currency | null;
    quantity: number;
    confidence: number | null;
    riskFlags: RiskFlag[];
    summary: string | null;
    provider: string | null;
  };
  decision: PolicyDecisionDto | null;
  approval: ApprovalDto | null;
  order: OrderDto | null;
  createdAt: string;
  updatedAt: string;
};

export type PurchaseRequestDetailDto = PurchaseRequestDto & { audit: AuditEventDto[] };

export type ApprovalListItemDto = ApprovalDto & {
  request: Pick<PurchaseRequestDto, "rawInput" | "status" | "extracted" | "decision">;
};

export type Paginated<T> = { items: T[]; nextCursor: string | null };

export type ApiErrorBody = { error: { code: string; message: string; details?: unknown } };

/* -------------------------------------------------------------------------- */
/* Guardian Checkout (merchant-initiated sessions)                            */
/* -------------------------------------------------------------------------- */

export const CheckoutItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sku: z.string().trim().max(64).optional(),
  quantity: z.number().int().min(1).max(100),
  unitAmountCents: z.number().int().min(1).max(10_000_000),
});
export type CheckoutItem = z.infer<typeof CheckoutItemSchema>;

export const AgentContextSchema = z.object({
  agentName: z.string().trim().min(1).max(80),
  goal: z.string().trim().max(500),
  reasoning: z.string().trim().max(1500),
});
export type AgentContext = z.infer<typeof AgentContextSchema>;

export const CreateCheckoutSessionInputSchema = z.object({
  items: z.array(CheckoutItemSchema).min(1).max(50),
  currency: CurrencySchema,
  category: CategorySchema,
  merchantReference: z.string().trim().max(120).optional(),
  returnUrl: z.string().url().max(2000),
  cancelUrl: z.string().url().max(2000),
  agentContext: AgentContextSchema.optional(),
});
export type CreateCheckoutSessionInput = z.infer<typeof CreateCheckoutSessionInputSchema>;

export const CHECKOUT_SESSION_STATUSES = [
  "open",
  "pending_approval",
  "approved",
  "blocked",
  "paying",
  "completed",
  "cancelled",
  "expired",
  "failed",
] as const;
export type CheckoutSessionStatus = (typeof CHECKOUT_SESSION_STATUSES)[number];

/** What the shopper sees on the Guardian checkout page. */
export type CheckoutSessionDto = {
  id: string;
  status: CheckoutSessionStatus;
  merchant: { name: string; slug: string };
  items: CheckoutItem[];
  category: Category;
  amountCents: number;
  currency: Currency;
  merchantReference: string | null;
  agentContext: AgentContext | null;
  expiresAt: string;
  request: PurchaseRequestDto | null;
  /** Set once the session is final: where to send the browser back to the merchant. */
  redirectUrl: string | null;
};

/** What the merchant's server sees. No policy details about the shopper are exposed. */
export type MerchantCheckoutSessionDto = {
  id: string;
  status: CheckoutSessionStatus;
  amountCents: number;
  currency: Currency;
  merchantReference: string | null;
  checkoutUrl: string;
  paypalOrderId: string | null;
  captureId: string | null;
  expiresAt: string;
  createdAt: string;
};

/* -------------------------------------------------------------------------- */
/* Demo store + shopping agent                                                */
/* -------------------------------------------------------------------------- */

export type StoreProduct = {
  sku: string;
  name: string;
  description: string;
  category: Category;
  priceCents: number;
  emoji: string;
  tags: string[];
};

export type AgentStep =
  | { kind: "thought"; text: string }
  | { kind: "tool"; name: string; input: unknown; output: unknown };

export type AgentRunDto = {
  agent: string;
  steps: AgentStep[];
  message: string;
  cart: { sku: string; name: string; quantity: number; unitAmountCents: number }[];
  checkout: { sessionId: string; checkoutUrl: string } | null;
};

export const AgentRunInputSchema = z.object({ goal: z.string().trim().min(3).max(500) });

export const StoreCheckoutInputSchema = z.object({
  items: z.array(z.object({ sku: z.string().min(1).max(64), quantity: z.number().int().min(1).max(20) })).min(1).max(20),
});

/* -------------------------------------------------------------------------- */
/* Helpers shared by API, policy engine and UI                                */
/* -------------------------------------------------------------------------- */

/** Canonical merchant key: "Amazon.com, Inc." and "amazon" compare equal. */
export function normalizeMerchant(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(inc|llc|ltd|co|corp|corporation|limited|plc)\b\.?/g, "")
    .replace(/\.(com|net|org|co|io|shop|store)(\.[a-z]{2})?\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function formatMoney(cents: number, currency: Currency | string = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
