-- 075_worker_documents_multi_certification.sql
-- Workers may now upload multiple certification_doc files per slot (vault or
-- per-job), instead of the single-file-per-(worker, doc_type[, job_id]) rule
-- that has applied to every doc_type since 007_worker_marketplace.sql. All
-- other doc_types stay one-per-slot.
--
-- Tightens the two partial-unique indexes from 007 by excluding
-- doc_type = 'certification_doc' from their predicates, and adds a
-- defense-in-depth BEFORE INSERT trigger (mirroring the guard style of
-- 022_job_application_required_docs_guard.sql) that caps certification_doc
-- rows per slot at 5 -- the app layer's MAX_CERTIFICATION_FILES
-- (infra/lambda/lib/job-fields.ts) is the primary enforcement point; this is
-- a backstop for direct inserts.
--
-- ============================================================
-- DEPLOY ORDER -- OPPOSITE of 073_job_application_requirements.sql:
-- Deploy this migration ONLY AFTER the lambda rollout that reworks
-- worker-doc-confirm.ts away from ON CONFLICT arbiter inference. That
-- handler currently does:
--   ON CONFLICT (worker_id, job_id, doc_type) WHERE job_id IS NOT NULL
--     DO UPDATE ...
-- Once worker_documents_per_job_unique's predicate gains
-- "AND doc_type <> 'certification_doc'", that ON CONFLICT clause no longer
-- matches the index for certification_doc rows (arbiter inference requires
-- an exact predicate match) and inserts for certification_doc will start
-- raising "no unique or exclusion constraint matching the ON CONFLICT
-- specification". The lambda must stop relying on that arbiter -- e.g. by
-- branching to a plain INSERT for certification_doc -- BEFORE this
-- migration runs.
--
-- lib/applications.ts also writes worker_documents via
-- "INSERT ... ON CONFLICT DO NOTHING" (no conflict target), which performs
-- no arbiter inference and is unaffected by either index's predicate --
-- checked, not missed. worker-doc-confirm.ts is the only call site with a
-- targeted arbiter naming these columns.
-- ============================================================
--
-- Run AFTER 073_job_application_requirements.sql (and after the lambda
-- rollout described above), connected as jale_admin (NOT the RDS master
-- user). Forward-only (ADR-005).

BEGIN;

-- ── 1. Tighten the vault/per-job unique indexes ─────────────────
DROP INDEX IF EXISTS worker_documents_vault_unique;
DROP INDEX IF EXISTS worker_documents_per_job_unique;

-- Vault slot: at most one row per (worker, doc_type) where job_id IS NULL,
-- EXCEPT certification_doc, which may have many.
CREATE UNIQUE INDEX worker_documents_vault_unique
  ON worker_documents (worker_id, doc_type)
  WHERE job_id IS NULL AND doc_type <> 'certification_doc';

-- Per-job slot: at most one row per (worker, job, doc_type) where
-- job_id IS NOT NULL, EXCEPT certification_doc, which may have many.
CREATE UNIQUE INDEX worker_documents_per_job_unique
  ON worker_documents (worker_id, job_id, doc_type)
  WHERE job_id IS NOT NULL AND doc_type <> 'certification_doc';

-- ── 2. Defense-in-depth cap on certification_doc rows per slot ──
-- "Same slot" means: the vault slot (job_id IS NULL) shared across all
-- applications, or the same per-job slot (job_id = NEW.job_id).
-- IS NOT DISTINCT FROM handles both the NULL=NULL vault comparison and the
-- equal-non-null per-job comparison in one clause.
--
-- NOTE: worker_documents is FORCE ROW LEVEL SECURITY (005), and this
-- function runs with invoker rights, so the COUNT below is RLS-scoped to
-- rows visible under the inserting session's app.current_internal_user_id
-- (normally just the worker's own rows, which is what we want to count).
-- On a hypothetical insert path where that setting is unset, the count
-- reads 0 and the cap does not fire -- the same exposure already accepted
-- by 022_job_application_required_docs_guard.sql's trigger, which this one
-- deliberately mirrors rather than redesigns.
CREATE OR REPLACE FUNCTION enforce_certification_document_limit()
RETURNS TRIGGER AS $$
DECLARE
  existing_count INTEGER;
BEGIN
  SELECT count(*) INTO existing_count
  FROM worker_documents
  WHERE worker_id = NEW.worker_id
    AND doc_type = 'certification_doc'
    AND job_id IS NOT DISTINCT FROM NEW.job_id;

  IF existing_count >= 5 THEN
    RAISE EXCEPTION 'certification document limit reached for this slot (max 5)'
      USING ERRCODE = '23514',
            CONSTRAINT = 'certification_document_limit';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS worker_documents_certification_limit_guard ON worker_documents;

CREATE TRIGGER worker_documents_certification_limit_guard
  BEFORE INSERT ON worker_documents
  FOR EACH ROW
  WHEN (NEW.doc_type = 'certification_doc')
  EXECUTE FUNCTION enforce_certification_document_limit();

-- ── 3. Verification ──────────────────────────────────────────────
DO $$
DECLARE
  vault_def TEXT;
  per_job_def TEXT;
BEGIN
  SELECT indexdef INTO vault_def
  FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'worker_documents_vault_unique';
  IF vault_def IS NULL OR vault_def NOT ILIKE '%doc_type <> ''certification_doc''%' THEN
    RAISE EXCEPTION 'worker_documents_vault_unique missing or not tightened: %', COALESCE(vault_def, '<absent>');
  END IF;

  SELECT indexdef INTO per_job_def
  FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'worker_documents_per_job_unique';
  IF per_job_def IS NULL OR per_job_def NOT ILIKE '%doc_type <> ''certification_doc''%' THEN
    RAISE EXCEPTION 'worker_documents_per_job_unique missing or not tightened: %', COALESCE(per_job_def, '<absent>');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class rel ON rel.oid = t.tgrelid
    WHERE rel.relname = 'worker_documents'
      AND t.tgname = 'worker_documents_certification_limit_guard'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'worker_documents_certification_limit_guard trigger missing';
  END IF;
END;
$$;

COMMIT;
