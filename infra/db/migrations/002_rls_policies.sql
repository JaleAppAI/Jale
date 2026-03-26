-- ============================================================
-- 002_rls_policies.sql
-- Run manually AFTER 001_initial_schema.sql
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

-- ENABLE activates RLS for non-owner roles.
-- FORCE makes the table owner (jale_admin) also obey the policies.
-- Both are required — ENABLE alone leaves jale_admin unrestricted.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- SELECT: each session can only see its own row.
-- current_setting(..., true): 'true' means return NULL if unset (missing_ok).
-- If app.current_user_id is not set → NULL → no rows returned (safe default).
CREATE POLICY users_isolation_select
  ON users FOR SELECT
  USING (cognito_sub = current_setting('app.current_user_id', true));

-- INSERT: can only insert a row for the authenticated user
CREATE POLICY users_isolation_insert
  ON users FOR INSERT
  WITH CHECK (cognito_sub = current_setting('app.current_user_id', true));

-- UPDATE: can only update own row and cannot change cognito_sub to another user
CREATE POLICY users_isolation_update
  ON users FOR UPDATE
  USING     (cognito_sub = current_setting('app.current_user_id', true))
  WITH CHECK (cognito_sub = current_setting('app.current_user_id', true));

-- No DELETE policy in Sprint 1 — account deletion is a future story

-- Explicit grants (best practice even for the table owner)
GRANT SELECT, INSERT, UPDATE ON users TO jale_admin;
GRANT SELECT, INSERT ON legal_consent_log TO jale_admin;

-- ============================================================
-- VERIFICATION — run after applying (connect as jale_admin):
--
-- Without context → must return 0 rows:
--   SELECT * FROM users;
--
-- With context → must return exactly 1 row:
--   BEGIN;
--   SET LOCAL app.current_user_id = '<a real cognito_sub>';
--   SELECT * FROM users;
--   COMMIT;
-- ============================================================

-- ============================================================
-- RLS for legal_consent_log
-- Each session can only see/insert its own consent records.
-- ============================================================
ALTER TABLE legal_consent_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_consent_log FORCE ROW LEVEL SECURITY;

CREATE POLICY consent_log_isolation_select
  ON legal_consent_log FOR SELECT
  USING (user_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)));

CREATE POLICY consent_log_isolation_insert
  ON legal_consent_log FOR INSERT
  WITH CHECK (user_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)));

GRANT SELECT, INSERT ON legal_consent_log TO jale_admin;
