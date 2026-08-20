-- 078_worker_documents_cert_name.sql
-- Job-flow redesign (BE-T1): lets a worker label each certification_doc
-- upload with a human-readable name (e.g. "OSHA 30", "Forklift cert"), so
-- the multi-file certification slot introduced in
-- 075_worker_documents_multi_certification.sql can show which file is which
-- instead of an undifferentiated pile of five uploads.
--
-- Adds worker_documents.cert_name (nullable TEXT, no default -- NULL means
-- "no label supplied", not an app-layer-normalized value) with two CHECKs:
--   worker_documents_cert_name_valid   -- cert_name is only meaningful on
--                                         certification_doc rows; every other
--                                         doc_type must leave it NULL.
--   worker_documents_cert_name_length  -- <=200 chars, matching the existing
--                                         MAX_CERTIFICATION_LENGTH bound used
--                                         for jobs.certifications entries
--                                         (job-fields.ts) for consistency,
--                                         though that is an app-layer const
--                                         for a different column and this
--                                         CHECK does not read it.
--
-- NO new unique index on (worker_id, job_id, doc_type, cert_name) or similar:
-- 075's entire point was that a worker may hold multiple certification_doc
-- files per slot, and a worker may legitimately upload two files under the
-- same cert_name (e.g. front/back of one card, or a renewed duplicate before
-- the old one is deleted). Uniqueness here would silently reintroduce the
-- one-per-slot constraint 075 removed, just keyed on a different column.
--
-- ============================================================
-- WIDENING THE 075 TRIGGER: enforce_certification_document_limit()
-- ============================================================
-- CREATE OR REPLACE, not DROP/CREATE: the trigger binding itself
-- (worker_documents_certification_limit_guard, including its
-- WHEN (NEW.doc_type = 'certification_doc') clause) lives on the CREATE
-- TRIGGER statement, not on the function body, and is left completely alone
-- here -- same "replace the function, never touch the trigger" precedent as
-- 029_hired_count_trigger_security_definer.sql.
--
-- The replaced function now enforces TWO caps, both scoped the same way
-- 075 already scoped its single cap -- worker_id + doc_type =
-- 'certification_doc' + job_id IS NOT DISTINCT FROM NEW.job_id (the vault
-- slot when NULL, or the same per-job slot when not):
--
--   1. Total-per-slot cap of 5 (unchanged from 075: same query, same
--      RAISE ... USING ERRCODE = '23514', CONSTRAINT = 'certification_document_limit').
--      infra/lambda/api/worker-doc-confirm.ts and worker-doc-confirm-auth.ts
--      both key off this EXACT (code, constraint) pair
--      (`pgErr.code === '23514' && pgErr.constraint === 'certification_document_limit'`)
--      to turn the DB-level rejection into a graceful 409. Changing this
--      RAISE's ERRCODE or CONSTRAINT value would silently turn that 409 into
--      an unhandled 500 -- left byte-for-byte identical on purpose.
--   2. NEW per-name cap of 5: the same scope, plus
--      cert_name IS NOT DISTINCT FROM NEW.cert_name. This is a genuinely new
--      failure mode (no lambda code today anticipates "too many files under
--      this same label"), so it deliberately raises a DIFFERENT constraint
--      name -- 'certification_document_name_limit' -- rather than reusing
--      'certification_document_limit'. Reusing the old name would make the
--      lambda's exact-match handler mislabel a per-name rejection as a
--      per-slot one in its response body.
--
--      REACHABILITY, verified empirically against a live Postgres 16
--      instance: with both caps set to 5 and the name-cap query being the
--      total-cap query plus one more AND clause, existing_name_count can
--      never exceed existing_count for the same candidate row. So the
--      total-cap RAISE (unchanged, #1 above) always fires no later than the
--      name-cap RAISE could -- this branch cannot be independently reached
--      today; five certification_doc rows in one slot trip the *total* cap
--      on the sixth insert regardless of what name it carries. This is not
--      dead code: it is structurally correct now and starts firing for real
--      the moment the two limits ever diverge (e.g. a future migration
--      raises the total-per-slot cap above 5 while leaving the per-name cap
--      at 5). Until then, a per-name-only rejection cannot occur, so the
--      "falls through to a generic 500" lambda-compatibility gap described
--      above for the new constraint name is currently theoretical, not
--      reachable in production as this migration ships. Kept anyway so the
--      cap is already correct in shape and semantics for the day the two
--      thresholds diverge, per the task's explicit request for both caps.
--
-- Both caps are TOCTOU races, not serialized caps -- same caveat 075 already
-- documents for the total cap: two concurrent inserts can each see
-- count = 4 and both proceed, landing at 6 (or 6-under-one-name). The
-- overshoot is bounded (at most one extra row per race), not unbounded, and
-- matches 075's accepted risk rather than introducing a new one.
--
-- jale_whatsapp already holds table-level SELECT, INSERT on worker_documents
-- (021_whatsapp_required_docs_apply_support.sql), so cert_name needs no grant
-- change for the WhatsApp side (Ivan's team can read/write it under the
-- existing grant as soon as their flow sends the column).
--
-- Run AFTER 077_jobs_structured_fields.sql, connected as jale_admin (NOT the
-- RDS master user). Forward-only (ADR-005).

BEGIN;

-- ── 1. New column ────────────────────────────────────────────────
ALTER TABLE worker_documents
  ADD COLUMN IF NOT EXISTS cert_name TEXT;

-- ── 2. CHECK constraints ─────────────────────────────────────────
ALTER TABLE worker_documents
  DROP CONSTRAINT IF EXISTS worker_documents_cert_name_valid;

ALTER TABLE worker_documents
  ADD CONSTRAINT worker_documents_cert_name_valid
  CHECK (cert_name IS NULL OR doc_type = 'certification_doc');

ALTER TABLE worker_documents
  DROP CONSTRAINT IF EXISTS worker_documents_cert_name_length;

ALTER TABLE worker_documents
  ADD CONSTRAINT worker_documents_cert_name_length
  CHECK (cert_name IS NULL OR char_length(cert_name) <= 200);

-- ── 3. Widen the 075 trigger function to also enforce a per-name cap ──
CREATE OR REPLACE FUNCTION enforce_certification_document_limit()
RETURNS TRIGGER AS $$
DECLARE
  existing_count INTEGER;
  existing_name_count INTEGER;
BEGIN
  -- Total-per-slot cap (unchanged from 075: same query, same error).
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

  -- Per-name cap (new): same slot scope, plus the same cert_name. A distinct
  -- constraint name on purpose -- see header for the lambda-compatibility
  -- rationale.
  --
  -- NOTE on reachability: this query is the total-cap query above with one
  -- extra AND clause, so existing_name_count <= existing_count always holds
  -- for the same inserted row. With both caps currently set to 5, that means
  -- existing_name_count >= 5 implies existing_count >= 5 too -- so the
  -- total-cap RAISE above always fires first, and this branch cannot be
  -- independently reached today (verified empirically: 5 rows under one
  -- cert_name in a slot already trips the total-cap error on the 6th
  -- insert, whatever name it uses). This is deliberate, not dead code: it is
  -- structurally correct and future-proofed the moment the two limits ever
  -- diverge (e.g. a later migration raises the total-per-slot cap above 5
  -- while leaving the per-name cap at 5), at which point this branch starts
  -- firing for real and produces the more specific error.
  SELECT count(*) INTO existing_name_count
  FROM worker_documents
  WHERE worker_id = NEW.worker_id
    AND doc_type = 'certification_doc'
    AND job_id IS NOT DISTINCT FROM NEW.job_id
    AND cert_name IS NOT DISTINCT FROM NEW.cert_name;

  IF existing_name_count >= 5 THEN
    RAISE EXCEPTION 'certification document limit reached for this name in this slot (max 5)'
      USING ERRCODE = '23514',
            CONSTRAINT = 'certification_document_name_limit';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger binding itself is untouched: no DROP TRIGGER, no CREATE TRIGGER.

-- ── 4. Verification ──────────────────────────────────────────────
DO $$
DECLARE
  def TEXT;
  src TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'worker_documents' AND c.conname = 'worker_documents_cert_name_valid' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%cert_name%'
     OR def NOT ILIKE '%certification_doc%'
  THEN
    RAISE EXCEPTION 'worker_documents_cert_name_valid CHECK missing or malformed: %', COALESCE(def, '<absent>');
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'worker_documents' AND c.conname = 'worker_documents_cert_name_length' AND c.contype = 'c';
  IF def IS NULL
     OR def NOT ILIKE '%cert_name%'
     OR def NOT ILIKE '%200%'
  THEN
    RAISE EXCEPTION 'worker_documents_cert_name_length CHECK missing or malformed: %', COALESCE(def, '<absent>');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'worker_documents' AND column_name = 'cert_name'
  ) THEN
    RAISE EXCEPTION 'worker_documents.cert_name column missing';
  END IF;

  -- The trigger binding must be unchanged from 075: same name, still present,
  -- still a real (non-internal) trigger.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class rel ON rel.oid = t.tgrelid
    WHERE rel.relname = 'worker_documents'
      AND t.tgname = 'worker_documents_certification_limit_guard'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'worker_documents_certification_limit_guard trigger missing (must not be dropped/recreated by this migration)';
  END IF;

  -- Both caps must still be present in the function body -- catches a future
  -- edit that silently drops one cap while "fixing" the other.
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'enforce_certification_document_limit';

  IF src IS NULL
     OR src NOT ILIKE '%certification_document_limit%'
     OR src NOT ILIKE '%certification_document_name_limit%'
     OR src NOT ILIKE '%cert_name IS NOT DISTINCT FROM NEW.cert_name%'
     OR src NOT ILIKE '%job_id IS NOT DISTINCT FROM NEW.job_id%'
  THEN
    RAISE EXCEPTION 'enforce_certification_document_limit missing one of the total-cap/name-cap scopes: %', COALESCE(src, '<absent>');
  END IF;
END;
$$;

COMMIT;
