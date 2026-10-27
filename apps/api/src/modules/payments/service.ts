import { randomUUID } from "node:crypto";
import { evaluatePolicy } from "@guardian/policy-engine";
import { PayPalApiError, PayPalHttpGateway, type CapturedOrder } from "@guardian/paypal-client";
import type { AuditActor, OrderDto } from "@guardian/shared";
import type { AppContext } from "../../context";
import type { Queryable } from "../../db/index";
import { recordAudit, type RequestMeta } from "../../lib/audit";
import { AppError, conflict, notFound } from "../../lib/errors";
import { toOrderDto, type ApprovalRow, type OrderRow } from "../../lib/mappers";
import { expireStaleApprovals } from "../approvals/service";
import { getCommittedSpend, getPolicyRow, lockUserBudget, toSnapshot } from "../policies/service";
import { lockOwnedRequest } from "../purchase-requests/repo";

type Gate =
  | { kind: "ready"; order: OrderRow; callPayPal: boolean; description: string }
  | { kind: "denied"; error: AppError };

/**
 * Creates (or idempotently returns) the PayPal order for a purchase request.
 *
 * Every guard runs inside one transaction under the user's budget lock:
 * ownership, request status, approval validity, a fresh policy re-check with
 * up-to-date spend, and the one-order-per-request constraint. Only then do we call
 * PayPal, outside the transaction, with a stable PayPal-Request-Id so a retry after
 * a crash or timeout returns the same PayPal order instead of creating a second one.
 */
export async function createOrder(
  ctx: AppContext,
  userId: string,
  purchaseRequestId: string,
  meta: RequestMeta,
  /** Where PayPal sends the buyer back; defaults to the in-app checkout pages. */
  redirect?: { returnUrl: string; cancelUrl: string; brandName?: string },
): Promise<OrderDto> {
  const gate = await ctx.db.transaction<Gate>(async (tx) => {
    await lockUserBudget(tx, userId);
    await expireStaleApprovals(tx, userId);
    const request = await lockOwnedRequest(tx, userId, purchaseRequestId);
    const description = `${request.item_name ?? "Purchase"}${request.merchant_name ? ` — ${request.merchant_name}` : ""}`;

    const { rows: existing } = await tx.query<OrderRow>(`SELECT * FROM paypal_orders WHERE purchase_request_id = $1`, [purchaseRequestId]);
    if (existing[0]) {
      const order = existing[0];
      if (order.status === "voided") return { kind: "denied", error: conflict("ORDER_VOIDED", "This checkout was cancelled") };
      // creating/failed: a previous attempt didn't finish; retry it with the same idempotency key.
      return { kind: "ready", order, callPayPal: order.status === "creating" || order.status === "failed", description };
    }

    if (request.status !== "approved") {
      const reasons: Record<string, [string, string]> = {
        pending_approval: ["APPROVAL_REQUIRED", "This purchase needs your approval before checkout"],
        blocked: ["PURCHASE_BLOCKED", "This purchase was blocked by your policy"],
        rejected: ["PURCHASE_REJECTED", "This purchase was rejected"],
        expired: ["APPROVAL_EXPIRED", "The approval window for this purchase has expired"],
      };
      const [code, message] = reasons[request.status] ?? ["NOT_PAYABLE", `A ${request.status.replace("_", " ")} request can't be paid`];
      return { kind: "denied", error: conflict(code, message) };
    }

    const { rows: approvals } = await tx.query<ApprovalRow>(`SELECT * FROM approvals WHERE purchase_request_id = $1`, [purchaseRequestId]);
    const approval = approvals[0];
    const humanApproved = approval?.status === "approved";
    if (humanApproved && new Date(approval.expires_at) <= new Date()) {
      await tx.query(`UPDATE approvals SET status = 'expired' WHERE id = $1`, [approval.id]);
      await tx.query(`UPDATE purchase_requests SET status = 'expired', updated_at = now() WHERE id = $1`, [purchaseRequestId]);
      await recordAudit(tx, { userId, purchaseRequestId, actor: "system", action: "approval.expired", outcome: "expired_before_checkout" });
      return { kind: "denied", error: conflict("APPROVAL_EXPIRED", "Your approval expired before checkout. Submit the request again.") };
    }

    if (request.amount_cents === null || request.amount_cents <= 0 || !request.currency) {
      return { kind: "denied", error: conflict("NOT_PAYABLE", "This request has no payable amount") };
    }

    // Re-check against *current* policy and spend: limits may have changed, or other
    // purchases may have used the budget, since the original decision.
    const policy = await getPolicyRow(tx, userId);
    const snapshot = toSnapshot(policy);
    const spend = await getCommittedSpend(tx, userId, snapshot.currency);
    const recheck = evaluatePolicy({
      amountCents: request.amount_cents,
      currency: request.currency.trim(),
      category: request.category ?? "other",
      merchantName: request.merchant_name ?? "",
      monthlySpendCents: spend.committedCents,
      aiConfidence: request.ai_confidence ?? 0,
      riskFlags: request.ai_risk_flags,
      policy: snapshot,
    });
    if (recheck.decision === "block" || (recheck.decision === "require_approval" && !humanApproved)) {
      await recordAudit(tx, {
        userId,
        purchaseRequestId,
        actor: "policy_engine",
        action: "payment.checkout_denied",
        outcome: recheck.decision,
        metadata: { triggeredRules: recheck.details, explanation: recheck.explanation, policyVersion: policy.version },
        meta,
      });
      return {
        kind: "denied",
        error: conflict("POLICY_CHANGED", `Checkout stopped by your current policy. ${recheck.explanation}`, { triggeredRules: recheck.triggeredRules }),
      };
    }

    const { rows } = await tx.query<OrderRow>(
      `INSERT INTO paypal_orders (purchase_request_id, user_id, status, currency, amount_cents, idempotency_key)
       VALUES ($1, $2, 'creating', $3, $4, $5) RETURNING *`,
      [purchaseRequestId, userId, request.currency.trim(), request.amount_cents, randomUUID()],
    );
    await recordAudit(tx, {
      userId,
      purchaseRequestId,
      actor: "user",
      action: "payment.checkout_requested",
      metadata: { amountCents: request.amount_cents, currency: request.currency.trim(), humanApproved },
      meta,
    });
    return { kind: "ready", order: rows[0]!, callPayPal: true, description };
  });

  // Denials are thrown after commit so their audit events persist.
  if (gate.kind === "denied") throw gate.error;
  if (!gate.callPayPal) return toOrderDto(gate.order);

  const order = gate.order;
  try {
    const created = await ctx.paypal.createOrder({
      requestId: order.idempotency_key,
      referenceId: order.purchase_request_id,
      description: gate.description,
      amountCents: order.amount_cents,
      currency: order.currency.trim(),
      returnUrl: redirect?.returnUrl ?? `${ctx.config.webUrl}/checkout/return?orderId=${order.id}`,
      cancelUrl: redirect?.cancelUrl ?? `${ctx.config.webUrl}/checkout/cancel?orderId=${order.id}`,
      brandName: redirect?.brandName,
    });
    return await ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<OrderRow>(
        `UPDATE paypal_orders SET status = 'created', paypal_order_id = $2, approval_url = $3, paypal_response = $4, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [order.id, created.id, created.approvalUrl, JSON.stringify(created.raw)],
      );
      await tx.query(`UPDATE purchase_requests SET status = 'checkout_created', updated_at = now() WHERE id = $1`, [order.purchase_request_id]);
      await recordAudit(tx, {
        userId,
        purchaseRequestId: order.purchase_request_id,
        actor: "system",
        action: "payment.order_created",
        outcome: created.status,
        metadata: { paypalOrderId: created.id, environment: ctx.paypal.environment, amountCents: order.amount_cents },
      });
      return toOrderDto(rows[0]!);
    });
  } catch (error) {
    ctx.log.error({ err: error, orderId: order.id }, "PayPal order creation failed");
    await ctx.db.transaction(async (tx) => {
      await tx.query(`UPDATE paypal_orders SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'creating'`, [order.id]);
      await recordAudit(tx, {
        userId,
        purchaseRequestId: order.purchase_request_id,
        actor: "system",
        action: "payment.order_failed",
        outcome: "failed",
        metadata: describePayPalError(error),
      });
    });
    throw new AppError(502, "PAYPAL_UNAVAILABLE", "PayPal couldn't create the checkout. Please try again.");
  }
}

export async function getOrder(ctx: AppContext, userId: string, orderId: string): Promise<OrderDto> {
  return toOrderDto(await findOwnedOrder(ctx.db, userId, orderId));
}

export async function listOrders(ctx: AppContext, userId: string): Promise<OrderDto[]> {
  const { rows } = await ctx.db.query<OrderRow>(
    `SELECT * FROM paypal_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
  return rows.map(toOrderDto);
}

export async function captureOrder(ctx: AppContext, userId: string, orderId: string, meta: RequestMeta): Promise<OrderDto> {
  const order = await findOwnedOrder(ctx.db, userId, orderId);
  if (order.status === "completed") return toOrderDto(order);
  if (order.status !== "created" && order.status !== "approved") {
    throw conflict("ORDER_NOT_CAPTURABLE", `This order is ${order.status} and can't be captured`);
  }
  return captureOrderRow(ctx, order, "user", meta);
}

/**
 * Captures a PayPal order. Safe to call repeatedly and concurrently (user return page and
 * webhook racing): the capture uses a stable PayPal-Request-Id, ORDER_ALREADY_CAPTURED is
 * treated as success, and the DB transition only fires once.
 */
export async function captureOrderRow(ctx: AppContext, order: OrderRow, actor: AuditActor, meta?: RequestMeta): Promise<OrderDto> {
  if (!order.paypal_order_id) throw conflict("ORDER_NOT_READY", "Checkout hasn't been created yet");

  let result: CapturedOrder;
  try {
    result = await ctx.paypal.captureOrder(order.paypal_order_id, `${order.idempotency_key}-capture`);
  } catch (error) {
    if (error instanceof PayPalApiError && error.issue === "ORDER_ALREADY_CAPTURED") {
      result = PayPalHttpGateway.captureFromSnapshot(await ctx.paypal.getOrder(order.paypal_order_id));
    } else if (error instanceof PayPalApiError && (error.issue === "ORDER_NOT_APPROVED" || error.issue === "PAYER_ACTION_REQUIRED")) {
      throw conflict("ORDER_NOT_APPROVED", "Finish approving the payment in PayPal first");
    } else if (error instanceof PayPalApiError && error.issue === "INSTRUMENT_DECLINED") {
      throw conflict("PAYMENT_DECLINED", "PayPal declined the payment method. Open PayPal again to choose another one.", {
        approvalUrl: order.approval_url,
      });
    } else {
      ctx.log.error({ err: error, orderId: order.id }, "PayPal capture failed");
      throw new AppError(502, "PAYPAL_UNAVAILABLE", "PayPal couldn't complete the payment. Please try again.");
    }
  }

  const amountMismatch =
    result.amountCents !== null && (result.amountCents !== order.amount_cents || result.currency !== order.currency.trim());
  const nextStatus = amountMismatch
    ? "failed"
    : result.status === "COMPLETED" && result.captureStatus === "COMPLETED"
      ? "completed"
      : result.captureStatus === "DECLINED" || result.captureStatus === "FAILED"
        ? "failed"
        : "approved"; // e.g. capture PENDING: the PAYMENT.CAPTURE.COMPLETED webhook finishes it

  const updated = await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<OrderRow>(
      `UPDATE paypal_orders SET status = $2, capture_id = COALESCE($3, capture_id), paypal_response = $4, updated_at = now()
       WHERE id = $1 AND status <> 'completed' RETURNING *`,
      [order.id, nextStatus, result.captureId, JSON.stringify(result.raw)],
    );
    if (!rows[0]) return null; // someone else already completed it
    if (nextStatus === "completed" || nextStatus === "failed") {
      await tx.query(`UPDATE purchase_requests SET status = $2, updated_at = now() WHERE id = $1`, [order.purchase_request_id, nextStatus]);
    }
    await recordAudit(tx, {
      userId: order.user_id,
      purchaseRequestId: order.purchase_request_id,
      actor,
      action: amountMismatch ? "payment.amount_mismatch" : nextStatus === "completed" ? "payment.captured" : "payment.capture_" + nextStatus,
      outcome: result.captureStatus ?? result.status,
      metadata: {
        paypalOrderId: order.paypal_order_id,
        captureId: result.captureId,
        expectedAmountCents: order.amount_cents,
        capturedAmountCents: result.amountCents,
        currency: result.currency,
        ...(amountMismatch ? { requiresManualReview: true } : {}),
      },
      meta,
    });
    return rows[0];
  });

  if (amountMismatch) {
    ctx.log.error({ orderId: order.id, expected: order.amount_cents, captured: result.amountCents }, "Captured amount mismatch");
    throw new AppError(502, "AMOUNT_MISMATCH", "The captured amount didn't match the approved amount. Flagged for review.");
  }
  return toOrderDto(updated ?? (await findOrderById(ctx.db, order.id)));
}

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

type WebhookEvent = {
  id: string;
  event_type: string;
  resource?: { id?: string; status?: string; supplementary_data?: { related_ids?: { order_id?: string } } };
};

/** Idempotent webhook handling: events are stored first, processed, then marked done. */
export async function handlePayPalWebhook(ctx: AppContext, event: WebhookEvent): Promise<"processed" | "duplicate" | "ignored"> {
  const paypalOrderId =
    event.event_type.startsWith("CHECKOUT.ORDER") ? event.resource?.id : event.resource?.supplementary_data?.related_ids?.order_id;

  await ctx.db.query(
    `INSERT INTO webhook_events (id, event_type, resource_id, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [event.id, event.event_type, paypalOrderId ?? null, JSON.stringify(event)],
  );
  const { rows: seen } = await ctx.db.query<{ processed_at: Date | null }>(`SELECT processed_at FROM webhook_events WHERE id = $1`, [event.id]);
  if (seen[0]?.processed_at) return "duplicate";

  const order = paypalOrderId ? await findOrderByPayPalId(ctx.db, paypalOrderId) : null;
  let outcome: "processed" | "ignored" = "ignored";

  if (order) {
    switch (event.event_type) {
      case "CHECKOUT.ORDER.APPROVED": {
        if (order.status === "created") {
          await ctx.db.transaction(async (tx) => {
            await tx.query(`UPDATE paypal_orders SET status = 'approved', updated_at = now() WHERE id = $1 AND status = 'created'`, [order.id]);
            await recordAudit(tx, { userId: order.user_id, purchaseRequestId: order.purchase_request_id, actor: "paypal", action: "payment.buyer_approved", outcome: "approved", metadata: { webhookEventId: event.id } });
          });
        }
        // Capture server-side too, so payment completes even if the buyer closes the tab.
        if (order.status !== "completed") await captureOrderRow(ctx, { ...order, status: "approved" }, "system");
        outcome = "processed";
        break;
      }
      case "PAYMENT.CAPTURE.COMPLETED": {
        await ctx.db.transaction(async (tx) => {
          const { rows } = await tx.query(
            `UPDATE paypal_orders SET status = 'completed', capture_id = COALESCE(capture_id, $2), updated_at = now()
             WHERE id = $1 AND status <> 'completed' RETURNING id`,
            [order.id, event.resource?.id ?? null],
          );
          if (!rows[0]) return;
          await tx.query(`UPDATE purchase_requests SET status = 'completed', updated_at = now() WHERE id = $1`, [order.purchase_request_id]);
          await recordAudit(tx, { userId: order.user_id, purchaseRequestId: order.purchase_request_id, actor: "paypal", action: "payment.captured", outcome: "COMPLETED", metadata: { webhookEventId: event.id, captureId: event.resource?.id } });
        });
        outcome = "processed";
        break;
      }
      case "PAYMENT.CAPTURE.DENIED":
      case "PAYMENT.CAPTURE.DECLINED": {
        await ctx.db.transaction(async (tx) => {
          await tx.query(`UPDATE paypal_orders SET status = 'failed', updated_at = now() WHERE id = $1 AND status <> 'completed'`, [order.id]);
          await tx.query(`UPDATE purchase_requests SET status = 'failed', updated_at = now() WHERE id = $1 AND status <> 'completed'`, [order.purchase_request_id]);
          await recordAudit(tx, { userId: order.user_id, purchaseRequestId: order.purchase_request_id, actor: "paypal", action: "payment.capture_denied", outcome: event.event_type, metadata: { webhookEventId: event.id } });
        });
        outcome = "processed";
        break;
      }
      default:
        await recordAudit(ctx.db, { userId: order.user_id, purchaseRequestId: order.purchase_request_id, actor: "paypal", action: "webhook.received", outcome: event.event_type, metadata: { webhookEventId: event.id } });
    }
  }

  await ctx.db.query(`UPDATE webhook_events SET processed_at = now() WHERE id = $1`, [event.id]);
  return outcome;
}

/* -------------------------------------------------------------------------- */

async function findOwnedOrder(q: Queryable, userId: string, orderId: string): Promise<OrderRow> {
  const { rows } = await q.query<OrderRow>(`SELECT * FROM paypal_orders WHERE id = $1 AND user_id = $2`, [orderId, userId]);
  if (!rows[0]) throw notFound("Order");
  return rows[0];
}

async function findOrderById(q: Queryable, orderId: string): Promise<OrderRow> {
  const { rows } = await q.query<OrderRow>(`SELECT * FROM paypal_orders WHERE id = $1`, [orderId]);
  if (!rows[0]) throw notFound("Order");
  return rows[0];
}

async function findOrderByPayPalId(q: Queryable, paypalOrderId: string): Promise<OrderRow | null> {
  const { rows } = await q.query<OrderRow>(`SELECT * FROM paypal_orders WHERE paypal_order_id = $1`, [paypalOrderId]);
  return rows[0] ?? null;
}

function describePayPalError(error: unknown): Record<string, unknown> {
  if (error instanceof PayPalApiError) return { status: error.status, issue: error.issue, debugId: error.debugId, message: error.message };
  return { message: error instanceof Error ? error.message : String(error) };
}
