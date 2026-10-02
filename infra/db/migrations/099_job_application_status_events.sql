-- ============================================================
-- 099_job_application_status_events.sql
-- Run manually AFTER 098_admin_analytics_hires_and_delivery.sql, connected as
-- jale_admin (NOT the RDS master user). Forward-only (ADR-005).
--
-- Roadmap sub-project 1d
-- (docs/superpowers/specs/2026-10-01-admin-analytics-1d-history-capture-design.md).
--
-- job_applications.status keeps only its current value (091 chose no history
-- table because stage gating runs on timestamps). This table records every
-- status change for analytics; nothing in the application reads it.
--
-- WRITE PATH: a definer trigger function owned by jale_admin, fired AFTER
-- INSERT and AFTER UPDATE OF status (only when status actually changes). The
-- employer API (jale_admin) and WhatsApp worker replies (jale_whatsapp) both
-- write job_applications.status; running as the owner makes the insert
-- succeed whichever role made the change. A move to 'hired' rejected by 091's
-- BEFORE guard aborts the statement, so no event is written. A trigger error
-- aborts the parent write -- deliberately: silently skipped history is the
-- defect this table fixes -- so the function does one INSERT and reads
-- nothing beyond NEW/OLD.
--
-- ACCESS: FORCE RLS. jale_admin may INSERT (the trigger's path) and may read
-- only while app.admin_analytics_read is 'on' (089's gate). No update or
-- delete policy, so no session can rewrite or remove rows through RLS. (The
-- owner keeps TRUNCATE and DDL rights, and any jale_admin session can append
-- rows through the insert policy; real tamper-proofing is not possible while
-- jale_admin owns the table.) ON DELETE CASCADE removes an application's
-- history with it (job hard-delete, worker reset); cascades are referential
-- actions and are not subject to RLS. No other role receives any privilege.
--
-- BACKFILL: one row per existing application, is_backfill = true, at its
-- current status; changed_at = hired_at for hired rows (095), else
-- updated_at. jale_admin is subject to FORCE RLS on job_applications, so the
-- backfill opens 089's gate for this transaction only. CREATE TRIGGER takes a
-- SHARE ROW EXCLUSIVE lock on job_applications, pausing writes until COMMIT,
-- which makes the self-check's count comparison race-free.
--
-- No application code depends on this table: there is no deploy order.
-- ============================================================
BEGIN;

-- Fail fast instead of queueing every parent-table write behind a stuck transaction; a timed-out apply writes no ledger row and can simply be rerun.
SET LOCAL lock_timeout = '5s';

-- 089's gate: lets this jale_admin session read job_applications (and the new
-- table) for the backfill and the self-check. Transaction-local.
SELECT set_config('app.admin_analytics_read', 'on', true);

-- Precondition: the backfill below depends on 089's gate policy reading
-- job_applications for this session. Assert it via pg_policy -- a catalog
-- table, so RLS itself never filters it -- instead of trusting the backfill's
-- own row count, which would be 0 = 0 and pass silently if the gate failed
-- to open (the 088-style defect 089 exists to repair).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.job_applications'::regclass
       AND polname = 'job_applications_admin_analytics_read'
       AND polcmd = 'r'
       AND polpermissive
       AND polroles = ARRAY['jale_admin'::regrole::oid]
       AND pg_get_expr(polqual, polrelid) = $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$
  ) THEN
    RAISE EXCEPTION 'migration 099: 089 gate policy on job_applications missing or drifted; the backfill would read zero rows';
  END IF;
END $$;

CREATE TABLE public.job_application_status_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES public.job_applications(id) ON DELETE CASCADE,
  job_id UUID NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_backfill BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX job_application_status_events_application_idx
  ON public.job_application_status_events (application_id, changed_at);
CREATE INDEX job_application_status_events_job_idx
  ON public.job_application_status_events (job_id, changed_at);

ALTER TABLE public.job_application_status_events OWNER TO jale_admin;
ALTER TABLE public.job_application_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_application_status_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_application_status_events FROM PUBLIC;

CREATE POLICY job_application_status_events_capture_insert
  ON public.job_application_status_events FOR INSERT
  TO jale_admin
  WITH CHECK (true);

CREATE POLICY job_application_status_events_admin_analytics_read
  ON public.job_application_status_events FOR SELECT
  TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

CREATE FUNCTION public.capture_job_application_status_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_from TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_from := OLD.status;
  END IF;

  INSERT INTO public.job_application_status_events (application_id, job_id, from_status, to_status)
  VALUES (NEW.id, NEW.job_id, v_from, NEW.status);

  RETURN NULL;
END $$;

ALTER FUNCTION public.capture_job_application_status_event() OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.capture_job_application_status_event() FROM PUBLIC;

CREATE TRIGGER job_application_status_events_on_insert
  AFTER INSERT ON public.job_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.capture_job_application_status_event();

CREATE TRIGGER job_application_status_events_on_update
  AFTER UPDATE OF status ON public.job_applications
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.capture_job_application_status_event();

-- ── Backfill ────────────────────────────────────────────────
INSERT INTO public.job_application_status_events (application_id, job_id, from_status, to_status, changed_at, is_backfill)
SELECT a.id,
       a.job_id,
       NULL,
       a.status,
       CASE WHEN a.status = 'hired' AND a.hired_at IS NOT NULL THEN a.hired_at ELSE a.updated_at END,
       true
  FROM public.job_applications a;

-- ── Fail-closed self-check ──────────────────────────────────
DO $$
DECLARE
  v_table   CONSTANT REGCLASS := 'public.job_application_status_events'::regclass;
  v_fn      OID := to_regprocedure('public.capture_job_application_status_event()')::OID;
  fn        RECORD;
  pol       RECORD;
  v_parent  BIGINT;
  v_backfill BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v_table
                  AND c.relrowsecurity AND c.relforcerowsecurity
                  AND pg_get_userbyid(c.relowner) = 'jale_admin') THEN
    RAISE EXCEPTION 'migration 099: table missing FORCE RLS or not owned by jale_admin';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
              WHERE c.oid = v_table AND a.grantee <> c.relowner) THEN
    RAISE EXCEPTION 'migration 099: table grants privileges beyond its owner';
  END IF;

  IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_table) <> 2 THEN
    RAISE EXCEPTION 'migration 099: expected exactly two policies';
  END IF;
  FOR pol IN
    SELECT p.polname, p.polcmd, p.polpermissive, p.polroles,
           pg_get_expr(p.polqual, p.polrelid) AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
      FROM pg_policy p WHERE p.polrelid = v_table
  LOOP
    IF NOT pol.polpermissive OR pol.polroles IS DISTINCT FROM ARRAY['jale_admin'::regrole::oid] THEN
      RAISE EXCEPTION 'migration 099: policy % is not a permissive jale_admin-only policy', pol.polname;
    END IF;
    IF pol.polname = 'job_application_status_events_capture_insert' THEN
      IF pol.polcmd <> 'a' OR pol.check_expr IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'migration 099: capture_insert policy drifted';
      END IF;
    ELSIF pol.polname = 'job_application_status_events_admin_analytics_read' THEN
      IF pol.polcmd <> 'r'
         OR pol.qual IS DISTINCT FROM $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$ THEN
        RAISE EXCEPTION 'migration 099: admin_analytics_read policy drifted';
      END IF;
    ELSE
      RAISE EXCEPTION 'migration 099: unexpected policy %', pol.polname;
    END IF;
  END LOOP;

  SELECT owner.rolname AS owner_name, p.prosecdef, p.proconfig INTO fn
    FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
   WHERE p.oid = v_fn;
  IF v_fn IS NULL OR fn.owner_name IS DISTINCT FROM 'jale_admin' OR NOT fn.prosecdef
     OR NOT (fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'migration 099: trigger function owner/secdef/search_path wrong';
  END IF;
  IF has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 099: trigger function executable by PUBLIC';
  END IF;

  -- tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE, 16 = UPDATE,
  -- 32 = TRUNCATE, 64 = INSTEAD.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.job_applications'::regclass
                    AND t.tgname = 'job_application_status_events_on_insert'
                    AND t.tgenabled = 'O' AND t.tgfoid = v_fn
                    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 4) = 4
                    AND (t.tgtype & 64) = 0 AND (t.tgtype & (8|16|32)) = 0) THEN
    RAISE EXCEPTION 'migration 099: AFTER INSERT ROW trigger missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.job_applications'::regclass
                    AND t.tgname = 'job_application_status_events_on_update'
                    AND t.tgenabled = 'O' AND t.tgfoid = v_fn AND t.tgqual IS NOT NULL
                    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 16) = 16
                    AND (t.tgtype & 64) = 0 AND (t.tgtype & (4|8|32)) = 0
                    AND (SELECT array_agg(x ORDER BY x) FROM unnest(t.tgattr::int2[]) AS x)
                        = (SELECT array_agg(a.attnum ORDER BY a.attnum) FROM pg_attribute a
                            WHERE a.attrelid = 'public.job_applications'::regclass
                              AND a.attname IN ('status'))) THEN
    RAISE EXCEPTION 'migration 099: AFTER UPDATE ROW trigger missing, disabled, without its WHEN clause, or not tracking exactly the expected columns';
  END IF;

  SELECT count(*) INTO v_parent FROM public.job_applications;
  SELECT count(*) INTO v_backfill FROM public.job_application_status_events WHERE is_backfill;
  IF v_parent <> v_backfill THEN
    RAISE EXCEPTION 'migration 099: backfill wrote % rows for % applications', v_backfill, v_parent;
  END IF;
END $$;

COMMIT;
