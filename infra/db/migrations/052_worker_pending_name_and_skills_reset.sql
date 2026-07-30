-- ============================================================
-- 052_worker_pending_name_and_skills_reset.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Two independent gaps found by the 2026-07-27 review of main:
--
-- 1. Durable signup name. 027's reconcile_worker_signup deliberately
--    receives '' for the name because worker-web-signup is an
--    unauthenticated endpoint and nothing it supplies is identity proof.
--    The name therefore only reaches users.full_name via the authenticated
--    PATCH /worker/profile the browser performs after OTP -- so a worker who
--    closes the tab between OTP and that PATCH keeps full_name NULL forever.
--    This adds a staging column plus two SECURITY DEFINER functions: signup
--    stages the submitted name, and the VerifyAuthChallenge trigger promotes
--    it on the first CORRECT OTP, and only when full_name is still NULL.
--    A squatter who pre-creates an account can therefore only ever set a
--    pending value that (a) the real owner's own signup overwrites, (b) is
--    discarded unless the OTP is passed, (c) loses to the authenticated
--    post-OTP PATCH because promotion requires full_name IS NULL, and
--    (d) expires. The TTL matters because promotion fires on the FIRST
--    correct OTP, which for a worker who never finishes the web flow may
--    arrive through WhatsApp onboarding much later; without it a long-stale
--    staged name could be adopted onto the real owner's account.
--
--    users has FORCE ROW LEVEL SECURITY (002:11, 020:11), so even jale_admin
--    is subject to policy. Both functions reuse the existing
--    users_worker_reconcile policy (027:271) by setting
--    app.worker_reconcile_sub, exactly as reconcile_worker_signup does --
--    no new policy on users is introduced.
--
-- 2. worker_skills reset on RESTART. 030 granted jale_whatsapp INSERT so
--    onboarding could seed a trade-derived starter skill, and that INSERT is
--    ON CONFLICT DO NOTHING (profile-flow.ts). When a worker sends RESTART
--    and picks a different trade, the abandoned trade's row survives and the
--    worker is matched on a trade they no longer claim. jale_whatsapp holds
--    SELECT (008:20) and INSERT (030:17) but no DELETE, so the reset cannot
--    be written today. This adds the DELETE grant and a worker-scoped DELETE
--    policy mirroring worker_skills_whatsapp_insert.
--
-- Replay-safe: every statement is idempotent and the self-audit asserts
-- existence only, never a mutable value.
-- ============================================================

BEGIN;

-- ── 1. Pending signup name ──────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_full_name_set_at TIMESTAMPTZ;

COMMENT ON COLUMN users.pending_full_name IS
  'Name submitted at unauthenticated web signup. Never displayed and never '
  'trusted as identity; promoted to full_name by promote_worker_pending_name '
  'on the first correct OTP, only while full_name IS NULL, and only inside '
  'the staging TTL.';

COMMENT ON COLUMN users.pending_full_name_set_at IS
  'When pending_full_name was staged. Promotion requires this to be recent, '
  'so a value staged by someone who never proves phone possession cannot be '
  'adopted by an unrelated later login.';

-- Stage the caller-supplied name. Deliberately a no-op once full_name is
-- set, so this can never clobber an established name. The 160-char cap
-- exists because this value arrives over an UNAUTHENTICATED endpoint and
-- users.full_name is an unbounded TEXT column -- without it, anyone could
-- stage megabytes per request and have them promoted into full_name later.
CREATE OR REPLACE FUNCTION stage_worker_pending_name(
  p_cognito_sub TEXT,
  p_full_name TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_pending_name_max_len CONSTANT INT := 160;
  v_updated INT;
BEGIN
  IF p_cognito_sub IS NULL OR btrim(p_cognito_sub) = '' THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.worker_reconcile_sub', p_cognito_sub, true);

  UPDATE users
     SET pending_full_name = NULLIF(left(btrim(p_full_name), c_pending_name_max_len), ''),
         pending_full_name_set_at = now()
   WHERE cognito_sub = p_cognito_sub
     AND user_type = 'worker'
     AND full_name IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- Promote the staged name after a correct OTP. Returns true only when a
-- name was actually adopted. The staged value is always discarded, so a
-- rejected name cannot linger for a later attempt.
CREATE OR REPLACE FUNCTION promote_worker_pending_name(
  p_cognito_sub TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_pending_name_ttl CONSTANT INTERVAL := INTERVAL '24 hours';
  v_promoted INT;
BEGIN
  IF p_cognito_sub IS NULL OR btrim(p_cognito_sub) = '' THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.worker_reconcile_sub', p_cognito_sub, true);

  -- The TTL matters because promotion fires on a worker's FIRST correct OTP,
  -- which may arrive through a different channel long after a web signup.
  -- Without it, a name staged by someone who never proved phone possession
  -- could be adopted onto the real owner's account much later.
  UPDATE users
     SET full_name = pending_full_name,
         pending_full_name = NULL,
         pending_full_name_set_at = NULL
   WHERE cognito_sub = p_cognito_sub
     AND user_type = 'worker'
     AND full_name IS NULL
     AND pending_full_name IS NOT NULL
     AND pending_full_name_set_at IS NOT NULL
     AND pending_full_name_set_at > now() - c_pending_name_ttl;

  GET DIAGNOSTICS v_promoted = ROW_COUNT;

  -- Nothing staged survives a verified login, promoted or not.
  UPDATE users
     SET pending_full_name = NULL,
         pending_full_name_set_at = NULL
   WHERE cognito_sub = p_cognito_sub
     AND user_type = 'worker'
     AND (pending_full_name IS NOT NULL OR pending_full_name_set_at IS NOT NULL);

  RETURN v_promoted > 0;
END;
$$;

REVOKE ALL ON FUNCTION stage_worker_pending_name(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stage_worker_pending_name(TEXT, TEXT) TO jale_admin;

REVOKE ALL ON FUNCTION promote_worker_pending_name(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION promote_worker_pending_name(TEXT) TO jale_admin;

-- ── 2. worker_skills reset on RESTART ───────────────────────

GRANT DELETE ON worker_skills TO jale_whatsapp;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'worker_skills'
       AND policyname = 'worker_skills_whatsapp_delete'
  ) THEN
    CREATE POLICY worker_skills_whatsapp_delete
      ON worker_skills FOR DELETE TO jale_whatsapp
      USING (
        EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = worker_skills.worker_id
            AND u.user_type = 'worker'
        )
      );
  END IF;
END $$;

-- ── Self-audit (existence only, so replays stay green) ──────

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'users'
       AND column_name IN ('pending_full_name', 'pending_full_name_set_at')
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'migration 052 self-audit failed: users pending-name columns missing';
  END IF;

  IF to_regprocedure('public.stage_worker_pending_name(text,text)') IS NULL THEN
    RAISE EXCEPTION 'migration 052 self-audit failed: stage_worker_pending_name missing';
  END IF;

  IF to_regprocedure('public.promote_worker_pending_name(text)') IS NULL THEN
    RAISE EXCEPTION 'migration 052 self-audit failed: promote_worker_pending_name missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'worker_skills'
       AND policyname = 'worker_skills_whatsapp_delete'
  ) THEN
    RAISE EXCEPTION 'migration 052 self-audit failed: worker_skills_whatsapp_delete policy missing';
  END IF;

  IF NOT has_table_privilege('jale_whatsapp', 'public.worker_skills', 'DELETE') THEN
    RAISE EXCEPTION 'migration 052 self-audit failed: jale_whatsapp lacks DELETE on worker_skills';
  END IF;
END;
$migration$;

COMMIT;
