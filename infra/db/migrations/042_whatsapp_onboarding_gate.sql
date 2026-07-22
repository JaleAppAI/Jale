-- ============================================================
-- 042_whatsapp_onboarding_gate.sql
-- Additive WhatsApp v2 onboarding, identity, delivery, and event state.
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Pre-auth and cross-worker leases are exposed only through catalog-path
-- SECURITY DEFINER functions. The Twilio callback implementation is replaced
-- under its existing helper owner solely to accept both SM and MM SIDs.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.worker_onboarding_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  lifecycle TEXT NOT NULL DEFAULT 'onboarding'
    CHECK (lifecycle IN ('onboarding', 'ready', 'suspended')),
  lifecycle_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.worker_workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workflow_version INTEGER NOT NULL,
  current_step_key TEXT NOT NULL
    CHECK (current_step_key IN ('start.choose_language', 'identity.verify_otp', 'legal.review', 'profile.name', 'profile.location', 'profile.trade', 'profile.custom_trade', 'trust.question.1', 'trust.question.2', 'trust.question.3')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'declined', 'cancelled', 'failed')),
  preferred_language TEXT NOT NULL DEFAULT 'es'
    CHECK (preferred_language IN ('en', 'es')),
  lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS worker_workflow_one_active
  ON public.worker_workflow_runs (user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.worker_workflow_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.worker_workflow_runs(id) ON DELETE CASCADE,
  from_step_key TEXT,
  to_step_key TEXT NOT NULL,
  inbound_message_sid TEXT,
  reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.worker_identity_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash TEXT NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  provider_challenge_id TEXT,
  candidate_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  verified_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  preferred_language TEXT NOT NULL DEFAULT 'es'
    CHECK (preferred_language IN ('en', 'es')),
  current_step_key TEXT NOT NULL DEFAULT 'start.choose_language'
    CHECK (current_step_key IN ('start.choose_language', 'identity.verify_otp')),
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'expired', 'locked', 'superseded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_identity_challenges_phone_status
  ON public.worker_identity_challenges (phone_hash, status);

CREATE TABLE IF NOT EXISTS public.worker_message_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  category TEXT NOT NULL
    CHECK (category IN ('onboarding', 'security', 'account', 'job_alert', 'employer_chat')),
  owner_service TEXT NOT NULL
    CHECK (owner_service IN ('onboarding-v2', 'identity', 'job-alert', 'job-messaging', 'account')),
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  dedupe_key TEXT NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'deferred'
    CHECK (status IN ('deferred', 'eligible', 'leased', 'released', 'delivered',
                  'expired', 'superseded', 'rejected', 'failed')),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  decision_reason TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  release_sequence INTEGER,
  leased_until TIMESTAMPTZ,
  outbox_id UUID REFERENCES public.whatsapp_outbox(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT worker_message_intent_dedupe UNIQUE (dedupe_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_message_intents_release_sequence_unique
  ON public.worker_message_intents (user_id, release_sequence)
  WHERE release_sequence IS NOT NULL;
CREATE INDEX IF NOT EXISTS worker_message_intents_user_status
  ON public.worker_message_intents (user_id, status);
CREATE INDEX IF NOT EXISTS worker_message_intents_status_expires
  ON public.worker_message_intents (status, expires_at);

CREATE TABLE IF NOT EXISTS public.worker_domain_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('assessment.requested', 'worker.ready')),
  aggregate_id UUID NOT NULL,
  event_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT worker_domain_outbox_event_key UNIQUE (event_key)
);
CREATE INDEX IF NOT EXISTS worker_domain_outbox_status_attempt
  ON public.worker_domain_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS public.whatsapp_runtime_controls (
  control_key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  phone_hashes TEXT[] NOT NULL DEFAULT '{}'::text[],
  global_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.worker_reset_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  phone_hash TEXT NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  operator TEXT NOT NULL,
  reason TEXT NOT NULL,
  table_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  dry_run BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP POLICY IF EXISTS whatsapp_runtime_controls_definer ON public.whatsapp_runtime_controls;
CREATE POLICY whatsapp_runtime_controls_definer ON public.whatsapp_runtime_controls TO jale_admin
  USING (true) WITH CHECK (true);

INSERT INTO public.whatsapp_runtime_controls (control_key, enabled, global_enabled)
VALUES ('onboarding_v2_enabled', false, false),
       ('deferred_delivery_enabled', false, false)
ON CONFLICT (control_key) DO NOTHING;

ALTER TABLE public.worker_onboarding_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_onboarding_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.worker_workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_workflow_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.worker_workflow_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_workflow_transitions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.worker_identity_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_identity_challenges FORCE ROW LEVEL SECURITY;
ALTER TABLE public.worker_message_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_message_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.worker_domain_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_domain_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE public.worker_reset_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_reset_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_runtime_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_runtime_controls FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS worker_onboarding_state_worker ON public.worker_onboarding_state;
CREATE POLICY worker_onboarding_state_worker ON public.worker_onboarding_state TO jale_whatsapp
  USING (user_id::text = current_setting('app.current_internal_user_id', true))
  WITH CHECK (user_id::text = current_setting('app.current_internal_user_id', true));
DROP POLICY IF EXISTS worker_workflow_runs_worker ON public.worker_workflow_runs;
CREATE POLICY worker_workflow_runs_worker ON public.worker_workflow_runs TO jale_whatsapp
  USING (user_id::text = current_setting('app.current_internal_user_id', true))
  WITH CHECK (user_id::text = current_setting('app.current_internal_user_id', true));
DROP POLICY IF EXISTS worker_workflow_transitions_worker ON public.worker_workflow_transitions;
CREATE POLICY worker_workflow_transitions_worker ON public.worker_workflow_transitions TO jale_whatsapp
  USING (EXISTS (SELECT 1 FROM public.worker_workflow_runs r WHERE r.id = run_id
    AND r.user_id::text = current_setting('app.current_internal_user_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.worker_workflow_runs r WHERE r.id = run_id
    AND r.user_id::text = current_setting('app.current_internal_user_id', true)));
DROP POLICY IF EXISTS worker_identity_challenges_worker ON public.worker_identity_challenges;
CREATE POLICY worker_identity_challenges_worker ON public.worker_identity_challenges TO jale_whatsapp
  USING (verified_user_id::text = current_setting('app.current_internal_user_id', true))
  WITH CHECK (verified_user_id::text = current_setting('app.current_internal_user_id', true));
DROP POLICY IF EXISTS worker_message_intents_worker ON public.worker_message_intents;
CREATE POLICY worker_message_intents_worker ON public.worker_message_intents TO jale_whatsapp
  USING (user_id::text = current_setting('app.current_internal_user_id', true))
  WITH CHECK (user_id::text = current_setting('app.current_internal_user_id', true));
DROP POLICY IF EXISTS worker_domain_outbox_worker ON public.worker_domain_outbox;
CREATE POLICY worker_domain_outbox_worker ON public.worker_domain_outbox TO jale_whatsapp
  USING (aggregate_id::text = current_setting('app.current_internal_user_id', true))
  WITH CHECK (aggregate_id::text = current_setting('app.current_internal_user_id', true));
DROP POLICY IF EXISTS worker_reset_audit_worker ON public.worker_reset_audit;
CREATE POLICY worker_reset_audit_worker ON public.worker_reset_audit FOR SELECT TO jale_whatsapp
  USING (user_id::text = current_setting('app.current_internal_user_id', true));
DROP POLICY IF EXISTS whatsapp_runtime_controls_read ON public.whatsapp_runtime_controls;
CREATE POLICY whatsapp_runtime_controls_read ON public.whatsapp_runtime_controls FOR SELECT TO jale_whatsapp
  USING (true);

-- SECURITY DEFINER functions are jale_admin-owned. These policies let only
-- that definer cross forced RLS; application sessions remain worker-scoped.
DROP POLICY IF EXISTS worker_onboarding_state_definer ON public.worker_onboarding_state;
CREATE POLICY worker_onboarding_state_definer ON public.worker_onboarding_state TO jale_admin USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS worker_workflow_runs_definer ON public.worker_workflow_runs;
CREATE POLICY worker_workflow_runs_definer ON public.worker_workflow_runs TO jale_admin USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS worker_workflow_transitions_definer ON public.worker_workflow_transitions;
CREATE POLICY worker_workflow_transitions_definer ON public.worker_workflow_transitions TO jale_admin USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS worker_identity_challenges_definer ON public.worker_identity_challenges;
CREATE POLICY worker_identity_challenges_definer ON public.worker_identity_challenges TO jale_admin USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS worker_domain_outbox_definer ON public.worker_domain_outbox;
CREATE POLICY worker_domain_outbox_definer ON public.worker_domain_outbox TO jale_admin USING (true) WITH CHECK (true);

REVOKE ALL ON public.worker_onboarding_state FROM jale_whatsapp;
GRANT SELECT (id, user_id, lifecycle, lifecycle_changed_at, ready_at, created_at, updated_at),
  INSERT (user_id, lifecycle, lifecycle_changed_at, ready_at),
  UPDATE (lifecycle, lifecycle_changed_at, ready_at, updated_at)
  ON public.worker_onboarding_state TO jale_whatsapp;
REVOKE ALL ON public.worker_workflow_runs FROM jale_whatsapp;
GRANT SELECT (id, user_id, workflow_version, current_step_key, status, preferred_language, lock_version, context, created_at, updated_at, completed_at),
  INSERT (user_id, workflow_version, current_step_key, status, preferred_language, lock_version, context),
  UPDATE (current_step_key, status, preferred_language, lock_version, context, updated_at, completed_at)
  ON public.worker_workflow_runs TO jale_whatsapp;
REVOKE ALL ON public.worker_workflow_transitions FROM jale_whatsapp;
GRANT SELECT (id, run_id, from_step_key, to_step_key, inbound_message_sid, reason, metadata, created_at),
  INSERT (run_id, from_step_key, to_step_key, inbound_message_sid, reason, metadata)
  ON public.worker_workflow_transitions TO jale_whatsapp;
REVOKE ALL ON public.worker_identity_challenges FROM jale_whatsapp;
GRANT SELECT (id, phone_hash, provider_challenge_id, candidate_user_id, verified_user_id, preferred_language, current_step_key, context, status, attempts, expires_at, locked_until, created_at, updated_at)
  ON public.worker_identity_challenges TO jale_whatsapp;
REVOKE ALL ON public.worker_message_intents FROM jale_whatsapp;
GRANT SELECT (id, user_id, category, owner_service, source_type, source_id, dedupe_key, priority, status, policy_version, decision_reason, payload, expires_at, release_sequence, leased_until, outbox_id, created_at, updated_at),
  INSERT (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, status, policy_version, decision_reason, payload, expires_at, release_sequence, leased_until, outbox_id),
  UPDATE (status, decision_reason, release_sequence, leased_until, outbox_id, updated_at)
  ON public.worker_message_intents TO jale_whatsapp;
REVOKE ALL ON public.worker_domain_outbox FROM jale_whatsapp;
GRANT SELECT (id, event_type, aggregate_id, event_key, payload, status, attempts, next_attempt_at, last_error, created_at, updated_at),
  INSERT (event_type, aggregate_id, event_key, payload, status, attempts, next_attempt_at, last_error),
  UPDATE (status, attempts, next_attempt_at, last_error, updated_at)
  ON public.worker_domain_outbox TO jale_whatsapp;
REVOKE ALL ON public.worker_reset_audit FROM jale_whatsapp;
GRANT SELECT (id, user_id, phone_hash, operator, reason, table_counts, dry_run, created_at)
  ON public.worker_reset_audit TO jale_whatsapp;
REVOKE ALL ON public.whatsapp_runtime_controls FROM jale_whatsapp;
GRANT SELECT (control_key, enabled, phone_hashes, global_enabled)
  ON public.whatsapp_runtime_controls TO jale_whatsapp;

CREATE OR REPLACE FUNCTION public.load_worker_pre_auth(p_phone_hash TEXT)
RETURNS SETOF public.worker_identity_challenges
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_phone_hash IS NULL OR p_phone_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid phone hash' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT c.* FROM public.worker_identity_challenges c
    WHERE c.phone_hash = p_phone_hash AND c.status IN ('pending', 'locked')
    ORDER BY c.created_at DESC, c.id DESC LIMIT 1;
END $$;
ALTER FUNCTION public.load_worker_pre_auth(TEXT) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.load_worker_pre_auth(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_worker_pre_auth(TEXT) TO jale_whatsapp;

CREATE OR REPLACE FUNCTION public.save_worker_pre_auth(p_phone_hash TEXT, p_patch JSONB)
RETURNS SETOF public.worker_identity_challenges
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id UUID;
BEGIN
  IF p_phone_hash IS NULL OR p_phone_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid phone hash' USING ERRCODE = '22023';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) k
       WHERE k NOT IN ('provider_challenge_id','candidate_user_id','preferred_language','current_step_key','context','status','attempts','expires_at','locked_until')) THEN
    RAISE EXCEPTION 'invalid pre-auth patch' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone_hash, 0));
  SELECT c.id INTO v_id FROM public.worker_identity_challenges c
    WHERE c.phone_hash = p_phone_hash AND c.status IN ('pending', 'locked')
    ORDER BY c.created_at DESC, c.id DESC LIMIT 1 FOR UPDATE;
  IF v_id IS NULL THEN
    INSERT INTO public.worker_identity_challenges (phone_hash) VALUES (p_phone_hash) RETURNING id INTO v_id;
  END IF;
  UPDATE public.worker_identity_challenges SET
    provider_challenge_id = CASE WHEN p_patch ? 'provider_challenge_id' THEN NULLIF(p_patch->>'provider_challenge_id','') ELSE provider_challenge_id END,
    candidate_user_id = CASE WHEN p_patch ? 'candidate_user_id' THEN NULLIF(p_patch->>'candidate_user_id','')::uuid ELSE candidate_user_id END,
    preferred_language = COALESCE(p_patch->>'preferred_language', preferred_language),
    current_step_key = COALESCE(p_patch->>'current_step_key', current_step_key),
    context = CASE WHEN p_patch ? 'context' THEN p_patch->'context' ELSE context END,
    status = COALESCE(p_patch->>'status', status),
    attempts = CASE WHEN p_patch ? 'attempts' THEN (p_patch->>'attempts')::integer ELSE attempts END,
    expires_at = CASE WHEN p_patch ? 'expires_at' THEN NULLIF(p_patch->>'expires_at','')::timestamptz ELSE expires_at END,
    locked_until = CASE WHEN p_patch ? 'locked_until' THEN NULLIF(p_patch->>'locked_until','')::timestamptz ELSE locked_until END,
    updated_at = pg_catalog.now()
  WHERE id = v_id;
  RETURN QUERY SELECT c.* FROM public.worker_identity_challenges c WHERE c.id = v_id;
END $$;
ALTER FUNCTION public.save_worker_pre_auth(TEXT, JSONB) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.save_worker_pre_auth(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_worker_pre_auth(TEXT, JSONB) TO jale_whatsapp;

CREATE OR REPLACE FUNCTION public.bind_verified_identity_and_start_workflow(
  p_phone_hash TEXT, p_verified_user_id UUID, p_conversation_id UUID,
  p_workflow_version INTEGER, p_preferred_language TEXT,
  p_inbound_message_sid TEXT, p_context JSONB DEFAULT '{}'::jsonb
) RETURNS TABLE (challenge_id UUID, onboarding_state_id UUID, run_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_challenge UUID; v_state UUID; v_run UUID; v_updated INTEGER;
BEGIN
  IF p_phone_hash IS NULL OR p_phone_hash !~ '^[0-9a-f]{64}$' OR p_verified_user_id IS NULL
     OR p_conversation_id IS NULL OR p_workflow_version <= 0 OR p_preferred_language NOT IN ('en','es') THEN
    RAISE EXCEPTION 'invalid verified identity binding' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone_hash, 0));
  SELECT c.id INTO v_challenge FROM public.worker_identity_challenges c
    WHERE c.phone_hash = p_phone_hash AND c.status IN ('pending','locked')
    ORDER BY c.created_at DESC, c.id DESC LIMIT 1 FOR UPDATE;
  IF v_challenge IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_verified_user_id AND u.user_type = 'worker') THEN
    RAISE EXCEPTION 'verified challenge or worker not found' USING ERRCODE = '23503';
  END IF;
  UPDATE public.worker_identity_challenges SET verified_user_id = p_verified_user_id,
    status = 'verified', updated_at = pg_catalog.now() WHERE id = v_challenge;
  UPDATE public.whatsapp_conversations SET user_id = p_verified_user_id, updated_at = pg_catalog.now()
    WHERE id = p_conversation_id AND (user_id IS NULL OR user_id = p_verified_user_id);
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'conversation cannot be bound' USING ERRCODE = '23503'; END IF;
  INSERT INTO public.worker_onboarding_state (user_id, lifecycle, lifecycle_changed_at)
    VALUES (p_verified_user_id, 'onboarding', pg_catalog.now())
    ON CONFLICT (user_id) DO UPDATE SET lifecycle = 'onboarding', lifecycle_changed_at = pg_catalog.now(), updated_at = pg_catalog.now()
    RETURNING id INTO v_state;
  INSERT INTO public.worker_workflow_runs
    (user_id, workflow_version, current_step_key, status, preferred_language, context)
    VALUES (p_verified_user_id, p_workflow_version, 'legal.review', 'active', p_preferred_language, COALESCE(p_context, '{}'::jsonb))
    RETURNING id INTO v_run;
  INSERT INTO public.worker_workflow_transitions
    (run_id, from_step_key, to_step_key, inbound_message_sid, reason, metadata)
    VALUES (v_run, 'identity.verify_otp', 'legal.review', p_inbound_message_sid, 'otp_verified', '{}'::jsonb);
  RETURN QUERY SELECT v_challenge, v_state, v_run;
END $$;
ALTER FUNCTION public.bind_verified_identity_and_start_workflow(TEXT, UUID, UUID, INTEGER, TEXT, TEXT, JSONB) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.bind_verified_identity_and_start_workflow(TEXT, UUID, UUID, INTEGER, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bind_verified_identity_and_start_workflow(TEXT, UUID, UUID, INTEGER, TEXT, TEXT, JSONB) TO jale_whatsapp;

CREATE OR REPLACE FUNCTION public.lease_worker_domain_events(p_event_type TEXT, p_limit INTEGER)
RETURNS SETOF public.worker_domain_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_event_type NOT IN ('assessment.requested', 'worker.ready') OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid domain event lease request' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT e.id FROM public.worker_domain_outbox e
    WHERE e.event_type = p_event_type AND e.status = 'pending'
      AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= pg_catalog.now())
    ORDER BY e.created_at, e.id FOR UPDATE SKIP LOCKED LIMIT p_limit
  )
  UPDATE public.worker_domain_outbox e SET status = 'processing', attempts = e.attempts + 1,
    updated_at = pg_catalog.now() FROM candidates c WHERE e.id = c.id RETURNING e.*;
END $$;
ALTER FUNCTION public.lease_worker_domain_events(TEXT, INTEGER) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.lease_worker_domain_events(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lease_worker_domain_events(TEXT, INTEGER) TO jale_whatsapp;

-- Temporarily restore SET-capable membership exactly as migration 040 does so
-- the callback remains owned and re-created by its locked helper role.
DO $$ BEGIN
  EXECUTE format('GRANT jale_twilio_callback TO %I WITH SET TRUE, INHERIT FALSE', current_user);
END $$;
SET LOCAL ROLE jale_twilio_callback;
DROP FUNCTION IF EXISTS jale_twilio_callback.record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION jale_twilio_callback.record_whatsapp_delivery_status(
  p_twilio_message_sid TEXT,
  p_message_status TEXT,
  p_error_code TEXT,
  p_error_message TEXT
)
RETURNS TABLE (matched BOOLEAN, changed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_outbox_id UUID;
  v_source_type TEXT;
  v_source_id UUID;
  v_previous_status TEXT;
  v_status TEXT := LOWER(BTRIM(p_message_status));
  v_error_code TEXT := NULLIF(BTRIM(p_error_code), '');
  v_error_message TEXT := NULLIF(BTRIM(p_error_message), '');
  v_transition_allowed BOOLEAN := false;
BEGIN
  IF p_twilio_message_sid IS NULL
     OR p_twilio_message_sid !~ '^(SM|MM)[0-9A-Fa-f]{32}$' THEN
    RAISE EXCEPTION 'invalid Twilio message SID' USING ERRCODE = '22023';
  END IF;
  IF v_status IS NULL OR v_status NOT IN (
    'queued', 'accepted', 'sent', 'delivered', 'read', 'undelivered', 'failed'
  ) THEN
    RAISE EXCEPTION 'invalid Twilio delivery status' USING ERRCODE = '22023';
  END IF;
  IF v_error_code IS NOT NULL
     AND (v_error_code !~ '^[0-9]{1,10}$') THEN
    RAISE EXCEPTION 'invalid Twilio error code' USING ERRCODE = '22023';
  END IF;
  IF v_error_message IS NOT NULL AND CHAR_LENGTH(v_error_message) > 1000 THEN
    RAISE EXCEPTION 'Twilio error message too long' USING ERRCODE = '22001';
  END IF;

  SELECT o.id, o.source_type, o.source_id, o.twilio_delivery_status
    INTO v_outbox_id, v_source_type, v_source_id, v_previous_status
    FROM public.whatsapp_outbox o
   WHERE o.twilio_message_sid = p_twilio_message_sid
   FOR UPDATE;

  IF v_outbox_id IS NULL THEN
    RETURN QUERY SELECT false, false;
    RETURN;
  END IF;

  -- Duplicate same-status callback: Twilio may re-deliver a status callback
  -- (retry, at-least-once delivery). Refresh the callback timestamp and any
  -- updated error detail so operators see the latest callback time, but do
  -- not re-fire admin events and report changed=false.
  IF v_previous_status IS NOT NULL AND v_status = v_previous_status THEN
    UPDATE public.whatsapp_outbox
       SET twilio_error_code = v_error_code,
           twilio_error_message = v_error_message,
           twilio_status_updated_at = pg_catalog.clock_timestamp(),
           last_error = CASE
             WHEN v_status IN ('failed', 'undelivered')
               THEN COALESCE(v_error_message, v_error_code, last_error)
             ELSE last_error
           END
     WHERE id = v_outbox_id;
    RETURN QUERY SELECT true, false;
    RETURN;
  END IF;

  v_transition_allowed := CASE
    WHEN v_previous_status IS NULL THEN true
    WHEN v_previous_status IN ('failed', 'undelivered', 'read') THEN false
    WHEN v_status = 'queued' THEN false
    WHEN v_status = 'accepted' THEN v_previous_status = 'queued'
    WHEN v_status = 'sent' THEN v_previous_status IN ('queued', 'accepted')
    WHEN v_status = 'delivered' THEN v_previous_status IN ('queued', 'accepted', 'sent')
    WHEN v_status = 'read' THEN v_previous_status IN ('queued', 'accepted', 'sent', 'delivered')
    WHEN v_status IN ('failed', 'undelivered')
      THEN v_previous_status IN ('queued', 'accepted', 'sent')
    ELSE false
  END;

  IF NOT v_transition_allowed THEN
    RETURN QUERY SELECT true, false;
    RETURN;
  END IF;

  UPDATE public.whatsapp_outbox
     SET twilio_delivery_status = v_status,
         twilio_error_code = v_error_code,
         twilio_error_message = v_error_message,
         twilio_status_updated_at = pg_catalog.clock_timestamp(),
         last_error = CASE
           WHEN v_status IN ('failed', 'undelivered')
             THEN COALESCE(v_error_message, v_error_code, last_error)
           ELSE last_error
         END
   WHERE id = v_outbox_id;

  IF v_source_type = 'admin_case'
     AND v_source_id IS NOT NULL
     AND v_status IN ('delivered', 'read', 'undelivered', 'failed')
     AND EXISTS (SELECT 1 FROM public.admin_cases WHERE id = v_source_id) THEN
    INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload)
    VALUES (
      v_source_id,
      CASE
        WHEN v_status IN ('undelivered', 'failed') THEN 'admin_reply_delivery_failed'
        WHEN v_status = 'read' THEN 'admin_reply_read'
        ELSE 'admin_reply_delivered'
      END,
      'system',
      'twilio',
      jsonb_build_object(
        'title', CASE
          WHEN v_status IN ('undelivered', 'failed') THEN 'WhatsApp reply delivery failed'
          WHEN v_status = 'read' THEN 'WhatsApp reply read'
          ELSE 'WhatsApp reply delivered'
        END,
        'detail', COALESCE(v_error_message, v_error_code, v_status),
        'twilioMessageSid', p_twilio_message_sid,
        'twilioStatus', v_status,
        'twilioErrorCode', v_error_code,
        'twilioErrorMessage', v_error_message,
        'outboxId', v_outbox_id
      )
    );

    UPDATE public.admin_cases
       SET details = details || jsonb_build_object(
             'lastOutboundTwilioSid', p_twilio_message_sid,
             'lastOutboundTwilioStatus', v_status,
             'lastOutboundTwilioErrorCode', v_error_code,
             'lastOutboundTwilioErrorMessage', v_error_message
           ),
           updated_at = pg_catalog.now()
     WHERE id = v_source_id;
  END IF;

  RETURN QUERY SELECT true, true;
END;
$$;

ALTER FUNCTION jale_twilio_callback.record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT)
  OWNER TO jale_twilio_callback;
REVOKE ALL ON FUNCTION jale_twilio_callback.record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_twilio_callback.record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT) TO jale_whatsapp;
RESET ROLE;
DO $$ BEGIN
  EXECUTE format('GRANT jale_twilio_callback TO %I WITH SET FALSE, INHERIT FALSE', current_user);
  EXECUTE format('REVOKE jale_twilio_callback FROM %I GRANTED BY %I', current_user, current_user);
END $$;

DO $$
DECLARE fn RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('worker_onboarding_state'), ('worker_workflow_runs'), ('worker_workflow_transitions'),
      ('worker_identity_challenges'), ('worker_message_intents'), ('worker_domain_outbox'),
      ('worker_reset_audit'), ('whatsapp_runtime_controls')
    ) expected(name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = expected.name
        AND c.relrowsecurity AND c.relforcerowsecurity
    )
  ) THEN RAISE EXCEPTION 'migration 042 RLS self-audit failed'; END IF;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('worker_workflow_one_active'), ('worker_message_intent_dedupe'),
      ('worker_domain_outbox_event_key'), ('worker_message_intents_release_sequence_unique')
    ) expected(name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relname = expected.name)
  ) THEN RAISE EXCEPTION 'migration 042 constraint self-audit failed'; END IF;

  FOR fn IN SELECT * FROM (VALUES
    ('public', 'load_worker_pre_auth', '25'::oidvector, 'jale_admin'),
    ('public', 'save_worker_pre_auth', '25 3802'::oidvector, 'jale_admin'),
    ('public', 'bind_verified_identity_and_start_workflow', '25 2950 2950 23 25 25 3802'::oidvector, 'jale_admin'),
    ('public', 'lease_worker_domain_events', '25 23'::oidvector, 'jale_admin'),
    ('jale_twilio_callback', 'record_whatsapp_delivery_status', '25 25 25 25'::oidvector, 'jale_twilio_callback')
  ) AS required(schema_name, function_name, argument_types, owner_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      WHERE n.nspname = fn.schema_name AND p.proname = fn.function_name
        AND p.proargtypes = fn.argument_types AND r.rolname = fn.owner_name
        AND p.prosecdef
        AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
        AND NOT pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
    ) THEN RAISE EXCEPTION 'migration 042 function self-audit failed: %.%', fn.schema_name, fn.function_name; END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege('jale_whatsapp', 'public.whatsapp_runtime_controls', 'UPDATE')
     OR pg_catalog.has_table_privilege('jale_whatsapp', 'public.whatsapp_runtime_controls', 'INSERT')
     OR pg_catalog.has_table_privilege('jale_whatsapp', 'public.whatsapp_runtime_controls', 'DELETE') THEN
    RAISE EXCEPTION 'runtime controls are writable by jale_whatsapp';
  END IF;
END $$;

COMMIT;
