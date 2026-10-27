# Purchase Guardian

**Your AI can shop. Purchase Guardian decides whether it should pay.**

AI agents can now fill a cart and press **Pay with PayPal**. Purchase Guardian is the step in between: like 3-D Secure for card payments, every checkout passes through **your** spending policy before PayPal opens, and comes back to the store with the result.

```
AI agent at a store: "restock kitchen basics under $30"
   → agent searches, fills cart, clicks Pay with PayPal        (AI shops; it has no payment tool)
   → redirected to Guardian: checked against YOUR policy       (policy decides)
        ✓ approved  → straight on to PayPal
        ? ask       → your phone buzzes, tap Approve, checkout continues
        ✕ blocked   → back to the store, nothing charged
   → PayPal approval → capture → back to the store             (PayPal executes)
   → every step in an append-only audit trail
```

**Try it:** open `/store`, tell the shopping agent what you need, and watch the checkout route through Guardian.

## Features

- **Guardian Checkout.** A redirect step any merchant or agent platform can put in front of PayPal ([integration guide](docs/guardian-checkout.md)). Return URLs are allowlisted per merchant, merchants only see the outcome, and the flow is idempotent end to end.
- **AI shopping agent.** It runs on NVIDIA NIM with tool calling: search the catalog, build a cart, request checkout. It can't pay; it can only ask Guardian.
- **Installable phone app (PWA).** It has a bottom-tab layout, works offline, and supports **push notifications**. When a checkout needs approval your phone gets a notification, and the waiting checkout page continues on its own once you approve.

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

### Use NVIDIA (recommended) or Claude

- **NVIDIA:** set `NVIDIA_API_KEY` in `apps/api/.env` (from https://build.nvidia.com). It powers both request parsing and the shopping agent. The default model is `meta/llama-3.3-70b-instruct`; change it with `NVIDIA_MODEL`.
- **Claude:** alternatively, set `ANTHROPIC_API_KEY` to use Claude (`claude-opus-5-5`) for parsing.
- **No key:** an offline parser and an offline agent planner keep everything working.

### Phone notifications

```bash
npx web-push generate-vapid-keys
```

Put the keys in `apps/api/.env` as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.

To use it on a phone:
1. Open the app on your phone over HTTPS (any deployed URL).
2. Install it: **Add to Home Screen**. On iPhone, notifications only work once the app is installed from the home screen.
3. On the Guardian page, tap **Turn on approval notifications**.

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

`render.yaml` is a Render Blueprint that sets up managed Postgres, the API and the web app, all in the Oregon region.

- On the **API**, set `WEB_URL`, `CORS_ORIGINS`, `PAYPAL_*`, `NVIDIA_API_KEY` and the `VAPID_*` keys.
- On the **web app**, set `API_URL`.
- For **global edge caching**, put the web service behind Cloudflare. Static assets already ship with immutable cache headers.

## How AI is used

- **Shopping agent (NVIDIA NIM, `meta/llama-3.3-70b-instruct`).** A tool-calling loop with `search_products`, `add_to_cart`, `remove_from_cart`, `view_cart` and `request_checkout`. `request_checkout` only creates a Guardian Checkout session, so the agent has no way to move money. Its goal and reasoning are shown to the shopper and scanned for injected instructions.
- **Request understanding (NVIDIA or Claude Opus 5.5).** It turns free text like "buy a $65 gift from Amazon" into a structured intent (item, merchant, category, amount, confidence, risk flags). The output is re-validated against a strict schema.
- **Decisions are never AI.** Approve, ask and block come only from the deterministic policy engine. Payments happen only after that, plus your approval when the policy asks for it.
- **Development.** This project was built with AI assistance (Claude Code).

## License

MIT
