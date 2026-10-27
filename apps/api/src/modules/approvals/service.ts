import type { ApprovalListItemDto, ApprovalStatus, PurchaseRequestDto } from "@guardian/shared";
import type { AppContext } from "../../context";
import type { Queryable } from "../../db/index";
import { recordAudit, type RequestMeta } from "../../lib/audit";
import { conflict, notFound } from "../../lib/errors";
import { toApprovalDto, type ApprovalRow } from "../../lib/mappers";
import { fetchRequests } from "../purchase-requests/repo";

/** Lazily expires pending approvals past their deadline (no cron needed for correctness). */
export async function expireStaleApprovals(q: Queryable, userId: string): Promise<void> {
  const { rows } = await q.query<{ purchase_request_id: string }>(
    `UPDATE approvals SET status = 'expired'
      WHERE user_id = $1 AND status = 'pending' AND expires_at <= now()
      RETURNING purchase_request_id`,
    [userId],
  );
  for (const { purchase_request_id } of rows) {
    await q.query(
      `UPDATE purchase_requests SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'pending_approval'`,
      [purchase_request_id],
    );
    await recordAudit(q, { userId, purchaseRequestId: purchase_request_id, actor: "system", action: "approval.expired", outcome: "expired" });
  }
}

export async function listApprovals(ctx: AppContext, userId: string, status?: ApprovalStatus): Promise<ApprovalListItemDto[]> {
  await ctx.db.transaction((tx) => expireStaleApprovals(tx, userId));
  const { rows } = await ctx.db.query<ApprovalRow>(
    `SELECT * FROM approvals WHERE user_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT 100`,
    [userId, status ?? null],
  );
  const ids = rows.map((a) => a.purchase_request_id);
  const requests = new Map<string, PurchaseRequestDto>(
    ids.length ? (await fetchRequests(ctx.db, userId, { ids, limit: ids.length })).map((r) => [r.id, r]) : [],
  );
  return rows.flatMap((a) => {
    const req = requests.get(a.purchase_request_id);
    if (!req) return [];
    return [{ ...toApprovalDto(a), request: { rawInput: req.rawInput, status: req.status, extracted: req.extracted, decision: req.decision } }];
  });
}

export async function decideApproval(
  ctx: AppContext,
  userId: string,
  approvalId: string,
  verdict: "approved" | "rejected",
  meta: RequestMeta,
): Promise<ApprovalListItemDto> {
  const outcome = await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<ApprovalRow & { user_id: string }>(
      `SELECT * FROM approvals WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [approvalId, userId],
    );
    const approval = rows[0];
    if (!approval) throw notFound("Approval");
    if (approval.status === "pending" && new Date(approval.expires_at) <= new Date()) {
      await expireStaleApprovals(tx, userId);
      return "expired" as const;
    }
    if (approval.status !== "pending") {
      throw conflict("APPROVAL_NOT_PENDING", `This approval is already ${approval.status}`);
    }

    const column = verdict === "approved" ? "approved_at" : "rejected_at";
    await tx.query(`UPDATE approvals SET status = $2, ${column} = now() WHERE id = $1`, [approvalId, verdict]);
    await tx.query(
      `UPDATE purchase_requests SET status = $2, updated_at = now() WHERE id = $1 AND status = 'pending_approval'`,
      [approval.purchase_request_id, verdict === "approved" ? "approved" : "rejected"],
    );
    await recordAudit(tx, {
      userId,
      purchaseRequestId: approval.purchase_request_id,
      actor: "user",
      action: verdict === "approved" ? "approval.approved" : "approval.rejected",
      outcome: verdict,
      meta,
    });
    return "ok" as const;
  });
  if (outcome === "expired") throw conflict("APPROVAL_EXPIRED", "This approval has expired. Submit the request again.");

  const [item] = (await listApprovals(ctx, userId)).filter((a) => a.id === approvalId);
  if (!item) throw notFound("Approval");
  return item;
}
