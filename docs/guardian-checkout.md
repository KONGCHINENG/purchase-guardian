# Guardian Checkout: merchant & agent integration

Guardian Checkout adds one step in front of PayPal, the way 3-D Secure adds one in front of card payments. The shopper (or their AI agent) clicks **Pay with PayPal**, Guardian checks the purchase against the shopper's own spending policy, and only then does PayPal open. The browser always ends up back on the merchant's site.

```
Merchant / AI agent                 Guardian                                  PayPal
─────────────────────               ─────────────────────────────────         ──────────
POST /checkout-sessions  ────────▶  session (amount, items, return URLs)
redirect shopper to checkoutUrl ─▶  /pay/:id  (shopper signs in)
                                    policy: approve │ ask │ block
                                      ask   → push to shopper's phone, page waits
                                      block → redirect cancelUrl?guardian_status=blocked
                                      approve ────────────────────────────▶  buyer approves
                                    /pay/:id/return ◀────────────────────────  redirect back
                                    capture (idempotent)
redirect ◀── returnUrl?guardian_status=completed&guardian_session=:id
GET /checkout-sessions/:id  ─────▶  verify status server-side (never trust the query string)
```

## 1. Get a merchant key

```bash
npm run merchant:create -w @guardian/api -- "Acme Store" acme https://shop.acme.com
```

The key (`pgm_…`) is shown once; only its SHA-256 hash is stored. Return and cancel URLs must be on one of the registered origins, so Guardian can't be used as an open redirect.

## 2. Create a session (server-side)

```http
POST /api/v1/checkout-sessions
Authorization: Bearer pgm_…
Content-Type: application/json

{
  "items": [{ "name": "Desk lamp", "sku": "LAMP-1", "quantity": 1, "unitAmountCents": 4500 }],
  "currency": "USD",
  "category": "household",
  "merchantReference": "order-1042",
  "returnUrl": "https://shop.acme.com/checkout/done",
  "cancelUrl": "https://shop.acme.com/cart",
  "agentContext": { "agentName": "Acme Assistant", "goal": "a lamp for my desk", "reasoning": "Cheapest LED lamp in stock" }
}
```

Response `201`: `{ id, status: "open", checkoutUrl, amountCents, expiresAt, … }`. Redirect the shopper to `checkoutUrl`. Sessions expire after 30 minutes (`CHECKOUT_SESSION_TTL_MINUTES`).

`agentContext` is optional. Send it when an AI agent built the cart, so the shopper sees who asked and why. It's treated as untrusted text: instructions hidden in it are flagged and force a human approval.

## 3. Handle the return

Guardian redirects to `returnUrl` (paid) or `cancelUrl` (blocked, cancelled, expired) with `guardian_session` and `guardian_status`. Always confirm with:

```http
GET /api/v1/checkout-sessions/:id
Authorization: Bearer pgm_…
```

→ `{ status: "completed", paypalOrderId, captureId, amountCents, … }`. Merchants only ever see the outcome, never the shopper's limits or rules.

| Status | Meaning |
|---|---|
| `open` | Created; shopper hasn't opened it yet |
| `pending_approval` | Shopper's policy asked for a human decision |
| `approved` | Cleared; shopper is being sent to PayPal |
| `paying` | PayPal order created, waiting for buyer approval |
| `completed` | Captured. Ship the order. |
| `blocked` / `cancelled` / `expired` / `failed` | Nothing was charged |

## Demo merchant

`/store` (Northwind Market) is a built-in demo merchant with an AI shopping agent. It runs in the same deployment for convenience but goes through exactly this API path with its own merchant identity. Disable it with `DEMO_STORE_ENABLED=false`.
