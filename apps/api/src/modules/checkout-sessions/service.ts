/**
 * Guardian Checkout: a 3-D-Secure-style step in front of PayPal.
 *
 *   merchant/agent ──POST /checkout-sessions──▶ Guardian ──redirect──▶ /pay/:id (shopper)
 *     ▶ policy decision (approve / ask / block) ─▶ PayPal approval ─▶ capture
 *     ▶ redirect back to the merchant's return URL with the outcome
 *
 * Merchants never see the shopper's policy, only the outcome. Return URLs must match
 * the merchant's registered origins, so Guardian can't be abused as an open redirect.
 */
import { createHmac, randomBytes } from "node:crypto";
import type {
  CheckoutSessionDto,
  CheckoutSessionStatus,
  CreateCheckoutSessionInput,
  MerchantCheckoutSessionDto,
  PurchaseRequestDto,
} from "@guardian/shared";
import { formatMoney } from "@guardian/shared";
import type { AppContext } from "../../context";
import type { Queryable } from "../../db/index";
import { recordAudit, type RequestMeta } from "../../lib/audit";
import { badRequest, conflict, notFound } from "../../lib/errors";
import type { OrderRow } from "../../lib/mappers";
import { hashToken } from "../../lib/security";
import { detectRiskSignals } from "../ai/heuristic";
import type { AiAnalysis } from "../ai/index";
import { captureOrder, createOrder } from "../payments/service";
import { applyPolicyDecision } from "../purchase-requests/service";
import { fetchRequests } from "../purchase-requests/repo";

export type MerchantRow = { id: string; name: string; slug: string; allowed_return_origins: string[] };

type SessionRow = {
  id: string;
  merchant_id: string;
  user_id: string | null;
  purchase_request_id: string | null;
  status: CheckoutSessionStatus;
  merchant_reference: string | null;
  items: CheckoutSessionDto["items"];
  category: CheckoutSessionDto["category"];
  amount_cents: number;
  currency: string;
  return_url: string;
  cancel_url: string;
  agent_context: CheckoutSessionDto["agentContext"];
  expires_at: Date;
  created_at: Date;
  merchant_name: string;
  merchant_slug: string;
};

const FINAL: ReadonlySet<CheckoutSessionStatus> = new Set(["blocked", "completed", "cancelled", "expired", "failed"]);

/* -------------------------------------------------------------------------- */
/* Merchants                                                                  */
/* -------------------------------------------------------------------------- */

export function generateMerchantKey(): string {
  return `pgm_${randomBytes(24).toString("base64url")}`;
}

export async function findMerchantByKey(q: Queryable, apiKey: string): Promise<MerchantRow | null> {
  const { rows } = await q.query<MerchantRow>(`SELECT id, name, slug, allowed_return_origins FROM merchants WHERE api_key_hash = $1`, [hashToken(apiKey)]);
  return rows[0] ?? null;
}

export async function createMerchant(q: Queryable, input: { name: string; slug: string; origins: string[]; apiKey?: string }) {
  const apiKey = input.apiKey ?? generateMerchantKey();
  const origins = input.origins.map((o) => new URL(o).origin);
  const { rows } = await q.query<MerchantRow>(
    `INSERT INTO merchants (name, slug, api_key_hash, allowed_return_origins) VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, api_key_hash = EXCLUDED.api_key_hash, allowed_return_origins = EXCLUDED.allowed_return_origins
     RETURNING id, name, slug, allowed_return_origins`,
    [input.name, input.slug, hashToken(apiKey), JSON.stringify(origins)],
  );
  return { merchant: rows[0]!, apiKey };
}

/** The built-in demo store's key is derived from the server secret, so it's stable without being stored. */
export function demoMerchantKey(jwtSecret: string): string {
  return `pgm_demo_${createHmac("sha256", jwtSecret).update("demo-store").digest("base64url")}`;
}

export async function ensureDemoMerchant(ctx: Pick<AppContext, "db" | "config">): Promise<MerchantRow> {
  const { merchant } = await createMerchant(ctx.db, {
    name: "Northwind Market",
    slug: "demo-store",
    origins: [ctx.config.webUrl],
    apiKey: demoMerchantKey(ctx.config.auth.jwtSecret),
  });
  return merchant;
}

/* -------------------------------------------------------------------------- */
/* Merchant API                                                               */
/* -------------------------------------------------------------------------- */

export async function createSession(
  ctx: AppContext,
  merchant: MerchantRow,
  input: CreateCheckoutSessionInput,
): Promise<MerchantCheckoutSessionDto> {
  for (const url of [input.returnUrl, input.cancelUrl]) {
    if (!merchant.allowed_return_origins.includes(new URL(url).origin)) {
      throw badRequest(`Redirect URL origin ${new URL(url).origin} is not registered for this merchant`);
    }
  }
  const amount = input.items.reduce((sum, i) => sum + i.unitAmountCents * i.quantity, 0);
  if (amount > 100_000_000) throw badRequest("Order total is too large");

  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO checkout_sessions
       (merchant_id, merchant_reference, items, category, amount_cents, currency, return_url, cancel_url, agent_context, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(mins => $10))
     RETURNING id`,
    [
      merchant.id,
      input.merchantReference ?? null,
      JSON.stringify(input.items),
      input.category,
      amount,
      input.currency,
      input.returnUrl,
      input.cancelUrl,
      input.agentContext ? JSON.stringify(input.agentContext) : null,
      ctx.config.checkoutSessionTtlMinutes,
    ],
  );
  return getSessionForMerchant(ctx, merchant, rows[0]!.id);
}

export async function getSessionForMerchant(ctx: AppContext, merchant: MerchantRow, id: string): Promise<MerchantCheckoutSessionDto> {
  const session = await loadSession(ctx.db, id);
  if (!session || session.merchant_id !== merchant.id) throw notFound("Checkout session");
  const status = await syncStatus(ctx, session);
  const order = await orderFor(ctx.db, session);
  return {
    id: session.id,
    status,
    amountCents: session.amount_cents,
    currency: session.currency.trim() as MerchantCheckoutSessionDto["currency"],
    merchantReference: session.merchant_reference,
    checkoutUrl: `${ctx.config.webUrl}/pay/${session.id}`,
    paypalOrderId: status === "completed" ? (order?.paypal_order_id ?? null) : null,
    captureId: status === "completed" ? (order?.capture_id ?? null) : null,
    expiresAt: new Date(session.expires_at).toISOString(),
    createdAt: new Date(session.created_at).toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Shopper API                                                                */
/* -------------------------------------------------------------------------- */

/** Read-only view for the shopper. Unclaimed sessions show a preview; claimed ones are owner-only. */
export async function viewSession(ctx: AppContext, userId: string, id: string): Promise<CheckoutSessionDto> {
  const session = await ownedOrOpen(ctx, userId, id);
  return toDto(ctx, session, await syncStatus(ctx, session));
}

/**
 * Binds the session to the signed-in shopper and runs it through their policy, via the
 * exact same decision path as chat requests. Idempotent for the same shopper.
 */
export async function claimSession(ctx: AppContext, userId: string, id: string, meta: RequestMeta): Promise<CheckoutSessionDto> {
  const claim = await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1 FOR UPDATE OF s`, [id]);
    const session = rows[0];
    if (!session || (session.user_id && session.user_id !== userId)) throw notFound("Checkout session");
    if (session.user_id) return { session, fresh: false };
    if (new Date(session.expires_at) <= new Date()) {
      await tx.query(`UPDATE checkout_sessions SET status = 'expired', updated_at = now() WHERE id = $1`, [id]);
      throw conflict("SESSION_EXPIRED", "This checkout link has expired. Return to the store and try again.");
    }

    const description = describe(session);
    const { rows: req } = await tx.query<{ id: string }>(
      `INSERT INTO purchase_requests (user_id, raw_input) VALUES ($1, $2) RETURNING id`,
      [userId, description],
    );
    await tx.query(
      `UPDATE checkout_sessions SET user_id = $2, purchase_request_id = $3, updated_at = now() WHERE id = $1`,
      [id, userId, req[0]!.id],
    );
    await recordAudit(tx, {
      userId,
      purchaseRequestId: req[0]!.id,
      actor: "user",
      action: "checkout.session_opened",
      metadata: {
        merchant: session.merchant_name,
        sessionId: id,
        items: session.items,
        amountCents: session.amount_cents,
        agent: session.agent_context?.agentName ?? null,
      },
      meta,
    });
    return { session: { ...session, user_id: userId, purchase_request_id: req[0]!.id }, fresh: true };
  });

  if (claim.fresh) {
    const s = claim.session;
    const totalQty = s.items.reduce((n, i) => n + i.quantity, 0);
    // Structured cart from the merchant: nothing to interpret, but agent-written text is
    // still untrusted and scanned for injection attempts.
    const scanned = [s.agent_context?.goal, s.agent_context?.reasoning, ...s.items.map((i) => i.name)].filter(Boolean).join("\n");
    const analysis: AiAnalysis = {
      intent: {
        itemName: s.items.length === 1 ? s.items[0]!.name : `${s.items[0]!.name} + ${s.items.length - 1} more`,
        merchantName: s.merchant_name,
        category: s.category,
        amountCents: s.amount_cents,
        currency: s.currency.trim() as AiAnalysis["intent"]["currency"],
        quantity: totalQty,
        confidence: 1,
        missingFields: [],
      },
      riskFlags: detectRiskSignals(scanned),
      summary: s.agent_context ? `${s.agent_context.agentName} wants to check out at ${s.merchant_name}` : `Checkout at ${s.merchant_name}`,
      provider: "merchant",
      model: "checkout-session",
    };
    await applyPolicyDecision(ctx, userId, s.purchase_request_id!, analysis, meta, {
      title: `Approve ${formatMoney(s.amount_cents, s.currency.trim())} at ${s.merchant_name}?`,
      body: s.agent_context ? `${s.agent_context.agentName}: "${s.agent_context.goal}"` : `${analysis.intent.itemName}`,
      url: `/pay/${s.id}`,
    });
  }
  return viewSession(ctx, userId, id);
}

/** Creates (or reuses) the PayPal order and returns where to send the shopper. */
export async function startPayment(ctx: AppContext, userId: string, id: string, meta: RequestMeta): Promise<{ approvalUrl: string }> {
  const session = await ownedOrOpen(ctx, userId, id);
  if (!session.user_id || !session.purchase_request_id) throw conflict("NOT_CLAIMED", "Open the checkout first");
  const status = await syncStatus(ctx, session);
  if (status !== "approved" && status !== "paying") throw conflict("NOT_APPROVED", `This checkout is ${status.replace("_", " ")}`);

  const order = await createOrder(ctx, userId, session.purchase_request_id, meta, {
    returnUrl: `${ctx.config.webUrl}/pay/${id}/return`,
    cancelUrl: `${ctx.config.webUrl}/pay/${id}?paypal=cancelled`,
    brandName: session.merchant_name,
  });
  if (!order.approvalUrl) throw conflict("ORDER_NOT_PAYABLE", "This order can no longer be paid");
  await ctx.db.query(`UPDATE checkout_sessions SET status = 'paying', updated_at = now() WHERE id = $1 AND status <> 'completed'`, [id]);
  return { approvalUrl: order.approvalUrl };
}

/** After PayPal sends the shopper back: capture, then hand the merchant's return URL to the browser. */
export async function completePayment(ctx: AppContext, userId: string, id: string, meta: RequestMeta): Promise<CheckoutSessionDto> {
  const session = await ownedOrOpen(ctx, userId, id);
  const order = await orderFor(ctx.db, session);
  if (!order) throw conflict("NO_ORDER", "Payment hasn't started for this checkout");
  if (order.status !== "completed") await captureOrder(ctx, userId, order.id, meta);
  return viewSession(ctx, userId, id);
}

export async function cancelSession(ctx: AppContext, userId: string, id: string, meta: RequestMeta): Promise<CheckoutSessionDto> {
  const session = await ownedOrOpen(ctx, userId, id);
  const status = await syncStatus(ctx, session);
  if (status === "completed") throw conflict("ALREADY_PAID", "This checkout is already paid");
  if (!FINAL.has(status)) {
    await ctx.db.transaction(async (tx) => {
      await tx.query(`UPDATE checkout_sessions SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
      if (session.purchase_request_id) {
        await tx.query(
          `UPDATE approvals SET status = 'rejected', rejected_at = now() WHERE purchase_request_id = $1 AND status = 'pending'`,
          [session.purchase_request_id],
        );
        await tx.query(
          `UPDATE purchase_requests SET status = 'rejected', updated_at = now() WHERE id = $1 AND status IN ('pending_approval', 'approved', 'checkout_created')`,
          [session.purchase_request_id],
        );
      }
      await recordAudit(tx, { userId, purchaseRequestId: session.purchase_request_id, actor: "user", action: "checkout.cancelled", metadata: { sessionId: id }, meta });
    });
  }
  return viewSession(ctx, userId, id);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

const SESSION_SELECT = `
  SELECT s.*, m.name AS merchant_name, m.slug AS merchant_slug
    FROM checkout_sessions s JOIN merchants m ON m.id = s.merchant_id`;

async function loadSession(q: Queryable, id: string): Promise<SessionRow | null> {
  const { rows } = await q.query<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1`, [id]);
  return rows[0] ?? null;
}

async function ownedOrOpen(ctx: AppContext, userId: string, id: string): Promise<SessionRow> {
  const session = await loadSession(ctx.db, id);
  // Someone else's claimed session looks exactly like a missing one.
  if (!session || (session.user_id && session.user_id !== userId)) throw notFound("Checkout session");
  return session;
}

async function orderFor(q: Queryable, session: SessionRow): Promise<OrderRow | null> {
  if (!session.purchase_request_id) return null;
  const { rows } = await q.query<OrderRow>(`SELECT * FROM paypal_orders WHERE purchase_request_id = $1`, [session.purchase_request_id]);
  return rows[0] ?? null;
}

const REQUEST_TO_SESSION: Record<string, CheckoutSessionStatus> = {
  analyzing: "open",
  pending_approval: "pending_approval",
  approved: "approved",
  blocked: "blocked",
  checkout_created: "paying",
  completed: "completed",
  rejected: "cancelled",
  expired: "expired",
  failed: "failed",
};

/**
 * The linked purchase request is the source of truth (approvals, payments and webhooks
 * all update it); the session row caches the derived status for merchant reads.
 */
async function syncStatus(ctx: AppContext, session: SessionRow): Promise<CheckoutSessionStatus> {
  let status: CheckoutSessionStatus = session.status;
  if (session.status !== "cancelled" && session.purchase_request_id) {
    const { rows } = await ctx.db.query<{ status: string }>(`SELECT status FROM purchase_requests WHERE id = $1`, [session.purchase_request_id]);
    status = REQUEST_TO_SESSION[rows[0]?.status ?? "failed"] ?? "failed";
  }
  if (!FINAL.has(status) && status !== "paying" && new Date(session.expires_at) <= new Date()) status = "expired";
  if (status !== session.status) {
    await ctx.db.query(`UPDATE checkout_sessions SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'completed'`, [session.id, status]);
  }
  return status;
}

async function toDto(ctx: AppContext, session: SessionRow, status: CheckoutSessionStatus): Promise<CheckoutSessionDto> {
  let request: PurchaseRequestDto | null = null;
  if (session.user_id && session.purchase_request_id) {
    [request = null] = await fetchRequests(ctx.db, session.user_id, { id: session.purchase_request_id, limit: 1 });
  }
  return {
    id: session.id,
    status,
    merchant: { name: session.merchant_name, slug: session.merchant_slug },
    items: session.items,
    category: session.category,
    amountCents: session.amount_cents,
    currency: session.currency.trim() as CheckoutSessionDto["currency"],
    merchantReference: session.merchant_reference,
    agentContext: session.agent_context,
    expiresAt: new Date(session.expires_at).toISOString(),
    request,
    redirectUrl: FINAL.has(status) ? merchantRedirect(session, status) : null,
  };
}

function merchantRedirect(session: SessionRow, status: CheckoutSessionStatus): string {
  const url = new URL(status === "completed" ? session.return_url : session.cancel_url);
  url.searchParams.set("guardian_session", session.id);
  url.searchParams.set("guardian_status", status);
  return url.toString();
}

function describe(session: SessionRow): string {
  const lines = session.items.map((i) => `${i.quantity}× ${i.name} (${formatMoney(i.unitAmountCents * i.quantity, session.currency.trim())})`);
  const agent = session.agent_context ? ` · requested by ${session.agent_context.agentName}: "${session.agent_context.goal}"` : "";
  return `Checkout at ${session.merchant_name}: ${lines.join(", ")}${agent}`.slice(0, 2000);
}
