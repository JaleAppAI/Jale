-- 033_pay_interval_experience_months_worker_certifications.sql
-- Sprint 15 / TSK-09: canonical pay interval, experience in months, and worker certifications.
-- Run manually AFTER 032_work_authorization_required.sql.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS pay_interval TEXT,
  ADD COLUMN IF NOT EXISTS required_experience_months INTEGER;

-- Clamp the years value to 80 BEFORE multiplying: legacy year columns are only
-- CHECK (>= 0) (mig 023 jobs / mig 003 worker_profiles), so an out-of-range row
-- must not (a) abort the ADD CONSTRAINT that follows, nor (b) overflow int4 in
-- the `* 12` on an extreme dirty value. LEAST(years, 80) * 12 ∈ [0, 960] always.
UPDATE jobs
SET required_experience_months = LEAST(required_experience_years, 80) * 12
WHERE required_experience_months IS NULL
  AND required_experience_years IS NOT NULL;

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_pay_interval_check,
  ADD CONSTRAINT jobs_pay_interval_check
    CHECK (pay_interval IS NULL OR pay_interval IN ('hourly', 'daily', 'weekly', 'monthly', 'fixed')),
  DROP CONSTRAINT IF EXISTS jobs_required_experience_months_check,
  ADD CONSTRAINT jobs_required_experience_months_check
    CHECK (required_experience_months IS NULL OR required_experience_months BETWEEN 0 AND 960);

ALTER TABLE worker_profiles
  ADD COLUMN IF NOT EXISTS experience_months INTEGER,
  ADD COLUMN IF NOT EXISTS certifications TEXT[] NOT NULL DEFAULT '{}'::text[];

-- Same clamp-before-multiply as the jobs backfill above (avoids int4 overflow).
UPDATE worker_profiles
SET experience_months = LEAST(years_experience, 80) * 12
WHERE experience_months IS NULL
  AND years_experience IS NOT NULL;

ALTER TABLE worker_profiles
  DROP CONSTRAINT IF EXISTS worker_profiles_experience_months_check,
  ADD CONSTRAINT worker_profiles_experience_months_check
    CHECK (experience_months IS NULL OR experience_months BETWEEN 0 AND 960),
  DROP CONSTRAINT IF EXISTS worker_profiles_certifications_count_check,
  ADD CONSTRAINT worker_profiles_certifications_count_check
    CHECK (cardinality(certifications) <= 20),
  DROP CONSTRAINT IF EXISTS worker_profiles_certifications_values_check,
  ADD CONSTRAINT worker_profiles_certifications_values_check
    CHECK (
      certifications IS NOT NULL
      AND array_position(certifications, '') IS NULL
      AND length(array_to_string(certifications, '')) <= 4000
    );

-- The matching role needs canonical experience for scoring, but worker certifications
-- remain worker-declared profile facts exposed only through applicant-scoped APIs for now.
GRANT SELECT (experience_months) ON worker_profiles TO jale_matching;
