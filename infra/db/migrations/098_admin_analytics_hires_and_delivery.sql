-- ============================================================
-- 098_admin_analytics_hires_and_delivery.sql
-- Run manually AFTER 097_twilio_callback_job_message_outbox.sql, connected as
-- jale_admin (NOT the RDS master user). Forward-only (ADR-005) -- 088 and 089
-- are applied and are NOT edited.
--
-- Roadmap sub-project 1a
-- (docs/superpowers/specs/2026-10-01-admin-analytics-roadmap-design.md).
--
-- (1) admin_analytics_totals gains hires_total and jobs_with_hire.
--     jobs.status = 'filled' is written only by sync_job_hired_counts (029)
--     when hires reach number_of_workers_needed; employers cannot set it
--     (WRITABLE_JOB_STATUSES excludes it), and a filled job the employer then
--     closes becomes 'closed'. A 'filled' count says almost nothing about
--     hiring; hires and jobs-with-a-hire do. hires_total counts applications
--     EVER hired -- job_applications.hired_at IS NOT NULL (095: stamped once
--     on first hire by employer-application-status-update.ts and kept across
--     any later un-hire/re-hire, backfilled for rows hired before 095) -- so
--     an un-hire does not make a historical hire disappear from the "all
--     time" tile. jobs_with_hire stays CURRENT state, unchanged: jobs.
--     workers_hired > 0, maintained by sync_job_hired_counts (029) off
--     job_applications.status = 'hired', so an un-hired job drops out of it.
--     jobs_filled stays in the result so an admin build still on the old
--     mapping keeps working during the deploy window. The return type
--     changes, which CREATE OR REPLACE cannot do, so the function is dropped
--     and recreated inside this transaction and its ACL is re-granted below.
--
-- (2) admin_analytics_message_traffic counts the failures 089 missed. Same
--     signature and columns, so CREATE OR REPLACE keeps its ACL.
--       wa_failed:           status 'failed' or 'send_unknown' (an ambiguous
--                            send that is deliberately never retried), or a
--                            Twilio-reported 'failed'/'undelivered' on a row
--                            the app marked 'sent'.
--       job_messages_failed: 'failed' or 'undelivered' (028's status set).
--       job_messages_out:    excludes sender_type 'system' -- the "worker
--                            ended the conversation" row is stored with
--                            direction 'outbound' (lib/job-messaging.ts).
--
-- No new policies: jobs, job_applications and job_conversation_messages are
-- already gated by 089; whatsapp_outbox is not FORCE RLS.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the admin console build
-- that reads hires_total / jobs_with_hire. The old build reads the superset
-- result safely; the new build against 089's function would render NaN.
-- ============================================================
BEGIN;

-- ── Totals snapshot (return type changes) ───────────────────
DROP FUNCTION public.admin_analytics_totals();

CREATE FUNCTION public.admin_analytics_totals()
RETURNS TABLE (
  total_workers    BIGINT,
  total_employers  BIGINT,
  paying_employers BIGINT,
  jobs_active      BIGINT,
  jobs_paused      BIGINT,
  jobs_filled      BIGINT,
  jobs_closed      BIGINT,
  hires_total      BIGINT,
  jobs_with_hire   BIGINT
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
    (SELECT count(*) FROM public.jobs WHERE workers_hired > 0);
END $$;

-- ── Message traffic per bucket (signature unchanged) ────────
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

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  WITH jm AS (
    SELECT date_trunc(p_bucket, m.created_at, 'UTC') AS b,
           count(*) FILTER (WHERE m.direction = 'outbound' AND m.sender_type <> 'system') AS out_count,
           count(*) FILTER (WHERE m.direction = 'inbound')                                AS in_count,
           count(*) FILTER (WHERE m.status IN ('failed', 'undelivered'))                  AS failed_count
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
           count(*) AS outbound_count,
           count(*) FILTER (
             WHERE o.status IN ('failed', 'send_unknown')
                OR o.twilio_delivery_status IN ('failed', 'undelivered')
           ) AS failed_count
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

-- ── Ownership + ACL ─────────────────────────────────────────
-- The drop above discarded totals' ACL, so it MUST be re-granted here.
-- message_traffic's is restated so this file fully describes the model.
ALTER FUNCTION public.admin_analytics_totals() OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_message_traffic(TIMESTAMPTZ, TEXT) OWNER TO jale_admin;

REVOKE ALL ON FUNCTION public.admin_analytics_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_message_traffic(TIMESTAMPTZ, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_analytics_totals() TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_message_traffic(TIMESTAMPTZ, TEXT) TO jale_admin_console;

-- Fail closed if either function drifted from the reviewed model (089's
-- checks), if totals lost its new columns, or if the gate does not open.
DO $$
DECLARE
  fn_sig TEXT;
  fn_oid OID;
  fn     RECORD;
BEGIN
  FOR fn_sig IN
    SELECT unnest(ARRAY[
      'public.admin_analytics_totals()',
      'public.admin_analytics_message_traffic(timestamptz, text)'
    ])
  LOOP
    fn_oid := to_regprocedure(fn_sig)::OID;

    IF fn_oid IS NULL THEN
      RAISE EXCEPTION 'migration 098: % missing', fn_sig;
    END IF;

    SELECT owner.rolname AS owner_name, p.prosecdef, p.proconfig
      INTO fn
      FROM pg_proc p
      JOIN pg_roles owner ON owner.oid = p.proowner
     WHERE p.oid = fn_oid;

    IF fn.owner_name <> 'jale_admin' OR NOT fn.prosecdef THEN
      RAISE EXCEPTION 'migration 098: % owner/secdef wrong', fn_sig;
    END IF;
    IF NOT (fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
      RAISE EXCEPTION 'migration 098: % search_path not pinned', fn_sig;
    END IF;
    IF has_function_privilege('public', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 098: % executable by PUBLIC', fn_sig;
    END IF;
    IF NOT has_function_privilege('jale_admin_console', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 098: % not executable by console', fn_sig;
    END IF;
  END LOOP;

  IF pg_get_function_result(to_regprocedure('public.admin_analytics_totals()'))
       NOT LIKE '%hires_total bigint, jobs_with_hire bigint)' THEN
    RAISE EXCEPTION 'migration 098: admin_analytics_totals result lacks hires_total/jobs_with_hire';
  END IF;

  -- Reset the gate before EACH smoke call and check it back, individually --
  -- a single check after both calls would pass as soon as the FIRST function
  -- opened it, even if the second (message_traffic) body were missing its
  -- own set_config.
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_totals();
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 098: admin_analytics_totals did not set the read flag';
  END IF;

  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_message_traffic(now(), 'day');
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 098: admin_analytics_message_traffic did not set the read flag';
  END IF;
END $$;

COMMIT;
