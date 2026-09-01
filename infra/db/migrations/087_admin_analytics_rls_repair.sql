-- ============================================================
-- 087_admin_analytics_rls_repair.sql
-- Run manually AFTER 086_admin_analytics.sql, connected as jale_admin (NOT the
-- RDS master user). Forward-only (ADR-005) — 086 is committed and is NOT edited.
--
-- DEFECT REPAIRED
-- 086's five SECURITY DEFINER functions are owned by jale_admin, whose
-- rolbypassrls attribute is false (020b documents why: the RDS master user is a
-- member of rds_superuser, but role ATTRIBUTES such as BYPASSRLS do not inherit
-- through role membership). Their source tables — users, jobs, job_applications,
-- subscriptions, job_conversation_messages — all carry FORCE ROW LEVEL SECURITY,
-- which subjects the table OWNER to RLS as well. No existing policy matches a
-- definer session (users_isolation_select, for example, is
-- `cognito_sub = current_setting('app.current_user_id', true)`, and the analytics
-- functions never set that GUC), so every one of those reads returned ZERO rows.
--
-- The failure was silent: no error, just zeros. 086's own DO block did not catch
-- it because PERFORM validates column/table references but asserts nothing about
-- row counts — zero rows is a perfectly successful PERFORM. Only the two
-- whatsapp_* tables (relforcerowsecurity = false, so the owner is exempt)
-- returned real data, which is exactly why the Analytics tab would have rendered
-- correct WhatsApp counters beside zeros for every other metric.
--
-- FIX — the repo's established GUC-gated definer pattern (031_employer_display_name,
-- itself following 027's reconcile_worker_signup; see also the *_definer policies
-- from 020b/042/043): each analytics function flips a transaction-local flag as its
-- first statement, and a permissive SELECT policy scoped TO jale_admin makes rows
-- visible only while that flag is set. Because the flag is set with is_local => true
-- and is flipped ONLY inside these definer bodies, ordinary jale_admin sessions
-- (employer/worker web traffic) are unaffected: their existing isolation policies
-- still govern them, and permissive policies are OR'd.
--
-- NOT CHOSEN: granting jale_admin_console table SELECT on the source tables. That
-- would hand the least-privilege console role broad access to worker/employer PII
-- and defeat the entire point of routing it through aggregate-only definer
-- functions. This migration adds NO policy and NO table grant for the console
-- role — its only new capability is the five EXECUTE grants 086 already gave it,
-- re-asserted below.
--
-- admin_analytics_totals and admin_analytics_paying_employers are converted from
-- LANGUAGE sql to LANGUAGE plpgsql so they can PERFORM set_config first. Their
-- signatures and return types are unchanged, so CREATE OR REPLACE is legal and,
-- run as the same owner, preserves existing ACLs — the full ACL block is
-- re-asserted anyway so this file is self-contained and auditable.
-- ============================================================
BEGIN;

-- ── Gated read policies ─────────────────────────────────────
-- Exactly the five FORCE-RLS tables the analytics functions read. Scoped TO
-- jale_admin (the definer owner) and gated on the transaction-local flag, so
-- they are inert in every session that does not run one of the five functions.
-- Guarded by a pg_policy existence check so re-applying this file is a no-op
-- (026's idempotence style).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'users_admin_analytics_read'
       AND polrelid = 'public.users'::regclass
  ) THEN
    CREATE POLICY users_admin_analytics_read
      ON public.users FOR SELECT
      TO jale_admin
      USING (current_setting('app.admin_analytics_read', true) = 'on');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'jobs_admin_analytics_read'
       AND polrelid = 'public.jobs'::regclass
  ) THEN
    CREATE POLICY jobs_admin_analytics_read
      ON public.jobs FOR SELECT
      TO jale_admin
      USING (current_setting('app.admin_analytics_read', true) = 'on');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'job_applications_admin_analytics_read'
       AND polrelid = 'public.job_applications'::regclass
  ) THEN
    CREATE POLICY job_applications_admin_analytics_read
      ON public.job_applications FOR SELECT
      TO jale_admin
      USING (current_setting('app.admin_analytics_read', true) = 'on');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'subscriptions_admin_analytics_read'
       AND polrelid = 'public.subscriptions'::regclass
  ) THEN
    CREATE POLICY subscriptions_admin_analytics_read
      ON public.subscriptions FOR SELECT
      TO jale_admin
      USING (current_setting('app.admin_analytics_read', true) = 'on');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'job_conversation_messages_admin_analytics_read'
       AND polrelid = 'public.job_conversation_messages'::regclass
  ) THEN
    CREATE POLICY job_conversation_messages_admin_analytics_read
      ON public.job_conversation_messages FOR SELECT
      TO jale_admin
      USING (current_setting('app.admin_analytics_read', true) = 'on');
  END IF;
END $$;

-- ── Totals snapshot ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_analytics_totals()
RETURNS TABLE (
  total_workers    BIGINT,
  total_employers  BIGINT,
  paying_employers BIGINT,
  jobs_active      BIGINT,
  jobs_paused      BIGINT,
  jobs_filled      BIGINT,
  jobs_closed      BIGINT
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
    (SELECT count(*) FROM public.jobs WHERE status = 'closed');
END $$;

-- ── Signups per bucket ──────────────────────────────────────
-- date_trunc's 3-arg form pins the bucket boundary to UTC regardless of the
-- connection's TimeZone GUC, since Task 4's TS layer merges buckets by exact
-- UTC ISO timestamp.
CREATE OR REPLACE FUNCTION public.admin_analytics_signups(
  p_from   TIMESTAMPTZ,
  p_bucket TEXT
)
RETURNS TABLE (
  bucket_start     TIMESTAMPTZ,
  worker_signups   BIGINT,
  employer_signups BIGINT
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
  SELECT date_trunc(p_bucket, u.created_at, 'UTC') AS bucket_start,
         count(*) FILTER (WHERE u.user_type = 'worker')   AS worker_signups,
         count(*) FILTER (WHERE u.user_type = 'employer') AS employer_signups
    FROM public.users u
   WHERE u.created_at >= p_from
   GROUP BY 1
   ORDER BY 1;
END $$;

-- ── Jobs posted + applications per bucket ───────────────────
CREATE OR REPLACE FUNCTION public.admin_analytics_jobs_activity(
  p_from   TIMESTAMPTZ,
  p_bucket TEXT
)
RETURNS TABLE (
  bucket_start           TIMESTAMPTZ,
  jobs_posted            BIGINT,
  applications_submitted BIGINT
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

  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  WITH job_buckets AS (
    SELECT date_trunc(p_bucket, j.created_at, 'UTC') AS b, count(*) AS jobs_posted
      FROM public.jobs j
     WHERE j.created_at >= p_from
     GROUP BY 1
  ), app_buckets AS (
    SELECT date_trunc(p_bucket, a.created_at, 'UTC') AS b, count(*) AS applications_submitted
      FROM public.job_applications a
     WHERE a.created_at >= p_from
     GROUP BY 1
  )
  SELECT COALESCE(jb.b, ab.b)                    AS bucket_start,
         COALESCE(jb.jobs_posted, 0)             AS jobs_posted,
         COALESCE(ab.applications_submitted, 0)  AS applications_submitted
    FROM job_buckets jb
    FULL OUTER JOIN app_buckets ab ON ab.b = jb.b
   ORDER BY 1;
END $$;

-- ── Message traffic per bucket ──────────────────────────────
-- In-app: job_conversation_messages by direction, failures by status.
-- WhatsApp: inbound = whatsapp_processed_messages (first_seen_at),
-- outbound + failures = whatsapp_outbox (created_at). The two whatsapp_* tables
-- are not FORCE RLS, so the owner already reads them without a gated policy.
CREATE OR REPLACE FUNCTION public.admin_analytics_message_traffic(
  p_from   TIMESTAMPTZ,
  p_bucket TEXT
)
RETURNS TABLE (
  bucket_start        TIMESTAMPTZ,
  job_messages_out    BIGINT,
  job_messages_in     BIGINT,
  job_messages_failed BIGINT,
  wa_inbound          BIGINT,
  wa_outbound         BIGINT,
  wa_failed           BIGINT
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

  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  WITH jm AS (
    SELECT date_trunc(p_bucket, m.created_at, 'UTC') AS b,
           count(*) FILTER (WHERE m.direction = 'outbound') AS out_count,
           count(*) FILTER (WHERE m.direction = 'inbound')  AS in_count,
           count(*) FILTER (WHERE m.status = 'failed')      AS failed_count
      FROM public.job_conversation_messages m
     WHERE m.created_at >= p_from
     GROUP BY 1
  ), wa_in AS (
    SELECT date_trunc(p_bucket, p.first_seen_at, 'UTC') AS b, count(*) AS inbound_count
      FROM public.whatsapp_processed_messages p
     WHERE p.first_seen_at >= p_from
     GROUP BY 1
  ), wa_out AS (
    SELECT date_trunc(p_bucket, o.created_at, 'UTC') AS b,
           count(*)                                    AS outbound_count,
           count(*) FILTER (WHERE o.status = 'failed') AS failed_count
      FROM public.whatsapp_outbox o
     WHERE o.created_at >= p_from
     GROUP BY 1
  )
  SELECT COALESCE(jm.b, wa_in.b, wa_out.b)   AS bucket_start,
         COALESCE(jm.out_count, 0)           AS job_messages_out,
         COALESCE(jm.in_count, 0)            AS job_messages_in,
         COALESCE(jm.failed_count, 0)        AS job_messages_failed,
         COALESCE(wa_in.inbound_count, 0)    AS wa_inbound,
         COALESCE(wa_out.outbound_count, 0)  AS wa_outbound,
         COALESCE(wa_out.failed_count, 0)    AS wa_failed
    FROM jm
    FULL OUTER JOIN wa_in  ON wa_in.b = jm.b
    FULL OUTER JOIN wa_out ON wa_out.b = COALESCE(jm.b, wa_in.b)
   ORDER BY 1;
END $$;

-- ── Paying employers list ───────────────────────────────────
-- Business identity only: employer_display_name() returns company_name
-- or 'Empleador' — never full_name/email (spec privacy rule). That helper is
-- itself a definer function with its own gated policy from 031, so it keeps
-- working unchanged.
CREATE OR REPLACE FUNCTION public.admin_analytics_paying_employers()
RETURNS TABLE (
  employer_id          UUID,
  display_name         TEXT,
  plan_code            TEXT,
  status               TEXT,
  current_period_end   TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  SELECT s.user_id,
         public.employer_display_name(s.user_id),
         s.plan_code,
         s.status,
         s.current_period_end,
         s.cancel_at_period_end
    FROM public.subscriptions s
   WHERE s.status IN ('active', 'trialing', 'past_due')
   ORDER BY public.employer_display_name(s.user_id) ASC, s.created_at ASC;
END $$;

-- ── Ownership + ACL lockdown ────────────────────────────────
-- Re-asserted verbatim from 086. CREATE OR REPLACE by the same owner preserves
-- ACLs, so these are no-ops on a database that already carries 086 — they are
-- restated so this file alone fully describes the reviewed privilege model.
ALTER FUNCTION public.admin_analytics_totals() OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_signups(TIMESTAMPTZ, TEXT) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_jobs_activity(TIMESTAMPTZ, TEXT) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_message_traffic(TIMESTAMPTZ, TEXT) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_paying_employers() OWNER TO jale_admin;

REVOKE ALL ON FUNCTION public.admin_analytics_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_signups(TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_jobs_activity(TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_message_traffic(TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_paying_employers() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_analytics_totals() TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_signups(TIMESTAMPTZ, TEXT) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_jobs_activity(TIMESTAMPTZ, TEXT) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_message_traffic(TIMESTAMPTZ, TEXT) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_paying_employers() TO jale_admin_console;

-- Fail closed if any function's definition or ACL differs from the reviewed
-- model (owner jale_admin, SECURITY DEFINER, pinned search_path, no PUBLIC
-- execute, console CAN execute), or if any of the five gated policies is
-- missing or has drifted off jale_admin / off SELECT. Each function is resolved
-- by its FULL signature via to_regprocedure (072's pattern) rather than by bare
-- proname, so an overload of the same name could never be mistaken for the
-- reviewed one.
DO $$
DECLARE
  fn_sig  TEXT;
  fn_oid  OID;
  fn      RECORD;
  pol     RECORD;
  pol_rec RECORD;
BEGIN
  FOR fn_sig IN
    SELECT unnest(ARRAY[
      'public.admin_analytics_totals()',
      'public.admin_analytics_signups(timestamptz, text)',
      'public.admin_analytics_jobs_activity(timestamptz, text)',
      'public.admin_analytics_message_traffic(timestamptz, text)',
      'public.admin_analytics_paying_employers()'
    ])
  LOOP
    fn_oid := to_regprocedure(fn_sig)::OID;

    IF fn_oid IS NULL THEN
      RAISE EXCEPTION 'admin_analytics repair check: % missing', fn_sig;
    END IF;

    SELECT owner.rolname AS owner_name, p.prosecdef, p.proconfig
      INTO fn
      FROM pg_proc p
      JOIN pg_roles owner ON owner.oid = p.proowner
     WHERE p.oid = fn_oid;

    IF fn.owner_name <> 'jale_admin' OR NOT fn.prosecdef THEN
      RAISE EXCEPTION 'admin_analytics repair check: % owner/secdef wrong', fn_sig;
    END IF;
    IF NOT (fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
      RAISE EXCEPTION 'admin_analytics repair check: % search_path not pinned', fn_sig;
    END IF;
    IF has_function_privilege('public', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'admin_analytics repair check: % executable by PUBLIC', fn_sig;
    END IF;
    IF NOT has_function_privilege('jale_admin_console', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'admin_analytics repair check: % not executable by console', fn_sig;
    END IF;
  END LOOP;

  -- Every gated policy must exist, be a SELECT policy, be permissive, be
  -- scoped to exactly jale_admin — never to the console role — and gate on
  -- exactly the analytics flag, so a pre-existing same-name policy with a
  -- different (e.g. USING (true)) predicate cannot silently pass this check.
  FOR pol IN
    SELECT * FROM (VALUES
      ('users',                     'users_admin_analytics_read'),
      ('jobs',                      'jobs_admin_analytics_read'),
      ('job_applications',          'job_applications_admin_analytics_read'),
      ('subscriptions',             'subscriptions_admin_analytics_read'),
      ('job_conversation_messages', 'job_conversation_messages_admin_analytics_read')
    ) AS t(tbl, polname)
  LOOP
    SELECT p.polcmd, p.polpermissive, p.polroles, p.polrelid,
           pg_get_expr(p.polqual, p.polrelid) AS polqual_expr
      INTO pol_rec
      FROM pg_policy p
     WHERE p.polname = pol.polname
       AND p.polrelid = format('public.%I', pol.tbl)::regclass;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'admin_analytics repair check: policy % on % missing', pol.polname, pol.tbl;
    END IF;
    IF pol_rec.polcmd <> 'r' OR NOT pol_rec.polpermissive THEN
      RAISE EXCEPTION 'admin_analytics repair check: policy % on % is not a permissive SELECT policy', pol.polname, pol.tbl;
    END IF;
    IF pol_rec.polroles IS DISTINCT FROM ARRAY['jale_admin'::regrole::oid] THEN
      RAISE EXCEPTION 'admin_analytics repair check: policy % on % is not scoped to exactly jale_admin', pol.polname, pol.tbl;
    END IF;
    IF pol_rec.polqual_expr IS DISTINCT FROM $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$ THEN
      RAISE EXCEPTION 'admin_analytics repair check: policy % on % predicate has drifted', pol.polname, pol.tbl;
    END IF;
  END LOOP;

  -- Smoke-execute every function. Unlike 086's block, these calls must also
  -- prove the gate actually opens: with the fixture-free chain there may be no
  -- rows at all, so row counts cannot be asserted here — but the flag must be
  -- readable back as 'on' after a call, which is what regressed.
  PERFORM * FROM public.admin_analytics_totals();
  PERFORM * FROM public.admin_analytics_signups(now(), 'day');
  PERFORM * FROM public.admin_analytics_jobs_activity(now(), 'day');
  PERFORM * FROM public.admin_analytics_message_traffic(now(), 'day');
  PERFORM * FROM public.admin_analytics_paying_employers();

  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'admin_analytics repair check: definer bodies did not set the read flag';
  END IF;
END $$;

COMMIT;
