/**
 * Ordered, append-only schema migrations. Never edit a shipped migration; add a new one.
 * Kept as TS strings so they ship inside the bundled API build with no file copying.
 */
export type Migration = { id: string; sql: string };

export const migrations: Migration[] = [
  {
    id: "001_init",
    sql: /* sql */ `
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_policies (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                      UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  currency                     CHAR(3) NOT NULL DEFAULT 'USD',
  monthly_limit_cents          BIGINT NOT NULL DEFAULT 100000 CHECK (monthly_limit_cents >= 0),
  per_purchase_limit_cents     BIGINT NOT NULL DEFAULT 25000 CHECK (per_purchase_limit_cents >= 0),
  require_approval_above_cents BIGINT NOT NULL DEFAULT 5000 CHECK (require_approval_above_cents >= 0),
  blocked_categories           JSONB NOT NULL DEFAULT '["gambling"]',
  allowed_merchants            JSONB NOT NULL DEFAULT '[]',
  blocked_merchants            JSONB NOT NULL DEFAULT '[]',
  risk_sensitivity             TEXT NOT NULL DEFAULT 'balanced' CHECK (risk_sensitivity IN ('strict', 'balanced', 'relaxed')),
  version                      INTEGER NOT NULL DEFAULT 1,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  raw_input       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'analyzing' CHECK (status IN (
                    'analyzing', 'blocked', 'pending_approval', 'approved', 'checkout_created',
                    'completed', 'rejected', 'expired', 'failed')),
  item_name       TEXT,
  merchant_name   TEXT,
  category        TEXT,
  currency        CHAR(3),
  amount_cents    BIGINT CHECK (amount_cents IS NULL OR amount_cents >= 0),
  quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  ai_provider     TEXT,
  ai_model        TEXT,
  ai_confidence   NUMERIC(4,3),
  ai_risk_flags   JSONB NOT NULL DEFAULT '[]',
  ai_reasoning    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE policy_decisions (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id            UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  decision                       TEXT NOT NULL CHECK (decision IN ('approve', 'require_approval', 'block')),
  triggered_rules                JSONB NOT NULL DEFAULT '[]',
  explanation                    TEXT NOT NULL,
  monthly_spend_cents            BIGINT NOT NULL DEFAULT 0,
  remaining_monthly_budget_cents BIGINT NOT NULL DEFAULT 0,
  policy_version                 INTEGER NOT NULL,
  engine_version                 INTEGER NOT NULL,
  policy_snapshot                JSONB NOT NULL,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id UUID NOT NULL UNIQUE REFERENCES purchase_requests(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  expires_at          TIMESTAMPTZ NOT NULL,
  approved_at         TIMESTAMPTZ,
  rejected_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One PayPal order per purchase request, one idempotency key per order.
CREATE TABLE paypal_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id UUID NOT NULL UNIQUE REFERENCES purchase_requests(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paypal_order_id     TEXT UNIQUE,
  approval_url        TEXT,
  status              TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'created', 'approved', 'completed', 'failed', 'voided')),
  currency            CHAR(3) NOT NULL,
  amount_cents        BIGINT NOT NULL CHECK (amount_cents > 0),
  idempotency_key     UUID NOT NULL UNIQUE,
  capture_id          TEXT,
  paypal_response     JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  purchase_request_id UUID REFERENCES purchase_requests(id) ON DELETE SET NULL,
  actor               TEXT NOT NULL CHECK (actor IN ('user', 'ai', 'policy_engine', 'system', 'paypal')),
  action              TEXT NOT NULL,
  outcome             TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}',
  ip_address          INET,
  user_agent          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit log is append-only: block UPDATE and DELETE at the database level.
-- The single exception is nulling out user/request references (FK ON DELETE SET NULL
-- when an account is erased), which anonymizes an event without altering its content.
CREATE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id AND NEW.actor = OLD.actor AND NEW.action = OLD.action
     AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome
     AND NEW.metadata = OLD.metadata AND NEW.created_at = OLD.created_at
     AND (NEW.user_id IS NULL OR NEW.user_id = OLD.user_id)
     AND (NEW.purchase_request_id IS NULL OR NEW.purchase_request_id = OLD.purchase_request_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by UUID,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PayPal webhook deliveries, keyed by PayPal's event id so replays are no-ops.
CREATE TABLE webhook_events (
  id           TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  resource_id  TEXT,
  payload      JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_purchase_requests_user_created ON purchase_requests (user_id, created_at DESC, id DESC);
CREATE INDEX idx_policy_decisions_request       ON policy_decisions (purchase_request_id, created_at DESC);
CREATE INDEX idx_approvals_user_status          ON approvals (user_id, status);
CREATE INDEX idx_paypal_orders_user_created     ON paypal_orders (user_id, created_at DESC);
CREATE INDEX idx_audit_events_user_created      ON audit_events (user_id, created_at DESC);
CREATE INDEX idx_audit_events_request           ON audit_events (purchase_request_id, id);
CREATE INDEX idx_refresh_tokens_user            ON refresh_tokens (user_id);
`,
  },
];
