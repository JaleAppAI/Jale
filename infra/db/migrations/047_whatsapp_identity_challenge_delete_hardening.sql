-- Harden WhatsApp identity-challenge lifecycle against worker deletion.
--
-- Problem: worker_identity_challenges is keyed by phone_hash, and its two FKs
-- to users(id) were ON DELETE SET NULL (migration 042). When a worker account
-- is deleted, every other onboarding table cascades away, but a
-- status='verified' challenge row SURVIVES (only verified_user_id is nulled;
-- status + context JSONB persist). On the worker's next sign-on, the strict
-- replay guard in bind_verified_identity_and_start_workflow finds that orphaned
-- verified row by phone_hash, sees the stored identity no longer matches, and
-- raises 'conflicting verified identity replay' (55000) on every attempt — the
-- worker can never re-onboard.
--
-- This supersedes the bind function last redefined in migration 046 (already
-- applied in prod), keeping 046's active-run reuse and adding the deletion
-- hardening below. Two parts, both idempotent / forward-only — apply manually
-- through the migration runbook, after 046:
--   1. Flip both FKs to ON DELETE CASCADE so deleting a user removes its
--      challenge rows regardless of which delete path (ops script / admin /
--      manual SQL) is used.
--   2. Make bind_verified_identity_and_start_workflow self-heal: an existing
--      verified challenge whose bound identity no longer exists is superseded
--      and the bind falls through to a fresh run. The strict replay guard is
--      preserved for a still-live identity (same-hash hijack protection).

BEGIN;

-- ── Part 1: FK ON DELETE CASCADE ───────────────────────────────────────────
-- The inline REFERENCES in migration 042 produced the default constraint names
-- below. DROP IF EXISTS + re-ADD makes this safe to re-run.
ALTER TABLE public.worker_identity_challenges
  DROP CONSTRAINT IF EXISTS worker_identity_challenges_candidate_user_id_fkey,
  DROP CONSTRAINT IF EXISTS worker_identity_challenges_verified_user_id_fkey;

ALTER TABLE public.worker_identity_challenges
  ADD CONSTRAINT worker_identity_challenges_candidate_user_id_fkey
    FOREIGN KEY (candidate_user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  ADD CONSTRAINT worker_identity_challenges_verified_user_id_fkey
    FOREIGN KEY (verified_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- ── Part 2: self-healing bind function ─────────────────────────────────────
-- Supersedes the migration-046 definition. Only the "existing verified
-- challenge" branch changes; the fresh-bind path is identical to 046.
CREATE OR REPLACE FUNCTION public.bind_verified_identity_and_start_workflow(
  p_phone_hash TEXT, p_verified_user_id UUID, p_conversation_id UUID,
  p_workflow_version INTEGER, p_preferred_language TEXT,
  p_inbound_message_sid TEXT, p_context JSONB DEFAULT '{}'::jsonb
) RETURNS TABLE (challenge_id UUID, onboarding_state_id UUID, run_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_challenge UUID;
  v_state UUID;
  v_run UUID;
  v_updated INTEGER;
  v_existing_user UUID;
  v_existing_conversation UUID;
  v_existing_state UUID;
  v_existing_run UUID;
  v_created_run BOOLEAN := false;
BEGIN
  IF p_phone_hash IS NULL OR p_phone_hash !~ '^[0-9a-f]{64}$' OR p_verified_user_id IS NULL
     OR p_conversation_id IS NULL OR p_workflow_version <= 0 OR p_preferred_language NOT IN ('en','es')
     OR p_context IS NULL OR jsonb_typeof(p_context) <> 'object' THEN
    RAISE EXCEPTION 'invalid verified identity binding' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone_hash, 0));

  SELECT c.id, c.verified_user_id,
         NULLIF(c.context->>'bound_conversation_id', '')::uuid,
         NULLIF(c.context->>'onboarding_state_id', '')::uuid,
         NULLIF(c.context->>'workflow_run_id', '')::uuid
    INTO v_challenge, v_existing_user, v_existing_conversation,
         v_existing_state, v_existing_run
    FROM public.worker_identity_challenges c
   WHERE c.phone_hash = p_phone_hash AND c.status = 'verified'
   ORDER BY c.updated_at DESC, c.id DESC LIMIT 1 FOR UPDATE;
  IF v_challenge IS NOT NULL THEN
    -- Self-heal: only keep the strict replay guard when the identity this
    -- verified challenge was bound to STILL EXISTS. A worker who deleted their
    -- account leaves an orphaned verified row (verified_user_id SET NULL by the
    -- FK, or its onboarding_state / workflow_run cascade-deleted). That row must
    -- not block re-onboarding — supersede it and fall through to a fresh bind.
    --
    -- Liveness is probed via the bound onboarding_state + workflow_run, not the
    -- users table: those two have USING(true) definer RLS policies visible to
    -- this SECURITY DEFINER function, whereas users is only visible once
    -- app.onboarding_bind_user_id is set (later, in the fresh-bind path). Both
    -- rows are ON DELETE CASCADE from users, so their absence (or a nulled
    -- verified_user_id) is a faithful signal that the bound identity is gone.
    IF v_existing_user IS NOT NULL
       AND v_existing_state IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.worker_onboarding_state s
                     WHERE s.id = v_existing_state AND s.user_id = v_existing_user)
       AND v_existing_run IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.worker_workflow_runs r
                     WHERE r.id = v_existing_run AND r.user_id = v_existing_user)
    THEN
      -- Live identity: this is a genuine replay. Return the original result only
      -- when user AND conversation match; otherwise a different conversation is
      -- trying to rebind a verified phone (same-hash hijack) — reject it.
      IF v_existing_user IS DISTINCT FROM p_verified_user_id
         OR v_existing_conversation IS DISTINCT FROM p_conversation_id THEN
        RAISE EXCEPTION 'conflicting verified identity replay' USING ERRCODE = '55000';
      END IF;
      RETURN QUERY SELECT v_challenge, v_existing_state, v_existing_run;
      RETURN;
    END IF;

    -- Orphaned verified challenge (its bound identity was deleted): supersede
    -- it and fall through to the fresh-bind path below.
    UPDATE public.worker_identity_challenges
       SET status = 'superseded', updated_at = pg_catalog.now()
     WHERE id = v_challenge;
    v_challenge := NULL;
  END IF;

  SELECT c.id INTO v_challenge FROM public.worker_identity_challenges c
    WHERE c.phone_hash = p_phone_hash AND c.status = 'pending'
      AND c.provider_challenge_id IS NOT NULL AND c.expires_at IS NOT NULL
      AND c.expires_at > pg_catalog.now()
      AND (c.locked_until IS NULL OR c.locked_until <= pg_catalog.now())
    ORDER BY c.created_at DESC, c.id DESC LIMIT 1 FOR UPDATE;
  IF v_challenge IS NULL THEN
    RAISE EXCEPTION 'no bindable identity challenge' USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.set_config('app.onboarding_bind_user_id', p_verified_user_id::text, true);
  PERFORM pg_catalog.set_config('app.onboarding_bind_conversation_id', p_conversation_id::text, true);
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_verified_user_id AND u.user_type = 'worker') THEN
    RAISE EXCEPTION 'verified worker not found' USING ERRCODE = '23503';
  END IF;

  UPDATE public.whatsapp_conversations SET user_id = p_verified_user_id, updated_at = pg_catalog.now()
    WHERE id = p_conversation_id AND (user_id IS NULL OR user_id = p_verified_user_id);
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'conversation cannot be bound' USING ERRCODE = '55000'; END IF;

  UPDATE public.worker_identity_challenges SET verified_user_id = p_verified_user_id,
    status = 'verified', context = context || jsonb_build_object('bound_conversation_id', p_conversation_id),
    updated_at = pg_catalog.now()
  WHERE id = v_challenge AND status = 'pending';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'identity challenge changed during binding' USING ERRCODE = '55000'; END IF;

  INSERT INTO public.worker_onboarding_state (user_id, lifecycle, lifecycle_changed_at)
    VALUES (p_verified_user_id, 'onboarding', pg_catalog.now())
    ON CONFLICT (user_id) DO UPDATE SET lifecycle = 'onboarding', lifecycle_changed_at = pg_catalog.now(), updated_at = pg_catalog.now()
    RETURNING id INTO v_state;

  -- The state upsert locks the per-user row, so a concurrent bind observes
  -- the active run created by its winner.
  SELECT r.id INTO v_run FROM public.worker_workflow_runs r
   WHERE r.user_id = p_verified_user_id AND r.status = 'active'
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1 FOR UPDATE;
  IF v_run IS NULL THEN
    INSERT INTO public.worker_workflow_runs
      (user_id, workflow_version, current_step_key, status, preferred_language, context)
      VALUES (p_verified_user_id, p_workflow_version, 'legal.review', 'active', p_preferred_language, p_context)
      RETURNING id INTO v_run;
    v_created_run := true;
  END IF;

  UPDATE public.worker_identity_challenges SET context = context || jsonb_build_object(
      'bound_conversation_id', p_conversation_id, 'onboarding_state_id', v_state, 'workflow_run_id', v_run),
    updated_at = pg_catalog.now()
  WHERE id = v_challenge;

  IF v_created_run THEN
    INSERT INTO public.worker_workflow_transitions
      (run_id, from_step_key, to_step_key, inbound_message_sid, reason, metadata)
      VALUES (v_run, 'identity.verify_otp', 'legal.review', p_inbound_message_sid, 'otp_verified', '{}'::jsonb);
  END IF;
  RETURN QUERY SELECT v_challenge, v_state, v_run;
END $$;

ALTER FUNCTION public.bind_verified_identity_and_start_workflow(TEXT, UUID, UUID, INTEGER, TEXT, TEXT, JSONB) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.bind_verified_identity_and_start_workflow(TEXT, UUID, UUID, INTEGER, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bind_verified_identity_and_start_workflow(TEXT, UUID, UUID, INTEGER, TEXT, TEXT, JSONB) TO jale_whatsapp;

COMMIT;
