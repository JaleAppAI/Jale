-- 073_job_application_requirements.sql
-- Per-job applicant-requirement checkboxes (jobs.required_fields) and the
-- worker-supplied answers they gate (job_applications.application_answers).
-- Employers pick which profile fields a worker must supply before applying;
-- a WhatsApp bot team consumes required_fields via SELECT and later writes
-- application_answers incrementally as a conversational flow fills them in.
-- required_fields validity is the exact eleven-value set enumerated in
-- REQUIRED_FIELD_TYPES (infra/lambda/lib/job-fields.ts) -- keep both in sync
-- by hand.
--
-- Also widens the existing required_docs / doc_type CHECKs (jobs,
-- worker_documents, document_upload_token_slots) to add 'work_auth_doc' and
-- 'certification_doc'. 'ssn' is kept in all three for legacy rows; the
-- app layer (DOC_TYPES in job-fields.ts) already excludes it from new jobs
-- (see 032_work_authorization_required.sql).
--
-- jale_whatsapp already holds table-level SELECT on jobs (004_whatsapp.sql),
-- so required_fields needs no new grant. It gets a column-level UPDATE grant
-- on job_applications.application_answers for future incremental
-- conversational fills, mirroring the (status, updated_at) grant added in
-- 028_job_messaging_hardening.sql. Deliberately NO changes to
-- jale_public_jobs in this migration.
--
-- Does NOT touch the worker_documents vault/per-job unique indexes -- that
-- is 075_worker_documents_multi_certification.sql, which has the OPPOSITE
-- deploy-order requirement (deploy AFTER the lambda rollout, not before).
--
-- Run AFTER 072_whatsapp_retrigger_sweep_definer.sql, connected as jale_admin
-- (NOT the RDS master user). Forward-only (ADR-005). Deploy BEFORE the
-- lambda rollout referencing these columns.

BEGIN;

-- ── 1. jobs.required_fields ─────────────────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS required_fields TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_required_fields_valid;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_required_fields_valid
  CHECK (required_fields <@ ARRAY[
    'work_authorization', 'date_available', 'desired_pay', 'home_address',
    'date_of_birth', 'emergency_contact', 'worked_here_before', 'education',
    'references', 'work_history', 'military_service'
  ]::text[]);

-- ── 2. Widen jobs.required_docs CHECK ───────────────────────────
-- Named explicitly in 005_document_vault.sql (jobs_required_docs_valid) and
-- never renamed since, so no dynamic pg_constraint lookup is needed here.
ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_required_docs_valid;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_required_docs_valid
  -- 'ssn' kept for legacy rows only; app-layer DOC_TYPES excludes it (see
  -- 032_work_authorization_required.sql and job-fields.ts).
  CHECK (required_docs <@ ARRAY['resume', 'driver_license', 'ssn', 'work_auth_doc', 'certification_doc']::text[]);

-- ── 3. Widen the inline doc_type CHECKs on worker_documents and
--        document_upload_token_slots ──────────────────────────────
-- Both are unnamed/auto-named inline column CHECKs (005, 017), so find the
-- generated name via pg_constraint before dropping (same technique as
-- 019_application_status_constraint_repair.sql).
DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT rel.relname AS table_name, c.conname AS constraint_name
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname IN ('worker_documents', 'document_upload_token_slots')
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%doc_type%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', con.table_name, con.constraint_name);
  END LOOP;
END;
$$;

ALTER TABLE worker_documents
  ADD CONSTRAINT worker_documents_doc_type_valid
  CHECK (doc_type IN ('resume', 'driver_license', 'ssn', 'work_auth_doc', 'certification_doc'));

ALTER TABLE document_upload_token_slots
  ADD CONSTRAINT document_upload_token_slots_doc_type_valid
  CHECK (doc_type IN ('resume', 'driver_license', 'ssn', 'work_auth_doc', 'certification_doc'));

-- ── 4. job_applications.application_answers ─────────────────────
ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS application_answers JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── 5. Grants ────────────────────────────────────────────────────
-- jale_whatsapp already has table-level SELECT on jobs (004_whatsapp.sql),
-- so reading the new required_fields column needs no new grant.
GRANT UPDATE (application_answers, updated_at) ON job_applications TO jale_whatsapp;
-- Deliberately NO changes to jale_public_jobs.

-- ── 6. Verification ──────────────────────────────────────────────
DO $$
DECLARE
  def TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'jobs' AND c.conname = 'jobs_required_fields_valid' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%required_fields%'
     OR def NOT ILIKE '%work_authorization%'
     OR def NOT ILIKE '%military_service%'
  THEN
    RAISE EXCEPTION 'jobs_required_fields_valid CHECK missing or malformed: %', COALESCE(def, '<absent>');
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'jobs' AND c.conname = 'jobs_required_docs_valid' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%work_auth_doc%'
     OR def NOT ILIKE '%certification_doc%'
     OR def NOT ILIKE '%ssn%'
  THEN
    RAISE EXCEPTION 'jobs_required_docs_valid CHECK missing or not widened: %', COALESCE(def, '<absent>');
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'worker_documents' AND c.conname = 'worker_documents_doc_type_valid' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%work_auth_doc%'
     OR def NOT ILIKE '%certification_doc%'
     OR def NOT ILIKE '%ssn%'
  THEN
    RAISE EXCEPTION 'worker_documents_doc_type_valid CHECK missing or not widened: %', COALESCE(def, '<absent>');
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'document_upload_token_slots' AND c.conname = 'document_upload_token_slots_doc_type_valid' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%work_auth_doc%'
     OR def NOT ILIKE '%certification_doc%'
     OR def NOT ILIKE '%ssn%'
  THEN
    RAISE EXCEPTION 'document_upload_token_slots_doc_type_valid CHECK missing or not widened: %', COALESCE(def, '<absent>');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'required_fields'
  ) THEN
    RAISE EXCEPTION 'jobs.required_fields column missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'job_applications' AND column_name = 'application_answers'
  ) THEN
    RAISE EXCEPTION 'job_applications.application_answers column missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE grantee = 'jale_whatsapp'
      AND table_schema = 'public'
      AND table_name = 'job_applications'
      AND column_name = 'application_answers'
      AND privilege_type = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'jale_whatsapp missing UPDATE grant on job_applications.application_answers';
  END IF;
END;
$$;

COMMIT;
