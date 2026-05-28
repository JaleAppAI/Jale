-- ============================================================
-- 017_document_upload_token_hardening.sql
-- Run manually AFTER 016_employer_profiles.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Harden tokenized document uploads by binding each presigned
-- upload to a server-issued per-document slot.
-- ============================================================

ALTER TABLE document_upload_tokens
  ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

ALTER TABLE worker_documents
  ADD COLUMN IF NOT EXISTS s3_version_id TEXT;

CREATE TABLE IF NOT EXISTS document_upload_token_slots (
  token_hash         TEXT NOT NULL REFERENCES document_upload_tokens(token_hash) ON DELETE CASCADE,
  doc_type           TEXT NOT NULL CHECK (doc_type IN ('resume', 'driver_license', 'ssn')),
  issued_s3_key      TEXT NOT NULL,
  expected_mime_type TEXT NOT NULL CHECK (expected_mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  max_file_size      INTEGER NOT NULL CHECK (max_file_size > 0),
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at       TIMESTAMPTZ,
  s3_version_id      TEXT,
  PRIMARY KEY (token_hash, doc_type),
  UNIQUE (issued_s3_key)
);

CREATE INDEX IF NOT EXISTS document_upload_token_slots_token_idx
  ON document_upload_token_slots(token_hash);

CREATE INDEX IF NOT EXISTS document_upload_token_slots_confirmed_idx
  ON document_upload_token_slots(token_hash, confirmed_at);

GRANT SELECT, INSERT, UPDATE ON document_upload_token_slots TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON document_upload_tokens TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON worker_documents TO jale_admin;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'worker_documents'
      AND policyname = 'worker_documents_worker_update'
  ) THEN
    CREATE POLICY worker_documents_worker_update ON worker_documents
      FOR UPDATE
      USING (worker_id::text = current_setting('app.current_internal_user_id', true))
      WITH CHECK (worker_id::text = current_setting('app.current_internal_user_id', true));
  END IF;
END;
$$;
