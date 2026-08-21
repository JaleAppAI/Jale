-- 081_whatsapp_application_defaults_read.sql
-- Grants jale_whatsapp SELECT-only read access to worker_application_defaults
-- (079_worker_application_defaults.sql). 079's header (lines 46-52)
-- explicitly anticipated this follow-up:
--   GRANT SELECT, INSERT, UPDATE ON worker_application_defaults TO jale_whatsapp;
-- This migration deliberately grants ONLY SELECT -- narrower than 079's
-- anticipated text. Write-back of collected WhatsApp answers into
-- worker_application_defaults is explicitly deferred (plan: docs/superpowers/
-- plans/2026-08-19-whatsapp-application-fill.md Task 9,
-- seedAnswersFromDefaults() reads only); a future migration adds INSERT/
-- UPDATE if/when write-back ships. Least-privilege by default, same posture
-- 079 and 071_wage_references.sql document for their own deliberately-
-- excluded grants.
--
-- ── RLS analysis: two GUC conventions, two policies ──────────────────
-- worker_application_defaults has RLS both ENABLED and FORCED (079 lines
-- 77-78). FORCE means RLS is enforced even against the table owner
-- (jale_admin); it is certainly enforced against jale_whatsapp, which does
-- not own the table. A GRANT never bypasses RLS -- a role still needs a
-- policy that evaluates true for its session before it can see any row.
--
-- 079 created exactly one policy, worker_application_defaults_self (079
-- lines 85-99), FOR ALL, with NO "TO" clause -- an omitted TO clause
-- defaults to PUBLIC, so the policy is not role-excluded; it does apply to
-- jale_whatsapp along with every other role. But its USING/WITH CHECK
-- resolve worker identity as:
--   worker_id = (SELECT id FROM users
--                 WHERE cognito_sub = current_setting('app.current_user_id', true)
--                   AND user_type = 'worker')
-- current_setting('app.current_user_id', true) is the WEB/Cognito-sub
-- convention, set by setRlsContext() (infra/lambda/lib/db.ts:58-66). It
-- covers web-app sessions. WhatsApp Lambdas never set app.current_user_id;
-- they identify the worker through a DIFFERENT GUC, the "internal"
-- convention:
--   current_setting('app.current_internal_user_id', true)  -- users.id
-- set by setInternalUserRlsContext() (infra/lambda/lib/db.ts:72-80), which
-- infra/lambda/whatsapp/processor.ts:1824 and
-- infra/lambda/api/worker-doc-confirm.ts:182 both call, and which the plan's
-- Task 9 seeding step (seedAnswersFromDefaults) is specified to call before
-- its SELECT on this table.
--
-- For a jale_whatsapp session, current_setting('app.current_user_id', true)
-- therefore returns NULL; `cognito_sub = NULL` is never true; the subquery
-- returns no row; `worker_id = NULL` is never satisfied.
-- worker_application_defaults_self, exactly as 079 wrote it, evaluates to
-- false for every row under a jale_whatsapp/app.current_internal_user_id
-- session -- functionally identical to "every policy excludes this role,"
-- even though no policy names a TO list that does so explicitly. The GRANT
-- above gives jale_whatsapp the SELECT *privilege*; on its own it would
-- still see ZERO rows.
--
-- Direct precedent: 066_preferred_cities_whatsapp_read.sql hit this exact
-- shape of gap for worker_preferred_cities (065's self-policy was also keyed
-- on app.current_user_id/cognito_sub with no TO clause) and closed it by
-- adding a SECOND, role-scoped policy alongside the grant:
--   CREATE POLICY worker_preferred_cities_whatsapp_read
--     ON worker_preferred_cities FOR SELECT TO jale_whatsapp
--     USING (user_id::text = current_setting('app.current_internal_user_id', true));
-- This migration follows that precedent below: worker_application_defaults_self
-- (079) continues to cover web sessions via app.current_user_id unchanged
-- (not touched here), and the new worker_application_defaults_whatsapp_read
-- policy covers jale_whatsapp sessions via app.current_internal_user_id,
-- mirroring 066's shape exactly (same TO/FOR SELECT/USING structure, same
-- ::text cast, same GUC), just naming 079's actual PK column
-- (worker_id, not user_id). Two policies, same table, same command (SELECT)
-- but disjoint roles: PostgreSQL ORs multiple permissive policies together,
-- so this only ADDS visibility for jale_whatsapp -- it cannot narrow what
-- worker_application_defaults_self already grants web sessions.
--
-- The DROP POLICY IF EXISTS guard below is NOT copied from 066 (066 has no
-- such guard); it mirrors 079's own local convention in this same feature
-- chain (079 lines 80-83, citing 077/078) of hardening accidental re-applies
-- of a single file, since CREATE POLICY has no IF NOT EXISTS form. The
-- migration chain itself remains forward-only (ADR-005).
--
-- Run AFTER 080_whatsapp_application_fill.sql, connected as jale_admin (NOT
-- the RDS master user). Forward-only (ADR-005).

BEGIN;

GRANT SELECT ON worker_application_defaults TO jale_whatsapp;

DROP POLICY IF EXISTS worker_application_defaults_whatsapp_read ON worker_application_defaults;

CREATE POLICY worker_application_defaults_whatsapp_read
  ON worker_application_defaults FOR SELECT TO jale_whatsapp
  USING (worker_id::text = current_setting('app.current_internal_user_id', true));

-- ── self-verification (073 pattern) ─────────────────────────────
DO $$
BEGIN
  IF NOT has_table_privilege('jale_whatsapp', 'worker_application_defaults', 'SELECT') THEN
    RAISE EXCEPTION 'jale_whatsapp missing SELECT grant on worker_application_defaults';
  END IF;

  -- Write-back is deliberately deferred (see header) -- guard against a
  -- future edit accidentally widening this migration's grant list.
  IF has_table_privilege('jale_whatsapp', 'worker_application_defaults', 'INSERT') THEN
    RAISE EXCEPTION 'jale_whatsapp unexpectedly has INSERT on worker_application_defaults (write-back deferred, see header)';
  END IF;

  IF has_table_privilege('jale_whatsapp', 'worker_application_defaults', 'UPDATE') THEN
    RAISE EXCEPTION 'jale_whatsapp unexpectedly has UPDATE on worker_application_defaults (write-back deferred, see header)';
  END IF;

  -- Table must still be RLS ENABLE + FORCE (079 invariant; this migration
  -- does not touch either setting, but a grant-only reviewer should not be
  -- able to silently rely on that without the migration itself checking).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class rel
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'worker_application_defaults'
      AND rel.relrowsecurity AND rel.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'worker_application_defaults must keep RLS ENABLE + FORCE';
  END IF;

  -- The web-facing self policy from 079 must still be present and untouched
  -- by this migration -- this migration only ADDS a policy, it does not
  -- replace 079's.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class rel ON rel.oid = p.polrelid
    WHERE rel.relname = 'worker_application_defaults' AND p.polname = 'worker_application_defaults_self'
  ) THEN
    RAISE EXCEPTION 'worker_application_defaults_self (079) policy missing -- this migration must not remove it';
  END IF;

  -- The new jale_whatsapp-scoped SELECT policy: role-scoped to jale_whatsapp
  -- only (not PUBLIC, unlike 079's policy), command SELECT, and its USING
  -- expression must reference the internal-user GUC (not the web GUC) --
  -- see header for why that distinction is the entire point of this
  -- migration (049/066/073-style: assert shape via pg_policies, not just
  -- existence).
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'worker_application_defaults'
      AND policyname = 'worker_application_defaults_whatsapp_read'
      AND cmd = 'SELECT'
      AND roles = ARRAY['jale_whatsapp']::name[]
      AND qual ILIKE '%current_internal_user_id%'
      AND qual ILIKE '%worker_id%'
  ) THEN
    RAISE EXCEPTION 'worker_application_defaults_whatsapp_read policy missing or has the wrong shape (expected TO jale_whatsapp, FOR SELECT, USING referencing worker_id + app.current_internal_user_id)';
  END IF;
END;
$$;

COMMIT;
