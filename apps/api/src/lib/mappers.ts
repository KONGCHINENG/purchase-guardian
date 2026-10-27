/** Row → DTO mappers. The DB speaks snake_case; the API speaks camelCase. */
import type {
  ApprovalDto,
  AuditEventDto,
  OrderDto,
  PolicyDecisionDto,
  PolicyDto,
  PurchaseRequestDto,
  UserDto,
} from "@guardian/shared";

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());
const isoReq = (d: Date | string): string => new Date(d).toISOString();

export type UserRow = { id: string; email: string; full_name: string | null; status: string; password_hash: string; created_at: Date };
export const toUserDto = (r: UserRow): UserDto => ({ id: r.id, email: r.email, fullName: r.full_name, createdAt: isoReq(r.created_at) });

export type PolicyRow = {
  currency: string;
  monthly_limit_cents: number;
  per_purchase_limit_cents: number;
  require_approval_above_cents: number;
  blocked_categories: string[];
  allowed_merchants: string[];
  blocked_merchants: string[];
  risk_sensitivity: string;
  version: number;
  updated_at: Date;
};
export const toPolicyDto = (r: PolicyRow): PolicyDto => ({
  currency: r.currency.trim() as PolicyDto["currency"],
  monthlyLimitCents: r.monthly_limit_cents,
  perPurchaseLimitCents: r.per_purchase_limit_cents,
  requireApprovalAboveCents: r.require_approval_above_cents,
  blockedCategories: r.blocked_categories as PolicyDto["blockedCategories"],
  allowedMerchants: r.allowed_merchants,
  blockedMerchants: r.blocked_merchants,
  riskSensitivity: r.risk_sensitivity as PolicyDto["riskSensitivity"],
  version: r.version,
  updatedAt: isoReq(r.updated_at),
});

export type DecisionRow = {
  decision: string;
  triggered_rules: string[];
  explanation: string;
  monthly_spend_cents: number;
  remaining_monthly_budget_cents: number;
  policy_version: number;
  created_at: Date;
};
export const toDecisionDto = (r: DecisionRow): PolicyDecisionDto => ({
  decision: r.decision as PolicyDecisionDto["decision"],
  triggeredRules: r.triggered_rules,
  explanation: r.explanation,
  monthlySpendCents: r.monthly_spend_cents,
  remainingMonthlyBudgetCents: r.remaining_monthly_budget_cents,
  policyVersion: r.policy_version,
  createdAt: isoReq(r.created_at),
});

export type ApprovalRow = {
  id: string;
  purchase_request_id: string;
  status: string;
  expires_at: Date;
  approved_at: Date | null;
  rejected_at: Date | null;
  created_at: Date;
};
export const toApprovalDto = (r: ApprovalRow): ApprovalDto => ({
  id: r.id,
  purchaseRequestId: r.purchase_request_id,
  status: r.status as ApprovalDto["status"],
  expiresAt: isoReq(r.expires_at),
  approvedAt: iso(r.approved_at),
  rejectedAt: iso(r.rejected_at),
  createdAt: isoReq(r.created_at),
});

export type OrderRow = {
  id: string;
  purchase_request_id: string;
  user_id: string;
  paypal_order_id: string | null;
  approval_url: string | null;
  status: string;
  currency: string;
  amount_cents: number;
  idempotency_key: string;
  capture_id: string | null;
  created_at: Date;
  updated_at: Date;
};
export const toOrderDto = (r: OrderRow): OrderDto => ({
  id: r.id,
  purchaseRequestId: r.purchase_request_id,
  paypalOrderId: r.paypal_order_id,
  // Only expose the approval link while the buyer still needs it.
  approvalUrl: r.status === "created" ? r.approval_url : null,
  status: r.status as OrderDto["status"],
  currency: r.currency.trim() as OrderDto["currency"],
  amountCents: r.amount_cents,
  captureId: r.capture_id,
  createdAt: isoReq(r.created_at),
  updatedAt: isoReq(r.updated_at),
});

export type PurchaseRequestRow = {
  id: string;
  user_id: string;
  raw_input: string;
  status: string;
  item_name: string | null;
  merchant_name: string | null;
  category: string | null;
  currency: string | null;
  amount_cents: number | null;
  quantity: number;
  ai_provider: string | null;
  ai_model: string | null;
  ai_confidence: number | null;
  ai_risk_flags: string[];
  ai_reasoning: { summary?: string } | null;
  created_at: Date;
  updated_at: Date;
};
export const toPurchaseRequestDto = (
  r: PurchaseRequestRow,
  related: { decision?: DecisionRow | null; approval?: ApprovalRow | null; order?: OrderRow | null } = {},
): PurchaseRequestDto => ({
  id: r.id,
  rawInput: r.raw_input,
  status: r.status as PurchaseRequestDto["status"],
  extracted: {
    itemName: r.item_name,
    merchantName: r.merchant_name,
    category: r.category as PurchaseRequestDto["extracted"]["category"],
    amountCents: r.amount_cents,
    currency: (r.currency?.trim() ?? null) as PurchaseRequestDto["extracted"]["currency"],
    quantity: r.quantity,
    confidence: r.ai_confidence,
    riskFlags: r.ai_risk_flags as PurchaseRequestDto["extracted"]["riskFlags"],
    summary: r.ai_reasoning?.summary ?? null,
    provider: r.ai_provider,
  },
  decision: related.decision ? toDecisionDto(related.decision) : null,
  approval: related.approval ? toApprovalDto(related.approval) : null,
  order: related.order ? toOrderDto(related.order) : null,
  createdAt: isoReq(r.created_at),
  updatedAt: isoReq(r.updated_at),
});

export type AuditRow = { id: string | number; actor: string; action: string; outcome: string | null; metadata: Record<string, unknown>; created_at: Date };
export const toAuditDto = (r: AuditRow): AuditEventDto => ({
  id: String(r.id),
  actor: r.actor as AuditEventDto["actor"],
  action: r.action,
  outcome: r.outcome,
  metadata: r.metadata,
  createdAt: isoReq(r.created_at),
});
