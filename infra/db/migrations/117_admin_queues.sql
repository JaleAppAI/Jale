-- ============================================================
-- 117_admin_queues.sql
-- Run manually AFTER 102_admin_identity_lockouts.sql, connected as
-- jale_admin (NOT the RDS master user). Forward-only (ADR-005).
-- Numbered 117 to leave 104-112 for migrations written in parallel and 116
-- for the job-message sweeper repair; it depends on nothing after 102 (not on
-- 113-116), so it may be applied before or after them.
--
-- Roadmap sub-project 2d
-- (docs/superpowers/specs/2026-10-09-admin-analytics-2d-admin-queues-design.md).
--
-- Three admin-queue questions, in five parts:
-- (1) CASE STATUS TIMING. admin_cases.status_changed_at is when the case
--     entered its current status. A BEFORE trigger stamps now() on every real
--     status change (any writer: the console, a bastion edit, a definer); an
--     AFTER trigger writes one "Status changed" timeline event
--     (admin_case_events, event_type status_changed) with the old and new
--     status. Neither fires on an update that leaves the status as it was
--     (a reply to a case already waiting on the worker, a Twilio callback
--     that touches details / updated_at). The event's actor is 'admin' when
--     the session logged in as jale_admin_console, else 'system'; its
--     actor_id is NULL (the console's own audit row names the admin). An
--     event that cannot be written rolls the status change back.
--     Existing cases are backfilled once, never earlier than created_at:
--     resolved / dismissed at resolved_at; pending_worker at the earliest
--     audit row that moves a case there (request_more_info, reply_whatsapp,
--     reset_verification_step; target_type admin_case or the retired
--     verification); everything else, and anything without that evidence,
--     at created_at. Past status changes get no invented timeline events.
-- (2) admin_analytics_onboarding_restarts(p_weeks): per week (Monday 00:00
--     UTC), door and onboarding step, the workers who reached the step, and
--     the workers and presses that started over (worker_restart) or went
--     back (worker_back, worker_back_web) from it; all-steps rows (step_key
--     NULL) per week and door whose worker counts are distinct across steps;
--     and whole-window rows (week_start NULL) of both kinds whose worker
--     counts are distinct across the window.
-- (3) admin_analytics_operator_resets(p_weeks): operator resets of
--     onboarding (worker_reset_audit, dry runs left out) per week and masked
--     reason, with bulk runs (10+ distinct workers reset with one reason
--     within an hour) taken out and listed one row each.
-- (4) admin_analytics_digest_adoption(): employers, how many have the
--     applicant digest switched on, and how many of those have an address
--     the producer would send to.
-- (5) admin_analytics_digest_sends(p_weeks): applicant digest emails per
--     week (by created_at) by outcome, plus a whole-window row.
--
-- WEEKS: Monday 00:00 UTC; the window is the current (partial) week and the
-- p_weeks - 1 before it, computed on UTC wall-clock time as in 113-115.
--
-- RESTARTS (worker_workflow_transitions, one row per step move). A run's
-- door is the transition that created it, by presence over all its rows
-- (113's rule): otp_verified -> whatsapp, else web_start -> web; a run with
-- neither (adopted) counts only under 'all'. Runs of workers who ever went
-- through the retired web bypass (a web_worker_bypass transition) are left
-- out, as in 113. Started over = reason worker_restart (WhatsApp only, a
-- self-loop when already on profile.name); went back = worker_back /
-- worker_back_web; the step is the one the worker left (from_step_key).
-- Reached = distinct workers who were at the step in the period: arrived
-- at it (to_step_key) by any move except those three and the voice-note
-- retry loops (*_retry_offered), or started over or went back from it -- so
-- a worker who arrived before the window and pressed inside it is reached,
-- and the workers who pressed never outnumber those reached. Presses count
-- rows; workers count distinct run owners; 'all' counts a worker once
-- however many doors they used, and an all-steps row once however many
-- steps (its presses are sums). Only the 17 onboarding steps
-- count (113's list): a NULL or unknown step is left out. Operator resets
-- delete a worker's runs and transitions, so their earlier moves are gone.
-- RESETS (worker_reset_audit WHERE NOT dry_run). Reason shown = trimmed,
-- then, in this order, each replaced by four bullets (U+2022): every
-- email-like token (anything without spaces around an '@'), every UUID-shaped
-- token (8-4-4-4-12 hex digits), every phone-like run (an optional +, a
-- digit, 5+ digits, spaces, dots, dashes, slashes, underscores or
-- parentheses, a digit) and every remaining run of 4+ digits; then cut to 80
-- characters and right-trimmed (a cut never ends in a space);
-- '(no reason)' when that is empty; other free text leaves as typed. The
-- operator, the worker and the phone hash are never returned. BULK: a reset
-- is bulk when 10 or more distinct workers were reset with the same raw
-- reason within some one-hour span (first to last reset at most an hour
-- apart) that contains it; bulk resets
-- of one reason less than an hour apart form one run. Membership is decided
-- over every reset, also those before the window, so a run that started
-- before the window keeps its in-window resets out of the counts; each
-- figure (workers, resets, first reset) counts only in-window resets: a
-- run's run_started_at and week_start are those of its first in-window
-- reset.
-- DIGEST. Employers = users of type employer, test accounts left out exactly
-- as 114 (@jale.test, seed-). Switched on = employer_digest_settings.enabled
-- (a missing row is off). An address the producer would send to = its own
-- check (email_outbox's recipient CHECK): length 3-320 with an '@' after the
-- first character. Sends = email_outbox rows with source_type
-- employer_digest whose source_id is such an employer (rows of deleted or
-- test employers and billing mail drop out): sent; failed = failed after 5+
-- attempts; unknown = send_unknown (timed out, never retried, may have
-- arrived); in progress = pending, or failed below 5 attempts (retrying);
-- employers reached = distinct employers with a sent row.
--
-- ACCESS (roadmap rules, 089's pattern): every read function is a definer
-- owned by jale_admin with a pinned search path, executable by the admin
-- console role only, and opens app.admin_analytics_read after validating its
-- input. The onboarding tables are read through 042's definer policies,
-- worker_reset_audit through its admin read policy, email_outbox through
-- 037's admin select policy and users through 089's gate.
-- employer_digest_settings is FORCE RLS with no policy a definer satisfies,
-- so a definer read it as zero rows (the 088 defect): this migration adds
-- 089's gated read policy to it. The timeline trigger is a definer too (it
-- writes admin_case_events through 026's jale_admin policy), so the console
-- needs no new grant; the stamp trigger reads nothing. No table grant, no
-- index.
--
-- PLANS: users carries policies whose row estimates are useless (114), so
-- every lookup of an employer is a LATERAL index probe on users_pkey (LIMIT
-- 1 keeps the planner from turning it into a join). worker_workflow_
-- transitions, worker_reset_audit and email_outbox have no created_at index
-- and get none: restarts scan transitions three times (door transitions,
-- bypass transitions, the window's moves), resets and sends scan their
-- table once. Bulk detection uses window frames and a join on the reason
-- for the rare repeat resets, never a probe per reset.
--
-- DEPLOY ORDER: apply BEFORE deploying the admin console build that selects
-- admin_cases.status_changed_at (/cases and Home fail without it) and calls
-- these functions. Apply in a quiet window: the column, the backfill and the
-- triggers hold an exclusive lock on admin_cases until COMMIT.
-- ============================================================
BEGIN;

-- Fail fast instead of queueing every admin_cases and employer_digest_settings
-- read and write behind a stuck transaction (the column, the triggers and
-- the policy take AccessExclusiveLocks until COMMIT); a timed-out apply
-- writes no ledger row and can simply be rerun.
SET LOCAL lock_timeout = '5s';

-- Preconditions: pg_policy is a catalog table, so RLS never filters this
-- check; a missing policy would otherwise make a section silently empty (the
-- 088 defect) or the backfill silently wrong.
DO $$
DECLARE
  v_gate CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT * FROM (VALUES
      ('public.worker_workflow_runs', 'worker_workflow_runs_definer', '*', 'true', 'true'),
      ('public.worker_workflow_transitions', 'worker_workflow_transitions_definer', '*', 'true', 'true'),
      ('public.worker_reset_audit', 'worker_reset_audit_admin_read', 'r', 'true', NULL),
      ('public.email_outbox', 'email_outbox_admin_select', 'r', 'true', NULL),
      ('public.users', 'users_admin_analytics_read', 'r', v_gate, NULL),
      ('public.admin_cases', 'admin_cases_service_all', '*', 'true', 'true'),
      ('public.admin_case_events', 'admin_case_events_service_all', '*', 'true', 'true')
    ) AS expected(rel, name, cmd, qual, chk)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
       WHERE p.polrelid = pol.rel::regclass
         AND p.polname = pol.name
         AND p.polcmd::text = pol.cmd
         AND p.polpermissive
         AND p.polroles = ARRAY['jale_admin'::regrole::oid]
         AND pg_get_expr(p.polqual, p.polrelid) = pol.qual
         AND pg_get_expr(p.polwithcheck, p.polrelid) IS NOT DISTINCT FROM pol.chk
    ) THEN
      RAISE EXCEPTION 'migration 117: policy % on % missing or drifted; a 2d section, the backfill or the status timeline would break', pol.name, pol.rel;
    END IF;
  END LOOP;

  -- The backfill reads the audit trail as jale_admin (026's shared read).
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.admin_audit_log'::regclass
       AND p.polname = 'admin_audit_log_select'
       AND p.polcmd = 'r'
       AND p.polpermissive
       AND 'jale_admin'::regrole::oid = ANY (p.polroles)
       AND pg_get_expr(p.polqual, p.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION 'migration 117: policy admin_audit_log_select missing or drifted; the backfill would read no audit rows';
  END IF;

  -- The timeline trigger runs as jale_admin; a failed insert would roll back
  -- every status change.
  IF NOT has_table_privilege('jale_admin', 'public.admin_case_events', 'INSERT') THEN
    RAISE EXCEPTION 'migration 117: jale_admin cannot insert admin_case_events; every status change would fail';
  END IF;

  -- A RESTRICTIVE SELECT (or ALL) policy is AND'ed with every policy above,
  -- so one that applies to jale_admin on any table read here could hide rows
  -- just as silently: one for jale_admin, for PUBLIC (role 0), or for any
  -- role whose privileges jale_admin has (RLS applies those too:
  -- has_privs_of_role, i.e. pg_has_role USAGE; jale_admin is a non-inheriting
  -- MEMBER of every role it created, which RLS does not apply). A RESTRICTIVE
  -- INSERT, UPDATE or DELETE policy never filters a read, so only polcmd 'r'
  -- (SELECT) and '*' (ALL) count -- and on admin_case_events, which the
  -- timeline trigger writes (and the self-check below reads back), 'a'
  -- (INSERT) too: one would fail every status change.
  IF EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE ((p.polrelid IN ('public.users'::regclass, 'public.worker_workflow_runs'::regclass,
                            'public.worker_workflow_transitions'::regclass,
                            'public.worker_reset_audit'::regclass, 'public.email_outbox'::regclass,
                            'public.employer_digest_settings'::regclass, 'public.admin_cases'::regclass,
                            'public.admin_audit_log'::regclass)
             AND p.polcmd IN ('r', '*'))
            OR (p.polrelid = 'public.admin_case_events'::regclass AND p.polcmd IN ('r', 'a', '*')))
       AND NOT p.polpermissive
       AND ('jale_admin'::regrole::oid = ANY (p.polroles) OR 0::OID = ANY (p.polroles)
            OR EXISTS (SELECT 1 FROM unnest(p.polroles) AS r(role_oid)
                        WHERE r.role_oid <> 0 AND pg_has_role('jale_admin', r.role_oid, 'USAGE')))
  ) THEN
    RAISE EXCEPTION 'migration 117: a restrictive policy for jale_admin, a role it inherits, or PUBLIC on a table 2d reads or writes; it would hide rows or fail status changes';
  END IF;
END $$;

-- ── When each case entered its current status ───────────────
ALTER TABLE public.admin_cases ADD COLUMN status_changed_at TIMESTAMPTZ;

-- The integration suite runs this exact statement (between the markers)
-- against fixtures, so keep it one statement.
-- BEGIN status_changed_at backfill
UPDATE public.admin_cases c
   SET status_changed_at = greatest(c.created_at, CASE
         WHEN c.status IN ('resolved', 'dismissed') THEN COALESCE(c.resolved_at, c.created_at)
         WHEN c.status = 'pending_worker' THEN COALESCE((
           SELECT min(a.created_at)
             FROM public.admin_audit_log a
            WHERE a.target_type IN ('admin_case', 'verification')
              AND a.target_id = c.id::text
              AND a.action IN ('request_more_info', 'reply_whatsapp', 'reset_verification_step')
         ), c.created_at)
         ELSE c.created_at
       END);
-- END status_changed_at backfill

ALTER TABLE public.admin_cases
  ALTER COLUMN status_changed_at SET DEFAULT now(),
  ALTER COLUMN status_changed_at SET NOT NULL;

-- ── Status triggers ─────────────────────────────────────────
-- Stamps the time of a real status change. Reads nothing, so it runs as the
-- writer (no definer needed).
CREATE FUNCTION public.admin_cases_stamp_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.status_changed_at := now();
  RETURN NEW;
END $$;

-- Writes the "Status changed" timeline event. A definer (the roadmap rule
-- for capture triggers): the console, a callback or a bastion session all
-- write the event through jale_admin's policy. Errors are not caught: a
-- failed event rolls the status change back. The arrow is U+2192.
CREATE FUNCTION public.admin_cases_record_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload)
  VALUES (
    NEW.id,
    'status_changed',
    CASE WHEN session_user = 'jale_admin_console' THEN 'admin' ELSE 'system' END,
    NULL,
    jsonb_build_object(
      'title', 'Status changed',
      'detail', CASE OLD.status WHEN 'open' THEN 'Open'
                                WHEN 'pending_worker' THEN 'Pending worker'
                                WHEN 'pending_admin' THEN 'Pending admin'
                                WHEN 'resolved' THEN 'Resolved'
                                WHEN 'dismissed' THEN 'Dismissed'
                                ELSE OLD.status END
                || U&' \2192 '
                || CASE NEW.status WHEN 'open' THEN 'Open'
                                   WHEN 'pending_worker' THEN 'Pending worker'
                                   WHEN 'pending_admin' THEN 'Pending admin'
                                   WHEN 'resolved' THEN 'Resolved'
                                   WHEN 'dismissed' THEN 'Dismissed'
                                   ELSE NEW.status END,
      'from', OLD.status,
      'to', NEW.status));
  RETURN NULL;
END $$;

CREATE TRIGGER admin_cases_stamp_status_change
  BEFORE UPDATE OF status ON public.admin_cases
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.admin_cases_stamp_status_change();

CREATE TRIGGER admin_cases_record_status_change
  AFTER UPDATE OF status ON public.admin_cases
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.admin_cases_record_status_change();

-- ── employer_digest_settings: 089's gated read ──────────────
-- SELECT-only, for jale_admin, true only while a definer below has opened
-- the transaction-local flag. The predicate reads no table, so it adds no
-- policy recursion.
CREATE POLICY employer_digest_settings_admin_analytics_read
  ON public.employer_digest_settings FOR SELECT
  TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

-- ── Start over and back, by step ────────────────────────────
CREATE FUNCTION public.admin_analytics_onboarding_restarts(p_weeks INTEGER)
RETURNS TABLE (
  week_start      TIMESTAMPTZ,
  door            TEXT,
  step_key        TEXT,
  reached         BIGINT,
  restart_workers BIGINT,
  restart_presses BIGINT,
  back_workers    BIGINT,
  back_presses    BIGINT
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
  WITH steps(step_key, ord) AS (
    VALUES ('start.choose_language', 1), ('identity.verify_otp', 2), ('legal.review', 3),
           ('profile.voice_choice', 4), ('profile.voice_processing', 5), ('profile.name', 6),
           ('profile.location', 7), ('profile.trade', 8), ('profile.custom_trade', 9),
           ('profile.experience', 10), ('profile.transportation', 11), ('profile.availability', 12),
           ('trust.question.1', 13), ('trust.question.2', 14), ('trust.question.3', 15),
           ('profile.photo', 16), ('profile.photo_type', 17)
  ), doors(door, ord) AS (
    VALUES ('all', 1), ('whatsapp', 2), ('web', 3)
  ), run_doors AS (
    -- The door that created each run, by presence over all its rows (also
    -- before the window): both doors write it and a Terms skip in one
    -- transaction, so order cannot decide (113). A run with neither is not
    -- listed here and counts only under 'all'.
    SELECT t.run_id,
           CASE WHEN bool_or(t.reason = 'otp_verified') THEN 'whatsapp' ELSE 'web' END AS d
      FROM public.worker_workflow_transitions t
     WHERE t.reason IN ('otp_verified', 'web_start')
     GROUP BY t.run_id
  ), bypass_users AS (
    SELECT DISTINCT r.user_id
      FROM public.worker_workflow_runs r
      JOIN public.worker_workflow_transitions t ON t.run_id = r.id
     WHERE t.reason = 'web_worker_bypass'
  ), moves AS (
    -- One fact per in-window move: started over or went back from the step
    -- the worker left, or arrived at a step. Voice-note retry loops are
    -- system moves, neither.
    SELECT date_trunc('week', t.created_at, 'UTC') AS wk,
           t.run_id,
           CASE WHEN t.reason = 'worker_restart' THEN 'restart'
                WHEN t.reason IN ('worker_back', 'worker_back_web') THEN 'back'
                ELSE 'arrived'
           END AS kind,
           CASE WHEN t.reason IN ('worker_restart', 'worker_back', 'worker_back_web') THEN t.from_step_key
                ELSE t.to_step_key
           END AS step
      FROM public.worker_workflow_transitions t
     WHERE t.created_at >= v_from
       AND t.reason !~ '_retry_offered$'
  ), facts AS (
    -- Each move counts under its run's door and under 'all'.
    SELECT m.wk, d.door, m.step, r.user_id, m.kind
      FROM moves m
      JOIN steps s ON s.step_key = m.step
      JOIN public.worker_workflow_runs r ON r.id = m.run_id
      LEFT JOIN run_doors rd ON rd.run_id = m.run_id
      CROSS JOIN LATERAL (VALUES ('all'), (rd.d)) AS d(door)
     WHERE d.door IS NOT NULL
       AND r.user_id NOT IN (SELECT b.user_id FROM bypass_users b)
  ), agg AS (
    -- (week, door, step) and the whole window per (door, step); the
    -- all-steps rows (step NULL) per (week, door) and per door. A worker was
    -- at a step when they arrived at it or pressed from it, so reached
    -- counts every worker of the group. Every group holds at least one fact,
    -- so every row has a non-zero count.
    SELECT f.wk,
           f.door,
           f.step,
           count(DISTINCT f.user_id) AS n_reached,
           count(DISTINCT f.user_id) FILTER (WHERE f.kind = 'restart') AS n_restart_workers,
           count(*) FILTER (WHERE f.kind = 'restart') AS n_restart_presses,
           count(DISTINCT f.user_id) FILTER (WHERE f.kind = 'back') AS n_back_workers,
           count(*) FILTER (WHERE f.kind = 'back') AS n_back_presses
      FROM facts f
     GROUP BY GROUPING SETS ((f.wk, f.door, f.step), (f.door, f.step), (f.wk, f.door), (f.door))
  )
  SELECT a.wk,
         a.door,
         a.step,
         a.n_reached,
         a.n_restart_workers,
         a.n_restart_presses,
         a.n_back_workers,
         a.n_back_presses
    FROM agg a
    JOIN doors d ON d.door = a.door
    -- The all-steps row (step NULL) first in each group, then 113's order.
    LEFT JOIN steps s ON s.step_key = a.step
   ORDER BY a.wk NULLS LAST, d.ord, s.ord NULLS FIRST;
END $$;

-- ── Operator resets ─────────────────────────────────────────
CREATE FUNCTION public.admin_analytics_operator_resets(p_weeks INTEGER)
RETURNS TABLE (
  week_start     TIMESTAMPTZ,
  reason         TEXT,
  workers        BIGINT,
  resets         BIGINT,
  bulk           BOOLEAN,
  run_started_at TIMESTAMPTZ
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

  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH audits AS (
    -- Every real reset, also before the window (a bulk run that began
    -- before it still marks its in-window resets). shown is the only form of
    -- the reason that leaves: trimmed; then, in this order, email-like
    -- tokens, UUID-shaped tokens, phone-like runs (a digit, 5+ digits or
    -- separators, a digit, an optional leading +; the separators include
    -- / and _) and any other 4+ digit run, each masked; cut to 80
    -- characters, never ending in a space.
    SELECT a.id,
           a.user_id,
           a.reason AS raw,
           COALESCE(NULLIF(rtrim(left(
                    regexp_replace(regexp_replace(regexp_replace(regexp_replace(btrim(a.reason),
                      '[^[:space:]]+@[^[:space:]]+', U&'\2022\2022\2022\2022', 'g'),
                      '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}', U&'\2022\2022\2022\2022', 'g'),
                      '\+?[0-9][0-9 ()./_-]{5,}[0-9]', U&'\2022\2022\2022\2022', 'g'),
                      '[0-9]{4,}', U&'\2022\2022\2022\2022', 'g'), 80)), ''),
                    '(no reason)') AS shown,
           a.created_at,
           lag(a.created_at) OVER (PARTITION BY a.reason, a.user_id ORDER BY a.created_at, a.id) AS prev_at
      FROM public.worker_reset_audit a
     WHERE NOT a.dry_run
  ), repeats AS (
    -- A worker reset again with the same reason within the hour: the only
    -- rows a one-hour span can hold twice.
    SELECT x.raw, x.created_at, x.prev_at
      FROM audits x
     WHERE x.prev_at >= x.created_at - interval '1 hour'
  ), starts AS (
    -- Each reset as the start of a span [t, t + 1 hour]: the resets in it.
    SELECT x.id, x.user_id, x.raw, x.shown, x.created_at,
           count(*) OVER (PARTITION BY x.raw ORDER BY x.created_at
                          RANGE BETWEEN CURRENT ROW AND interval '1 hour' FOLLOWING) AS span_rows
      FROM audits x
  ), doubles AS (
    -- Per span, the repeats whose earlier reset of that worker is in the
    -- span too: each would count its worker twice. A join on the reason, not
    -- a probe per span, so the plan stays linear in practice (repeats are
    -- rare) and its estimate small.
    SELECT st.id, count(*) AS n
      FROM starts st
      JOIN repeats p ON p.raw = st.raw
                    AND p.prev_at >= st.created_at
                    AND p.created_at >= st.created_at
                    AND p.created_at <= st.created_at + interval '1 hour'
     GROUP BY st.id
  ), spans AS (
    -- Distinct workers per span (a window frame cannot count DISTINCT).
    SELECT st.id, st.user_id, st.raw, st.shown, st.created_at,
           st.span_rows - COALESCE(d.n, 0) AS span_workers
      FROM starts st
      LEFT JOIN doubles d ON d.id = st.id
  ), marked AS (
    -- Bulk: the latest span of 10+ distinct workers that starts at or before
    -- this reset ends at or after it.
    SELECT sp.id, sp.user_id, sp.raw, sp.shown, sp.created_at,
           COALESCE(max(sp.created_at) FILTER (WHERE sp.span_workers >= 10)
                      OVER (PARTITION BY sp.raw ORDER BY sp.created_at
                            RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                      >= sp.created_at - interval '1 hour', false) AS is_bulk
      FROM spans sp
  ), bulk_runs AS (
    -- Bulk resets of one reason less than an hour apart form one run.
    SELECT g.*, sum(g.new_run) OVER (PARTITION BY g.raw ORDER BY g.created_at, g.id
                                     ROWS UNBOUNDED PRECEDING) AS run_no
      FROM (
        SELECT m.*,
               CASE WHEN lag(m.created_at) OVER (PARTITION BY m.raw ORDER BY m.created_at, m.id)
                           > m.created_at - interval '1 hour'
                    THEN 0 ELSE 1 END AS new_run
          FROM marked m
         WHERE m.is_bulk
      ) g
  ), shown_rows AS (
    -- Only in-window resets are counted, bulk or not.
    SELECT date_trunc('week', m.created_at, 'UTC') AS wk,
           m.shown,
           count(DISTINCT m.user_id) AS n_workers,
           count(*) AS n_resets,
           false AS is_bulk,
           NULL::TIMESTAMPTZ AS started
      FROM marked m
     WHERE NOT m.is_bulk
       AND m.created_at >= v_from
     GROUP BY 1, 2
    UNION ALL
    SELECT date_trunc('week', min(b.created_at), 'UTC'),
           b.shown,
           count(DISTINCT b.user_id),
           count(*),
           true,
           min(b.created_at)
      FROM bulk_runs b
     WHERE b.created_at >= v_from
     GROUP BY b.raw, b.shown, b.run_no
  )
  SELECT o.wk, o.shown, o.n_workers, o.n_resets, o.is_bulk, o.started
    FROM shown_rows o
   ORDER BY o.is_bulk, o.wk, o.started, o.shown COLLATE "C";
END $$;

-- ── Applicant digest: adoption right now ────────────────────
CREATE FUNCTION public.admin_analytics_digest_adoption()
RETURNS TABLE (
  employers            BIGINT,
  digest_on            BIGINT,
  digest_on_with_email BIGINT
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
  SELECT count(*),
         count(*) FILTER (WHERE d.enabled),
         count(*) FILTER (WHERE d.enabled
                            AND u.email IS NOT NULL AND length(u.email) BETWEEN 3 AND 320 AND position('@' IN u.email) > 1)
    FROM public.users u
    -- The employer's settings row, by an index probe (a missing row is off).
    LEFT JOIN LATERAL (
      SELECT s.enabled
        FROM public.employer_digest_settings s
       WHERE s.employer_id = u.id
       LIMIT 1
    ) d ON true
   WHERE u.user_type = 'employer'
     AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false);
END $$;

-- ── Applicant digest: emails by week ────────────────────────
CREATE FUNCTION public.admin_analytics_digest_sends(p_weeks INTEGER)
RETURNS TABLE (
  week_start        TIMESTAMPTZ,
  emailed           BIGINT,
  sent              BIGINT,
  failed            BIGINT,
  unknown           BIGINT,
  in_progress       BIGINT,
  employers_reached BIGINT
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

  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH weeks AS (
    -- Every week of the window, plus NULL for the whole-window row.
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n)) AT TIME ZONE 'UTC' AS wk
      FROM generate_series(0, p_weeks - 1) AS g(n)
    UNION ALL
    SELECT NULL::TIMESTAMPTZ
  ), facts AS (
    SELECT date_trunc('week', o.created_at, 'UTC') AS wk,
           o.source_id AS employer,
           o.status,
           o.attempt_count
      FROM public.email_outbox o
      -- A non-test employer that still exists, by an index probe per email.
      CROSS JOIN LATERAL (
        SELECT 1
          FROM public.users u
         WHERE u.id = o.source_id
           AND u.user_type = 'employer'
           AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
         LIMIT 1
      ) e
     WHERE o.source_type = 'employer_digest'
       AND o.created_at >= v_from
  ), agg AS (
    SELECT f.wk,
           count(*) AS n_emailed,
           count(*) FILTER (WHERE f.status = 'sent') AS n_sent,
           count(*) FILTER (WHERE f.status = 'failed' AND f.attempt_count >= 5) AS n_failed,
           count(*) FILTER (WHERE f.status = 'send_unknown') AS n_unknown,
           count(*) FILTER (WHERE f.status = 'pending' OR (f.status = 'failed' AND f.attempt_count < 5)) AS n_in_progress,
           count(DISTINCT f.employer) FILTER (WHERE f.status = 'sent') AS n_reached
      FROM facts f
     GROUP BY GROUPING SETS ((f.wk), ())
  )
  SELECT w.wk,
         COALESCE(a.n_emailed, 0),
         COALESCE(a.n_sent, 0),
         COALESCE(a.n_failed, 0),
         COALESCE(a.n_unknown, 0),
         COALESCE(a.n_in_progress, 0),
         COALESCE(a.n_reached, 0)
    FROM weeks w
    -- The whole-window rows (wk NULL) join each other.
    LEFT JOIN agg a ON a.wk IS NOT DISTINCT FROM w.wk
   ORDER BY w.wk NULLS LAST;
END $$;

-- ── Ownership + ACL ─────────────────────────────────────────
-- The trigger functions are executable by no one but their owner: a
-- trigger fires whatever its function's EXECUTE grants.
ALTER FUNCTION public.admin_cases_stamp_status_change() OWNER TO jale_admin;
ALTER FUNCTION public.admin_cases_record_status_change() OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_onboarding_restarts(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_operator_resets(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_digest_adoption() OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_digest_sends(INTEGER) OWNER TO jale_admin;

REVOKE ALL ON FUNCTION public.admin_cases_stamp_status_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_cases_record_status_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_onboarding_restarts(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_operator_resets(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_digest_adoption() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_digest_sends(INTEGER) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_analytics_onboarding_restarts(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_operator_resets(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_digest_adoption() TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_digest_sends(INTEGER) TO jale_admin_console;

-- Fail closed if the column, a trigger, the policy or any function drifted
-- from the reviewed model, if the gate does not open, if bad input is
-- accepted, or if a status change does not stamp and record itself.
DO $$
DECLARE
  v_gate     CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;
  v_stamp    CONSTANT TEXT := $q$CREATE TRIGGER admin_cases_stamp_status_change BEFORE UPDATE OF status ON public.admin_cases FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION public.admin_cases_stamp_status_change()$q$;
  v_record   CONSTANT TEXT := $q$CREATE TRIGGER admin_cases_record_status_change AFTER UPDATE OF status ON public.admin_cases FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION public.admin_cases_record_status_change()$q$;
  v_sentinel CONSTANT TEXT := 'migration 117: smoke test done, rolling it back';
  fn         RECORD;
  fn_oid     OID;
  v_raised   BOOLEAN;
  v_arg      INTEGER;
  v_weekly   TEXT;
  v_case     UUID;
  v_ran      BOOLEAN := false;
  v_events   INTEGER;
BEGIN
  -- Names in the catalog checks below print schema-qualified whatever the
  -- applying role's search_path (this is the migration's last statement).
  SET LOCAL search_path = pg_catalog, pg_temp;

  -- The column: timestamptz, NOT NULL, DEFAULT now().
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
      JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.admin_cases'::regclass
       AND a.attname = 'status_changed_at'
       AND a.atttypid = 'timestamptz'::regtype
       AND a.attnotnull
       AND NOT a.attisdropped
       AND pg_get_expr(d.adbin, d.adrelid) = 'now()'
  ) THEN
    RAISE EXCEPTION 'migration 117: admin_cases.status_changed_at missing or drifted';
  END IF;

  -- Both triggers, exactly: timing, UPDATE OF status, the WHEN clause, the
  -- function, enabled.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.admin_cases'::regclass
       AND t.tgname = 'admin_cases_stamp_status_change'
       AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = v_stamp
  ) THEN
    RAISE EXCEPTION 'migration 117: trigger admin_cases_stamp_status_change missing or drifted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.admin_cases'::regclass
       AND t.tgname = 'admin_cases_record_status_change'
       AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = v_record
  ) THEN
    RAISE EXCEPTION 'migration 117: trigger admin_cases_record_status_change missing or drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.employer_digest_settings'::regclass
       AND p.polname = 'employer_digest_settings_admin_analytics_read'
       AND p.polcmd = 'r'
       AND p.polpermissive
       AND p.polroles = ARRAY['jale_admin'::regrole::oid]
       AND pg_get_expr(p.polqual, p.polrelid) = v_gate
       AND p.polwithcheck IS NULL
  ) THEN
    RAISE EXCEPTION 'migration 117: policy employer_digest_settings_admin_analytics_read missing or drifted; digest adoption would read zero rows';
  END IF;

  FOR fn IN
    SELECT * FROM (VALUES
      ('public.admin_analytics_onboarding_restarts(integer)',
       'TABLE(week_start timestamp with time zone, door text, step_key text, reached bigint, restart_workers bigint, restart_presses bigint, back_workers bigint, back_presses bigint)',
       true, true),
      ('public.admin_analytics_operator_resets(integer)',
       'TABLE(week_start timestamp with time zone, reason text, workers bigint, resets bigint, bulk boolean, run_started_at timestamp with time zone)',
       true, true),
      ('public.admin_analytics_digest_adoption()',
       'TABLE(employers bigint, digest_on bigint, digest_on_with_email bigint)',
       true, true),
      ('public.admin_analytics_digest_sends(integer)',
       'TABLE(week_start timestamp with time zone, emailed bigint, sent bigint, failed bigint, unknown bigint, in_progress bigint, employers_reached bigint)',
       true, true),
      ('public.admin_cases_record_status_change()', 'trigger', true, false),
      ('public.admin_cases_stamp_status_change()', 'trigger', false, false)
    ) AS expected(sig, result, definer, console)
  LOOP
    fn_oid := to_regprocedure(fn.sig)::OID;
    IF fn_oid IS NULL THEN
      RAISE EXCEPTION 'migration 117: % missing', fn.sig;
    END IF;
    -- The exact columns the console maps, in order.
    IF pg_get_function_result(fn_oid) IS DISTINCT FROM fn.result THEN
      RAISE EXCEPTION 'migration 117: % result drifted', fn.sig;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = fn_oid
         AND p.proowner = 'jale_admin'::regrole::oid
         AND p.prosecdef = fn.definer
         -- A NULL proconfig (no pinned search_path) must fail, not skip.
         AND COALESCE(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false)
    ) THEN
      RAISE EXCEPTION 'migration 117: % owner/secdef/search_path wrong', fn.sig;
    END IF;
    IF has_function_privilege('jale_admin_console', fn_oid, 'EXECUTE') IS DISTINCT FROM fn.console THEN
      RAISE EXCEPTION 'migration 117: % EXECUTE for jale_admin_console drifted', fn.sig;
    END IF;
    -- Exactly the owner (and, for a read function, the console) may execute;
    -- PUBLIC is grantee 0.
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
         AND a.grantee <> p.proowner
         AND NOT (fn.console AND a.grantee = 'jale_admin_console'::regrole::oid)
    ) THEN
      RAISE EXCEPTION 'migration 117: % executable by a role other than its owner and the console', fn.sig;
    END IF;
  END LOOP;

  -- 098's pattern: clear the gate before EACH call and read it back. Each
  -- call also plans its whole query, so a wrong table or column fails here.
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_onboarding_restarts(4);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 117: admin_analytics_onboarding_restarts did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_operator_resets(4);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 117: admin_analytics_operator_resets did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_digest_adoption();
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 117: admin_analytics_digest_adoption did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_digest_sends(4);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 117: admin_analytics_digest_sends did not set the read flag';
  END IF;

  FOREACH v_weekly IN ARRAY ARRAY[
    'admin_analytics_onboarding_restarts', 'admin_analytics_operator_resets', 'admin_analytics_digest_sends'
  ] LOOP
    FOREACH v_arg IN ARRAY ARRAY[0, 27] LOOP
      BEGIN
        EXECUTE format('SELECT * FROM public.%I($1)', v_weekly) USING v_arg;
        v_raised := false;
      EXCEPTION WHEN raise_exception THEN
        v_raised := SQLERRM = 'admin_analytics_invalid_weeks';
      END;
      IF NOT v_raised THEN
        RAISE EXCEPTION 'migration 117: %(%) did not reject the window', v_weekly, v_arg;
      END IF;
    END LOOP;
  END LOOP;

  -- Smoke test: a throwaway case changes status once in place and once for
  -- real. Everything it writes is undone by raising the sentinel inside this
  -- sub-block (a subtransaction) and catching only that; any other error,
  -- including a failed check below, aborts the migration.
  BEGIN
    INSERT INTO public.admin_cases (case_type, status, priority, summary)
    VALUES ('help_request', 'open', 50, 'migration 117 self-check')
    RETURNING id INTO v_case;
    UPDATE public.admin_cases SET status_changed_at = now() - interval '1 day' WHERE id = v_case;

    -- Same status: neither trigger fires.
    UPDATE public.admin_cases SET status = 'open' WHERE id = v_case;
    SELECT count(*) INTO v_events FROM public.admin_case_events e WHERE e.case_id = v_case;
    IF v_events <> 0 OR NOT EXISTS (
      SELECT 1 FROM public.admin_cases c WHERE c.id = v_case AND c.status_changed_at = now() - interval '1 day'
    ) THEN
      RAISE EXCEPTION 'migration 117: a same-status update stamped the case or wrote an event';
    END IF;

    -- A real change: stamped now, and exactly one event, as 'system' (this
    -- session is not the console).
    UPDATE public.admin_cases SET status = 'pending_worker' WHERE id = v_case;
    IF NOT EXISTS (
      SELECT 1 FROM public.admin_cases c WHERE c.id = v_case AND c.status_changed_at = now()
    ) THEN
      RAISE EXCEPTION 'migration 117: a status change did not stamp status_changed_at';
    END IF;
    SELECT count(*) INTO v_events FROM public.admin_case_events e WHERE e.case_id = v_case;
    IF v_events <> 1 OR NOT EXISTS (
      SELECT 1 FROM public.admin_case_events e
       WHERE e.case_id = v_case
         AND e.event_type = 'status_changed'
         AND e.actor_type = 'system'
         AND e.actor_id IS NULL
         AND e.created_at = now()
         AND e.payload = jsonb_build_object('title', 'Status changed', 'detail', U&'Open \2192 Pending worker',
                                            'from', 'open', 'to', 'pending_worker')
    ) THEN
      RAISE EXCEPTION 'migration 117: a status change did not write exactly one status_changed event';
    END IF;

    v_ran := true;
    RAISE EXCEPTION USING MESSAGE = v_sentinel;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM IS DISTINCT FROM v_sentinel THEN
      RAISE;
    END IF;
  END;
  IF NOT v_ran OR EXISTS (SELECT 1 FROM public.admin_cases c WHERE c.id = v_case)
     OR EXISTS (SELECT 1 FROM public.admin_case_events e WHERE e.case_id = v_case) THEN
    RAISE EXCEPTION 'migration 117: the trigger smoke test did not run or left rows behind';
  END IF;
END $$;

COMMIT;
