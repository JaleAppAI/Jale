-- ============================================================
-- 023_job_fields_and_statuses_mvp.sql
-- Run manually AFTER 022_job_application_required_docs_guard.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Adds MVP labor-need fields and aligns job/application lifecycle
-- statuses for the employer hiring flow.
-- ============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS pay_min INTEGER,
  ADD COLUMN IF NOT EXISTS pay_max INTEGER,
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS expected_duration TEXT,
  ADD COLUMN IF NOT EXISTS shift_schedule TEXT,
  ADD COLUMN IF NOT EXISTS transportation_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS language_preference TEXT[] NOT NULL DEFAULT ARRAY['any']::text[],
  ADD COLUMN IF NOT EXISTS number_of_workers_needed INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS workers_hired INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trade_category TEXT,
  ADD COLUMN IF NOT EXISTS required_experience_years INTEGER,
  ADD COLUMN IF NOT EXISTS certifications TEXT[] NOT NULL DEFAULT '{}'::text[];

UPDATE jobs
SET language_preference = ARRAY['any']::text[]
WHERE language_preference IS NULL OR cardinality(language_preference) = 0;

UPDATE jobs
SET number_of_workers_needed = 1
WHERE number_of_workers_needed IS NULL OR number_of_workers_needed < 1;

UPDATE jobs
SET workers_hired = 0
WHERE workers_hired IS NULL OR workers_hired < 0;

UPDATE jobs j
SET workers_hired = counts.hired_count
FROM (
  SELECT job_id, COUNT(*)::int AS hired_count
  FROM job_applications
  WHERE status = 'hired'
  GROUP BY job_id
) counts
WHERE counts.job_id = j.id;

UPDATE jobs
SET number_of_workers_needed = workers_hired
WHERE workers_hired > number_of_workers_needed;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname
  INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'jobs'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%status%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE jobs DROP CONSTRAINT %I', constraint_name);
  END IF;
END;
$$;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('active', 'paused', 'filled', 'closed'));

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_pay_range_check,
  ADD CONSTRAINT jobs_pay_range_check
  CHECK (
    (pay_min IS NULL OR pay_min >= 0)
    AND (pay_max IS NULL OR pay_max >= 0)
    AND (pay_min IS NULL OR pay_max IS NULL OR pay_min <= pay_max)
  );

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_headcount_check,
  ADD CONSTRAINT jobs_headcount_check
  CHECK (
    number_of_workers_needed > 0
    AND workers_hired >= 0
  );

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_language_preference_check,
  ADD CONSTRAINT jobs_language_preference_check
  CHECK (
    language_preference <@ ARRAY['any', 'en', 'es']::text[]
    AND cardinality(language_preference) > 0
    AND NOT ('any' = ANY(language_preference) AND cardinality(language_preference) > 1)
  );

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_trade_category_check,
  ADD CONSTRAINT jobs_trade_category_check
  CHECK (
    trade_category IS NULL
    OR trade_category IN (
      'electrician',
      'plumber',
      'carpenter',
      'concrete',
      'painting',
      'drywall',
      'general_labor',
      'other'
    )
  );

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_required_experience_check,
  ADD CONSTRAINT jobs_required_experience_check
  CHECK (required_experience_years IS NULL OR required_experience_years >= 0);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at
  ON jobs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_trade_category
  ON jobs(trade_category)
  WHERE trade_category IS NOT NULL;

DO $$
DECLARE
  status_constraint RECORD;
BEGIN
  FOR status_constraint IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'job_applications'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE job_applications DROP CONSTRAINT %I', status_constraint.conname);
  END LOOP;
END;
$$;

UPDATE job_applications
SET status = CASE status
  WHEN 'reviewed' THEN 'contacted'
  WHEN 'rejected' THEN 'not_interested'
  ELSE status
END
WHERE status IN ('reviewed', 'rejected');

ALTER TABLE job_applications
  ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE job_applications
  ADD CONSTRAINT job_applications_status_check
  CHECK (status IN ('pending', 'contacted', 'talking', 'hired', 'not_interested'));

DROP INDEX IF EXISTS idx_job_applications_status_pending;
CREATE INDEX IF NOT EXISTS idx_job_applications_status_pending
  ON job_applications(job_id, applied_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_job_applications_status_lifecycle
  ON job_applications(job_id, status, applied_at DESC);

CREATE OR REPLACE FUNCTION sync_job_hired_counts()
RETURNS TRIGGER AS $$
DECLARE
  target_job_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_job_id := OLD.job_id;
  ELSE
    target_job_id := NEW.job_id;
  END IF;

  UPDATE jobs
  SET workers_hired = (
        SELECT COUNT(*)::int
        FROM job_applications
        WHERE job_id = target_job_id
          AND status = 'hired'
      ),
      status = CASE
        WHEN status IN ('closed', 'paused') THEN status
        WHEN (
          SELECT COUNT(*)::int
          FROM job_applications
          WHERE job_id = target_job_id
            AND status = 'hired'
        ) >= number_of_workers_needed THEN 'filled'
        WHEN status = 'filled' THEN 'active'
        ELSE status
      END
  WHERE id = target_job_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_applications_hired_count_sync ON job_applications;

CREATE TRIGGER job_applications_hired_count_sync
  AFTER INSERT OR UPDATE OF status OR DELETE ON job_applications
  FOR EACH ROW EXECUTE FUNCTION sync_job_hired_counts();
