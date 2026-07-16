-- 035_job_delete_grants.sql
-- Enable employer hard-delete of a job.
--
-- Two things are required, not one:
--   1. DELETE grants — jale_admin had only SELECT/INSERT/UPDATE on jobs (003),
--      job_conversations (025), and document_upload_tokens (005/017).
--   2. FOR DELETE RLS policies — jobs, worker_documents, and job_conversations are all
--      FORCE ROW LEVEL SECURITY. Under FORCE RLS a DELETE with no permissive DELETE
--      policy silently matches 0 rows, so a grant alone is not enough. These policies
--      key on app.current_user_id (the Cognito sub the delete Lambda sets via
--      setRlsContext), mirroring jobs_employer_update (003).
--
-- worker_documents already has a DELETE grant (018); document_upload_tokens has no RLS
-- enabled, so it needs only the grant. job_applications and the matching tables delete
-- via ON DELETE CASCADE (owner rights, RLS-exempt) and need nothing here.
BEGIN;

GRANT DELETE ON jobs                   TO jale_admin;
GRANT DELETE ON job_conversations      TO jale_admin;
GRANT DELETE ON document_upload_tokens TO jale_admin;

-- DROP … IF EXISTS before CREATE so this migration is safely re-runnable (matches 018).
DROP POLICY IF EXISTS jobs_employer_delete ON jobs;
CREATE POLICY jobs_employer_delete ON jobs FOR DELETE
  USING (employer_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)));

-- worker_documents has no employer_id column, so ownership is checked through jobs.
DROP POLICY IF EXISTS worker_documents_employer_delete ON worker_documents;
CREATE POLICY worker_documents_employer_delete ON worker_documents FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.id = worker_documents.job_id
      AND j.employer_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true))));

-- job_conversations carries employer_id directly (025).
DROP POLICY IF EXISTS job_conversations_employer_delete ON job_conversations;
CREATE POLICY job_conversations_employer_delete ON job_conversations FOR DELETE
  USING (employer_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)));

COMMIT;
