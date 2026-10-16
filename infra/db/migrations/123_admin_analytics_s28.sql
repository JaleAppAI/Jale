-- ============================================================
-- 123_admin_analytics_s28.sql
-- Run manually AFTER 122_admin_inbox.sql,
-- connected as jale_admin. Forward-only (ADR-005).
-- It reads 122's identity_lockout_resets and nothing created after it; the
-- runner applies it after 122 and before 124.
--
-- Sprint 28, the analytics read side. All math happens here, so no account,
-- case, challenge, job or message reaches the console -- only counts,
-- shares' parts, medians, week starts, reason codes and the dates listed:
-- (1) admin_analytics_paying_weekly(p_weeks): per week (Monday 00:00 UTC),
--     employers that existed by the week's end, how many paid at its end,
--     how many started and stopped paying during it, and the first
--     non-backfill status change (before it the history is only 100's
--     backfill: "approximate before").
-- (2) admin_analytics_reset_reasons(p_days): lockout resets of the last
--     p_days by reason code (every code, zeros included, in the reset
--     form's order), then operator resets as one row (reason_code NULL).
-- (3) admin_analytics_case_aging(): open cases by time in their current
--     status, waiting on us or on the worker.
-- (4) admin_analytics_case_resolution(p_weeks): per week, cases resolved,
--     with the median and p75 hours from opening.
-- (5) admin_analytics_onboarding_steps(p_weeks, p_door): for 113's cohort
--     of the window (one door or both), each onboarding step and how many of
--     the cohort ever arrived at it.
-- (6) admin_analytics_identity_funnel(p_weeks): WhatsApp identity
--     challenges started in the window: reached the code, verified, locked
--     at least once, expired unused, wrong codes per challenge (0, 1, 2,
--     3+), and the median and p75 minutes to verify.
-- (7) admin_analytics_ranking_freshness(): how old each active job's
--     candidate ranking is, how many rankings are the fallback, and how many
--     active jobs have applications but no ranking.
-- (8) admin_analytics_billing_inbox_now() gains failed_last_24h (sprint 28
--     CR-3). CREATE OR REPLACE cannot change a return type, so it is dropped,
--     recreated with the same body plus that column, and re-granted. The
--     deployed console reads its columns by name, so applying this before the
--     deploy is safe.
-- (9) admin_analytics_home_metrics(): hires and jobs with a hire in the last
--     30 days, and the number of stale jobs at 14 days.
-- (10) admin_analytics_system_health(): WhatsApp sends of the last 24 hours
--     that gave up or failed on delivery, and voice notes of the last 7 days
--     finished and usable.
--
-- WEEKS: Monday 00:00 UTC; the window is the current (partial) week and the
-- p_weeks - 1 before it, computed on UTC wall-clock time as in 113-117. The
-- weekly functions return every week of the window, zero-filled, oldest
-- first, with partial = true on the current week only; no whole-window row.
--
-- TEST ACCOUNTS (114/117's rule: an account whose email ends @jale.test or
-- whose cognito_sub starts seed-), used in WHERE only:
--   (1) employers that are test accounts count nowhere;
--   (2) a lockout reset of a challenge whose candidate or verified account is
--       a test account, and an operator reset of a test account, are left
--       out;
--   (3), (4) cases whose worker or employer is a test account are left out;
--   (5) cohort members whose account is a test account are left out (an
--       unlinked WhatsApp number cannot be told apart and stays);
--   (6) challenges whose candidate or verified account is a test account
--       are left out;
--   (7), (9) jobs of test employers are left out;
--   (8), (10) no account rule: an outbox row or a Stripe event names a
--       number or an event, not an account, as in 115; voice notes keep
--       115's ai_test_profile rule.
--
-- DEFINITIONS.
-- PAYING: an employer pays at an instant when the latest status change of
-- one of its subscriptions before that instant is to active, trialing or
-- past_due (admin_analytics_totals' set), counted once per employer. A
-- week's end is the next Monday, or now for the current week. Started
-- paying = paying at the week's end and not at its start; stopped = the
-- reverse; so paying(week) = paying(week before) + started - stopped.
-- RESETS: lockout resets are identity_lockout_resets rows (122); operator
-- resets are worker_reset_audit rows with dry_run = false. Never a note,
-- an operator, a phone hash or an account.
-- CASE AGE: now - status_changed_at (117) of every case not resolved or
-- dismissed; pending_worker waits on the worker, open and pending_admin on
-- us. Buckets: under 1 h, 1-4 h, 4-24 h, 1-3 days, over 3 days.
-- RESOLUTION: a move to resolved on the case timeline (117's status_changed
-- event, payload to = resolved), at the event's time; a case reopened and
-- resolved again counts each time. A case resolved before the timeline
-- recorded moves (no such event) counts once at resolved_at. A case created
-- already resolved (resolved_at <= created_at: 122's lockout reset record)
-- has no wait and is left out; dismissals are not resolutions. Hours run
-- from the case's created_at.
-- STEPS: the cohort is 113's (copied, not changed): people who first
-- contacted Jale in the window by door, without reset or bypass accounts.
-- A cohort member reached a step when any of their runs moved to it (a
-- worker_workflow_transitions row with that to_step_key, at any time) or
-- stands on it. The two pre-sign-in steps are WhatsApp's: every WhatsApp
-- starter reached the language step, and the code step counts 113's
-- "requested a code"; a web starter passed both on the web, so door 'all'
-- counts them there and door 'web' returns no rows for them. Branch steps
-- (only some workers see them): profile.voice_processing (sent a voice
-- note) and profile.custom_trade (picked "other" trade).
-- IDENTITY: a wrong code is a rise of the challenge's attempt counter in its
-- history (101), plus each move into locked (the code that locks is not
-- counted by the counter); the counter restarts at 0 on a resend, so the
-- history, not the current row, gives the total. Reached the code: at the
-- code step, verified, locked or any wrong code. Expired unused: reached the
-- code, never verified or locked, and the code expired (status expired, or
-- pending past expires_at). The wrong-code buckets split the challenges that
-- reached the code. Minutes to verify run from a challenge's first history
-- row to its first move to verified, only for challenges with no backfill
-- row; timings_since is the first non-backfill history row.
-- RANKINGS: per active job, its newest computed_at; a job is on the
-- fallback when any of its rows has ranking_version sql-v1 (status 'failed'
-- is never written). Buckets: under 1 h, 1-6 h, 6-24 h, 1-3 days, over 3
-- days (the ranking cache lives 24 hours).
-- HIRES: job_applications.hired_at in the last 30 days (095's approximate
-- hires included, as in 114). STALE: admin_analytics_stale_jobs(14)'s rows,
-- counted.
-- FAILED SENDS: 115's classification, on messages created in the last 24
-- hours: gave up (unsent and no longer retried) or failed on delivery.
-- VOICE: finished = completed or failed; usable = 115's usable.
--
-- ACCESS (roadmap rules, 089's pattern): every read function is a definer
-- owned by jale_admin with a pinned search path, executable by the admin
-- console role only, and opens app.admin_analytics_read after validating its
-- input. Tables are read through their existing jale_admin policies (the
-- preconditions pin each one); whatsapp_outbox is ENABLE, not FORCE, row
-- level security, so its owner reads it (115). identity_lockout_resets and
-- employer_candidate_rankings are FORCE RLS with no policy a definer
-- satisfies, so a definer read them as zero rows (the 088 defect): this
-- migration adds 089's gated read policy to each. No table grant, no index.
--
-- PLANS: users carries policies whose row estimates are useless (114), so
-- every lookup of an account is a LATERAL index probe or an EXISTS on
-- users_pkey; the paying history is read per subscription through
-- subscription_status_history_subscription_idx. The outbox and extraction
-- scans are 115's.
--
-- DEPLOY ORDER: apply BEFORE deploying the admin console build that calls
-- these functions (Home, /analytics, /analytics/funnels,
-- /analytics/employers, /analytics/ops).
--
-- LOCKS: each of the two policy statements takes ACCESS EXCLUSIVE on its
-- table (identity_lockout_resets, employer_candidate_rankings) and holds
-- it until COMMIT; while it is held, every read and write of that table
-- waits. So the policies come after every function, grant and check that
-- does not need them: from the first policy to COMMIT run only the policy
-- check, one call each of reset_reasons and ranking_freshness, and the
-- bounds checks, which raise before reading any table. The smoke calls
-- take ACCESS SHARE on the other tables read here, also held until
-- COMMIT; that blocks only DDL on them. lock_timeout bounds every lock
-- wait: a request not granted within 5 seconds fails the apply, which
-- writes no ledger row and can be rerun.
-- ============================================================
BEGIN;

-- Fail fast instead of queueing reads and writes of the two policy tables
-- behind a stuck transaction; a timed-out apply writes no ledger row and can
-- simply be rerun.
SET LOCAL lock_timeout = '5s';

-- Preconditions: pg_policy and pg_class are catalogs, so row security never
-- filters these checks; a missing policy would otherwise make a figure
-- silently zero (the 088 defect).
DO $$
DECLARE
  v_gate CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;
  pol RECORD;
BEGIN
  IF to_regclass('public.identity_lockout_resets') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = 'public.admin_cases'::regclass AND a.attname = 'case_number' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'migration 123: apply 122 first (identity_lockout_resets or admin_cases.case_number is missing)';
  END IF;

  FOR pol IN
    SELECT * FROM (VALUES
      ('public.users', 'users_admin_analytics_read', 'r', v_gate),
      ('public.jobs', 'jobs_admin_analytics_read', 'r', v_gate),
      ('public.job_applications', 'job_applications_admin_analytics_read', 'r', v_gate),
      ('public.subscription_status_history', 'subscription_status_history_admin_analytics_read', 'r', v_gate),
      ('public.worker_identity_challenge_events', 'worker_identity_challenge_events_admin_analytics_read', 'r', v_gate),
      ('public.whatsapp_conversations', 'whatsapp_conversations_admin_analytics_read', 'r', v_gate),
      ('public.billing_webhook_events', 'billing_webhook_events_admin_analytics_read', 'r', v_gate),
      ('public.job_message_outbox', 'job_message_outbox_admin_analytics_read', 'r', v_gate),
      ('public.worker_profile_ai_extractions', 'worker_profile_ai_extractions_admin_analytics_read', 'r', v_gate),
      ('public.worker_identity_challenges', 'worker_identity_challenges_definer', '*', 'true'),
      ('public.worker_onboarding_state', 'worker_onboarding_state_definer', '*', 'true'),
      ('public.worker_workflow_runs', 'worker_workflow_runs_definer', '*', 'true'),
      ('public.worker_workflow_transitions', 'worker_workflow_transitions_definer', '*', 'true'),
      ('public.worker_reset_audit', 'worker_reset_audit_admin_read', 'r', 'true'),
      ('public.admin_cases', 'admin_cases_service_all', '*', 'true'),
      ('public.admin_case_events', 'admin_case_events_service_all', '*', 'true')
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
      RAISE EXCEPTION 'migration 123: policy % on % missing or drifted; a figure would read zero rows', pol.name, pol.rel;
    END IF;
  END LOOP;

  -- whatsapp_outbox is read as its owner (ENABLE, not FORCE, row security).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid = 'public.whatsapp_outbox'::regclass
       AND c.relowner = 'jale_admin'::regrole
       AND NOT c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'migration 123: whatsapp_outbox is forced or not owned by jale_admin; failed sends would read zero rows';
  END IF;

  -- A RESTRICTIVE SELECT (or ALL) policy is AND'ed with every policy above,
  -- so one that applies to jale_admin on any table read here could hide rows
  -- just as silently: one for jale_admin, for PUBLIC (role 0), or for any
  -- role whose privileges jale_admin has.
  IF EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid IN ('public.users'::regclass, 'public.jobs'::regclass, 'public.job_applications'::regclass,
                          'public.subscription_status_history'::regclass,
                          'public.worker_identity_challenge_events'::regclass,
                          'public.worker_identity_challenges'::regclass, 'public.worker_onboarding_state'::regclass,
                          'public.worker_workflow_runs'::regclass, 'public.worker_workflow_transitions'::regclass,
                          'public.worker_reset_audit'::regclass, 'public.whatsapp_conversations'::regclass,
                          'public.admin_cases'::regclass, 'public.admin_case_events'::regclass,
                          'public.billing_webhook_events'::regclass, 'public.job_message_outbox'::regclass,
                          'public.worker_profile_ai_extractions'::regclass, 'public.whatsapp_outbox'::regclass,
                          'public.identity_lockout_resets'::regclass, 'public.employer_candidate_rankings'::regclass)
       AND p.polcmd IN ('r', '*')
       AND NOT p.polpermissive
       AND ('jale_admin'::regrole::oid = ANY (p.polroles) OR 0::OID = ANY (p.polroles)
            OR EXISTS (SELECT 1 FROM unnest(p.polroles) AS r(role_oid)
                        WHERE r.role_oid <> 0 AND pg_has_role('jale_admin', r.role_oid, 'USAGE')))
  ) THEN
    RAISE EXCEPTION 'migration 123: a restrictive policy for jale_admin, a role it inherits, or PUBLIC on a table 123 reads; it would hide rows';
  END IF;
END $$;

-- ── (1) Paying employers by week ────────────────────────────
CREATE FUNCTION public.admin_analytics_paying_weekly(p_weeks INTEGER)
RETURNS TABLE (
  week_start         TIMESTAMPTZ,
  partial            BOOLEAN,
  employers          BIGINT,
  paying             BIGINT,
  new_paying         BIGINT,
  churned            BIGINT,
  approximate_before TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_week0  TIMESTAMPTZ;
  v_approx TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  -- Week arithmetic on UTC wall-clock time, so the session TimeZone (and its
  -- daylight-saving shifts) can never move a week edge.
  v_week0 := date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  SELECT min(h.changed_at) INTO v_approx
    FROM public.subscription_status_history h
   WHERE NOT h.is_backfill;

  RETURN QUERY
  WITH weeks AS (
    SELECT t.wk_utc AT TIME ZONE 'UTC' AS wk,
           least((t.wk_utc + interval '7 days') AT TIME ZONE 'UTC', now()) AS wk_end
      FROM (SELECT date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n) AS wk_utc
              FROM generate_series(0, p_weeks - 1) AS g(n)) t
  ), subs AS (
    SELECT DISTINCT h.subscription_id, h.user_id
      FROM public.subscription_status_history h
  ), owners AS (
    -- Subscriptions of employers that still exist and are not test accounts.
    SELECT s.subscription_id, s.user_id
      FROM subs s
      CROSS JOIN LATERAL (
        SELECT 1
          FROM public.users u
         WHERE u.id = s.user_id
           AND u.user_type = 'employer'
           AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
         LIMIT 1
      ) e
  ), edges AS (
    -- Each subscription's latest status before the week starts and before
    -- it ends, by an index probe.
    SELECT w.wk,
           o.user_id,
           COALESCE(st.to_status IN ('active', 'trialing', 'past_due'), false) AS paying_start,
           COALESCE(en.to_status IN ('active', 'trialing', 'past_due'), false) AS paying_end
      FROM weeks w
      CROSS JOIN owners o
      LEFT JOIN LATERAL (
        SELECT h.to_status
          FROM public.subscription_status_history h
         WHERE h.subscription_id = o.subscription_id
           AND h.changed_at < w.wk
         ORDER BY h.changed_at DESC, h.id DESC
         LIMIT 1
      ) st ON true
      LEFT JOIN LATERAL (
        SELECT h.to_status
          FROM public.subscription_status_history h
         WHERE h.subscription_id = o.subscription_id
           AND h.changed_at < w.wk_end
         ORDER BY h.changed_at DESC, h.id DESC
         LIMIT 1
      ) en ON true
  ), per_employer AS (
    SELECT e.wk, e.user_id, bool_or(e.paying_start) AS at_start, bool_or(e.paying_end) AS at_end
      FROM edges e
     GROUP BY e.wk, e.user_id
  ), agg AS (
    SELECT p.wk,
           count(*) FILTER (WHERE p.at_end) AS n_paying,
           count(*) FILTER (WHERE p.at_end AND NOT p.at_start) AS n_new,
           count(*) FILTER (WHERE p.at_start AND NOT p.at_end) AS n_churned
      FROM per_employer p
     GROUP BY p.wk
  ), emp AS (
    SELECT w.wk, count(x.created_at) AS n_employers
      FROM weeks w
      LEFT JOIN (
        SELECT u.created_at
          FROM public.users u
         WHERE u.user_type = 'employer'
           AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
      ) x ON x.created_at < w.wk_end
     GROUP BY w.wk
  )
  SELECT w.wk,
         w.wk = v_week0,
         COALESCE(m.n_employers, 0),
         COALESCE(a.n_paying, 0),
         COALESCE(a.n_new, 0),
         COALESCE(a.n_churned, 0),
         v_approx
    FROM weeks w
    LEFT JOIN emp m ON m.wk = w.wk
    LEFT JOIN agg a ON a.wk = w.wk
   ORDER BY w.wk;
END $$;

-- ── (2) Resets by reason ────────────────────────────────────
CREATE FUNCTION public.admin_analytics_reset_reasons(p_days INTEGER)
RETURNS TABLE (
  source      TEXT,
  reason_code TEXT,
  resets      BIGINT
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

  RETURN QUERY
  WITH codes (code, ord) AS (
    VALUES ('codes_not_arriving', 1), ('worker_confused', 2), ('typo_in_details', 3),
           ('identity_confirmed_elsewhere', 4), ('other', 5)
  ), lockouts AS (
    SELECT r.reason_code AS code, count(*) AS n
      FROM public.identity_lockout_resets r
      LEFT JOIN public.worker_identity_challenges c ON c.id = r.challenge_id
     WHERE r.created_at > now() - make_interval(days => p_days)
       AND NOT EXISTS (
         SELECT 1
           FROM public.users u
          WHERE u.id IN (c.candidate_user_id, c.verified_user_id)
            AND COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
       )
     GROUP BY r.reason_code
  ), operators AS (
    SELECT count(*) AS n
      FROM public.worker_reset_audit a
     WHERE NOT a.dry_run
       AND a.created_at > now() - make_interval(days => p_days)
       AND NOT EXISTS (
         SELECT 1
           FROM public.users u
          WHERE u.id = a.user_id
            AND COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
       )
  ), rows_out AS (
    SELECT 'lockout_reset'::TEXT AS src, k.code, COALESCE(l.n, 0) AS n, k.ord
      FROM codes k
      LEFT JOIN lockouts l ON l.code = k.code
    UNION ALL
    SELECT 'operator_reset'::TEXT, NULL::TEXT, o.n, 6
      FROM operators o
  )
  SELECT x.src, x.code, x.n
    FROM rows_out x
   ORDER BY x.ord;
END $$;

-- ── (3) Open cases by age ───────────────────────────────────
CREATE FUNCTION public.admin_analytics_case_aging()
RETURNS TABLE (
  bucket            TEXT,
  waiting_on_us     BIGINT,
  waiting_on_worker BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  -- No arguments to validate.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  WITH buckets (id, ord, lo, hi) AS (
    VALUES ('under_1h', 1, NULL::INTERVAL, interval '1 hour'),
           ('1_4h', 2, interval '1 hour', interval '4 hours'),
           ('4_24h', 3, interval '4 hours', interval '24 hours'),
           ('1_3d', 4, interval '24 hours', interval '72 hours'),
           ('over_3d', 5, interval '72 hours', NULL::INTERVAL)
  ), open_cases AS (
    SELECT now() - c.status_changed_at AS age,
           c.status = 'pending_worker' AS on_worker
      FROM public.admin_cases c
     WHERE c.status NOT IN ('resolved', 'dismissed')
       AND NOT EXISTS (
         SELECT 1
           FROM public.users u
          WHERE u.id IN (c.user_id, c.employer_id)
            AND COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
       )
  )
  SELECT b.id,
         count(o.age) FILTER (WHERE NOT o.on_worker),
         count(o.age) FILTER (WHERE o.on_worker)
    FROM buckets b
    LEFT JOIN open_cases o
      ON (b.lo IS NULL OR o.age >= b.lo) AND (b.hi IS NULL OR o.age < b.hi)
   GROUP BY b.id, b.ord
   ORDER BY b.ord;
END $$;

-- ── (4) Resolutions by week ─────────────────────────────────
CREATE FUNCTION public.admin_analytics_case_resolution(p_weeks INTEGER)
RETURNS TABLE (
  week_start   TIMESTAMPTZ,
  partial      BOOLEAN,
  resolved     BIGINT,
  median_hours NUMERIC,
  p75_hours    NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_week0 TIMESTAMPTZ;
  v_from  TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  v_week0 := date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH weeks AS (
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n)) AT TIME ZONE 'UTC' AS wk
      FROM generate_series(0, p_weeks - 1) AS g(n)
  ), kept AS (
    SELECT c.id, c.status, c.created_at, c.resolved_at
      FROM public.admin_cases c
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.users u
        WHERE u.id IN (c.user_id, c.employer_id)
          AND COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
     )
  ), facts AS (
    -- Every move to resolved on the case timeline.
    SELECT e.created_at AS at, k.created_at AS opened
      FROM public.admin_case_events e
      JOIN kept k ON k.id = e.case_id
     WHERE e.event_type = 'status_changed'
       AND e.payload ->> 'to' = 'resolved'
       AND e.created_at >= v_from
    UNION ALL
    -- Resolved before the timeline recorded moves: once, at resolved_at.
    -- A case created already resolved has no wait.
    SELECT k.resolved_at, k.created_at
      FROM kept k
     WHERE k.status = 'resolved'
       AND k.resolved_at >= v_from
       AND k.resolved_at > k.created_at
       AND NOT EXISTS (
         SELECT 1
           FROM public.admin_case_events e
          WHERE e.case_id = k.id
            AND e.event_type = 'status_changed'
            AND e.payload ->> 'to' = 'resolved'
       )
  ), agg AS (
    SELECT date_trunc('week', f.at, 'UTC') AS wk,
           count(*) AS n,
           round(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY extract(epoch FROM f.at - f.opened)::DOUBLE PRECISION / 3600)::NUMERIC, 1) AS p50,
           round(percentile_cont(0.75) WITHIN GROUP (
             ORDER BY extract(epoch FROM f.at - f.opened)::DOUBLE PRECISION / 3600)::NUMERIC, 1) AS p75
      FROM facts f
     GROUP BY 1
  )
  SELECT w.wk,
         w.wk = v_week0,
         COALESCE(a.n, 0),
         a.p50,
         a.p75
    FROM weeks w
    LEFT JOIN agg a ON a.wk = w.wk
   ORDER BY w.wk;
END $$;

-- ── (5) Onboarding step by step ─────────────────────────────
CREATE FUNCTION public.admin_analytics_onboarding_steps(p_weeks INTEGER, p_door TEXT)
RETURNS TABLE (
  step_key   TEXT,
  step_order INTEGER,
  branch     BOOLEAN,
  reached    BIGINT,
  started    BIGINT
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
  IF p_door IS NULL OR p_door NOT IN ('all', 'whatsapp', 'web') THEN
    RAISE EXCEPTION 'admin_analytics_invalid_door';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  -- 113's window: nothing before the first v2 verification ('infinity'
  -- when there is none, so the query still plans and returns zeros).
  SELECT min(t.created_at) INTO v_launch
    FROM public.worker_workflow_transitions t
   WHERE t.reason IN ('otp_verified', 'web_start');

  v_launch_week := COALESCE(date_trunc('week', v_launch, 'UTC'), 'infinity'::TIMESTAMPTZ);
  v_from := greatest(
    (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC',
    v_launch_week);

  RETURN QUERY
  WITH steps (key, ord, is_branch, pre_auth) AS (
    VALUES ('start.choose_language', 1, false, true), ('identity.verify_otp', 2, false, true),
           ('legal.review', 3, false, false), ('profile.voice_choice', 4, false, false),
           ('profile.voice_processing', 5, true, false), ('profile.name', 6, false, false),
           ('profile.location', 7, false, false), ('profile.trade', 8, false, false),
           ('profile.custom_trade', 9, true, false), ('profile.experience', 10, false, false),
           ('profile.transportation', 11, false, false), ('profile.availability', 12, false, false),
           ('trust.question.1', 13, false, false), ('trust.question.2', 14, false, false),
           ('trust.question.3', 15, false, false), ('profile.photo', 16, false, false),
           ('profile.photo_type', 17, false, false)
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
    -- 113's conversation owner and start, unchanged.
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
    -- 113's people, unchanged.
    SELECT c.user_id, c.phone_hash, c.started_at AS started_at, 'whatsapp'::TEXT AS d
      FROM conv c
      LEFT JOIN public.users u ON u.id = c.user_id
     WHERE c.started_at >= v_from
       AND (u.id IS NULL OR u.user_type = 'worker')
       AND NOT COALESCE(c.user_id IS NOT NULL AND u.created_at < c.started_at, false)
    UNION ALL
    SELECT u.id, lc.phone_hash, u.created_at, 'web'::TEXT
      FROM public.users u
      LEFT JOIN LATERAL (
        SELECT c.phone_hash
          FROM conv c
         WHERE c.user_id = u.id
         ORDER BY c.updated_at DESC
         LIMIT 1
      ) lc ON true
     WHERE u.user_type = 'worker'
       AND u.created_at >= v_from
       AND NOT EXISTS (SELECT 1 FROM conv c WHERE c.user_id = u.id AND c.started_at <= u.created_at)
  ), cohort AS (
    -- 113's exclusions, then test accounts; then the door.
    SELECT row_number() OVER () AS pid, p.user_id, p.phone_hash, p.d
      FROM people p
     WHERE (p.user_id IS NULL OR p.user_id NOT IN (SELECT ru.user_id FROM reset_users ru))
       AND (p.phone_hash IS NULL OR p.phone_hash NOT IN (SELECT rp.phone_hash FROM reset_phones rp))
       AND (p.user_id IS NULL OR p.user_id NOT IN (SELECT bu.user_id FROM bypass_users bu))
       AND NOT EXISTS (
         SELECT 1
           FROM public.users u
          WHERE u.id = p.user_id
            AND COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
       )
       AND (p_door = 'all' OR p.d = p_door)
  ), challenge_facts AS (
    SELECT ch.phone_hash,
           bool_or(ch.current_step_key = 'identity.verify_otp' OR ch.status = 'verified') AS reached_code
      FROM public.worker_identity_challenges ch
     WHERE ch.phone_hash IN (SELECT c.phone_hash FROM cohort c)
     GROUP BY ch.phone_hash
  ), facts AS (
    -- The language step: every starter (a web starter chose it on the web).
    SELECT c.pid, 'start.choose_language'::TEXT AS step
      FROM cohort c
    UNION
    -- The code step: 113's "requested a code".
    SELECT c.pid, 'identity.verify_otp'::TEXT
      FROM cohort c
      LEFT JOIN challenge_facts cf ON cf.phone_hash = c.phone_hash
     WHERE c.d = 'web'
        OR COALESCE(cf.reached_code, false)
        OR EXISTS (SELECT 1 FROM public.worker_workflow_runs r WHERE r.user_id = c.user_id)
        OR EXISTS (SELECT 1 FROM public.worker_onboarding_state s WHERE s.user_id = c.user_id AND s.ready_at IS NOT NULL)
    UNION
    -- Every later step: a move to it, at any time, in any of the member's runs.
    SELECT c.pid, t.to_step_key
      FROM cohort c
      JOIN public.worker_workflow_runs r ON r.user_id = c.user_id
      JOIN public.worker_workflow_transitions t ON t.run_id = r.id
    UNION
    -- Or a run standing on it.
    SELECT c.pid, r.current_step_key
      FROM cohort c
      JOIN public.worker_workflow_runs r ON r.user_id = c.user_id
  )
  SELECT s.key,
         s.ord,
         s.is_branch,
         count(DISTINCT f.pid),
         (SELECT count(*) FROM cohort)
    FROM steps s
    LEFT JOIN facts f ON f.step = s.key
   -- The web door has no pre-sign-in steps.
   WHERE p_door <> 'web' OR NOT s.pre_auth
   GROUP BY s.key, s.ord, s.is_branch
   ORDER BY s.ord;
END $$;

-- ── (6) Identity verification funnel ────────────────────────
CREATE FUNCTION public.admin_analytics_identity_funnel(p_weeks INTEGER)
RETURNS TABLE (
  challenges               BIGINT,
  reached_code             BIGINT,
  verified                 BIGINT,
  locked_once              BIGINT,
  expired_unused           BIGINT,
  attempts_zero            BIGINT,
  attempts_one             BIGINT,
  attempts_two             BIGINT,
  attempts_three_plus      BIGINT,
  median_minutes_to_verify NUMERIC,
  p75_minutes_to_verify    NUMERIC,
  timings_since            TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_from  TIMESTAMPTZ;
  v_since TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  SELECT min(e.changed_at) INTO v_since
    FROM public.worker_identity_challenge_events e
   WHERE NOT e.is_backfill;

  RETURN QUERY
  WITH ch AS (
    SELECT c.id, c.current_step_key, c.status, c.attempts, c.expires_at
      FROM public.worker_identity_challenges c
     WHERE c.created_at >= v_from
       AND NOT EXISTS (
         SELECT 1
           FROM public.users u
          WHERE u.id IN (c.candidate_user_id, c.verified_user_id)
            AND COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
       )
  ), ev AS (
    -- Each challenge's history in order; a rise of the counter is a wrong code.
    SELECT e.challenge_id, e.from_status, e.to_status, e.changed_at, e.is_backfill,
           greatest(e.attempts - lag(e.attempts, 1, 0) OVER (PARTITION BY e.challenge_id ORDER BY e.changed_at, e.id), 0) AS rise
      FROM public.worker_identity_challenge_events e
     WHERE e.challenge_id IN (SELECT ch.id FROM ch)
  ), ev_facts AS (
    SELECT v.challenge_id,
           sum(v.rise) + count(*) FILTER (WHERE v.to_status = 'locked' AND v.from_status IS DISTINCT FROM 'locked') AS wrong,
           bool_or(v.to_status = 'verified') AS ev_verified,
           bool_or(v.to_status = 'locked') AS ev_locked,
           bool_or(v.is_backfill) AS any_backfill,
           min(v.changed_at) AS first_at,
           min(v.changed_at) FILTER (WHERE v.to_status = 'verified') AS verified_at
      FROM ev v
     GROUP BY v.challenge_id
  ), facts AS (
    -- A challenge with no history (none should exist after 101) falls back
    -- to its current row.
    SELECT c.status,
           c.expires_at,
           c.current_step_key,
           COALESCE(f.wrong, c.attempts + CASE WHEN c.status = 'locked' THEN 1 ELSE 0 END) AS wrong,
           (c.status = 'verified' OR COALESCE(f.ev_verified, false)) AS is_verified,
           (c.status = 'locked' OR COALESCE(f.ev_locked, false)) AS is_locked,
           CASE WHEN NOT COALESCE(f.any_backfill, true) AND f.verified_at IS NOT NULL
                THEN extract(epoch FROM f.verified_at - f.first_at)::DOUBLE PRECISION / 60
           END AS minutes
      FROM ch c
      LEFT JOIN ev_facts f ON f.challenge_id = c.id
  ), shaped AS (
    SELECT x.*,
           (x.current_step_key = 'identity.verify_otp' OR x.is_verified OR x.is_locked OR x.wrong > 0) AS is_code
      FROM facts x
  )
  SELECT count(*),
         count(*) FILTER (WHERE s.is_code),
         count(*) FILTER (WHERE s.is_verified),
         count(*) FILTER (WHERE s.is_locked),
         count(*) FILTER (WHERE s.is_code AND NOT s.is_verified AND NOT s.is_locked
                            AND (s.status = 'expired' OR (s.status = 'pending' AND s.expires_at <= now()))),
         count(*) FILTER (WHERE s.is_code AND s.wrong = 0),
         count(*) FILTER (WHERE s.is_code AND s.wrong = 1),
         count(*) FILTER (WHERE s.is_code AND s.wrong = 2),
         count(*) FILTER (WHERE s.is_code AND s.wrong >= 3),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.minutes)::NUMERIC, 1),
         round(percentile_cont(0.75) WITHIN GROUP (ORDER BY s.minutes)::NUMERIC, 1),
         v_since
    FROM shaped s;
END $$;

-- ── (7) Candidate ranking freshness ─────────────────────────
CREATE FUNCTION public.admin_analytics_ranking_freshness()
RETURNS TABLE (
  under_1h                          BIGINT,
  from_1h_to_6h                     BIGINT,
  from_6h_to_24h                    BIGINT,
  from_1d_to_3d                     BIGINT,
  over_3d                           BIGINT,
  ranked_jobs                       BIGINT,
  fallback_jobs                     BIGINT,
  jobs_with_applications_no_ranking BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  -- No arguments to validate.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  -- An aggregate with no GROUP BY: exactly one row, zeros when empty.
  RETURN QUERY
  WITH live AS (
    -- Active jobs of employers that are not test accounts.
    SELECT j.id
      FROM public.jobs j
      CROSS JOIN LATERAL (
        SELECT 1
          FROM public.users u
         WHERE u.id = j.employer_id
           AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
         LIMIT 1
      ) e
     WHERE j.status = 'active'
  ), ranked AS (
    SELECT r.job_id,
           max(r.computed_at) AS last_at,
           bool_or(r.ranking_version = 'sql-v1') AS on_fallback
      FROM public.employer_candidate_rankings r
     WHERE r.job_id IN (SELECT l.id FROM live l)
     GROUP BY r.job_id
  ), waiting AS (
    SELECT count(*) AS n
      FROM live l
     WHERE NOT EXISTS (SELECT 1 FROM ranked k WHERE k.job_id = l.id)
       AND EXISTS (SELECT 1 FROM public.job_applications a WHERE a.job_id = l.id)
  )
  SELECT count(*) FILTER (WHERE now() - k.last_at < interval '1 hour'),
         count(*) FILTER (WHERE now() - k.last_at >= interval '1 hour' AND now() - k.last_at < interval '6 hours'),
         count(*) FILTER (WHERE now() - k.last_at >= interval '6 hours' AND now() - k.last_at < interval '24 hours'),
         count(*) FILTER (WHERE now() - k.last_at >= interval '24 hours' AND now() - k.last_at < interval '72 hours'),
         count(*) FILTER (WHERE now() - k.last_at >= interval '72 hours'),
         count(*),
         count(*) FILTER (WHERE k.on_fallback),
         (SELECT w.n FROM waiting w)
    FROM ranked k;
END $$;

-- ── (8) Billing inbox right now gains the last 24 hours ─────
DROP FUNCTION public.admin_analytics_billing_inbox_now();

CREATE FUNCTION public.admin_analytics_billing_inbox_now()
RETURNS TABLE (
  stuck_received   BIGINT,
  failed_now       BIGINT,
  failed_last_24h  BIGINT,
  unresolved_older BIGINT,
  oldest_stuck_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  -- No arguments to validate.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  -- 115's body, plus failed_last_24h: failed events received in the last
  -- 24 hours, counted the same way as failed_now.
  RETURN QUERY
  SELECT count(*) FILTER (WHERE b.processing_status = 'received'
                            AND b.received_at > now() - interval '1 hour'),
         count(*) FILTER (WHERE b.processing_status = 'failed'
                            AND b.received_at > now() - interval '1 hour'),
         count(*) FILTER (WHERE b.processing_status = 'failed'
                            AND b.received_at > now() - interval '24 hours'),
         count(*) FILTER (WHERE b.received_at <= now() - interval '1 hour'
                            AND b.received_at > now() - interval '14 days'),
         min(b.received_at) FILTER (WHERE b.received_at > now() - interval '1 hour')
    FROM public.billing_webhook_events b
   -- Stuck: received with no live claim -- the processor's own re-claim
   -- predicate (an expired or missing lease). A failed row waits for the
   -- same re-claim, which stops at the dead-letter queue.
   WHERE (b.processing_status = 'received'
          AND (b.lease_expires_at IS NULL OR b.lease_expires_at < now()))
      OR b.processing_status = 'failed';
END $$;

-- ── (9) Home metrics ────────────────────────────────────────
CREATE FUNCTION public.admin_analytics_home_metrics()
RETURNS TABLE (
  hires_last_30d          BIGINT,
  jobs_with_hire_last_30d BIGINT,
  stale_jobs_14d          BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  -- No arguments to validate.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  WITH hires AS (
    -- Hires of the last 30 days on jobs of employers that are not test
    -- accounts, by an index probe per hire.
    SELECT a.job_id
      FROM public.job_applications a
      CROSS JOIN LATERAL (
        SELECT 1
          FROM public.jobs j
          JOIN public.users u ON u.id = j.employer_id
         WHERE j.id = a.job_id
           AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
         LIMIT 1
      ) e
     WHERE a.hired_at > now() - interval '30 days'
  )
  SELECT (SELECT count(*) FROM hires),
         (SELECT count(DISTINCT h.job_id) FROM hires h),
         -- 114's stale jobs at 14 days, counted; no row leaves this function.
         (SELECT count(*) FROM public.admin_analytics_stale_jobs(14));
END $$;

-- ── (10) System health ──────────────────────────────────────
CREATE FUNCTION public.admin_analytics_system_health()
RETURNS TABLE (
  whatsapp_failed_24h BIGINT,
  ai_finished_7d      BIGINT,
  ai_usable_7d        BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  -- No arguments to validate.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  WITH msgs AS (
    -- 115's lanes and classification: gave up = unsent and no longer being
    -- retried; delivery failed = sent, then reported failed or undelivered.
    SELECT (o.status IN ('pending', 'failed', 'send_unknown')
             AND NOT (o.status = 'pending'
                      OR (o.status = 'failed' AND o.attempt_count < 5
                          AND o.source_type IS DISTINCT FROM 'worker_intent')
                      OR (o.status = 'send_unknown' AND o.source_type IS NOT DISTINCT FROM 'worker_intent'
                          AND COALESCE(o.worker_intent_leased_until > now(), false))))
           OR (o.status = 'sent' AND COALESCE(o.twilio_delivery_status IN ('failed', 'undelivered'), false)) AS is_failed
      FROM public.whatsapp_outbox o
     WHERE o.created_at > now() - interval '24 hours'
       AND (o.source_type IS NULL OR o.source_type IN ('admin_case', 'worker_intent', 'job_alert'))
    UNION ALL
    SELECT ((m.status IN ('pending', 'send_unknown') OR (m.status = 'failed' AND m.sent_at IS NULL))
             AND NOT (m.status = 'pending' OR (m.status = 'failed' AND m.attempt_count < 5 AND m.sent_at IS NULL)))
           OR (m.status = 'failed' AND m.sent_at IS NOT NULL)
      FROM public.job_message_outbox m
     WHERE m.created_at > now() - interval '24 hours'
       AND m.send_kind IN ('template', 'freeform')
  ), voice AS (
    SELECT x.status,
           COALESCE(jsonb_typeof(x.extracted_fields) = 'object'
                    AND jsonb_typeof(x.confidence_scores) = 'object', false) AS is_object
      FROM public.worker_profile_ai_extractions x
     WHERE x.created_at > now() - interval '7 days'
       AND NOT x.ai_test_profile
  )
  SELECT (SELECT count(*) FROM msgs m WHERE m.is_failed),
         (SELECT count(*) FROM voice v WHERE v.status IN ('completed', 'failed')),
         (SELECT count(*) FROM voice v WHERE v.status = 'completed' AND v.is_object);
END $$;

-- ── Ownership + ACL ─────────────────────────────────────────
ALTER FUNCTION public.admin_analytics_paying_weekly(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_reset_reasons(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_case_aging() OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_case_resolution(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_onboarding_steps(INTEGER, TEXT) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_identity_funnel(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_ranking_freshness() OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_billing_inbox_now() OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_home_metrics() OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_system_health() OWNER TO jale_admin;

REVOKE ALL ON FUNCTION public.admin_analytics_paying_weekly(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_reset_reasons(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_case_aging() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_case_resolution(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_onboarding_steps(INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_identity_funnel(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_ranking_freshness() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_billing_inbox_now() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_home_metrics() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_system_health() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_analytics_paying_weekly(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_reset_reasons(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_case_aging() TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_case_resolution(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_onboarding_steps(INTEGER, TEXT) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_identity_funnel(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_ranking_freshness() TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_billing_inbox_now() TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_home_metrics() TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_system_health() TO jale_admin_console;

-- Fail closed if a function drifted from the reviewed model or its gate does
-- not open. This runs before the two policies below, so it calls only the
-- eight functions that read neither policy table.
DO $$
DECLARE
  fn     RECORD;
  fn_oid OID;
BEGIN
  -- Names in the catalog checks below print schema-qualified whatever the
  -- applying role's search_path. SET LOCAL lasts until COMMIT; every
  -- statement after this block names its objects with their schema.
  SET LOCAL search_path = pg_catalog, pg_temp;

  FOR fn IN
    SELECT * FROM (VALUES
      ('public.admin_analytics_paying_weekly(integer)',
       'TABLE(week_start timestamp with time zone, partial boolean, employers bigint, paying bigint, new_paying bigint, churned bigint, approximate_before timestamp with time zone)',
       'SELECT * FROM public.admin_analytics_paying_weekly(4)'),
      ('public.admin_analytics_reset_reasons(integer)',
       'TABLE(source text, reason_code text, resets bigint)',
       NULL),
      ('public.admin_analytics_case_aging()',
       'TABLE(bucket text, waiting_on_us bigint, waiting_on_worker bigint)',
       'SELECT * FROM public.admin_analytics_case_aging()'),
      ('public.admin_analytics_case_resolution(integer)',
       'TABLE(week_start timestamp with time zone, partial boolean, resolved bigint, median_hours numeric, p75_hours numeric)',
       'SELECT * FROM public.admin_analytics_case_resolution(4)'),
      ('public.admin_analytics_onboarding_steps(integer,text)',
       'TABLE(step_key text, step_order integer, branch boolean, reached bigint, started bigint)',
       'SELECT * FROM public.admin_analytics_onboarding_steps(4, ''all'')'),
      ('public.admin_analytics_identity_funnel(integer)',
       'TABLE(challenges bigint, reached_code bigint, verified bigint, locked_once bigint, expired_unused bigint, attempts_zero bigint, attempts_one bigint, attempts_two bigint, attempts_three_plus bigint, median_minutes_to_verify numeric, p75_minutes_to_verify numeric, timings_since timestamp with time zone)',
       'SELECT * FROM public.admin_analytics_identity_funnel(4)'),
      ('public.admin_analytics_ranking_freshness()',
       'TABLE(under_1h bigint, from_1h_to_6h bigint, from_6h_to_24h bigint, from_1d_to_3d bigint, over_3d bigint, ranked_jobs bigint, fallback_jobs bigint, jobs_with_applications_no_ranking bigint)',
       NULL),
      ('public.admin_analytics_billing_inbox_now()',
       'TABLE(stuck_received bigint, failed_now bigint, failed_last_24h bigint, unresolved_older bigint, oldest_stuck_at timestamp with time zone)',
       'SELECT * FROM public.admin_analytics_billing_inbox_now()'),
      ('public.admin_analytics_home_metrics()',
       'TABLE(hires_last_30d bigint, jobs_with_hire_last_30d bigint, stale_jobs_14d bigint)',
       'SELECT * FROM public.admin_analytics_home_metrics()'),
      ('public.admin_analytics_system_health()',
       'TABLE(whatsapp_failed_24h bigint, ai_finished_7d bigint, ai_usable_7d bigint)',
       'SELECT * FROM public.admin_analytics_system_health()')
    ) AS expected(sig, result, smoke)
  LOOP
    fn_oid := to_regprocedure(fn.sig)::OID;
    IF fn_oid IS NULL THEN
      RAISE EXCEPTION 'migration 123: % missing', fn.sig;
    END IF;
    -- The exact columns the console maps, in order.
    IF pg_get_function_result(fn_oid) IS DISTINCT FROM fn.result THEN
      RAISE EXCEPTION 'migration 123: % result drifted', fn.sig;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = fn_oid
         AND p.proowner = 'jale_admin'::regrole::oid
         AND p.prosecdef
         -- A NULL proconfig (no pinned search_path) must fail, not skip.
         AND COALESCE(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false)
    ) THEN
      RAISE EXCEPTION 'migration 123: % owner/secdef/search_path wrong', fn.sig;
    END IF;
    IF NOT has_function_privilege('jale_admin_console', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 123: % not executable by jale_admin_console', fn.sig;
    END IF;
    -- Exactly the owner and the console may execute; PUBLIC is grantee 0.
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
         AND a.grantee <> p.proowner
         AND a.grantee <> 'jale_admin_console'::regrole::oid
    ) THEN
      RAISE EXCEPTION 'migration 123: % executable by a role other than its owner and the console', fn.sig;
    END IF;

    -- 098's pattern: clear the gate, call, read it back. Each call also
    -- plans its whole query, so a wrong table or column fails here. The two
    -- functions that read a policy table are called after the policies.
    IF fn.smoke IS NOT NULL THEN
      PERFORM set_config('app.admin_analytics_read', '', true);
      EXECUTE fn.smoke;
      IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'migration 123: % did not set the read flag', fn.sig;
      END IF;
    END IF;
  END LOOP;
END $$;

-- ── Gated reads for the two tables a definer could not read ──
-- SELECT-only, for jale_admin, true only while a definer above has opened
-- the transaction-local flag. The predicate reads no table, so it adds no
-- policy recursion. Each statement holds ACCESS EXCLUSIVE on its table until
-- COMMIT, so the policies come last: after them run only the check below,
-- one call each of the two functions that read these tables, and the bounds
-- checks.
CREATE POLICY identity_lockout_resets_admin_analytics_read
  ON public.identity_lockout_resets FOR SELECT
  TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

CREATE POLICY employer_candidate_rankings_admin_analytics_read
  ON public.employer_candidate_rankings FOR SELECT
  TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

-- Fail closed if a policy drifted from the reviewed model, if the two gated
-- reads do not open the gate, or if bad input is accepted.
DO $$
DECLARE
  v_gate   CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;
  fn       RECORD;
  v_raised BOOLEAN;
  v_bad    RECORD;
BEGIN
  -- Schema-qualified names, as in the check above (this is the migration's
  -- last statement).
  SET LOCAL search_path = pg_catalog, pg_temp;

  IF (SELECT count(*) FROM pg_policy p
       WHERE p.polname IN ('identity_lockout_resets_admin_analytics_read', 'employer_candidate_rankings_admin_analytics_read')
         AND p.polrelid IN ('public.identity_lockout_resets'::regclass, 'public.employer_candidate_rankings'::regclass)
         AND p.polname = replace(p.polrelid::regclass::text, 'public.', '') || '_admin_analytics_read'
         AND p.polcmd = 'r'
         AND p.polpermissive
         AND p.polroles = ARRAY['jale_admin'::regrole::oid]
         AND pg_get_expr(p.polqual, p.polrelid) = v_gate
         AND p.polwithcheck IS NULL) <> 2 THEN
    RAISE EXCEPTION 'migration 123: a gated read policy is missing or drifted; lockout resets or rankings would read zero rows';
  END IF;

  -- The two functions that read a policy table, as above.
  FOR fn IN
    SELECT * FROM (VALUES
      ('public.admin_analytics_reset_reasons(integer)', 'SELECT * FROM public.admin_analytics_reset_reasons(30)'),
      ('public.admin_analytics_ranking_freshness()', 'SELECT * FROM public.admin_analytics_ranking_freshness()')
    ) AS gated(sig, smoke)
  LOOP
    PERFORM set_config('app.admin_analytics_read', '', true);
    EXECUTE fn.smoke;
    IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'migration 123: % did not set the read flag', fn.sig;
    END IF;
  END LOOP;

  -- Every bound is rejected with its exact error. Each function raises
  -- before its query runs, so these read no table.
  FOR v_bad IN
    SELECT * FROM (VALUES
      ('SELECT * FROM public.admin_analytics_paying_weekly(0)', 'admin_analytics_invalid_weeks'),
      ('SELECT * FROM public.admin_analytics_paying_weekly(27)', 'admin_analytics_invalid_weeks'),
      ('SELECT * FROM public.admin_analytics_case_resolution(0)', 'admin_analytics_invalid_weeks'),
      ('SELECT * FROM public.admin_analytics_case_resolution(27)', 'admin_analytics_invalid_weeks'),
      ('SELECT * FROM public.admin_analytics_identity_funnel(0)', 'admin_analytics_invalid_weeks'),
      ('SELECT * FROM public.admin_analytics_identity_funnel(27)', 'admin_analytics_invalid_weeks'),
      ('SELECT * FROM public.admin_analytics_onboarding_steps(0, ''all'')', 'admin_analytics_invalid_weeks'),
      ('SELECT * FROM public.admin_analytics_onboarding_steps(27, ''all'')', 'admin_analytics_invalid_weeks'),
      ('SELECT * FROM public.admin_analytics_onboarding_steps(4, ''sms'')', 'admin_analytics_invalid_door'),
      ('SELECT * FROM public.admin_analytics_reset_reasons(0)', 'admin_analytics_invalid_days'),
      ('SELECT * FROM public.admin_analytics_reset_reasons(91)', 'admin_analytics_invalid_days')
    ) AS bad(stmt, message)
  LOOP
    BEGIN
      EXECUTE v_bad.stmt;
      v_raised := false;
    EXCEPTION WHEN raise_exception THEN
      v_raised := SQLERRM = v_bad.message;
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'migration 123: "%" did not raise %', v_bad.stmt, v_bad.message;
    END IF;
  END LOOP;
END $$;

COMMIT;
