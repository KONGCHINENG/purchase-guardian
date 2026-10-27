/**
 * Minimal, typed PayPal Orders v2 adapter.
 *
 * - Every mutating call takes a `requestId`, sent as `PayPal-Request-Id`, so retries
 *   (ours, the client's, or a double click) can never create or capture twice.
 * - OAuth tokens are cached and refreshed with a single in-flight request.
 * - `MockPayPalGateway` is stateless and deterministic for local dev and tests.
 */

export type PayPalEnvironment = "sandbox" | "live" | "mock";

export type CreateOrderInput = {
  requestId: string;
  referenceId: string;
  description: string;
  amountCents: number;
  currency: string;
  returnUrl: string;
  cancelUrl: string;
  brandName?: string;
};

export type CreatedOrder = { id: string; status: string; approvalUrl: string; raw: unknown };

export type CapturedOrder = {
  id: string;
  status: string;
  captureId: string | null;
  captureStatus: string | null;
  amountCents: number | null;
  currency: string | null;
  raw: unknown;
};

export type OrderSnapshot = { id: string; status: string; raw: unknown };

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface PayPalGateway {
  readonly environment: PayPalEnvironment;
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
  captureOrder(orderId: string, requestId: string): Promise<CapturedOrder>;
  getOrder(orderId: string): Promise<OrderSnapshot>;
  verifyWebhookSignature(headers: WebhookHeaders, event: unknown): Promise<boolean>;
}

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly issue: string | null,
    readonly debugId: string | null,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "PayPalApiError";
  }
}

export function centsToAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError(`Invalid amount: ${cents}`);
  return (cents / 100).toFixed(2);
}

export function amountToCents(value: string): number {
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
}

/* -------------------------------------------------------------------------- */
/* HTTP gateway (sandbox / live)                                              */
/* -------------------------------------------------------------------------- */

export type HttpGatewayConfig = {
  environment: "sandbox" | "live";
  clientId: string;
  clientSecret: string;
  webhookId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
};

const BASE_URLS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

type PayPalLink = { href: string; rel: string; method?: string };

export class PayPalHttpGateway implements PayPalGateway {
  readonly environment: "sandbox" | "live";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor(private readonly config: HttpGatewayConfig) {
    this.environment = config.environment;
    this.baseUrl = BASE_URLS[config.environment];
    this.fetchImpl = config.fetch ?? fetch;
  }

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const body = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: input.referenceId,
          custom_id: input.referenceId,
          description: input.description.slice(0, 127),
          amount: { currency_code: input.currency, value: centsToAmount(input.amountCents) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: (input.brandName ?? "Purchase Guardian").slice(0, 127),
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
          },
        },
      },
    };
    const res = await this.request<{ id: string; status: string; links?: PayPalLink[] }>(
      "POST",
      "/v2/checkout/orders",
      body,
      input.requestId,
    );
    const link = res.links?.find((l) => l.rel === "payer-action") ?? res.links?.find((l) => l.rel === "approve");
    if (!link) throw new PayPalApiError(502, "MISSING_APPROVAL_LINK", null, "PayPal did not return an approval link", res);
    return { id: res.id, status: res.status, approvalUrl: link.href, raw: res };
  }

  async captureOrder(orderId: string, requestId: string): Promise<CapturedOrder> {
    const res = await this.request<CaptureResponse>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId);
    return parseCapture(res);
  }

  async getOrder(orderId: string): Promise<OrderSnapshot> {
    const res = await this.request<{ id: string; status: string }>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    return { id: res.id, status: res.status, raw: res };
  }

  async verifyWebhookSignature(headers: WebhookHeaders, event: unknown): Promise<boolean> {
    if (!this.config.webhookId) return false;
    const h = (name: string) => {
      const v = headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const res = await this.request<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: this.config.webhookId,
      webhook_event: event,
    });
    return res.verification_status === "SUCCESS";
  }

  /** Builds the full parsed capture result for an order fetched with GET (e.g. after ORDER_ALREADY_CAPTURED). */
  static captureFromSnapshot(snapshot: OrderSnapshot): CapturedOrder {
    return parseCapture(snapshot.raw as CaptureResponse);
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    this.tokenInFlight ??= (async () => {
      try {
        const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
        const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
          method: "POST",
          headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=client_credentials",
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
        });
        const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
        if (!res.ok || !json.access_token) {
          throw new PayPalApiError(res.status, "AUTHENTICATION_FAILURE", res.headers.get("paypal-debug-id"), json.error_description ?? "PayPal authentication failed");
        }
        // Refresh a minute early so in-flight requests never carry an expiring token.
        this.token = { value: json.access_token, expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 300) - 60) * 1000 };
        return json.access_token;
      } finally {
        this.tokenInFlight = null;
      }
    })();
    return this.tokenInFlight;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, requestId?: string): Promise<T> {
    const maxRetries = this.config.maxRetries ?? 2;
    // POSTs are only retried when they carry an idempotency key.
    const retryable = method === "GET" || Boolean(requestId);
    for (let attempt = 0; ; attempt++) {
      try {
        const token = await this.getAccessToken();
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
            ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
        });
        const text = await res.text();
        const json = text ? (JSON.parse(text) as unknown) : {};
        if (res.ok) return json as T;
        if (res.status === 401) this.token = null;
        const err = json as { name?: string; message?: string; details?: { issue?: string; description?: string }[] };
        throw new PayPalApiError(
          res.status,
          err.details?.[0]?.issue ?? err.name ?? null,
          res.headers.get("paypal-debug-id"),
          err.details?.[0]?.description ?? err.message ?? `PayPal request failed with ${res.status}`,
          json,
        );
      } catch (error) {
        // Retry transient failures only: network errors, 5xx, 429, and one stale-token 401.
        const transient = error instanceof PayPalApiError ? error.status >= 500 || error.status === 429 || error.status === 401 : true;
        if (!(retryable && transient && attempt < maxRetries)) throw error;
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
}

type CaptureResponse = {
  id: string;
  status: string;
  purchase_units?: {
    payments?: { captures?: { id: string; status: string; amount?: { currency_code: string; value: string } }[] };
  }[];
};

function parseCapture(res: CaptureResponse): CapturedOrder {
  const capture = res.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    id: res.id,
    status: res.status,
    captureId: capture?.id ?? null,
    captureStatus: capture?.status ?? null,
    amountCents: capture?.amount ? amountToCents(capture.amount.value) : null,
    currency: capture?.amount?.currency_code ?? null,
    raw: res,
  };
}

/* -------------------------------------------------------------------------- */
/* Mock gateway (local dev / tests)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Stateless mock: the order id encodes amount and currency, so captures verify
 * amounts without shared memory and keep working across restarts and replicas.
 * Approval is simulated by sending the browser straight to the return URL.
 */
export class MockPayPalGateway implements PayPalGateway {
  readonly environment = "mock" as const;

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const suffix = Buffer.from(input.requestId).toString("hex").slice(0, 16).toUpperCase();
    const id = `MOCK-${input.amountCents}-${input.currency}-${suffix}`;
    const url = new URL(input.returnUrl);
    url.searchParams.set("token", id);
    url.searchParams.set("PayerID", "MOCKPAYER");
    return { id, status: "PAYER_ACTION_REQUIRED", approvalUrl: url.toString(), raw: { id, mock: true } };
  }

  async captureOrder(orderId: string): Promise<CapturedOrder> {
    const match = /^MOCK-(\d+)-([A-Z]{3})-/.exec(orderId);
    if (!match) throw new PayPalApiError(404, "RESOURCE_NOT_FOUND", null, "Unknown mock order");
    return {
      id: orderId,
      status: "COMPLETED",
      captureId: `MOCKCAP-${orderId.slice(-8)}`,
      captureStatus: "COMPLETED",
      amountCents: Number(match[1]),
      currency: match[2] ?? null,
      raw: { id: orderId, status: "COMPLETED", mock: true },
    };
  }

  async getOrder(orderId: string): Promise<OrderSnapshot> {
    return { id: orderId, status: "APPROVED", raw: { id: orderId, status: "APPROVED", mock: true } };
  }

  async verifyWebhookSignature(): Promise<boolean> {
    return true;
  }
}

export function createPayPalGateway(config: {
  environment: PayPalEnvironment;
  clientId?: string;
  clientSecret?: string;
  webhookId?: string;
}): PayPalGateway {
  if (config.environment === "mock") return new MockPayPalGateway();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required for sandbox/live PayPal");
  }
  return new PayPalHttpGateway({
    environment: config.environment,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    webhookId: config.webhookId,
  });
}
