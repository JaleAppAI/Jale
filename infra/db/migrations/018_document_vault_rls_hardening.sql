-- ============================================================
-- 018_document_vault_rls_hardening.sql
-- Run manually AFTER 017_document_upload_token_hardening.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Harden worker document vault RLS:
-- - worker vault mutations use app.current_internal_user_id
-- - employer reads require a matching job application relationship
-- ============================================================

ALTER TABLE worker_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_documents FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON worker_documents TO jale_admin;

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'worker_documents'
      AND policyname = 'worker_documents_worker_delete'
  ) THEN
    CREATE POLICY worker_documents_worker_delete ON worker_documents
      FOR DELETE
      USING (worker_id::text = current_setting('app.current_internal_user_id', true));
  END IF;
END;
$$;

DROP POLICY IF EXISTS worker_documents_employer_select ON worker_documents;

CREATE POLICY worker_documents_employer_select ON worker_documents
  FOR SELECT USING (
    worker_documents.job_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM job_applications ja
      JOIN jobs j ON j.id = ja.job_id
      WHERE ja.worker_id = worker_documents.worker_id
        AND ja.job_id = worker_documents.job_id
        AND j.employer_id = (
          SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)
        )
    )
  );
