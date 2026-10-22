-- ============================================================
-- 129_org_owner_carry_overs.sql
-- Run manually AFTER 128_company_limits.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Employer organizations: Phase 1's owner gaps, carried over (125's hire
-- details, from merging PR #105 with sprint 28; 119's owner job edits).
--
-- (1) HIRE DETAILS. 125's jale_cap.employer_save_hire_details (owner
--     jale_cap_hire_details) and jale_cap.employer_hire_details_notice
--     (owner jale_cap_worker_lane) accept only the job's own employer, and
--     jale_cap_hire_details' policies on jobs and job_applications show only
--     the caller's own jobs, so a company owner saving details on a
--     foreman's hire gets not_found. As 119 did for 105's capability
--     functions:
--       * each function is replaced by its 125 definition with only the
--         caller comparison changed to
--           (j.employer_id::text = v_caller OR jale_internal.is_org_owner_of(v_caller, j.employer_id)),
--         under its 125 owner (temporary SET window, closed again); the
--         notice's owner reads a member's job and application through 119's
--         jale_cap_worker_lane owner policies, which must exist;
--       * jale_cap_hire_details gets three permissive owner policies beside
--         its 125 ones, through the array helper:
--           x = ANY ((SELECT jale_internal.org_owner_scope(caller, false))::uuid[]);
--       * the helpers' owner (jale_rls_relationship_reader) grants
--         jale_cap_hire_details USAGE on jale_internal and EXECUTE on
--         is_org_owner_of and org_owner_scope, inside its window.
--     A foreman keeps exactly today's reach; signatures, results and
--     callers are unchanged.
-- (2) OWNER EDITS ON A SUSPENDED MEMBER'S JOB. 119's jobs_org_owner_update
--     checked the new row against the owner's ACTIVE members, so an owner
--     could not pause or close a suspended foreman's job in place. Its WITH
--     CHECK now accepts any member (as its USING does), and the trigger
--     jobs_assignee_must_be_active (a jale_admin definer that reads at most
--     two memberships behind 127's organization_members_trigger_read gate),
--     BEFORE UPDATE OF employer_id, status, refuses (42501), for every role:
--       * a move (employer_id changes) to a person with no membership
--         (DETAIL assignee_not_member), to a member who is not active
--         (assignee_inactive), of a job whose employer has no membership
--         (job_employer_not_member), or to a member of another company than
--         the job's current employer (assignee_other_company);
--       * a reactivation (status changes INTO 'active') of a job whose
--         employer, after the update, is not an active member
--         (employer_inactive_for_activation): 128's rule that a foreman
--         still suspended keeps their jobs paused holds for the owner's
--         relaxed WITH CHECK too. One rewrite, not a refusal: 105's
--         hired-count recount (jale_cap.sync_job_hired_counts) reopens a
--         filled job on any application write once its hires no longer fill
--         it (filled -> active inside the job_applications trigger,
--         pg_trigger_depth() > 1). Refusing it would fail a worker's
--         application or anyone's un-hire, and letting it through would let
--         the owner (who may write the job's applications) reopen the job,
--         so it reopens to paused while the employer is not an active
--         member: billing_paused_at is set only when the member is billing
--         suspended (128's billing_restore_org resumes it once the member is
--         restored); otherwise it stays NULL. The recount never moves a
--         paused job, so later application writes leave it paused. A direct
--         statement, filled -> active included, is refused.
--     The trigger's WHEN skips everything else: edits to an active job, and
--     status changes to paused, closed or filled. The DETAIL is the reason's
--     stable code, so Phase 3 can tell each refusal from an RLS denial.
--     The guard takes no row locks: serialising a move or a reactivation
--     with a concurrent suspend or remove is the caller's job (Phase 3's
--     handlers take the company lock, employer_org_usage(true), first).
--     128's billing_restore_org restores members before it resumes their
--     jobs, and resumes only active members' jobs, so it passes.
--
-- LOCK ORDER. Everything on jobs and job_applications (three policies, the
-- ALTER POLICY, the trigger) is the last section.
--
-- REPLAY: refused once jobs_cap_hire_details_org_owner_select exists.
-- ============================================================
BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── Preconditions ───────────────────────────────────────────
DO $$
BEGIN
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'migration 129: connect as the migration login itself, without SET ROLE';
  END IF;
  IF to_regprocedure('jale_cap.employer_org_usage(boolean)') IS NULL THEN
    RAISE EXCEPTION 'migration 129: apply 128 first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'jobs_cap_hire_details_org_owner_select') THEN
    RAISE EXCEPTION 'migration 129: already applied; it is not re-runnable';
  END IF;
  IF to_regprocedure('jale_internal.is_org_owner_of(text, uuid)') IS NULL
     OR to_regprocedure('jale_internal.org_owner_scope(text, boolean)') IS NULL THEN
    RAISE EXCEPTION 'migration 129: the 118 org helpers are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure('jale_cap.employer_save_hire_details(uuid, uuid, date, text, text, text, text)')
                    AND r.rolname = 'jale_cap_hire_details')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure('jale_cap.employer_hire_details_notice(uuid, text)')
                    AND r.rolname = 'jale_cap_worker_lane') THEN
    RAISE EXCEPTION 'migration 129: a 125 function this migration replaces is missing or has an unexpected owner';
  END IF;
  IF NOT has_function_privilege('jale_cap_worker_lane', 'jale_internal.is_org_owner_of(text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 129: jale_cap_worker_lane cannot execute is_org_owner_of (119''s grant is missing)';
  END IF;
  -- The notice's owner reads a member's job and application through 119's policies.
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.jobs'::regclass
                  AND polname = 'jobs_cap_worker_lane_org_owner_select'
                  AND polroles = ARRAY['jale_cap_worker_lane'::regrole::oid])
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.job_applications'::regclass
                     AND polname = 'job_applications_cap_worker_lane_org_owner_select'
                     AND polroles = ARRAY['jale_cap_worker_lane'::regrole::oid]) THEN
    RAISE EXCEPTION 'migration 129: 119''s jobs_cap_worker_lane_org_owner_select / job_applications_cap_worker_lane_org_owner_select are missing';
  END IF;
  -- 119's owner UPDATE policy, in the shape section 5 relaxes: its exact
  -- USING (any member) and WITH CHECK (active members), as the catalog
  -- prints them on a bed with 128 applied.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.jobs'::regclass AND p.polname = 'jobs_org_owner_update'
       AND p.polcmd = 'w' AND p.polpermissive
       AND p.polroles = ARRAY['jale_api'::regrole::oid]
       AND pg_get_expr(p.polqual, p.polrelid)
           = $q$(employer_id = ANY (( SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id'::text, true), false) AS org_owner_scope)::uuid[]))$q$
       AND pg_get_expr(p.polwithcheck, p.polrelid)
           = $q$(employer_id = ANY (( SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id'::text, true), true) AS org_owner_scope)::uuid[]))$q$
  ) THEN
    RAISE EXCEPTION 'migration 129: jobs_org_owner_update (119) is missing or drifted';
  END IF;
  -- 127's gate, which the job-move guard reads memberships behind.
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.organization_members'::regclass
                  AND polname = 'organization_members_trigger_read' AND polroles = ARRAY['jale_admin'::regrole::oid]) THEN
    RAISE EXCEPTION 'migration 129: organization_members_trigger_read (127) is missing';
  END IF;
  IF to_regprocedure('public.jobs_assignee_must_be_active()') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 129: public.jobs_assignee_must_be_active already exists';
  END IF;
END $$;

-- ── 1. The hire-details owner may call the org helpers ──────
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_rls_relationship_reader', current_user);
END $$;
SET LOCAL ROLE jale_rls_relationship_reader;
GRANT USAGE ON SCHEMA jale_internal TO jale_cap_hire_details;
GRANT EXECUTE ON FUNCTION jale_internal.is_org_owner_of(TEXT, UUID) TO jale_cap_hire_details;
GRANT EXECUTE ON FUNCTION jale_internal.org_owner_scope(TEXT, BOOLEAN) TO jale_cap_hire_details;
RESET ROLE;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', 'jale_rls_relationship_reader', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_rls_relationship_reader', current_user, current_user);
END $$;

-- ── 2. employer_save_hire_details: the owner case ───────────
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_cap_hire_details', current_user);
END $$;
SET LOCAL ROLE jale_cap_hire_details;

CREATE OR REPLACE FUNCTION jale_cap.employer_save_hire_details(
  p_job_id          UUID,
  p_worker_id       UUID,
  p_start_date      DATE,
  p_report_location TEXT,
  p_contact_name    TEXT,
  p_contact_phone   TEXT,
  p_notes           TEXT
)
RETURNS TABLE (
  outcome         TEXT,
  application_id  UUID,
  changed         BOOLEAN,
  start_date      TEXT,
  report_location TEXT,
  contact_name    TEXT,
  contact_phone   TEXT,
  notes           TEXT,
  updated_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller      TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_location    TEXT := NULLIF(pg_catalog.btrim(p_report_location), '');
  v_name        TEXT := NULLIF(pg_catalog.btrim(p_contact_name), '');
  v_phone       TEXT := NULLIF(pg_catalog.btrim(p_contact_phone), '');
  v_notes       TEXT := NULLIF(pg_catalog.btrim(p_notes), '');
  v_app         UUID;
  v_status      TEXT;
  v_old_start   DATE;
  v_old_loc     TEXT;
  v_old_name    TEXT;
  v_old_phone   TEXT;
  v_old_notes   TEXT;
  v_old_updated TIMESTAMPTZ;
  v_changed     BOOLEAN;
  v_updated     TIMESTAMPTZ;
BEGIN
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'employer_save_hire_details: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_job_id IS NULL OR p_worker_id IS NULL THEN
    RAISE EXCEPTION 'employer_save_hire_details: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 129: the job's employer, or the active owner of their company.
  SELECT ja.id, ja.status, ja.hire_start_date, ja.hire_report_location, ja.hire_contact_name,
         ja.hire_contact_phone, ja.hire_notes, ja.hire_details_updated_at
    INTO v_app, v_status, v_old_start, v_old_loc, v_old_name, v_old_phone, v_old_notes, v_old_updated
    FROM public.job_applications ja
    JOIN public.jobs j ON j.id = ja.job_id
   WHERE ja.job_id = p_job_id
     AND ja.worker_id = p_worker_id
     AND (j.employer_id::text = v_caller OR jale_internal.is_org_owner_of(v_caller, j.employer_id))
     FOR UPDATE OF ja;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, false, NULL::text, NULL::text, NULL::text,
                        NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_status <> 'hired' THEN
    RETURN QUERY SELECT 'not_hired'::text, NULL::uuid, false, NULL::text, NULL::text, NULL::text,
                        NULL::text, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  v_changed := (v_old_start, v_old_loc, v_old_name, v_old_phone, v_old_notes)
               IS DISTINCT FROM (p_start_date, v_location, v_name, v_phone, v_notes);
  IF v_changed OR v_old_updated IS NULL THEN
    UPDATE public.job_applications ja
       SET hire_start_date = p_start_date,
           hire_report_location = v_location,
           hire_contact_name = v_name,
           hire_contact_phone = v_phone,
           hire_notes = v_notes,
           hire_details_updated_at = pg_catalog.now()
     WHERE ja.id = v_app
    RETURNING ja.hire_details_updated_at INTO v_updated;
  ELSE
    v_updated := v_old_updated;
  END IF;

  RETURN QUERY SELECT 'saved'::text, v_app, v_changed, pg_catalog.to_char(p_start_date, 'YYYY-MM-DD'),
                      v_location, v_name, v_phone, v_notes, v_updated;
END;
$fn$;

RESET ROLE;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', 'jale_cap_hire_details', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_cap_hire_details', current_user, current_user);
END $$;

-- ── 3. employer_hire_details_notice: the owner case ─────────
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_cap_worker_lane', current_user);
END $$;
SET LOCAL ROLE jale_cap_worker_lane;

CREATE OR REPLACE FUNCTION jale_cap.employer_hire_details_notice(
  p_application_id UUID,
  p_body           TEXT
)
RETURNS TABLE (outcome TEXT, intent_id UUID, outbox_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller     TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_worker     UUID;
  v_job        UUID;
  v_status     TEXT;
  v_saved_at   TIMESTAMPTZ;
  v_lifecycle  TEXT;
  v_enabled    BOOLEAN;
  v_number     TEXT;
  v_inbound_at TIMESTAMPTZ;
  v_dedupe     TEXT;
  v_intent     UUID;
  v_outbox     UUID;
BEGIN
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'employer_hire_details_notice: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_application_id IS NULL OR p_body IS NULL OR pg_catalog.btrim(p_body) = ''
     OR pg_catalog.char_length(p_body) > 1600 THEN
    RAISE EXCEPTION 'employer_hire_details_notice: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 129: the job's employer, or the active owner of their company.
  SELECT ja.worker_id, ja.job_id, ja.status, ja.hire_details_updated_at
    INTO v_worker, v_job, v_status, v_saved_at
    FROM public.job_applications ja
    JOIN public.jobs j ON j.id = ja.job_id
   WHERE ja.id = p_application_id
     AND (j.employer_id::text = v_caller OR jale_internal.is_org_owner_of(v_caller, j.employer_id));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employer_hire_details_notice: the application is not on one of the caller''s jobs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_status <> 'hired' OR v_saved_at IS NULL THEN
    RETURN QUERY SELECT 'no_details'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  -- The gate, as the intent claim reads it (no row means onboarding), and
  -- the deferred-delivery control (missing means off).
  SELECT s.lifecycle INTO v_lifecycle
    FROM public.worker_onboarding_state s
   WHERE s.user_id = v_worker
     FOR UPDATE OF s;
  IF COALESCE(v_lifecycle, 'onboarding') <> 'ready' THEN
    RETURN QUERY SELECT 'not_ready'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  SELECT c.enabled INTO v_enabled
    FROM public.whatsapp_runtime_controls c
   WHERE c.control_key = 'deferred_delivery_enabled';
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN QUERY SELECT 'delivery_disabled'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  SELECT COALESCE(u.whatsapp_number, u.phone) INTO v_number
    FROM public.users u
   WHERE u.id = v_worker;
  IF v_number IS NULL OR v_number = '' THEN
    RETURN QUERY SELECT 'no_number'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  -- Free text is delivered only inside the window the worker's own last
  -- message opened, with 15 minutes kept for the drain.
  SELECT p.first_seen_at INTO v_inbound_at
    FROM public.whatsapp_processed_messages p
   WHERE p.whatsapp_number = v_number
     AND pg_catalog.strpos(p.message_sid, '#') = 0
   ORDER BY p.first_seen_at DESC
   LIMIT 1;
  IF v_inbound_at IS NULL OR v_inbound_at <= pg_catalog.now() - interval '23 hours 45 minutes' THEN
    RETURN QUERY SELECT 'outside_window'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  v_dedupe := 'hire-details:' || p_application_id::text || ':'
              || pg_catalog.floor(pg_catalog.date_part('epoch', v_saved_at) * 1000)::bigint::text;
  INSERT INTO public.worker_message_intents AS i (
    user_id, category, owner_service, source_type, source_id, dedupe_key,
    priority, status, policy_version, payload, expires_at
  )
  VALUES (v_worker, 'account', 'account', 'hire_details', p_application_id, v_dedupe,
          30, 'deferred', 1,
          pg_catalog.jsonb_build_object('kind', 'hire_details', 'applicationId', p_application_id, 'jobId', v_job),
          pg_catalog.now() + interval '1 day')
  ON CONFLICT ON CONSTRAINT worker_message_intent_dedupe DO NOTHING
  RETURNING i.id INTO v_intent;
  IF v_intent IS NULL THEN
    RETURN QUERY SELECT 'duplicate'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  UPDATE public.worker_message_intents i
     SET status = 'eligible', decision_reason = 'worker_ready', updated_at = pg_catalog.now()
   WHERE i.id = v_intent;
  v_outbox := pg_catalog.gen_random_uuid();
  INSERT INTO public.whatsapp_outbox (
    id, inbound_message_sid, sequence, whatsapp_number, body, content_template, content_variables,
    source_type, source_id
  )
  VALUES (v_outbox, NULL, 1, v_number, p_body, NULL, NULL, 'worker_intent', v_intent);
  UPDATE public.worker_message_intents i
     SET outbox_id = v_outbox
   WHERE i.id = v_intent;

  RETURN QUERY SELECT 'queued'::text, v_intent, v_outbox;
END;
$fn$;

RESET ROLE;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', 'jale_cap_worker_lane', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_cap_worker_lane', current_user, current_user);
END $$;

-- ── 4. The job-move and reactivation guard's function ───────
-- A jale_admin definer, like 127's stamping function: it reads at most two
-- memberships behind 127's gate, and locks nothing. Its trigger is in
-- section 5; its WHEN admits only a move or a change INTO 'active'.
CREATE FUNCTION public.jobs_assignee_must_be_active()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_moved    BOOLEAN := OLD.employer_id IS DISTINCT FROM NEW.employer_id;
  v_from_org UUID;
  v_to_org   UUID;
  v_status   TEXT;
  v_billing  TIMESTAMPTZ;
BEGIN
  PERFORM pg_catalog.set_config('app.org_trigger_read', 'on', true);
  IF v_moved THEN
    SELECT m.organization_id INTO v_from_org
      FROM public.organization_members m
     WHERE m.user_id = OLD.employer_id;
  END IF;
  SELECT m.organization_id, m.status, m.billing_suspended_at INTO v_to_org, v_status, v_billing
    FROM public.organization_members m
   WHERE m.user_id = NEW.employer_id;
  PERFORM pg_catalog.set_config('app.org_trigger_read', '', true);

  -- Refused for every role, the superuser's fixtures included.
  IF v_moved THEN
    IF v_to_org IS NULL THEN
      RAISE EXCEPTION 'jobs: a job moves only to an active member of its own company'
        USING ERRCODE = 'insufficient_privilege', DETAIL = 'assignee_not_member',
              HINT = 'The new employer has no company membership.';
    END IF;
    IF v_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'jobs: a job moves only to an active member of its own company'
        USING ERRCODE = 'insufficient_privilege', DETAIL = 'assignee_inactive',
              HINT = 'The new employer is a suspended or removed member.';
    END IF;
    IF v_from_org IS NULL THEN
      RAISE EXCEPTION 'jobs: a job moves only to an active member of its own company'
        USING ERRCODE = 'insufficient_privilege', DETAIL = 'job_employer_not_member',
              HINT = 'The job''s current employer has no company membership.';
    END IF;
    IF v_to_org IS DISTINCT FROM v_from_org THEN
      RAISE EXCEPTION 'jobs: a job moves only to an active member of its own company'
        USING ERRCODE = 'insufficient_privilege', DETAIL = 'assignee_other_company',
              HINT = 'The new employer is a member of another company.';
    END IF;
  END IF;

  -- A change INTO 'active' needs an active employer (128: a foreman still
  -- suspended keeps their jobs paused).
  IF OLD.status IS DISTINCT FROM 'active' AND NEW.status = 'active'
     AND v_status IS DISTINCT FROM 'active' THEN
    -- 105's hired-count recount reopening a filled job (a hire undone, a job
    -- that now needs more workers) runs inside the job_applications trigger
    -- (depth > 1) on any application write, a worker's own included, so it
    -- cannot be refused; and anyone who may write the job's applications
    -- (the owner included) can trigger it, so it cannot be let through
    -- either. It reopens to paused instead, billing-marked when the member
    -- is billing-suspended (128's restore resumes it with the member), and
    -- the recount leaves a paused job paused on every later write. No event
    -- is written: 105 writes none for its own filled -> active either.
    IF OLD.status = 'filled' AND pg_catalog.pg_trigger_depth() > 1 THEN
      NEW.status := 'paused';
      IF v_billing IS NOT NULL THEN
        NEW.billing_paused_at := pg_catalog.now();
      END IF;
      RETURN NEW;
    END IF;
    -- A direct statement, filled -> active included, is refused.
    RAISE EXCEPTION 'jobs: only an active member''s job can be made active'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'employer_inactive_for_activation',
            HINT = 'The job''s employer is not an active member of a company; reassign the job or restore the member first.';
  END IF;
  RETURN NEW;
END;
$fn$;
ALTER FUNCTION public.jobs_assignee_must_be_active() OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.jobs_assignee_must_be_active() FROM PUBLIC;

-- ── 5. Last: jobs and job_applications ──────────────────────
-- The hire-details owner's reads, owner case.
CREATE POLICY jobs_cap_hire_details_org_owner_select ON public.jobs
  AS PERMISSIVE FOR SELECT TO jale_cap_hire_details
  USING (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]));
CREATE POLICY job_applications_cap_hire_details_org_owner_select ON public.job_applications
  AS PERMISSIVE FOR SELECT TO jale_cap_hire_details
  USING (job_id IN (SELECT j.id FROM public.jobs j
                     WHERE j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));
CREATE POLICY job_applications_cap_hire_details_org_owner_update ON public.job_applications
  AS PERMISSIVE FOR UPDATE TO jale_cap_hire_details
  USING (job_id IN (SELECT j.id FROM public.jobs j
                     WHERE j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])))
  WITH CHECK (job_id IN (SELECT j.id FROM public.jobs j
                     WHERE j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));

-- The owner may edit any member's job in place; moves are the trigger's.
ALTER POLICY jobs_org_owner_update ON public.jobs
  WITH CHECK (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]));

CREATE TRIGGER jobs_assignee_must_be_active
  BEFORE UPDATE OF employer_id, status ON public.jobs
  FOR EACH ROW
  WHEN (OLD.employer_id IS DISTINCT FROM NEW.employer_id
        OR (OLD.status IS DISTINCT FROM 'active' AND NEW.status = 'active'))
  EXECUTE FUNCTION public.jobs_assignee_must_be_active();

-- ── Self-check ──────────────────────────────────────────────
DO $$
DECLARE
  fn    RECORD;
  v_def TEXT;
BEGIN
  SET LOCAL search_path = pg_catalog, pg_temp;

  -- Replaced functions keep their owners, definer status, search_path and
  -- their one caller, and carry the owner case.
  FOR fn IN
    SELECT * FROM (VALUES
      ('jale_cap.employer_save_hire_details(uuid, uuid, date, text, text, text, text)', 'jale_cap_hire_details'),
      ('jale_cap.employer_hire_details_notice(uuid, text)', 'jale_cap_worker_lane')
    ) AS t(sig, owner_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid = to_regprocedure(fn.sig) AND r.rolname = fn.owner_name AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::TEXT[]
    ) OR has_function_privilege('public', to_regprocedure(fn.sig), 'EXECUTE')
       OR NOT has_function_privilege('jale_api', to_regprocedure(fn.sig), 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                   WHERE p.oid = to_regprocedure(fn.sig) AND a.privilege_type = 'EXECUTE'
                     AND a.grantee <> p.proowner AND pg_get_userbyid(a.grantee) <> 'jale_api') THEN
      RAISE EXCEPTION 'migration 129: % drifted', fn.sig;
    END IF;
    IF position('jale_internal.is_org_owner_of(v_caller, j.employer_id)' IN pg_get_functiondef(to_regprocedure(fn.sig))) = 0 THEN
      RAISE EXCEPTION 'migration 129: % has no owner case', fn.sig;
    END IF;
  END LOOP;

  -- The hire-details owner may call both helpers its function and policies use.
  IF NOT has_schema_privilege('jale_cap_hire_details', 'jale_internal', 'USAGE')
     OR NOT has_function_privilege('jale_cap_hire_details', to_regprocedure('jale_internal.is_org_owner_of(text, uuid)'), 'EXECUTE')
     OR NOT has_function_privilege('jale_cap_hire_details', to_regprocedure('jale_internal.org_owner_scope(text, boolean)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 129: jale_cap_hire_details cannot reach the org helpers';
  END IF;

  -- The three owner policies, permissive, for the hire-details owner only.
  IF (SELECT count(*) FROM pg_policy
       WHERE polname IN ('jobs_cap_hire_details_org_owner_select', 'job_applications_cap_hire_details_org_owner_select',
                         'job_applications_cap_hire_details_org_owner_update')
         AND polpermissive AND polroles = ARRAY['jale_cap_hire_details'::regrole::oid]) <> 3 THEN
    RAISE EXCEPTION 'migration 129: the hire-details owner policies are not as reviewed';
  END IF;

  -- 119's worker-lane owner policies, which the notice reads through, are in place.
  IF (SELECT count(*) FROM pg_policy
       WHERE polname IN ('jobs_cap_worker_lane_org_owner_select', 'job_applications_cap_worker_lane_org_owner_select')
         AND polroles = ARRAY['jale_cap_worker_lane'::regrole::oid]) <> 2 THEN
    RAISE EXCEPTION 'migration 129: 119''s worker-lane owner policies are missing';
  END IF;

  -- The job-move guard: a jale_admin definer nobody may call, on its trigger.
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.oid = to_regprocedure('public.jobs_assignee_must_be_active()')
          AND r.rolname = 'jale_admin' AND p.prosecdef
          AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::TEXT[]
     ) OR has_function_privilege('public', to_regprocedure('public.jobs_assignee_must_be_active()'), 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.jobs'::regclass AND tgname = 'jobs_assignee_must_be_active'
                     AND tgfoid = to_regprocedure('public.jobs_assignee_must_be_active()') AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'migration 129: jobs_assignee_must_be_active is missing or drifted';
  END IF;
  -- Nobody but its owner holds EXECUTE on the guard's function.
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid = to_regprocedure('public.jobs_assignee_must_be_active()')
                AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) THEN
    RAISE EXCEPTION 'migration 129: someone besides jale_admin may execute jobs_assignee_must_be_active()';
  END IF;
  -- Its trigger: timing, columns and WHEN exactly as reviewed.
  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_assignee_must_be_active';
  IF v_def IS DISTINCT FROM
       $d$CREATE TRIGGER jobs_assignee_must_be_active BEFORE UPDATE OF employer_id, status ON public.jobs FOR EACH ROW WHEN (((old.employer_id IS DISTINCT FROM new.employer_id) OR ((old.status IS DISTINCT FROM 'active'::text) AND (new.status = 'active'::text)))) EXECUTE FUNCTION public.jobs_assignee_must_be_active()$d$ THEN
    RAISE EXCEPTION 'migration 129: the jobs_assignee_must_be_active trigger drifted: %', v_def;
  END IF;

  -- jobs_org_owner_update: WITH CHECK is now its USING (any member of the company).
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.jobs'::regclass AND p.polname = 'jobs_org_owner_update'
       AND pg_get_expr(p.polwithcheck, p.polrelid) = pg_get_expr(p.polqual, p.polrelid)
  ) THEN
    RAISE EXCEPTION 'migration 129: jobs_org_owner_update WITH CHECK was not relaxed to any member';
  END IF;

  -- Every window is closed.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member
     WHERE g.rolname IN ('jale_rls_relationship_reader', 'jale_cap_hire_details', 'jale_cap_worker_lane')
       AND u.rolname = current_user AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'migration 129: a role window was left open';
  END IF;

  -- No gate is left open.
  IF current_setting('app.org_trigger_read', true) = 'on' THEN
    RAISE EXCEPTION 'migration 129: app.org_trigger_read was left open';
  END IF;
END $$;

COMMIT;
