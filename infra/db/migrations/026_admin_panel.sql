-- ============================================================
-- 026_admin_panel.sql
-- Admin support console schema for Sprint 12
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Creates admin console tables (users, cases, case events, audit log),
-- the dedicated jale_admin_console login role used by the admin Next.js
-- Lambda, and the RLS policies that give that role:
--   - full bounded access to the admin_* tables, and
--   - column-scoped CROSS-USER read of `users` for case subjects.
--
-- After running this migration, set the jale_admin_console password from
-- the CDK-generated secret (mirrors the jale_matching / jale_ai pattern):
--   ALTER ROLE jale_admin_console WITH PASSWORD '<password from jale/admin-console/db>';
-- The DB host/port/dbname/username already live in that secret.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub TEXT UNIQUE,
  admin_email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin_readonly', 'admin_ops', 'admin_superadmin')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type TEXT NOT NULL CHECK (case_type IN ('help_request', 'verification_blocker', 'outbound_failure', 'conversation_stuck')),
  status TEXT NOT NULL CHECK (status IN ('open', 'pending_worker', 'pending_admin', 'resolved', 'dismissed')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 1 AND 100),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  employer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_case_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES admin_cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'worker', 'admin')),
  actor_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  actor_email TEXT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('admin_readonly', 'admin_ops', 'admin_superadmin', 'system')),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  pii_reveal BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_cases_status_priority_created_at
  ON admin_cases (status, priority DESC, created_at DESC);

-- Verification queue reads filter on case_type='verification_blocker' and sort
-- by (status, priority DESC, updated_at DESC). A partial index keeps that queue
-- on an index scan instead of a seq scan + in-memory sort as the table grows.
CREATE INDEX IF NOT EXISTS idx_admin_cases_verification_queue
  ON admin_cases (status, priority DESC, updated_at DESC)
  WHERE case_type = 'verification_blocker';

CREATE INDEX IF NOT EXISTS idx_admin_cases_user_id
  ON admin_cases (user_id);

CREATE INDEX IF NOT EXISTS idx_admin_cases_conversation_id
  ON admin_cases (conversation_id);

CREATE INDEX IF NOT EXISTS idx_admin_cases_assigned_admin_id
  ON admin_cases (assigned_admin_id);

CREATE INDEX IF NOT EXISTS idx_admin_case_events_case_id_created_at
  ON admin_case_events (case_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
  ON admin_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target
  ON admin_audit_log (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_pii_reveal
  ON admin_audit_log (pii_reveal, created_at DESC)
  WHERE pii_reveal = true;

-- ── Dedicated admin console role ──────────────────────────────
-- jale_admin_console: least-privilege login role for the admin Next.js
-- Lambda. The internet-facing admin app must NOT run as the shared
-- jale_admin owner role. Password is NOT set here — set via ALTER ROLE
-- after migration from the jale/admin-console/db secret.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jale_admin_console') THEN
    CREATE ROLE jale_admin_console WITH LOGIN;
  END IF;
END;
$$;

-- ── RLS ───────────────────────────────────────────────────────
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_case_events FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- admin_users: owner/ops (jale_admin) full access; console reads only.
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_users_self_or_service' AND polrelid = 'public.admin_users'::regclass) THEN
    CREATE POLICY admin_users_self_or_service ON admin_users
      FOR ALL TO jale_admin USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_users_console_read' AND polrelid = 'public.admin_users'::regclass) THEN
    CREATE POLICY admin_users_console_read ON admin_users
      FOR SELECT TO jale_admin_console USING (true);
  END IF;

  -- admin_cases: owner/ops full access; console read + insert + update (no delete).
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_cases_service_all' AND polrelid = 'public.admin_cases'::regclass) THEN
    CREATE POLICY admin_cases_service_all ON admin_cases
      FOR ALL TO jale_admin USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_cases_console_read' AND polrelid = 'public.admin_cases'::regclass) THEN
    CREATE POLICY admin_cases_console_read ON admin_cases
      FOR SELECT TO jale_admin_console USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_cases_console_insert' AND polrelid = 'public.admin_cases'::regclass) THEN
    CREATE POLICY admin_cases_console_insert ON admin_cases
      FOR INSERT TO jale_admin_console WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_cases_console_update' AND polrelid = 'public.admin_cases'::regclass) THEN
    CREATE POLICY admin_cases_console_update ON admin_cases
      FOR UPDATE TO jale_admin_console USING (true) WITH CHECK (true);
  END IF;

  -- admin_case_events: owner/ops full access; console read + insert.
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_case_events_service_all' AND polrelid = 'public.admin_case_events'::regclass) THEN
    CREATE POLICY admin_case_events_service_all ON admin_case_events
      FOR ALL TO jale_admin USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_case_events_console_read' AND polrelid = 'public.admin_case_events'::regclass) THEN
    CREATE POLICY admin_case_events_console_read ON admin_case_events
      FOR SELECT TO jale_admin_console USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_case_events_console_insert' AND polrelid = 'public.admin_case_events'::regclass) THEN
    CREATE POLICY admin_case_events_console_insert ON admin_case_events
      FOR INSERT TO jale_admin_console WITH CHECK (true);
  END IF;

  -- admin_audit_log: APPEND-ONLY for both roles. Separate SELECT + INSERT
  -- policies (never FOR ALL) so the append-only intent is encoded in the
  -- policy itself, not only in the GRANT. No UPDATE/DELETE policy exists.
  -- TRUST BOUNDARY: append-only binds the application roles (esp. the
  -- internet-facing jale_admin_console). jale_admin OWNS these tables and can
  -- still TRUNCATE/DROP/ALTER them — it is a trusted bastion-only operator
  -- credential, not an app surface. A future hardening step could move the
  -- audit log to a schema/role the app owner cannot rewrite.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_audit_log_service_all' AND polrelid = 'public.admin_audit_log'::regclass) THEN
    DROP POLICY admin_audit_log_service_all ON admin_audit_log;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_audit_log_select' AND polrelid = 'public.admin_audit_log'::regclass) THEN
    CREATE POLICY admin_audit_log_select ON admin_audit_log
      FOR SELECT TO jale_admin, jale_admin_console USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'admin_audit_log_insert' AND polrelid = 'public.admin_audit_log'::regclass) THEN
    CREATE POLICY admin_audit_log_insert ON admin_audit_log
      FOR INSERT TO jale_admin, jale_admin_console WITH CHECK (true);
  END IF;

  -- users: column-scoped CROSS-USER read for case subjects. The admin console
  -- needs to resolve worker AND employer identity for cases/verifications it
  -- shows. This deliberately mirrors ADR-W05 (jale_whatsapp cross-user read):
  -- broader than jale_admin's per-user policy, compensated by (a) a dedicated
  -- least-privilege role, (b) column-level grants below, (c) PII masked by
  -- default in the app, and (d) every raw reveal writes an audit row.
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'users_admin_console_read' AND polrelid = 'public.users'::regclass) THEN
    CREATE POLICY users_admin_console_read ON users
      FOR SELECT TO jale_admin_console USING (true);
  END IF;
END;
$$;

-- ── Grants ────────────────────────────────────────────────────
-- Explicit CONNECT + schema USAGE for the new role. These are usually covered
-- by PUBLIC defaults (jale_whatsapp relies on them), but granting explicitly
-- removes the one silent "permission denied for schema public" failure mode if
-- PUBLIC grants are ever revoked as a hardening step.
GRANT CONNECT ON DATABASE jale TO jale_admin_console;
GRANT USAGE ON SCHEMA public TO jale_admin_console;

-- jale_admin (owner/ops/bastion): unchanged. Audit log stays append-only.
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_users TO jale_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_cases TO jale_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_case_events TO jale_admin;
GRANT SELECT, INSERT ON admin_audit_log TO jale_admin;

-- jale_admin_console (the admin Lambda): least privilege.
--   - admin_users: read only (resolve assigned-admin email)
--   - admin_cases: read + insert + update (bounded mutations; NO delete)
--   - admin_case_events: read + insert (timeline)
--   - admin_audit_log: append-only (read + insert; NO update/delete)
GRANT SELECT ON admin_users TO jale_admin_console;
GRANT SELECT, INSERT, UPDATE ON admin_cases TO jale_admin_console;
GRANT SELECT, INSERT ON admin_case_events TO jale_admin_console;
GRANT SELECT, INSERT ON admin_audit_log TO jale_admin_console;

-- users: column-scoped read of identity fields only (never the full row).
GRANT SELECT (id, full_name, phone, email, user_type, whatsapp_number)
  ON users TO jale_admin_console;

COMMIT;

-- ============================================================
-- VERIFICATION — run after applying (connect as jale_admin):
--
-- 1. Role exists:
--   SELECT rolname FROM pg_roles WHERE rolname = 'jale_admin_console';
--
-- 2. Console can read a case subject's identity (set password first):
--   SET ROLE jale_admin_console;
--   SELECT id, full_name FROM users LIMIT 1;   -- returns a row
--   RESET ROLE;
--
-- 3. Console cannot mutate the audit log:
--   SET ROLE jale_admin_console;
--   UPDATE admin_audit_log SET action = 'x';   -- must fail (no grant/policy)
--   DELETE FROM admin_audit_log;               -- must fail
--   RESET ROLE;
--
-- 4. Console cannot read non-granted user columns:
--   SET ROLE jale_admin_console;
--   SELECT cognito_sub FROM users LIMIT 1;      -- must fail (column not granted)
--   RESET ROLE;
-- ============================================================
