-- ============================================================
-- 003_jobs_and_applications.sql
-- Run manually AFTER 002_rls_policies.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Canonical undeployed baseline for employer jobs, worker profiles,
-- and applications. Older duplicate job/application migrations were
-- folded into this file so fresh databases have one schema path.
-- ============================================================

-- ── Jobs ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  company     TEXT,
  location    TEXT        NOT NULL,
  pay         TEXT,
  job_type    TEXT        NOT NULL CHECK (job_type IN ('full-time', 'part-time', 'contract')),
  description TEXT,
  status      TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_employer_id ON jobs(employer_id);

CREATE TRIGGER jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Job Applications ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_applications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id  UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status     TEXT        NOT NULL DEFAULT 'submitted'
             CHECK (status IN ('submitted', 'viewed', 'contacted', 'hired', 'rejected')),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, worker_id)
);

CREATE INDEX IF NOT EXISTS idx_job_applications_job_id    ON job_applications(job_id);
CREATE INDEX IF NOT EXISTS idx_job_applications_worker_id ON job_applications(worker_id);
CREATE INDEX IF NOT EXISTS idx_job_applications_status_submitted
  ON job_applications(job_id, applied_at DESC)
  WHERE status = 'submitted';

CREATE TRIGGER job_applications_updated_at
  BEFORE UPDATE ON job_applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Worker Profiles ──────────────────────────────────────────
-- full_name and phone are denormalized here so employers can read
-- applicant contact info without needing access to the users table.
-- These are populated when the worker completes their profile (future sprint).
CREATE TABLE IF NOT EXISTS worker_profiles (
  user_id          UUID    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name        TEXT,
  phone            TEXT,
  skills           TEXT[]  NOT NULL DEFAULT '{}',
  availability     TEXT    CHECK (availability IN ('full_time', 'part_time', 'weekends', 'flexible')),
  years_experience INTEGER CHECK (years_experience IS NULL OR years_experience >= 0),
  location         TEXT,
  bio              TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER worker_profiles_updated_at
  BEFORE UPDATE ON worker_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Grants ───────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON jobs TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON job_applications TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON worker_profiles TO jale_admin;

-- ── RLS: jobs ────────────────────────────────────────────────
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY jobs_employer_select
  ON jobs FOR SELECT
  USING (employer_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)));

CREATE POLICY jobs_employer_insert
  ON jobs FOR INSERT
  WITH CHECK (employer_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)));

CREATE POLICY jobs_employer_update
  ON jobs FOR UPDATE
  USING     (employer_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)))
  WITH CHECK (employer_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)));

-- ── RLS: job_applications ────────────────────────────────────
ALTER TABLE job_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_applications FORCE ROW LEVEL SECURITY;

-- Workers see their own applications
CREATE POLICY applications_worker_select
  ON job_applications FOR SELECT
  USING (worker_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)));

CREATE POLICY applications_worker_insert
  ON job_applications FOR INSERT
  WITH CHECK (worker_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)));

-- Employers see applications to their jobs (explicit employer ownership check, not relying on cascade)
CREATE POLICY applications_employer_select
  ON job_applications FOR SELECT
  USING (
    job_id IN (
      SELECT id FROM jobs
      WHERE employer_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true))
    )
  );

-- ── RLS: worker_profiles ─────────────────────────────────────
ALTER TABLE worker_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_profiles FORCE ROW LEVEL SECURITY;

-- Workers manage their own profile
CREATE POLICY worker_profiles_self
  ON worker_profiles FOR ALL
  USING (user_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)))
  WITH CHECK (user_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)));

-- Employers can read any worker profile (needed to display applicant details)
CREATE POLICY worker_profiles_employer_read
  ON worker_profiles FOR SELECT
  USING ((SELECT user_type FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)) = 'employer');

-- ============================================================
-- VERIFICATION — run after applying (connect as jale_admin):
--
-- 1. Employer sees only their own jobs:
--   BEGIN;
--   SELECT set_config('app.current_user_id', '<employer_cognito_sub>', true);
--   SELECT * FROM jobs;             -- must return only this employer's jobs
--   SELECT * FROM job_applications; -- must return only applications to their jobs
--   COMMIT;
--
-- 2. Worker sees only their own applications:
--   BEGIN;
--   SELECT set_config('app.current_user_id', '<worker_cognito_sub>', true);
--   SELECT * FROM job_applications; -- must return only this worker's applications
--   COMMIT;
-- ============================================================
