-- 074_job_optional_requirements.sql
-- Every per-job applicant data point is three-state: Off / Optional /
-- Required. Required (jobs.required_fields / jobs.required_docs, added in
-- 073_job_application_requirements.sql) blocks application submission when
-- absent; Optional (jobs.optional_fields / jobs.optional_docs, added here)
-- is asked but skippable. A field/doc absent from both arrays is Off.
--
-- optional_fields validity is the EXACT SAME eleven-value set as
-- jobs_required_fields_valid (073) -- keep both allowlists in sync by hand,
-- same caveat as 073's REQUIRED_FIELD_TYPES / job-fields.ts note.
--
-- optional_docs deliberately does NOT include 'ssn': unlike required_docs
-- (which keeps 'ssn' for legacy rows per 032_work_authorization_required.sql
-- and 073), optional_docs is a brand-new column with no legacy rows to
-- carry forward, and the app layer's DOC_TYPES (job-fields.ts) never offers
-- 'ssn' for new selections anyway.
--
-- A data point must never occupy both tiers on the same job at once, so
-- this migration also adds two disjointness CHECKs (required vs optional,
-- per field/doc array) -- see jobs_fields_tiers_disjoint /
-- jobs_docs_tiers_disjoint below.
--
-- Purely additive: two new columns with NOT NULL DEFAULT '{}', their own
-- validity CHECKs, and two cross-column disjointness CHECKs. Deploy-anytime
-- (safe against old application code, which never references these
-- columns), but deploy BEFORE the lambda rollout that reads/writes
-- optional_fields / optional_docs.
--
-- jale_whatsapp already holds table-level SELECT on jobs (004_whatsapp.sql),
-- so reading optional_fields / optional_docs needs no new grant.
-- Deliberately NO changes to jale_public_jobs in this migration.
--
-- Run AFTER 073_job_application_requirements.sql, connected as jale_admin
-- (NOT the RDS master user). Forward-only (ADR-005).

BEGIN;

-- ── 1. jobs.optional_fields ─────────────────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS optional_fields TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_optional_fields_valid;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_optional_fields_valid
  -- Same eleven-value allowlist as jobs_required_fields_valid (073) --
  -- keep both in sync by hand.
  CHECK (optional_fields <@ ARRAY[
    'work_authorization', 'date_available', 'desired_pay', 'home_address',
    'date_of_birth', 'emergency_contact', 'worked_here_before', 'education',
    'references', 'work_history', 'military_service'
  ]::text[]);

-- ── 2. jobs.optional_docs ────────────────────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS optional_docs TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_optional_docs_valid;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_optional_docs_valid
  -- No 'ssn' here: optional_docs is new with no legacy rows, unlike
  -- required_docs (jobs_required_docs_valid in 073) which keeps 'ssn' only
  -- for legacy data.
  CHECK (optional_docs <@ ARRAY['resume', 'driver_license', 'work_auth_doc', 'certification_doc']::text[]);

-- ── 3. Tier disjointness ─────────────────────────────────────────
-- A data point is required, optional, or absent -- never two tiers at
-- once. Both arrays are small (<=11 / <=4 elements), so the array overlap
-- operator (&&) is cheap here.
ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_fields_tiers_disjoint;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_fields_tiers_disjoint
  CHECK (NOT (required_fields && optional_fields));

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_docs_tiers_disjoint;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_docs_tiers_disjoint
  CHECK (NOT (required_docs && optional_docs));

-- ── 4. Grants ────────────────────────────────────────────────────
-- jale_whatsapp already has table-level SELECT on jobs (004_whatsapp.sql),
-- so reading the new optional_fields / optional_docs columns needs no new
-- grant. Deliberately NO changes to jale_public_jobs.

-- ── 5. Verification ──────────────────────────────────────────────
DO $$
DECLARE
  def TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'jobs' AND c.conname = 'jobs_optional_fields_valid' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%optional_fields%'
     OR def NOT ILIKE '%work_authorization%'
     OR def NOT ILIKE '%military_service%'
  THEN
    RAISE EXCEPTION 'jobs_optional_fields_valid CHECK missing or malformed: %', COALESCE(def, '<absent>');
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'jobs' AND c.conname = 'jobs_optional_docs_valid' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%optional_docs%'
     OR def NOT ILIKE '%work_auth_doc%'
     OR def NOT ILIKE '%certification_doc%'
     OR def ILIKE '%ssn%'
  THEN
    RAISE EXCEPTION 'jobs_optional_docs_valid CHECK missing, malformed, or wrongly includes ssn: %', COALESCE(def, '<absent>');
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'jobs' AND c.conname = 'jobs_fields_tiers_disjoint' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%required_fields%'
     OR def NOT ILIKE '%optional_fields%'
  THEN
    RAISE EXCEPTION 'jobs_fields_tiers_disjoint CHECK missing or malformed: %', COALESCE(def, '<absent>');
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'jobs' AND c.conname = 'jobs_docs_tiers_disjoint' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%required_docs%'
     OR def NOT ILIKE '%optional_docs%'
  THEN
    RAISE EXCEPTION 'jobs_docs_tiers_disjoint CHECK missing or malformed: %', COALESCE(def, '<absent>');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'optional_fields'
  ) THEN
    RAISE EXCEPTION 'jobs.optional_fields column missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'optional_docs'
  ) THEN
    RAISE EXCEPTION 'jobs.optional_docs column missing';
  END IF;
END;
$$;

COMMIT;
