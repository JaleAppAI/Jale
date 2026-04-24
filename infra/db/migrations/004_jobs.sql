-- ============================================================
-- 004_jobs.sql
-- Run manually AFTER 003_whatsapp.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Creates a minimal jobs table for the Job Alert Sender Lambda.
-- V1: basic columns only. Expand with description, requirements,
-- start_date, contact info, etc. when the job posting flow exists.
-- ============================================================

CREATE TABLE jobs (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title      TEXT NOT NULL,
    company    TEXT NOT NULL,
    location   TEXT NOT NULL,
    pay        TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- jale_whatsapp: read-only (queries jobs to send alerts)
GRANT SELECT ON jobs TO jale_whatsapp;

-- jale_admin: full access (for future job posting endpoints)
GRANT ALL ON jobs TO jale_admin;

-- RLS: jale_whatsapp can read all jobs, jale_admin can do everything
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY jobs_read_wa ON jobs
    FOR SELECT TO jale_whatsapp USING (true);

CREATE POLICY jobs_admin ON jobs
    FOR ALL TO jale_admin USING (true);

-- ============================================================
-- VERIFICATION — run after applying:
--   \d jobs
--   SET ROLE jale_whatsapp;
--   SELECT * FROM jobs;  -- should work (empty table)
--   INSERT INTO jobs (title, company, location, pay)
--     VALUES ('test', 'test', 'test', 'test');  -- must fail (no INSERT grant)
--   RESET ROLE;
-- ============================================================
