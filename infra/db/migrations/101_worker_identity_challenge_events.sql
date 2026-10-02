-- ============================================================
-- 101_worker_identity_challenge_events.sql
-- Run manually AFTER 100_subscription_status_history.sql, connected as
-- jale_admin (NOT the RDS master user). Forward-only (ADR-005).
--
-- Roadmap sub-project 1d
-- (docs/superpowers/specs/2026-10-01-admin-analytics-1d-history-capture-design.md).
--
-- worker_identity_challenges overwrites attempts and the lock on every resend,
-- so lifetime attempts, lockouts, and time-to-verify cannot be measured. This
-- table records every change to status, attempts, and locked_until for
-- analytics; nothing in the application reads it. It references challenge_id
-- only: the unsalted phone hash stays in the source table (it is reversible
-- by brute force over the phone-number space) and is deleted with it.
--
-- WRITE PATH: a definer trigger function owned by jale_admin, fired AFTER
-- INSERT and AFTER UPDATE OF status, attempts, locked_until (only when one of
-- them actually changes). The writers are themselves definer functions
-- (save_worker_pre_auth and the bind functions: 042/046/047/087), which
-- insert a bare row and then update it; an update that leaves the tracked
-- columns unchanged writes nothing. A trigger error aborts the parent write
-- -- deliberately -- so the function does one INSERT and reads nothing beyond
-- NEW/OLD.
--
-- ACCESS: FORCE RLS. jale_admin may INSERT (the trigger's path) and may read
-- only while app.admin_analytics_read is 'on' (089's gate). No update or
-- delete policy, so no session can rewrite or remove rows through RLS. (The
-- owner keeps TRUNCATE and DDL rights, and any jale_admin session can append
-- rows through the insert policy; real tamper-proofing is not possible while
-- jale_admin owns the table.) ON DELETE CASCADE removes a challenge's
-- history with it (challenges cascade from users since 047, and the operator
-- reset deletes them). No other role receives any privilege.
--
-- BACKFILL: one row per existing challenge, is_backfill = true, at its current
-- status/attempts/lock, changed_at = updated_at. jale_admin already reads
-- worker_identity_challenges through 042's definer policy; the gate below is
-- for reading the new table in the self-check. CREATE TRIGGER pauses writes
-- to worker_identity_challenges until COMMIT, which makes the self-check's
-- count comparison race-free.
--
-- No application code depends on this table: there is no deploy order.
-- ============================================================
BEGIN;

-- Fail fast instead of queueing every parent-table write behind a stuck transaction; a timed-out apply writes no ledger row and can simply be rerun.
SET LOCAL lock_timeout = '5s';

-- 089's gate: lets this jale_admin session read the new table in the
-- self-check. Transaction-local.
SELECT set_config('app.admin_analytics_read', 'on', true);

-- Precondition: the backfill below depends on 042's definer policy reading
-- worker_identity_challenges for this session. Assert it via pg_policy -- a
-- catalog table, so RLS itself never filters it -- instead of trusting the
-- backfill's own row count, which would be 0 = 0 and pass silently if the
-- policy failed to open (the 088-style defect 089 exists to repair).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.worker_identity_challenges'::regclass
       AND polname = 'worker_identity_challenges_definer'
       AND polcmd = '*'
       AND polpermissive
       AND polroles = ARRAY['jale_admin'::regrole::oid]
       AND pg_get_expr(polqual, polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION 'migration 101: 042 definer policy on worker_identity_challenges missing or drifted; the backfill would read zero rows';
  END IF;
END $$;

CREATE TABLE public.worker_identity_challenge_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  challenge_id UUID NOT NULL REFERENCES public.worker_identity_challenges(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  locked_until TIMESTAMPTZ,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_backfill BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX worker_identity_challenge_events_challenge_idx
  ON public.worker_identity_challenge_events (challenge_id, changed_at);

ALTER TABLE public.worker_identity_challenge_events OWNER TO jale_admin;
ALTER TABLE public.worker_identity_challenge_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_identity_challenge_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.worker_identity_challenge_events FROM PUBLIC;

CREATE POLICY worker_identity_challenge_events_capture_insert
  ON public.worker_identity_challenge_events FOR INSERT
  TO jale_admin
  WITH CHECK (true);

CREATE POLICY worker_identity_challenge_events_admin_analytics_read
  ON public.worker_identity_challenge_events FOR SELECT
  TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

CREATE FUNCTION public.capture_worker_identity_challenge_event()
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

  INSERT INTO public.worker_identity_challenge_events
    (challenge_id, from_status, to_status, attempts, locked_until)
  VALUES (NEW.id, v_from, NEW.status, NEW.attempts, NEW.locked_until);

  RETURN NULL;
END $$;

ALTER FUNCTION public.capture_worker_identity_challenge_event() OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.capture_worker_identity_challenge_event() FROM PUBLIC;

CREATE TRIGGER worker_identity_challenge_events_on_insert
  AFTER INSERT ON public.worker_identity_challenges
  FOR EACH ROW
  EXECUTE FUNCTION public.capture_worker_identity_challenge_event();

CREATE TRIGGER worker_identity_challenge_events_on_update
  AFTER UPDATE OF status, attempts, locked_until ON public.worker_identity_challenges
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        OR OLD.attempts IS DISTINCT FROM NEW.attempts
        OR OLD.locked_until IS DISTINCT FROM NEW.locked_until)
  EXECUTE FUNCTION public.capture_worker_identity_challenge_event();

-- ── Backfill ────────────────────────────────────────────────
INSERT INTO public.worker_identity_challenge_events
  (challenge_id, from_status, to_status, attempts, locked_until, changed_at, is_backfill)
SELECT w.id, NULL, w.status, w.attempts, w.locked_until, w.updated_at, true
  FROM public.worker_identity_challenges w;

-- ── Fail-closed self-check ──────────────────────────────────
DO $$
DECLARE
  v_table   CONSTANT REGCLASS := 'public.worker_identity_challenge_events'::regclass;
  v_fn      OID := to_regprocedure('public.capture_worker_identity_challenge_event()')::OID;
  fn        RECORD;
  pol       RECORD;
  v_parent  BIGINT;
  v_backfill BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v_table
                  AND c.relrowsecurity AND c.relforcerowsecurity
                  AND pg_get_userbyid(c.relowner) = 'jale_admin') THEN
    RAISE EXCEPTION 'migration 101: table missing FORCE RLS or not owned by jale_admin';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
              WHERE c.oid = v_table AND a.grantee <> c.relowner) THEN
    RAISE EXCEPTION 'migration 101: table grants privileges beyond its owner';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = v_table AND a.attname = 'phone_hash' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'migration 101: history must not carry phone_hash';
  END IF;

  IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_table) <> 2 THEN
    RAISE EXCEPTION 'migration 101: expected exactly two policies';
  END IF;
  FOR pol IN
    SELECT p.polname, p.polcmd, p.polpermissive, p.polroles,
           pg_get_expr(p.polqual, p.polrelid) AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
      FROM pg_policy p WHERE p.polrelid = v_table
  LOOP
    IF NOT pol.polpermissive OR pol.polroles IS DISTINCT FROM ARRAY['jale_admin'::regrole::oid] THEN
      RAISE EXCEPTION 'migration 101: policy % is not a permissive jale_admin-only policy', pol.polname;
    END IF;
    IF pol.polname = 'worker_identity_challenge_events_capture_insert' THEN
      IF pol.polcmd <> 'a' OR pol.check_expr IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'migration 101: capture_insert policy drifted';
      END IF;
    ELSIF pol.polname = 'worker_identity_challenge_events_admin_analytics_read' THEN
      IF pol.polcmd <> 'r'
         OR pol.qual IS DISTINCT FROM $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$ THEN
        RAISE EXCEPTION 'migration 101: admin_analytics_read policy drifted';
      END IF;
    ELSE
      RAISE EXCEPTION 'migration 101: unexpected policy %', pol.polname;
    END IF;
  END LOOP;

  SELECT owner.rolname AS owner_name, p.prosecdef, p.proconfig INTO fn
    FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
   WHERE p.oid = v_fn;
  IF v_fn IS NULL OR fn.owner_name IS DISTINCT FROM 'jale_admin' OR NOT fn.prosecdef
     OR NOT (fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'migration 101: trigger function owner/secdef/search_path wrong';
  END IF;
  IF has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 101: trigger function executable by PUBLIC';
  END IF;

  -- tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE, 16 = UPDATE,
  -- 32 = TRUNCATE, 64 = INSTEAD.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.worker_identity_challenges'::regclass
                    AND t.tgname = 'worker_identity_challenge_events_on_insert'
                    AND t.tgenabled = 'O' AND t.tgfoid = v_fn
                    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 4) = 4
                    AND (t.tgtype & 64) = 0 AND (t.tgtype & (8|16|32)) = 0) THEN
    RAISE EXCEPTION 'migration 101: AFTER INSERT ROW trigger missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.worker_identity_challenges'::regclass
                    AND t.tgname = 'worker_identity_challenge_events_on_update'
                    AND t.tgenabled = 'O' AND t.tgfoid = v_fn AND t.tgqual IS NOT NULL
                    AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 16) = 16
                    AND (t.tgtype & 64) = 0 AND (t.tgtype & (4|8|32)) = 0
                    AND (SELECT array_agg(x ORDER BY x) FROM unnest(t.tgattr::int2[]) AS x)
                        = (SELECT array_agg(a.attnum ORDER BY a.attnum) FROM pg_attribute a
                            WHERE a.attrelid = 'public.worker_identity_challenges'::regclass
                              AND a.attname IN ('status', 'attempts', 'locked_until'))) THEN
    RAISE EXCEPTION 'migration 101: AFTER UPDATE ROW trigger missing, disabled, without its WHEN clause, or not tracking exactly the expected columns';
  END IF;

  SELECT count(*) INTO v_parent FROM public.worker_identity_challenges;
  SELECT count(*) INTO v_backfill FROM public.worker_identity_challenge_events WHERE is_backfill;
  IF v_parent <> v_backfill THEN
    RAISE EXCEPTION 'migration 101: backfill wrote % rows for % challenges', v_backfill, v_parent;
  END IF;
END $$;

COMMIT;
