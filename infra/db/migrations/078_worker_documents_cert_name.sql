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
--                                         CHECK does not read it. MAX_CERTIFICATION_LENGTH
--                                         is also module-private (not exported)
--                                         -- keep the two numbers in sync by
--                                         hand, same caveat 073/074 already
--                                         document for their own hand-synced
--                                         allowlists; nothing enforces it.
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
--   1. Total-per-slot cap, RAISED from 5 (075) to 20 HERE: same query, same
--      RAISE ... USING ERRCODE = '23514', CONSTRAINT = 'certification_document_limit'
--      -- byte-identical code/constraint, only the threshold and message
--      text change. infra/lambda/api/worker-doc-confirm.ts and
--      worker-doc-confirm-auth.ts both key off this EXACT (code, constraint)
--      pair (`pgErr.code === '23514' && pgErr.constraint === 'certification_document_limit'`)
--      to turn the DB-level rejection into a graceful 409 -- changing either
--      of those two values would silently turn that 409 into an unhandled
--      500, so they stay byte-for-byte identical even though the number
--      moved.
--
--      WHY 20, NOT 5 (product decision): the per-cert-proof feature this
--      sprint ships lets a job require several distinct certifications, each
--      of which may need multiple files (front/back of a card, a multi-page
--      license) -- "3 proof-required certs x 2 files each" is a normal case
--      that a hard cap of 5 would reject outright. 20 gives real headroom
--      per slot while the per-name cap below keeps any single label bounded.
--      This also mitigates a latent bug in
--      infra/lambda/lib/applications.ts's copyRequiredDocumentSnapshots
--      (cert branch, ~lines 79-98): it dedupes snapshot copies by s3_key but
--      never deletes, so vault churn followed by a re-apply can grow a
--      per-job slot's row count over time; at the old cap of 5 that path
--      could abort the whole apply transaction mid-flight, at 20 there is
--      far more headroom before that pre-existing issue becomes
--      user-visible. That lambda bug itself is untouched here -- it lives in
--      code this migration does not own.
--
--   2. Per-name cap, still 5, NOW INDEPENDENTLY REACHABLE: the same scope,
--      plus cert_name IS NOT DISTINCT FROM NEW.cert_name. A genuinely new
--      failure mode (no lambda code today anticipates "too many files under
--      this same label"), so it deliberately raises a DIFFERENT constraint
--      name -- 'certification_document_name_limit' -- rather than reusing
--      'certification_document_limit'. Reusing the old name would make the
--      lambda's exact-match handler mislabel a per-name rejection as a
--      per-slot one in its response body.
--
--      REACHABILITY now that the two thresholds diverge (20 total vs 5
--      per-name): existing_name_count can independently reach 5 while
--      existing_count is still well under 20 -- e.g. 5 files all named
--      'OSHA 30' in an otherwise-empty slot. The per-name cap is now the
--      BINDING limit for a same-name flood; the total cap only binds once a
--      slot holds >=20 rows spread across distinct names. Verified
--      empirically against a live Postgres 16 instance: (a) 5 rows under one
--      cert_name, a 6th under that same name -> rejected with
--      certification_document_name_limit; (b) 6 rows under 6 distinct names
--      -> all succeed (the old cap of 5 no longer binds once names differ);
--      (c) a slot filled to 20 rows across distinct names -> the 21st is
--      rejected with certification_document_limit regardless of its name.
--
--      NULL-GROUPING SEMANTIC: cert_name is nullable, and
--      cert_name IS NOT DISTINCT FROM NEW.cert_name groups NULL with NULL --
--      every unlabeled certification_doc row in a slot (every legacy row,
--      and any future upload that omits a label) counts toward ONE shared
--      "name" bucket. So 5 unlabeled files already in a slot block a 6th
--      unlabeled insert via certification_document_name_limit -- verified
--      empirically: 5 rows with cert_name NULL, a 6th with cert_name NULL,
--      rejected with certification_document_name_limit. Unlabeled uploads
--      therefore keep exactly the old 075 ceiling of 5; only distinctly-
--      named uploads get the new headroom up to 20.
--
--      WHY THIS SHIPS NO PRODUCTION BEHAVIOR CHANGE YET: both confirm
--      lambdas (worker-doc-confirm.ts, worker-doc-confirm-auth.ts)
--      pre-check the slot's total count against
--      MAX_CERTIFICATION_FILES = 5 (infra/lambda/lib/job-fields.ts) BEFORE
--      ever attempting the insert, and that constant is untouched here --
--      job-fields.ts and the lambdas belong to other tasks. So today no call
--      path can push a slot past 5 total regardless of naming: this
--      migration raises the DB-level ceiling and gives the per-name cap
--      independent teeth, but the app layer still stops everyone at 5
--      first, and certification_document_name_limit has no lambda mapping
--      yet. Wave 2 is expected to raise MAX_CERTIFICATION_FILES to 20, add a
--      certification_document_name_limit catch mapping alongside the
--      existing certification_document_limit one, and make cert_name
--      mandatory on certification uploads -- all in the release that
--      actually turns this DB headroom into the per-cert-proof feature.
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
  -- Total-per-slot cap: same query and same error code/constraint as 075,
  -- threshold raised from 5 to 20 here -- see header for why.
  SELECT count(*) INTO existing_count
  FROM worker_documents
  WHERE worker_id = NEW.worker_id
    AND doc_type = 'certification_doc'
    AND job_id IS NOT DISTINCT FROM NEW.job_id;

  IF existing_count >= 20 THEN
    RAISE EXCEPTION 'certification document limit reached for this slot (max 20)'
      USING ERRCODE = '23514',
            CONSTRAINT = 'certification_document_limit';
  END IF;

  -- Per-name cap: same slot scope, plus the same cert_name. A distinct
  -- constraint name on purpose -- see header for the lambda-compatibility
  -- rationale. Now that the total cap is 20 while this stays 5, this branch
  -- is INDEPENDENTLY REACHABLE and is the binding limit for a same-name
  -- flood (including the all-NULL/unlabeled bucket -- see header's
  -- NULL-GROUPING SEMANTIC section). See header REACHABILITY section for
  -- the full empirical verification.
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
  -- edit that silently drops one cap while "fixing" the other. Now that the
  -- two thresholds diverge (20 total vs 5 per-name) and both matter, pin the
  -- exact numbers too, so a future edit that silently changes either cap
  -- (e.g. reverting the total back to 5, or quietly raising the per-name cap)
  -- fails loudly here instead of drifting unnoticed.
  SELECT pg_get_functiondef(p.oid) INTO src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'enforce_certification_document_limit';

  IF src IS NULL
     OR src NOT ILIKE '%certification_document_limit%'
     OR src NOT ILIKE '%certification_document_name_limit%'
     OR src NOT ILIKE '%cert_name IS NOT DISTINCT FROM NEW.cert_name%'
     OR src NOT ILIKE '%job_id IS NOT DISTINCT FROM NEW.job_id%'
     OR src NOT ILIKE '%existing_count >= 20%'
     OR src NOT ILIKE '%existing_name_count >= 5%'
  THEN
    RAISE EXCEPTION 'enforce_certification_document_limit missing one of the total-cap/name-cap scopes or has drifted off its pinned thresholds (total>=20, per-name>=5): %', COALESCE(src, '<absent>');
  END IF;
END;
$$;

COMMIT;
