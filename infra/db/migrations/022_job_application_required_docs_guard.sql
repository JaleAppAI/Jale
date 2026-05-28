-- ============================================================
-- 022_job_application_required_docs_guard.sql
-- Run manually AFTER 021_whatsapp_required_docs_apply_support.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Block direct job application inserts when required docs are missing.
-- Docs may be present in the worker vault or as same-job snapshots.
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_job_application_required_docs()
RETURNS TRIGGER AS $$
DECLARE
  missing_docs TEXT[];
BEGIN
  SELECT COALESCE(array_agg(required_doc ORDER BY required_doc), ARRAY[]::text[])
  INTO missing_docs
  FROM unnest((
    SELECT COALESCE(required_docs, ARRAY[]::text[])
    FROM jobs
    WHERE id = NEW.job_id
  )) AS required_doc
  WHERE NOT EXISTS (
    SELECT 1
    FROM worker_documents wd
    WHERE wd.worker_id = NEW.worker_id
      AND wd.doc_type = required_doc
      AND (wd.job_id IS NULL OR wd.job_id = NEW.job_id)
  );

  IF COALESCE(array_length(missing_docs, 1), 0) > 0 THEN
    RAISE EXCEPTION 'missing required documents: %', array_to_string(missing_docs, ',')
      USING ERRCODE = '23514',
            CONSTRAINT = 'job_applications_required_docs_check';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_applications_required_docs_guard ON job_applications;

CREATE TRIGGER job_applications_required_docs_guard
  BEFORE INSERT ON job_applications
  FOR EACH ROW EXECUTE FUNCTION enforce_job_application_required_docs();
