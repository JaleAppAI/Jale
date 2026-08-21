-- 077_whatsapp_application_fill.sql
-- WhatsApp application-fill flow (spec: docs/superpowers/specs/
-- 2026-08-19-whatsapp-application-fill-design.md §5).
-- 1. jale_whatsapp gains DELETE on worker_documents: the fill's doc write is
--    DELETE-then-INSERT (mirrors worker-doc-confirm.ts; ON CONFLICT arbiters
--    stopped matching in 007/075). The worker-scoped RLS DELETE policy from
--    018 already applies (no TO clause) — no policy changes.
-- 2. The 022 required-docs INSERT guard learns a session GUC bypass so the
--    WhatsApp accept can create the application BEFORE docs are collected.
--    Every other writer keeps the guard.
--
-- Run AFTER 076_ai_extraction_asr_metadata.sql, connected as jale_admin (NOT
-- the RDS master user). Forward-only (ADR-005).

BEGIN;

GRANT DELETE ON worker_documents TO jale_whatsapp;

-- Recreate the 022 trigger function with the GUC gate. Function body copied
-- verbatim from 022_job_application_required_docs_guard.sql, with only the
-- guard clause added as the first statement. CREATE OR REPLACE FUNCTION
-- keeps the existing job_applications_required_docs_guard trigger binding.
CREATE OR REPLACE FUNCTION enforce_job_application_required_docs()
RETURNS TRIGGER AS $$
DECLARE
  missing_docs TEXT[];
BEGIN
  IF current_setting('app.allow_incomplete_docs', true) = 'on' THEN
    RETURN NEW;
  END IF;

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

-- ── self-verification (073 pattern) ─────────────────────────────
DO $$
DECLARE
  has_delete boolean;
  fn_src text;
BEGIN
  SELECT has_table_privilege('jale_whatsapp', 'worker_documents', 'DELETE')
    INTO has_delete;
  IF NOT has_delete THEN
    RAISE EXCEPTION 'jale_whatsapp DELETE grant on worker_documents missing';
  END IF;

  SELECT prosrc INTO fn_src FROM pg_proc
   WHERE proname = 'enforce_job_application_required_docs';
  IF fn_src IS NULL OR fn_src NOT ILIKE '%allow_incomplete_docs%' THEN
    RAISE EXCEPTION 'required-docs guard missing GUC bypass: %', COALESCE(left(fn_src, 80), '<absent>');
  END IF;
END $$;

COMMIT;
