BEGIN;

ALTER TABLE job_applications DISABLE TRIGGER job_applications_hired_count_sync;

UPDATE job_applications
SET status = CASE status
  WHEN 'reviewed' THEN 'contacted'
  WHEN 'rejected' THEN 'not_interested'
  ELSE status
END
WHERE status IN ('reviewed', 'rejected');

ALTER TABLE job_applications ENABLE TRIGGER job_applications_hired_count_sync;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM job_applications
    WHERE status NOT IN ('pending', 'contacted', 'talking', 'hired', 'not_interested')
  ) THEN
    RAISE EXCEPTION 'sprint11_unexpected_application_status';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jobs
    WHERE COALESCE(pay_min, 0) > 9999
       OR COALESCE(pay_max, 0) > 9999
       OR COALESCE(required_experience_years, 0) > 80
       OR number_of_workers_needed > 500
       OR workers_hired > 500
  ) THEN
    RAISE EXCEPTION 'sprint11_job_field_out_of_bounds';
  END IF;
END $$;

UPDATE jobs
SET number_of_workers_needed = GREATEST(number_of_workers_needed, workers_hired, 1)
WHERE number_of_workers_needed < 1
   OR workers_hired > number_of_workers_needed;

ALTER TABLE job_applications DROP CONSTRAINT IF EXISTS job_applications_status_check;
ALTER TABLE job_applications
  ADD CONSTRAINT job_applications_status_check
  CHECK (status IN ('pending', 'contacted', 'talking', 'hired', 'not_interested')) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_job_applications_status_talking
  ON job_applications (job_id, applied_at DESC)
  WHERE status = 'talking';

CREATE INDEX IF NOT EXISTS idx_job_applications_status_hired
  ON job_applications (job_id, applied_at DESC)
  WHERE status = 'hired';

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_pay_range_check;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_pay_bounds_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_pay_bounds_check
  CHECK (
    (pay_min IS NULL OR (pay_min >= 0 AND pay_min <= 9999)) AND
    (pay_max IS NULL OR (pay_max >= 0 AND pay_max <= 9999)) AND
    (pay_min IS NULL OR pay_max IS NULL OR pay_min <= pay_max)
  ) NOT VALID;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_headcount_check;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_headcount_bounds_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_headcount_bounds_check
  CHECK (
    number_of_workers_needed BETWEEN 1 AND 500 AND
    workers_hired >= 0 AND
    workers_hired <= number_of_workers_needed
  ) NOT VALID;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_required_experience_check;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_required_experience_years_bounds_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_required_experience_years_bounds_check
  CHECK (
    required_experience_years IS NULL OR
    required_experience_years BETWEEN 0 AND 80
  ) NOT VALID;

COMMIT;

BEGIN;

ALTER TABLE job_applications VALIDATE CONSTRAINT job_applications_status_check;
ALTER TABLE jobs VALIDATE CONSTRAINT jobs_pay_bounds_check;
ALTER TABLE jobs VALIDATE CONSTRAINT jobs_headcount_bounds_check;
ALTER TABLE jobs VALIDATE CONSTRAINT jobs_required_experience_years_bounds_check;

COMMIT;
