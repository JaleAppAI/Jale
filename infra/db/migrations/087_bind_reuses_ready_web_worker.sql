-- Stop `bind_verified_identity_and_start_workflow` from un-finishing a worker
-- who already completed onboarding.
--
-- Connect as: jale_admin (NOT the RDS master user)
--
-- ── The regression ─────────────────────────────────────────────────────────
-- The bind function (042 -> 046 -> 047) does two things that are correct for a
-- NET-NEW worker and wrong for one who has already finished:
--
--   1. `INSERT INTO worker_onboarding_state ... ON CONFLICT (user_id) DO UPDATE
--      SET lifecycle = 'onboarding'` is UNCONDITIONAL, so a lifecycle='ready'
--      row is overwritten back to 'onboarding' while `ready_at` is left set --
--      a self-contradictory row that reads "still onboarding, finished at
--      <timestamp>".
--   2. The run lookup filters `status = 'active'`, which a COMPLETED run is
--      not, so the function falls through and INSERTs a brand-new active run
--      at 'legal.review'. Nothing stops it: `worker_workflow_one_active`
--      (042) is `UNIQUE (user_id) WHERE (status = 'active')`, and the finished
--      run is 'completed'.
--
-- Net effect: the worker is asked to accept the Terms of Service again, and
-- their finished onboarding is silently reopened.
--
-- ── Why it was unreachable before, and is not any more ─────────────────────
-- This gap has been latent since 042. It was unreachable in production because
-- migration 053's `bypass_onboarding_for_web_worker` caught a website-
-- registered worker (email + tos_accepted_at set) on their FIRST WhatsApp
-- message and short-circuited them to 'ready' BEFORE the pre-auth/OTP/bind
-- lane ever ran; a WhatsApp-native worker, meanwhile, reaches 'ready' only on
-- a conversation that is already bound, so their next message never re-binds.
--
-- Sprint 22 R2 removes both of those shields. The redesigned web signup is
-- PHONE ONLY -- `reconcile_worker_signup` writes no email -- so 053's
-- eligibility predicate can no longer match, and the bypass lane has been
-- deleted from the processor outright. A web worker now drives the SAME v2
-- engine through `start_web_onboarding_workflow` (086) and, when they later
-- message WhatsApp for the first time, arrives at this bind with a REAL
-- workflow run behind them. For a worker still mid-onboarding that already
-- works: 046's `status = 'active'` reuse adopts their live run untouched. For
-- one who FINISHED on the web, this migration is what stops the reopen.
--
-- ── The change ─────────────────────────────────────────────────────────────
-- `CREATE OR REPLACE` of the 047 function with its body copied verbatim and
-- exactly two edits (plus the `v_lifecycle` declaration they need):
--
--   1. The state upsert preserves a terminal lifecycle: 'ready' stays 'ready'
--      and keeps its `lifecycle_changed_at`; anything else still moves to
--      'onboarding' exactly as before. `ready_at` was never written here and
--      still is not.
--   2. When no ACTIVE run exists and the state IS 'ready', adopt the latest
--      COMPLETED run (`FOR UPDATE`, newest `completed_at` first) instead of
--      inserting a fresh one. `loadWorkerGate` then returns the completed
--      gate and `routeOnboardingV2`'s ready-handoff branch fires, which is
--      the behaviour a finished worker should get on WhatsApp.
--
-- The `otp_verified` transition INSERT is already gated on `v_created_run`, so
-- an adopted run -- active or completed -- still gets no spurious transition
-- row. Nothing else in the function moves: the FK hardening and self-healing
-- replay guard from 047 are untouched, as is 046's active-run reuse.
--
-- ready-with-NO-completed-run is refused with 55000, deliberately mirroring
-- `start_web_onboarding_workflow` (086), which raises the identical message
-- for the identical anomaly. Both this function and 086 create the run
-- alongside the state, so a 'ready' state with no run behind it cannot arise
-- from either code path; minting a fresh onboarding run for it would silently
-- un-finish a finished worker, and falling through to the INSERT is exactly
-- the bug this migration exists to remove. Refuse and let an operator look.
--
-- ── Deploy note ────────────────────────────────────────────────────────────
-- Apply with the R2 release. Order against the code deploy does not matter:
-- the new function is strictly MORE conservative than the old one -- it never
-- writes anything the old one did not, it only declines to overwrite a
-- terminal lifecycle and declines to mint a duplicate run. Every pre-R2
-- caller (net-new worker, mid-onboarding worker) takes a byte-identical path.
--
-- Idempotent: `CREATE OR REPLACE` plus grant statements that restate the 047
-- ACL. Safe to re-run.

BEGIN;

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
  -- 087: the lifecycle the state row ENDS this call with, so the run lookup
  -- below can tell "finished worker" from "still onboarding".
  v_lifecycle TEXT;
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

  -- 087 CHANGE 1 of 2. Was an unconditional `SET lifecycle = 'onboarding'`,
  -- which un-finished a worker who had already reached 'ready' (leaving
  -- ready_at set behind it). A terminal lifecycle now survives the bind, with
  -- its original lifecycle_changed_at; every other state still moves to
  -- 'onboarding' exactly as before. 'suspended' is deliberately NOT preserved:
  -- that is 042's operator-hold value and reopening onboarding for it is the
  -- pre-existing behaviour of both this function and 046, unchanged here.
  INSERT INTO public.worker_onboarding_state (user_id, lifecycle, lifecycle_changed_at)
    VALUES (p_verified_user_id, 'onboarding', pg_catalog.now())
    ON CONFLICT (user_id) DO UPDATE SET
      lifecycle = CASE WHEN worker_onboarding_state.lifecycle = 'ready'
                       THEN worker_onboarding_state.lifecycle ELSE 'onboarding' END,
      lifecycle_changed_at = CASE WHEN worker_onboarding_state.lifecycle = 'ready'
                       THEN worker_onboarding_state.lifecycle_changed_at ELSE pg_catalog.now() END,
      updated_at = pg_catalog.now()
    RETURNING id, lifecycle INTO v_state, v_lifecycle;

  -- The state upsert locks the per-user row, so a concurrent bind observes
  -- the active run created by its winner.
  SELECT r.id INTO v_run FROM public.worker_workflow_runs r
   WHERE r.user_id = p_verified_user_id AND r.status = 'active'
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1 FOR UPDATE;

  -- 087 CHANGE 2 of 2. A worker who FINISHED onboarding has no active run, so
  -- the INSERT below used to mint a second one at 'legal.review' and ask them
  -- to accept the Terms again. Adopt their completed run instead: loadWorkerGate
  -- returns the completed gate and the router hands off as 'ready'.
  IF v_run IS NULL AND v_lifecycle = 'ready' THEN
    SELECT r.id INTO v_run FROM public.worker_workflow_runs r
     WHERE r.user_id = p_verified_user_id AND r.status = 'completed'
     ORDER BY r.completed_at DESC NULLS LAST, r.created_at DESC, r.id DESC LIMIT 1 FOR UPDATE;

    -- ready with no run behind it is a data anomaly: this function and
    -- start_web_onboarding_workflow (086) both create the run alongside the
    -- state. Minting a fresh onboarding run here would silently un-finish a
    -- finished worker, so refuse and let an operator look. Same errcode and
    -- same message text as 086's identical guard.
    IF v_run IS NULL THEN
      RAISE EXCEPTION 'worker is lifecycle=ready with no completed workflow run'
        USING ERRCODE = '55000';
    END IF;
  END IF;

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

-- ── Apply-time self-audit + smoke ──────────────────────────────────────────
-- plpgsql only PARSES a body at CREATE time, so a mis-qualified call inside a
-- branch stays invisible until something executes it -- and on RDS nothing
-- else will. The smoke below therefore EXECUTES the changed path end to end
-- against a synthetic ready worker, inside a subtransaction that is always
-- rolled back, so the database is left byte-identical either way.
--
-- Assertion results are carried out of the rolled-back subtransaction in a
-- plpgsql variable: variable assignments are not transactional, only the
-- database writes are, so the failure message survives the rollback and is
-- re-raised outside it.
DO $audit$
DECLARE
  v_fail TEXT;
  v_user UUID;
  v_conv UUID;
  v_run UUID;
  v_out_run UUID;
  v_runs INTEGER;
  v_lifecycle TEXT;
  v_transitions INTEGER;
  v_hash TEXT := pg_catalog.repeat('87', 32);  -- 64 hex chars
BEGIN
  -- Structural audit: owner, SECURITY DEFINER, pinned search_path, no PUBLIC
  -- EXECUTE, and the one grant the WhatsApp processor needs.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE n.nspname = 'public'
       AND p.proname = 'bind_verified_identity_and_start_workflow'
       AND r.rolname = 'jale_admin'
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
       AND NOT pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'migration 087: bind definer failed the owner/SECURITY DEFINER/search_path/PUBLIC-ACL audit';
  END IF;

  IF NOT pg_catalog.has_function_privilege('jale_whatsapp',
       'public.bind_verified_identity_and_start_workflow(text,uuid,uuid,integer,text,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 087: jale_whatsapp cannot execute the bind definer';
  END IF;

  BEGIN
    -- users is RLS-forced and this migration runs as a NON-superuser
    -- jale_admin, so the fixture INSERT has to satisfy a policy. The
    -- users_worker_reconcile policy (ALL, jale_admin) keys on
    -- app.worker_reconcile_sub; wa_conv_admin keys on app.current_user_id.
    PERFORM pg_catalog.set_config('app.worker_reconcile_sub', '__087_smoke_sub__', true);
    PERFORM pg_catalog.set_config('app.current_user_id', '__087_smoke_sub__', true);

    INSERT INTO public.users (cognito_sub, user_type, phone)
      VALUES ('__087_smoke_sub__', 'worker', '+10000000087')
      RETURNING id INTO v_user;

    -- A worker who FINISHED: lifecycle ready, ready_at set, run completed.
    INSERT INTO public.worker_onboarding_state (user_id, lifecycle, lifecycle_changed_at, ready_at)
      VALUES (v_user, 'ready', pg_catalog.now(), pg_catalog.now());
    INSERT INTO public.worker_workflow_runs
      (user_id, workflow_version, current_step_key, status, preferred_language, completed_at)
      VALUES (v_user, 1, 'trust.question.3', 'completed', 'en', pg_catalog.now())
      RETURNING id INTO v_run;

    -- Their first WhatsApp message: a conversation and a bindable challenge.
    INSERT INTO public.whatsapp_conversations (user_id, whatsapp_number, language, conversation_state)
      VALUES (v_user, '+10000000087', 'es', 'new')
      RETURNING id INTO v_conv;
    INSERT INTO public.worker_identity_challenges
      (phone_hash, provider_challenge_id, preferred_language, current_step_key, status, expires_at)
      VALUES (v_hash, '__087_smoke_session__', 'en', 'identity.verify_otp', 'pending',
              pg_catalog.now() + INTERVAL '10 minutes');

    SELECT b.run_id INTO v_out_run
      FROM public.bind_verified_identity_and_start_workflow(
             v_hash, v_user, v_conv, 1, 'en', '__087_smoke_sid__') b;

    SELECT pg_catalog.count(*) INTO v_runs
      FROM public.worker_workflow_runs WHERE user_id = v_user;
    SELECT s.lifecycle INTO v_lifecycle
      FROM public.worker_onboarding_state s WHERE s.user_id = v_user;
    SELECT pg_catalog.count(*) INTO v_transitions
      FROM public.worker_workflow_transitions t
     WHERE t.run_id = v_run AND t.reason = 'otp_verified';

    IF v_runs <> 1 THEN
      v_fail := pg_catalog.format(
        'migration 087 smoke: the bind created a second run (%s runs for a lifecycle=ready worker)', v_runs);
    ELSIF v_out_run IS DISTINCT FROM v_run THEN
      v_fail := 'migration 087 smoke: the bind did not adopt the completed run';
    ELSIF v_lifecycle IS DISTINCT FROM 'ready' THEN
      v_fail := pg_catalog.format(
        'migration 087 smoke: the bind un-readied the worker (lifecycle=%s)', v_lifecycle);
    ELSIF v_transitions <> 0 THEN
      v_fail := 'migration 087 smoke: an otp_verified transition was appended to an adopted run';
    END IF;

    -- Always unwind: every write above is fixture data.
    RAISE EXCEPTION 'migration 087 smoke rollback' USING ERRCODE = 'JS087';
  EXCEPTION
    WHEN SQLSTATE 'JS087' THEN
      NULL;  -- expected: the subtransaction's writes are discarded
  END;

  IF v_fail IS NOT NULL THEN
    RAISE EXCEPTION '%', v_fail;
  END IF;

  RAISE NOTICE 'migration 087: bind adopts a completed run and preserves lifecycle=ready (smoke passed)';
END
$audit$;

COMMIT;
