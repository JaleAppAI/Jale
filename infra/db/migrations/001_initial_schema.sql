-- ============================================================
-- 001_initial_schema.sql
-- Run manually BEFORE 002_rls_policies.sql
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub  TEXT        NOT NULL UNIQUE,
    user_type    TEXT        NOT NULL CHECK (user_type IN ('worker', 'employer')),
    email        TEXT,
    phone        TEXT,
    full_name    TEXT,
    tenant_id    UUID,       -- nullable in Sprint 1; future FK to organizations table
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_cognito_sub ON users (cognito_sub);
CREATE INDEX IF NOT EXISTS idx_users_tenant_id   ON users (tenant_id);

-- legal_consent_log: used by LegalStack
CREATE TABLE IF NOT EXISTS legal_consent_log (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_type    TEXT        NOT NULL CHECK (document_type IN ('tos', 'privacy')),
    document_version TEXT        NOT NULL,
    accepted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address       TEXT,
    user_agent       TEXT
);

CREATE INDEX IF NOT EXISTS idx_consent_user_id ON legal_consent_log (user_id);

-- Auto-update updated_at on every row update
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
