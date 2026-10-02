-- ============================================================
-- 102_admin_identity_lockouts.sql
-- Run manually AFTER 101_worker_identity_challenge_events.sql, connected as
-- jale_admin (NOT the RDS master user). Forward-only (ADR-005).
--
-- Roadmap sub-project 1b
-- (docs/superpowers/specs/2026-10-02-admin-analytics-1b-lockout-list-design.md).
--
-- The admin verification queue read admin_cases rows that nothing in
-- production creates. The real verification failure is a worker locked out
-- of, or stuck at, the WhatsApp phone-code step. A lock lasts 15 minutes and a
-- code resend rewrites the challenge row (status 'pending', attempts 0, no
-- lock), so the current row cannot show a lockout after the fact; 101's
-- history can. admin_identity_lockouts(p_days) returns one row per challenge
-- that was locked out in the window ('lockout') or is stuck at the code step
-- with a code that expired over an hour ago ('stuck'), with a masked phone
-- and what happened next, which may live on a newer challenge for the same
-- phone since an expired challenge is never reused. A newer same-phone
-- challenge counts only once it reached the code step; "retrying" means a
-- code or lock from the last hour; a lockout whose re-sent code then expired
-- unused reads "code expired".
--
-- PHONE: the challenge stores only phone_hash = sha256(trim(number)) hex
-- (hashNormalizedPhone). The number comes from whatsapp_conversations by
-- matching that hash and is masked by admin_mask_phone() inside the function,
-- in the console's maskPhone format. No hash, user id, or Cognito session is
-- returned.
--
-- ACCESS (roadmap rules, 089's pattern): the list is a definer owned by
-- jale_admin with a pinned search path, executable by the admin console role
-- only; it opens app.admin_analytics_read AFTER validating p_days. Sources:
--   worker_identity_challenges        042's unconditional definer policy
--   worker_identity_challenge_events  101's gated read policy
--   whatsapp_conversations            a NEW gated read policy below. No
--     migration forces RLS on it, but 042 treats it as a legacy forced-RLS
--     table; the gated policy makes the read work either way and changes
--     nothing for any other role or for an ungated jale_admin session.
--
-- DEPLOY ORDER: apply BEFORE deploying the admin console build that calls
-- admin_identity_lockouts (/verifications and the dashboard).
-- ============================================================
BEGIN;

-- Fail fast instead of queueing every whatsapp_conversations read behind a
-- stuck transaction (the policy created below takes an AccessExclusiveLock
-- until COMMIT); a timed-out apply writes no ledger row and can simply be
-- rerun.
SET LOCAL lock_timeout = '5s';

-- Preconditions: the list reads through these two policies. pg_policy is a
-- catalog table, so RLS never filters this check; a missing policy would
-- otherwise make the list silently empty (the 088 defect).
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
    RAISE EXCEPTION 'migration 102: 042 definer policy on worker_identity_challenges missing or drifted; the lockout list would read zero challenges';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.worker_identity_challenge_events'::regclass
       AND polname = 'worker_identity_challenge_events_admin_analytics_read'
       AND polcmd = 'r'
       AND polpermissive
       AND polroles = ARRAY['jale_admin'::regrole::oid]
       AND pg_get_expr(polqual, polrelid) = $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$
  ) THEN
    RAISE EXCEPTION 'migration 102: 101 gated read policy on worker_identity_challenge_events missing or drifted; the lockout list would read zero lockouts';
  END IF;
END $$;

-- ── whatsapp_conversations: 089's gated read ────────────────
CREATE POLICY whatsapp_conversations_admin_analytics_read
  ON public.whatsapp_conversations FOR SELECT
  TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

-- ── Phone masking: the console's maskPhone, in SQL ──────────
-- Invoker and owner-only: the list calls it as its owner; nothing else may.
CREATE FUNCTION public.admin_mask_phone(p_phone TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN length(d) < 10 THEN 'Masked'
           ELSE CASE WHEN length(d) > 10 THEN '+' || left(d, length(d) - 10) || ' ' ELSE '' END
                || substr(d, length(d) - 9, 3) || ' *** ' || right(d, 4)
         END
    FROM (SELECT regexp_replace(p_phone, '[^0-9]', '', 'g') AS d) AS digits
$$;

-- ── The lockout list ────────────────────────────────────────
CREATE FUNCTION public.admin_identity_lockouts(p_days INTEGER DEFAULT 7)
RETURNS TABLE (
  challenge_id  UUID,
  kind          TEXT,
  masked_phone  TEXT,
  outcome       TEXT,
  lockout_count INTEGER,
  attempts      INTEGER,
  locked_until  TIMESTAMPTZ,
  last_event_at TIMESTAMPTZ,
  started_at    TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_since TIMESTAMPTZ;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 30 THEN
    RAISE EXCEPTION 'admin_identity_lockouts_invalid_days';
  END IF;
  v_since := now() - make_interval(days => p_days);

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  WITH lockouts AS (
    -- Every event that left a challenge locked: a new lock, or a re-lock with
    -- a new locked_until. Backfill rows count, so a lock from before 101 that
    -- is still in place appears.
    SELECT e.challenge_id AS cid,
           count(*)::INTEGER AS n,
           max(e.changed_at) AS last_at
      FROM public.worker_identity_challenge_events e
     WHERE e.to_status = 'locked'
       AND e.changed_at >= v_since
     GROUP BY e.challenge_id
  ), picked AS (
    SELECT c.id, c.phone_hash, c.status AS c_status, c.verified_user_id,
           c.attempts AS c_attempts, c.locked_until AS c_locked_until,
           c.expires_at AS c_expires_at, c.updated_at, c.created_at,
           l.n, l.last_at,
           nw.newer_verified, nw.newer_progressed, nw.newer_live,
           CASE WHEN l.cid IS NOT NULL THEN 'lockout' ELSE 'stuck' END AS k
      FROM public.worker_identity_challenges c
      LEFT JOIN lockouts l ON l.cid = c.id
      -- An expired challenge is never reused: the next message opens a NEW row
      -- for the same phone, first parked at start.choose_language. Only newer
      -- rows that reached the code step say what happened next, and only a
      -- recent code or lock is a live retry. Aggregates without GROUP BY
      -- return one row.
      CROSS JOIN LATERAL (
        SELECT COALESCE(bool_or(n.status = 'verified' OR n.verified_user_id IS NOT NULL), false) AS newer_verified,
               COALESCE(bool_or(n.current_step_key = 'identity.verify_otp'
                                OR n.status = 'verified' OR n.verified_user_id IS NOT NULL), false) AS newer_progressed,
               COALESCE(bool_or(n.status IN ('pending', 'locked')
                                AND n.current_step_key = 'identity.verify_otp'
                                AND COALESCE(n.locked_until, n.expires_at, n.updated_at) >= now() - interval '1 hour'), false) AS newer_live
          FROM public.worker_identity_challenges n
         WHERE n.phone_hash = c.phone_hash
           AND (n.created_at, n.id) > (c.created_at, c.id)
      ) nw
     WHERE l.cid IS NOT NULL
        OR (c.status IN ('pending', 'expired')
            AND c.current_step_key = 'identity.verify_otp'
            AND c.verified_user_id IS NULL
            AND COALESCE(c.expires_at, c.updated_at) < now() - interval '1 hour'
            AND c.updated_at >= v_since
            AND NOT nw.newer_progressed)
  ), conv AS (
    -- whatsapp_number is UNIQUE and stored as trimmed E.164, so in practice each hash matches one row.
    SELECT encode(sha256(convert_to(btrim(w.whatsapp_number), 'UTF8')), 'hex') AS h,
           w.whatsapp_number AS num
      FROM public.whatsapp_conversations w
  )
  SELECT p.id,
         p.k,
         public.admin_mask_phone(cv.num),
         CASE
           WHEN p.c_status = 'verified' OR p.verified_user_id IS NOT NULL OR p.newer_verified THEN 'verified'
           WHEN p.c_status = 'locked' AND p.c_locked_until > now() THEN 'locked'
           WHEN p.c_status = 'superseded' THEN 'superseded'
           WHEN p.newer_live THEN 'retrying'
           WHEN p.c_status = 'locked' THEN 'lock_expired'
           WHEN p.k = 'lockout' AND p.c_status = 'pending'
                AND COALESCE(p.c_expires_at, p.updated_at) >= now() - interval '1 hour' THEN 'retrying'
           ELSE 'code_expired'
         END,
         COALESCE(p.n, 0),
         p.c_attempts,
         p.c_locked_until,
         COALESCE(p.last_at, p.updated_at),
         p.created_at
    FROM picked p
    LEFT JOIN conv cv ON cv.h = p.phone_hash
   ORDER BY (p.k = 'lockout') DESC, COALESCE(p.last_at, p.updated_at) DESC, p.id;
END $$;

-- ── Ownership + ACL ─────────────────────────────────────────
ALTER FUNCTION public.admin_mask_phone(TEXT) OWNER TO jale_admin;
ALTER FUNCTION public.admin_identity_lockouts(INTEGER) OWNER TO jale_admin;

REVOKE ALL ON FUNCTION public.admin_mask_phone(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_identity_lockouts(INTEGER) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_identity_lockouts(INTEGER) TO jale_admin_console;

-- Fail closed if either function drifted from the reviewed model, if the
-- masking format diverges from the console's, if the conversations read path
-- is missing, or if the gate does not open.
DO $$
DECLARE
  v_fn     OID := to_regprocedure('public.admin_identity_lockouts(integer)')::OID;
  v_mask   OID := to_regprocedure('public.admin_mask_phone(text)')::OID;
  fn       RECORD;
  v_days   INTEGER;
  v_raised BOOLEAN;
BEGIN
  IF v_fn IS NULL OR v_mask IS NULL THEN
    RAISE EXCEPTION 'migration 102: admin_identity_lockouts or admin_mask_phone missing';
  END IF;

  SELECT owner.rolname AS owner_name, p.prosecdef, p.proconfig INTO fn
    FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
   WHERE p.oid = v_fn;
  IF fn.owner_name IS DISTINCT FROM 'jale_admin' OR NOT fn.prosecdef
     OR NOT (fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'migration 102: admin_identity_lockouts owner/secdef/search_path wrong';
  END IF;
  -- Exactly the owner and the console may execute the list (PUBLIC is grantee 0).
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = v_fn AND a.privilege_type = 'EXECUTE'
       AND a.grantee NOT IN (p.proowner, 'jale_admin_console'::regrole::oid)
  ) THEN
    RAISE EXCEPTION 'migration 102: admin_identity_lockouts executable by a role other than its owner and the console';
  END IF;
  IF NOT has_function_privilege('jale_admin_console', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 102: admin_identity_lockouts not executable by console';
  END IF;

  SELECT owner.rolname AS owner_name, p.prosecdef, p.proconfig INTO fn
    FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
   WHERE p.oid = v_mask;
  IF fn.owner_name IS DISTINCT FROM 'jale_admin' OR fn.prosecdef
     OR NOT (fn.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'migration 102: admin_mask_phone owner/invoker/search_path wrong';
  END IF;
  -- Only the owner may execute the masking helper.
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = v_mask AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'migration 102: admin_mask_phone must not be executable outside its owner';
  END IF;
  IF public.admin_mask_phone('+526641234567') IS DISTINCT FROM '+52 664 *** 4567'
     OR public.admin_mask_phone('6641234567') IS DISTINCT FROM '664 *** 4567'
     OR public.admin_mask_phone('12345') IS DISTINCT FROM 'Masked'
     OR public.admin_mask_phone(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'migration 102: admin_mask_phone does not match the console maskPhone format';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.whatsapp_conversations'::regclass
       AND polname = 'whatsapp_conversations_admin_analytics_read'
       AND polcmd = 'r'
       AND polpermissive
       AND polroles = ARRAY['jale_admin'::regrole::oid]
       AND pg_get_expr(polqual, polrelid) = $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$
  ) THEN
    RAISE EXCEPTION 'migration 102: whatsapp_conversations gated read policy missing or drifted';
  END IF;
  IF NOT has_table_privilege('jale_admin', 'public.whatsapp_conversations', 'SELECT') THEN
    RAISE EXCEPTION 'migration 102: jale_admin cannot SELECT whatsapp_conversations';
  END IF;

  -- 098's pattern: clear the gate, call, require it back on.
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_identity_lockouts(7);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 102: admin_identity_lockouts did not set the read flag';
  END IF;

  FOREACH v_days IN ARRAY ARRAY[0, 31] LOOP
    BEGIN
      PERFORM * FROM public.admin_identity_lockouts(v_days);
      v_raised := false;
    EXCEPTION WHEN raise_exception THEN
      v_raised := SQLERRM = 'admin_identity_lockouts_invalid_days';
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'migration 102: admin_identity_lockouts(%) did not reject the window', v_days;
    END IF;
  END LOOP;
END $$;

COMMIT;
