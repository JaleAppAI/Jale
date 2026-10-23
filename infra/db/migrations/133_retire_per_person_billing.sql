-- ============================================================
-- 133_retire_per_person_billing.sql
-- Run manually AFTER 132_org_team_carry_overs.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Employer organizations, Phase 3 milestone A, part 4: the per-person
-- billing pair retires
-- (docs/superpowers/specs/2026-10-15-employer-organizations-design.md,
-- "Billing and limits").
--
-- Since Phase 2 the billing processor enforces and restores by company,
-- through 128's jale_billing_internal.billing_enforce_org_limits and
-- billing_restore_org. 128 kept 125's per-person pair for the Lambdas
-- deployed before Phase 2 and said Phase 3 drops it; this migration does:
--   billing_pause_over_limit_jobs(uuid, integer)  (036, replaced by 125)
--   billing_resume_paused_jobs(uuid, integer)     (125)
-- Nothing else changes. jale_billing_job_enforcer stays: it owns
-- jale_billing_internal and 128's pair, with its rights on jobs, its
-- job_status_events INSERT and its EXECUTE on enqueue_job_visibility_event.
-- jobs.billing_paused_at stays: 128's pair sets and reads it.
-- On users, 036's UPDATE (id) grant and its users_billing_job_enforcer_lock
-- policy served only the dropped per-person function's row lock and are now
-- unused (128's pair locks the organizations row instead). They are left in
-- place on purpose: 128's self-check and suites pin the enforcer's exact
-- users rights. Revoking them is a follow-up, not part of 133.
--
-- PRODUCTION PRECONDITION. Apply only after Phase 2 milestone B's Lambdas
-- (the company-keyed billing processor) are deployed and confirmed live: the
-- processor must not call either function (grep of infra/lambda is empty).
-- A processor that still did would fail its webhook with 42883 and retry.
-- ROLLBACK. Once 133 is applied, never roll the billing processor back past
-- Phase 2 (#108). The Phase 1 processor calls the dropped functions, and
-- every plan webhook would fail with 42883 and retry. Roll forward instead.
--
-- No dependent object exists (pg_depend lists none on a bed at 132), so
-- the DROPs name no CASCADE: a dependent added since would abort the
-- migration instead of being dropped with them.
--
-- WHO DROPS. Only a function's owner may drop it, and jale_admin holds no
-- USAGE on jale_billing_internal (036), so it cannot even name them. The
-- DROPs run inside the enforcer's window (128's): SET for this transaction,
-- never INHERIT, closed again before the self-check, which proves it.
--
-- LOCKS. DROP FUNCTION locks no table.
--
-- REPLAY: refused once both functions are gone.
-- ============================================================
BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Preconditions ────────────────────────────────────────
DO $$
DECLARE
  v_person INTEGER;
BEGIN
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'migration 133: connect as the migration login itself, without SET ROLE';
  END IF;
  -- 132 as committed: checked first, so a database without it says so.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.job_conversations'::regclass
                    AND conname = 'job_conversations_job_employer_fkey') THEN
    RAISE EXCEPTION 'migration 133: apply 132 first (job_conversations_job_employer_fkey is missing)';
  END IF;
  -- By catalog row: jale_admin cannot resolve names in jale_billing_internal.
  SELECT count(*) INTO v_person
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'jale_billing_internal'
     AND p.proname IN ('billing_pause_over_limit_jobs', 'billing_resume_paused_jobs');
  IF v_person = 0 THEN
    RAISE EXCEPTION 'migration 133: already applied (125''s per-person billing functions are gone); it is not re-runnable';
  END IF;
  -- 125's pair, exactly: these two signatures, no overload, the enforcer's definers.
  IF v_person <> 2
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'jale_billing_internal'
            AND p.proname IN ('billing_pause_over_limit_jobs', 'billing_resume_paused_jobs')
            AND pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_active_job_limit integer'
            AND pg_get_userbyid(p.proowner) = 'jale_billing_job_enforcer' AND p.prosecdef) <> 2 THEN
    RAISE EXCEPTION 'migration 133: 125''s billing_pause_over_limit_jobs / billing_resume_paused_jobs are not as 125 left them';
  END IF;
  -- 128's replacements, the processor's only billing calls since Phase 2.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'jale_billing_internal'
         AND p.proname IN ('billing_enforce_org_limits', 'billing_restore_org')
         AND pg_get_function_identity_arguments(p.oid) = 'p_organization_id uuid, p_active_job_limit integer, p_foreman_seat_limit integer'
         AND pg_get_userbyid(p.proowner) = 'jale_billing_job_enforcer' AND p.prosecdef
         AND has_function_privilege('jale_billing', p.oid, 'EXECUTE')) <> 2 THEN
    RAISE EXCEPTION 'migration 133: 128''s billing_enforce_org_limits / billing_restore_org are missing (apply 128 first)';
  END IF;
  -- The enforcer is as 128 left it: a member of nothing, no SET or INHERIT
  -- row in it, and this login's ADMIN row (the window below needs it).
  IF EXISTS (SELECT 1 FROM pg_auth_members am
              WHERE am.member = 'jale_billing_job_enforcer'::regrole
                 OR (am.roleid = 'jale_billing_job_enforcer'::regrole AND (am.inherit_option OR am.set_option)))
     OR NOT EXISTS (SELECT 1 FROM pg_auth_members am
                     WHERE am.roleid = 'jale_billing_job_enforcer'::regrole
                       AND am.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                       AND am.admin_option) THEN
    RAISE EXCEPTION 'migration 133: jale_billing_job_enforcer''s memberships are not as 128 left them';
  END IF;
END $$;

-- ── 1. The drop, as the owner (128's window) ────────────────
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_billing_job_enforcer', current_user);
END $$;
SET LOCAL ROLE jale_billing_job_enforcer;

DROP FUNCTION jale_billing_internal.billing_pause_over_limit_jobs(uuid, integer);
DROP FUNCTION jale_billing_internal.billing_resume_paused_jobs(uuid, integer);

RESET ROLE;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', 'jale_billing_job_enforcer', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_billing_job_enforcer', current_user, current_user);
END $$;

-- ── 2. Self-check ───────────────────────────────────────────
DO $$
BEGIN
  SET LOCAL search_path = pg_catalog, pg_temp;

  -- Neither per-person function exists, under any signature.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'jale_billing_internal'
                AND p.proname IN ('billing_pause_over_limit_jobs', 'billing_resume_paused_jobs')) THEN
    RAISE EXCEPTION 'migration 133: a per-person billing function is still present';
  END IF;

  -- 128's pair is intact: the enforcer's pinned definers, executable by
  -- exactly jale_billing, and the only functions left in the schema.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'jale_billing_internal'
         AND p.proname IN ('billing_enforce_org_limits', 'billing_restore_org')
         AND pg_get_function_identity_arguments(p.oid) = 'p_organization_id uuid, p_active_job_limit integer, p_foreman_seat_limit integer'
         AND pg_get_userbyid(p.proowner) = 'jale_billing_job_enforcer' AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
         AND has_function_privilege('jale_billing', p.oid, 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                          WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
                            AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) <> 'jale_billing'))) <> 2
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'jale_billing_internal') <> 2 THEN
    RAISE EXCEPTION 'migration 133: 128''s billing_enforce_org_limits / billing_restore_org are not intact';
  END IF;

  -- The window is closed, and the enforcer is a member of nothing.
  IF EXISTS (SELECT 1 FROM pg_auth_members m
              WHERE m.roleid = 'jale_billing_job_enforcer'::regrole
                AND (m.set_option OR m.inherit_option))
     OR EXISTS (SELECT 1 FROM pg_auth_members am WHERE am.member = 'jale_billing_job_enforcer'::regrole)
     OR NOT EXISTS (SELECT 1 FROM pg_auth_members am
                     WHERE am.roleid = 'jale_billing_job_enforcer'::regrole
                       AND am.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                       AND am.admin_option) THEN
    RAISE EXCEPTION 'migration 133: the jale_billing_job_enforcer window was left open';
  END IF;
END $$;

COMMIT;
