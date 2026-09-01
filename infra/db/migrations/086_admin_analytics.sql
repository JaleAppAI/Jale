-- ============================================================
-- 086_admin_analytics.sql
-- Run manually AFTER 085_employer_trust_assessment_read.sql, connected as
-- jale_admin (NOT the RDS master user). Forward-only (ADR-005).
--
-- Admin console analytics (spec 2026-08-30-admin-analytics-design):
-- five SECURITY DEFINER aggregate functions so the least-privilege
-- jale_admin_console role can render the Analytics tab WITHOUT any
-- table grants on users/jobs/subscriptions/messaging tables. Owner
-- jale_admin; EXECUTE granted only to jale_admin_console. Functions
-- return aggregates and business display names only — no personal PII.
-- Grant/hardening pattern mirrors 072_whatsapp_retrigger_sweep_definer.
-- ============================================================
BEGIN;

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
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM public.users WHERE user_type = 'worker'),
    (SELECT count(*) FROM public.users WHERE user_type = 'employer'),
    (SELECT count(DISTINCT s.user_id) FROM public.subscriptions s
      WHERE s.status IN ('active', 'trialing', 'past_due')),
    (SELECT count(*) FROM public.jobs WHERE status = 'active'),
    (SELECT count(*) FROM public.jobs WHERE status = 'paused'),
    (SELECT count(*) FROM public.jobs WHERE status = 'filled'),
    (SELECT count(*) FROM public.jobs WHERE status = 'closed');
$$;

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
-- outbound + failures = whatsapp_outbox (created_at).
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
-- or 'Empleador' — never full_name/email (spec privacy rule).
CREATE OR REPLACE FUNCTION public.admin_analytics_paying_employers()
RETURNS TABLE (
  employer_id          UUID,
  display_name         TEXT,
  plan_code            TEXT,
  status               TEXT,
  current_period_end   TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.user_id,
         public.employer_display_name(s.user_id),
         s.plan_code,
         s.status,
         s.current_period_end,
         s.cancel_at_period_end
    FROM public.subscriptions s
   WHERE s.status IN ('active', 'trialing', 'past_due')
   ORDER BY public.employer_display_name(s.user_id) ASC, s.created_at ASC;
$$;

-- ── Ownership + ACL lockdown ────────────────────────────────
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
-- execute, jale_admin_console CAN execute). Each function is resolved by its
-- FULL signature via to_regprocedure (072's pattern) rather than by bare
-- proname, so an overload of the same name could never be mistaken for the
-- reviewed one. The block then smoke-executes every function: plpgsql
-- bodies are only syntax-checked at CREATE time, so RETURN QUERY referencing
-- a since-renamed column would otherwise apply cleanly here and only fail
-- when the console actually calls it.
DO $$
DECLARE
  fn_sig TEXT;
  fn_oid OID;
  fn     RECORD;
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
      RAISE EXCEPTION 'admin_analytics migration check: % missing', fn_sig;
    END IF;

    SELECT owner.rolname AS owner_name, p.prosecdef, p.proconfig
      INTO fn
      FROM pg_proc p
      JOIN pg_roles owner ON owner.oid = p.proowner
     WHERE p.oid = fn_oid;

    IF fn.owner_name <> 'jale_admin' OR NOT fn.prosecdef THEN
      RAISE EXCEPTION 'admin_analytics migration check: % owner/secdef wrong', fn_sig;
    END IF;
    IF NOT (fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
      RAISE EXCEPTION 'admin_analytics migration check: % search_path not pinned', fn_sig;
    END IF;
    IF has_function_privilege('public', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'admin_analytics migration check: % executable by PUBLIC', fn_sig;
    END IF;
    IF NOT has_function_privilege('jale_admin_console', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'admin_analytics migration check: % not executable by console', fn_sig;
    END IF;
  END LOOP;

  -- Smoke-execute every function so a broken column/table reference in a
  -- plpgsql body aborts this migration instead of surfacing later at
  -- console request time.
  PERFORM * FROM public.admin_analytics_totals();
  PERFORM * FROM public.admin_analytics_signups(now(), 'day');
  PERFORM * FROM public.admin_analytics_jobs_activity(now(), 'day');
  PERFORM * FROM public.admin_analytics_message_traffic(now(), 'day');
  PERFORM * FROM public.admin_analytics_paying_employers();
END $$;

COMMIT;
