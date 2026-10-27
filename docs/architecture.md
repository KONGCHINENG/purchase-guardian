# Architecture

> **Principle:** the AI recommends, the policy decides, PayPal executes. The LLM never holds payment authority.

## System overview

```
┌──────────────────────────────┐
│ Web (Next.js 16, React 19)   │  Landing · Auth · Guardian chat · Approvals
│ apps/web                     │  Activity + audit trail · Policy editor
└──────────────┬───────────────┘
               │ same-origin /api/v1/* (Next rewrite → API)
               │ Bearer access JWT (memory) + httpOnly refresh cookie
┌──────────────▼───────────────┐
│ API (Fastify 5, stateless)   │  helmet · CORS · rate limits (per user / per IP)
│ apps/api                     │  request ids · structured logs · zod validation
│                              │
│  auth ─ policies ─ purchase-requests ─ approvals ─ payments ─ webhooks
│              │            │                 │
│              │     ┌──────▼───────┐  ┌──────▼──────────────┐
│              │     │ AI analyzer  │  │ Policy engine        │
│              │     │ Claude Opus  │  │ packages/policy-     │
│              │     │ 5.5, struct. │  │ engine (pure, no I/O)│
│              │     │ output + Zod │  └──────────────────────┘
│              │     │ heuristic    │
│              │     │ fallback     │  ┌──────────────────────┐
│              │     └──────────────┘  │ PayPal gateway        │
│              │                       │ packages/paypal-client│
│              │                       │ Orders v2, idempotent │
│              │                       └───────────┬──────────┘
└──────────────┼───────────────────────────────────┼──────────┘
        ┌──────▼──────────────┐             ┌──────▼──────────┐
        │ PostgreSQL          │             │ PayPal Sandbox   │
        │ (PGlite in dev/test)│             │ create · capture │
        └─────────────────────┘             │ webhooks         │
                                            └─────────────────┘
```

### Why these choices

| Concern | Choice | Reason |
|---|---|---|
| API framework | Fastify instead of the proposal's NestJS | Same modular layout (`modules/<domain>/{routes,service}.ts`) with far less boilerplate for a small team; ~2× NestJS throughput; easy to extract services later. |
| Data access | `pg` + hand-written SQL, no ORM | Money logic needs exact control over locks (`FOR UPDATE`, advisory locks) and transactions. SQL is reviewed alongside code. |
| Local DB | PGlite (Postgres compiled to WASM) | Zero-install dev and fast hermetic tests on the *same* SQL dialect as production. `DATABASE_URL=pglite://…` vs `postgres://…`. |
| Redis / BullMQ | **Deferred** | Not needed for correctness at MVP scale: budget locks live in Postgres, approval expiry is lazy, AI runs inline (~1–3 s). Add when moving AI/webhooks to workers (see scaling). |
| AI | Claude Opus 5.5 via `messages.parse` + Zod structured output, effort `low` | One bounded extraction call per request. Output is re-validated with the strict shared schema, then merged with deterministic risk signals. |
| Payments | PayPal Orders v2, intent `CAPTURE`, redirect approval | Buyer approves in PayPal; we capture server-side. `PayPal-Request-Id` on every mutation. |

## Request lifecycle

```
POST /purchase-requests "Buy a $65 gift from Amazon"
  │ tx: INSERT purchase_request(status=analyzing) + audit(submitted)
  ▼
AI analyzer (outside any transaction — model latency never holds locks)
  │ Claude → structured intent → PurchaseIntentSchema.parse → + deterministic risk flags
  │ on model error/refusal → heuristic parser, flagged ai_unavailable / ai_refused
  ▼
tx (per-user advisory lock):
  │ load policy + committed spend (captured + in-flight orders this month)
  │ evaluatePolicy()  → approve | require_approval | block  (+ explanation)
  │ UPDATE request, INSERT policy_decision, audit(ai), audit(policy)
  │ require_approval → INSERT approval(expires_at = now + TTL)
  ▼
User approves (POST /approvals/:id/approve)  ── only for require_approval
  ▼
POST /payments/paypal/orders
  │ tx (advisory lock): ownership · status=approved · approval not expired ·
  │   policy RE-CHECK with fresh spend · one order per request (UNIQUE) ·
  │   INSERT paypal_order(status=creating, idempotency_key)
  │ PayPal create order (PayPal-Request-Id = idempotency_key) → approval URL
  ▼
Buyer approves on PayPal → redirect /checkout/return?orderId=…
  ▼
POST /payments/paypal/orders/:id/capture   (and/or webhook CHECKOUT.ORDER.APPROVED)
  │ PayPal capture (PayPal-Request-Id = key-capture); ORDER_ALREADY_CAPTURED = success
  │ verify captured amount == approved amount, else flag for manual review
  │ tx: order → completed (only once), request → completed, audit(captured)
```

## Data model

Defined in [`apps/api/src/db/migrations.ts`](../apps/api/src/db/migrations.ts).

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | Accounts | `email CITEXT UNIQUE`, scrypt password hash |
| `user_policies` | One policy per user, versioned | `UNIQUE(user_id)`, non-negative limits, `version` bumps on every change |
| `purchase_requests` | Raw input + AI extraction + status | status `CHECK`, `ai_risk_flags JSONB`, `ai_reasoning JSONB` |
| `policy_decisions` | Every evaluation, with the policy snapshot and engine version | Immutable history; latest wins |
| `approvals` | Human-in-the-loop gate | `UNIQUE(purchase_request_id)`, `expires_at` |
| `paypal_orders` | PayPal order per request | `UNIQUE(purchase_request_id)`, `UNIQUE(idempotency_key)`, `UNIQUE(paypal_order_id)`, `amount_cents > 0` |
| `audit_events` | Append-only log of every AI, policy, user and payment action | Trigger rejects `UPDATE`/`DELETE` (only FK anonymization allowed) |
| `refresh_tokens` | Rotating sessions | Only SHA-256 hashes stored, reuse → revoke all |
| `webhook_events` | PayPal deliveries | PK = PayPal event id → replays are no-ops |

Money is `BIGINT` minor units everywhere; no floats touch amounts.

## Repository layout

```
purchase-guardian/
├─ apps/
│  ├─ api/                    Fastify API
│  │  ├─ src/
│  │  │  ├─ main.ts           boot: config → db → migrations → app → graceful shutdown
│  │  │  ├─ app.ts            plugins, error handling, health, route registration
│  │  │  ├─ config.ts         zod-validated env
│  │  │  ├─ context.ts        dependency container (db, analyzer, paypal, log)
│  │  │  ├─ db/               pg/PGlite adapter, migrations, migration runner
│  │  │  ├─ lib/              errors, security (scrypt, JWT), audit, row→DTO mappers
│  │  │  ├─ plugins/auth.ts   Bearer auth preHandler
│  │  │  └─ modules/          ai · auth · policies · purchase-requests · approvals · payments
│  │  └─ test/                HTTP integration tests (PGlite + mock PayPal)
│  └─ web/                    Next.js app (App Router)
│     └─ src/{app,components,lib}
├─ packages/
│  ├─ shared/                 zod schemas, enums, DTO types (API ↔ UI contract)
│  ├─ policy-engine/          pure deterministic rules + tests
│  └─ paypal-client/          Orders v2 adapter, token cache, retries, mock gateway + tests
├─ docs/                      architecture · api · security
├─ docker-compose.yml · render.yaml · .github/workflows/ci.yml
```

## Scaling path

**Now (0–10K users).** One API instance and one web instance behind Render's load balancer, managed Postgres. The API is stateless (JWT access tokens, DB-backed refresh tokens, Postgres advisory locks), so adding replicas is a config change.

**10K–500K.**
- Horizontal API replicas; Postgres read replica for list/audit reads.
- Move AI analysis to a queue worker (BullMQ on Redis): `POST /purchase-requests` returns `202 analyzing`, UI polls/streams status. The service boundary (`analyzeAndDecide`) is already isolated for this.
- Webhook ingestion → enqueue → worker (table already supports at-least-once processing).
- Redis-backed rate limiting (`@fastify/rate-limit` store swap) so limits are global across replicas.
- OpenTelemetry tracing from request → AI call → PayPal call (request ids already propagate).

**500K–millions.**
- Partition `audit_events` by month; stream to a warehouse for analytics.
- Shard by `user_id` (every hot query is already user-scoped and indexed `(user_id, created_at)`).
- Dedicated risk service consuming domain events; policy packs for B2B/teams.
