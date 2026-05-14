-- ============================================================
-- 013_application_status_alignment.sql
-- Run manually AFTER 012_ai_trust_assessment.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Align job_applications.status to the canonical lifecycle:
-- pending, reviewed, hired, rejected.
-- ============================================================

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
    AND rel.relname = 'job_applications'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%status%'
    AND pg_get_constraintdef(con.oid) LIKE '%submitted%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE job_applications DROP CONSTRAINT %I', constraint_name);
  END IF;
END;
$$;

ALTER TABLE job_applications
  DROP CONSTRAINT IF EXISTS job_applications_status_check;

UPDATE job_applications
SET status = CASE status
  WHEN 'submitted' THEN 'pending'
  WHEN 'viewed' THEN 'reviewed'
  WHEN 'contacted' THEN 'reviewed'
  ELSE status
END
WHERE status IN ('submitted', 'viewed', 'contacted');

ALTER TABLE job_applications
  ALTER COLUMN status SET DEFAULT 'pending';

DROP INDEX IF EXISTS idx_job_applications_status_submitted;

CREATE INDEX IF NOT EXISTS idx_job_applications_status_pending
  ON job_applications(job_id, applied_at DESC)
  WHERE status = 'pending';

ALTER TABLE job_applications
  ADD CONSTRAINT job_applications_status_check
  CHECK (status IN ('pending', 'reviewed', 'hired', 'rejected'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'job_applications'
      AND policyname = 'applications_employer_update'
  ) THEN
    CREATE POLICY applications_employer_update
      ON job_applications FOR UPDATE
      USING (
        job_id IN (
          SELECT id FROM jobs
          WHERE employer_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true))
        )
      )
      WITH CHECK (
        job_id IN (
          SELECT id FROM jobs
          WHERE employer_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true))
        )
      );
  END IF;
END;
$$;
