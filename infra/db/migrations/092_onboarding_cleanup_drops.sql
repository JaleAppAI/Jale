-- ============================================================
-- 092_onboarding_cleanup_drops.sql
-- Run manually AFTER 091_application_stages.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Forward-only (ADR-005). ONE transaction. This file is the sprint-23
-- CLEANUP: it removes four groups of objects that no longer have a caller,
-- and it removes NOTHING else. There is no new capability here.
--
-- ── DEPLOY ORDER: APPLY THIS MIGRATION *AFTER* DEPLOYING THE CODE ──
-- The EXACT OPPOSITE of 090 and 091, and the same rule 086 carried. Every
-- object below is referenced by at least one line of code on the tip that
-- precedes this file's PR; the PR that carries this migration is what
-- removes those last references (see "WHAT THE SAME PR REMOVES" below).
-- Applying first would break a still-deployed Lambda:
--   * `reset-whatsapp-onboarding-v2.ts` SETs users.trust_signals in its
--     one-transaction reset -- a 42703 undefined_column would abort the
--     whole operator reset, not degrade it;
--   * `profile-flow.ts`'s `trustSignalColumnsAvailable` probes
--     information_schema for those columns -- harmless, but it exists only
--     to guard a caller that is already gone;
--   * `scripts/inspect-trust-score.ps1` SELECTs both columns.
-- So the release order for this migration is:
--   1. deploy the code that stops referencing these objects
--   2. apply THIS file
-- Nothing here is time-critical: every object is already dead weight, so a
-- long gap between (1) and (2) is safe. The reverse is not.
--
-- ── WHY EACH OBJECT IS DEAD (verified by repo-wide grep on this tip) ────
--
-- 1. 053_whatsapp_web_worker_bypass.sql -- the ENTIRE migration.
--    053 short-circuited a website-registered worker (users.email AND
--    users.tos_accepted_at both set) to lifecycle 'ready' on their first
--    inbound WhatsApp message. Sprint 22 R2 removed both halves of that
--    premise: web signup is now PHONE ONLY (`reconcile_worker_signup`
--    writes no email), so the eligibility predicate can never match again,
--    and the bypass lane was deleted from the processor outright. 087's
--    header documents exactly this ("Sprint 22 R2 removes both of those
--    shields"), and 087 exists BECAUSE the bypass is gone -- it repairs the
--    reopen bug the bypass used to hide. The three objects:
--      * FUNCTION bypass_onboarding_for_web_worker(UUID,UUID,TEXT,TEXT,TEXT)
--        -- no caller in lambda/, scripts/, admin/ or frontend/; the only
--        remaining mentions are two processor.test.ts assertions that the
--        name is NEVER queried, and prose in 087's header.
--      * POLICY users_web_worker_bypass_definer ON users -- a policy is
--        never referenced by name, so absence-of-grep is not proof. It was
--        checked structurally instead: it is the ONLY `FOR UPDATE` policy
--        on `users` keyed on `app.onboarding_bind_user_id`, and the only
--        function that ever set that GUC *and* then UPDATEd `users` was
--        053's definer. The surviving setters of that GUC (042/046/047/086/
--        087) write whatsapp_conversations, worker_onboarding_state and
--        worker_workflow_runs -- never `users` -- and 042's
--        users_onboarding_bind_definer, which stays, is FOR SELECT. 027's
--        users_worker_reconcile (FOR ALL, keyed on app.worker_reconcile_sub)
--        is what covers every surviving jale_admin write to `users`, and it
--        is untouched here. `users` keeps FORCE ROW LEVEL SECURITY.
--      * GRANT SELECT (email) ON users TO jale_whatsapp -- existed solely so
--        the processor could evaluate 053's eligibility check before calling
--        the definer. No SQL under lambda/whatsapp/ names `email` at all,
--        and no surviving INVOKER-rights function reads users.email (026's
--        email grant is to a different role and stays).
--
-- 2. 052_worker_pending_name_and_skills_reset.sql -- its FIRST half only.
--    The staged-signup-name lane. R2 made web signup phone-only and the
--    worker types their name at `profile.name` inside the flow, so nothing
--    stages and nothing promotes: `worker-web-signup.ts` accepts-and-ignores
--    `fullName`, and `verify-auth-challenge.ts` touches no database at all.
--    Both handlers' comments already say the functions "have no caller left"
--    and verify-auth-challenge.test.ts pins that the handler never issues
--    `SELECT promote_worker_pending_name`.
--    052's SECOND half is DELIBERATELY KEPT and is asserted below: the
--    `GRANT DELETE ON worker_skills TO jale_whatsapp` and the
--    `worker_skills_whatsapp_delete` policy are live -- the RESTART reset
--    (`resetPendingTrustAssessmentAndSkills`) still needs both.
--
-- 3. 006_trust_signal_layer.sql -- users.trust_signals /
--    trust_signals_completed_at. The v1 three-question trust layer. v2
--    stores answers in worker_trust_assessments.answers (012/049) and the
--    extraction output in worker_trust_extractions (086); nothing reads or
--    writes the v1 columns. The repo's own tests already assert their
--    ABSENCE from the live SQL (`onboarding-repository.test.ts:391` and
--    `employer-candidate-ranking.test.ts:168` both assert the generated
--    query text does not contain `trust_signals`, and processor.test.ts
--    pins zero `u.trust_signals` reads). No index, no view, no generated
--    column and no constraint references either column -- the pg_depend
--    probe in part (a) proves that at apply time rather than trusting this
--    comment. Their column grants (006 to jale_whatsapp, and 010's
--    multi-column grant to jale_matching) are revoked explicitly before the
--    drop, even though DROP COLUMN would discard the ACL entries anyway --
--    the explicit REVOKE is what makes the intent auditable in this file,
--    and the self-audit then proves the OTHER columns in 010's grant list
--    (id, user_type, main_trade) survived it.
--
-- 4. 022_job_application_required_docs_guard.sql /
--    080_whatsapp_application_fill.sql -- FUNCTION
--    enforce_job_application_required_docs(). 091 dropped the TRIGGER that
--    called it and deliberately left the function behind so that reverting
--    091 would be one CREATE TRIGGER with no function to restore. That soak
--    is over; 091's own header names this drop as "migration 092's cleanup
--    job". Its `app.allow_incomplete_docs` GUC bypass dies with it (already
--    inert -- applications.ts:193 documents it as dead and
--    applications.test.ts asserts neither surface ever sets it).
--    NOT to be confused with 091's `enforce_job_application_hire_requirements()`,
--    which is LIVE, is what replaced this guard, and is asserted PRESENT below.
--
-- ── WHAT THE SAME PR REMOVES (the code half of "code first") ────────────
--   * infra/scripts/reset-whatsapp-onboarding-v2.ts   -- USERS_UPDATE stops
--     SETting trust_signals / trust_signals_completed_at.
--   * infra/lambda/whatsapp/lib/profile-flow.ts       -- the dead
--     `trustSignalColumnsAvailable` probe and its private
--     `tableColumnExists` helper (the processor has its own copy).
--   * scripts/inspect-trust-score.ps1                 -- drops the two
--     columns from the operator snapshot query.
--   * infra/test/unit/db/whatsapp-onboarding-052.integration.test.ts is
--     deleted; its FIVE pending-name cases die with the objects, and its
--     FOUR surviving cases (052's worker_skills half, saveTrustAnswer's
--     upsert-by-question_index, findPreviousStepKey) move into this
--     migration's own integration suite so no coverage is lost.
--
-- ── A STALE COMMENT THAT CANNOT BE FIXED ────────────────────────────────
-- 090_email_outbox_delivery_metadata.sql's header says the cleanup that
-- drops these objects "is now 091, not 088 or 089". It is 092. 090 is
-- applied and committed, and applied migrations are never edited
-- (forward-only), so that line stays wrong on purpose. This header is the
-- correction. lambda/auth/verify-auth-challenge.ts carried the same stale
-- "091 drops them" and IS corrected in this PR, because it is code.
--
-- ── IDEMPOTENCE ─────────────────────────────────────────────────────────
-- Every statement is guarded (`DROP ... IF EXISTS`, `DROP COLUMN IF EXISTS`)
-- and the self-audit asserts ABSENCE, so a second apply is a no-op that
-- still passes. The two REVOKEs are no-ops once the columns are gone.
-- Nothing here is CASCADE: a plain DROP that finds a live dependent must
-- fail loudly (2BP01) rather than quietly take the dependent with it. That
-- is the whole safety model of this file, which is why part (a) enumerates
-- dependents BEFORE anything is dropped -- a post-hoc audit cannot see what
-- a CASCADE would have eaten.
--
-- ── REGISTRATION POINTS (five, plus one this file adds work to) ──
--   1  scripts/run-migrations.sh                              MIGRATIONS array
--   2  scripts/run-migrations.ps1                             $Migrations list
--   3  infra/test/unit/db/migrations.test.ts                   number sequence
--                                                             + content test
--   4  infra/test/unit/db/migrations/apply-order.test.ts       baseline list
--   5  infra/test/unit/scripts/run-migrations-sh.test.ts       compares (1) to
--      the on-disk directory. It extracts the list with
--      /\d{3}b?_[a-zA-Z0-9_]+\.sql/g over the whole block, so a COMMENT that
--      names a migration file inside that block reads as a list entry and
--      fails the comparison -- name numbers in prose there, never files.
--   +  infra/test/unit/scripts/run-whatsapp-v2-db-tests.test.ts pins the
--      fail-closed runner's suite array with toEqual, so this migration's new
--      real-DB suite is registered there as well as in the .sh itself. The
--      same file-name trap applies to that .sh: its pin test regexes suite
--      paths out of the WHOLE script, so a comment naming a removed suite
--      would read as a list entry.
--
-- Next free migration after this one: 093.
-- ============================================================
BEGIN;

-- ── (a) dependency pre-flight: prove nothing else hangs off these ───
-- Runs BEFORE any drop. Nothing below uses CASCADE, so PostgreSQL would
-- already refuse a drop with a live dependent -- but it refuses with a bare
-- "cannot drop ... because other objects depend on it" that names one
-- dependent and tells an operator nothing about the rest. This block turns
-- that into a complete, named list in a single RAISE.
--
-- deptype 'n' (NORMAL) is the only class that matters: those are exactly the
-- dependencies that block a RESTRICT drop. 'a' (AUTO -- the column's own
-- default expression and its NOT NULL/CHECK baggage) and 'i' (INTERNAL) are
-- discarded with the object by design and must not be reported as blockers.
DO $$
DECLARE
  v_deps TEXT[];
BEGIN
  -- Columns: users.pending_full_name / _set_at (052) and
  -- users.trust_signals / _completed_at (006).
  SELECT COALESCE(array_agg(DISTINCT pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)),
                  ARRAY[]::text[])
    INTO v_deps
    FROM pg_catalog.pg_depend d
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
   WHERE d.refclassid = 'pg_catalog.pg_class'::regclass
     AND d.refobjid = 'public.users'::regclass
     AND a.attname IN ('pending_full_name', 'pending_full_name_set_at',
                       'trust_signals', 'trust_signals_completed_at')
     AND d.deptype = 'n';

  IF array_length(v_deps, 1) > 0 THEN
    RAISE EXCEPTION 'migration 092 pre-flight: users columns still carry dependents (no CASCADE is used here): %',
      array_to_string(v_deps, ' | ');
  END IF;

  -- Functions: the 022/080 guard, 053's bypass definer, and 052's two
  -- pending-name definers. A surviving TRIGGER on the guard function is the
  -- realistic failure (091 not applied, or the trigger recreated), and it
  -- shows up here rather than as a 2BP01 three statements later.
  SELECT COALESCE(array_agg(DISTINCT pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)),
                  ARRAY[]::text[])
    INTO v_deps
    FROM pg_catalog.pg_depend d
   WHERE d.refclassid = 'pg_catalog.pg_proc'::regclass
     AND d.refobjid IN (
       to_regprocedure('public.enforce_job_application_required_docs()')::OID,
       to_regprocedure('public.bypass_onboarding_for_web_worker(uuid,uuid,text,text,text)')::OID,
       to_regprocedure('public.stage_worker_pending_name(text,text)')::OID,
       to_regprocedure('public.promote_worker_pending_name(text)')::OID
     )
     AND d.deptype = 'n';

  IF array_length(v_deps, 1) > 0 THEN
    RAISE EXCEPTION 'migration 092 pre-flight: functions still carry dependents (no CASCADE is used here): %',
      array_to_string(v_deps, ' | ');
  END IF;
END;
$$;

-- ── (b) 053: the web-worker onboarding bypass, in full ──────────────
DROP FUNCTION IF EXISTS public.bypass_onboarding_for_web_worker(UUID, UUID, TEXT, TEXT, TEXT);

DROP POLICY IF EXISTS users_web_worker_bypass_definer ON public.users;

-- COLUMN-SCOPED. A bare `REVOKE SELECT ON users FROM jale_whatsapp` would
-- take 004's fourteen-column lookup grant, 041's tos_accepted_at and 049's
-- privacy_accepted_at with it and break every WhatsApp inbound turn. The
-- self-audit below re-asserts all of those, which is what catches a
-- widened revoke.
REVOKE SELECT (email) ON public.users FROM jale_whatsapp;

-- ── (c) 052 first half: the staged signup name ──────────────────────
DROP FUNCTION IF EXISTS public.stage_worker_pending_name(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.promote_worker_pending_name(TEXT);

ALTER TABLE public.users
  DROP COLUMN IF EXISTS pending_full_name,
  DROP COLUMN IF EXISTS pending_full_name_set_at;

-- ── (d) 006: the v1 trust-signal columns ────────────────────────────
-- Explicit REVOKEs first (see header note 3). Both roles that hold a column
-- grant on these are named: 006 granted jale_whatsapp SELECT + UPDATE, and
-- 010 named them inside a five-column SELECT grant to jale_matching -- only
-- the two columns are revoked there, never the grant.
--
-- GUARDED, because REVOKE has no IF EXISTS and a column-scoped REVOKE
-- naming a dropped column is a hard 42703 -- which would make the SECOND
-- apply of this file fail where the first succeeded. That is the one replay
-- hazard in an otherwise all-IF-EXISTS migration, and it is why these two
-- statements live inside a DO block instead of standing on their own.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users'
       AND column_name = 'trust_signals'
  ) THEN
    EXECUTE 'REVOKE SELECT (trust_signals, trust_signals_completed_at),'
         || '       UPDATE (trust_signals, trust_signals_completed_at)'
         || '  ON public.users FROM jale_whatsapp';

    EXECUTE 'REVOKE SELECT (trust_signals, trust_signals_completed_at)'
         || '  ON public.users FROM jale_matching';
  END IF;
END;
$$;

ALTER TABLE public.users
  DROP COLUMN IF EXISTS trust_signals,
  DROP COLUMN IF EXISTS trust_signals_completed_at;

-- ── (e) 022/080: the retired required-docs INSERT guard function ────
-- 091 dropped its trigger. Nothing else calls it: a plpgsql RETURNS TRIGGER
-- function is reachable only from a trigger, and part (a) proved none is
-- attached.
DROP FUNCTION IF EXISTS public.enforce_job_application_required_docs();

-- ── (f) self-verification ───────────────────────────────────────────
-- On RDS there is no Jest: this block is the ONLY thing that verifies this
-- migration in production, which is why migrations.test.ts pins its literal
-- strings. Two halves, and the SECOND is the important one -- asserting that
-- five objects are gone is easy, and a REVOKE or a DROP COLUMN that took
-- more than it should would sail straight through it. So every neighbouring
-- grant, policy and function that must have SURVIVED is asserted too.
DO $$
DECLARE
  col       TEXT;
  fn        TEXT;
  pol       TEXT;
  missing   TEXT[] := ARRAY[]::text[];
BEGIN
  -- ---------- ABSENT ----------

  -- (b) 053's definer, policy and column grant.
  IF to_regprocedure('public.bypass_onboarding_for_web_worker(uuid,uuid,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 092: bypass_onboarding_for_web_worker still exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'public' AND tablename = 'users'
       AND policyname = 'users_web_worker_bypass_definer'
  ) THEN
    RAISE EXCEPTION 'migration 092: policy users_web_worker_bypass_definer still exists on users';
  END IF;

  -- privilege_type MUST be pinned to SELECT. information_schema.column_privileges
  -- expands a TABLE-level grant across every column, and 004 gives
  -- jale_whatsapp table-level INSERT on users -- so `email` legitimately
  -- carries an INSERT row that this migration neither creates nor removes.
  -- An unscoped EXISTS here reads that INSERT row as a surviving 053 grant
  -- and fails a correct migration.
  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
     WHERE grantee = 'jale_whatsapp' AND table_schema = 'public'
       AND table_name = 'users' AND column_name = 'email'
       AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'migration 092: jale_whatsapp still holds SELECT on users.email';
  END IF;

  -- (c) 052's two definers.
  IF to_regprocedure('public.stage_worker_pending_name(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 092: stage_worker_pending_name still exists';
  END IF;
  IF to_regprocedure('public.promote_worker_pending_name(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 092: promote_worker_pending_name still exists';
  END IF;

  -- (c) + (d) the four dropped columns.
  FOREACH col IN ARRAY ARRAY['pending_full_name', 'pending_full_name_set_at',
                             'trust_signals', 'trust_signals_completed_at']
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users' AND column_name = col
    ) THEN
      RAISE EXCEPTION 'migration 092: users.% still exists', col;
    END IF;
  END LOOP;

  -- (e) the 022/080 guard function AND its trigger (091 dropped the trigger;
  -- if something recreated it, part (a) would already have failed, but the
  -- end state is asserted here too).
  IF to_regprocedure('public.enforce_job_application_required_docs()') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 092: enforce_job_application_required_docs() still exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgname = 'job_applications_required_docs_guard'
       AND t.tgrelid = 'public.job_applications'::regclass
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'migration 092: job_applications_required_docs_guard trigger is back';
  END IF;

  -- ---------- STILL PRESENT (nothing else changed) ----------

  -- users keeps FORCE ROW LEVEL SECURITY. Dropping a policy must never be
  -- the thing that turns a table's enforcement off.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class rel
    JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public' AND rel.relname = 'users'
       AND rel.relrowsecurity AND rel.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'migration 092: users must keep RLS ENABLE + FORCE';
  END IF;

  -- jale_whatsapp's SELECT lookup grant on users, intact. 004's fourteen
  -- columns plus 041's tos_accepted_at and 049's privacy_accepted_at. This
  -- is the assertion that catches a widened REVOKE in part (b) or (d).
  FOREACH col IN ARRAY ARRAY['id', 'cognito_sub', 'phone', 'whatsapp_number', 'user_type',
                             'full_name', 'city', 'main_trade', 'main_trade_other',
                             'years_experience', 'has_transportation', 'availability',
                             'tos_version', 'privacy_version', 'tos_accepted_at',
                             'privacy_accepted_at']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.column_privileges
       WHERE grantee = 'jale_whatsapp' AND table_schema = 'public'
         AND table_name = 'users' AND column_name = col
         AND privilege_type = 'SELECT'
    ) THEN
      missing := missing || ('SELECT ' || col);
    END IF;
  END LOOP;

  -- jale_whatsapp's UPDATE grant on users, intact (004 + 004's cognito_sub
  -- repair). The onboarding flow writes every one of these.
  FOREACH col IN ARRAY ARRAY['whatsapp_number', 'whatsapp_linked_at', 'full_name', 'city',
                             'main_trade', 'main_trade_other', 'years_experience',
                             'has_transportation', 'availability', 'tos_version',
                             'tos_accepted_at', 'privacy_version', 'privacy_accepted_at',
                             'cognito_sub']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.column_privileges
       WHERE grantee = 'jale_whatsapp' AND table_schema = 'public'
         AND table_name = 'users' AND column_name = col
         AND privilege_type = 'UPDATE'
    ) THEN
      missing := missing || ('UPDATE ' || col);
    END IF;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'migration 092: a REVOKE took more than users.email/trust_signals -- jale_whatsapp lost: %',
      array_to_string(missing, ', ');
  END IF;

  -- 053's own negative invariant, preserved: the column grants above must
  -- never have been "repaired" into a table-level SELECT.
  IF has_table_privilege('jale_whatsapp', 'public.users', 'SELECT') THEN
    RAISE EXCEPTION 'migration 092: jale_whatsapp unexpectedly has broad SELECT on users';
  END IF;

  -- 010's grant to jale_matching lost exactly two columns and kept three.
  FOREACH col IN ARRAY ARRAY['id', 'user_type', 'main_trade']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.column_privileges
       WHERE grantee = 'jale_matching' AND table_schema = 'public'
         AND table_name = 'users' AND column_name = col
         AND privilege_type = 'SELECT'
    ) THEN
      RAISE EXCEPTION 'migration 092: the jale_matching revoke took users.% as well', col;
    END IF;
  END LOOP;

  -- The surviving users policies this file must not have disturbed: 027's
  -- reconcile lane (the ONLY jale_admin write policy on users now) and 042's
  -- bind SELECT definer, plus the four jale_whatsapp lanes from 004.
  FOREACH pol IN ARRAY ARRAY['users_worker_reconcile', 'users_onboarding_bind_definer',
                             'wa_users_read', 'wa_users_update', 'wa_users_insert',
                             'users_matching_read']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies
       WHERE schemaname = 'public' AND tablename = 'users' AND policyname = pol
    ) THEN
      RAISE EXCEPTION 'migration 092: policy % disappeared from users', pol;
    END IF;
  END LOOP;

  -- 052's SECOND half is deliberately KEPT: the RESTART reset still deletes
  -- worker_skills as jale_whatsapp, and needs both the grant and the policy.
  IF NOT has_table_privilege('jale_whatsapp', 'public.worker_skills', 'DELETE') THEN
    RAISE EXCEPTION 'migration 092: jale_whatsapp lost DELETE on worker_skills (052 half two is kept)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'public' AND tablename = 'worker_skills'
       AND policyname = 'worker_skills_whatsapp_delete'
  ) THEN
    RAISE EXCEPTION 'migration 092: worker_skills_whatsapp_delete policy disappeared (052 half two is kept)';
  END IF;

  -- The functions that share a prefix or a purpose with the four dropped
  -- here and are LIVE. enforce_job_application_hire_requirements is 091's
  -- replacement for the guard dropped in part (e) -- dropping the wrong one
  -- of that pair is the single most damaging mistake this file could make,
  -- and it would silently un-gate every hire.
  FOREACH fn IN ARRAY ARRAY['public.enforce_job_application_hire_requirements()',
                            'public.start_web_onboarding_workflow(text,text,integer)',
                            'public.resolve_worker_internal_id(text)',
                            'public.bind_verified_identity_and_start_workflow(text,uuid,uuid,integer,text,text,jsonb)',
                            'public.reconcile_worker_signup(text,text,text)']
  LOOP
    IF to_regprocedure(fn) IS NULL THEN
      RAISE EXCEPTION 'migration 092: % must still exist', fn;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgname = 'job_applications_hire_requirements_guard'
       AND t.tgrelid = 'public.job_applications'::regclass
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'migration 092: 091 hire gate trigger is missing -- the wrong guard was dropped';
  END IF;
END;
$$;

COMMIT;
