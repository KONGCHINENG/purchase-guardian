# API reference

Base path `/api/v1`. JSON in and out. Authenticated routes need `Authorization: Bearer <accessToken>`.
Errors always look like `{ "error": { "code": "SOME_CODE", "message": "Human readable", "details": … } }`.
Every response carries `x-request-id` (send your own to correlate logs).

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{ email, password (≥10), fullName? }` | 201 → `{ accessToken, expiresIn, user }` + `guardian_rt` httpOnly cookie |
| POST | `/auth/login` | `{ email, password }` | 401 `INVALID_CREDENTIALS` |
| POST | `/auth/refresh` | cookie (or `{ refreshToken }`) | Rotates the refresh token; reusing an old one revokes all sessions |
| POST | `/auth/logout` | cookie | 204 |
| GET | `/auth/me` | — | Current user |

Rate limit: 10/min per IP on credential routes (configurable).

## Policies

| Method | Path | Notes |
|---|---|---|
| GET | `/policies/me` | Active policy |
| PUT | `/policies/me` | Full replace: `{ currency, monthlyLimitCents, perPurchaseLimitCents, requireApprovalAboveCents, blockedCategories[], allowedMerchants[], blockedMerchants[], riskSensitivity }`. Bumps `version`. |
| GET | `/policies/me/usage` | `{ spentCents, reservedCents, remainingCents, monthlyLimitCents, periodStart, pendingApprovals }` |

## Purchase requests

| Method | Path | Notes |
|---|---|---|
| POST | `/purchase-requests` | `{ rawInput }` → 201 with extraction, decision, approval and audit trail. 20/min per user. |
| GET | `/purchase-requests?limit=20&cursor=…` | Keyset pagination → `{ items, nextCursor }` |
| GET | `/purchase-requests/:id` | Detail incl. `audit[]` |
| POST | `/purchase-requests/:id/retry-analysis` | Re-run AI + policy (blocked/expired/failed/rejected/pending only) |

Example (`POST /purchase-requests`):

```json
{ "rawInput": "Buy a $65 birthday gift from Amazon for my sister" }
```

```json
{
  "id": "1affb789-…",
  "status": "pending_approval",
  "extracted": { "itemName": "Birthday gift", "merchantName": "Amazon", "category": "gifts",
                 "amountCents": 6500, "currency": "USD", "quantity": 1, "confidence": 0.93,
                 "riskFlags": [], "summary": "…", "provider": "anthropic" },
  "decision": { "decision": "require_approval", "triggeredRules": ["AMOUNT_ABOVE_CONFIRMATION_THRESHOLD"],
                "explanation": "Needs your approval: $65.00 is above your $50.00 confirmation threshold. …",
                "remainingMonthlyBudgetCents": 93500, "policyVersion": 1 },
  "approval": { "id": "…", "status": "pending", "expiresAt": "…" },
  "order": null,
  "audit": [ … ]
}
```

## Approvals

| Method | Path | Notes |
|---|---|---|
| GET | `/approvals?status=pending` | Pending + history (expired ones are swept lazily) |
| POST | `/approvals/:id/approve` | 409 `APPROVAL_EXPIRED` / `APPROVAL_NOT_PENDING` |
| POST | `/approvals/:id/reject` | |

## PayPal checkout

| Method | Path | Notes |
|---|---|---|
| POST | `/payments/paypal/orders` | `{ purchaseRequestId }` → 201 order with `approvalUrl`. Idempotent per request. 409 codes: `APPROVAL_REQUIRED`, `PURCHASE_BLOCKED`, `APPROVAL_EXPIRED`, `POLICY_CHANGED` |
| GET | `/payments/paypal/orders` | Recent orders |
| GET | `/payments/paypal/orders/:id` | Local order status |
| POST | `/payments/paypal/orders/:id/capture` | After buyer approval. Idempotent. 409 `ORDER_NOT_APPROVED`, `PAYMENT_DECLINED` |
| POST | `/webhooks/paypal` | PayPal → us. Signature verified via PayPal API (`PAYPAL_WEBHOOK_ID`). Handles `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED/DENIED/DECLINED` |

## Health

`GET /health` (liveness) · `GET /health/ready` (DB reachable; reports AI provider and PayPal env).
