-- ============================================================
-- 119_employer_org_owner_access.sql
-- Run manually AFTER 118_employer_organizations.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Employer organizations, Phase 1 milestone B
-- (docs/superpowers/specs/2026-10-15-employer-organizations-design.md).
--
-- A company's active owner may act on every member's jobs, applicants and
-- conversations; a foreman keeps exactly today's per-person reach. No
-- existing policy is dropped or rewritten in place: every per-person policy
-- stays, and permissive *_org_owner policies are added beside them for
-- jale_api (and, for the capability functions' own reads, for their owner
-- roles). Row policies test x = ANY ((SELECT
-- jale_internal.org_owner_scope(caller, false))::uuid[]) (118): the array
-- is computed once per statement and the comparison can use an index
-- (without the cast, ANY ((SELECT ...)) parses as the subquery form:
-- uuid = uuid[]). Job reassignment's WITH CHECK uses
-- org_owner_scope(caller, true), so a job moves only to an active member.
-- The caller is app.current_internal_user_id, which resolveEmployerActor
-- always sets.
--
-- Also: jale_internal.employer_has_applicant_relationship gains the owner
-- case (so every policy that calls it -- users, trust tables, worker posts
-- and media, onboarding state -- follows), through the same array helper
-- (org_owner_scope, once per call), and three capability functions
-- that compare j.employer_id to the caller accept the member's owner:
-- jale_cap.upload_token_issue, jale_cap.employer_stage_recipient and the
-- two job checks in jale_cap.employer_claim_worker_intent. Each is replaced
-- by its 105 definition with only those comparisons changed, under its 105
-- owner (temporary SET window, closed again as in 105).
--
-- Company templates: every active member reads them
-- (jale_internal.org_member_scope; a removed member's templates stay with
-- the company); the owner may edit or delete any.
--
-- LOCK ORDER. CREATE POLICY takes an ACCESS EXCLUSIVE lock on its table,
-- held to COMMIT. The policies on public.jobs and public.job_applications
-- (the hottest tables: every employer and worker read) are created after
-- every other policy and function, just before the catch-up back-fill, so
-- those locks are taken last and held for the shortest time.
--
-- CATCH-UP BACK-FILL. 118 may be applied before Milestone A's
-- post-confirmation Lambda is deployed, and that Lambda keeps a new
-- employer's users row without a company while
-- employer_ensure_organization does not exist yet (SQLSTATE 42883): such
-- an employer has no membership. 118 section (6)'s back-fill, restricted to
-- employer users with no organization_members row, gives each one a
-- one-person company, behind the same gates (app.org_bootstrap,
-- app.employer_name_lookup) and the same temporary users_org_bootstrap_read
-- policy, which is dropped again before COMMIT. Like 118's, it runs last,
-- so the ACCESS EXCLUSIVE lock its CREATE POLICY takes on users is held for
-- the shortest time.
-- ============================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── Preconditions ───────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('jale_internal.is_org_owner_of(text, uuid)') IS NULL
     OR to_regprocedure('jale_internal.shares_org_with(text, uuid)') IS NULL
     OR to_regprocedure('jale_internal.org_owner_scope(text, boolean)') IS NULL
     OR to_regprocedure('jale_internal.org_member_scope(text)') IS NULL THEN
    RAISE EXCEPTION 'migration 119: the 118 org helpers are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.organizations'::regclass AND polname = 'organizations_org_bootstrap')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.organization_members'::regclass AND polname = 'organization_members_org_bootstrap')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.employer_profiles'::regclass AND polname = 'employer_profiles_name_lookup') THEN
    RAISE EXCEPTION 'migration 119: a gated policy the catch-up back-fill needs is missing (118 / 031)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.users'::regclass AND polname = 'users_org_bootstrap_read') THEN
    RAISE EXCEPTION 'migration 119: users_org_bootstrap_read already exists; 118 must have dropped it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure('jale_cap.upload_token_issue(text, uuid, uuid)') AND r.rolname = 'jale_cap_upload_tokens')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure('jale_cap.employer_stage_recipient(uuid)') AND r.rolname = 'jale_cap_worker_lane')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure('jale_cap.employer_claim_worker_intent(uuid, text, uuid, jsonb, jsonb)') AND r.rolname = 'jale_cap_worker_lane')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure('jale_internal.employer_has_applicant_relationship(text, uuid)') AND r.rolname = 'jale_rls_relationship_reader') THEN
    RAISE EXCEPTION 'migration 119: a function this migration replaces has an unexpected owner (105 / 038)';
  END IF;
END $$;

-- ── Owner policies for jale_api ─────────────────────────────
-- Each row check is x = ANY ((SELECT jale_internal.org_owner_scope(...))::uuid[]):
-- one evaluation per statement, then an index-usable comparison.
CREATE POLICY job_conversations_org_owner_all ON public.job_conversations AS PERMISSIVE FOR ALL TO jale_api
  USING (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]))
  WITH CHECK (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]));

CREATE POLICY job_messages_org_owner_all ON public.job_conversation_messages AS PERMISSIVE FOR ALL TO jale_api
  USING (EXISTS (SELECT 1 FROM public.job_conversations jc
                  WHERE jc.id = job_conversation_messages.conversation_id
                    AND jc.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])))
  WITH CHECK (EXISTS (SELECT 1 FROM public.job_conversations jc
                  WHERE jc.id = job_conversation_messages.conversation_id
                    AND jc.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));

CREATE POLICY job_outbox_org_owner_all ON public.job_message_outbox AS PERMISSIVE FOR ALL TO jale_api
  USING (EXISTS (SELECT 1 FROM public.job_conversations jc
                  WHERE jc.id = job_message_outbox.conversation_id
                    AND jc.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])))
  WITH CHECK (EXISTS (SELECT 1 FROM public.job_conversations jc
                  WHERE jc.id = job_message_outbox.conversation_id
                    AND jc.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));

CREATE POLICY employer_candidate_rankings_org_owner_read ON public.employer_candidate_rankings AS PERMISSIVE FOR SELECT TO jale_api
  USING (EXISTS (SELECT 1 FROM public.jobs j
                  WHERE j.id = employer_candidate_rankings.job_id
                    AND j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));

-- Beside 106's job_visibility_events_dedupe_read__api (the edit handler's dedupe read).
CREATE POLICY job_visibility_events_org_owner_read ON public.job_visibility_events AS PERMISSIVE FOR SELECT TO jale_api
  USING (job_id IN (SELECT jobs.id FROM public.jobs
                     WHERE jobs.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));

CREATE POLICY worker_profiles_org_owner_read ON public.worker_profiles AS PERMISSIVE FOR SELECT TO jale_api
  USING (EXISTS (SELECT 1 FROM public.job_applications ja JOIN public.jobs j ON j.id = ja.job_id
                  WHERE ja.worker_id = worker_profiles.user_id
                    AND j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));
CREATE POLICY worker_skills_org_owner_read ON public.worker_skills AS PERMISSIVE FOR SELECT TO jale_api
  USING (EXISTS (SELECT 1 FROM public.job_applications ja JOIN public.jobs j ON j.id = ja.job_id
                  WHERE ja.worker_id = worker_skills.worker_id
                    AND j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));

CREATE POLICY worker_documents_org_owner_select ON public.worker_documents AS PERMISSIVE FOR SELECT TO jale_api
  USING (job_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.job_applications ja JOIN public.jobs j ON j.id = ja.job_id
     WHERE ja.worker_id = worker_documents.worker_id AND ja.job_id = worker_documents.job_id
       AND j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));
CREATE POLICY worker_documents_org_owner_delete ON public.worker_documents AS PERMISSIVE FOR DELETE TO jale_api
  USING (EXISTS (SELECT 1 FROM public.jobs j
                  WHERE j.id = worker_documents.job_id
                    AND j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));

-- Every active member reads the company's templates, including a removed
-- or suspended member's: templates stay with the company.
CREATE POLICY employer_job_templates_org_read ON public.employer_job_templates AS PERMISSIVE FOR SELECT TO jale_api
  USING (employer_id = ANY ((SELECT jale_internal.org_member_scope(current_setting('app.current_internal_user_id', true)))::uuid[]));
CREATE POLICY employer_job_templates_org_owner_update ON public.employer_job_templates AS PERMISSIVE FOR UPDATE TO jale_api
  USING (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]))
  WITH CHECK (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]));
CREATE POLICY employer_job_templates_org_owner_delete ON public.employer_job_templates AS PERMISSIVE FOR DELETE TO jale_api
  USING (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]));

-- ── The capability owners' reads ────────────────────────────
-- Their EXECUTE on org_owner_scope and is_org_owner_of is granted by the
-- functions' owner, inside the relationship-reader window below.
CREATE POLICY job_conversations_cap_worker_lane_org_owner_select ON public.job_conversations AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]));
CREATE POLICY job_conversation_messages_cap_worker_lane_org_owner_select ON public.job_conversation_messages AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (conversation_id IN (SELECT jc.id FROM public.job_conversations jc
                              WHERE jc.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));

-- ── Applicant predicate: the owner case ─────────────────────
-- Also the capability owners' EXECUTE on the two helpers they call: only the
-- functions' owner may grant it, so it is granted here, as that owner.
-- The owner case uses the array helper, like the row policies: the policies
-- that call this predicate run it once per candidate row, so the company is
-- read once per call (an initplan), not once per application of the worker.
-- jale_rls_relationship_reader owns org_owner_scope, so it may execute it.
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_rls_relationship_reader', current_user);
END $$;
SET LOCAL ROLE jale_rls_relationship_reader;
GRANT EXECUTE ON FUNCTION jale_internal.is_org_owner_of(TEXT, UUID) TO jale_cap_upload_tokens, jale_cap_worker_lane;
GRANT EXECUTE ON FUNCTION jale_internal.org_owner_scope(TEXT, BOOLEAN) TO jale_cap_upload_tokens, jale_cap_worker_lane;
CREATE OR REPLACE FUNCTION jale_internal.employer_has_applicant_relationship(
  p_employer_internal_id TEXT,
  p_worker_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.job_applications ja
      JOIN public.jobs j ON j.id = ja.job_id
     WHERE ja.worker_id = p_worker_id
       AND (j.employer_id::TEXT = p_employer_internal_id
            OR j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(p_employer_internal_id, false))::uuid[]))
  );
$$;
RESET ROLE;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET FALSE', 'jale_rls_relationship_reader', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_rls_relationship_reader', current_user, current_user);
END $$;

-- ── Capability functions: the owner case ────────────────────
-- Each function is re-created by its 105 owner, which already holds CREATE
-- on jale_cap (104:256), under 105's temporary SET window.
DO $$
DECLARE
  owner_role TEXT;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY['jale_cap_upload_tokens', 'jale_cap_worker_lane'] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', owner_role, current_user);
  END LOOP;
END $$;

SET LOCAL ROLE jale_cap_upload_tokens;
-- 105:127-165, with one comparison changed (marked).
CREATE OR REPLACE FUNCTION jale_cap.upload_token_issue(
  p_token_hash TEXT,
  p_job_id     UUID,
  p_worker_id  UUID
)
RETURNS TABLE (outcome TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller  TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_expires TIMESTAMPTZ;
BEGIN
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'upload_token_issue: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_job_id IS NULL OR p_worker_id IS NULL THEN
    RAISE EXCEPTION 'upload_token_issue: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Only the employer who owns the job (or their company's owner, 119),
  -- only for a worker who applied to it.
  IF NOT EXISTS (
       SELECT 1 FROM public.jobs j
        WHERE j.id = p_job_id
          AND (j.employer_id::text = v_caller                                    -- 119
               OR jale_internal.is_org_owner_of(v_caller, j.employer_id))        -- 119
     )
     OR NOT jale_internal.worker_has_application(p_worker_id::text, p_job_id) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::timestamptz;
    RETURN;
  END IF;

  v_expires := now() + interval '7 days';
  INSERT INTO public.document_upload_tokens (token_hash, worker_id, job_id, expires_at)
  VALUES (p_token_hash, p_worker_id, p_job_id, v_expires);
  RETURN QUERY SELECT 'ok'::text, v_expires;
END;
$fn$;
RESET ROLE;

SET LOCAL ROLE jale_cap_worker_lane;
-- 105:524-574, with one comparison changed (marked).
CREATE OR REPLACE FUNCTION jale_cap.employer_stage_recipient(
  p_application_id UUID
)
RETURNS TABLE (worker_id UUID, language TEXT, has_whatsapp_number BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_worker UUID;
  v_number TEXT;
  v_lang   TEXT;
BEGIN
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'employer_stage_recipient: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_application_id IS NULL THEN
    RAISE EXCEPTION 'employer_stage_recipient: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT ja.worker_id INTO v_worker
    FROM public.job_applications ja
    JOIN public.jobs j ON j.id = ja.job_id
   WHERE ja.id = p_application_id
     AND (j.employer_id::text = v_caller                                         -- 119
          OR jale_internal.is_org_owner_of(v_caller, j.employer_id));            -- 119
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employer_stage_recipient: the application is not on one of the caller''s jobs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The stage notification's own rules: the newest workflow run's language
  -- (es without one), and the number COALESCE(whatsapp_number, phone), where
  -- an empty value counts as no number.
  SELECT COALESCE(u.whatsapp_number, u.phone) INTO v_number
    FROM public.users u
   WHERE u.id = v_worker;
  SELECT COALESCE((
    SELECT r.preferred_language
      FROM public.worker_workflow_runs r
     WHERE r.user_id = v_worker
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 1
  ), 'es') INTO v_lang;

  RETURN QUERY SELECT v_worker, v_lang, (v_number IS NOT NULL AND v_number <> '');
END;
$fn$;

-- 105:576-792, with the two job comparisons changed (marked). Its
-- relationship check (105:637) already follows the predicate above.
CREATE OR REPLACE FUNCTION jale_cap.employer_claim_worker_intent(
  p_worker_id UUID,
  p_kind      TEXT,
  p_source_id UUID,
  p_payload   JSONB,
  p_message   JSONB
)
RETURNS TABLE (
  intent_id           UUID,
  decision_action     TEXT,
  decision_reason     TEXT,
  outbox_id           UUID,
  outbox_materialized BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller        TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_payload       JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_expires       TIMESTAMPTZ := now() + interval '7 days';
  v_category      TEXT;
  v_owner_service TEXT;
  v_source_type   TEXT;
  v_priority      INTEGER;
  v_dedupe        TEXT;
  v_conversation  UUID;
  v_source_worker UUID;
  v_app_job       UUID;
  v_app_status    TEXT;
  v_app_updated   TIMESTAMPTZ;
  v_intent        UUID;
  v_intent_outbox UUID;
  v_status        TEXT;
  v_lifecycle     TEXT;
  v_enabled       BOOLEAN;
  v_action        TEXT;
  v_reason        TEXT;
  v_number        TEXT;
  v_outbox        UUID;
BEGIN
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'employer_claim_worker_intent: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_worker_id IS NULL OR p_kind IS NULL OR p_source_id IS NULL
     OR jsonb_typeof(v_payload) <> 'object'
     OR (p_message IS NOT NULL AND NOT (
           (COALESCE(jsonb_typeof(p_message -> 'body') = 'string', false)
            AND (p_message ->> 'body') <> ''
            AND NOT (p_message ? 'content_template') AND NOT (p_message ? 'content_variables'))
        OR (COALESCE(jsonb_typeof(p_message -> 'content_template') = 'string', false)
            AND (p_message ->> 'content_template') <> ''
            AND COALESCE(jsonb_typeof(p_message -> 'content_variables') = 'object', false)
            AND NOT (p_message ? 'body'))
     )) THEN
    RAISE EXCEPTION 'employer_claim_worker_intent: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The worker must be one of the caller's applicants, whatever the source
  -- row says: a conversation could name another worker.
  IF NOT jale_internal.employer_has_applicant_relationship(v_caller, p_worker_id) THEN
    RAISE EXCEPTION 'employer_claim_worker_intent: the worker is not one of the caller''s applicants'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The source must belong to the caller, and the worker must be its worker.
  -- Everything the intent records is derived from the kind and the source.
  IF p_kind = 'employer_chat' THEN
    SELECT jc.id, jc.worker_id INTO v_conversation, v_source_worker
      FROM public.job_conversation_messages m
      JOIN public.job_conversations jc ON jc.id = m.conversation_id
     WHERE m.id = p_source_id
       AND m.sender_type = 'employer'
       AND (jc.employer_id::text = v_caller                                      -- 119
            OR jale_internal.is_org_owner_of(v_caller, jc.employer_id));        -- 119
    IF NOT FOUND OR v_source_worker <> p_worker_id THEN
      RAISE EXCEPTION 'employer_claim_worker_intent: the message is not the caller''s message to this worker'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_category := 'employer_chat';
    v_owner_service := 'job-messaging';
    v_source_type := 'job_conversation_message';
    v_priority := 40;
    v_dedupe := 'employer-chat:' || p_source_id::text;
    v_payload := v_payload || jsonb_build_object('conversationId', v_conversation);
  ELSIF p_kind = 'application_stage' THEN
    SELECT ja.job_id, ja.worker_id, ja.status, ja.updated_at
      INTO v_app_job, v_source_worker, v_app_status, v_app_updated
      FROM public.job_applications ja
      JOIN public.jobs j ON j.id = ja.job_id
     WHERE ja.id = p_source_id
       AND (j.employer_id::text = v_caller                                       -- 119
            OR jale_internal.is_org_owner_of(v_caller, j.employer_id));         -- 119
    IF NOT FOUND OR v_source_worker <> p_worker_id THEN
      RAISE EXCEPTION 'employer_claim_worker_intent: the application is not on one of the caller''s jobs for this worker'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_app_status NOT IN ('details_requested', 'hired') THEN
      RAISE EXCEPTION 'employer_claim_worker_intent: the application''s status is not one that notifies the worker'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_category := 'account';
    v_owner_service := 'account';
    v_source_type := 'application_stage';
    v_priority := 30;
    -- The application's current status and its updated_at in whole
    -- milliseconds (truncated): a resend in a new transaction gets a new key.
    v_dedupe := 'application-stage:' || p_source_id::text || ':' || v_app_status || ':'
                || floor(extract(epoch FROM v_app_updated) * 1000)::bigint::text;
    v_payload := v_payload || jsonb_build_object(
      'kind', 'application_stage', 'status', v_app_status, 'applicationId', p_source_id, 'jobId', v_app_job);
  ELSE
    RAISE EXCEPTION 'employer_claim_worker_intent: unknown kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The claim: a new intent starts deferred; a repeat of a deferred or
  -- eligible intent only touches updated_at; any other existing intent is
  -- returned as it is.
  WITH attempted AS (
    INSERT INTO public.worker_message_intents AS i (
      user_id, category, owner_service, source_type, source_id, dedupe_key,
      priority, status, policy_version, payload, expires_at
    )
    VALUES (p_worker_id, v_category, v_owner_service, v_source_type, p_source_id, v_dedupe,
            v_priority, 'deferred', 1, v_payload, v_expires)
    ON CONFLICT ON CONSTRAINT worker_message_intent_dedupe
      DO UPDATE SET updated_at = now()
       WHERE i.status IN ('deferred', 'eligible')
    RETURNING i.id, i.outbox_id, i.status
  )
  SELECT a.id, a.outbox_id, a.status INTO v_intent, v_intent_outbox, v_status
    FROM attempted a
  UNION ALL
  SELECT e.id, e.outbox_id, e.status
    FROM public.worker_message_intents e
   WHERE e.dedupe_key = v_dedupe
     AND NOT EXISTS (SELECT 1 FROM attempted)
  LIMIT 1;
  IF v_intent IS NULL THEN
    RAISE EXCEPTION 'employer_claim_worker_intent: the intent claim returned no row';
  END IF;

  IF v_status NOT IN ('deferred', 'eligible') THEN
    RETURN QUERY SELECT v_intent,
      CASE WHEN v_status IN ('leased', 'released', 'delivered') THEN 'allow'
           WHEN v_status = 'expired' THEN 'expire'
           ELSE 'reject' END::text,
      CASE WHEN v_status IN ('leased', 'released', 'delivered') THEN 'worker_ready'
           WHEN v_status = 'expired' THEN 'intent_expired'
           ELSE 'invalid_owner' END::text,
      v_intent_outbox,
      false;
    RETURN;
  END IF;

  -- The gate (the worker's onboarding row locked; no row means onboarding)
  -- and the deferred-delivery control (missing means off).
  SELECT s.lifecycle INTO v_lifecycle
    FROM public.worker_onboarding_state s
   WHERE s.user_id = p_worker_id
     FOR UPDATE OF s;
  v_lifecycle := COALESCE(v_lifecycle, 'onboarding');
  SELECT c.enabled INTO v_enabled
    FROM public.whatsapp_runtime_controls c
   WHERE c.control_key = 'deferred_delivery_enabled';
  v_enabled := COALESCE(v_enabled, false);

  IF v_expires <= now() THEN
    v_action := 'expire'; v_reason := 'intent_expired';
  ELSIF v_lifecycle = 'suspended' THEN
    v_action := 'reject'; v_reason := 'worker_suspended';
  ELSIF v_lifecycle = 'onboarding' THEN
    v_action := 'defer'; v_reason := 'worker_onboarding';
  ELSIF NOT v_enabled THEN
    v_action := 'defer'; v_reason := 'delivery_disabled';
  ELSE
    v_action := 'allow'; v_reason := 'worker_ready';
  END IF;

  UPDATE public.worker_message_intents i
     SET status = CASE v_action WHEN 'allow' THEN 'eligible' WHEN 'defer' THEN 'deferred'
                                WHEN 'reject' THEN 'rejected' ELSE 'expired' END,
         decision_reason = v_reason,
         updated_at = now()
   WHERE i.id = v_intent
     AND i.status IN ('deferred', 'eligible');

  IF v_action = 'allow' AND v_intent_outbox IS NULL THEN
    -- The recipient is always the worker's own number, read here.
    SELECT COALESCE(u.whatsapp_number, u.phone) INTO v_number
      FROM public.users u
     WHERE u.id = p_worker_id;
    IF p_message IS NULL OR v_number IS NULL OR v_number = '' THEN
      UPDATE public.worker_message_intents i
         SET status = 'rejected', decision_reason = 'renderer_unavailable', updated_at = now()
       WHERE i.id = v_intent
         AND i.status = 'eligible';
      RETURN QUERY SELECT v_intent, 'reject'::text, 'renderer_unavailable'::text, NULL::uuid, false;
      RETURN;
    END IF;

    v_outbox := gen_random_uuid();
    INSERT INTO public.whatsapp_outbox (
      id, inbound_message_sid, sequence, whatsapp_number, body, content_template, content_variables,
      source_type, source_id
    )
    VALUES (v_outbox, NULL, 1, v_number, p_message ->> 'body', p_message ->> 'content_template',
            p_message -> 'content_variables', 'worker_intent', v_intent);
    UPDATE public.worker_message_intents i
       SET outbox_id = v_outbox
     WHERE i.id = v_intent;
    RETURN QUERY SELECT v_intent, v_action, v_reason, v_outbox, true;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_intent, v_action, v_reason, v_intent_outbox, false;
END;
$fn$;
RESET ROLE;

DO $$
DECLARE
  owner_role TEXT;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY['jale_cap_upload_tokens', 'jale_cap_worker_lane'] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', owner_role, current_user);
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', owner_role, current_user, current_user);
  END LOOP;
END $$;

-- ── Owner policies on jobs and job_applications ────────────
-- The hottest tables, so CREATE POLICY's ACCESS EXCLUSIVE lock on them is
-- taken last (before only the catch-up's lock on users) and held for the
-- shortest time before COMMIT. Same row check as above.
CREATE POLICY jobs_org_owner_select ON public.jobs AS PERMISSIVE FOR SELECT TO jale_api
  USING (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]));
-- Reassignment: any member's job (USING), but only to an active member (WITH CHECK).
CREATE POLICY jobs_org_owner_update ON public.jobs AS PERMISSIVE FOR UPDATE TO jale_api
  USING (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]))
  WITH CHECK (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), true))::uuid[]));
CREATE POLICY jobs_org_owner_delete ON public.jobs AS PERMISSIVE FOR DELETE TO jale_api
  USING (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]));

CREATE POLICY applications_org_owner_select ON public.job_applications AS PERMISSIVE FOR SELECT TO jale_api
  USING (job_id IN (SELECT jobs.id FROM public.jobs
                     WHERE jobs.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));
CREATE POLICY applications_org_owner_update ON public.job_applications AS PERMISSIVE FOR UPDATE TO jale_api
  USING (job_id IN (SELECT jobs.id FROM public.jobs
                     WHERE jobs.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])))
  WITH CHECK (job_id IN (SELECT jobs.id FROM public.jobs
                     WHERE jobs.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));

-- The capability owners' reads of the same two tables.
CREATE POLICY jobs_cap_upload_tokens_org_owner_select ON public.jobs AS PERMISSIVE FOR SELECT TO jale_cap_upload_tokens
  USING (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]));
CREATE POLICY jobs_cap_worker_lane_org_owner_select ON public.jobs AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]));
CREATE POLICY job_applications_cap_worker_lane_org_owner_select ON public.job_applications AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (job_id IN (SELECT j.id FROM public.jobs j
                     WHERE j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));

-- ── Catch-up back-fill ──────────────────────────────────────
-- 118 section (6), for employers with no membership yet (confirmed between
-- 118 and Milestone A's post-confirmation Lambda). Last, as in 118, so the
-- ACCESS EXCLUSIVE lock CREATE POLICY takes on users is held for the
-- shortest time before COMMIT. jale_admin reads users under FORCE RLS: this
-- policy lets it see employer rows while the bootstrap gate is open; it
-- exists only for this section and is dropped at its end.
CREATE POLICY users_org_bootstrap_read ON public.users
  AS PERMISSIVE FOR SELECT TO jale_admin
  USING (current_setting('app.org_bootstrap', true) = 'on' AND user_type = 'employer');

SELECT set_config('app.org_bootstrap', 'on', true);
SELECT set_config('app.employer_name_lookup', 'on', true);

CREATE TEMP TABLE org_catchup ON COMMIT DROP AS
SELECT u.id                  AS user_id,
       gen_random_uuid()     AS organization_id,
       COALESCE(NULLIF(btrim(ep.company_name), ''), NULLIF(btrim(u.full_name), ''), 'Employer') AS name,
       u.created_at          AS joined_at
  FROM public.users u
  LEFT JOIN public.employer_profiles ep ON ep.user_id = u.id
 WHERE u.user_type = 'employer'
   AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = u.id);

INSERT INTO public.organizations (id, name, created_at, updated_at)
SELECT organization_id, name, joined_at, joined_at FROM org_catchup;

INSERT INTO public.organization_members (user_id, organization_id, role, status, joined_at, status_changed_at)
SELECT user_id, organization_id, 'owner', 'active', joined_at, joined_at FROM org_catchup;

DO $$
DECLARE
  v_missing BIGINT;
BEGIN
  SELECT count(*) INTO v_missing
    FROM public.users u
   WHERE u.user_type = 'employer'
     AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = u.id);
  IF v_missing <> 0 THEN
    RAISE EXCEPTION 'migration 119: % employer users still have no company after the catch-up back-fill', v_missing;
  END IF;
END $$;

SELECT set_config('app.employer_name_lookup', 'off', true);
SELECT set_config('app.org_bootstrap', 'off', true);

DROP POLICY users_org_bootstrap_read ON public.users;

-- ── Self-check ──────────────────────────────────────────────
DO $$
DECLARE
  fn RECORD;
  v_sig      TEXT;
  v_role     TEXT;
  -- 22 policies, in polname order.
  v_expected CONSTANT TEXT[] := ARRAY[
    'applications_org_owner_select', 'applications_org_owner_update',
    'employer_candidate_rankings_org_owner_read', 'employer_job_templates_org_owner_delete',
    'employer_job_templates_org_owner_update', 'employer_job_templates_org_read', 'job_applications_cap_worker_lane_org_owner_select',
    'job_conversation_messages_cap_worker_lane_org_owner_select', 'job_conversations_cap_worker_lane_org_owner_select',
    'job_conversations_org_owner_all', 'job_messages_org_owner_all', 'job_outbox_org_owner_all',
    'job_visibility_events_org_owner_read',
    'jobs_cap_upload_tokens_org_owner_select', 'jobs_cap_worker_lane_org_owner_select',
    'jobs_org_owner_delete', 'jobs_org_owner_select', 'jobs_org_owner_update',
    'worker_documents_org_owner_delete', 'worker_documents_org_owner_select',
    'worker_profiles_org_owner_read', 'worker_skills_org_owner_read'];
BEGIN
  SET LOCAL search_path = pg_catalog, pg_temp;

  -- The catch-up left nothing open. (Its own fail-closed count ran while the
  -- gates were open; with them closed jale_admin no longer sees those rows.)
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.users'::regclass AND polname = 'users_org_bootstrap_read') THEN
    RAISE EXCEPTION 'migration 119: users_org_bootstrap_read must not outlive the catch-up back-fill';
  END IF;
  IF current_setting('app.org_bootstrap', true) IS DISTINCT FROM 'off'
     OR current_setting('app.employer_name_lookup', true) IS DISTINCT FROM 'off' THEN
    RAISE EXCEPTION 'migration 119: a gate was left open';
  END IF;

  IF (SELECT array_agg(polname::text ORDER BY polname) FROM pg_policy
       WHERE polname LIKE '%org_owner%' OR polname = 'employer_job_templates_org_read')
     IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'migration 119: the owner policy set drifted';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = ANY (v_expected) AND NOT polpermissive) THEN
    RAISE EXCEPTION 'migration 119: an owner policy is restrictive';
  END IF;
  -- Every owner policy goes through an array helper (one call per
  -- statement), never the per-row predicate.
  IF EXISTS (SELECT 1 FROM pg_policy
              WHERE polname = ANY (v_expected)
                AND (position('is_org_owner_of' IN coalesce(pg_get_expr(polqual, polrelid), '')) > 0
                     OR position('is_org_owner_of' IN coalesce(pg_get_expr(polwithcheck, polrelid), '')) > 0)) THEN
    RAISE EXCEPTION 'migration 119: an owner policy calls is_org_owner_of per row';
  END IF;

  -- The capability owners may call both helpers their policies and functions use.
  FOREACH v_sig IN ARRAY ARRAY['jale_internal.is_org_owner_of(text, uuid)', 'jale_internal.org_owner_scope(text, boolean)'] LOOP
    FOREACH v_role IN ARRAY ARRAY['jale_cap_upload_tokens', 'jale_cap_worker_lane'] LOOP
      IF NOT has_function_privilege(v_role, to_regprocedure(v_sig), 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 119: % cannot execute %', v_role, v_sig;
      END IF;
    END LOOP;
  END LOOP;

  -- Replaced functions keep their owners, definer status, search_path and grants.
  FOR fn IN
    SELECT * FROM (VALUES
      ('jale_cap.upload_token_issue(text, uuid, uuid)', 'jale_cap_upload_tokens', 'jale_api', 'is_org_owner_of'),
      ('jale_cap.employer_stage_recipient(uuid)', 'jale_cap_worker_lane', 'jale_api', 'is_org_owner_of'),
      ('jale_cap.employer_claim_worker_intent(uuid, text, uuid, jsonb, jsonb)', 'jale_cap_worker_lane', 'jale_api', 'is_org_owner_of'),
      -- The predicate runs inside per-row policies: the array helper, once per call.
      ('jale_internal.employer_has_applicant_relationship(text, uuid)', 'jale_rls_relationship_reader', 'jale_api', 'org_owner_scope')
    ) AS t(sig, owner_name, caller, owner_helper)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid = to_regprocedure(fn.sig) AND r.rolname = fn.owner_name AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::TEXT[]
    ) OR has_function_privilege('public', to_regprocedure(fn.sig), 'EXECUTE')
       OR NOT has_function_privilege(fn.caller, to_regprocedure(fn.sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 119: % drifted', fn.sig;
    END IF;
    IF position(fn.owner_helper IN pg_get_functiondef(to_regprocedure(fn.sig))) = 0 THEN
      RAISE EXCEPTION 'migration 119: % has no owner case', fn.sig;
    END IF;
  END LOOP;
  IF position('is_org_owner_of' IN pg_get_functiondef(to_regprocedure('jale_internal.employer_has_applicant_relationship(text, uuid)'))) > 0 THEN
    RAISE EXCEPTION 'migration 119: employer_has_applicant_relationship calls is_org_owner_of per row';
  END IF;
  IF NOT has_function_privilege('jale_rls_relationship_reader', to_regprocedure('jale_internal.org_owner_scope(text, boolean)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 119: jale_rls_relationship_reader cannot execute org_owner_scope';
  END IF;

  -- All the windows are closed.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member
     WHERE g.rolname IN ('jale_rls_relationship_reader', 'jale_cap_upload_tokens', 'jale_cap_worker_lane')
       AND u.rolname = current_user AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'migration 119: a role window was left open';
  END IF;
END $$;

COMMIT;
