import { describe, expect, it, vi } from "vitest";
import { amountToCents, centsToAmount, MockPayPalGateway, PayPalApiError, PayPalHttpGateway } from "./index";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function gatewayWith(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
  const gateway = new PayPalHttpGateway({
    environment: "sandbox",
    clientId: "id",
    clientSecret: "secret",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { gateway, calls };
}

const orderInput = {
  requestId: "11111111-1111-1111-1111-111111111111",
  referenceId: "req-1",
  description: "Birthday gift",
  amountCents: 6_500,
  currency: "USD",
  returnUrl: "https://app.test/checkout/return?orderId=o1",
  cancelUrl: "https://app.test/checkout/cancel?orderId=o1",
};

describe("money helpers", () => {
  it("round-trips cents and decimal strings", () => {
    expect(centsToAmount(6_500)).toBe("65.00");
    expect(centsToAmount(5)).toBe("0.05");
    expect(amountToCents("65.00")).toBe(6_500);
    expect(amountToCents("0.5")).toBe(50);
    expect(() => centsToAmount(1.5)).toThrow();
  });
});

describe("PayPalHttpGateway", () => {
  it("creates an order with an idempotency key and returns the payer-action link", async () => {
    const { gateway, calls } = gatewayWith([
      json(200, { access_token: "tok", expires_in: 32_400 }),
      json(201, {
        id: "5O190127TN364715T",
        status: "PAYER_ACTION_REQUIRED",
        links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=5O19" }],
      }),
    ]);
    const order = await gateway.createOrder(orderInput);
    expect(order.approvalUrl).toContain("checkoutnow");
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers["PayPal-Request-Id"]).toBe(orderInput.requestId);
    const body = JSON.parse(String(calls[1]!.init.body));
    expect(body.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "65.00" });
  });

  it("caches the OAuth token across calls", async () => {
    const { gateway, calls } = gatewayWith([
      json(200, { access_token: "tok", expires_in: 32_400 }),
      json(200, { id: "A", status: "APPROVED" }),
      json(200, { id: "B", status: "APPROVED" }),
    ]);
    await gateway.getOrder("A");
    await gateway.getOrder("B");
    expect(calls.filter((c) => c.url.endsWith("/v1/oauth2/token"))).toHaveLength(1);
  });

  it("retries idempotent calls on 5xx and parses the capture", async () => {
    const { gateway } = gatewayWith([
      json(200, { access_token: "tok", expires_in: 32_400 }),
      json(503, { name: "SERVICE_UNAVAILABLE" }),
      json(201, {
        id: "ORDER",
        status: "COMPLETED",
        purchase_units: [{ payments: { captures: [{ id: "CAP", status: "COMPLETED", amount: { currency_code: "USD", value: "65.00" } }] } }],
      }),
    ]);
    const capture = await gateway.captureOrder("ORDER", "key:capture");
    expect(capture).toMatchObject({ status: "COMPLETED", captureId: "CAP", amountCents: 6_500, currency: "USD" });
  });

  it("surfaces PayPal issues without retrying 4xx errors", async () => {
    const { gateway } = gatewayWith([
      json(200, { access_token: "tok", expires_in: 32_400 }),
      json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED", description: "Payer has not approved" }] }),
    ]);
    const error = await gateway.captureOrder("ORDER", "key:capture").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalApiError);
    expect((error as PayPalApiError).issue).toBe("ORDER_NOT_APPROVED");
  });
});

describe("MockPayPalGateway", () => {
  it("is stateless: the capture amount is recovered from the order id", async () => {
    const mock = new MockPayPalGateway();
    const order = await mock.createOrder(orderInput);
    expect(new URL(order.approvalUrl).searchParams.get("token")).toBe(order.id);
    const capture = await new MockPayPalGateway().captureOrder(order.id);
    expect(capture).toMatchObject({ status: "COMPLETED", amountCents: 6_500, currency: "USD" });
  });
});
