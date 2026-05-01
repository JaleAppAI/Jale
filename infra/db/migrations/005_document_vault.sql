-- ============================================================
-- 005_document_vault.sql
-- Run manually AFTER 004_whatsapp.sql
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

-- Add required_docs column to jobs
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS required_docs TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE jobs
  ADD CONSTRAINT jobs_required_docs_valid
  CHECK (required_docs <@ ARRAY['resume', 'driver_license', 'ssn']::text[]);

-- Upload tokens table (used to authenticate worker upload page)
CREATE TABLE IF NOT EXISTS document_upload_tokens (
  token_hash  TEXT PRIMARY KEY,
  worker_id   UUID NOT NULL REFERENCES users(id),
  job_id      UUID NOT NULL REFERENCES jobs(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false
);

-- Worker documents metadata table
CREATE TABLE IF NOT EXISTS worker_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id   UUID NOT NULL REFERENCES users(id),
  job_id      UUID NOT NULL REFERENCES jobs(id),
  doc_type    TEXT NOT NULL CHECK (doc_type IN ('resume', 'driver_license', 'ssn')),
  s3_key      TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  file_size   INTEGER NOT NULL,
  mime_type   TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (worker_id, job_id, doc_type)
);

-- Grants
GRANT SELECT, INSERT, UPDATE ON document_upload_tokens TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON worker_documents TO jale_admin;

-- RLS policies for worker_documents
ALTER TABLE worker_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_documents FORCE ROW LEVEL SECURITY;

-- Workers can read/insert their own documents.
-- Worker endpoints authenticate via token and set app.current_internal_user_id
-- to the worker's internal users.id UUID. app.current_user_id is reserved for
-- Cognito sub values.
CREATE POLICY worker_documents_worker_select ON worker_documents
  FOR SELECT USING (worker_id::text = current_setting('app.current_internal_user_id', true));

CREATE POLICY worker_documents_worker_insert ON worker_documents
  FOR INSERT WITH CHECK (worker_id::text = current_setting('app.current_internal_user_id', true));

-- Employers can read documents for workers who applied to their jobs.
-- Employer endpoints use the existing convention: app.current_user_id = cognito_sub.
CREATE POLICY worker_documents_employer_select ON worker_documents
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = job_id
        AND j.employer_id = (
          SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)
        )
    )
  );
