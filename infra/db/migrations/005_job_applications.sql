-- ============================================================
-- 005_job_applications.sql
-- Run manually AFTER 004_jobs.sql
-- Connect as: jale_admin (RDS master)
--
-- Purpose: Record worker applications to jobs. Each row represents a
-- worker accepting a job alert ("✅ Aceptar" button on jale_job_alert_*).
--
-- Design notes:
--   - job_id references jobs(id) so employers (future V1.5 query path)
--     can SELECT applications WHERE job_id IN (their jobs).
--   - user_id references users(id) so we can surface the worker's profile
--     + contact info to the employer.
--   - UNIQUE(job_id, user_id) prevents duplicate applications from
--     double-tap or SQS retry. The processor uses ON CONFLICT DO NOTHING
--     so a duplicate tap yields the same "Application sent!" reply without
--     error.
--   - status enum keeps future states (viewed, contacted, hired) cheap
--     to add without migration — Start with 'submitted' for V1.
-- ============================================================

CREATE TABLE job_applications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    -- ON DELETE RESTRICT so a stray DELETE on users cannot silently wipe
    -- job application history (originally enforced via 006 §B ALTER, folded
    -- into this definition on 2026-04-20 since 005 is undeployed).
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status      TEXT NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('submitted', 'viewed', 'contacted', 'hired', 'rejected')),
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, user_id)
);

-- Indexes to support employer queries (WHERE job_id = ?) and worker queries (WHERE user_id = ?)
CREATE INDEX idx_job_app_job  ON job_applications(job_id);
CREATE INDEX idx_job_app_user ON job_applications(user_id);
CREATE INDEX idx_job_app_status_submitted
    ON job_applications(job_id, applied_at DESC)
    WHERE status = 'submitted';

-- ──────────────────────────────────────────────────────────────
-- Grants
-- ──────────────────────────────────────────────────────────────

-- jale_admin: full access (employer Lambdas will query here in V1.5)
GRANT ALL ON job_applications TO jale_admin;

-- jale_whatsapp: INSERT only (worker accepts a job → new row).
-- SELECT is needed for the ON CONFLICT DO NOTHING idempotency check —
-- Postgres requires SELECT privilege on the target table's UNIQUE index
-- columns for the ON CONFLICT evaluation. Grant at column level to keep
-- the role tightly scoped.
GRANT INSERT, SELECT ON job_applications TO jale_whatsapp;

-- ──────────────────────────────────────────────────────────────
-- RLS
-- ──────────────────────────────────────────────────────────────

ALTER TABLE job_applications ENABLE ROW LEVEL SECURITY;

-- jale_whatsapp: can INSERT + SELECT any application (needed for the
-- cross-user ON CONFLICT check during accept handling).
CREATE POLICY jobapp_whatsapp_all ON job_applications
    FOR ALL TO jale_whatsapp USING (true) WITH CHECK (true);

-- jale_admin: user-scoped read/write (future V1.5 employer path would
-- SELECT applications for jobs the employer owns — for now just per-user).
CREATE POLICY jobapp_admin_user ON job_applications
    FOR ALL TO jale_admin
    USING (user_id = (SELECT id FROM users
                      WHERE cognito_sub = current_setting('app.current_user_id', true)));

-- ──────────────────────────────────────────────────────────────
-- Future V1.5 note
-- ──────────────────────────────────────────────────────────────
-- To let an employer see applications for their jobs, add a
-- posted_by_user_id column to jobs + an employer-scoped RLS policy on
-- job_applications that joins through jobs.posted_by_user_id. Not in V1.
