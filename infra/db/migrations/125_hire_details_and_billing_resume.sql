-- ============================================================
-- 125_hire_details_and_billing_resume.sql
-- Run manually AFTER 124 (sprint 28 applies 120-126 in number order),
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
-- It reads nothing created by 120-124.
--
-- Sprint 28, lane BE-4a. Two parts.
--
-- (A) HIRE DETAILS, THE WORKER'S WEB MESSAGE, THE EMPLOYER NUDGE (F19)
--   job_applications gains the start details an employer gives a hired
--   worker (start date, where to report, contact name and phone, notes,
--   when they were last saved) and two sweep stamps (when the employer
--   was last nudged, when the worker last asked for a reminder). Every new
--   column is nullable; the text columns are trimmed and bounded.
--   The request logins already read every column of the table (table-level
--   SELECT), so reads need no grant. Writes go through definers:
--     jale_cap.employer_save_hire_details        caller jale_api
--       owner jale_cap_hire_details: saves the details for a hired
--       applicant on one of the caller's jobs.
--     jale_cap.employer_hire_details_notice      caller jale_api
--       owner jale_cap_worker_lane: one "details added" WhatsApp line,
--       free text, only inside the worker's 24-hour window (the inbound log
--       whatsapp_processed_messages, 23h45m, bot-written ids excluded),
--       only for a ready worker while deferred delivery is on; otherwise it
--       writes nothing. One line per saved version of the details.
--     jale_cap.worker_post_application_message   caller jale_whatsapp
--       owner jale_cap_worker_messages: a hired worker's web message to the
--       employer. It opens the conversation when none is open, adds one
--       inbound worker message, and moves last_message_at only:
--       last_worker_message_at stays the WhatsApp reply window, and the
--       owner holds no right on employer_last_read_at. At most 10 web
--       messages (no provider message id) an hour per application.
--     jale_cap.worker_application_sent_messages  caller jale_whatsapp
--       owner jale_cap_worker_messages: the worker's own web-sent messages
--       on one application (latest 20, oldest first), for their page.
--     jale_cap.claim_hire_details_nudges          caller jale_job_digest
--     jale_cap.mark_hire_details_nudged           caller jale_job_digest
--       owner jale_cap_hire_nudges: the sweep's claim and stamp. A hired
--       application with no details is due once 24 hours after the hire
--       (hires of the last 7 days) and once more for each worker reminder.
--       The claim returns and locks due rows and stamps nothing; the sweep
--       stamps each row only after its email is queued, in the same
--       transaction, so a failed or cut-off sweep leaves the rest due.
--   Existing hires older than 24 hours are stamped at apply (section 1b),
--   so the first sweep mails no backlog; a worker reminder still reaches
--   them through the reminder branch.
--   jale_whatsapp may write hire_details_reminded_at (the remind button) and
--   still not hired_at. The sweep's login, jale_job_digest, may now also
--   queue and read back nudge mail (source_type hire_details_nudge),
--   beside its digest mail (106).
--
-- (B) PAUSED-JOB AUTO-RESUME
--   jobs.billing_paused_at marks a job the billing enforcer paused.
--   billing_pause_over_limit_jobs (036) is replaced, same signature and
--   result, to set it. billing_resume_paused_jobs(user, limit) resumes only
--   marked paused jobs, oldest first, up to the limit minus the active
--   jobs; a marked job whose hires already fill it comes back filled (029's
--   rule) and takes no slot. It never touches a closed or filled job, clears
--   the mark, records
--   one job_status_events row per job (actor billing) and announces a
--   public job to the visibility drain. The billing login may now also
--   queue and read back resume mail (source_type billing_resume), beside
--   its pause mail (037). An employer's own status write clears the mark
--   (code, not this file).
--   job_status_events is new and append-only: the enforcer inserts, the
--   master reads it only behind 089's admin analytics flag. The console
--   reads it only through public.admin_recent_job_resumes(limit), a
--   jale_admin definer like its analytics peers that returns event and job
--   ids and times, newest first (admin Home activity).
--
-- OWNERSHIP. The three new owners follow 107: NOLOGIN, NOINHERIT, member of
-- nothing, the creator's ADMIN-only row their only membership. Functions are
-- created by jale_admin and transferred inside a SET window that is closed
-- again (108). The enforcer's functions are written as the enforcer inside
-- its own window (036). The closing checks prove every window is closed.
--
-- DEPLOY ORDER: apply BEFORE the release deploy. The deployed code names
-- none of the new columns or functions, so it keeps working; the new code
-- needs them.
--
-- LOCKS: ADD COLUMN with CHECKs takes ACCESS EXCLUSIVE on job_applications
-- and jobs until COMMIT (the CHECKs scan existing rows once). Apply in a
-- quiet window.
--
-- REPLAY. Refused with a clear message once job_status_events exists.
-- ============================================================
BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Preconditions ────────────────────────────────────────
DO $$
BEGIN
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'migration 125: connect as the migration login itself, without SET ROLE';
  END IF;
  IF pg_catalog.to_regclass('public.job_status_events') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 125: already applied (public.job_status_events exists); it is not re-runnable';
  END IF;
  IF pg_catalog.to_regnamespace('jale_cap') IS NULL
     OR pg_catalog.to_regnamespace('jale_billing_internal') IS NULL
     OR (SELECT count(*) FROM pg_catalog.pg_roles
          WHERE rolname IN ('jale_api', 'jale_whatsapp', 'jale_billing', 'jale_job_digest',
                            'jale_cap_worker_lane', 'jale_billing_job_enforcer')) <> 6
     -- By catalog row: jale_admin holds no USAGE on jale_billing_internal (036),
     -- so it cannot resolve a name in it.
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'jale_billing_internal' AND p.proname = 'billing_pause_over_limit_jobs'
                      AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_active_job_limit integer')
     OR pg_catalog.to_regprocedure('public.enqueue_job_visibility_event(uuid, text, text)') IS NULL
     OR pg_catalog.to_regprocedure('public.assign_worker_thread_number(uuid)') IS NULL THEN
    RAISE EXCEPTION 'migration 125: apply the chain up to 117 first (a schema, role or function it builds on is missing)';
  END IF;
END;
$$;

-- ── 1. Columns ──────────────────────────────────────────────
ALTER TABLE public.job_applications
  ADD COLUMN hire_start_date          DATE,
  ADD COLUMN hire_report_location     TEXT,
  ADD COLUMN hire_contact_name        TEXT,
  ADD COLUMN hire_contact_phone       TEXT,
  ADD COLUMN hire_notes               TEXT,
  ADD COLUMN hire_details_updated_at  TIMESTAMPTZ,
  ADD COLUMN hire_details_nudged_at   TIMESTAMPTZ,
  ADD COLUMN hire_details_reminded_at TIMESTAMPTZ,
  ADD CONSTRAINT job_applications_hire_report_location_check
    CHECK (hire_report_location IS NULL
           OR (char_length(hire_report_location) <= 200 AND btrim(hire_report_location) = hire_report_location
               AND hire_report_location <> '')),
  ADD CONSTRAINT job_applications_hire_contact_name_check
    CHECK (hire_contact_name IS NULL
           OR (char_length(hire_contact_name) <= 80 AND btrim(hire_contact_name) = hire_contact_name
               AND hire_contact_name <> '')),
  ADD CONSTRAINT job_applications_hire_contact_phone_check
    CHECK (hire_contact_phone IS NULL
           OR (char_length(hire_contact_phone) <= 32 AND btrim(hire_contact_phone) = hire_contact_phone
               AND hire_contact_phone ~ '^[0-9 +()-]+$')),
  ADD CONSTRAINT job_applications_hire_notes_check
    CHECK (hire_notes IS NULL
           OR (char_length(hire_notes) <= 1000 AND btrim(hire_notes) = hire_notes AND hire_notes <> ''));

ALTER TABLE public.jobs
  ADD COLUMN billing_paused_at TIMESTAMPTZ;

-- ── 1b. No backlog for the nudge ────────────────────────────
-- Hires made more than 24 hours before this migration count as already
-- nudged, so the first sweep mails only hires made from now on. The
-- updated_at trigger is off for this one statement: the stamp is
-- bookkeeping and must not reorder anything that sorts on updated_at. The
-- table is already held ACCESS EXCLUSIVE by the ADD COLUMN above, and the
-- trigger is back on before anything else runs (checked in section 8).
-- BEGIN hire-details nudge backfill
ALTER TABLE public.job_applications DISABLE TRIGGER job_applications_updated_at;
UPDATE public.job_applications
   SET hire_details_nudged_at = pg_catalog.now()
 WHERE status = 'hired'
   AND hired_at IS NOT NULL
   AND hired_at <= pg_catalog.now() - interval '24 hours'
   AND hire_details_nudged_at IS NULL;
ALTER TABLE public.job_applications ENABLE TRIGGER job_applications_updated_at;
-- END hire-details nudge backfill

-- ── 2. The job event log ────────────────────────────────────
CREATE TABLE public.job_status_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID        NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  employer_id UUID        NOT NULL,
  from_status TEXT        NOT NULL,
  to_status   TEXT        NOT NULL,
  actor       TEXT        NOT NULL CONSTRAINT job_status_events_actor_check CHECK (actor IN ('billing')),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_status_events_changed_idx ON public.job_status_events (changed_at);
CREATE INDEX job_status_events_job_idx ON public.job_status_events (job_id, changed_at);

ALTER TABLE public.job_status_events OWNER TO jale_admin;
ALTER TABLE public.job_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_status_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_status_events FROM PUBLIC;

CREATE POLICY job_status_events_billing_insert
  ON public.job_status_events FOR INSERT TO jale_billing_job_enforcer
  WITH CHECK (actor = 'billing');
CREATE POLICY job_status_events_admin_analytics_read
  ON public.job_status_events FOR SELECT TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');
GRANT INSERT ON public.job_status_events TO jale_billing_job_enforcer;

-- ── 3. The new owners (107's pattern) ───────────────────────
DO $$
DECLARE
  owner_role TEXT;
  helper pg_catalog.pg_roles%ROWTYPE;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY['jale_cap_hire_details', 'jale_cap_worker_messages', 'jale_cap_hire_nudges'] LOOP
    SELECT * INTO helper FROM pg_catalog.pg_roles WHERE rolname = owner_role;
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        owner_role
      );
      SELECT * INTO helper FROM pg_catalog.pg_roles WHERE rolname = owner_role;
    END IF;

    IF helper.rolcanlogin OR helper.rolsuper OR helper.rolcreatedb OR helper.rolcreaterole
       OR helper.rolinherit OR helper.rolreplication OR helper.rolbypassrls THEN
      RAISE EXCEPTION 'migration 125: existing role % has unsafe attributes', owner_role;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.member = helper.oid
          OR (am.roleid = helper.oid
              AND NOT (am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                       AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option))
    ) THEN
      RAISE EXCEPTION 'migration 125: role % has unsafe memberships', owner_role;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = helper.oid
         AND am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         AND am.admin_option
    ) THEN
      EXECUTE format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', owner_role, current_user);
    END IF;
  END LOOP;
END;
$$;

-- ALTER FUNCTION ... OWNER TO needs the new owner to hold CREATE on the
-- function's schema.
GRANT CREATE ON SCHEMA jale_cap TO jale_cap_hire_details, jale_cap_worker_messages, jale_cap_hire_nudges;
-- The sweep's login calls its claim in jale_cap.
GRANT USAGE ON SCHEMA jale_cap TO jale_job_digest;

-- ── 4. What each owner holds ────────────────────────────────
-- Hire details: a hired applicant on one of the caller's jobs.
GRANT SELECT (id, job_id, worker_id, status, hire_start_date, hire_report_location, hire_contact_name,
              hire_contact_phone, hire_notes, hire_details_updated_at),
      UPDATE (hire_start_date, hire_report_location, hire_contact_name, hire_contact_phone, hire_notes,
              hire_details_updated_at)
  ON public.job_applications TO jale_cap_hire_details;
GRANT SELECT (id, employer_id) ON public.jobs TO jale_cap_hire_details;

CREATE POLICY job_applications_cap_hire_details_select
  ON public.job_applications FOR SELECT TO jale_cap_hire_details
  USING (job_id IN (SELECT j.id FROM public.jobs j
                     WHERE j.employer_id::text = current_setting('app.current_internal_user_id', true)));
CREATE POLICY job_applications_cap_hire_details_update
  ON public.job_applications FOR UPDATE TO jale_cap_hire_details
  USING (job_id IN (SELECT j.id FROM public.jobs j
                     WHERE j.employer_id::text = current_setting('app.current_internal_user_id', true)))
  WITH CHECK (job_id IN (SELECT j.id FROM public.jobs j
                          WHERE j.employer_id::text = current_setting('app.current_internal_user_id', true)));
CREATE POLICY jobs_cap_hire_details_select
  ON public.jobs FOR SELECT TO jale_cap_hire_details
  USING (employer_id::text = current_setting('app.current_internal_user_id', true));

-- Worker web messages: the caller's own applications and conversations.
GRANT SELECT (id, job_id, worker_id, status) ON public.job_applications TO jale_cap_worker_messages;
GRANT SELECT (id, employer_id) ON public.jobs TO jale_cap_worker_messages;
GRANT SELECT (id, job_id, employer_id, worker_id, application_id, status),
      INSERT (job_id, employer_id, worker_id, application_id, last_message_at, worker_thread_number),
      UPDATE (last_message_at)
  ON public.job_conversations TO jale_cap_worker_messages;
-- body: the worker's own web-sent messages, read back for their page
-- (worker_application_sent_messages).
GRANT SELECT (id, conversation_id, sender_type, direction, twilio_message_sid, created_at, body),
      INSERT (conversation_id, sender_type, direction, body, status)
  ON public.job_conversation_messages TO jale_cap_worker_messages;
GRANT EXECUTE ON FUNCTION public.assign_worker_thread_number(uuid) TO jale_cap_worker_messages;

CREATE POLICY job_applications_cap_worker_messages_select
  ON public.job_applications FOR SELECT TO jale_cap_worker_messages
  USING (worker_id::text = current_setting('app.current_internal_user_id', true));
CREATE POLICY jobs_cap_worker_messages_select
  ON public.jobs FOR SELECT TO jale_cap_worker_messages
  USING (id IN (SELECT ja.job_id FROM public.job_applications ja
                 WHERE ja.worker_id::text = current_setting('app.current_internal_user_id', true)));
CREATE POLICY job_conversations_cap_worker_messages_select
  ON public.job_conversations FOR SELECT TO jale_cap_worker_messages
  USING (worker_id::text = current_setting('app.current_internal_user_id', true));
CREATE POLICY job_conversations_cap_worker_messages_insert
  ON public.job_conversations FOR INSERT TO jale_cap_worker_messages
  WITH CHECK (worker_id::text = current_setting('app.current_internal_user_id', true));
CREATE POLICY job_conversations_cap_worker_messages_update
  ON public.job_conversations FOR UPDATE TO jale_cap_worker_messages
  USING (worker_id::text = current_setting('app.current_internal_user_id', true))
  WITH CHECK (worker_id::text = current_setting('app.current_internal_user_id', true));
CREATE POLICY job_conversation_messages_cap_worker_messages_select
  ON public.job_conversation_messages FOR SELECT TO jale_cap_worker_messages
  USING (conversation_id IN (SELECT jc.id FROM public.job_conversations jc
                              WHERE jc.worker_id::text = current_setting('app.current_internal_user_id', true)));
CREATE POLICY job_conversation_messages_cap_worker_messages_insert
  ON public.job_conversation_messages FOR INSERT TO jale_cap_worker_messages
  WITH CHECK (sender_type = 'worker' AND direction = 'inbound'
              AND conversation_id IN (SELECT jc.id FROM public.job_conversations jc
                                       WHERE jc.worker_id::text = current_setting('app.current_internal_user_id', true)));

-- The nudge sweep: no caller; hired applications only, and the two people
-- named in the nudge.
GRANT SELECT (id, job_id, worker_id, status, hired_at, hire_start_date, hire_report_location, hire_contact_name,
              hire_contact_phone, hire_notes, hire_details_nudged_at, hire_details_reminded_at),
      UPDATE (hire_details_nudged_at)
  ON public.job_applications TO jale_cap_hire_nudges;
GRANT SELECT (id, employer_id, title) ON public.jobs TO jale_cap_hire_nudges;
-- cognito_sub: worker_profiles_self (TO PUBLIC) is evaluated for every
-- reader and its subquery reads that column; the claim never returns it.
GRANT SELECT (id, user_type, email, full_name, cognito_sub) ON public.users TO jale_cap_hire_nudges;
GRANT SELECT (user_id, full_name) ON public.worker_profiles TO jale_cap_hire_nudges;

CREATE POLICY job_applications_cap_hire_nudges_select
  ON public.job_applications FOR SELECT TO jale_cap_hire_nudges
  USING (status = 'hired');
CREATE POLICY job_applications_cap_hire_nudges_update
  ON public.job_applications FOR UPDATE TO jale_cap_hire_nudges
  USING (status = 'hired')
  WITH CHECK (status = 'hired');
CREATE POLICY jobs_cap_hire_nudges_select
  ON public.jobs FOR SELECT TO jale_cap_hire_nudges
  USING (id IN (SELECT ja.job_id FROM public.job_applications ja WHERE ja.status = 'hired'));
CREATE POLICY users_cap_hire_nudges_select
  ON public.users FOR SELECT TO jale_cap_hire_nudges
  USING (id IN (SELECT ja.worker_id FROM public.job_applications ja WHERE ja.status = 'hired')
         OR id IN (SELECT j.employer_id FROM public.jobs j));
CREATE POLICY worker_profiles_cap_hire_nudges_select
  ON public.worker_profiles FOR SELECT TO jale_cap_hire_nudges
  USING (user_id IN (SELECT ja.worker_id FROM public.job_applications ja WHERE ja.status = 'hired'));

-- The worker lane owner: the saved-details stamp (its notice's dedupe) and
-- the inbound log of its applicants' numbers (the 24-hour window).
GRANT SELECT (hire_details_updated_at) ON public.job_applications TO jale_cap_worker_lane;
GRANT SELECT (whatsapp_number, message_sid, first_seen_at) ON public.whatsapp_processed_messages TO jale_cap_worker_lane;
CREATE POLICY whatsapp_processed_messages_cap_worker_lane_select
  ON public.whatsapp_processed_messages FOR SELECT TO jale_cap_worker_lane
  USING (EXISTS (SELECT 1 FROM public.users u
                  WHERE (u.whatsapp_number = whatsapp_processed_messages.whatsapp_number
                         OR u.phone = whatsapp_processed_messages.whatsapp_number)
                    AND jale_internal.employer_has_applicant_relationship(
                          current_setting('app.current_internal_user_id', true), u.id)));

-- The worker's door: the reminder stamp only.
GRANT UPDATE (hire_details_reminded_at) ON public.job_applications TO jale_whatsapp;

-- The billing enforcer: the mark, the resume's visibility ping and its event row.
-- workers_hired and number_of_workers_needed: a resumed job whose hires
-- already fill it comes back filled, never active (029's rule).
GRANT SELECT (public_code, public_listing_enabled, billing_paused_at, workers_hired, number_of_workers_needed),
      UPDATE (billing_paused_at)
  ON public.jobs TO jale_billing_job_enforcer;
GRANT EXECUTE ON FUNCTION public.enqueue_job_visibility_event(uuid, text, text) TO jale_billing_job_enforcer;

-- Mail: one more kind for each producer. Permissive policies OR together, so
-- the billing login may queue and read back billing_pause (037) and
-- billing_resume mail, and the digest login employer_digest (106) and
-- hire_details_nudge mail; neither login any other kind.
CREATE POLICY email_outbox_billing_resume_select
  ON public.email_outbox FOR SELECT TO jale_billing
  USING (source_type = 'billing_resume');
CREATE POLICY email_outbox_billing_resume_insert
  ON public.email_outbox FOR INSERT TO jale_billing
  WITH CHECK (source_type = 'billing_resume');
CREATE POLICY email_outbox_hire_nudge_select
  ON public.email_outbox FOR SELECT TO jale_job_digest
  USING (source_type = 'hire_details_nudge');
CREATE POLICY email_outbox_hire_nudge_insert
  ON public.email_outbox FOR INSERT TO jale_job_digest
  WITH CHECK (source_type = 'hire_details_nudge');

-- ── 5. The jale_cap functions ───────────────────────────────
CREATE FUNCTION jale_cap.employer_save_hire_details(
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

  SELECT ja.id, ja.status, ja.hire_start_date, ja.hire_report_location, ja.hire_contact_name,
         ja.hire_contact_phone, ja.hire_notes, ja.hire_details_updated_at
    INTO v_app, v_status, v_old_start, v_old_loc, v_old_name, v_old_phone, v_old_notes, v_old_updated
    FROM public.job_applications ja
    JOIN public.jobs j ON j.id = ja.job_id
   WHERE ja.job_id = p_job_id
     AND ja.worker_id = p_worker_id
     AND j.employer_id::text = v_caller
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
REVOKE ALL ON FUNCTION jale_cap.employer_save_hire_details(uuid, uuid, date, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.employer_save_hire_details(uuid, uuid, date, text, text, text, text) TO jale_api;

CREATE FUNCTION jale_cap.employer_hire_details_notice(
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

  SELECT ja.worker_id, ja.job_id, ja.status, ja.hire_details_updated_at
    INTO v_worker, v_job, v_status, v_saved_at
    FROM public.job_applications ja
    JOIN public.jobs j ON j.id = ja.job_id
   WHERE ja.id = p_application_id
     AND j.employer_id::text = v_caller;
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
REVOKE ALL ON FUNCTION jale_cap.employer_hire_details_notice(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.employer_hire_details_notice(uuid, text) TO jale_api;

CREATE FUNCTION jale_cap.worker_post_application_message(
  p_application_id UUID,
  p_body           TEXT
)
RETURNS TABLE (
  outcome             TEXT,
  conversation_id     UUID,
  message_id          UUID,
  sent_at             TIMESTAMPTZ,
  retry_after_seconds INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller       TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_body         TEXT := pg_catalog.btrim(p_body);
  v_job          UUID;
  v_employer     UUID;
  v_worker       UUID;
  v_status       TEXT;
  v_conversation UUID;
  v_thread       INTEGER;
  v_count        INTEGER;
  v_tenth        TIMESTAMPTZ;
  v_message      UUID;
  v_sent         TIMESTAMPTZ;
BEGIN
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'worker_post_application_message: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_application_id IS NULL THEN
    RAISE EXCEPTION 'worker_post_application_message: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_body IS NULL OR v_body = '' OR pg_catalog.char_length(v_body) > 2000 THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;

  SELECT ja.job_id, ja.worker_id, ja.status, j.employer_id
    INTO v_job, v_worker, v_status, v_employer
    FROM public.job_applications ja
    JOIN public.jobs j ON j.id = ja.job_id
   WHERE ja.id = p_application_id
     AND ja.worker_id::text = v_caller;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;
  IF v_status <> 'hired' THEN
    RETURN QUERY SELECT 'not_hired'::text, NULL::uuid, NULL::uuid, NULL::timestamptz, NULL::integer;
    RETURN;
  END IF;

  -- One writer per application at a time, so the hour's count below and
  -- the conversation lookup cannot race a second request.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('worker_post_application_message:' || p_application_id::text, 0));

  -- Web messages carry no provider message id; WhatsApp replies do and are
  -- not counted.
  SELECT count(*)::integer INTO v_count
    FROM public.job_conversation_messages m
    JOIN public.job_conversations jc ON jc.id = m.conversation_id
   WHERE jc.application_id = p_application_id
     AND m.sender_type = 'worker'
     AND m.direction = 'inbound'
     AND m.twilio_message_sid IS NULL
     AND m.created_at > pg_catalog.now() - interval '1 hour';
  IF v_count >= 10 THEN
    SELECT m.created_at INTO v_tenth
      FROM public.job_conversation_messages m
      JOIN public.job_conversations jc ON jc.id = m.conversation_id
     WHERE jc.application_id = p_application_id
       AND m.sender_type = 'worker'
       AND m.direction = 'inbound'
       AND m.twilio_message_sid IS NULL
       AND m.created_at > pg_catalog.now() - interval '1 hour'
     ORDER BY m.created_at DESC
    OFFSET 9 LIMIT 1;
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::uuid, NULL::timestamptz,
      GREATEST(1, pg_catalog.ceil(pg_catalog.date_part('epoch', v_tenth + interval '1 hour' - pg_catalog.now()))::integer);
    RETURN;
  END IF;

  SELECT jc.id INTO v_conversation
    FROM public.job_conversations jc
   WHERE jc.job_id = v_job
     AND jc.employer_id = v_employer
     AND jc.worker_id = v_worker
     AND jc.status = 'open'
   LIMIT 1;
  IF v_conversation IS NULL THEN
    v_thread := public.assign_worker_thread_number(v_worker);
    INSERT INTO public.job_conversations AS jc
      (job_id, employer_id, worker_id, application_id, last_message_at, worker_thread_number)
    VALUES (v_job, v_employer, v_worker, p_application_id, pg_catalog.now(), v_thread)
    ON CONFLICT (job_id, employer_id, worker_id) WHERE status = 'open' DO NOTHING
    RETURNING jc.id INTO v_conversation;
    IF v_conversation IS NULL THEN
      SELECT jc.id INTO v_conversation
        FROM public.job_conversations jc
       WHERE jc.job_id = v_job
         AND jc.employer_id = v_employer
         AND jc.worker_id = v_worker
         AND jc.status = 'open'
       LIMIT 1;
    END IF;
    IF v_conversation IS NULL THEN
      RAISE EXCEPTION 'worker_post_application_message: the conversation could not be opened';
    END IF;
  END IF;

  INSERT INTO public.job_conversation_messages AS m (conversation_id, sender_type, direction, body, status)
  VALUES (v_conversation, 'worker', 'inbound', v_body, 'received')
  RETURNING m.id, m.created_at INTO v_message, v_sent;
  UPDATE public.job_conversations jc
     SET last_message_at = pg_catalog.now()
   WHERE jc.id = v_conversation;

  RETURN QUERY SELECT 'sent'::text, v_conversation, v_message, v_sent, NULL::integer;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.worker_post_application_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.worker_post_application_message(uuid, text) TO jale_whatsapp;

CREATE FUNCTION jale_cap.claim_hire_details_nudges(
  p_limit INTEGER
)
RETURNS TABLE (
  application_id UUID,
  job_id         UUID,
  employer_id    UUID,
  employer_email TEXT,
  worker_name    TEXT,
  job_title      TEXT,
  kind           TEXT,
  requested_at   TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'claim_hire_details_nudges: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Returns and locks the due rows; stamps nothing. The caller stamps each
  -- row with mark_hire_details_nudged once its email is queued, in the same
  -- transaction, so a row whose email never went stays due.
  RETURN QUERY
  WITH due AS MATERIALIZED (
    SELECT ja.id, ja.job_id, ja.worker_id,
           COALESCE(ja.hire_details_reminded_at, ja.hired_at) AS due_at,
           CASE WHEN ja.hire_details_reminded_at IS NOT NULL
                     AND (ja.hire_details_nudged_at IS NULL
                          OR ja.hire_details_reminded_at > ja.hire_details_nudged_at)
                THEN 'remind' ELSE 'auto' END AS nudge_kind,
           ja.hire_details_reminded_at AS reminded_at
      FROM public.job_applications ja
     WHERE ja.status = 'hired'
       AND ja.hire_start_date IS NULL
       AND ja.hire_report_location IS NULL
       AND ja.hire_contact_name IS NULL
       AND ja.hire_contact_phone IS NULL
       AND ja.hire_notes IS NULL
       AND ((ja.hire_details_nudged_at IS NULL
             AND ja.hired_at <= pg_catalog.now() - interval '24 hours'
             AND ja.hired_at > pg_catalog.now() - interval '7 days')
         OR (ja.hire_details_reminded_at IS NOT NULL
             AND (ja.hire_details_nudged_at IS NULL OR ja.hire_details_reminded_at > ja.hire_details_nudged_at)))
     ORDER BY COALESCE(ja.hire_details_reminded_at, ja.hired_at), ja.id
     LIMIT p_limit
       FOR UPDATE OF ja SKIP LOCKED
  )
  SELECT d.id, d.job_id, j.employer_id, e.email,
         COALESCE(NULLIF(pg_catalog.btrim(wp.full_name), ''), NULLIF(pg_catalog.btrim(w.full_name), '')),
         j.title, d.nudge_kind, d.reminded_at
    FROM due d
    JOIN public.jobs j ON j.id = d.job_id
    JOIN public.users e ON e.id = j.employer_id
    LEFT JOIN public.users w ON w.id = d.worker_id
    LEFT JOIN public.worker_profiles wp ON wp.user_id = d.worker_id
   ORDER BY d.due_at, d.id;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.claim_hire_details_nudges(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.claim_hire_details_nudges(integer) TO jale_job_digest;

-- The sweep's stamp for one claimed row, once its email is queued. It also
-- ends the reminder branch for that row (the stamp is newer than the
-- reminder).
CREATE FUNCTION jale_cap.mark_hire_details_nudged(
  p_application_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF p_application_id IS NULL THEN
    RAISE EXCEPTION 'mark_hire_details_nudged: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.job_applications ja
     SET hire_details_nudged_at = pg_catalog.now()
   WHERE ja.id = p_application_id
     AND ja.status = 'hired';
  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.mark_hire_details_nudged(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.mark_hire_details_nudged(uuid) TO jale_job_digest;

-- The worker's own web-sent messages on one application, for their page:
-- the latest 20, oldest first. Never an employer message or a WhatsApp reply
-- (those carry a provider message id).
CREATE FUNCTION jale_cap.worker_application_sent_messages(
  p_application_id UUID
)
RETURNS TABLE (message_id UUID, body TEXT, sent_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
BEGIN
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'worker_application_sent_messages: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_application_id IS NULL THEN
    RAISE EXCEPTION 'worker_application_sent_messages: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  SELECT r.id, r.body, r.created_at
    FROM (
      SELECT m.id, m.body, m.created_at
        FROM public.job_conversation_messages m
        JOIN public.job_conversations jc ON jc.id = m.conversation_id
        JOIN public.job_applications ja ON ja.id = jc.application_id
       WHERE jc.application_id = p_application_id
         AND ja.worker_id::text = v_caller
         AND jc.worker_id::text = v_caller
         AND m.sender_type = 'worker'
         AND m.direction = 'inbound'
         AND m.twilio_message_sid IS NULL
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 20
    ) r
   ORDER BY r.created_at, r.id;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.worker_application_sent_messages(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.worker_application_sent_messages(uuid) TO jale_whatsapp;

-- ── 6. Ownership transfer (082's window) ────────────────────
DO $$
DECLARE
  owner_role TEXT;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY[
    'jale_cap_hire_details', 'jale_cap_worker_messages', 'jale_cap_hire_nudges', 'jale_cap_worker_lane'
  ] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', owner_role, current_user);
  END LOOP;
END;
$$;

ALTER FUNCTION jale_cap.employer_save_hire_details(uuid, uuid, date, text, text, text, text) OWNER TO jale_cap_hire_details;
ALTER FUNCTION jale_cap.employer_hire_details_notice(uuid, text) OWNER TO jale_cap_worker_lane;
ALTER FUNCTION jale_cap.worker_post_application_message(uuid, text) OWNER TO jale_cap_worker_messages;
ALTER FUNCTION jale_cap.worker_application_sent_messages(uuid) OWNER TO jale_cap_worker_messages;
ALTER FUNCTION jale_cap.claim_hire_details_nudges(integer) OWNER TO jale_cap_hire_nudges;
ALTER FUNCTION jale_cap.mark_hire_details_nudged(uuid) OWNER TO jale_cap_hire_nudges;

DO $$
DECLARE
  owner_role TEXT;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY[
    'jale_cap_hire_details', 'jale_cap_worker_messages', 'jale_cap_hire_nudges', 'jale_cap_worker_lane'
  ] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', owner_role, current_user);
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', owner_role, current_user, current_user);
  END LOOP;
END;
$$;

-- ── 7. The enforcer's functions (036's window) ──────────────
GRANT jale_billing_job_enforcer TO jale_admin WITH SET TRUE, INHERIT FALSE;
SET LOCAL ROLE jale_billing_job_enforcer;

-- Same signature, result and order as 036; the UPDATE now marks the job.
CREATE OR REPLACE FUNCTION jale_billing_internal.billing_pause_over_limit_jobs(
  p_user_id UUID,
  p_active_job_limit INTEGER
)
RETURNS TABLE (
  paused_count INTEGER,
  employer_email TEXT,
  paused_titles TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_active_job_limit IS NULL OR p_active_job_limit < 0 THEN
    RAISE EXCEPTION 'billing_active_job_limit_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT u.email INTO employer_email
    FROM public.users u
   WHERE u.id = p_user_id AND u.user_type = 'employer'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_employer_not_found' USING ERRCODE = 'P0002';
  END IF;

  WITH ranked AS MATERIALIZED (
    SELECT j.id,
           row_number() OVER (ORDER BY j.created_at ASC, j.id ASC) AS active_rank
      FROM public.jobs j
     WHERE j.employer_id = p_user_id AND j.status = 'active'
  ), paused AS (
    UPDATE public.jobs j
       SET status = 'paused', updated_at = now(), billing_paused_at = now()
      FROM ranked r
     WHERE j.id = r.id
       AND r.active_rank > p_active_job_limit
       AND j.status = 'active'
    RETURNING j.title, j.created_at, j.id
  )
  SELECT count(*)::INTEGER,
         COALESCE(array_agg(p.title ORDER BY p.created_at ASC, p.id ASC), ARRAY[]::TEXT[])
    INTO paused_count, paused_titles
    FROM paused p;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION jale_billing_internal.billing_resume_paused_jobs(
  p_user_id UUID,
  p_active_job_limit INTEGER
)
RETURNS TABLE (
  resumed_count INTEGER,
  employer_email TEXT,
  resumed_titles TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_active INTEGER;
  v_ids    UUID[];
  v_titles TEXT[] := ARRAY[]::TEXT[];
  rec      RECORD;
BEGIN
  IF p_active_job_limit IS NULL OR p_active_job_limit < 0 THEN
    RAISE EXCEPTION 'billing_active_job_limit_invalid' USING ERRCODE = '22023';
  END IF;

  -- The same employer lock the pause takes, so the two never interleave.
  SELECT u.email INTO employer_email
    FROM public.users u
   WHERE u.id = p_user_id AND u.user_type = 'employer'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_employer_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*)::INTEGER INTO v_active
    FROM public.jobs j
   WHERE j.employer_id = p_user_id AND j.status = 'active';

  -- A job billing paused whose hires already fill it comes back filled, as
  -- 029's hired-count rule makes any job that is neither paused nor closed:
  -- it takes no active slot and is not announced or mailed.
  FOR rec IN
    SELECT j.id
      FROM public.jobs j
     WHERE j.employer_id = p_user_id
       AND j.status = 'paused'
       AND j.billing_paused_at IS NOT NULL
       AND j.workers_hired >= j.number_of_workers_needed
     ORDER BY j.created_at ASC, j.id ASC
       FOR UPDATE OF j
  LOOP
    UPDATE public.jobs j
       SET status = 'filled', billing_paused_at = NULL, updated_at = now()
     WHERE j.id = rec.id;
    INSERT INTO public.job_status_events (job_id, employer_id, from_status, to_status, actor)
    VALUES (rec.id, p_user_id, 'paused', 'filled', 'billing');
  END LOOP;

  -- Only jobs billing paused and still paused, with an opening left: an
  -- employer's own pause, a closed or a filled job is never picked. Oldest
  -- first, as the pause keeps the oldest active.
  IF p_active_job_limit > v_active THEN
    SELECT COALESCE(array_agg(picked.id ORDER BY picked.created_at ASC, picked.id ASC), ARRAY[]::UUID[])
      INTO v_ids
      FROM (
        SELECT j.id, j.created_at
          FROM public.jobs j
         WHERE j.employer_id = p_user_id
           AND j.status = 'paused'
           AND j.billing_paused_at IS NOT NULL
           AND j.workers_hired < j.number_of_workers_needed
         ORDER BY j.created_at ASC, j.id ASC
         LIMIT p_active_job_limit - v_active
           FOR UPDATE OF j
      ) picked;

    UPDATE public.jobs j
       SET status = 'active', billing_paused_at = NULL, updated_at = now()
     WHERE j.id = ANY (v_ids)
       AND j.status = 'paused'
       AND j.billing_paused_at IS NOT NULL;

    FOR rec IN
      SELECT j.id, j.title, j.public_code, j.public_listing_enabled
        FROM public.jobs j
       WHERE j.id = ANY (v_ids)
       ORDER BY j.created_at ASC, j.id ASC
    LOOP
      INSERT INTO public.job_status_events (job_id, employer_id, from_status, to_status, actor)
      VALUES (rec.id, p_user_id, 'paused', 'active', 'billing');
      IF rec.public_listing_enabled AND rec.public_code IS NOT NULL THEN
        PERFORM public.enqueue_job_visibility_event(rec.id, rec.public_code, 'published');
      END IF;
      v_titles := v_titles || rec.title;
    END LOOP;
  END IF;

  resumed_count := COALESCE(cardinality(v_titles), 0);
  resumed_titles := v_titles;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION jale_billing_internal.billing_resume_paused_jobs(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_billing_internal.billing_resume_paused_jobs(UUID, INTEGER) TO jale_billing;
RESET ROLE;

GRANT jale_billing_job_enforcer TO jale_admin WITH SET FALSE, INHERIT FALSE;
REVOKE jale_billing_job_enforcer FROM jale_admin GRANTED BY jale_admin;

-- ── 7b. The console's recent resumes (admin Home activity) ──
-- The console reads job_status_events only through this definer: ids and
-- times of the jobs billing resumed, newest first, no employer or worker
-- data. Owned by jale_admin like the other console analytics definers; it
-- opens app.admin_analytics_read for its one query and closes it again.
CREATE FUNCTION public.admin_recent_job_resumes(p_limit INTEGER DEFAULT 8)
RETURNS TABLE (event_id UUID, job_id UUID, changed_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 8), 1), 50);
BEGIN
  PERFORM pg_catalog.set_config('app.admin_analytics_read', 'on', true);
  RETURN QUERY
  SELECT e.id, e.job_id, e.changed_at
    FROM public.job_status_events e
   WHERE e.actor = 'billing' AND e.from_status = 'paused' AND e.to_status = 'active'
   ORDER BY e.changed_at DESC, e.id DESC
   LIMIT v_limit;
  PERFORM pg_catalog.set_config('app.admin_analytics_read', '', true);
END;
$fn$;
ALTER FUNCTION public.admin_recent_job_resumes(INTEGER) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.admin_recent_job_resumes(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_recent_job_resumes(INTEGER) TO jale_admin_console;

-- ── 8. Self-audit ───────────────────────────────────────────
DO $$
DECLARE
  spec RECORD;
  fn_oid OID;
  info RECORD;
  offender TEXT;
  v_grants TEXT[];
  owner_role TEXT;
  v_col TEXT;
BEGIN
  -- Functions: owner, definer, pinned path, language, and exactly their callers.
  -- Looked up by catalog row, not by name: jale_admin cannot resolve a name
  -- in jale_billing_internal (036).
  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_cap', 'employer_save_hire_details',
       'p_job_id uuid, p_worker_id uuid, p_start_date date, p_report_location text, p_contact_name text, p_contact_phone text, p_notes text',
       'jale_cap_hire_details', 'jale_api'),
      ('jale_cap', 'employer_hire_details_notice', 'p_application_id uuid, p_body text', 'jale_cap_worker_lane', 'jale_api'),
      ('jale_cap', 'worker_post_application_message', 'p_application_id uuid, p_body text', 'jale_cap_worker_messages', 'jale_whatsapp'),
      ('jale_cap', 'worker_application_sent_messages', 'p_application_id uuid', 'jale_cap_worker_messages', 'jale_whatsapp'),
      ('jale_cap', 'claim_hire_details_nudges', 'p_limit integer', 'jale_cap_hire_nudges', 'jale_job_digest'),
      ('jale_cap', 'mark_hire_details_nudged', 'p_application_id uuid', 'jale_cap_hire_nudges', 'jale_job_digest'),
      ('jale_billing_internal', 'billing_pause_over_limit_jobs', 'p_user_id uuid, p_active_job_limit integer',
       'jale_billing_job_enforcer', 'jale_billing'),
      ('jale_billing_internal', 'billing_resume_paused_jobs', 'p_user_id uuid, p_active_job_limit integer',
       'jale_billing_job_enforcer', 'jale_billing'),
      ('public', 'admin_recent_job_resumes', 'p_limit integer', 'jale_admin', 'jale_admin_console')
    ) AS t(schema_name, fn_name, fn_args, owner_role, caller)
  LOOP
    SELECT p.oid INTO fn_oid
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = spec.schema_name AND p.proname = spec.fn_name
       AND pg_catalog.pg_get_function_identity_arguments(p.oid) = spec.fn_args;
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef AS definer,
           p.proconfig AS config, l.lanname AS language
      INTO info
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE p.oid = fn_oid;
    IF fn_oid IS NULL OR info.owner_name IS DISTINCT FROM spec.owner_role OR NOT info.definer
       OR info.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
       OR info.language <> 'plpgsql' THEN
      RAISE EXCEPTION 'migration 125: %.% has the wrong owner, security, search_path or language', spec.schema_name, spec.fn_name;
    END IF;
    SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END, ', ')
      INTO offender
      FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
       AND (a.grantee = 0 OR pg_catalog.pg_get_userbyid(a.grantee) <> spec.caller);
    IF offender IS NOT NULL THEN
      RAISE EXCEPTION 'migration 125: %.% is executable by a role other than its owner and caller (%)', spec.schema_name, spec.fn_name, offender;
    END IF;
    IF NOT has_function_privilege(spec.caller, fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 125: % cannot execute %.%', spec.caller, spec.schema_name, spec.fn_name;
    END IF;
  END LOOP;

  -- Owners: no login, no elevated attribute, NOINHERIT, member of nothing,
  -- and no SET or INHERIT membership left in them.
  FOREACH owner_role IN ARRAY ARRAY[
    'jale_cap_hire_details', 'jale_cap_worker_messages', 'jale_cap_hire_nudges', 'jale_cap_worker_lane',
    'jale_billing_job_enforcer'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles r
       WHERE r.rolname = owner_role
         AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit
              OR r.rolreplication OR r.rolbypassrls)
    ) OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = owner_role) THEN
      RAISE EXCEPTION 'migration 125: owner % is missing or has unsafe attributes', owner_role;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = owner_role)
          OR (am.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = owner_role)
              AND (am.inherit_option OR am.set_option))
    ) THEN
      RAISE EXCEPTION 'migration 125: owner % kept a membership or a SET/INHERIT window', owner_role;
    END IF;
  END LOOP;

  -- The enforcer's exact column rights on users and jobs (036's invariant, the mark added).
  SELECT array_agg(c.relname || ':' || a.attname || ':' || p.privilege
                   ORDER BY c.relname || ':' || a.attname || ':' || p.privilege)
    INTO v_grants
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
   WHERE c.oid IN ('public.jobs'::regclass, 'public.users'::regclass)
     AND has_column_privilege('jale_billing_job_enforcer', c.oid, a.attname, p.privilege);
  IF v_grants IS DISTINCT FROM ARRAY[
    'jobs:billing_paused_at:SELECT', 'jobs:billing_paused_at:UPDATE', 'jobs:created_at:SELECT',
    'jobs:employer_id:SELECT', 'jobs:id:SELECT', 'jobs:number_of_workers_needed:SELECT', 'jobs:public_code:SELECT',
    'jobs:public_listing_enabled:SELECT', 'jobs:status:SELECT', 'jobs:status:UPDATE', 'jobs:title:SELECT',
    'jobs:updated_at:UPDATE', 'jobs:workers_hired:SELECT',
    'users:email:SELECT', 'users:id:SELECT', 'users:id:UPDATE', 'users:user_type:SELECT'
  ]::TEXT[] OR has_table_privilege('jale_billing_job_enforcer', 'public.jobs', 'INSERT,DELETE')
     OR has_table_privilege('jale_billing_job_enforcer', 'public.users', 'INSERT,DELETE') THEN
    RAISE EXCEPTION 'migration 125: jale_billing_job_enforcer exact column grant invariant failed (%)', v_grants;
  END IF;

  -- The request logins read the new columns and write none of them; the
  -- worker's door writes the reminder stamp and still not the hire date.
  FOREACH v_col IN ARRAY ARRAY['hire_start_date', 'hire_report_location', 'hire_contact_name', 'hire_contact_phone',
                               'hire_notes', 'hire_details_updated_at', 'hire_details_nudged_at',
                               'hire_details_reminded_at'] LOOP
    IF NOT has_column_privilege('jale_api', 'public.job_applications', v_col, 'SELECT')
       OR NOT has_column_privilege('jale_whatsapp', 'public.job_applications', v_col, 'SELECT')
       OR has_column_privilege('jale_api', 'public.job_applications', v_col, 'UPDATE')
       OR (has_column_privilege('jale_whatsapp', 'public.job_applications', v_col, 'UPDATE')
           <> (v_col = 'hire_details_reminded_at')) THEN
      RAISE EXCEPTION 'migration 125: request-login rights on job_applications.% are not as reviewed', v_col;
    END IF;
  END LOOP;
  IF has_column_privilege('jale_whatsapp', 'public.job_applications', 'hired_at', 'UPDATE') THEN
    RAISE EXCEPTION 'migration 125: jale_whatsapp can UPDATE job_applications.hired_at';
  END IF;

  -- The web message never writes the read stamp or the WhatsApp reply window.
  IF has_column_privilege('jale_cap_worker_messages', 'public.job_conversations', 'employer_last_read_at', 'UPDATE')
     OR has_column_privilege('jale_cap_worker_messages', 'public.job_conversations', 'last_worker_message_at', 'UPDATE') THEN
    RAISE EXCEPTION 'migration 125: the worker-message owner can write a stamp it must not';
  END IF;

  -- The updated_at trigger is back on after the backfill (section 1b).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = 'public.job_applications'::regclass
       AND t.tgname = 'job_applications_updated_at'
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'migration 125: job_applications_updated_at is not enabled';
  END IF;

  -- Row security is still on, and forced, where it was.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
     WHERE c.oid IN ('public.job_applications'::regclass, 'public.jobs'::regclass, 'public.job_status_events'::regclass)
       AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'migration 125: job_applications, jobs or job_status_events lost RLS ENABLE + FORCE';
  END IF;
END;
$$;

COMMIT;
