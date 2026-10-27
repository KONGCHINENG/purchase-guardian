import type { AuditActor } from "@guardian/shared";
import type { Queryable } from "../db/index";

export type RequestMeta = { ip?: string | null; userAgent?: string | null };

export type AuditEntry = {
  userId: string | null;
  purchaseRequestId?: string | null;
  actor: AuditActor;
  action: string;
  outcome?: string | null;
  metadata?: Record<string, unknown>;
  meta?: RequestMeta;
};

/**
 * Appends to the immutable audit log. Always pass the transaction the state change
 * happens in, so the event and the change commit (or roll back) together.
 */
export async function recordAudit(q: Queryable, entry: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_events (user_id, purchase_request_id, actor, action, outcome, metadata, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.userId,
      entry.purchaseRequestId ?? null,
      entry.actor,
      entry.action,
      entry.outcome ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.meta?.ip ?? null,
      entry.meta?.userAgent?.slice(0, 512) ?? null,
    ],
  );
}
