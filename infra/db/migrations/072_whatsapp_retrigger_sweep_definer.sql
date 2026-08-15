-- ============================================================
-- 072_whatsapp_retrigger_sweep_definer.sql
-- Run manually AFTER 071_wage_references.sql, connected as
-- jale_admin (NOT the RDS master user). Forward-only (ADR-005).
--
-- Stranded-intent repair (spec 2026-08-13-whatsapp-employer-delivery):
-- workers made lifecycle='ready' without a worker.ready domain event (e.g.
-- the migration-053 web-worker bypass) hold deferred business intents
-- forever — the recovery sweep only ran from a manual CLI. This definer
-- function lets a SCHEDULED Lambda, connected as jale_whatsapp (whose own
-- policies on these tables are worker-scoped), perform the cross-worker
-- sweep. SECURITY DEFINER + owner jale_admin passes the *_definer
-- USING(true) policies from migrations 042/043; the grant pattern mirrors
-- public.lease_worker_domain_events (042).
--
-- Semantics are identical to the TS sweep (delivery-retrigger-sweep.ts):
-- one worker.ready event per ready worker holding a deferred, unrendered
-- business-category intent, deduped per sweep generation by event_key.
-- Idempotency rests on the UNIQUE(event_key) + releaseWorkerReady's
-- FOR UPDATE SKIP LOCKED lease — repeated sweeps at worst enqueue no-op
-- events. Apply BEFORE deploying the sweep Lambda.
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.retrigger_deferred_ready_workers(
  p_sweep_run_id TEXT,
  p_limit INTEGER DEFAULT 500
)
RETURNS TABLE (workers_swept INTEGER, events_enqueued INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_sweep_run_id IS NULL OR btrim(p_sweep_run_id) = '' THEN
    RAISE EXCEPTION 'retrigger_sweep_invalid_run_id';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'retrigger_sweep_invalid_limit';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT DISTINCT s.user_id
      FROM public.worker_onboarding_state s
      JOIN public.worker_message_intents i ON i.user_id = s.user_id
     WHERE s.lifecycle = 'ready'
       AND i.status = 'deferred'
       AND i.outbox_id IS NULL
       AND i.category IN ('account', 'job_alert', 'employer_chat')
     ORDER BY s.user_id
     LIMIT p_limit
  ), inserted AS (
    INSERT INTO public.worker_domain_outbox (event_type, aggregate_id, event_key, payload)
    SELECT 'worker.ready',
           c.user_id,
           'worker.ready:sweep:' || c.user_id::text || ':' || p_sweep_run_id,
           '{}'::jsonb
      FROM candidates c
    ON CONFLICT (event_key) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*)::integer FROM candidates),
         (SELECT count(*)::integer FROM inserted);
END $$;

ALTER FUNCTION public.retrigger_deferred_ready_workers(TEXT, INTEGER) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.retrigger_deferred_ready_workers(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retrigger_deferred_ready_workers(TEXT, INTEGER) TO jale_whatsapp;

-- Fail closed if the definer's definition or ACL differs from the reviewed
-- model (owner, SECURITY DEFINER, pinned search_path, no PUBLIC execute,
-- jale_whatsapp CAN execute).
DO $$
DECLARE
  fn RECORD;
BEGIN
  SELECT owner.rolname AS owner_name, p.prosecdef, p.proconfig
    INTO fn
    FROM pg_proc p
    JOIN pg_roles owner ON owner.oid = p.proowner
   WHERE p.oid = to_regprocedure('public.retrigger_deferred_ready_workers(TEXT, INTEGER)');
  IF NOT FOUND OR fn.owner_name <> 'jale_admin'
     OR NOT fn.prosecdef
     OR fn.proconfig <> ARRAY['search_path=pg_catalog, pg_temp']::TEXT[] THEN
    RAISE EXCEPTION 'retrigger sweep definer definition invariant failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p,
         LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
     WHERE p.oid = to_regprocedure('public.retrigger_deferred_ready_workers(TEXT, INTEGER)')
       AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ) OR NOT has_function_privilege(
    'jale_whatsapp',
    'public.retrigger_deferred_ready_workers(TEXT, INTEGER)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'retrigger sweep definer ACL invariant failed';
  END IF;
END;
$$;

COMMIT;
