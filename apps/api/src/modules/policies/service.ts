import type { PolicySnapshot } from "@guardian/policy-engine";
import type { PolicyDto, UpdatePolicyInput, UsageDto } from "@guardian/shared";
import type { AppContext } from "../../context";
import type { Queryable } from "../../db/index";
import { recordAudit, type RequestMeta } from "../../lib/audit";
import { notFound } from "../../lib/errors";
import { toPolicyDto, type PolicyRow } from "../../lib/mappers";

/** Unpaid checkouts hold budget for this long, then stop counting (PayPal orders expire anyway). */
export const RESERVATION_WINDOW_HOURS = 6;

const MONTH_START_UTC = `(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

/**
 * Serializes budget-affecting work per user for the rest of the transaction, so two
 * concurrent requests can't both pass the monthly-limit check. Scales horizontally:
 * the lock lives in Postgres, not in any one API process.
 */
export async function lockUserBudget(q: Queryable, userId: string): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 42))`, [userId]);
}

export async function getPolicyRow(q: Queryable, userId: string): Promise<PolicyRow> {
  const { rows } = await q.query<PolicyRow>(`SELECT * FROM user_policies WHERE user_id = $1`, [userId]);
  if (!rows[0]) throw notFound("Policy");
  return rows[0];
}

export function toSnapshot(row: PolicyRow): PolicySnapshot {
  const dto = toPolicyDto(row);
  return {
    currency: dto.currency,
    monthlyLimitCents: dto.monthlyLimitCents,
    perPurchaseLimitCents: dto.perPurchaseLimitCents,
    requireApprovalAboveCents: dto.requireApprovalAboveCents,
    blockedCategories: dto.blockedCategories,
    allowedMerchants: dto.allowedMerchants,
    blockedMerchants: dto.blockedMerchants,
    riskSensitivity: dto.riskSensitivity,
  };
}

/**
 * Spend committed this calendar month (UTC): captured orders plus checkouts still in
 * flight. Counting in-flight orders stops two concurrent purchases from both fitting
 * into the same remaining budget.
 */
export async function getCommittedSpend(
  q: Queryable,
  userId: string,
  currency: string,
): Promise<{ spentCents: number; reservedCents: number; committedCents: number }> {
  const { rows } = await q.query<{ spent: number; reserved: number }>(
    `SELECT
       COALESCE(SUM(amount_cents) FILTER (WHERE status = 'completed'), 0)::bigint AS spent,
       COALESCE(SUM(amount_cents) FILTER (
         WHERE status IN ('creating', 'created', 'approved')
           AND created_at > now() - make_interval(hours => $3)
       ), 0)::bigint AS reserved
     FROM paypal_orders
     WHERE user_id = $1 AND currency = $2 AND created_at >= ${MONTH_START_UTC}`,
    [userId, currency, RESERVATION_WINDOW_HOURS],
  );
  const spentCents = rows[0]?.spent ?? 0;
  const reservedCents = rows[0]?.reserved ?? 0;
  return { spentCents, reservedCents, committedCents: spentCents + reservedCents };
}

export async function getPolicy(ctx: AppContext, userId: string): Promise<PolicyDto> {
  return toPolicyDto(await getPolicyRow(ctx.db, userId));
}

export async function updatePolicy(ctx: AppContext, userId: string, input: UpdatePolicyInput, meta: RequestMeta): Promise<PolicyDto> {
  return ctx.db.transaction(async (tx) => {
    const before = toPolicyDto(await getPolicyRow(tx, userId));
    const { rows } = await tx.query<PolicyRow>(
      `UPDATE user_policies SET
         currency = $2, monthly_limit_cents = $3, per_purchase_limit_cents = $4,
         require_approval_above_cents = $5, blocked_categories = $6, allowed_merchants = $7,
         blocked_merchants = $8, risk_sensitivity = $9, version = version + 1, updated_at = now()
       WHERE user_id = $1
       RETURNING *`,
      [
        userId,
        input.currency,
        input.monthlyLimitCents,
        input.perPurchaseLimitCents,
        input.requireApprovalAboveCents,
        JSON.stringify(input.blockedCategories),
        JSON.stringify(input.allowedMerchants),
        JSON.stringify(input.blockedMerchants),
        input.riskSensitivity,
      ],
    );
    const after = toPolicyDto(rows[0]!);
    await recordAudit(tx, {
      userId,
      actor: "user",
      action: "policy.updated",
      outcome: `v${after.version}`,
      metadata: { before, after },
      meta,
    });
    return after;
  });
}

export async function getUsage(ctx: AppContext, userId: string): Promise<UsageDto> {
  const policy = await getPolicyRow(ctx.db, userId);
  const currency = policy.currency.trim();
  const spend = await getCommittedSpend(ctx.db, userId, currency);
  const { rows } = await ctx.db.query<{ n: number; month_start: Date }>(
    `SELECT
       (SELECT count(*) FROM approvals WHERE user_id = $1 AND status = 'pending' AND expires_at > now())::int AS n,
       ${MONTH_START_UTC} AS month_start`,
    [userId],
  );
  return {
    currency: currency as UsageDto["currency"],
    monthlyLimitCents: policy.monthly_limit_cents,
    spentCents: spend.spentCents,
    reservedCents: spend.reservedCents,
    remainingCents: Math.max(0, policy.monthly_limit_cents - spend.committedCents),
    periodStart: new Date(rows[0]!.month_start).toISOString(),
    pendingApprovals: rows[0]!.n,
  };
}
