import { MockPayPalGateway, PayPalApiError, type CapturedOrder, type CreatedOrder, type CreateOrderInput } from "@guardian/paypal-client";
import type { AgentRunDto, CheckoutSessionDto, MerchantCheckoutSessionDto } from "@guardian/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NvidiaShoppingAgent, OfflineShoppingAgent, createAgentTools, type ShoppingAgentModel } from "../src/modules/demo-store/agent";
import { createMerchant } from "../src/modules/checkout-sessions/service";
import { createTestApp, registerUser, type TestApp } from "./helpers";

/** A mock PayPal whose next calls can be told to misbehave, and which counts captures. */
class ScriptedPayPal extends MockPayPalGateway {
  captures = 0;
  failNextCreate = false;
  captureAmountOverride: number | null = null;

  override async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new PayPalApiError(500, "INTERNAL_SERVER_ERROR", null, "PayPal is down");
    }
    return super.createOrder(input);
  }

  override async captureOrder(orderId: string): Promise<CapturedOrder> {
    this.captures++;
    const result = await super.captureOrder(orderId);
    return this.captureAmountOverride === null ? result : { ...result, amountCents: this.captureAmountOverride };
  }
}

let t: TestApp;
let merchantKey: string;
const paypal = new ScriptedPayPal();
const STORE = "https://shop.example.com";

beforeAll(async () => {
  t = await createTestApp(paypal);
  ({ apiKey: merchantKey } = await createMerchant(t.db, { name: "Safety Shop", slug: "safety", origins: [STORE] }));
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  paypal.captures = 0;
  paypal.failNextCreate = false;
  paypal.captureAmountOverride = null;
});

const newSession = async (unitAmountCents: number) => {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/checkout-sessions",
    headers: { authorization: `Bearer ${merchantKey}` },
    payload: { items: [{ name: "Desk lamp", quantity: 1, unitAmountCents }], currency: "USD", category: "household", returnUrl: `${STORE}/thanks`, cancelUrl: `${STORE}/cart` },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as MerchantCheckoutSessionDto;
};

const shopper = (auth: Record<string, string>, action: string, id: string, method: "GET" | "POST" = "POST") =>
  t.app.inject({ method, url: `/api/v1/checkout-sessions/${id}/${action}`, headers: auth });

const orderFor = async (requestId: string) =>
  (await t.db.query<{ status: string; paypal_order_id: string }>(`SELECT status, paypal_order_id FROM paypal_orders WHERE purchase_request_id = $1`, [requestId])).rows[0]!;

const webhook = (id: string, event_type: string, resource: Record<string, unknown>) =>
  t.app.inject({ method: "POST", url: "/api/v1/webhooks/paypal", payload: { id, event_type, resource } });

describe("cancelling a checkout that has reached PayPal", () => {
  it("can't be charged by returning from PayPal afterwards", async () => {
    const u = await registerUser(t.app);
    const session = await newSession(2_000);
    const claimed = (await shopper(u.auth, "claim", session.id)).json() as CheckoutSessionDto;
    expect((await shopper(u.auth, "pay", session.id)).statusCode).toBe(200);
    expect((await shopper(u.auth, "cancel", session.id)).statusCode).toBe(200);

    const late = await shopper(u.auth, "complete", session.id);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("ORDER_VOIDED");
    expect(paypal.captures).toBe(0);
    expect((await orderFor(claimed.request!.id)).status).toBe("voided");

    const usage = (await t.app.inject({ method: "GET", url: "/api/v1/policies/me/usage", headers: u.auth })).json();
    expect(usage).toMatchObject({ spentCents: 0, reservedCents: 0 });
  });

  it("can't be charged by a late PayPal webhook", async () => {
    const u = await registerUser(t.app);
    const session = await newSession(2_100);
    const claimed = (await shopper(u.auth, "claim", session.id)).json() as CheckoutSessionDto;
    await shopper(u.auth, "pay", session.id);
    await shopper(u.auth, "cancel", session.id);
    const { paypal_order_id } = await orderFor(claimed.request!.id);

    const res = await webhook(`WH-void-${session.id}`, "CHECKOUT.ORDER.APPROVED", { id: paypal_order_id });
    expect(res.statusCode).toBe(200);
    expect(paypal.captures).toBe(0);
    expect((await orderFor(claimed.request!.id)).status).toBe("voided");
  });

  it("reports the money if a capture finished anyway, instead of hiding it behind 'cancelled'", async () => {
    const u = await registerUser(t.app);
    const session = await newSession(2_200);
    const claimed = (await shopper(u.auth, "claim", session.id)).json() as CheckoutSessionDto;
    await shopper(u.auth, "pay", session.id);
    await shopper(u.auth, "cancel", session.id);
    // The capture won the race at PayPal and committed after the cancel.
    await t.db.query(`UPDATE paypal_orders SET status = 'completed' WHERE purchase_request_id = $1`, [claimed.request!.id]);
    await t.db.query(`UPDATE purchase_requests SET status = 'completed' WHERE id = $1`, [claimed.request!.id]);
    const seen = await t.app.inject({ method: "GET", url: `/api/v1/checkout-sessions/${session.id}`, headers: { authorization: `Bearer ${merchantKey}` } });
    expect(seen.json().status).toBe("completed");
  });

  it("flags a capture PayPal reports on a voided order for manual review", async () => {
    const u = await registerUser(t.app);
    const session = await newSession(2_300);
    const claimed = (await shopper(u.auth, "claim", session.id)).json() as CheckoutSessionDto;
    await shopper(u.auth, "pay", session.id);
    await shopper(u.auth, "cancel", session.id);
    const { paypal_order_id } = await orderFor(claimed.request!.id);

    await webhook(`WH-unexpected-${session.id}`, "PAYMENT.CAPTURE.COMPLETED", { id: "CAP-1", supplementary_data: { related_ids: { order_id: paypal_order_id } } });
    expect((await orderFor(claimed.request!.id)).status).toBe("voided");
    const { rows } = await t.db.query(`SELECT action FROM audit_events WHERE purchase_request_id = $1 AND action = 'payment.capture_unexpected'`, [claimed.request!.id]);
    expect(rows).toHaveLength(1);
  });
});

describe("failed PayPal orders", () => {
  it("never revives an order that failed at capture", async () => {
    const u = await registerUser(t.app);
    const session = await newSession(2_400);
    const claimed = (await shopper(u.auth, "claim", session.id)).json() as CheckoutSessionDto;
    await shopper(u.auth, "pay", session.id);
    paypal.captureAmountOverride = 1;
    expect((await shopper(u.auth, "complete", session.id)).statusCode).toBe(502);

    const retry = await t.app.inject({ method: "POST", url: "/api/v1/payments/paypal/orders", headers: u.auth, payload: { purchaseRequestId: claimed.request!.id } });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe("ORDER_FAILED");
    expect((await shopper(u.auth, "view", session.id, "GET")).json().status).toBe("failed");
  });

  it("retries an order that never reached PayPal", async () => {
    const u = await registerUser(t.app);
    const session = await newSession(2_500);
    await shopper(u.auth, "claim", session.id);
    paypal.failNextCreate = true;
    expect((await shopper(u.auth, "pay", session.id)).statusCode).toBe(502);
    expect((await shopper(u.auth, "pay", session.id)).statusCode).toBe(200);
    expect((await shopper(u.auth, "complete", session.id)).json().status).toBe("completed");
  });

  it("re-checks the current policy when retrying", async () => {
    const u = await registerUser(t.app);
    const session = await newSession(2_600);
    await shopper(u.auth, "claim", session.id);
    paypal.failNextCreate = true;
    await shopper(u.auth, "pay", session.id);

    const policy = (await t.app.inject({ method: "GET", url: "/api/v1/policies/me", headers: u.auth })).json();
    await t.app.inject({ method: "PUT", url: "/api/v1/policies/me", headers: u.auth, payload: { ...policy, perPurchaseLimitCents: 1_000, requireApprovalAboveCents: 500 } });

    const retry = await shopper(u.auth, "pay", session.id);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe("POLICY_CHANGED");
  });
});

describe("checkout session lifecycle", () => {
  it("closes the approval when the session expires", async () => {
    const u = await registerUser(t.app);
    const session = await newSession(7_500);
    const claimed = (await shopper(u.auth, "claim", session.id)).json() as CheckoutSessionDto;
    expect(claimed.status).toBe("pending_approval");
    await t.db.query(`UPDATE checkout_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [session.id]);

    const view = (await shopper(u.auth, "view", session.id, "GET")).json() as CheckoutSessionDto;
    expect(view.status).toBe("expired");
    expect(view.redirectUrl).toContain("guardian_status=expired");
    const approve = await t.app.inject({ method: "POST", url: `/api/v1/approvals/${claimed.request!.approval!.id}/approve`, headers: u.auth });
    expect(approve.statusCode).toBe(409);
  });

  it("fails closed when the policy decision can't run, rather than waiting forever", async () => {
    const u = await registerUser(t.app);
    const session = await newSession(1_000);
    await t.db.query(`DELETE FROM user_policies WHERE user_id = $1`, [u.userId]);
    const claimed = (await shopper(u.auth, "claim", session.id)).json() as CheckoutSessionDto;
    expect(claimed.status).toBe("failed");
    expect(claimed.redirectUrl).toContain("guardian_status=failed");
  });

  it("won't reopen a cancelled session for a different shopper", async () => {
    const first = await registerUser(t.app);
    const second = await registerUser(t.app);
    const session = await newSession(1_100);
    await shopper(first.auth, "cancel", session.id);
    const claimed = (await shopper(second.auth, "claim", session.id)).json() as CheckoutSessionDto;
    expect(claimed.status).toBe("cancelled");
    expect(claimed.request).toBeNull();
  });
});

describe("refresh tokens", () => {
  it("accepts a token rotated moments ago, so two tabs don't sign each other out", async () => {
    const u = await registerUser(t.app);
    const refresh = (token: string) => t.app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { guardian_rt: token } });
    const first = await refresh(u.refreshCookie);
    expect(first.statusCode).toBe(200);
    expect((await refresh(u.refreshCookie)).statusCode).toBe(200);
    expect((await refresh(first.cookies.find((c) => c.name === "guardian_rt")!.value)).statusCode).toBe(200);
  });

  it("gives logged-out tokens no grace", async () => {
    const u = await registerUser(t.app);
    await t.app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { guardian_rt: u.refreshCookie } });
    expect((await t.app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { guardian_rt: u.refreshCookie } })).statusCode).toBe(401);
  });
});

describe("shopping agent resilience", () => {
  const brokenModel: ShoppingAgentModel = {
    name: "Shopping agent (broken)",
    run: () => Promise.reject(new Error("model unavailable")),
  };

  const agentApp = async (agentModel: ShoppingAgentModel, env: Record<string, string> = {}) => createTestApp(new MockPayPalGateway(), { agentModel, env });
  const runAgent = async (app: TestApp, goal = "Restock kitchen basics under $30") =>
    (await app.app.inject({ method: "POST", url: "/api/v1/demo-store/agent", payload: { goal } })).json() as AgentRunDto;

  it("falls back to the offline planner when the model fails, and says who ran", async () => {
    const app = await agentApp(brokenModel);
    const run = await runAgent(app);
    await app.close();
    expect(run.agent).toBe(new OfflineShoppingAgent().name);
    expect(run.checkout?.checkoutUrl).toBeTruthy();
  });

  it("stops spending LLM credit at the daily limit", async () => {
    let calls = 0;
    const counted: ShoppingAgentModel = {
      name: "Shopping agent (counted)",
      run: (goal, tools) => {
        calls++;
        return new OfflineShoppingAgent().run(goal, tools);
      },
    };
    const app = await agentApp(counted, { AGENT_DAILY_LIMIT: "1" });
    const first = await runAgent(app);
    const second = await runAgent(app);
    await app.close();
    expect(calls).toBe(1);
    expect(first.agent).toBe(counted.name);
    expect(second.agent).toBe(new OfflineShoppingAgent().name);
  });

  /** Replays scripted model replies through the real NVIDIA agent loop. */
  const scriptedAgent = (replies: (Record<string, unknown> | Error)[]) => {
    const agent = new NvidiaShoppingAgent({ apiKey: "test", model: "test-model", baseUrl: "http://localhost:1/v1", timeoutMs: 1000 });
    const create = async () => {
      const next = replies.shift();
      if (!next || next instanceof Error) throw next ?? new Error("out of replies");
      return { choices: [{ message: next }] };
    };
    (agent as unknown as { client: unknown }).client = { chat: { completions: { create } } };
    return agent;
  };
  const toolCall = (name: string, args: unknown) => ({ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const toolsWithCheckout = () => createAgentTools(async () => ({ checkoutUrl: "http://localhost:3000/pay/abc" }));

  it("hands over a cart the model built but forgot to check out", async () => {
    const tools = toolsWithCheckout();
    const outcome = await scriptedAgent([
      { content: "", tool_calls: [toolCall("add_to_cart", { sku: "GR-RICE", quantity: 1 })] },
      { content: "All done, your cart is ready." },
    ]).run("rice", tools);
    expect(outcome.steps.some((s) => s.kind === "tool" && s.name === "request_checkout")).toBe(true);
  });

  it("treats tool calls printed as plain text as a failed run", async () => {
    const reply = { content: '{"name": "search_products", "parameters": {"query": "rice"}}' };
    await expect(scriptedAgent([reply]).run("rice", toolsWithCheckout())).rejects.toThrow(/without using its tools/);
  });

  it("keeps the checkout when the model fails after handing over the cart", async () => {
    const tools = toolsWithCheckout();
    const outcome = await scriptedAgent([
      { content: "", tool_calls: [toolCall("add_to_cart", { sku: "GR-RICE", quantity: 1 })] },
      { content: "", tool_calls: [toolCall("request_checkout", { reasoning: "Rice fits the goal." })] },
      new Error("connection reset"),
    ]).run("rice", tools);
    expect(outcome.message).toContain("Guardian");
  });

  it("doesn't leak the model error when nothing matches the goal", async () => {
    const app = await agentApp(brokenModel);
    const run = await runAgent(app, "xyzzy nothing matches this at all");
    await app.close();
    expect(JSON.stringify(run)).not.toContain("model unavailable");
    expect(run.checkout).toBeNull();
  });
});
