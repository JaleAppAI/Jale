-- ============================================================
-- 007_worker_marketplace.sql
-- Run manually AFTER 006_trust_signal_layer.sql
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

-- ── worker_documents: vault semantics ──────────────────────────
-- A NULL job_id row is a "vault" doc owned by the worker, usable
-- across any application. A non-NULL row is a per-job snapshot
-- (existing tokenized flow, or a copy made at apply-time).
ALTER TABLE worker_documents ALTER COLUMN job_id DROP NOT NULL;

ALTER TABLE worker_documents
  DROP CONSTRAINT IF EXISTS worker_documents_worker_id_job_id_doc_type_key;

-- Vault slot: at most one row per (worker, doc_type) where job_id IS NULL.
CREATE UNIQUE INDEX IF NOT EXISTS worker_documents_vault_unique
  ON worker_documents (worker_id, doc_type)
  WHERE job_id IS NULL;

-- Per-job slot: at most one row per (worker, job, doc_type) where job_id IS NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS worker_documents_per_job_unique
  ON worker_documents (worker_id, job_id, doc_type)
  WHERE job_id IS NOT NULL;

-- ── jobs: worker read-active policy ────────────────────────────
CREATE POLICY jobs_worker_read_active ON jobs FOR SELECT
  USING (
    status = 'active'
    AND (SELECT user_type FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)) = 'worker'
  );

-- ── Index for My Applications list ─────────────────────────────
CREATE INDEX IF NOT EXISTS idx_job_applications_worker_applied
  ON job_applications(worker_id, applied_at DESC);

-- ============================================================
-- VERIFICATION — run after applying (connect as jale_admin):
--
-- 1. Worker sees active jobs globally:
--   BEGIN;
--   SELECT set_config('app.current_user_id', '<worker_cognito_sub>', true);
--   SELECT count(*) FROM jobs;  -- should equal count of all active jobs
--   COMMIT;
--
-- 2. Vault partial index works:
--   INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
--     VALUES ('<worker_uuid>', NULL, 'resume', 'k1', 'cv.pdf', 100, 'application/pdf');
--   -- Second insert with same (worker_id, doc_type, NULL) must fail:
--   INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
--     VALUES ('<worker_uuid>', NULL, 'resume', 'k2', 'cv2.pdf', 200, 'application/pdf');
-- ============================================================
