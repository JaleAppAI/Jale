-- ============================================================
-- 053_whatsapp_web_worker_bypass.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Web-registered workers (users.email AND users.tos_accepted_at both set,
-- from the website signup + OTP flow) must skip WhatsApp v2 onboarding
-- entirely: their first inbound WhatsApp message should land them
-- straight at lifecycle='ready' with a completed workflow run, never at
-- identity.verify_otp/legal.review.
--
-- jale_whatsapp cannot write worker_onboarding_state / worker_workflow_runs
-- for an identity it has not itself authenticated through the OTP
-- challenge chain: the RLS WITH CHECK on both tables requires
-- app.current_internal_user_id to already equal the target user, and
-- setting that GUC to an arbitrary caller-supplied id for a session that
-- has never linked this phone would be self-authorizing. That is exactly
-- why migration 047's bind function is SECURITY DEFINER. This migration
-- adds a parallel SECURITY DEFINER entry point for the web-worker case,
-- which independently re-validates eligibility inside the definer rather
-- than trusting the caller's own web/email check.
--
-- Safe to apply BEFORE the code deploy that calls it: this file only ADDS
-- a column grant, a policy, and a function nothing yet calls. No existing
-- code path is touched or behaves any differently after this applies.
--
-- Idempotent / replayable: CREATE OR REPLACE, DROP POLICY IF EXISTS +
-- CREATE, and plain GRANT statements are all safe to re-run.
-- ============================================================

BEGIN;

-- ── Column-scoped grant: let jale_whatsapp check web-registration ──────────
-- Mirrors 041's SELECT (tos_accepted_at) grant. Column-scoped deliberately:
-- jale_whatsapp must never gain broad SELECT on users -- RLS on that table
-- already restricts reads to worker rows, but the column grant is the
-- first line of defense and keeps the intent explicit in the ACL itself.
GRANT SELECT (email) ON public.users TO jale_whatsapp;

DO $$
BEGIN
  IF NOT has_column_privilege('jale_whatsapp', 'public.users', 'email', 'SELECT') THEN
    RAISE EXCEPTION 'jale_whatsapp is missing SELECT on users.email';
  END IF;

  IF has_table_privilege('jale_whatsapp', 'public.users', 'SELECT') THEN
    RAISE EXCEPTION 'jale_whatsapp unexpectedly has broad SELECT on users';
  END IF;
END;
$$;

-- ── UPDATE policy for the definer below ─────────────────────────────────
-- Reuses the exact GUC 042's bind function already established
-- (app.onboarding_bind_user_id) so both definers share one convention:
-- only the transaction that has itself validated and pinned the target
-- worker id may write that worker's row, and only that one row. users
-- keeps FORCE ROW LEVEL SECURITY (002:11), so even the owner needs this.
DROP POLICY IF EXISTS users_web_worker_bypass_definer ON public.users;
CREATE POLICY users_web_worker_bypass_definer ON public.users FOR UPDATE TO jale_admin
  USING (
    user_type = 'worker'
    AND id::text = current_setting('app.onboarding_bind_user_id', true)
  )
  WITH CHECK (
    user_type = 'worker'
    AND id::text = current_setting('app.onboarding_bind_user_id', true)
  );

-- ── The bypass definer ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bypass_onboarding_for_web_worker(
  p_user_id UUID,
  p_conversation_id UUID,
  p_workflow_version TEXT,
  p_preferred_language TEXT,
  p_inbound_message_sid TEXT
) RETURNS TABLE (onboarding_state_id UUID, run_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_workflow_version INTEGER;
  v_state UUID;
  v_run UUID;
  v_updated INTEGER;
  v_conversation_whatsapp_number TEXT;
  v_created_run BOOLEAN := false;
BEGIN
  IF p_user_id IS NULL OR p_conversation_id IS NULL
     OR p_preferred_language NOT IN ('en', 'es')
     OR p_workflow_version IS NULL OR p_workflow_version !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'invalid web worker bypass request' USING ERRCODE = '22023';
  END IF;
  v_workflow_version := p_workflow_version::integer;
  IF v_workflow_version <= 0 THEN
    RAISE EXCEPTION 'invalid web worker bypass request' USING ERRCODE = '22023';
  END IF;

  -- Same keying posture as 047: one advisory lock per identity serializes a
  -- burst of near-simultaneous inbound messages from the same worker, so
  -- only one bypass attempt ever runs the read-modify-write below at a time.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  PERFORM pg_catalog.set_config('app.onboarding_bind_user_id', p_user_id::text, true);
  PERFORM pg_catalog.set_config('app.onboarding_bind_conversation_id', p_conversation_id::text, true);

  -- Re-validate eligibility inside the definer -- never trust that the
  -- caller's own web/email check is still true by the time this runs.
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
     WHERE u.id = p_user_id
       AND u.user_type = 'worker'
       AND u.tos_accepted_at IS NOT NULL
       AND u.email IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'web worker not eligible for onboarding bypass' USING ERRCODE = '23503';
  END IF;

  -- Same conversation-bind guard as 047: a conversation with no owner yet,
  -- or already owned by this exact worker, binds; anything else (owned by
  -- a DIFFERENT worker) is rejected outright.
  UPDATE public.whatsapp_conversations
     SET user_id = p_user_id, updated_at = pg_catalog.now()
   WHERE id = p_conversation_id AND (user_id IS NULL OR user_id = p_user_id)
  RETURNING whatsapp_number INTO v_conversation_whatsapp_number;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'conversation cannot be bound' USING ERRCODE = '55000';
  END IF;

  -- Only ever fills a NULL -- a web worker who somehow already linked a
  -- WhatsApp number keeps it untouched.
  UPDATE public.users SET
    whatsapp_number = COALESCE(whatsapp_number, v_conversation_whatsapp_number),
    whatsapp_linked_at = CASE WHEN whatsapp_number IS NULL THEN pg_catalog.now() ELSE whatsapp_linked_at END
  WHERE id = p_user_id;

  INSERT INTO public.worker_onboarding_state (user_id, lifecycle, ready_at, lifecycle_changed_at)
    VALUES (p_user_id, 'ready', pg_catalog.now(), pg_catalog.now())
    ON CONFLICT (user_id) DO UPDATE SET
      lifecycle = 'ready', ready_at = pg_catalog.now(),
      lifecycle_changed_at = pg_catalog.now(), updated_at = pg_catalog.now()
    RETURNING id INTO v_state;

  -- Idempotent: a worker who already has ANY run (a previous bypass call,
  -- or a genuine WhatsApp onboarding attempt) keeps it untouched -- no
  -- duplicate completed run and no duplicate transition on replay.
  SELECT r.id INTO v_run FROM public.worker_workflow_runs r
   WHERE r.user_id = p_user_id
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1 FOR UPDATE;
  IF v_run IS NULL THEN
    INSERT INTO public.worker_workflow_runs
      (user_id, workflow_version, current_step_key, status, preferred_language, completed_at)
      VALUES (p_user_id, v_workflow_version, 'legal.review', 'completed', p_preferred_language, pg_catalog.now())
      RETURNING id INTO v_run;
    v_created_run := true;
  END IF;

  IF v_created_run THEN
    INSERT INTO public.worker_workflow_transitions
      (run_id, from_step_key, to_step_key, inbound_message_sid, reason, metadata)
      VALUES (v_run, NULL, 'legal.review', p_inbound_message_sid, 'web_worker_bypass', '{}'::jsonb);
  END IF;

  RETURN QUERY SELECT v_state, v_run;
END $$;

ALTER FUNCTION public.bypass_onboarding_for_web_worker(UUID, UUID, TEXT, TEXT, TEXT) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.bypass_onboarding_for_web_worker(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bypass_onboarding_for_web_worker(UUID, UUID, TEXT, TEXT, TEXT) TO jale_whatsapp;

-- ── Self-audit ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'public' AND p.proname = 'bypass_onboarding_for_web_worker'
      AND p.proargtypes = '2950 2950 25 25 25'::oidvector
      AND r.rolname = 'jale_admin'
      AND p.prosecdef
      AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND NOT pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'migration 053 function self-audit failed: bypass_onboarding_for_web_worker';
  END IF;

  IF NOT pg_catalog.has_function_privilege('jale_whatsapp',
       'public.bypass_onboarding_for_web_worker(uuid,uuid,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 053 grant self-audit failed: jale_whatsapp cannot execute bypass_onboarding_for_web_worker';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'public' AND tablename = 'users'
       AND policyname = 'users_web_worker_bypass_definer'
       AND cmd = 'UPDATE'
       AND roles = ARRAY['jale_admin']::name[]
  ) THEN
    RAISE EXCEPTION 'migration 053 policy self-audit failed: users_web_worker_bypass_definer';
  END IF;

  IF NOT has_column_privilege('jale_whatsapp', 'public.users', 'email', 'SELECT') THEN
    RAISE EXCEPTION 'migration 053 column-grant self-audit failed: jale_whatsapp lacks SELECT on users.email';
  END IF;

  IF has_table_privilege('jale_whatsapp', 'public.users', 'SELECT') THEN
    RAISE EXCEPTION 'migration 053 self-audit failed: jale_whatsapp unexpectedly has broad SELECT on users';
  END IF;
END;
$$;

COMMIT;
