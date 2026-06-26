-- ============================================================
-- 031_work_authorization_required.sql
-- Run manually AFTER 030_whatsapp_worker_skills_seed.sql
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

-- Add work authorization required flag to jobs
-- SSN is intentionally kept in jobs_required_docs_valid CHECK (existing rows may reference it).
-- App-layer DOC_TYPES in job-fields.ts no longer includes 'ssn', so new jobs cannot use it.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS work_authorization_required BOOLEAN NOT NULL DEFAULT false;

-- Grants: jale_admin already has full access to jobs; jale_whatsapp and jale_matching
-- can read the new column via existing SELECT grants on the jobs table.
