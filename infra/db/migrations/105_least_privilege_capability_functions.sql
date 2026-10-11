-- ============================================================
-- 105_least_privilege_capability_functions.sql
-- Run manually AFTER 104_least_privilege_logins.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Sprint 27, least-privilege database access, part 2 of 3: the capability
-- functions. Each one replaces a request or job path's direct access to
-- tables its login has no rights on:
--   upload tokens     jale_cap.upload_token_issue / _resolve / _slot /
--                     _confirm / _submit (the tokenized document upload; the
--                     token tables stay closed to every runtime login)
--   worker lane       jale_cap.employer_worker_delivery_context /
--                     employer_stage_recipient / employer_claim_worker_intent
--                     (employer messaging and stage notifications)
--   share links       jale_cap.resolve_share_link (one active link for a
--                     presented code; links cannot be listed)
--   delivery feedback jale_cap.apply_ses_feedback
--   retention         jale_cap.retention_purge
--
-- Every function follows the 061/062/082 pattern: SECURITY DEFINER with
-- `search_path = pg_catalog, pg_temp`, every object schema-qualified, EXECUTE
-- revoked from PUBLIC and granted to its caller login only, owned by a
-- NOLOGIN owner role (104) that holds exactly the rights its functions need.
-- Each function re-checks its caller in SQL: the employer functions read the
-- caller from app.current_internal_user_id (unset or empty raises 42501) and
-- refuse anything outside the caller's own jobs and applicants.
-- infra/db/access/SIGNATURES.md documents each signature and its outcomes.
--
-- OWNERS' RIGHTS. Each owner gets column-limited grants and its own policies
-- (TO the owner role only) on the tables its functions touch. Where a row
-- belongs to a caller, the owner's policy is keyed on the caller too, so the
-- definer itself can reach only the caller's jobs, conversations and
-- applicants (defence in depth behind each function's explicit checks):
--   jale_cap_upload_tokens  the two upload-token tables; the caller's own jobs;
--                           job-scoped documents of a worker and job that hold
--                           a live upload token
--   jale_cap_worker_lane    the caller's jobs, applications, conversations and
--                           messages; and, for the caller's applicants only,
--                           their numbers, onboarding state (read and row
--                           lock, never written), workflow runs, WhatsApp
--                           conversation language, message intents, and the
--                           authorised outbox insert for an eligible intent;
--                           the deferred-delivery runtime control
--   jale_cap_share_links    unrevoked share links
--   jale_cap_ses_feedback   the outbox rows that carry a provider message id;
--                           EXECUTE on disable_digest_for_employer (090)
--   jale_cap_retention      DELETE and SELECT on the three referral tables,
--                           limited by policy to rows past their retention age
--                           (the same ages the retention job always used)
--   jale_cap_job_messaging  the columns its two triggers compare or copy
--
-- JOB-MESSAGING TRIGGERS. A conversation must name its application's worker
-- and job and that job's employer (checked on every write that sets those
-- columns; existing rows are not re-validated). An outbox row the request
-- login writes is sent to the conversation's worker: its number is derived
-- in the database whatever the statement supplied.
--
-- RE-OWNED DEFINERS.
--   list_stale_job_outbox_workers(interval) keeps its public name, signature
--   and caller (jale_whatsapp) as an invoker wrapper over
--   jale_cap.list_stale_job_outbox_workers, owned by jale_cap_stale_outbox,
--   which reads only stale outbox rows and their conversations. Its output is
--   bounded (500 workers per call, oldest stale message first).
--   sync_job_hired_counts() moves to jale_cap, owned by jale_cap_hired_counts
--   (SELECT job_id, status on job_applications; UPDATE workers_hired, status
--   on jobs). Its trigger is bound by OID and keeps firing it unchanged.
--
-- The certification-limit trigger function (075/078) resolves its table
-- through the caller's search_path. It is pinned here to
-- `pg_catalog, public, pg_temp`, so it fires correctly from a writer whose
-- path is catalog-only, such as the upload confirm function.
--
-- It also makes job-scoped documents and upload tokens follow their job on
-- delete (ON DELETE CASCADE), so the request login can delete a job without
-- rights on those tables.
--
-- OWNERSHIP TRANSFER. ALTER FUNCTION ... OWNER TO requires that jale_admin
-- can SET ROLE to the new owner. 082's sequence, transcribed: grant SET to
-- the migration login, transfer, then turn SET off and revoke the
-- self-granted row, leaving only the creator's ADMIN-only membership. The
-- self-audit proves no role keeps SET or INHERIT on any owner. EXECUTE and
-- USAGE on jale_internal (owned by its helper role) are granted inside an
-- INHERIT-only window that the file closes again.
--
-- DEPLOY ORDER: apply after 104 and BEFORE the release deploy. The deployed
-- code never calls jale_cap; the two re-owned definers keep their behaviour
-- for it, and the cascades change nothing because it deletes those rows
-- itself before the job.
--
-- REPLAY. Refused with a clear message once jale_cap holds functions: the
-- functions belong to their owners by then, and the coverage guard (on test
-- beds) and the posture check (once deployed) re-verify their owners, rights
-- and policy expressions against infra/db/access/manifest.json. Nothing is partially applied, because the file is one
-- transaction.
-- ============================================================
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF pg_catalog.to_regnamespace('jale_cap') IS NULL
     OR (SELECT count(*) FROM pg_catalog.pg_roles
          WHERE rolname IN ('jale_cap_upload_tokens', 'jale_cap_worker_lane', 'jale_cap_share_links',
                            'jale_cap_ses_feedback', 'jale_cap_retention', 'jale_cap_stale_outbox',
                            'jale_cap_hired_counts', 'jale_cap_job_messaging',
                            'jale_api', 'jale_api_public', 'jale_job_ses_feedback', 'jale_job_retention')) <> 12 THEN
    RAISE EXCEPTION 'migration 105: apply 104 first (jale_cap, its owner roles and the logins are missing)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = pg_catalog.to_regnamespace('jale_cap')
  ) THEN
    RAISE EXCEPTION 'migration 105: already applied (jale_cap already holds functions); it is not re-runnable, and the coverage guard verifies its result';
  END IF;
  IF pg_catalog.to_regprocedure('public.sync_job_hired_counts()') IS NULL
     OR pg_catalog.to_regprocedure('public.list_stale_job_outbox_workers(interval)') IS NULL
     OR pg_catalog.to_regprocedure('public.enforce_certification_document_limit()') IS NULL THEN
    RAISE EXCEPTION 'migration 105: the functions it re-owns or pins are missing; apply the chain up to 104 first';
  END IF;
END;
$$;

-- ── Upload tokens: caller jale_api (issue), jale_api_public (the rest) ──
-- The token hash is the lower-case hex SHA-256 of the raw token; the raw
-- token never reaches the database.
CREATE FUNCTION jale_cap.upload_token_issue(
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

  -- Only the employer who owns the job, only for a worker who applied to it.
  IF NOT EXISTS (
       SELECT 1 FROM public.jobs j
        WHERE j.id = p_job_id AND j.employer_id::text = v_caller
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
REVOKE ALL ON FUNCTION jale_cap.upload_token_issue(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.upload_token_issue(text, uuid, uuid) TO jale_api;

CREATE FUNCTION jale_cap.upload_token_resolve(
  p_token_hash TEXT,
  p_doc_type   TEXT,
  p_mime_type  TEXT
)
RETURNS TABLE (outcome TEXT, s3_key TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_ext    TEXT;
  v_worker UUID;
  v_job    UUID;
  v_key    TEXT;
  v_issued TEXT;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'upload_token_resolve: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_doc_type IS NULL OR p_doc_type NOT IN ('resume', 'driver_license', 'work_auth_doc', 'certification_doc') THEN
    RETURN QUERY SELECT 'invalid_doc_type'::text, NULL::text;
    RETURN;
  END IF;
  v_ext := CASE p_mime_type
             WHEN 'application/pdf' THEN 'pdf'
             WHEN 'image/jpeg' THEN 'jpg'
             WHEN 'image/png' THEN 'png'
           END;
  IF v_ext IS NULL THEN
    RETURN QUERY SELECT 'invalid_mime_type'::text, NULL::text;
    RETURN;
  END IF;

  SELECT t.worker_id, t.job_id INTO v_worker, v_job
    FROM public.document_upload_tokens t
   WHERE t.token_hash = p_token_hash
     AND NOT t.used
     AND t.expires_at > now();
  IF NOT FOUND OR NOT jale_internal.worker_has_application(v_worker::text, v_job) THEN
    RETURN QUERY SELECT 'invalid_token'::text, NULL::text;
    RETURN;
  END IF;

  -- The key is built here from the token's own job and worker, so a caller
  -- can never choose another worker's prefix. A confirmed slot is never
  -- re-issued; an unconfirmed one gets a fresh key.
  v_key := 'documents/' || v_job::text || '/' || v_worker::text || '/' || p_doc_type || '/'
           || gen_random_uuid()::text || '.' || v_ext;
  INSERT INTO public.document_upload_token_slots AS s (
    token_hash, doc_type, issued_s3_key, expected_mime_type, max_file_size, requested_at
  )
  VALUES (p_token_hash, p_doc_type, v_key, p_mime_type, 10485760, now())
  ON CONFLICT (token_hash, doc_type) DO UPDATE
     SET issued_s3_key = EXCLUDED.issued_s3_key,
         expected_mime_type = EXCLUDED.expected_mime_type,
         max_file_size = EXCLUDED.max_file_size,
         requested_at = now(),
         s3_version_id = NULL
   WHERE s.confirmed_at IS NULL
  RETURNING s.issued_s3_key INTO v_issued;

  IF v_issued IS NULL THEN
    RETURN QUERY SELECT 'document_already_confirmed'::text, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::text, v_issued;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.upload_token_resolve(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.upload_token_resolve(text, text, text) TO jale_api_public;

CREATE FUNCTION jale_cap.upload_token_slot(
  p_token_hash TEXT,
  p_doc_type   TEXT,
  p_s3_key     TEXT,
  p_mime_type  TEXT
)
RETURNS TABLE (outcome TEXT, max_file_size INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_worker UUID;
  v_job    UUID;
  v_max    INTEGER;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'upload_token_slot: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT t.worker_id, t.job_id, s.max_file_size INTO v_worker, v_job, v_max
    FROM public.document_upload_tokens t
    JOIN public.document_upload_token_slots s ON s.token_hash = t.token_hash
   WHERE t.token_hash = p_token_hash
     AND s.doc_type = p_doc_type
     AND s.issued_s3_key = p_s3_key
     AND s.expected_mime_type = p_mime_type
     AND s.confirmed_at IS NULL
     AND NOT t.used
     AND t.expires_at > now();
  IF NOT FOUND OR NOT jale_internal.worker_has_application(v_worker::text, v_job) THEN
    RETURN QUERY SELECT 'invalid_or_confirmed_upload'::text, NULL::integer;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::text, v_max;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.upload_token_slot(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.upload_token_slot(text, text, text, text) TO jale_api_public;

CREATE FUNCTION jale_cap.upload_token_confirm(
  p_token_hash    TEXT,
  p_doc_type      TEXT,
  p_s3_key        TEXT,
  p_mime_type     TEXT,
  p_file_name     TEXT,
  p_file_size     INTEGER,
  p_s3_version_id TEXT,
  p_cert_name     TEXT
)
RETURNS TABLE (outcome TEXT, document_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  -- JavaScript's String.prototype.trim() whitespace (control characters are
  -- removed before trimming, so only the spaces remain to list).
  c_trim CONSTANT TEXT := '^[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$';
  v_cert       TEXT;
  v_name       TEXT;
  v_worker     UUID;
  v_job        UUID;
  v_max        INTEGER;
  v_count      INTEGER;
  v_doc        UUID;
  v_constraint TEXT;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_doc_type IS NULL OR p_s3_key IS NULL OR p_mime_type IS NULL OR p_file_name IS NULL THEN
    RAISE EXCEPTION 'upload_token_confirm: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A certification name labels a certification document only: blank means
  -- none, and it is stored trimmed, at most 200 characters (078).
  v_cert := NULLIF(regexp_replace(regexp_replace(p_cert_name, '[\x01-\x1f\x7f]', '', 'g'), c_trim, '', 'g'), '');
  IF v_cert IS NOT NULL AND (p_doc_type <> 'certification_doc' OR char_length(v_cert) > 200) THEN
    RAISE EXCEPTION 'upload_token_confirm: a certification name is only valid on a certification document, at most 200 characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The stored file name: control characters removed, path separators
  -- replaced, trimmed, at most 255 characters; nothing left falls back to
  -- <type>.<subtype>.
  v_name := left(regexp_replace(regexp_replace(regexp_replace(p_file_name, '[\x01-\x1f\x7f]', '', 'g'),
                                               '[\\/]', '_', 'g'),
                                c_trim, '', 'g'), 255);
  IF v_name = '' THEN
    v_name := p_doc_type || '.' || CASE WHEN strpos(p_mime_type, '/') > 0 THEN split_part(p_mime_type, '/', 2) ELSE 'file' END;
  END IF;

  -- The exact unconfirmed slot: token, type, issued key and MIME type. The
  -- slot row stays locked until the caller commits, so a concurrent or
  -- replayed confirm of the same slot waits and then finds it confirmed.
  SELECT t.worker_id, t.job_id, s.max_file_size INTO v_worker, v_job, v_max
    FROM public.document_upload_tokens t
    JOIN public.document_upload_token_slots s ON s.token_hash = t.token_hash
   WHERE t.token_hash = p_token_hash
     AND s.doc_type = p_doc_type
     AND s.issued_s3_key = p_s3_key
     AND s.expected_mime_type = p_mime_type
     AND s.confirmed_at IS NULL
     AND NOT t.used
     AND t.expires_at > now()
     FOR UPDATE OF s;
  IF NOT FOUND OR NOT jale_internal.worker_has_application(v_worker::text, v_job) THEN
    RETURN QUERY SELECT 'invalid_or_confirmed_upload'::text, NULL::uuid;
    RETURN;
  END IF;

  IF p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > v_max THEN
    RETURN QUERY SELECT 'invalid_file_size'::text, NULL::uuid;
    RETURN;
  END IF;

  -- The certification caps are checked before the slot is confirmed, so a
  -- refusal never burns the slot: 20 per job (075/078), 5 per name (078),
  -- unlabeled documents sharing one bucket.
  IF p_doc_type = 'certification_doc' THEN
    SELECT count(*)::integer INTO v_count
      FROM public.worker_documents d
     WHERE d.worker_id = v_worker AND d.job_id = v_job AND d.doc_type = 'certification_doc';
    IF v_count >= 20 THEN
      RETURN QUERY SELECT 'certification_document_limit'::text, NULL::uuid;
      RETURN;
    END IF;
    SELECT count(*)::integer INTO v_count
      FROM public.worker_documents d
     WHERE d.worker_id = v_worker AND d.job_id = v_job AND d.doc_type = 'certification_doc'
       AND d.cert_name IS NOT DISTINCT FROM v_cert;
    IF v_count >= 5 THEN
      RETURN QUERY SELECT 'certification_document_name_limit'::text, NULL::uuid;
      RETURN;
    END IF;
  END IF;

  v_doc := gen_random_uuid();
  BEGIN
    UPDATE public.document_upload_token_slots s
       SET confirmed_at = now(),
           s3_version_id = p_s3_version_id
     WHERE s.token_hash = p_token_hash
       AND s.doc_type = p_doc_type
       AND s.confirmed_at IS NULL;

    -- One document per worker, job and type, except certifications: the
    -- job's earlier document of the type is replaced. The worker's own
    -- vault copy (no job) is never touched.
    IF p_doc_type <> 'certification_doc' THEN
      DELETE FROM public.worker_documents d
       WHERE d.worker_id = v_worker AND d.job_id = v_job AND d.doc_type = p_doc_type;
    END IF;

    INSERT INTO public.worker_documents (
      id, worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id, cert_name
    )
    VALUES (v_doc, v_worker, v_job, p_doc_type, p_s3_key, v_name, p_file_size, p_mime_type, p_s3_version_id, v_cert);
  EXCEPTION
    -- Any refusal here rolls the block back, so the slot stays unconfirmed.
    WHEN unique_violation THEN
      -- A concurrent upload of the same type won; for certifications the
      -- same violation is the per-job cap (as it always has been mapped).
      RETURN QUERY SELECT CASE WHEN p_doc_type = 'certification_doc'
                               THEN 'certification_document_limit' ELSE 'document_conflict' END::text,
                          NULL::uuid;
      RETURN;
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IN ('certification_document_limit', 'certification_document_name_limit') THEN
        RETURN QUERY SELECT v_constraint, NULL::uuid;
        RETURN;
      END IF;
      RAISE;
  END;

  RETURN QUERY SELECT 'ok'::text, v_doc;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.upload_token_confirm(text, text, text, text, text, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.upload_token_confirm(text, text, text, text, text, integer, text, text) TO jale_api_public;

CREATE FUNCTION jale_cap.upload_token_submit(
  p_token_hash TEXT
)
RETURNS TABLE (outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'upload_token_submit: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- At least one confirmed slot; a repeat keeps the first submission time.
  UPDATE public.document_upload_tokens t
     SET used = true,
         used_at = COALESCE(t.used_at, now())
   WHERE t.token_hash = p_token_hash
     AND t.expires_at > now()
     AND EXISTS (
       SELECT 1 FROM public.document_upload_token_slots s
        WHERE s.token_hash = t.token_hash AND s.confirmed_at IS NOT NULL
     );
  IF FOUND THEN
    RETURN QUERY SELECT 'ok'::text;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.document_upload_tokens t
     WHERE t.token_hash = p_token_hash AND t.expires_at > now()
  ) THEN
    RETURN QUERY SELECT 'invalid_token'::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'confirm_required'::text;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.upload_token_submit(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.upload_token_submit(text) TO jale_api_public;

-- ── Worker lane: caller jale_api ────────────────────────────
CREATE FUNCTION jale_cap.employer_worker_delivery_context(
  p_worker_id UUID
)
RETURNS TABLE (lifecycle TEXT, workflow_language TEXT, whatsapp_language TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller    TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_lifecycle TEXT;
  v_workflow  TEXT;
  v_whatsapp  TEXT;
BEGIN
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'employer_worker_delivery_context: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_worker_id IS NULL THEN
    RAISE EXCEPTION 'employer_worker_delivery_context: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT jale_internal.employer_has_applicant_relationship(v_caller, p_worker_id) THEN
    RAISE EXCEPTION 'employer_worker_delivery_context: the worker is not one of the caller''s applicants'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The gate read: the stored lifecycle and the workflow language (the
  -- active run first, else the newest), with the worker's onboarding row
  -- locked for the rest of the caller's transaction.
  SELECT s.lifecycle, COALESCE(r.preferred_language, 'es') INTO v_lifecycle, v_workflow
    FROM public.worker_onboarding_state s
    LEFT JOIN LATERAL (
      SELECT c.preferred_language
        FROM public.worker_workflow_runs c
       WHERE c.user_id = s.user_id
       ORDER BY (c.status = 'active') DESC, c.created_at DESC, c.id DESC
       LIMIT 1
    ) r ON true
   WHERE s.user_id = p_worker_id
     FOR UPDATE OF s;
  IF NOT FOUND THEN
    v_lifecycle := NULL;
    v_workflow := 'es';
  END IF;

  SELECT wc.language INTO v_whatsapp
    FROM public.whatsapp_conversations wc
   WHERE wc.user_id = p_worker_id
   ORDER BY wc.updated_at DESC, wc.id DESC
   LIMIT 1;

  RETURN QUERY SELECT v_lifecycle, v_workflow, v_whatsapp;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.employer_worker_delivery_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.employer_worker_delivery_context(uuid) TO jale_api;

CREATE FUNCTION jale_cap.employer_stage_recipient(
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
     AND j.employer_id::text = v_caller;
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
REVOKE ALL ON FUNCTION jale_cap.employer_stage_recipient(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.employer_stage_recipient(uuid) TO jale_api;

CREATE FUNCTION jale_cap.employer_claim_worker_intent(
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
       AND jc.employer_id::text = v_caller;
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
       AND j.employer_id::text = v_caller;
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
REVOKE ALL ON FUNCTION jale_cap.employer_claim_worker_intent(uuid, text, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.employer_claim_worker_intent(uuid, text, uuid, jsonb, jsonb) TO jale_api;

-- ── Share links: caller jale_api ────────────────────────────
CREATE FUNCTION jale_cap.resolve_share_link(
  p_code TEXT
)
RETURNS TABLE (job_id UUID, channel TEXT, referrer_worker_id UUID, referrer_employer_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  -- One exact, canonical code (the table's own format); a malformed,
  -- unknown or revoked code gives no row. Nothing can be listed.
  IF p_code IS NULL OR p_code !~ '^[0-9A-HJKMNP-TV-Z]{8}$' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT l.job_id, l.channel, l.referrer_worker_id, l.referrer_employer_id
    FROM public.job_share_links l
   WHERE l.code = p_code
     AND l.revoked_at IS NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.resolve_share_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.resolve_share_link(text) TO jale_api;

-- ── Delivery feedback: caller jale_job_ses_feedback ─────────
CREATE FUNCTION jale_cap.apply_ses_feedback(
  p_ses_message_id TEXT
)
RETURNS TABLE (outcome TEXT, source_type TEXT, changed INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_type    TEXT;
  v_source  UUID;
  v_changed INTEGER;
BEGIN
  IF p_ses_message_id IS NULL OR p_ses_message_id = '' THEN
    RAISE EXCEPTION 'apply_ses_feedback: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT o.source_type, o.source_id INTO v_type, v_source
    FROM public.email_outbox o
   WHERE o.ses_message_id = p_ses_message_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unknown_message'::text, NULL::text, 0;
    RETURN;
  END IF;
  IF v_type <> 'employer_digest' THEN
    RETURN QUERY SELECT 'not_digest'::text, v_type, 0;
    RETURN;
  END IF;

  -- A digest's source is the employer it was sent for (090).
  v_changed := public.disable_digest_for_employer(v_source);
  RETURN QUERY SELECT 'digest'::text, v_type, v_changed;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.apply_ses_feedback(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.apply_ses_feedback(text) TO jale_job_ses_feedback;

-- ── Retention: caller jale_job_retention ────────────────────
CREATE FUNCTION jale_cap.retention_purge(
  p_batch INTEGER
)
RETURNS TABLE (tokens_deleted INTEGER, claims_deleted INTEGER, opens_deleted INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_tokens INTEGER;
  v_claims INTEGER;
  v_opens  INTEGER;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 5000 THEN
    RAISE EXCEPTION 'retention_purge: the batch must be between 1 and 5000' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Up to p_batch rows from each table, with the retention ages the job has
  -- always used: apply tokens 7 days past expiry; pending claims 30 days
  -- past their claim, or past expiry when unclaimed; opens after 400 days.
  -- The owner's policies carry the same ages.
  DELETE FROM public.referral_apply_tokens t
   WHERE t.token_hash IN (
     SELECT x.token_hash FROM public.referral_apply_tokens x
      WHERE x.expires_at < now() - interval '7 days'
      LIMIT p_batch);
  GET DIAGNOSTICS v_tokens = ROW_COUNT;

  DELETE FROM public.referral_pending_claims c
   WHERE c.phone_hash IN (
     SELECT x.phone_hash FROM public.referral_pending_claims x
      WHERE (x.claimed_at IS NOT NULL AND x.claimed_at < now() - interval '30 days')
         OR (x.claimed_at IS NULL AND x.expires_at < now() - interval '30 days')
      LIMIT p_batch);
  GET DIAGNOSTICS v_claims = ROW_COUNT;

  DELETE FROM public.job_share_opens o
   WHERE o.id IN (
     SELECT x.id FROM public.job_share_opens x
      WHERE x.opened_at < now() - interval '400 days'
      LIMIT p_batch);
  GET DIAGNOSTICS v_opens = ROW_COUNT;

  RETURN QUERY SELECT v_tokens, v_claims, v_opens;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.retention_purge(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.retention_purge(integer) TO jale_job_retention;

-- ── Re-owned: stale employer-message discovery (caller jale_whatsapp) ──
CREATE FUNCTION jale_cap.list_stale_job_outbox_workers(
  p_min_age INTERVAL
)
RETURNS TABLE (worker_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  -- A row younger than five minutes may still be in its sender's hands.
  IF p_min_age IS NULL OR p_min_age < interval '5 minutes' THEN
    RAISE EXCEPTION 'list_stale_job_outbox_workers: the minimum age must be at least 5 minutes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The workers with a sendable outbox row older than p_min_age; at most 500
  -- per call, the oldest stale message first, so one sweep stays bounded.
  RETURN QUERY
  SELECT jc.worker_id
    FROM public.job_message_outbox o
    JOIN public.job_conversations jc ON jc.id = o.conversation_id
   WHERE o.status IN ('pending', 'failed')
     AND o.attempt_count < 5
     AND o.created_at < now() - p_min_age
   GROUP BY jc.worker_id
   ORDER BY min(o.created_at), jc.worker_id
   LIMIT 500;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.list_stale_job_outbox_workers(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.list_stale_job_outbox_workers(interval) TO jale_whatsapp;

-- The public name keeps its signature, default and caller, and now runs with
-- its caller's rights over the capability function.
CREATE OR REPLACE FUNCTION public.list_stale_job_outbox_workers(
  p_min_age INTERVAL DEFAULT INTERVAL '5 minutes'
)
RETURNS TABLE (worker_id UUID)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $fn$
  SELECT s.worker_id FROM jale_cap.list_stale_job_outbox_workers(p_min_age) AS s;
$fn$;
REVOKE ALL ON FUNCTION public.list_stale_job_outbox_workers(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_stale_job_outbox_workers(interval) TO jale_whatsapp;

-- ── Re-owned: the hired-count trigger function ──────────────
-- Moved to jale_cap (its trigger is bound by OID), then given a catalog-only
-- search_path and schema-qualified names. The recount is unchanged: every
-- firing sets workers_hired and moves status between filled and active.
ALTER FUNCTION public.sync_job_hired_counts() SET SCHEMA jale_cap;
CREATE OR REPLACE FUNCTION jale_cap.sync_job_hired_counts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  target_job_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_job_id := OLD.job_id;
  ELSE
    target_job_id := NEW.job_id;
  END IF;

  UPDATE public.jobs j
     SET workers_hired = (
           SELECT count(*)::int
             FROM public.job_applications ja
            WHERE ja.job_id = target_job_id
              AND ja.status = 'hired'
         ),
         status = CASE
           WHEN j.status IN ('closed', 'paused') THEN j.status
           WHEN (
             SELECT count(*)::int
               FROM public.job_applications ja
              WHERE ja.job_id = target_job_id
                AND ja.status = 'hired'
           ) >= j.number_of_workers_needed THEN 'filled'
           WHEN j.status = 'filled' THEN 'active'
           ELSE j.status
         END
   WHERE j.id = target_job_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.sync_job_hired_counts() FROM PUBLIC;

-- ── The certification-limit trigger resolves its table on public ──
ALTER FUNCTION public.enforce_certification_document_limit() SET search_path = pg_catalog, public, pg_temp;

-- ── Job messaging: a conversation is bound to its application ──
-- Every new conversation, and every change to the columns that say whom it is
-- between, must name the worker and job of its application and that job's
-- employer. Existing rows are not re-validated: the trigger checks the row a
-- write produces.
CREATE FUNCTION jale_cap.job_conversation_application_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.job_applications ja
      JOIN public.jobs j ON j.id = ja.job_id
     WHERE ja.id = NEW.application_id
       AND ja.worker_id = NEW.worker_id
       AND ja.job_id = NEW.job_id
       AND j.employer_id = NEW.employer_id
  ) THEN
    RAISE EXCEPTION 'job_conversations: a conversation must name its application''s worker and job, and that job''s employer'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.job_conversation_application_guard() FROM PUBLIC;
CREATE TRIGGER job_conversations_application_guard
  BEFORE INSERT OR UPDATE OF job_id, employer_id, worker_id, application_id ON public.job_conversations
  FOR EACH ROW EXECUTE FUNCTION jale_cap.job_conversation_application_guard();

-- ── Job messaging: the request login never chooses a recipient ──
-- An outbox row the request login writes is sent to the conversation's
-- worker: the number is derived here with the rule the employer messaging
-- path applies (whatsapp_number, else phone, else the profile phone; trimmed,
-- a whatsapp: prefix removed), whatever the statement supplied. The WhatsApp
-- engine's rows keep the number of the message they answer, and the
-- migration login's rows are left as written.
CREATE FUNCTION jale_cap.job_message_outbox_recipient()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  c_trim CONSTANT TEXT := '^[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\t\n\v\f\r]+|[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\t\n\v\f\r]+$';
  -- The login the statement runs as, also under SET ROLE.
  v_writer TEXT := COALESCE(NULLIF(pg_catalog.current_setting('role'), 'none'), session_user::text);
  v_number TEXT;
BEGIN
  IF v_writer <> 'jale_api' THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(NULLIF(u.whatsapp_number, ''), NULLIF(u.phone, ''), NULLIF(wp.phone, '')) INTO v_number
    FROM public.job_conversations jc
    JOIN public.users u ON u.id = jc.worker_id
    LEFT JOIN public.worker_profiles wp ON wp.user_id = jc.worker_id
   WHERE jc.id = NEW.conversation_id;
  v_number := NULLIF(regexp_replace(regexp_replace(v_number, c_trim, '', 'g'), '^whatsapp:', '', 'i'), '');
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'job_message_outbox: the conversation''s worker has no WhatsApp number'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.whatsapp_number := v_number;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.job_message_outbox_recipient() FROM PUBLIC;
CREATE TRIGGER job_message_outbox_recipient
  BEFORE INSERT OR UPDATE OF conversation_id, whatsapp_number ON public.job_message_outbox
  FOR EACH ROW EXECUTE FUNCTION jale_cap.job_message_outbox_recipient();

-- ── The callers reach jale_cap; nothing else does ───────────
GRANT USAGE ON SCHEMA jale_cap TO jale_api;
GRANT USAGE ON SCHEMA jale_cap TO jale_api_public;
GRANT USAGE ON SCHEMA jale_cap TO jale_job_ses_feedback;
GRANT USAGE ON SCHEMA jale_cap TO jale_job_retention;
GRANT USAGE ON SCHEMA jale_cap TO jale_whatsapp;

-- ── Ownership transfer (082's window) ───────────────────────
DO $$
DECLARE
  owner_role TEXT;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY[
    'jale_cap_upload_tokens', 'jale_cap_worker_lane', 'jale_cap_share_links',
    'jale_cap_ses_feedback', 'jale_cap_retention', 'jale_cap_stale_outbox', 'jale_cap_hired_counts',
    'jale_cap_job_messaging'
  ] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', owner_role, current_user);
  END LOOP;
END;
$$;

ALTER FUNCTION jale_cap.upload_token_issue(text, uuid, uuid) OWNER TO jale_cap_upload_tokens;
ALTER FUNCTION jale_cap.upload_token_resolve(text, text, text) OWNER TO jale_cap_upload_tokens;
ALTER FUNCTION jale_cap.upload_token_slot(text, text, text, text) OWNER TO jale_cap_upload_tokens;
ALTER FUNCTION jale_cap.upload_token_confirm(text, text, text, text, text, integer, text, text) OWNER TO jale_cap_upload_tokens;
ALTER FUNCTION jale_cap.upload_token_submit(text) OWNER TO jale_cap_upload_tokens;
ALTER FUNCTION jale_cap.employer_worker_delivery_context(uuid) OWNER TO jale_cap_worker_lane;
ALTER FUNCTION jale_cap.employer_stage_recipient(uuid) OWNER TO jale_cap_worker_lane;
ALTER FUNCTION jale_cap.employer_claim_worker_intent(uuid, text, uuid, jsonb, jsonb) OWNER TO jale_cap_worker_lane;
ALTER FUNCTION jale_cap.resolve_share_link(text) OWNER TO jale_cap_share_links;
ALTER FUNCTION jale_cap.apply_ses_feedback(text) OWNER TO jale_cap_ses_feedback;
ALTER FUNCTION jale_cap.retention_purge(integer) OWNER TO jale_cap_retention;
ALTER FUNCTION jale_cap.list_stale_job_outbox_workers(interval) OWNER TO jale_cap_stale_outbox;
ALTER FUNCTION jale_cap.sync_job_hired_counts() OWNER TO jale_cap_hired_counts;
ALTER FUNCTION jale_cap.job_conversation_application_guard() OWNER TO jale_cap_job_messaging;
ALTER FUNCTION jale_cap.job_message_outbox_recipient() OWNER TO jale_cap_job_messaging;

DO $$
DECLARE
  owner_role TEXT;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY[
    'jale_cap_upload_tokens', 'jale_cap_worker_lane', 'jale_cap_share_links',
    'jale_cap_ses_feedback', 'jale_cap_retention', 'jale_cap_stale_outbox', 'jale_cap_hired_counts',
    'jale_cap_job_messaging'
  ] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', owner_role, current_user);
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', owner_role, current_user, current_user);
  END LOOP;
END;
$$;

-- ── The owners' rights ──────────────────────────────────────
-- Upload tokens: the two token tables (no row security; only this owner
-- holds rights on them), the caller's own jobs, and the job-scoped
-- documents of a worker and job that hold a live token.
GRANT SELECT ON public.document_upload_tokens TO jale_cap_upload_tokens;
GRANT INSERT (token_hash, worker_id, job_id, expires_at) ON public.document_upload_tokens TO jale_cap_upload_tokens;
GRANT UPDATE (used, used_at) ON public.document_upload_tokens TO jale_cap_upload_tokens;
GRANT SELECT ON public.document_upload_token_slots TO jale_cap_upload_tokens;
GRANT INSERT (token_hash, doc_type, issued_s3_key, expected_mime_type, max_file_size, requested_at)
  ON public.document_upload_token_slots TO jale_cap_upload_tokens;
GRANT UPDATE (issued_s3_key, expected_mime_type, max_file_size, requested_at, s3_version_id, confirmed_at)
  ON public.document_upload_token_slots TO jale_cap_upload_tokens;
GRANT SELECT (id, employer_id) ON public.jobs TO jale_cap_upload_tokens;
CREATE POLICY jobs_cap_upload_tokens_select ON public.jobs
  AS PERMISSIVE FOR SELECT TO jale_cap_upload_tokens
  USING (employer_id::text = current_setting('app.current_internal_user_id', true));
-- worker_documents' PUBLIC employer policies apply to every role that reads
-- or deletes its rows, and they read these columns; the policies on
-- job_applications and users still limit this role to the caller's own rows.
GRANT SELECT (job_id, worker_id) ON public.job_applications TO jale_cap_upload_tokens;
GRANT SELECT (id, cognito_sub) ON public.users TO jale_cap_upload_tokens;
GRANT SELECT (worker_id, job_id, doc_type, cert_name) ON public.worker_documents TO jale_cap_upload_tokens;
GRANT INSERT (id, worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id, cert_name)
  ON public.worker_documents TO jale_cap_upload_tokens;
GRANT DELETE ON public.worker_documents TO jale_cap_upload_tokens;
CREATE POLICY worker_documents_cap_upload_tokens_select ON public.worker_documents
  AS PERMISSIVE FOR SELECT TO jale_cap_upload_tokens
  USING (job_id IS NOT NULL AND (worker_id, job_id) IN (
    SELECT t.worker_id, t.job_id FROM public.document_upload_tokens t WHERE NOT t.used AND t.expires_at > now()));
CREATE POLICY worker_documents_cap_upload_tokens_insert ON public.worker_documents
  AS PERMISSIVE FOR INSERT TO jale_cap_upload_tokens
  WITH CHECK (job_id IS NOT NULL AND (worker_id, job_id) IN (
    SELECT t.worker_id, t.job_id FROM public.document_upload_tokens t WHERE NOT t.used AND t.expires_at > now()));
CREATE POLICY worker_documents_cap_upload_tokens_delete ON public.worker_documents
  AS PERMISSIVE FOR DELETE TO jale_cap_upload_tokens
  USING (job_id IS NOT NULL AND (worker_id, job_id) IN (
    SELECT t.worker_id, t.job_id FROM public.document_upload_tokens t WHERE NOT t.used AND t.expires_at > now()));

-- Worker lane: the caller's jobs, applications, conversations and messages;
-- for the caller's applicants only, their numbers, onboarding state (read
-- and row lock; its update policy admits no new row, so it is never
-- written), workflow runs, WhatsApp language and message intents; the
-- deferred-delivery control; the outbox insert for an eligible intent.
GRANT SELECT (id, employer_id) ON public.jobs TO jale_cap_worker_lane;
CREATE POLICY jobs_cap_worker_lane_select ON public.jobs
  AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (employer_id::text = current_setting('app.current_internal_user_id', true));
GRANT SELECT (id, job_id, worker_id, status, updated_at) ON public.job_applications TO jale_cap_worker_lane;
CREATE POLICY job_applications_cap_worker_lane_select ON public.job_applications
  AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (job_id IN (
    SELECT j.id FROM public.jobs j WHERE j.employer_id::text = current_setting('app.current_internal_user_id', true)));
GRANT SELECT (id, employer_id, worker_id) ON public.job_conversations TO jale_cap_worker_lane;
CREATE POLICY job_conversations_cap_worker_lane_select ON public.job_conversations
  AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (employer_id::text = current_setting('app.current_internal_user_id', true));
GRANT SELECT (id, conversation_id, sender_type) ON public.job_conversation_messages TO jale_cap_worker_lane;
CREATE POLICY job_conversation_messages_cap_worker_lane_select ON public.job_conversation_messages
  AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (conversation_id IN (
    SELECT jc.id FROM public.job_conversations jc
     WHERE jc.employer_id::text = current_setting('app.current_internal_user_id', true)));
GRANT SELECT (id, whatsapp_number, phone) ON public.users TO jale_cap_worker_lane;
CREATE POLICY users_cap_worker_lane_select ON public.users
  AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (jale_internal.employer_has_applicant_relationship(current_setting('app.current_internal_user_id', true), id));
GRANT SELECT (user_id, lifecycle) ON public.worker_onboarding_state TO jale_cap_worker_lane;
GRANT UPDATE (updated_at) ON public.worker_onboarding_state TO jale_cap_worker_lane;
CREATE POLICY worker_onboarding_state_cap_worker_lane_select ON public.worker_onboarding_state
  AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (jale_internal.employer_has_applicant_relationship(current_setting('app.current_internal_user_id', true), user_id));
CREATE POLICY worker_onboarding_state_cap_worker_lane_lock ON public.worker_onboarding_state
  AS PERMISSIVE FOR UPDATE TO jale_cap_worker_lane
  USING (jale_internal.employer_has_applicant_relationship(current_setting('app.current_internal_user_id', true), user_id))
  WITH CHECK (false);
GRANT SELECT (id, user_id, status, preferred_language, created_at) ON public.worker_workflow_runs TO jale_cap_worker_lane;
CREATE POLICY worker_workflow_runs_cap_worker_lane_select ON public.worker_workflow_runs
  AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (jale_internal.employer_has_applicant_relationship(current_setting('app.current_internal_user_id', true), user_id));
GRANT SELECT (control_key, enabled) ON public.whatsapp_runtime_controls TO jale_cap_worker_lane;
CREATE POLICY whatsapp_runtime_controls_cap_worker_lane_select ON public.whatsapp_runtime_controls
  AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (control_key = 'deferred_delivery_enabled');
GRANT SELECT (id, user_id, language, updated_at) ON public.whatsapp_conversations TO jale_cap_worker_lane;
CREATE POLICY whatsapp_conversations_cap_worker_lane_select ON public.whatsapp_conversations
  AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (user_id IS NOT NULL
         AND jale_internal.employer_has_applicant_relationship(current_setting('app.current_internal_user_id', true), user_id));
GRANT SELECT (id, user_id, dedupe_key, status, outbox_id) ON public.worker_message_intents TO jale_cap_worker_lane;
GRANT INSERT (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, status, policy_version, payload, expires_at)
  ON public.worker_message_intents TO jale_cap_worker_lane;
GRANT UPDATE (status, decision_reason, updated_at, outbox_id) ON public.worker_message_intents TO jale_cap_worker_lane;
CREATE POLICY worker_message_intents_cap_worker_lane_select ON public.worker_message_intents
  AS PERMISSIVE FOR SELECT TO jale_cap_worker_lane
  USING (jale_internal.employer_has_applicant_relationship(current_setting('app.current_internal_user_id', true), user_id));
CREATE POLICY worker_message_intents_cap_worker_lane_insert ON public.worker_message_intents
  AS PERMISSIVE FOR INSERT TO jale_cap_worker_lane
  WITH CHECK (status = 'deferred'
              AND (category, owner_service) IN (('employer_chat', 'job-messaging'), ('account', 'account'))
              AND jale_internal.employer_has_applicant_relationship(current_setting('app.current_internal_user_id', true), user_id));
CREATE POLICY worker_message_intents_cap_worker_lane_update ON public.worker_message_intents
  AS PERMISSIVE FOR UPDATE TO jale_cap_worker_lane
  USING (jale_internal.employer_has_applicant_relationship(current_setting('app.current_internal_user_id', true), user_id))
  WITH CHECK (jale_internal.employer_has_applicant_relationship(current_setting('app.current_internal_user_id', true), user_id));
GRANT INSERT (id, inbound_message_sid, sequence, whatsapp_number, body, content_template, content_variables, source_type, source_id)
  ON public.whatsapp_outbox TO jale_cap_worker_lane;
CREATE POLICY whatsapp_outbox_cap_worker_lane_insert ON public.whatsapp_outbox
  AS PERMISSIVE FOR INSERT TO jale_cap_worker_lane
  WITH CHECK (inbound_message_sid IS NULL
              AND source_type = 'worker_intent'
              AND source_id IN (
                SELECT i.id FROM public.worker_message_intents i WHERE i.status = 'eligible' AND i.outbox_id IS NULL));

-- Share links: unrevoked links only.
GRANT SELECT (code, job_id, channel, referrer_worker_id, referrer_employer_id, revoked_at)
  ON public.job_share_links TO jale_cap_share_links;
CREATE POLICY job_share_links_cap_share_links_select ON public.job_share_links
  AS PERMISSIVE FOR SELECT TO jale_cap_share_links
  USING (revoked_at IS NULL);

-- Delivery feedback: the outbox rows that carry a provider message id, and
-- the digest switch-off function.
GRANT SELECT (ses_message_id, source_type, source_id) ON public.email_outbox TO jale_cap_ses_feedback;
CREATE POLICY email_outbox_cap_ses_feedback_select ON public.email_outbox
  AS PERMISSIVE FOR SELECT TO jale_cap_ses_feedback
  USING (ses_message_id IS NOT NULL);
GRANT EXECUTE ON FUNCTION public.disable_digest_for_employer(uuid) TO jale_cap_ses_feedback;

-- Retention: only rows past their retention age.
GRANT SELECT (token_hash, expires_at) ON public.referral_apply_tokens TO jale_cap_retention;
GRANT DELETE ON public.referral_apply_tokens TO jale_cap_retention;
CREATE POLICY referral_apply_tokens_cap_retention_select ON public.referral_apply_tokens
  AS PERMISSIVE FOR SELECT TO jale_cap_retention
  USING (expires_at < now() - interval '7 days');
CREATE POLICY referral_apply_tokens_cap_retention_delete ON public.referral_apply_tokens
  AS PERMISSIVE FOR DELETE TO jale_cap_retention
  USING (expires_at < now() - interval '7 days');
GRANT SELECT (phone_hash, claimed_at, expires_at) ON public.referral_pending_claims TO jale_cap_retention;
GRANT DELETE ON public.referral_pending_claims TO jale_cap_retention;
CREATE POLICY referral_pending_claims_cap_retention_select ON public.referral_pending_claims
  AS PERMISSIVE FOR SELECT TO jale_cap_retention
  USING ((claimed_at IS NOT NULL AND claimed_at < now() - interval '30 days')
         OR (claimed_at IS NULL AND expires_at < now() - interval '30 days'));
CREATE POLICY referral_pending_claims_cap_retention_delete ON public.referral_pending_claims
  AS PERMISSIVE FOR DELETE TO jale_cap_retention
  USING ((claimed_at IS NOT NULL AND claimed_at < now() - interval '30 days')
         OR (claimed_at IS NULL AND expires_at < now() - interval '30 days'));
GRANT SELECT (id, opened_at) ON public.job_share_opens TO jale_cap_retention;
GRANT DELETE ON public.job_share_opens TO jale_cap_retention;
CREATE POLICY job_share_opens_cap_retention_select ON public.job_share_opens
  AS PERMISSIVE FOR SELECT TO jale_cap_retention
  USING (opened_at < now() - interval '400 days');
CREATE POLICY job_share_opens_cap_retention_delete ON public.job_share_opens
  AS PERMISSIVE FOR DELETE TO jale_cap_retention
  USING (opened_at < now() - interval '400 days');

-- Stale-message discovery: only sendable outbox rows, and the conversations
-- that hold one.
GRANT SELECT (conversation_id, status, attempt_count, created_at) ON public.job_message_outbox TO jale_cap_stale_outbox;
CREATE POLICY job_message_outbox_cap_stale_outbox_select ON public.job_message_outbox
  AS PERMISSIVE FOR SELECT TO jale_cap_stale_outbox
  USING (status IN ('pending', 'failed') AND attempt_count < 5);
GRANT SELECT (id, worker_id) ON public.job_conversations TO jale_cap_stale_outbox;
CREATE POLICY job_conversations_cap_stale_outbox_select ON public.job_conversations
  AS PERMISSIVE FOR SELECT TO jale_cap_stale_outbox
  USING (id IN (
    SELECT o.conversation_id FROM public.job_message_outbox o
     WHERE o.status IN ('pending', 'failed') AND o.attempt_count < 5));

-- Hired counts: the recount fires for every writer of job_applications, so
-- its rows cannot be keyed on a caller; the grants limit it to two columns.
GRANT SELECT (job_id, status) ON public.job_applications TO jale_cap_hired_counts;
CREATE POLICY job_applications_cap_hired_counts_select ON public.job_applications
  AS PERMISSIVE FOR SELECT TO jale_cap_hired_counts
  USING (true);
GRANT SELECT (id, status, number_of_workers_needed) ON public.jobs TO jale_cap_hired_counts;
GRANT UPDATE (workers_hired, status) ON public.jobs TO jale_cap_hired_counts;
CREATE POLICY jobs_cap_hired_counts_select ON public.jobs
  AS PERMISSIVE FOR SELECT TO jale_cap_hired_counts
  USING (true);
CREATE POLICY jobs_cap_hired_counts_update ON public.jobs
  AS PERMISSIVE FOR UPDATE TO jale_cap_hired_counts
  USING (true)
  WITH CHECK (true);

-- Job messaging: both triggers fire for every writer, so their rows cannot be
-- keyed on a caller; the grants limit them to the columns they compare or copy.
GRANT SELECT (id, job_id, worker_id) ON public.job_applications TO jale_cap_job_messaging;
CREATE POLICY job_applications_cap_job_messaging_select ON public.job_applications
  AS PERMISSIVE FOR SELECT TO jale_cap_job_messaging
  USING (true);
GRANT SELECT (id, employer_id) ON public.jobs TO jale_cap_job_messaging;
CREATE POLICY jobs_cap_job_messaging_select ON public.jobs
  AS PERMISSIVE FOR SELECT TO jale_cap_job_messaging
  USING (true);
GRANT SELECT (id, worker_id) ON public.job_conversations TO jale_cap_job_messaging;
CREATE POLICY job_conversations_cap_job_messaging_select ON public.job_conversations
  AS PERMISSIVE FOR SELECT TO jale_cap_job_messaging
  USING (true);
GRANT SELECT (id, whatsapp_number, phone) ON public.users TO jale_cap_job_messaging;
CREATE POLICY users_cap_job_messaging_select ON public.users
  AS PERMISSIVE FOR SELECT TO jale_cap_job_messaging
  USING (user_type = 'worker');
GRANT SELECT (user_id, phone) ON public.worker_profiles TO jale_cap_job_messaging;
CREATE POLICY worker_profiles_cap_job_messaging_select ON public.worker_profiles
  AS PERMISSIVE FOR SELECT TO jale_cap_job_messaging
  USING (true);

-- The relationship predicates (owned by their helper role): an INHERIT-only
-- window, GRANT statements only.
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET FALSE', 'jale_rls_relationship_reader', current_user);
END;
$$;
GRANT USAGE ON SCHEMA jale_internal TO jale_cap_upload_tokens, jale_cap_worker_lane;
GRANT EXECUTE ON FUNCTION jale_internal.worker_has_application(text, uuid) TO jale_cap_upload_tokens;
GRANT EXECUTE ON FUNCTION jale_internal.employer_has_applicant_relationship(text, uuid) TO jale_cap_worker_lane;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET FALSE', 'jale_rls_relationship_reader', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_rls_relationship_reader', current_user, current_user);
END;
$$;

-- ── Job-scoped documents follow their job ───────────────────
-- Deleting a job now removes its job-scoped documents and upload tokens (the
-- tokens' slots already cascade from the tokens), so the request login needs
-- no rights on those tables to delete a job. The deployed code deletes those
-- rows itself before the job, so nothing changes for it. Each constraint is
-- added NOT VALID and then validated.
ALTER TABLE public.worker_documents
  DROP CONSTRAINT worker_documents_job_id_fkey,
  ADD CONSTRAINT worker_documents_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.jobs (id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.worker_documents VALIDATE CONSTRAINT worker_documents_job_id_fkey;

ALTER TABLE public.document_upload_tokens
  DROP CONSTRAINT document_upload_tokens_job_id_fkey,
  ADD CONSTRAINT document_upload_tokens_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.jobs (id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.document_upload_tokens VALIDATE CONSTRAINT document_upload_tokens_job_id_fkey;

-- ── Self-audit ──────────────────────────────────────────────
DO $$
DECLARE
  spec RECORD;
  fn_oid OID;
  info RECORD;
  grantee_name TEXT;
  owner_role TEXT;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_cap.upload_token_issue(text, uuid, uuid)', 'jale_cap_upload_tokens', ARRAY['jale_api']),
      ('jale_cap.upload_token_resolve(text, text, text)', 'jale_cap_upload_tokens', ARRAY['jale_api_public']),
      ('jale_cap.upload_token_slot(text, text, text, text)', 'jale_cap_upload_tokens', ARRAY['jale_api_public']),
      ('jale_cap.upload_token_confirm(text, text, text, text, text, integer, text, text)', 'jale_cap_upload_tokens', ARRAY['jale_api_public']),
      ('jale_cap.upload_token_submit(text)', 'jale_cap_upload_tokens', ARRAY['jale_api_public']),
      ('jale_cap.employer_worker_delivery_context(uuid)', 'jale_cap_worker_lane', ARRAY['jale_api']),
      ('jale_cap.employer_stage_recipient(uuid)', 'jale_cap_worker_lane', ARRAY['jale_api']),
      ('jale_cap.employer_claim_worker_intent(uuid, text, uuid, jsonb, jsonb)', 'jale_cap_worker_lane', ARRAY['jale_api']),
      ('jale_cap.resolve_share_link(text)', 'jale_cap_share_links', ARRAY['jale_api']),
      ('jale_cap.apply_ses_feedback(text)', 'jale_cap_ses_feedback', ARRAY['jale_job_ses_feedback']),
      ('jale_cap.retention_purge(integer)', 'jale_cap_retention', ARRAY['jale_job_retention']),
      ('jale_cap.list_stale_job_outbox_workers(interval)', 'jale_cap_stale_outbox', ARRAY['jale_whatsapp']),
      ('jale_cap.sync_job_hired_counts()', 'jale_cap_hired_counts', ARRAY[]::text[]),
      ('jale_cap.job_conversation_application_guard()', 'jale_cap_job_messaging', ARRAY[]::text[]),
      ('jale_cap.job_message_outbox_recipient()', 'jale_cap_job_messaging', ARRAY[]::text[])
    ) AS t(signature, owner_role, callers)
  LOOP
    fn_oid := pg_catalog.to_regprocedure(spec.signature);
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef AS definer,
           p.proconfig AS config, l.lanname AS language
      INTO info
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE p.oid = fn_oid;
    IF fn_oid IS NULL OR info.owner_name IS DISTINCT FROM spec.owner_role OR NOT info.definer
       OR info.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
       OR info.language <> 'plpgsql' THEN
      RAISE EXCEPTION 'migration 105: % has the wrong owner, security, search_path or language', spec.signature;
    END IF;

    SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END, ', ')
      INTO grantee_name
      FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
       AND (a.grantee = 0 OR NOT (pg_catalog.pg_get_userbyid(a.grantee) = ANY (spec.callers)));
    IF grantee_name IS NOT NULL THEN
      RAISE EXCEPTION 'migration 105: % is executable by a role other than its owner and callers (%)', spec.signature, grantee_name;
    END IF;

    FOREACH grantee_name IN ARRAY spec.callers LOOP
      IF NOT pg_catalog.has_function_privilege(grantee_name, fn_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 105: % is not executable by %', spec.signature, grantee_name;
      END IF;
      IF NOT pg_catalog.has_schema_privilege(grantee_name, 'jale_cap', 'USAGE') THEN
        RAISE EXCEPTION 'migration 105: % lacks USAGE on jale_cap', grantee_name;
      END IF;
    END LOOP;
  END LOOP;

  -- The public stale-discovery name is an invoker wrapper for its one
  -- caller; the hired-count trigger fires the moved function.
  IF (SELECT p.prosecdef FROM pg_catalog.pg_proc p
       WHERE p.oid = pg_catalog.to_regprocedure('public.list_stale_job_outbox_workers(interval)')) IS DISTINCT FROM false
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid = pg_catalog.to_regprocedure('public.list_stale_job_outbox_workers(interval)')
          AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
          AND (a.grantee = 0 OR pg_catalog.pg_get_userbyid(a.grantee) <> 'jale_whatsapp')
     ) THEN
    RAISE EXCEPTION 'migration 105: public.list_stale_job_outbox_workers(interval) must be an invoker wrapper executable by jale_whatsapp only';
  END IF;
  IF pg_catalog.to_regprocedure('public.sync_job_hired_counts()') IS NOT NULL
     OR (SELECT t.tgfoid FROM pg_catalog.pg_trigger t
          WHERE t.tgrelid = 'public.job_applications'::regclass AND t.tgname = 'job_applications_hired_count_sync')
        IS DISTINCT FROM pg_catalog.to_regprocedure('jale_cap.sync_job_hired_counts()') THEN
    RAISE EXCEPTION 'migration 105: the hired-count trigger must fire jale_cap.sync_job_hired_counts()';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
         AND ((t.tgrelid = 'public.job_conversations'::regclass AND t.tgname = 'job_conversations_application_guard'
               AND t.tgfoid = pg_catalog.to_regprocedure('jale_cap.job_conversation_application_guard()'))
           OR (t.tgrelid = 'public.job_message_outbox'::regclass AND t.tgname = 'job_message_outbox_recipient'
               AND t.tgfoid = pg_catalog.to_regprocedure('jale_cap.job_message_outbox_recipient()')))) <> 2 THEN
    RAISE EXCEPTION 'migration 105: the job-messaging triggers must be in place and enabled';
  END IF;
  IF (SELECT p.proconfig FROM pg_catalog.pg_proc p
       WHERE p.oid = pg_catalog.to_regprocedure('public.enforce_certification_document_limit()'))
     IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] THEN
    RAISE EXCEPTION 'migration 105: the certification-limit trigger function must resolve its table on public';
  END IF;

  -- Each owner holds exactly its own policies, and none on a table it does
  -- not reach.
  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_cap_upload_tokens', 4), ('jale_cap_worker_lane', 14), ('jale_cap_share_links', 1),
      ('jale_cap_ses_feedback', 1), ('jale_cap_retention', 6), ('jale_cap_stale_outbox', 2),
      ('jale_cap_hired_counts', 3), ('jale_cap_job_messaging', 5)
    ) AS t(owner_role, policies)
  LOOP
    IF (SELECT count(*) FROM pg_catalog.pg_policy pol
         WHERE (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.owner_role) = ANY (pol.polroles))
       <> spec.policies THEN
      RAISE EXCEPTION 'migration 105: capability owner % does not hold exactly its % policies', spec.owner_role, spec.policies;
    END IF;
  END LOOP;

  FOREACH owner_role IN ARRAY ARRAY[
    'jale_cap_upload_tokens', 'jale_cap_worker_lane', 'jale_cap_share_links', 'jale_cap_ses_feedback',
    'jale_cap_retention', 'jale_cap_stale_outbox', 'jale_cap_hired_counts', 'jale_cap_job_messaging'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = owner_role)
         AND (am.set_option OR am.inherit_option)
    ) THEN
      RAISE EXCEPTION 'migration 105: a role still holds SET or INHERIT on capability owner %', owner_role;
    END IF;
    IF pg_catalog.has_schema_privilege(owner_role, 'public', 'CREATE') THEN
      RAISE EXCEPTION 'migration 105: capability owner % must not hold CREATE on public', owner_role;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members am
     WHERE am.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'jale_rls_relationship_reader')
       AND (am.inherit_option OR am.set_option)
  ) THEN
    RAISE EXCEPTION 'migration 105: a membership window on the relationship helper owner is still open';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
     WHERE n.nspname = 'jale_cap' AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'migration 105: jale_cap must stay closed to PUBLIC';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_constraint c
       WHERE c.contype = 'f' AND c.convalidated AND c.confdeltype = 'c'
         AND c.confrelid = 'public.jobs'::regclass
         AND (c.conrelid, c.conname) IN (('public.worker_documents'::regclass, 'worker_documents_job_id_fkey'),
                                         ('public.document_upload_tokens'::regclass, 'document_upload_tokens_job_id_fkey'))) <> 2 THEN
    RAISE EXCEPTION 'migration 105: the job-scoped document foreign keys must be validated and cascade on delete';
  END IF;
END;
$$;

COMMIT;
