# Security model

## Payment authority

| Threat | Mitigation (where) |
|---|---|
| Prompt injection tells the agent to bypass rules | The LLM only returns a description validated by Zod; it has no tools and no path to PayPal. Deterministic injection detection (`modules/ai/heuristic.ts`) adds a risk flag that forces human approval even if the model misses it. |
| AI misreads the request | Confidence below the policy's sensitivity threshold → approval required. Heuristic fallback is capped at 0.55, below every threshold, so it can never auto-approve. |
| Overspending via concurrent requests | Per-user Postgres advisory lock around every budget decision; in-flight checkouts count toward the budget. |
| Limits changed after approval | Policy is re-evaluated with fresh spend at checkout time (`POLICY_CHANGED`). |
| Double charge (double click, retry, webhook + redirect race) | One order per request (`UNIQUE`), `PayPal-Request-Id` on create and capture, `ORDER_ALREADY_CAPTURED` treated as success, completion transition guarded by `WHERE status <> 'completed'`. |
| Amount tampering | Order amount comes from the stored, approved request; captured amount is verified against it. |
| Stale approvals | `expires_at` enforced on approve and on checkout. |
| Forged webhooks | Signature verified through PayPal's verify-webhook-signature API; events stored by PayPal id so replays are no-ops. |
| Tampering with history | `audit_events` rejects UPDATE/DELETE at the database level. |

## Accounts and sessions

- Passwords: scrypt (N=2^15, r=8, p=1), constant-time compare, dummy hash on unknown emails to avoid user enumeration by timing.
- Access tokens: HS256 JWT, 15 min, held in browser memory only.
- Refresh tokens: 256-bit random, stored as SHA-256, httpOnly + `SameSite=Lax` + `Secure` (prod) cookie scoped to `/api/v1/auth`, rotated on every use; reuse revokes every session for the user.
- Cross-user access returns 404 (never reveals existence).

## Platform

- Secrets are server-side only (PayPal, Anthropic, JWT). The browser never sees them.
- `helmet` headers on the API; `X-Frame-Options: DENY`, `nosniff`, strict referrer on the web app.
- Rate limits: global 300/min, auth 10/min per IP, AI 20/min per user, payments 30/min per user.
- Body size limit 64 KB; all input validated with Zod; parameterized SQL only.
- Logs redact `Authorization`, cookies and `Set-Cookie`.
- Config refuses to boot in production with PGlite or the mock PayPal gateway.

## Before real money

- Move `JWT_SECRET` to a secrets manager and add key rotation (`kid`).
- KMS envelope encryption for PII columns; least-privilege DB roles (app role without DDL).
- CSRF token on cookie-authenticated endpoints if any are added beyond `/auth/refresh` (currently `SameSite=Lax` + POST-only).
- Refund flow for `AMOUNT_MISMATCH` cases; alerting on audit actions `payment.amount_mismatch` and `auth.refresh_token_reuse`.
