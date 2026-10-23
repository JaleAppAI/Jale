-- ============================================================
-- 131_job_shift_periods.sql
-- Run manually AFTER 130,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Shift choices (sprint 29, contract K2). An employer marks a job as one or
-- more of Day, Evening, Night and Overnight; shift_start/shift_end (077) stay
-- optional and independent of it. jobs.shift_periods holds the choice:
--   * TEXT[] NOT NULL DEFAULT '{}'. Every existing job reads as no shift
--     chosen; a constant default adds the column without rewriting the table.
--   * jobs_shift_periods_valid: every element is one of the four periods,
--     there are at most four, and the array has one dimension (`<@` and
--     cardinality() both ignore dimensions; an empty array has none, so its
--     array_ndims is NULL). `<@` accepts duplicates, so the API parser
--     (lambda/lib/job-fields.ts, parseShiftPeriods) folds them and stores the
--     periods in canonical order. The ARRAY[...] literal matches
--     SHIFT_PERIODS in that file (job-fields.test.ts pins the two together).
--
-- Grants. jale_public_jobs is the one column-scoped reader of jobs
-- (056/061/077/091) and gets SELECT on the new column for the public job
-- page. jale_api, jale_whatsapp and jale_matching hold table-level SELECT on
-- jobs and need no change. jale_job_digest keeps its column list: the
-- employer digest shows no shifts. The access manifest records the new
-- column on jale_public_jobs; nothing else in it changes.
--
-- REPLAY. Idempotent: ADD COLUMN IF NOT EXISTS, the CHECK is dropped and
-- added again, and a repeated GRANT changes nothing. A closing check refuses
-- to commit unless the column, its default, the CHECK and every login's
-- right to read it are exactly as described above.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the code. The new
-- handlers name jobs.shift_periods, and a statement naming a column that
-- does not exist fails. Applied first, the running code is unaffected: it
-- never names the column, and the default fills it on every insert.
-- ============================================================
BEGIN;

-- ALTER TABLE takes an ACCESS EXCLUSIVE lock on jobs; never queue behind a
-- stuck transaction.
SET LOCAL lock_timeout = '5s';

-- ── 1. Preconditions ────────────────────────────────────────
DO $$
BEGIN
  IF current_user <> 'jale_admin' THEN
    RAISE EXCEPTION 'migration 131: connect as jale_admin (this session runs as %)', current_user;
  END IF;
  IF pg_catalog.to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'migration 131: public.jobs is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'jale_public_jobs') THEN
    RAISE EXCEPTION 'migration 131: role jale_public_jobs is missing';
  END IF;
END;
$$;

-- ── 2. The column and its CHECK ─────────────────────────────
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS shift_periods TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_shift_periods_valid;

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_shift_periods_valid
  CHECK (shift_periods <@ ARRAY['day', 'evening', 'night', 'overnight']::text[]
         AND cardinality(shift_periods) <= 4
         AND (array_ndims(shift_periods) IS NULL OR array_ndims(shift_periods) = 1));

-- ── 3. Grants ───────────────────────────────────────────────
GRANT SELECT (shift_periods) ON public.jobs TO jale_public_jobs;

-- ── 4. Closing check ────────────────────────────────────────
DO $$
DECLARE
  v_type TEXT;
  v_not_null BOOLEAN;
  v_default TEXT;
  v_check TEXT;
  v_login TEXT;
BEGIN
  SELECT pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull,
         pg_catalog.pg_get_expr(d.adbin, d.adrelid)
    INTO v_type, v_not_null, v_default
    FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.jobs'::regclass
     AND a.attname = 'shift_periods'
     AND a.attnum > 0
     AND NOT a.attisdropped;
  IF v_type IS DISTINCT FROM 'text[]'
     OR v_not_null IS DISTINCT FROM true
     OR v_default IS DISTINCT FROM '''{}''::text[]' THEN
    RAISE EXCEPTION 'migration 131: jobs.shift_periods is % (not null: %, default: %), expected text[] NOT NULL DEFAULT ''{}''',
      COALESCE(v_type, '<absent>'), COALESCE(v_not_null::text, '<absent>'), COALESCE(v_default, '<none>');
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_check
    FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.jobs'::regclass
     AND c.conname = 'jobs_shift_periods_valid'
     AND c.contype = 'c'
     AND c.convalidated;
  IF v_check IS DISTINCT FROM
     'CHECK (((shift_periods <@ ARRAY[''day''::text, ''evening''::text, ''night''::text, ''overnight''::text]) AND (cardinality(shift_periods) <= 4) AND ((array_ndims(shift_periods) IS NULL) OR (array_ndims(shift_periods) = 1))))' THEN
    RAISE EXCEPTION 'migration 131: jobs_shift_periods_valid is missing or reads %', COALESCE(v_check, '<absent>');
  END IF;

  -- The public page's login reads the column through its own column grant,
  -- and still holds no table-wide SELECT.
  IF NOT pg_catalog.has_column_privilege('jale_public_jobs', 'public.jobs', 'shift_periods', 'SELECT') THEN
    RAISE EXCEPTION 'migration 131: jale_public_jobs cannot read jobs.shift_periods';
  END IF;
  IF pg_catalog.has_table_privilege('jale_public_jobs', 'public.jobs', 'SELECT') THEN
    RAISE EXCEPTION 'migration 131: jale_public_jobs holds a table-level SELECT on jobs';
  END IF;

  -- The table-level readers see it through the rights they already hold.
  FOREACH v_login IN ARRAY ARRAY['jale_api', 'jale_whatsapp', 'jale_matching'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_login)
       AND NOT pg_catalog.has_column_privilege(v_login, 'public.jobs', 'shift_periods', 'SELECT') THEN
      RAISE EXCEPTION 'migration 131: % cannot read jobs.shift_periods', v_login;
    END IF;
  END LOOP;

  -- The employer digest keeps its column list.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'jale_job_digest')
     AND pg_catalog.has_column_privilege('jale_job_digest', 'public.jobs', 'shift_periods', 'SELECT') THEN
    RAISE EXCEPTION 'migration 131: jale_job_digest can read jobs.shift_periods';
  END IF;
END;
$$;

COMMIT;
