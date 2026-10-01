-- ============================================================
-- 100_subscription_status_history.sql
-- Run manually AFTER 099_job_application_status_events.sql, connected as
-- jale_admin (NOT the RDS master user). Forward-only (ADR-005).
--
-- Roadmap sub-project 1d
-- (docs/superpowers/specs/2026-10-01-admin-analytics-1d-history-capture-design.md).
--
-- subscriptions overwrites status, plan_code, and cancel_at_period_end in
-- place (infra/lambda/billing/processor.ts), so "paying employers as of week
-- X" cannot be reconstructed. This table records every change to those three
-- columns for analytics; nothing in the application reads it. Plan changes
-- and scheduled cancellations are captured now so the churn and plan-mix
-- charts need no further migration.
--
-- WRITE PATH: a definer trigger function owned by jale_admin, fired AFTER
-- INSERT and AFTER UPDATE OF status, plan_code, cancel_at_period_end (only
-- when one of them actually changes). The only writer is the billing
-- processor (jale_billing); its INSERT ... ON CONFLICT DO UPDATE upsert fires
-- the UPDATE trigger on conflict, not the INSERT one. A trigger error aborts
-- the parent write -- deliberately -- so the function does one INSERT and
-- reads nothing beyond NEW/OLD.
--
-- ACCESS: FORCE RLS. jale_admin may INSERT (the trigger's path) and may read
-- only while app.admin_analytics_read is 'on' (089's gate). No update or
-- delete policy, so no session can rewrite or remove rows through RLS. (The
-- owner keeps TRUNCATE and DDL rights, and any jale_admin session can append
-- rows through the insert policy; real tamper-proofing is not possible while
-- jale_admin owns the table.) ON DELETE CASCADE removes a subscription's
-- history with it (subscriptions are never deleted today). No other role
-- receives any privilege.
--
-- BACKFILL: one row per existing subscription, is_backfill = true, at its
-- current status/plan/cancellation; changed_at = created_at while the status
-- is not terminal, updated_at once canceled or incomplete_expired (so a
-- cancellation is not dated to the start). jale_admin is subject to FORCE RLS
-- on subscriptions, so the backfill opens 089's gate for this transaction
-- only. CREATE TRIGGER pauses writes to subscriptions until COMMIT, which
-- makes the self-check's count comparison race-free.
--
-- No application code depends on this table: there is no deploy order.
-- ============================================================
BEGIN;

-- Fail fast instead of queueing every parent-table write behind a stuck transaction; a timed-out apply writes no ledger row and can simply be rerun.
SET LOCAL lock_timeout = '5s';

-- 089's gate: lets this jale_admin session read subscriptions (and the new
-- table) for the backfill and the self-check. Transaction-local.
SELECT set_config('app.admin_analytics_read', 'on', true);

-- Precondition: the backfill below depends on 089's gate policy reading
-- subscriptions for this session. Assert it via pg_policy -- a catalog
-- table, so RLS itself never filters it -- instead of trusting the backfill's
-- own row count, which would be 0 = 0 and pass silently if the gate failed
-- to open (the 088-style defect 089 exists to repair).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.subscriptions'::regclass
       AND polname = 'subscriptions_admin_analytics_read'
       AND polcmd = 'r'
       AND polpermissive
       AND polroles = ARRAY['jale_admin'::regrole::oid]
       AND pg_get_expr(polqual, polrelid) = $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$
  ) THEN
    RAISE EXCEPTION 'migration 100: 089 gate policy on subscriptions missing or drifted; the backfill would read zero rows';
  END IF;
END $$;

CREATE TABLE public.subscription_status_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  plan_code TEXT NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_backfill BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX subscription_status_history_subscription_idx
  ON public.subscription_status_history (subscription_id, changed_at);
CREATE INDEX subscription_status_history_changed_idx
  ON public.subscription_status_history (changed_at);

ALTER TABLE public.subscription_status_history OWNER TO jale_admin;
ALTER TABLE public.subscription_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_status_history FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.subscription_status_history FROM PUBLIC;

CREATE POLICY subscription_status_history_capture_insert
  ON public.subscription_status_history FOR INSERT
  TO jale_admin
  WITH CHECK (true);

CREATE POLICY subscription_status_history_admin_analytics_read
  ON public.subscription_status_history FOR SELECT
  TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

CREATE FUNCTION public.capture_subscription_status_history()
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

  INSERT INTO public.subscription_status_history
    (subscription_id, user_id, from_status, to_status, plan_code, cancel_at_period_end)
  VALUES (NEW.id, NEW.user_id, v_from, NEW.status, NEW.plan_code, NEW.cancel_at_period_end);

  RETURN NULL;
END $$;

ALTER FUNCTION public.capture_subscription_status_history() OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.capture_subscription_status_history() FROM PUBLIC;

CREATE TRIGGER subscription_status_history_on_insert
  AFTER INSERT ON public.subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.capture_subscription_status_history();

CREATE TRIGGER subscription_status_history_on_update
  AFTER UPDATE OF status, plan_code, cancel_at_period_end ON public.subscriptions
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        OR OLD.plan_code IS DISTINCT FROM NEW.plan_code
        OR OLD.cancel_at_period_end IS DISTINCT FROM NEW.cancel_at_period_end)
  EXECUTE FUNCTION public.capture_subscription_status_history();

-- ── Backfill ────────────────────────────────────────────────
INSERT INTO public.subscription_status_history
  (subscription_id, user_id, from_status, to_status, plan_code, cancel_at_period_end, changed_at, is_backfill)
SELECT s.id,
       s.user_id,
       NULL,
       s.status,
       s.plan_code,
       s.cancel_at_period_end,
       CASE WHEN s.status IN ('canceled', 'incomplete_expired') THEN s.updated_at ELSE s.created_at END,
       true
  FROM public.subscriptions s;

-- ── Fail-closed self-check ──────────────────────────────────
DO $$
DECLARE
  v_table   CONSTANT REGCLASS := 'public.subscription_status_history'::regclass;
  v_fn      OID := to_regprocedure('public.capture_subscription_status_history()')::OID;
  fn        RECORD;
  pol       RECORD;
  v_parent  BIGINT;
  v_backfill BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v_table
                  AND c.relrowsecurity AND c.relforcerowsecurity
                  AND pg_get_userbyid(c.relowner) = 'jale_admin') THEN
    RAISE EXCEPTION 'migration 100: table missing FORCE RLS or not owned by jale_admin';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
              WHERE c.oid = v_table AND a.grantee <> c.relowner) THEN
    RAISE EXCEPTION 'migration 100: table grants privileges beyond its owner';
  END IF;

  IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_table) <> 2 THEN
    RAISE EXCEPTION 'migration 100: expected exactly two policies';
  END IF;
  FOR pol IN
    SELECT p.polname, p.polcmd, p.polpermissive, p.polroles,
           pg_get_expr(p.polqual, p.polrelid) AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
      FROM pg_policy p WHERE p.polrelid = v_table
  LOOP
    IF NOT pol.polpermissive OR pol.polroles IS DISTINCT FROM ARRAY['jale_admin'::regrole::oid] THEN
      RAISE EXCEPTION 'migration 100: policy % is not a permissive jale_admin-only policy', pol.polname;
    END IF;
    IF pol.polname = 'subscription_status_history_capture_insert' THEN
      IF pol.polcmd <> 'a' OR pol.check_expr IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'migration 100: capture_insert policy drifted';
      END IF;
    ELSIF pol.polname = 'subscription_status_history_admin_analytics_read' THEN
      IF pol.polcmd <> 'r'
         OR pol.qual IS DISTINCT FROM $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$ THEN
        RAISE EXCEPTION 'migration 100: admin_analytics_read policy drifted';
      END IF;
    ELSE
      RAISE EXCEPTION 'migration 100: unexpected policy %', pol.polname;
    END IF;
  END LOOP;

  SELECT owner.rolname AS owner_name, p.prosecdef, p.proconfig INTO fn
    FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
   WHERE p.oid = v_fn;
  IF v_fn IS NULL OR fn.owner_name IS DISTINCT FROM 'jale_admin' OR NOT fn.prosecdef
     OR NOT (fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'migration 100: trigger function owner/secdef/search_path wrong';
  END IF;
  IF has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 100: trigger function executable by PUBLIC';
  END IF;

  -- tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE, 16 = UPDATE,
  -- 32 = TRUNCATE, 64 = INSTEAD.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.subscriptions'::regclass
                    AND t.tgname = 'subscription_status_history_on_insert'
                    AND t.tgenabled = 'O' AND t.tgfoid = v_fn
                    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 4) = 4
                    AND (t.tgtype & 64) = 0 AND (t.tgtype & (8|16|32)) = 0) THEN
    RAISE EXCEPTION 'migration 100: AFTER INSERT ROW trigger missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.subscriptions'::regclass
                    AND t.tgname = 'subscription_status_history_on_update'
                    AND t.tgenabled = 'O' AND t.tgfoid = v_fn AND t.tgqual IS NOT NULL
                    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 16) = 16
                    AND (t.tgtype & 64) = 0 AND (t.tgtype & (4|8|32)) = 0
                    AND (SELECT array_agg(x ORDER BY x) FROM unnest(t.tgattr::int2[]) AS x)
                        = (SELECT array_agg(a.attnum ORDER BY a.attnum) FROM pg_attribute a
                            WHERE a.attrelid = 'public.subscriptions'::regclass
                              AND a.attname IN ('status', 'plan_code', 'cancel_at_period_end'))) THEN
    RAISE EXCEPTION 'migration 100: AFTER UPDATE ROW trigger missing, disabled, without its WHEN clause, or not tracking exactly the expected columns';
  END IF;

  SELECT count(*) INTO v_parent FROM public.subscriptions;
  SELECT count(*) INTO v_backfill FROM public.subscription_status_history WHERE is_backfill;
  IF v_parent <> v_backfill THEN
    RAISE EXCEPTION 'migration 100: backfill wrote % rows for % subscriptions', v_backfill, v_parent;
  END IF;
END $$;

COMMIT;
