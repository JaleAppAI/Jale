-- ============================================================
-- 114_admin_employer_health.sql
-- Run manually AFTER 102_admin_identity_lockouts.sql, connected as
-- jale_admin (NOT the RDS master user). Forward-only (ADR-005).
-- Numbered 114 to leave 104-112 for migrations written in parallel; it
-- depends on nothing after 102 (and not on 113), so it may be applied before
-- or after them.
--
-- Roadmap sub-project 2b
-- (docs/superpowers/specs/2026-10-08-admin-analytics-2b-employer-health-design.md).
--
-- How well employers respond to workers. All math happens here, so no
-- per-application row reaches the console:
-- (1) admin_analytics_employer_weekly(p_weeks): one row per week (Monday
--     00:00 UTC) of the window plus one whole-window row (week_start NULL):
--     first response to applications (answered, answered with no recorded
--     time, unanswered after 7 days, applications 7+ days old, median / p75
--     hours) by application week; reply time to worker turns (turns,
--     unanswered after 7 days, turns 7+ days old, median / p75 hours) by turn
--     week; time to hire (hires, approximate pre-095 hires, median / p75
--     days) by hire week. Empty weeks are zero-filled. The whole-window row
--     also carries the live count of active jobs.
-- (2) admin_analytics_slowest_employers(p_weeks, p_limit): employers with 3+
--     applications in the window, most unanswered first, then slowest median
--     first response (no timed answer last).
-- (3) admin_analytics_stale_jobs(p_days): active jobs whose last employer
--     action (or posting) is at least p_days old, most idle first.
--
-- EMPLOYER ACTION, the only activity that counts: an employer message
-- (job_conversation_messages.created_at, any status), details_requested_at,
-- hired_at unless it is 095's backfill (hired_at = hired_seen_at =
-- hired_ack_at, an approximate time), and a 099 status event with
-- is_backfill = false to contacted, details_requested, hired or
-- not_interested. Timestamps that worker activity, triggers, Twilio or an
-- open thread on screen move are never read.
-- First response = the earliest action on an application, across all its
-- conversations. Answered = a first response, or a status other than pending
-- (no action time: answered, untimed). A worker turn starts at a worker
-- message whose previous non-system message in its conversation, in
-- (created_at, id) order, is not a worker message; its reply is the next
-- employer message in that order. A turn with no reply in a conversation
-- that has closed is left out. Approximate hires still count as hires.
--
-- TEST ACCOUNTS: employers whose users row matches @jale.test or seed- are
-- left out of every figure; the filter is used in WHERE only.
--
-- PLANS: the policy predicates make the planner's row estimates useless here
-- (1 estimated, 20k+ real), so every per-application or per-job lookup is a
-- LATERAL index probe; a join to an all-time aggregate became a quadratic
-- nested loop (30 s at 50k applications). No new index.
--
-- ACCESS (roadmap rules, 089's pattern): every function is a definer owned by
-- jale_admin with a pinned search path, executable by the admin console role
-- only, and opens app.admin_analytics_read after validating its input. users,
-- jobs, job_applications and job_conversation_messages are read through 089's
-- gated policies, job_application_status_events through 099's, and names
-- through employer_display_name() (031). job_conversations had no gated
-- policy, so a definer read it as zero rows (the 088 defect): this migration
-- adds that one policy. No table grant, no index.
--
-- DEPLOY ORDER: apply BEFORE deploying the admin console build that calls
-- these functions (/analytics/employers).
-- ============================================================
BEGIN;

-- Fail fast instead of queueing every job_conversations read and write
-- behind a stuck transaction (the policy created below takes an
-- AccessExclusiveLock until COMMIT); a timed-out apply writes no ledger row
-- and can simply be rerun.
SET LOCAL lock_timeout = '5s';

-- Preconditions: pg_policy is a catalog table, so RLS never filters this
-- check; a missing policy would otherwise make the page silently empty (the
-- 088 defect).
DO $$
DECLARE
  v_gate CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;
  v_name CONSTANT TEXT := $q$(current_setting('app.employer_name_lookup'::text, true) = 'on'::text)$q$;
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT * FROM (VALUES
      ('public.users', 'users_admin_analytics_read', 'r', v_gate),
      ('public.jobs', 'jobs_admin_analytics_read', 'r', v_gate),
      ('public.job_applications', 'job_applications_admin_analytics_read', 'r', v_gate),
      ('public.job_conversation_messages', 'job_conversation_messages_admin_analytics_read', 'r', v_gate),
      ('public.job_application_status_events', 'job_application_status_events_admin_analytics_read', 'r', v_gate),
      ('public.employer_profiles', 'employer_profiles_name_lookup', 'r', v_name)
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
      RAISE EXCEPTION 'migration 114: policy % on % missing or drifted; the employer health page would read zero rows', pol.name, pol.rel;
    END IF;
  END LOOP;

  -- A RESTRICTIVE policy is AND'ed with every gate, so one for jale_admin or
  -- PUBLIC (role 0) on any table read here could zero the page just as silently.
  IF EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid IN ('public.users'::regclass, 'public.jobs'::regclass,
                          'public.job_applications'::regclass, 'public.job_conversations'::regclass,
                          'public.job_conversation_messages'::regclass,
                          'public.job_application_status_events'::regclass,
                          'public.employer_profiles'::regclass)
       AND NOT p.polpermissive
       AND ('jale_admin'::regrole::oid = ANY (p.polroles) OR 0::OID = ANY (p.polroles))
  ) THEN
    RAISE EXCEPTION 'migration 114: a restrictive policy for jale_admin or PUBLIC on a table the employer health page reads; it would hide rows';
  END IF;

  -- Names come from 031's definer, called by the functions as jale_admin.
  IF NOT has_function_privilege('jale_admin', 'public.employer_display_name(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 114: jale_admin cannot execute employer_display_name(uuid)';
  END IF;
END $$;

-- ── job_conversations: 089's gated read ─────────────────────
-- The message policies reference conversations, never the reverse, so this
-- adds no policy recursion.
CREATE POLICY job_conversations_admin_analytics_read
  ON public.job_conversations FOR SELECT
  TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

-- ── Weekly first response, reply time and time to hire ──────
CREATE FUNCTION public.admin_analytics_employer_weekly(p_weeks INTEGER)
RETURNS TABLE (
  week_start               TIMESTAMPTZ,
  applications             BIGINT,
  answered                 BIGINT,
  answered_untimed         BIGINT,
  unanswered_7d            BIGINT,
  applications_due         BIGINT,
  first_response_p50_hours NUMERIC,
  first_response_p75_hours NUMERIC,
  worker_turns             BIGINT,
  turns_unanswered_7d      BIGINT,
  turns_due                BIGINT,
  reply_p50_hours          NUMERIC,
  reply_p75_hours          NUMERIC,
  hires                    BIGINT,
  hires_approximate        BIGINT,
  time_to_hire_p50_days    NUMERIC,
  time_to_hire_p75_days    NUMERIC,
  active_jobs              BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_from TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  -- Week arithmetic on UTC wall-clock time, so the session TimeZone (and its
  -- daylight-saving shifts) can never move the window edge.
  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH employers AS (
    SELECT u.id
      FROM public.users u
     WHERE u.user_type = 'employer'
       AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
  ), weeks AS (
    -- Every week of the window, plus NULL for the whole-window row.
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n)) AT TIME ZONE 'UTC' AS wk
      FROM generate_series(0, p_weeks - 1) AS g(n)
    UNION ALL
    SELECT NULL::TIMESTAMPTZ
  ), apps AS (
    SELECT a.id, a.status, a.applied_at, a.details_requested_at, a.hired_at,
           COALESCE(a.hired_at = a.hired_seen_at AND a.hired_at = a.hired_ack_at, false) AS hire_approx
      FROM public.job_applications a
      JOIN public.jobs j ON j.id = a.job_id
      JOIN employers e ON e.id = j.employer_id
     WHERE a.applied_at >= v_from
  ), app_facts AS (
    SELECT date_trunc('week', ap.applied_at, 'UTC') AS wk,
           ap.status,
           ap.applied_at,
           fa.first_at,
           extract(epoch FROM fa.first_at - ap.applied_at)::DOUBLE PRECISION / 3600 AS hours
      FROM apps ap
      -- The earliest employer action on the application, by index lookups.
      LEFT JOIN LATERAL (
        SELECT min(x.at) AS first_at
          FROM (
            SELECT min(m.created_at) AS at
              FROM public.job_conversations c
              JOIN public.job_conversation_messages m ON m.conversation_id = c.id
             WHERE c.application_id = ap.id
               AND m.sender_type = 'employer'
            UNION ALL
            SELECT ap.details_requested_at
            UNION ALL
            SELECT ap.hired_at WHERE NOT ap.hire_approx
            UNION ALL
            SELECT min(ev.changed_at)
              FROM public.job_application_status_events ev
             WHERE ev.application_id = ap.id
               AND NOT ev.is_backfill
               AND ev.to_status IN ('contacted', 'details_requested', 'hired', 'not_interested')
          ) x
      ) fa ON true
  ), fr AS (
    SELECT f.wk,
           count(*) AS n_apps,
           count(*) FILTER (WHERE f.first_at IS NOT NULL OR f.status <> 'pending') AS n_answered,
           count(*) FILTER (WHERE f.first_at IS NULL AND f.status <> 'pending') AS n_untimed,
           count(*) FILTER (WHERE f.first_at IS NULL AND f.status = 'pending'
                              AND f.applied_at <= now() - interval '7 days') AS n_unanswered,
           count(*) FILTER (WHERE f.applied_at <= now() - interval '7 days') AS n_due,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY f.hours)::NUMERIC, 1) AS p50,
           round(percentile_cont(0.75) WITHIN GROUP (ORDER BY f.hours)::NUMERIC, 1) AS p75
      FROM app_facts f
     GROUP BY GROUPING SETS ((f.wk), ())
  ), msgs AS (
    -- System rows ("worker ended the conversation") are ignored entirely.
    SELECT m.id, m.conversation_id, m.sender_type, m.created_at, c.status AS conv_status,
           lag(m.sender_type) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS prev_sender
      FROM public.job_conversation_messages m
      JOIN public.job_conversations c ON c.id = m.conversation_id
      JOIN employers e ON e.id = c.employer_id
     WHERE m.sender_type <> 'system'
  ), turns AS (
    SELECT date_trunc('week', t.created_at, 'UTC') AS wk,
           t.created_at AS turn_at,
           r.reply_at,
           t.conv_status
      FROM msgs t
      LEFT JOIN LATERAL (
        -- The next employer message, in the same (created_at, id) order.
        SELECT min(m.created_at) AS reply_at
          FROM public.job_conversation_messages m
         WHERE m.conversation_id = t.conversation_id
           AND m.sender_type = 'employer'
           AND (m.created_at, m.id) > (t.created_at, t.id)
      ) r ON true
     WHERE t.sender_type = 'worker'
       AND t.prev_sender IS DISTINCT FROM 'worker'
       AND t.created_at >= v_from
  ), rt AS (
    SELECT t.wk,
           count(*) AS n_turns,
           count(*) FILTER (WHERE t.reply_at IS NULL AND t.turn_at <= now() - interval '7 days') AS n_unanswered,
           count(*) FILTER (WHERE t.turn_at <= now() - interval '7 days') AS n_due,
           round(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY extract(epoch FROM t.reply_at - t.turn_at)::DOUBLE PRECISION / 3600)::NUMERIC, 1) AS p50,
           round(percentile_cont(0.75) WITHIN GROUP (
             ORDER BY extract(epoch FROM t.reply_at - t.turn_at)::DOUBLE PRECISION / 3600)::NUMERIC, 1) AS p75
      FROM turns t
     -- A turn whose conversation closed before any reply is left out.
     WHERE t.reply_at IS NOT NULL OR t.conv_status <> 'closed'
     GROUP BY GROUPING SETS ((t.wk), ())
  ), hire_facts AS (
    SELECT date_trunc('week', a.hired_at, 'UTC') AS wk,
           extract(epoch FROM a.hired_at - a.applied_at)::DOUBLE PRECISION / 86400 AS days,
           COALESCE(a.hired_at = a.hired_seen_at AND a.hired_at = a.hired_ack_at, false) AS approx
      FROM public.job_applications a
      JOIN public.jobs j ON j.id = a.job_id
      JOIN employers e ON e.id = j.employer_id
     WHERE a.hired_at >= v_from
  ), hr AS (
    SELECT h.wk,
           count(*) AS n_hires,
           count(*) FILTER (WHERE h.approx) AS n_approx,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY h.days)::NUMERIC, 1) AS p50,
           round(percentile_cont(0.75) WITHIN GROUP (ORDER BY h.days)::NUMERIC, 1) AS p75
      FROM hire_facts h
     GROUP BY GROUPING SETS ((h.wk), ())
  )
  SELECT w.wk,
         COALESCE(fr.n_apps, 0),
         COALESCE(fr.n_answered, 0),
         COALESCE(fr.n_untimed, 0),
         COALESCE(fr.n_unanswered, 0),
         COALESCE(fr.n_due, 0),
         fr.p50,
         fr.p75,
         COALESCE(rt.n_turns, 0),
         COALESCE(rt.n_unanswered, 0),
         COALESCE(rt.n_due, 0),
         rt.p50,
         rt.p75,
         COALESCE(hr.n_hires, 0),
         COALESCE(hr.n_approx, 0),
         hr.p50,
         hr.p75,
         CASE WHEN w.wk IS NULL THEN (
           SELECT count(*)
             FROM public.jobs j
             JOIN employers e ON e.id = j.employer_id
            WHERE j.status = 'active'
         ) END
    FROM weeks w
    -- The whole-window rows (wk NULL) join each other.
    LEFT JOIN fr ON fr.wk IS NOT DISTINCT FROM w.wk
    LEFT JOIN rt ON rt.wk IS NOT DISTINCT FROM w.wk
    LEFT JOIN hr ON hr.wk IS NOT DISTINCT FROM w.wk
   ORDER BY w.wk NULLS LAST;
END $$;

-- ── Slowest employers ───────────────────────────────────────
CREATE FUNCTION public.admin_analytics_slowest_employers(p_weeks INTEGER, p_limit INTEGER DEFAULT 10)
RETURNS TABLE (
  employer_id              UUID,
  display_name             TEXT,
  applications             BIGINT,
  unanswered_7d            BIGINT,
  first_response_p50_hours NUMERIC,
  active_jobs              BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_from TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_limit';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH employers AS (
    SELECT u.id
      FROM public.users u
     WHERE u.user_type = 'employer'
       AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
  ), apps AS (
    SELECT a.id, a.status, a.applied_at, a.details_requested_at, a.hired_at, j.employer_id AS emp,
           COALESCE(a.hired_at = a.hired_seen_at AND a.hired_at = a.hired_ack_at, false) AS hire_approx
      FROM public.job_applications a
      JOIN public.jobs j ON j.id = a.job_id
      JOIN employers e ON e.id = j.employer_id
     WHERE a.applied_at >= v_from
  ), app_facts AS (
    SELECT ap.emp,
           (fa.first_at IS NULL AND ap.status = 'pending'
              AND ap.applied_at <= now() - interval '7 days') AS is_unanswered,
           extract(epoch FROM fa.first_at - ap.applied_at)::DOUBLE PRECISION / 3600 AS hours
      FROM apps ap
      -- The earliest employer action on the application, by index lookups.
      LEFT JOIN LATERAL (
        SELECT min(x.at) AS first_at
          FROM (
            SELECT min(m.created_at) AS at
              FROM public.job_conversations c
              JOIN public.job_conversation_messages m ON m.conversation_id = c.id
             WHERE c.application_id = ap.id
               AND m.sender_type = 'employer'
            UNION ALL
            SELECT ap.details_requested_at
            UNION ALL
            SELECT ap.hired_at WHERE NOT ap.hire_approx
            UNION ALL
            SELECT min(ev.changed_at)
              FROM public.job_application_status_events ev
             WHERE ev.application_id = ap.id
               AND NOT ev.is_backfill
               AND ev.to_status IN ('contacted', 'details_requested', 'hired', 'not_interested')
          ) x
      ) fa ON true
  ), ranked AS (
    SELECT f.emp,
           count(*) AS n_apps,
           count(*) FILTER (WHERE f.is_unanswered) AS n_unanswered,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY f.hours)::NUMERIC, 1) AS p50
      FROM app_facts f
     GROUP BY f.emp
    HAVING count(*) >= 3
  )
  SELECT r.emp,
         public.employer_display_name(r.emp),
         r.n_apps,
         r.n_unanswered,
         r.p50,
         (SELECT count(*) FROM public.jobs j WHERE j.employer_id = r.emp AND j.status = 'active')
    FROM ranked r
   -- No timed answer is not evidence of slowness (all fresh, or answered
   -- before history began): those rank below measured employers.
   ORDER BY r.n_unanswered DESC, r.p50 DESC NULLS LAST, r.emp
   LIMIT p_limit;
END $$;

-- ── Stale active jobs ───────────────────────────────────────
CREATE FUNCTION public.admin_analytics_stale_jobs(p_days INTEGER DEFAULT 14)
RETURNS TABLE (
  job_id                  UUID,
  title                   TEXT,
  employer_id             UUID,
  display_name            TEXT,
  posted_at               TIMESTAMPTZ,
  last_employer_action_at TIMESTAMPTZ,
  days_idle               INTEGER,
  waiting_applicants      BIGINT,
  last_application_at     TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_days';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  WITH employers AS (
    SELECT u.id
      FROM public.users u
     WHERE u.user_type = 'employer'
       AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
  ), live AS (
    SELECT j.id, j.title, j.employer_id AS emp, j.created_at
      FROM public.jobs j
      JOIN employers e ON e.id = j.employer_id
     WHERE j.status = 'active'
  ), idle AS (
    -- Posting the job is the first employer action; greatest() skips NULL.
    SELECT l.id, l.title, l.emp, l.created_at,
           greatest(l.created_at, max(la.last_at)) AS last_at,
           count(a.id) FILTER (WHERE a.status = 'pending') AS n_waiting,
           max(a.applied_at) AS last_applied
      FROM live l
      LEFT JOIN public.job_applications a ON a.job_id = l.id
      -- The latest employer action on each application, by index lookups.
      LEFT JOIN LATERAL (
        SELECT max(x.at) AS last_at
          FROM (
            SELECT max(m.created_at) AS at
              FROM public.job_conversations c
              JOIN public.job_conversation_messages m ON m.conversation_id = c.id
             WHERE c.application_id = a.id
               AND m.sender_type = 'employer'
            UNION ALL
            SELECT a.details_requested_at
            UNION ALL
            SELECT a.hired_at WHERE NOT COALESCE(a.hired_at = a.hired_seen_at AND a.hired_at = a.hired_ack_at, false)
            UNION ALL
            SELECT max(ev.changed_at)
              FROM public.job_application_status_events ev
             WHERE ev.application_id = a.id
               AND NOT ev.is_backfill
               AND ev.to_status IN ('contacted', 'details_requested', 'hired', 'not_interested')
          ) x
      ) la ON true
     GROUP BY l.id, l.title, l.emp, l.created_at
  ), stale AS (
    SELECT i.*, floor(extract(epoch FROM now() - i.last_at) / 86400)::INTEGER AS idle_days
      FROM idle i
  )
  SELECT s.id,
         s.title,
         s.emp,
         public.employer_display_name(s.emp),
         s.created_at,
         s.last_at,
         s.idle_days,
         s.n_waiting,
         s.last_applied
    FROM stale s
   WHERE s.idle_days >= p_days
   ORDER BY s.idle_days DESC, s.id;
END $$;

-- ── Ownership + ACL ─────────────────────────────────────────
ALTER FUNCTION public.admin_analytics_employer_weekly(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_slowest_employers(INTEGER, INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_stale_jobs(INTEGER) OWNER TO jale_admin;

REVOKE ALL ON FUNCTION public.admin_analytics_employer_weekly(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_slowest_employers(INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_stale_jobs(INTEGER) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_analytics_employer_weekly(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_slowest_employers(INTEGER, INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_stale_jobs(INTEGER) TO jale_admin_console;

-- Fail closed if the new policy drifted, if any function drifted from the
-- reviewed model, if the gate does not open, or if bad input is accepted.
DO $$
DECLARE
  v_gate   CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;
  fn_sig   TEXT;
  fn_oid   OID;
  fn       RECORD;
  v_raised BOOLEAN;
  v_arg    INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.job_conversations'::regclass
       AND p.polname = 'job_conversations_admin_analytics_read'
       AND p.polcmd = 'r'
       AND p.polpermissive
       AND p.polroles = ARRAY['jale_admin'::regrole::oid]
       AND pg_get_expr(p.polqual, p.polrelid) = v_gate
  ) THEN
    RAISE EXCEPTION 'migration 114: policy job_conversations_admin_analytics_read missing or drifted; reply times would read zero conversations';
  END IF;

  FOREACH fn_sig IN ARRAY ARRAY[
    'public.admin_analytics_employer_weekly(integer)',
    'public.admin_analytics_slowest_employers(integer, integer)',
    'public.admin_analytics_stale_jobs(integer)'
  ] LOOP
    fn_oid := to_regprocedure(fn_sig)::OID;
    IF fn_oid IS NULL THEN
      RAISE EXCEPTION 'migration 114: % missing', fn_sig;
    END IF;

    SELECT owner.rolname AS owner_name, p.prosecdef, p.proconfig INTO fn
      FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
     WHERE p.oid = fn_oid;
    IF fn.owner_name IS DISTINCT FROM 'jale_admin' OR NOT fn.prosecdef
       OR NOT COALESCE(fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false) THEN
      RAISE EXCEPTION 'migration 114: % owner/secdef/search_path wrong', fn_sig;
    END IF;
    IF NOT has_function_privilege('jale_admin_console', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 114: % not executable by console', fn_sig;
    END IF;
    -- Exactly the owner and the console may execute (PUBLIC is grantee 0).
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
         AND a.grantee NOT IN (p.proowner, 'jale_admin_console'::regrole::oid)
    ) THEN
      RAISE EXCEPTION 'migration 114: % executable by a role other than its owner and the console', fn_sig;
    END IF;
  END LOOP;

  -- 098's pattern: clear the gate before EACH call and read it back. Each
  -- call also plans its whole query, so a wrong table or column fails here.
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_employer_weekly(4);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 114: admin_analytics_employer_weekly did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_slowest_employers(4, 10);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 114: admin_analytics_slowest_employers did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_stale_jobs(14);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 114: admin_analytics_stale_jobs did not set the read flag';
  END IF;

  FOREACH v_arg IN ARRAY ARRAY[0, 27] LOOP
    BEGIN
      PERFORM * FROM public.admin_analytics_employer_weekly(v_arg);
      v_raised := false;
    EXCEPTION WHEN raise_exception THEN
      v_raised := SQLERRM = 'admin_analytics_invalid_weeks';
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'migration 114: admin_analytics_employer_weekly(%) did not reject the window', v_arg;
    END IF;
    BEGIN
      PERFORM * FROM public.admin_analytics_slowest_employers(v_arg, 10);
      v_raised := false;
    EXCEPTION WHEN raise_exception THEN
      v_raised := SQLERRM = 'admin_analytics_invalid_weeks';
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'migration 114: admin_analytics_slowest_employers(%, 10) did not reject the window', v_arg;
    END IF;
  END LOOP;
  FOREACH v_arg IN ARRAY ARRAY[0, 101] LOOP
    BEGIN
      PERFORM * FROM public.admin_analytics_slowest_employers(4, v_arg);
      v_raised := false;
    EXCEPTION WHEN raise_exception THEN
      v_raised := SQLERRM = 'admin_analytics_invalid_limit';
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'migration 114: admin_analytics_slowest_employers(4, %) did not reject the limit', v_arg;
    END IF;
  END LOOP;
  FOREACH v_arg IN ARRAY ARRAY[0, 366] LOOP
    BEGIN
      PERFORM * FROM public.admin_analytics_stale_jobs(v_arg);
      v_raised := false;
    EXCEPTION WHEN raise_exception THEN
      v_raised := SQLERRM = 'admin_analytics_invalid_days';
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'migration 114: admin_analytics_stale_jobs(%) did not reject the window', v_arg;
    END IF;
  END LOOP;
END $$;

COMMIT;
