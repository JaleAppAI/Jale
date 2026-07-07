-- 034_billing_foundation.sql
-- Spec: docs/superpowers/specs/2026-06-30-billing-money-movement-design.md S5.1, S5.3
-- Employer subscriptions, entitlements, billing idempotency, billing webhook inbox.
-- Forward-only. Applied manually via bastion (ADR-005).

BEGIN;

-- ---------- Org-ready scaffolding (user-scoped billing MVP; multi-seat later) ----------
-- Decision 2026-07-06: billing stays user-scoped for MVP. organizations exists now so
-- users.tenant_id (nullable since 001) finally has its FK home and billing rows carry a
-- pre-staged nullable organization_id. Future multi-seat migration: backfill organization_id,
-- then swap the ~3 owner policies below for org-membership policies. No membership model,
-- no signup changes, and no RLS changes in this migration.
CREATE TABLE organizations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE  ROW LEVEL SECURITY;
-- No app policies on organizations: nothing reads it in the MVP (locked by default).

ALTER TABLE users
    ADD CONSTRAINT users_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES organizations(id) ON DELETE RESTRICT;

-- ---------- Plans (catalog data, not code branches) ----------
CREATE TABLE billing_plans (
    code            TEXT PRIMARY KEY,
    audience        TEXT NOT NULL CHECK (audience IN ('employer', 'worker')),
    display_name    TEXT NOT NULL,
    entitlements    JSONB NOT NULL CHECK (jsonb_typeof(entitlements) = 'object'),
    display_price_minor INTEGER CHECK (display_price_minor >= 0),
    currency        TEXT CHECK (currency ~ '^[a-z]{3}$'),
    billing_interval TEXT CHECK (billing_interval IN ('month', 'year')),
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO billing_plans
    (code, audience, display_name, entitlements, display_price_minor, currency, billing_interval) VALUES
    ('employer_free', 'employer', 'Free', '{"active_job_limit": 1}'::jsonb, 0,    'usd', 'month'),
    ('employer_pro',  'employer', 'Pro',  '{"active_job_limit": 10}'::jsonb, 2000, 'usd', 'month'),
    ('worker_free',   'worker',   'Free',  '{}'::jsonb,                     0,    'usd', 'month');

-- ---------- Stripe customer mapping ----------
CREATE TABLE billing_customers (
    user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    provider                TEXT NOT NULL CHECK (provider = 'stripe'),
    provider_customer_id    TEXT UNIQUE NOT NULL,
    organization_id         UUID REFERENCES organizations(id) ON DELETE RESTRICT,  -- nullable; MVP=NULL; future multi-seat owner
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Subscription mirror (Stripe is authoritative, spec S4.2) ----------
CREATE TABLE subscriptions (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    plan_code                   TEXT NOT NULL REFERENCES billing_plans(code),
    provider_subscription_id    TEXT UNIQUE,
    organization_id             UUID REFERENCES organizations(id) ON DELETE RESTRICT,  -- nullable; MVP=NULL; future multi-seat owner
    status                      TEXT NOT NULL CHECK (status IN
        ('incomplete', 'incomplete_expired', 'trialing', 'active',
         'past_due', 'canceled', 'unpaid', 'paused')),
    current_period_start        TIMESTAMPTZ,
    current_period_end          TIMESTAMPTZ,
    cancel_at_period_end        BOOLEAN NOT NULL DEFAULT false,
    grace_ends_at               TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One current subscription per user across non-terminal statuses (spec S5.1).
CREATE UNIQUE INDEX subscriptions_one_current_per_user
    ON subscriptions (user_id)
    WHERE status NOT IN ('canceled', 'incomplete_expired');

CREATE INDEX subscriptions_user_idx ON subscriptions (user_id);

-- ---------- Durable API idempotency (spec S11.1) ----------
CREATE TABLE billing_operations (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id               UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    operation_type              TEXT NOT NULL,
    client_idempotency_key      UUID NOT NULL,
    request_hash                TEXT NOT NULL,
    provider_idempotency_key    TEXT,
    provider_object_id          TEXT,
    status                      TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'succeeded', 'failed')),
    cached_response             JSONB,
    provider_expires_at         TIMESTAMPTZ,
    lease_expires_at            TIMESTAMPTZ,
    attempt_count               INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_code             TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (actor_user_id, operation_type, client_idempotency_key)
);

-- ---------- Webhook event inbox (spec S11.4) ----------
CREATE TABLE billing_webhook_events (
    stripe_event_id     TEXT PRIMARY KEY,
    event_type          TEXT NOT NULL,
    stripe_object_id    TEXT,
    processing_status   TEXT NOT NULL DEFAULT 'received'
                        CHECK (processing_status IN ('received', 'processed', 'failed', 'skipped')),
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    lease_expires_at    TIMESTAMPTZ,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at        TIMESTAMPTZ,
    last_error_code     TEXT
);

-- ---------- RLS ----------
ALTER TABLE billing_plans          ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_plans          FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing_customers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_customers      FORCE  ROW LEVEL SECURITY;
ALTER TABLE subscriptions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions          FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing_operations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_operations     FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_webhook_events FORCE  ROW LEVEL SECURITY;

-- Plan catalog readable by any authenticated app session.
CREATE POLICY billing_plans_read_all ON billing_plans
    FOR SELECT TO jale_admin USING (true);

-- Owner-scoped: current user via app.current_user_id (cognito sub) -> users.id.
CREATE POLICY billing_customers_owner ON billing_customers
    FOR ALL TO jale_admin
    USING (user_id = (SELECT id FROM users
                      WHERE cognito_sub = current_setting('app.current_user_id', true)))
    WITH CHECK (user_id = (SELECT id FROM users
                      WHERE cognito_sub = current_setting('app.current_user_id', true)));

CREATE POLICY subscriptions_owner_read ON subscriptions
    FOR SELECT TO jale_admin
    USING (user_id = (SELECT id FROM users
                      WHERE cognito_sub = current_setting('app.current_user_id', true)));

CREATE POLICY billing_operations_owner ON billing_operations
    FOR ALL TO jale_admin
    USING (actor_user_id = (SELECT id FROM users
                      WHERE cognito_sub = current_setting('app.current_user_id', true)))
    WITH CHECK (actor_user_id = (SELECT id FROM users
                      WHERE cognito_sub = current_setting('app.current_user_id', true)));
-- Note: jale_admin gets NO policy on billing_webhook_events (processor-only table).

-- ---------- Service role (spec S5.3): webhook processor only ----------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jale_billing') THEN
        CREATE ROLE jale_billing WITH LOGIN;
    END IF;
END;
$$;

GRANT SELECT                         ON billing_plans          TO jale_billing;
GRANT SELECT                         ON billing_customers      TO jale_billing;
GRANT SELECT, INSERT, UPDATE         ON subscriptions          TO jale_billing;
GRANT SELECT, INSERT, UPDATE         ON billing_webhook_events TO jale_billing;

CREATE POLICY billing_plans_svc      ON billing_plans          FOR SELECT TO jale_billing USING (true);
CREATE POLICY billing_customers_svc  ON billing_customers      FOR SELECT TO jale_billing USING (true);
CREATE POLICY subscriptions_svc      ON subscriptions          FOR ALL    TO jale_billing USING (true) WITH CHECK (true);
CREATE POLICY billing_webhooks_svc   ON billing_webhook_events FOR ALL    TO jale_billing USING (true) WITH CHECK (true);
-- No users-table grant or policy: processor correlation goes through
-- billing_customers.provider_customer_id and must not expose user PII.

-- App role grants for user-facing billing endpoints (run as jale_admin).
GRANT SELECT                 ON billing_plans      TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON billing_customers  TO jale_admin;
GRANT SELECT                 ON subscriptions      TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON billing_operations TO jale_admin;

COMMIT;
