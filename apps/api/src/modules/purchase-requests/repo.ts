import type { PurchaseRequestDetailDto, PurchaseRequestDto } from "@guardian/shared";
import type { Queryable } from "../../db/index";
import { notFound } from "../../lib/errors";
import {
  toAuditDto,
  toPurchaseRequestDto,
  type ApprovalRow,
  type AuditRow,
  type DecisionRow,
  type OrderRow,
  type PurchaseRequestRow,
} from "../../lib/mappers";

type JoinedRow = PurchaseRequestRow & {
  decision_json: DecisionRow | null;
  approval_json: ApprovalRow | null;
  order_json: OrderRow | null;
};

/** One round trip: requests with their latest decision, approval and order. */
export async function fetchRequests(
  q: Queryable,
  userId: string,
  opts: { ids?: string[]; id?: string; before?: { createdAt: string; id: string }; limit: number },
): Promise<PurchaseRequestDto[]> {
  const { rows } = await q.query<JoinedRow>(
    `SELECT pr.*,
            row_to_json(d) AS decision_json,
            row_to_json(a) AS approval_json,
            row_to_json(o) AS order_json
       FROM purchase_requests pr
       LEFT JOIN LATERAL (
         SELECT * FROM policy_decisions WHERE purchase_request_id = pr.id ORDER BY created_at DESC LIMIT 1
       ) d ON true
       LEFT JOIN approvals a ON a.purchase_request_id = pr.id
       LEFT JOIN paypal_orders o ON o.purchase_request_id = pr.id
      WHERE pr.user_id = $1
        AND ($2::uuid[] IS NULL OR pr.id = ANY($2::uuid[]))
        AND ($3::timestamptz IS NULL OR (pr.created_at, pr.id) < ($3::timestamptz, $4::uuid))
      ORDER BY pr.created_at DESC, pr.id DESC
      LIMIT $5`,
    [
      userId,
      opts.ids ?? (opts.id ? [opts.id] : null),
      opts.before?.createdAt ?? null,
      opts.before?.id ?? null,
      opts.limit,
    ],
  );
  return rows.map((r) => toPurchaseRequestDto(r, { decision: r.decision_json, approval: r.approval_json, order: r.order_json }));
}

export async function fetchRequestDetail(q: Queryable, userId: string, id: string): Promise<PurchaseRequestDetailDto> {
  const [request] = await fetchRequests(q, userId, { id, limit: 1 });
  if (!request) throw notFound("Purchase request");
  const { rows } = await q.query<AuditRow>(
    `SELECT id, actor, action, outcome, metadata, created_at FROM audit_events WHERE purchase_request_id = $1 ORDER BY id`,
    [id],
  );
  return { ...request, audit: rows.map(toAuditDto) };
}

/** Locks and returns a request owned by `userId` (404 for anyone else — never leak existence). */
export async function lockOwnedRequest(q: Queryable, userId: string, id: string): Promise<PurchaseRequestRow> {
  const { rows } = await q.query<PurchaseRequestRow>(
    `SELECT * FROM purchase_requests WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [id, userId],
  );
  if (!rows[0]) throw notFound("Purchase request");
  return rows[0];
}

export function encodeCursor(item: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify([item.createdAt, item.id])).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [string, string];
    if (Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}
