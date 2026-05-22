-- ============================================================
-- 019_application_status_constraint_repair.sql
-- Run manually AFTER 018_document_vault_rls_hardening.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Repair live DBs that still have an old job_applications.status
-- constraint that rejects the canonical "reviewed" status.
-- ============================================================

ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

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

DROP TRIGGER IF EXISTS job_applications_updated_at ON job_applications;

CREATE TRIGGER job_applications_updated_at
  BEFORE UPDATE ON job_applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE job_applications
  ADD CONSTRAINT job_applications_status_check
  CHECK (status IN ('pending', 'reviewed', 'hired', 'rejected'));
