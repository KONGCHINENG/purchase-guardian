# Purchase Guardian

**Your AI can shop. Purchase Guardian decides whether it should pay.**

An AI purchasing assistant that can understand and prepare purchases but can't complete a PayPal payment unless the purchase passes your budget, merchant, category and risk rules, and, when needed, your explicit approval.

```
"Buy a $65 birthday gift from Amazon"
   → Claude extracts {item, merchant, category, $65.00}       (AI describes)
   → policy engine: above your $50 threshold → needs approval  (policy decides)
   → you tap Approve once                                      (you stay in control)
   → PayPal Sandbox checkout → capture                         (PayPal executes)
   → every step in an append-only audit trail
```

## Features

- **Natural-language purchase requests.** Claude Opus 5.5 turns them into a validated, structured intent using structured outputs and Zod.
- **Deterministic policy engine.** It applies monthly budget, per-purchase limit, approval threshold, blocked/allowed merchants, blocked categories, and an AI-confidence sensitivity level. Every decision is explained in plain language.
- **Human approvals.** Approvals expire. The policy is re-checked at checkout in case your limits changed after you approved.
- **PayPal Orders v2.**
  - The buyer approves the payment on PayPal.
  - The server captures it after approval.
  - Every order is idempotent and bound to exactly one request.
  - Webhooks are signature-verified.
- **Append-only audit trail.** It records every AI analysis, policy decision, approval and payment event, enforced by a database trigger.
- **Prompt-injection resistance.** The LLM has no payment authority, and injection attempts are flagged deterministically and routed to a human.

## Tech

Next.js 16 · Fastify 5 · PostgreSQL (PGlite for zero-setup local dev) · Claude Opus 5.5 (`@anthropic-ai/sdk`) · PayPal Orders v2 · TypeScript monorepo (npm workspaces).

| Path | What it is |
|---|---|
| `apps/web` | Next.js UI: Guardian chat, approvals, activity and audit trail, policy editor |
| `apps/api` | Stateless REST API |
| `packages/policy-engine` | Pure, deterministic, unit-tested rules |
| `packages/paypal-client` | Typed PayPal adapter with token caching, idempotency, retries and a mock gateway |
| `packages/shared` | Zod schemas and DTO types shared by API and UI |

See [docs/architecture.md](docs/architecture.md), [docs/api.md](docs/api.md) and [docs/security.md](docs/security.md).

## Run locally (no database, no API keys needed)

Requires Node 20.11+.

```bash
npm install
cp .env.example apps/api/.env   # then set JWT_SECRET to a long random string
npm run dev                     # API on :4000, web on :3000
```

Open http://localhost:3000 and create an account.

- **Database.** Data is stored in embedded Postgres under `apps/api/.data/`.
- **Default mode.** Without keys the app uses the offline heuristic parser and a mock PayPal checkout. The heuristic parser can't auto-approve, so every purchase asks for your approval.

### Use Claude

Set `ANTHROPIC_API_KEY` in `apps/api/.env`. The model is `claude-opus-5-5`; override it with `ANTHROPIC_MODEL`.

### Use PayPal Sandbox

1. At https://developer.paypal.com, go to **Apps & Credentials** (Sandbox) and create an app.
2. In `apps/api/.env`, set:
   ```
   PAYPAL_ENV=sandbox
   PAYPAL_CLIENT_ID=…
   PAYPAL_CLIENT_SECRET=…
   ```
3. Pay with a sandbox **personal** account from **Testing Tools → Sandbox Accounts**.
4. Optional, for webhooks:
   - Add a webhook to `https://<your-api>/api/v1/webhooks/paypal` with the events `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.*`.
   - Set `PAYPAL_WEBHOOK_ID`.

### With real Postgres

```bash
docker compose up --build
```

## Test

```bash
npm test          # policy engine, PayPal client, heuristic parser, API integration tests
npm run typecheck
```

The API integration tests run the real HTTP stack against embedded Postgres and cover:

- the full purchase flow
- concurrent budget enforcement
- the policy re-check at checkout
- prompt injection
- AI outage fallback
- cross-user isolation
- idempotent webhooks
- audit immutability

## Deploy

`render.yaml` is a Render Blueprint that sets up managed Postgres, the API and the web app.

- On the **API**, set `WEB_URL`, `PAYPAL_*` and `ANTHROPIC_API_KEY`.
- On the **web app**, set `API_URL`.

## How AI is used

- **What it does.** Claude Opus 5.5 extracts item, merchant, category, amount, currency, quantity, a confidence score and risk flags from free text, using structured outputs at low effort.
- **What it can't do.** It can't approve, change policy or call PayPal.
- **Validation.** Its output is re-validated against a strict schema and combined with deterministic risk checks.
- **Who decides.** All approve, approval-required and block decisions come from the deterministic policy engine.
- **Development.** This project was built with AI assistance (Claude Code).

## License

MIT
