-- ============================================================
-- 113_admin_onboarding_funnel.sql
-- Run manually AFTER 102_admin_identity_lockouts.sql, connected as
-- jale_admin (NOT the RDS master user). Forward-only (ADR-005).
-- Numbered 113 to leave 104-112 for migrations written in parallel; it
-- depends on nothing after 102, so it may be applied before or after them.
--
-- Roadmap sub-project 2a
-- (docs/superpowers/specs/2026-10-08-admin-analytics-2a-funnels-design.md).
--
-- (1) admin_analytics_onboarding_cohorts(p_weeks): weekly cohorts of new
--     workers by first-contact door, how far each got (started, requested a
--     code, verified, accepted terms, finished profile, ready), and where the
--     rest stopped (declined, in progress, abandoned after 7 quiet days).
--     A conversation belongs to its linked account or, while unlinked, to the
--     worker account with the same phone (conversation-router.ts's rule). A
--     WhatsApp person is a conversation, unless that account was created
--     before it (that person started on the web). A conversation first
--     written before the launch week starts at its first challenge since
--     then (a returning pre-v2 contact), or never if there is none. A web
--     person is a worker account with no such conversation started at or
--     before it.
--     Excluded: phones and accounts in worker_reset_audit (dry_run = false),
--     053 bypass accounts (a web_worker_bypass transition), employers. Weeks
--     before the first otp_verified / web_start transition are not returned.
-- (2) admin_analytics_onboarding_stalled(p_days): active runs with no progress
--     for at least p_days, by the door that created the run (otp_verified /
--     web_start, by presence) and the step it is on.
-- (3) admin_analytics_signups and (4) admin_analytics_totals each gain one
--     verified column (a worker with an onboarding run). Their return types
--     change, which CREATE OR REPLACE cannot do, so both are dropped and
--     recreated and their ACLs re-granted below. The deployed console reads
--     only the old columns, so applying this before the deploy is safe.
--
-- ACCESS (roadmap rules, 089's pattern): every function is a definer owned by
-- jale_admin with a pinned search path, executable by the admin console role
-- only, and opens app.admin_analytics_read after validating its input. The
-- onboarding tables are read through 042's unconditional definer policies,
-- worker_reset_audit through its admin read policy, users through 089's gate,
-- whatsapp_conversations through 102's gate. No policy, grant or index is
-- added.
--
-- DEPLOY ORDER: apply BEFORE deploying the admin console build that calls the
-- new functions and reads the verified columns.
-- ============================================================
BEGIN;

-- Preconditions: pg_policy is a catalog table, so RLS never filters this
-- check; a missing policy would otherwise make the funnel silently empty
-- (the 088 defect).
DO $$
DECLARE
  v_gate CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT * FROM (VALUES
      ('public.worker_onboarding_state', 'worker_onboarding_state_definer', '*', 'true'),
      ('public.worker_workflow_runs', 'worker_workflow_runs_definer', '*', 'true'),
      ('public.worker_workflow_transitions', 'worker_workflow_transitions_definer', '*', 'true'),
      ('public.worker_identity_challenges', 'worker_identity_challenges_definer', '*', 'true'),
      ('public.worker_reset_audit', 'worker_reset_audit_admin_read', 'r', 'true'),
      ('public.users', 'users_admin_analytics_read', 'r', v_gate),
      ('public.whatsapp_conversations', 'whatsapp_conversations_admin_analytics_read', 'r', v_gate)
    ) AS expected(rel, name, cmd, qual)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
       WHERE p.polrelid = pol.rel::regclass
         AND p.polname = pol.name
         AND p.polcmd::text = pol.cmd
         AND p.polpermissive
         AND p.polroles = ARRAY['jale_admin'::regrole::oid]
         AND pg_get_expr(p.polqual, p.polrelid) = pol.qual
    ) THEN
      RAISE EXCEPTION 'migration 113: policy % on % missing or drifted; the funnel would read zero rows', pol.name, pol.rel;
    END IF;
  END LOOP;
END $$;

-- ── Weekly onboarding cohorts ───────────────────────────────
CREATE FUNCTION public.admin_analytics_onboarding_cohorts(p_weeks INTEGER)
RETURNS TABLE (
  cohort_week      TIMESTAMPTZ,
  door             TEXT,
  started          BIGINT,
  code_requested   BIGINT,
  verified         BIGINT,
  accepted_terms   BIGINT,
  finished_profile BIGINT,
  ready            BIGINT,
  declined         BIGINT,
  in_progress      BIGINT,
  abandoned        BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_launch      TIMESTAMPTZ;
  v_launch_week TIMESTAMPTZ;
  v_from        TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  -- Before the first v2 verification there is no funnel to show. With no
  -- launch yet the window starts at 'infinity': the query below still runs
  -- (so every apply plans it) and returns nothing.
  SELECT min(t.created_at) INTO v_launch
    FROM public.worker_workflow_transitions t
   WHERE t.reason IN ('otp_verified', 'web_start');

  -- Week arithmetic on UTC wall-clock time, so the session TimeZone (and its
  -- daylight-saving shifts) can never move the window edge.
  v_launch_week := COALESCE(date_trunc('week', v_launch, 'UTC'), 'infinity'::TIMESTAMPTZ);
  v_from := greatest(
    (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC',
    v_launch_week);

  RETURN QUERY
  WITH steps(step_key, ord) AS (
    VALUES ('start.choose_language', 1), ('identity.verify_otp', 2), ('legal.review', 3),
           ('profile.voice_choice', 4), ('profile.voice_processing', 5), ('profile.name', 6),
           ('profile.location', 7), ('profile.trade', 8), ('profile.custom_trade', 9),
           ('profile.experience', 10), ('profile.transportation', 11), ('profile.availability', 12),
           ('trust.question.1', 13), ('trust.question.2', 14), ('trust.question.3', 15),
           ('profile.photo', 16), ('profile.photo_type', 17)
  ), reset_users AS (
    SELECT DISTINCT a.user_id FROM public.worker_reset_audit a WHERE NOT a.dry_run
  ), reset_phones AS (
    SELECT DISTINCT a.phone_hash FROM public.worker_reset_audit a WHERE NOT a.dry_run
  ), bypass_users AS (
    SELECT DISTINCT r.user_id
      FROM public.worker_workflow_runs r
      JOIN public.worker_workflow_transitions t ON t.run_id = r.id
     WHERE t.reason = 'web_worker_bypass'
  ), conv AS (
    -- A conversation belongs to its linked account or, while still unlinked
    -- (the code was never verified on WhatsApp), to the worker account with
    -- the same phone -- the rule conversation-router.ts uses. Without this a
    -- person who used both doors would be counted once in each.
    -- A number keeps one conversation row forever, so one first written
    -- before the launch week starts at its first challenge since then (the
    -- start step writes one on the first v2 message). With none it never
    -- entered the funnel: no start, but it still carries the account's
    -- activity and reset check.
    SELECT COALESCE(w.user_id, pm.id) AS user_id,
           CASE WHEN w.created_at >= v_launch_week THEN w.created_at ELSE fc.first_at END AS started_at,
           w.updated_at, h.phone_hash
      FROM public.whatsapp_conversations w
      CROSS JOIN LATERAL (
        SELECT encode(sha256(convert_to(btrim(w.whatsapp_number), 'UTF8')), 'hex') AS phone_hash
      ) h
      LEFT JOIN LATERAL (
        SELECT u.id
          FROM public.users u
         WHERE w.user_id IS NULL
           AND u.user_type = 'worker'
           AND (u.whatsapp_number = btrim(w.whatsapp_number) OR u.phone = btrim(w.whatsapp_number))
         ORDER BY CASE WHEN u.whatsapp_number = btrim(w.whatsapp_number) THEN 0 ELSE 1 END, u.created_at, u.id
         LIMIT 1
      ) pm ON true
      LEFT JOIN LATERAL (
        SELECT min(ch.created_at) AS first_at
          FROM public.worker_identity_challenges ch
         WHERE ch.phone_hash = h.phone_hash
           AND ch.created_at >= v_launch_week
      ) fc ON w.created_at < v_launch_week
  ), people AS (
    -- WhatsApp people: a conversation, unless its account predates it (that
    -- person started on the web) or is not a worker.
    SELECT c.user_id, c.phone_hash, c.started_at AS started_at,
           c.updated_at AS conv_updated_at, 'whatsapp'::TEXT AS d
      FROM conv c
      LEFT JOIN public.users u ON u.id = c.user_id
     WHERE c.started_at >= v_from
       AND (u.id IS NULL OR u.user_type = 'worker')
       AND NOT COALESCE(c.user_id IS NOT NULL AND u.created_at < c.started_at, false)
    UNION ALL
    -- Web people: a worker account with no conversation at or before it. A
    -- later conversation still counts toward its activity and reset check.
    SELECT u.id, lc.phone_hash, u.created_at, lc.updated_at, 'web'::TEXT
      FROM public.users u
      LEFT JOIN LATERAL (
        SELECT c.phone_hash, c.updated_at
          FROM conv c
         WHERE c.user_id = u.id
         ORDER BY c.updated_at DESC
         LIMIT 1
      ) lc ON true
     WHERE u.user_type = 'worker'
       AND u.created_at >= v_from
       AND NOT EXISTS (SELECT 1 FROM conv c WHERE c.user_id = u.id AND c.started_at <= u.created_at)
  ), kept AS (
    SELECT p.*
      FROM people p
     WHERE (p.user_id IS NULL OR p.user_id NOT IN (SELECT ru.user_id FROM reset_users ru))
       AND (p.phone_hash IS NULL OR p.phone_hash NOT IN (SELECT rp.phone_hash FROM reset_phones rp))
       AND (p.user_id IS NULL OR p.user_id NOT IN (SELECT bu.user_id FROM bypass_users bu))
  ), run_facts AS (
    SELECT r.user_id,
           bool_or(r.status = 'active')   AS has_active,
           bool_or(r.status = 'declined') AS has_declined,
           max(r.updated_at)              AS run_updated_at,
           max(s.ord)                     AS run_ord
      FROM public.worker_workflow_runs r
      LEFT JOIN steps s ON s.step_key = r.current_step_key
     GROUP BY r.user_id
  ), trans_facts AS (
    SELECT r.user_id, max(s.ord) AS trans_ord, max(t.created_at) AS last_transition_at
      FROM public.worker_workflow_transitions t
      JOIN public.worker_workflow_runs r ON r.id = t.run_id
      LEFT JOIN steps s ON s.step_key = t.to_step_key
     GROUP BY r.user_id
  ), challenge_facts AS (
    SELECT ch.phone_hash,
           bool_or(ch.current_step_key = 'identity.verify_otp' OR ch.status = 'verified') AS reached_code,
           max(ch.updated_at) AS challenge_updated_at
      FROM public.worker_identity_challenges ch
     GROUP BY ch.phone_hash
  ), facts AS (
    SELECT k.d,
           date_trunc('week', k.started_at, 'UTC') AS wk,
           -- A ready worker verified at some point, so the stages always nest.
           (rf.user_id IS NOT NULL OR st.ready_at IS NOT NULL) AS is_verified,
           (k.d = 'web' OR rf.user_id IS NOT NULL OR st.ready_at IS NOT NULL
              OR COALESCE(cf.reached_code, false)) AS is_code,
           greatest(COALESCE(rf.run_ord, 0), COALESCE(tf.trans_ord, 0)) AS furthest,
           (st.ready_at IS NOT NULL) AS is_ready,
           (COALESCE(rf.has_declined, false) AND NOT COALESCE(rf.has_active, false)) AS is_declined,
           greatest(k.started_at, tf.last_transition_at, rf.run_updated_at,
                    k.conv_updated_at, cf.challenge_updated_at) AS last_activity
      FROM kept k
      LEFT JOIN run_facts rf ON rf.user_id = k.user_id
      LEFT JOIN trans_facts tf ON tf.user_id = k.user_id
      LEFT JOIN challenge_facts cf ON cf.phone_hash = k.phone_hash
      LEFT JOIN public.worker_onboarding_state st ON st.user_id = k.user_id
  )
  SELECT f.wk,
         f.d,
         count(*),
         count(*) FILTER (WHERE f.is_code),
         count(*) FILTER (WHERE f.is_verified),
         count(*) FILTER (WHERE f.is_ready OR (f.is_verified AND f.furthest > 3)),
         count(*) FILTER (WHERE f.is_ready OR (f.is_verified AND f.furthest >= 13)),
         count(*) FILTER (WHERE f.is_ready),
         count(*) FILTER (WHERE NOT f.is_ready AND f.is_declined),
         count(*) FILTER (WHERE NOT f.is_ready AND NOT f.is_declined
                            AND f.last_activity >= now() - interval '7 days'),
         count(*) FILTER (WHERE NOT f.is_ready AND NOT f.is_declined
                            AND f.last_activity < now() - interval '7 days')
    FROM facts f
   GROUP BY f.wk, f.d
   ORDER BY f.wk, f.d;
END $$;

-- ── Stalled active runs ─────────────────────────────────────
CREATE FUNCTION public.admin_analytics_onboarding_stalled(p_days INTEGER DEFAULT 7)
RETURNS TABLE (
  door     TEXT,
  step_key TEXT,
  workers  BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_days';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  -- The door is the run-creating transition, classified by presence, not
  -- order: both doors write it and an immediate Terms skip in the same
  -- transaction, so the two rows share created_at. An adopted run has
  -- neither ('other').
  RETURN QUERY
  WITH progress AS (
    SELECT r.id,
           r.current_step_key AS step,
           greatest(r.updated_at, max(t.created_at)) AS last_progress,
           CASE WHEN bool_or(t.reason = 'otp_verified') THEN 'whatsapp'
                WHEN bool_or(t.reason = 'web_start') THEN 'web'
                ELSE 'other' END AS d
      FROM public.worker_workflow_runs r
      LEFT JOIN public.worker_workflow_transitions t ON t.run_id = r.id
     WHERE r.status = 'active'
     GROUP BY r.id, r.current_step_key, r.updated_at
  )
  SELECT p.d, p.step, count(*)
    FROM progress p
   WHERE p.last_progress <= now() - make_interval(days => p_days)
   GROUP BY 1, 2
   ORDER BY 3 DESC, 2;
END $$;

-- ── Signups gain a verified column (return type changes) ────
DROP FUNCTION public.admin_analytics_signups(TIMESTAMPTZ, TEXT);

CREATE FUNCTION public.admin_analytics_signups(
  p_from   TIMESTAMPTZ,
  p_bucket TEXT
)
RETURNS TABLE (
  bucket_start            TIMESTAMPTZ,
  worker_signups          BIGINT,
  employer_signups        BIGINT,
  worker_signups_verified BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_from IS NULL THEN
    RAISE EXCEPTION 'admin_analytics_invalid_from';
  END IF;
  IF p_bucket IS DISTINCT FROM 'day' AND p_bucket IS DISTINCT FROM 'week' THEN
    RAISE EXCEPTION 'admin_analytics_invalid_bucket';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  WITH verified_users AS (
    SELECT DISTINCT r.user_id FROM public.worker_workflow_runs r
  )
  SELECT date_trunc(p_bucket, u.created_at, 'UTC') AS bucket_start,
         count(*) FILTER (WHERE u.user_type = 'worker')   AS worker_signups,
         count(*) FILTER (WHERE u.user_type = 'employer') AS employer_signups,
         count(*) FILTER (WHERE u.user_type = 'worker' AND v.user_id IS NOT NULL) AS worker_signups_verified
    FROM public.users u
    LEFT JOIN verified_users v ON v.user_id = u.id
   WHERE u.created_at >= p_from
   GROUP BY 1
   ORDER BY 1;
END $$;

-- ── Totals gain a verified-worker count (return type changes) ─
DROP FUNCTION public.admin_analytics_totals();

CREATE FUNCTION public.admin_analytics_totals()
RETURNS TABLE (
  total_workers          BIGINT,
  total_employers        BIGINT,
  paying_employers       BIGINT,
  jobs_active            BIGINT,
  jobs_paused            BIGINT,
  jobs_filled            BIGINT,
  jobs_closed            BIGINT,
  hires_total            BIGINT,
  jobs_with_hire         BIGINT,
  total_verified_workers BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  SELECT
    (SELECT count(*) FROM public.users WHERE user_type = 'worker'),
    (SELECT count(*) FROM public.users WHERE user_type = 'employer'),
    (SELECT count(DISTINCT s.user_id) FROM public.subscriptions s
      WHERE s.status IN ('active', 'trialing', 'past_due')),
    (SELECT count(*) FROM public.jobs WHERE status = 'active'),
    (SELECT count(*) FROM public.jobs WHERE status = 'paused'),
    (SELECT count(*) FROM public.jobs WHERE status = 'filled'),
    (SELECT count(*) FROM public.jobs WHERE status = 'closed'),
    (SELECT count(*) FROM public.job_applications WHERE hired_at IS NOT NULL),
    (SELECT count(*) FROM public.jobs WHERE workers_hired > 0),
    (SELECT count(*) FROM public.users u
      WHERE u.user_type = 'worker'
        AND EXISTS (SELECT 1 FROM public.worker_workflow_runs r WHERE r.user_id = u.id));
END $$;

-- ── Ownership + ACL ─────────────────────────────────────────
-- The two drops above discarded their ACLs, so they MUST be re-granted here.
ALTER FUNCTION public.admin_analytics_onboarding_cohorts(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_onboarding_stalled(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_signups(TIMESTAMPTZ, TEXT) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_totals() OWNER TO jale_admin;

REVOKE ALL ON FUNCTION public.admin_analytics_onboarding_cohorts(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_onboarding_stalled(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_signups(TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_totals() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_analytics_onboarding_cohorts(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_onboarding_stalled(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_signups(TIMESTAMPTZ, TEXT) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_totals() TO jale_admin_console;

-- Fail closed if any function drifted from the reviewed model, if a result
-- lost its verified column, if the gate does not open, or if bad input is
-- accepted.
DO $$
DECLARE
  fn_sig   TEXT;
  fn_oid   OID;
  fn       RECORD;
  v_raised BOOLEAN;
  v_arg    INTEGER;
BEGIN
  FOREACH fn_sig IN ARRAY ARRAY[
    'public.admin_analytics_onboarding_cohorts(integer)',
    'public.admin_analytics_onboarding_stalled(integer)',
    'public.admin_analytics_signups(timestamptz, text)',
    'public.admin_analytics_totals()'
  ] LOOP
    fn_oid := to_regprocedure(fn_sig)::OID;
    IF fn_oid IS NULL THEN
      RAISE EXCEPTION 'migration 113: % missing', fn_sig;
    END IF;

    SELECT owner.rolname AS owner_name, p.prosecdef, p.proconfig INTO fn
      FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
     WHERE p.oid = fn_oid;
    IF fn.owner_name IS DISTINCT FROM 'jale_admin' OR NOT fn.prosecdef
       OR NOT COALESCE(fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false) THEN
      RAISE EXCEPTION 'migration 113: % owner/secdef/search_path wrong', fn_sig;
    END IF;
    IF NOT has_function_privilege('jale_admin_console', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 113: % not executable by console', fn_sig;
    END IF;
    -- Exactly the owner and the console may execute (PUBLIC is grantee 0).
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
         AND a.grantee NOT IN (p.proowner, 'jale_admin_console'::regrole::oid)
    ) THEN
      RAISE EXCEPTION 'migration 113: % executable by a role other than its owner and the console', fn_sig;
    END IF;
  END LOOP;

  -- Exact result shapes: a recreated function that lost an old column fails too.
  IF pg_get_function_result(to_regprocedure('public.admin_analytics_signups(timestamptz, text)'))
       IS DISTINCT FROM 'TABLE(bucket_start timestamp with time zone, worker_signups bigint, employer_signups bigint, worker_signups_verified bigint)' THEN
    RAISE EXCEPTION 'migration 113: admin_analytics_signups result drifted';
  END IF;
  IF pg_get_function_result(to_regprocedure('public.admin_analytics_totals()'))
       IS DISTINCT FROM 'TABLE(total_workers bigint, total_employers bigint, paying_employers bigint, jobs_active bigint, jobs_paused bigint, jobs_filled bigint, jobs_closed bigint, hires_total bigint, jobs_with_hire bigint, total_verified_workers bigint)' THEN
    RAISE EXCEPTION 'migration 113: admin_analytics_totals result drifted';
  END IF;

  -- 098's pattern: clear the gate before EACH call and read it back.
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_onboarding_cohorts(4);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 113: admin_analytics_onboarding_cohorts did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_onboarding_stalled(7);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 113: admin_analytics_onboarding_stalled did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_signups(now(), 'day');
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 113: admin_analytics_signups did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_totals();
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 113: admin_analytics_totals did not set the read flag';
  END IF;

  FOREACH v_arg IN ARRAY ARRAY[0, 27] LOOP
    BEGIN
      PERFORM * FROM public.admin_analytics_onboarding_cohorts(v_arg);
      v_raised := false;
    EXCEPTION WHEN raise_exception THEN
      v_raised := SQLERRM = 'admin_analytics_invalid_weeks';
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'migration 113: admin_analytics_onboarding_cohorts(%) did not reject the window', v_arg;
    END IF;
  END LOOP;
  FOREACH v_arg IN ARRAY ARRAY[0, 91] LOOP
    BEGIN
      PERFORM * FROM public.admin_analytics_onboarding_stalled(v_arg);
      v_raised := false;
    EXCEPTION WHEN raise_exception THEN
      v_raised := SQLERRM = 'admin_analytics_invalid_days';
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'migration 113: admin_analytics_onboarding_stalled(%) did not reject the window', v_arg;
    END IF;
  END LOOP;
END $$;

COMMIT;
