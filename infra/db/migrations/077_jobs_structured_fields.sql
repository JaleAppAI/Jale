-- 077_jobs_structured_fields.sql
-- Job-flow redesign (BE-T1): six new structured fields on jobs that the
-- employer job-creation/edit flow will collect going forward, all nullable
-- with no default -- NULL is the "not collected" sentinel, not a value the
-- app layer normalizes away.
--
--   trade_category_other        free text, only meaningful when
--                                trade_category = 'other' (023).
--   expected_duration_bucket    a closed enum bucket ('lt_1w' .. 'ongoing').
--                                This sits ALONGSIDE the existing free-text
--                                jobs.expected_duration column (023) rather
--                                than replacing it: expected_duration is
--                                legacy display copy already rendered by old
--                                clients, and this migration does not touch
--                                it or backfill it. The two columns coexist
--                                until a later task retires the free-text one.
--   work_days                   TEXT[] of day abbreviations, e.g. {mon,wed,fri}.
--   shift_start / shift_end     TIME of day. Deliberately NO
--                                "shift_end > shift_start" CHECK: overnight
--                                shifts (e.g. shift_start='22:00',
--                                shift_end='06:00') are a legitimate, common
--                                shape for this trade population, and a
--                                same-day-only CHECK would reject them.
--                                Also deliberately NO "both or neither"
--                                completeness CHECK in the style of
--                                009_location_foundation.sql's
--                                jobs_location_complete or 068's
--                                worker_preferred_cities_coords_complete: a
--                                job may legitimately state one bound without
--                                the other (e.g. "starts around 7am, end time
--                                varies"), unlike a coordinate pair where one
--                                side without the other is never meaningful.
--   certification_requirements  JSONB array; shape (per-entry keys) is
--                                validated by the app layer, matching the
--                                073/074 precedent that per-entry validation
--                                of a JSON-shaped column stays out of SQL.
--                                Only jsonb_typeof(...) = 'array' is enforced
--                                here.
--
-- All four new CHECK constraints are deliberately ONE-WAY (they validate the
-- *new* column against another column's value, never the reverse), because
-- employer-jobs-update.ts writes the full row on every PATCH (via
-- parseJobFields), including columns the request body didn't touch. A
-- symmetric/bidirectional constraint (e.g. requiring trade_category_other to
-- be NOT NULL when trade_category = 'other') would make every legacy
-- trade_category='other' row -- which predates this migration and has
-- trade_category_other NULL -- unwritable by that handler until every one of
-- those employers re-supplies the new field. jobs_trade_category_other_valid
-- therefore only forbids trade_category_other on non-'other' rows; it does
-- NOT require it on 'other' rows. The app layer enforces "require
-- trade_category_other on new 'other' submissions" at the parseJobFields
-- layer, not here.
--
-- jale_public_jobs (056/061) is the only column-scoped read role on jobs;
-- without extending its grant, the public job page's SELECT would ask for
-- these six columns and get a bare "permission denied for table jobs" 500 the
-- moment its query is updated to include them. jale_matching (010) and
-- jale_whatsapp (004) both hold TABLE-level SELECT on jobs already, so no
-- grant change is needed for either.
--
-- Run AFTER 076_ai_extraction_asr_metadata.sql, connected as jale_admin (NOT
-- the RDS master user). Forward-only (ADR-005).

BEGIN;

-- ── 1. New columns ───────────────────────────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS trade_category_other TEXT,
  ADD COLUMN IF NOT EXISTS expected_duration_bucket TEXT,
  ADD COLUMN IF NOT EXISTS work_days TEXT[],
  ADD COLUMN IF NOT EXISTS shift_start TIME,
  ADD COLUMN IF NOT EXISTS shift_end TIME,
  ADD COLUMN IF NOT EXISTS certification_requirements JSONB;

-- ── 2. CHECK constraints ─────────────────────────────────────────
ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_trade_category_other_valid;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_trade_category_other_valid
  -- One-way on purpose -- see header. Legacy trade_category='other' rows with
  -- trade_category_other IS NULL remain valid and remain writable.
  CHECK (trade_category = 'other' OR trade_category_other IS NULL);

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_expected_duration_bucket_valid;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_expected_duration_bucket_valid
  CHECK (expected_duration_bucket IS NULL OR expected_duration_bucket IN (
    'lt_1w', '1_2w', '2_4w', '1_3m', '3_6m', '6m_plus', 'ongoing'
  ));

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_work_days_valid;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_work_days_valid
  CHECK (work_days IS NULL OR work_days <@ ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']::text[]);

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_certification_requirements_valid;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_certification_requirements_valid
  -- Only the outer shape is enforced here; per-entry validation is app-layer
  -- by 073/074 precedent (see header).
  CHECK (certification_requirements IS NULL OR jsonb_typeof(certification_requirements) = 'array');

-- ── 3. Grants ────────────────────────────────────────────────────
-- jale_public_jobs is the one column-scoped read role on jobs (056/061);
-- jale_matching (010) and jale_whatsapp (004) already hold table-level SELECT
-- on jobs and need no grant change.
GRANT SELECT (
  trade_category_other, expected_duration_bucket, work_days,
  shift_start, shift_end, certification_requirements
) ON jobs TO jale_public_jobs;

-- ── 4. Verification ──────────────────────────────────────────────
DO $$
DECLARE
  def TEXT;
  col TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'jobs' AND c.conname = 'jobs_trade_category_other_valid' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%trade_category%'
     OR def NOT ILIKE '%trade_category_other%'
  THEN
    RAISE EXCEPTION 'jobs_trade_category_other_valid CHECK missing or malformed: %', COALESCE(def, '<absent>');
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'jobs' AND c.conname = 'jobs_expected_duration_bucket_valid' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%expected_duration_bucket%'
     OR def NOT ILIKE '%ongoing%'
     OR def NOT ILIKE '%lt_1w%'
  THEN
    RAISE EXCEPTION 'jobs_expected_duration_bucket_valid CHECK missing or malformed: %', COALESCE(def, '<absent>');
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'jobs' AND c.conname = 'jobs_work_days_valid' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%work_days%'
     OR def NOT ILIKE '%mon%'
     OR def NOT ILIKE '%sun%'
  THEN
    RAISE EXCEPTION 'jobs_work_days_valid CHECK missing or malformed: %', COALESCE(def, '<absent>');
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'jobs' AND c.conname = 'jobs_certification_requirements_valid' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%certification_requirements%'
     OR def NOT ILIKE '%jsonb_typeof%'
     OR def NOT ILIKE '%array%'
  THEN
    RAISE EXCEPTION 'jobs_certification_requirements_valid CHECK missing or malformed: %', COALESCE(def, '<absent>');
  END IF;

  FOREACH col IN ARRAY ARRAY[
    'trade_category_other', 'expected_duration_bucket', 'work_days',
    'shift_start', 'shift_end', 'certification_requirements'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = col
    ) THEN
      RAISE EXCEPTION 'jobs.% column missing', col;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.column_privileges
      WHERE grantee = 'jale_public_jobs'
        AND table_schema = 'public'
        AND table_name = 'jobs'
        AND column_name = col
        AND privilege_type = 'SELECT'
    ) THEN
      RAISE EXCEPTION 'jale_public_jobs missing SELECT grant on jobs.%', col;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
