import { evaluatePolicy, POLICY_ENGINE_VERSION } from "@guardian/policy-engine";
import type { Paginated, PurchaseRequestDetailDto, PurchaseRequestDto, PurchaseRequestStatus } from "@guardian/shared";
import type { AppContext } from "../../context";
import { recordAudit, type RequestMeta } from "../../lib/audit";
import { conflict } from "../../lib/errors";
import type { PurchaseRequestRow } from "../../lib/mappers";
import { analyzePurchase, type AiAnalysis } from "../ai/index";
import { expireStaleApprovals } from "../approvals/service";
import { getCommittedSpend, getPolicyRow, lockUserBudget, toSnapshot } from "../policies/service";
import { decodeCursor, encodeCursor, fetchRequestDetail, fetchRequests, lockOwnedRequest } from "./repo";

const DECISION_STATUS = {
  approve: "approved",
  require_approval: "pending_approval",
  block: "blocked",
} as const satisfies Record<string, PurchaseRequestStatus>;

const RETRYABLE_STATUSES = new Set<string>(["blocked", "pending_approval", "expired", "failed", "rejected"]);

/**
 * The core pipeline: persist the request → AI describes it → policy decides → (maybe)
 * open an approval. The LLM call happens outside any transaction so slow model latency
 * never holds database locks.
 */
export async function createPurchaseRequest(
  ctx: AppContext,
  userId: string,
  rawInput: string,
  meta: RequestMeta,
): Promise<PurchaseRequestDetailDto> {
  const request = await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<PurchaseRequestRow>(
      `INSERT INTO purchase_requests (user_id, raw_input) VALUES ($1, $2) RETURNING *`,
      [userId, rawInput],
    );
    const row = rows[0]!;
    await recordAudit(tx, {
      userId,
      purchaseRequestId: row.id,
      actor: "user",
      action: "purchase_request.submitted",
      metadata: { rawInput },
      meta,
    });
    return row;
  });

  await analyzeAndDecide(ctx, userId, request.id, rawInput, meta);
  return fetchRequestDetail(ctx.db, userId, request.id);
}

export async function retryAnalysis(ctx: AppContext, userId: string, id: string, meta: RequestMeta): Promise<PurchaseRequestDetailDto> {
  const request = await ctx.db.transaction(async (tx) => {
    await expireStaleApprovals(tx, userId);
    const row = await lockOwnedRequest(tx, userId, id);
    if (!RETRYABLE_STATUSES.has(row.status)) {
      throw conflict("NOT_RETRYABLE", `A request that is ${row.status.replace("_", " ")} can't be re-analyzed`);
    }
    await tx.query(`UPDATE purchase_requests SET status = 'analyzing', updated_at = now() WHERE id = $1`, [id]);
    await recordAudit(tx, { userId, purchaseRequestId: id, actor: "user", action: "purchase_request.retry_requested", meta });
    return row;
  });

  await analyzeAndDecide(ctx, userId, id, request.raw_input, meta);
  return fetchRequestDetail(ctx.db, userId, id);
}

export async function getPurchaseRequest(ctx: AppContext, userId: string, id: string): Promise<PurchaseRequestDetailDto> {
  await ctx.db.transaction((tx) => expireStaleApprovals(tx, userId));
  return fetchRequestDetail(ctx.db, userId, id);
}

export async function listPurchaseRequests(
  ctx: AppContext,
  userId: string,
  opts: { limit: number; cursor?: string },
): Promise<Paginated<PurchaseRequestDto>> {
  await ctx.db.transaction((tx) => expireStaleApprovals(tx, userId));
  const items = await fetchRequests(ctx.db, userId, { before: decodeCursor(opts.cursor), limit: opts.limit + 1 });
  const page = items.slice(0, opts.limit);
  const last = page.at(-1);
  return { items: page, nextCursor: items.length > opts.limit && last ? encodeCursor(last) : null };
}

async function analyzeAndDecide(ctx: AppContext, userId: string, requestId: string, rawInput: string, meta: RequestMeta) {
  const policy = await getPolicyRow(ctx.db, userId);
  let analysis: AiAnalysis;
  try {
    analysis = await analyzePurchase(ctx.analyzer, rawInput, { defaultCurrency: toSnapshot(policy).currency as "USD" }, (reason, error) =>
      ctx.log.warn({ err: error, requestId, reason }, "AI analysis fell back to heuristic parser"),
    );
  } catch (error) {
    ctx.log.error({ err: error, requestId }, "Purchase analysis failed");
    await ctx.db.transaction(async (tx) => {
      await tx.query(`UPDATE purchase_requests SET status = 'failed', updated_at = now() WHERE id = $1`, [requestId]);
      await recordAudit(tx, { userId, purchaseRequestId: requestId, actor: "system", action: "ai.analysis_failed", outcome: "failed" });
    });
    return;
  }

  await ctx.db.transaction(async (tx) => {
    await lockUserBudget(tx, userId);
    const policyRow = await getPolicyRow(tx, userId);
    const snapshot = toSnapshot(policyRow);
    const spend = await getCommittedSpend(tx, userId, snapshot.currency);
    const { intent } = analysis;

    const result = evaluatePolicy({
      amountCents: intent.amountCents,
      currency: intent.currency,
      category: intent.category,
      merchantName: intent.merchantName,
      monthlySpendCents: spend.committedCents,
      aiConfidence: intent.confidence,
      riskFlags: analysis.riskFlags,
      policy: snapshot,
    });

    await tx.query(
      `UPDATE purchase_requests SET
         status = $2, item_name = $3, merchant_name = $4, category = $5, currency = $6, amount_cents = $7,
         quantity = $8, ai_provider = $9, ai_model = $10, ai_confidence = $11, ai_risk_flags = $12,
         ai_reasoning = $13, updated_at = now()
       WHERE id = $1`,
      [
        requestId,
        DECISION_STATUS[result.decision],
        intent.itemName,
        intent.merchantName || null,
        intent.category,
        intent.currency,
        intent.amountCents,
        intent.quantity,
        analysis.provider,
        analysis.model,
        intent.confidence,
        JSON.stringify(analysis.riskFlags),
        JSON.stringify({ summary: analysis.summary, missingFields: intent.missingFields }),
      ],
    );

    await tx.query(
      `INSERT INTO policy_decisions
         (purchase_request_id, decision, triggered_rules, explanation, monthly_spend_cents,
          remaining_monthly_budget_cents, policy_version, engine_version, policy_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        requestId,
        result.decision,
        JSON.stringify(result.triggeredRules),
        result.explanation,
        result.monthlySpendCents,
        result.remainingMonthlyBudgetCents,
        policyRow.version,
        POLICY_ENGINE_VERSION,
        JSON.stringify(snapshot),
      ],
    );

    await recordAudit(tx, {
      userId,
      purchaseRequestId: requestId,
      actor: "ai",
      action: "ai.analysis_completed",
      outcome: analysis.riskFlags.length ? "flagged" : "ok",
      metadata: { provider: analysis.provider, model: analysis.model, intent, riskFlags: analysis.riskFlags, summary: analysis.summary },
    });
    await recordAudit(tx, {
      userId,
      purchaseRequestId: requestId,
      actor: "policy_engine",
      action: "policy.evaluated",
      outcome: result.decision,
      metadata: {
        triggeredRules: result.details,
        explanation: result.explanation,
        engineVersion: result.version,
        policyVersion: policyRow.version,
        committedSpendCents: spend.committedCents,
      },
    });

    if (result.decision === "require_approval") {
      const { rows } = await tx.query<{ id: string; expires_at: Date }>(
        `INSERT INTO approvals (purchase_request_id, user_id, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))
         ON CONFLICT (purchase_request_id) DO UPDATE
           SET status = 'pending', expires_at = EXCLUDED.expires_at, approved_at = NULL, rejected_at = NULL, created_at = now()
         RETURNING id, expires_at`,
        [requestId, userId, ctx.config.approvalTtlMinutes],
      );
      await recordAudit(tx, {
        userId,
        purchaseRequestId: requestId,
        actor: "system",
        action: "approval.requested",
        outcome: "pending",
        metadata: { approvalId: rows[0]!.id, expiresAt: new Date(rows[0]!.expires_at).toISOString() },
        meta,
      });
    }
  });
}
