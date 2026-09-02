-- ============================================================
-- 091_application_stages.sql
-- Run manually AFTER 090_email_outbox_delivery_metadata.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Forward-only (ADR-005). ONE transaction: every statement here is either
-- purely additive or a widening of an existing CHECK, so this file needs
-- neither of the two deferred-validation keywords 024 used across its two
-- transactions. 024 needed them because it NARROWED the status domain after
-- a data backfill; a WIDENED CHECK is satisfied by every pre-existing row by
-- construction, so a plain ADD CONSTRAINT with its immediate scan is correct
-- (and migrations.test.ts asserts neither keyword appears here).
--
-- ── DEPLOY ORDER: APPLY THIS MIGRATION *BEFORE* DEPLOYING THE CODE ──
-- Same rule as 090, opposite of 086. The sprint-23 application-stages code
-- writes the literal status 'details_requested' and SELECTs
-- pre_application_prompts / prompt_answers / details_requested_at /
-- details_completed_at unconditionally. Code-first is a 23514 on every
-- "Request details" click and a 42703 undefined_column on every job read.
-- Applying first is safe: nothing already deployed reads or writes any of
-- the objects below, the widened status CHECK admits everything the old one
-- did, and the one thing this migration REMOVES (the 022 INSERT guard
-- trigger) only ever rejected writes -- its absence cannot break a caller.
--
-- ── ONE EXCEPTION TO THAT ORDER: PART (g) ───────────────────────
-- Part (g) purges the AI-generated trade_questions cache rows that Amazon
-- Nova Lite produced. The Haiku question-generator code (all Bedrock usages
-- move from Amazon Nova Lite to Claude Haiku 4.5) ships in a SEPARATE infra
-- PR, and that PR MUST BE DEPLOYED BEFORE THIS FILE IS APPLIED. Applying the
-- purge while the Nova generator is still live simply regenerates Nova rows
-- on the next custom-trade cache miss, wasting the purge; there is no
-- correctness hazard either way, only a wasted window. So the release order
-- for this migration is:
--     1. deploy the Haiku question-generator PR
--     2. apply THIS file
--     3. deploy the application-stages code
-- Everything except part (g) is still strictly apply-before-code.
--
-- ── WHAT THIS MIGRATION SUPERSEDES ──────────────────────────────
-- 1. 081_whatsapp_application_defaults_read.sql deliberately granted
--    jale_whatsapp SELECT ONLY on worker_application_defaults and its own
--    DO block asserts that jale_whatsapp holds NEITHER INSERT NOR UPDATE,
--    with the header calling write-back "explicitly deferred ... a future
--    migration adds INSERT/UPDATE if/when write-back ships". THIS IS THAT
--    MIGRATION. Write-back now ships because sprint 23 moves
--    upsertWorkerApplicationDefaults inside the SHARED requirement engine
--    (infra/lambda/lib/application-requirements.ts), which runs as
--    jale_whatsapp for BOTH doors -- the web stage-2 door runs as
--    jale_whatsapp too, because job_applications has no worker UPDATE
--    policy for jale_admin (003/015/045 are employer-keyed; the only worker
--    UPDATE lane is 028's jobapp_whatsapp_update). 081's negative
--    assertions are therefore now WRONG BY DESIGN, and re-applying 081
--    AFTER this file would fail. 081 is committed and is NOT edited
--    (forward-only); the chain order 081 -> 091 keeps a fresh cluster clean.
--    Least-privilege is preserved by the row-scoped policy added below --
--    the grant alone still reaches zero rows without it (081's own RLS
--    analysis, which stays valid).
-- 2. 022_job_application_required_docs_guard.sql's BEFORE INSERT trigger
--    (and 080's GUC-bypass rewrite of its function body) enforced "every
--    required doc must already exist before an application row can be
--    created". The stage model inverts that premise: stage 1 (apply)
--    collects NOTHING from the requirement vocabulary, so EVERY application
--    is incomplete at INSERT time by design, on both doors. The guard is
--    replaced by an equivalent gate at the moment that actually matters --
--    the transition to 'hired' (part (e) below).
--    Only the TRIGGER is dropped here. enforce_job_application_required_docs()
--    and its `app.allow_incomplete_docs` GUC bypass are left in place (now
--    dead code) so a revert is one CREATE TRIGGER statement with no function
--    to restore; the FUNCTION drop is migration 092's cleanup job.
--
-- ── CONTENTS ────────────────────────────────────────────────────
-- (a) job_applications_status_check widened with 'details_requested'
--     (between 'talking' and 'hired'), plus the partial index that mirrors
--     024's idx_job_applications_status_talking / _hired pair.
-- (b) job_applications.details_requested_at / details_completed_at.
--     Nullable with no default: NULL is "this stage has not happened",
--     not a value the app normalizes away (077's posture). The stage-2
--     gates read these TIMESTAMPS, never the literal status, so an employer
--     moving details_requested -> contacted/talking keeps a half-finished
--     fill alive. details_requested_at is written ONLY by the employer
--     status handler (COALESCE(details_requested_at, now())) and
--     details_completed_at ONLY by the shared engine -- which is exactly
--     why part (f) grants jale_whatsapp the second column and NOT the first.
-- (c) jobs.pre_application_prompts: the employer's free-text stage-1
--     questions. UNLIKE 073/074/077, per-entry shape IS enforced in SQL
--     here, via an IMMUTABLE STRICT SQL function. The precedent break is
--     deliberate: certification_requirements' entries are written by ONE
--     handler behind parseJobFields, whereas prompt entries are echoed back
--     to workers verbatim on two doors and are keyed by an `id` that the
--     answer map (part (d)) references -- a duplicate or malformed id is a
--     silent data-integrity bug, not a display glitch. The bounds (<=10
--     prompts, id ^[A-Za-z0-9_-]{1,40}$, text 1..500 chars) are the SAME
--     single bound set the app layer uses (lib/pre-application-prompts.ts:
--     MAX_PRE_APPLICATION_PROMPTS / MAX_PROMPT_TEXT_LENGTH) -- keep both in
--     sync by hand, same standing instruction 073 carries for
--     REQUIRED_FIELD_TYPES.
-- (d) job_applications.prompt_answers: the worker's answers, keyed by
--     prompt id. A SEPARATE COLUMN, not a reserved key inside
--     application_answers: that keeps the 16 KB application_answers cap
--     (MAX_ANSWERS_JSON_LENGTH) and every existing
--     Object.keys(application_answers) reader untouched, and makes
--     write-once a single SQL expression ($1::jsonb || prompt_answers,
--     where the EXISTING value wins). Only the outer shape and a byte cap
--     are enforced (12288 -- deliberately under application_answers' 16384,
--     since prompts are capped at 10 x 1000-char answers plus keys).
-- (e) The hire gate: a BEFORE UPDATE OF status trigger that refuses the
--     transition to 'hired' while any required field, required doc or
--     required-tier certification claim is missing. See the long note above
--     the function for the three decisions that shape it (invoker rights,
--     job-scoped docs only, fail-closed on an unreadable job).
-- (f) Grants: the two column UPDATEs on job_applications for jale_whatsapp,
--     and 081's deferred write-back on worker_application_defaults.
-- (g) A trade_questions cache purge for the Nova -> Claude Haiku 4.5 model
--     switch (086 Part 4's precedent, narrowed to the Nova rows). See its own
--     note below for the DEPLOY-ORDER exception it carries.
-- (h) A terminal DO self-audit block. On RDS there is no Jest: this block is
--     the ONLY thing that verifies this migration in production, which is
--     why migrations.test.ts pins its literal strings.
--
-- ── REGISTRATION POINTS (five, plus one this file adds work to) ──
--   1  scripts/run-migrations.sh                              MIGRATIONS array
--   2  scripts/run-migrations.ps1                             $Migrations list
--   3  infra/test/unit/db/migrations.test.ts                   number sequence
--                                                             + content test
--   4  infra/test/unit/db/migrations/apply-order.test.ts       baseline list
--   5  infra/test/unit/scripts/run-migrations-sh.test.ts       compares (1) to
--      the on-disk directory. It extracts the list with
--      /\d{3}b?_[a-zA-Z0-9_]+\.sql/g over the whole block, so a COMMENT that
--      names a migration file inside that block reads as a list entry and
--      fails the comparison -- name numbers in prose there, never files.
--   +  infra/test/unit/scripts/run-whatsapp-v2-db-tests.test.ts pins the
--      fail-closed runner's suite array with toEqual, so this migration's new
--      real-DB suite is registered there as well as in the .sh itself.
--
-- Next free migration after this one: 092 (the cleanup drops -- the dead
-- enforce_job_application_required_docs function above among them).
-- ============================================================
BEGIN;

-- ── (a) status domain + partial index ───────────────────────────
-- 015/019/024 all named this constraint explicitly and none renamed it, so a
-- pg_constraint lookup for a generated name (073's technique) is unnecessary.
ALTER TABLE job_applications
  DROP CONSTRAINT IF EXISTS job_applications_status_check;

ALTER TABLE job_applications
  ADD CONSTRAINT job_applications_status_check
  CHECK (status IN ('pending', 'contacted', 'talking', 'details_requested', 'hired', 'not_interested'));

-- Mirrors 024's two partial indexes exactly (same columns, same DESC, same
-- shape): the employer applicant list filters by status and orders by
-- applied_at, and "who is waiting on me" is the new hot query.
CREATE INDEX IF NOT EXISTS idx_job_applications_status_details_requested
  ON job_applications (job_id, applied_at DESC)
  WHERE status = 'details_requested';

-- ── (b) stage timestamps ────────────────────────────────────────
ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS details_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS details_completed_at TIMESTAMPTZ;

-- Deliberately NO "completed implies requested" CHECK and NO history table.
-- The completeness pair here is not a coordinate pair (009/068's
-- jobs_location_complete precedent): a row can legitimately carry
-- details_completed_at from a WhatsApp fill that finished before the
-- employer's request row was written in a retried transaction, and 077's
-- header documents why one-way/absent constraints beat symmetric ones on a
-- table whose handler rewrites whole rows.

-- ── (c) jobs.pre_application_prompts ────────────────────────────
-- IMMUTABLE + STRICT SQL function, called from a CHECK. IMMUTABLE is
-- required for a CHECK to be trustworthy (the audit block asserts
-- provolatile = 'i' so a later CREATE OR REPLACE cannot silently downgrade
-- it). STRICT means a NULL argument short-circuits to NULL -- which a CHECK
-- treats as passing -- and that is harmless because the column itself is
-- NOT NULL.
--
-- CASE, not a chain of ANDs: SQL does not guarantee left-to-right evaluation
-- of AND, so `jsonb_typeof(p) = 'array' AND jsonb_array_length(p) <= 10`
-- may evaluate jsonb_array_length FIRST and raise 22023 on a non-array
-- instead of returning false. CASE branches are evaluated in order.
--
-- NO `REVOKE ALL ... FROM PUBLIC` here, unlike 072/082/088/089. Those are
-- SECURITY DEFINER functions whose whole point is a privilege boundary.
-- This one is invoker-rights and is evaluated INSIDE a CHECK constraint on
-- `jobs` for whatever role is writing the row, so revoking PUBLIC EXECUTE
-- would make every non-owner writer's INSERT/UPDATE fail with 42501 on the
-- constraint. The default PUBLIC EXECUTE is the correct ACL for a pure
-- validator that reads no tables.
CREATE OR REPLACE FUNCTION public.pre_application_prompts_valid(p JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
    -- Outer shape.
    WHEN jsonb_typeof(p) <> 'array' THEN false
    WHEN jsonb_array_length(p) > 10 THEN false
    -- Per-entry shape: an object with EXACTLY the keys id and text, an id
    -- matching ^[A-Za-z0-9_-]{1,40}$, and text of 1..500 CHARACTERS (not
    -- bytes -- Spanish prompt text is the common case).
    WHEN EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p) AS e(value)
       WHERE jsonb_typeof(e.value) <> 'object'
          OR (SELECT count(*) FROM jsonb_object_keys(e.value) AS k) <> 2
          OR NOT (e.value ? 'id')
          OR NOT (e.value ? 'text')
          OR jsonb_typeof(e.value -> 'id') <> 'string'
          OR jsonb_typeof(e.value -> 'text') <> 'string'
          OR (e.value ->> 'id') !~ '^[A-Za-z0-9_-]{1,40}$'
          OR char_length(e.value ->> 'text') < 1
          OR char_length(e.value ->> 'text') > 500
    ) THEN false
    -- Ids must be distinct: prompt_answers (part (d)) is keyed by them, so a
    -- duplicate id makes one prompt's answer unaddressable.
    WHEN (
      SELECT count(DISTINCT x.value ->> 'id') FROM jsonb_array_elements(p) AS x(value)
    ) <> jsonb_array_length(p) THEN false
    ELSE true
  END
$$;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS pre_application_prompts JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_pre_application_prompts_valid;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_pre_application_prompts_valid
  CHECK (public.pre_application_prompts_valid(pre_application_prompts));

-- jale_public_jobs (056/061) is the ONE column-scoped read role on jobs, and
-- lambda/api/public-job.ts enumerates its columns explicitly -- without this
-- grant the public job page's SELECT would 500 with a bare "permission
-- denied for table jobs" the moment it names the new column (077's exact
-- precedent and its exact failure mode). jale_matching (010) and
-- jale_whatsapp (004) hold TABLE-level SELECT on jobs and need nothing.
GRANT SELECT (pre_application_prompts) ON jobs TO jale_public_jobs;

-- ── (d) job_applications.prompt_answers ─────────────────────────
ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS prompt_answers JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE job_applications
  DROP CONSTRAINT IF EXISTS job_applications_prompt_answers_valid;

ALTER TABLE job_applications
  ADD CONSTRAINT job_applications_prompt_answers_valid
  -- Outer shape + a byte cap only; per-key validation is app-layer
  -- (validatePromptAnswers), same 073/074/077 precedent. octet_length on the
  -- text rendering is the same measure MAX_ANSWERS_JSON_LENGTH uses for
  -- application_answers, so the two caps are directly comparable.
  CHECK (
    jsonb_typeof(prompt_answers) = 'object'
    AND octet_length(prompt_answers::text) <= 12288
  );

-- ── (e) the hire gate ───────────────────────────────────────────
-- Replaces 022/080's BEFORE INSERT required-docs guard (see header).
--
-- THREE DECISIONS, each load-bearing:
--
-- 1. NOT SECURITY DEFINER. The function runs with INVOKER rights, under the
--    caller's RLS. That is the opposite of 029's sync_job_hired_counts (which
--    HAD to become a definer so a jale_whatsapp worker reply could cascade
--    onto jobs) and it is deliberate: this gate must never see more than the
--    role attempting the hire can see, or it would leak the existence of
--    another employer's job through its own error DETAIL. The cost is that a
--    caller whose session cannot read the job row gets a hard failure rather
--    than a silent pass -- which is the next decision.
--
-- 2. FAIL CLOSED on an unreadable job. If the jobs SELECT returns no row
--    (RLS filtered it out, or the job was deleted mid-transaction) the gate
--    RAISES rather than returning NEW. A definer-free gate that treated
--    "cannot see the job" as "no requirements" would be trivially bypassable
--    by any role with UPDATE (status) on job_applications and no jobs
--    visibility -- exactly the shape of 089's silent-zero-rows defect, but
--    with a security consequence instead of a reporting one. The DETAIL
--    carries reason=job_unreadable alongside the three empty arrays so
--    parseHireGateError never has to special-case the shape.
--
-- 3. JOB-SCOPED DOCUMENTS ONLY (wd.job_id = NEW.job_id), with NO
--    `OR wd.job_id IS NULL` -- the exact opposite of 022's predicate. 018's
--    worker_documents_employer_select requires job_id IS NOT NULL, so an
--    employer session CANNOT see vault rows at all; a predicate that also
--    accepted vault rows would be dead on the employer path and would make
--    the gate's behavior depend on WHICH role attempted the hire. The
--    engine's copyRequiredDocumentSnapshots (lib/applications.ts) copies
--    vault docs onto the application on every stage-2 read/write, so a
--    genuinely-supplied doc always has a job-scoped row by the time the
--    employer can act. A vault-only doc deliberately does NOT satisfy this
--    gate.
--
-- Legacy 'ssn' is skipped: 032/073 removed it from the app-layer DOC_TYPES
-- and no new job can require it, but pre-032 rows still list it and their
-- workers can no longer supply one -- blocking those hires forever would be
-- a data-migration bug dressed as a security control.
--
-- Optional-tier certifications NEVER block (certification-claims.ts's rule),
-- and proof_required only has teeth on a required-tier entry.
CREATE OR REPLACE FUNCTION public.enforce_job_application_hire_requirements()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_job            RECORD;
  v_answers        JSONB;
  v_claims         JSONB;
  v_reqs           JSONB;
  v_missing_fields TEXT[];
  v_missing_docs   TEXT[];
  v_missing_certs  TEXT[];
BEGIN
  SELECT j.required_fields, j.required_docs, j.certification_requirements
    INTO v_job
    FROM public.jobs j
   WHERE j.id = NEW.job_id;

  IF NOT FOUND THEN
    -- Decision 2 above. Empty arrays keep the DETAIL shape stable.
    RAISE EXCEPTION 'hire blocked: job row is not readable in this session'
      USING ERRCODE = '23514',
            CONSTRAINT = 'job_applications_hire_requirements_check',
            DETAIL = '{"fields": [], "docs": [], "certifications": [], "reason": "job_unreadable"}';
  END IF;

  v_answers := COALESCE(NEW.application_answers, '{}'::jsonb);
  IF jsonb_typeof(v_answers) <> 'object' THEN
    v_answers := '{}'::jsonb;
  END IF;

  -- Required FIELDS: key presence in application_answers, nothing more. The
  -- per-key value validation is validateApplicationAnswers's job and already
  -- ran before the key could be written.
  SELECT COALESCE(array_agg(f ORDER BY f), ARRAY[]::TEXT[])
    INTO v_missing_fields
    FROM unnest(COALESCE(v_job.required_fields, ARRAY[]::TEXT[])) AS f
   WHERE NOT (v_answers ? f);

  -- Required DOCS: job-scoped snapshot rows only (decision 3), legacy 'ssn'
  -- skipped.
  SELECT COALESCE(array_agg(d ORDER BY d), ARRAY[]::TEXT[])
    INTO v_missing_docs
    FROM unnest(COALESCE(v_job.required_docs, ARRAY[]::TEXT[])) AS d
   WHERE d <> 'ssn'
     AND NOT EXISTS (
       SELECT 1
         FROM public.worker_documents wd
        WHERE wd.worker_id = NEW.worker_id
          AND wd.job_id = NEW.job_id
          AND wd.doc_type = d
     );

  -- Required-tier CERTIFICATIONS: a claim under the reserved
  -- application_answers key 'certifications' with has=true, plus at least one
  -- doc id when the requirement sets proof_required. Both sides fail open on
  -- a malformed JSON shape (parseCertificationRequirements's documented
  -- posture): a corrupt or hand-edited row must not 500 the hire path. `->>`
  -- comparisons rather than ::boolean casts throughout, because a jsonb null
  -- or a string in `has` would make the cast raise 22023.
  v_reqs := COALESCE(v_job.certification_requirements, '[]'::jsonb);
  IF jsonb_typeof(v_reqs) <> 'array' THEN
    v_reqs := '[]'::jsonb;
  END IF;

  v_claims := v_answers -> 'certifications';
  IF v_claims IS NULL OR jsonb_typeof(v_claims) <> 'array' THEN
    v_claims := '[]'::jsonb;
  END IF;

  SELECT COALESCE(array_agg(req.name ORDER BY req.name), ARRAY[]::TEXT[])
    INTO v_missing_certs
    FROM jsonb_array_elements(v_reqs) AS r(value)
    CROSS JOIN LATERAL (
      SELECT r.value ->> 'name'                        AS name,
             r.value ->> 'tier'                        AS tier,
             (r.value ->> 'proof_required') = 'true'   AS proof_required
    ) AS req
   WHERE jsonb_typeof(r.value) = 'object'
     AND req.name IS NOT NULL
     AND req.tier = 'required'
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(v_claims) AS c(value)
        WHERE jsonb_typeof(c.value) = 'object'
          AND c.value ->> 'name' = req.name
          AND c.value ->> 'has' = 'true'
          AND (
            NOT req.proof_required
            OR (
              jsonb_typeof(c.value -> 'doc_ids') = 'array'
              AND jsonb_array_length(c.value -> 'doc_ids') > 0
            )
          )
     );

  IF COALESCE(array_length(v_missing_fields, 1), 0) > 0
     OR COALESCE(array_length(v_missing_docs, 1), 0) > 0
     OR COALESCE(array_length(v_missing_certs, 1), 0) > 0
  THEN
    RAISE EXCEPTION 'hire blocked: application requirements incomplete'
      USING ERRCODE = '23514',
            CONSTRAINT = 'job_applications_hire_requirements_check',
            DETAIL = jsonb_build_object(
                       'fields',         to_jsonb(v_missing_fields),
                       'docs',           to_jsonb(v_missing_docs),
                       'certifications', to_jsonb(v_missing_certs)
                     )::text;
  END IF;

  RETURN NEW;
END;
$$;

-- The WHEN clause is what makes a hired -> hired rewrite (and every
-- non-status UPDATE that happens to name the column) a no-op, and what makes
-- hired -> talking -> hired re-fire. BEFORE, so a rejection costs no row
-- version and no AFTER-trigger work (029's sync_job_hired_counts never runs).
DROP TRIGGER IF EXISTS job_applications_hire_requirements_guard ON job_applications;

CREATE TRIGGER job_applications_hire_requirements_guard
  BEFORE UPDATE OF status ON job_applications
  FOR EACH ROW
  WHEN (NEW.status = 'hired' AND OLD.status IS DISTINCT FROM 'hired')
  EXECUTE FUNCTION public.enforce_job_application_hire_requirements();

-- Retire 022/080's INSERT guard (see header). The FUNCTION survives on
-- purpose; 092 drops it.
DROP TRIGGER IF EXISTS job_applications_required_docs_guard ON job_applications;

-- ── (f) grants ──────────────────────────────────────────────────
-- Column-scoped, layered on top of 028's row-scoped jobapp_whatsapp_update
-- policy: BOTH must line up for a write to land. details_requested_at is
-- deliberately EXCLUDED -- only the employer status handler (jale_admin) may
-- open stage 2, and a worker-driven session must not be able to arm its own
-- request. 028 (status, updated_at) and 073 (application_answers,
-- updated_at) already granted the rest of what the engine writes.
GRANT UPDATE (prompt_answers, details_completed_at) ON job_applications TO jale_whatsapp;

-- 081's deferred write-back (see header). The grant alone reaches zero rows:
-- worker_application_defaults is RLS ENABLE + FORCE (079) and its two
-- existing policies are worker_application_defaults_self (079, keyed on the
-- WEB GUC app.current_user_id via cognito_sub -> always false for a
-- jale_whatsapp session) and worker_application_defaults_whatsapp_read (081,
-- FOR SELECT only). So a role-scoped WRITE policy is required alongside,
-- keyed on the INTERNAL GUC the WhatsApp/web-door Lambdas actually set
-- (setInternalUserRlsContext, lib/db.ts) -- 066/081's exact shape.
--
-- FOR ALL rather than FOR INSERT + FOR UPDATE: the engine's write is an
-- upsert (ON CONFLICT (worker_id) DO UPDATE), which needs both commands
-- under one predicate, and FOR ALL's USING covers the conflict-row lookup
-- while WITH CHECK covers the resulting row. It does NOT widen SELECT beyond
-- what 081 already granted (same predicate, same GUC) and it grants no
-- DELETE capability, because no DELETE privilege is granted below.
GRANT INSERT, UPDATE ON worker_application_defaults TO jale_whatsapp;

DROP POLICY IF EXISTS worker_application_defaults_whatsapp_write ON worker_application_defaults;

CREATE POLICY worker_application_defaults_whatsapp_write
  ON worker_application_defaults FOR ALL TO jale_whatsapp
  USING (worker_id::text = current_setting('app.current_internal_user_id', true))
  WITH CHECK (worker_id::text = current_setting('app.current_internal_user_id', true));

-- ── (g) trade_questions cache purge (Nova -> Claude Haiku 4.5) ──
-- All Bedrock usages move from Amazon Nova Lite to Claude Haiku 4.5 in the
-- release that PRECEDES this migration's apply (see the deploy-order note in
-- the header). trade_questions (012) caches the three trust questions
-- generated for a CUSTOM trade, keyed by profession_key, and records which
-- model produced them in model_id. Rows minted by Nova must regenerate under
-- Haiku, so they are dropped here and the next cache miss re-generates them.
--
-- The predicate is narrower than 086 Part 4's (`WHERE is_seeded = false`,
-- which purged the whole AI-generated cache when the v2 question format
-- changed): only the NOVA rows are stale now. Two consequences worth stating:
--   * The five SEEDED standard trades (012:36 onward -- is_seeded = true,
--     model_id NULL) are untouched. They are hand-written, not generated.
--   * `model_id LIKE '%nova%'` never matches NULL (NULL LIKE anything is
--     NULL, not true), so a legacy AI row with an unrecorded model_id also
--     survives. That is deliberate: this purge is scoped to a model switch,
--     not a format change, and a row whose model is unknown is not provably
--     stale.
--
-- jale_admin has no explicit DELETE grant on trade_questions (012:30 grants
-- only SELECT/INSERT/UPDATE) but OWNS the table, and an owner's implicit
-- privileges cannot be revoked -- 086 Part 4 relies on exactly the same fact.
DO $$
DECLARE
  v_deleted   INTEGER;
  v_remaining INTEGER;
BEGIN
  DELETE FROM public.trade_questions
   WHERE is_seeded = false AND model_id LIKE '%nova%';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- The COUNT is reported, not asserted -- 086 Part 4's reasoning: the number
  -- of stale cache rows is not a property this migration controls.
  RAISE NOTICE 'migration 091: purged % Nova-generated trade_questions cache row(s)', v_deleted;

  -- The END STATE, however, IS asserted, which 086 deliberately did not do.
  -- 086 could not: its generator was still live, so a concurrent INSERT
  -- between the DELETE and COMMIT was expected. Here the Haiku generator is
  -- already deployed (header deploy-order rule), so NO writer can produce a
  -- Nova model_id any more and a surviving Nova row would mean the ordering
  -- rule was violated -- exactly the mistake worth failing the migration for,
  -- since silently leaving stale rows behind is how 089's zero-rows defect
  -- went unnoticed.
  SELECT count(*) INTO v_remaining
    FROM public.trade_questions
   WHERE is_seeded = false AND model_id LIKE '%nova%';
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'migration 091: % Nova-generated trade_questions row(s) survived the purge -- was the Haiku generator deployed first?', v_remaining;
  END IF;
END;
$$;

-- ── (h) self-verification (073/081/089 pattern) ─────────────────
-- On RDS there is no Jest. This block is the only thing that verifies the
-- above in production, so migrations.test.ts pins its literal strings to keep
-- a future edit from quietly deleting it.
DO $$
DECLARE
  def       TEXT;
  fn_oid    OID;
  fn        RECORD;
  smoke     BOOLEAN;
  pol_count INTEGER;
  idx_pred  TEXT;
  has_when  BOOLEAN;
  col       TEXT;
BEGIN
  -- (a) widened status CHECK.
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
   WHERE rel.relname = 'job_applications'
     AND c.conname = 'job_applications_status_check'
     AND c.contype = 'c';
  IF def IS NULL
     OR def NOT LIKE '%details_requested%'
     OR def NOT LIKE '%pending%'
     OR def NOT LIKE '%not_interested%'
  THEN
    RAISE EXCEPTION 'job_applications_status_check missing or not widened with details_requested: %', COALESCE(def, '<absent>');
  END IF;

  -- (a) partial index, asserted by its PREDICATE and not merely its name, so
  -- a same-named index on the wrong predicate cannot pass.
  SELECT pg_get_expr(i.indpred, i.indrelid) INTO idx_pred
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
   WHERE ic.relname = 'idx_job_applications_status_details_requested';
  IF idx_pred IS NULL OR idx_pred NOT LIKE '%details_requested%' THEN
    RAISE EXCEPTION 'idx_job_applications_status_details_requested missing or has no details_requested predicate: %', COALESCE(idx_pred, '<absent>');
  END IF;

  -- (b) stage timestamps: present, timestamptz, and NULLABLE (a NOT NULL
  -- here would have needed a default and would have lied about every legacy
  -- row's history).
  FOREACH col IN ARRAY ARRAY['details_requested_at', 'details_completed_at']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'job_applications'
         AND column_name = col
         AND data_type = 'timestamp with time zone'
         AND is_nullable = 'YES'
    ) THEN
      RAISE EXCEPTION 'job_applications.% missing, not timestamptz, or unexpectedly NOT NULL', col;
    END IF;
  END LOOP;

  -- (c) jobs.pre_application_prompts: jsonb, NOT NULL, default '[]'.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'jobs'
       AND column_name = 'pre_application_prompts'
       AND data_type = 'jsonb'
       AND is_nullable = 'NO'
       AND column_default LIKE '%[]%'
  ) THEN
    RAISE EXCEPTION 'jobs.pre_application_prompts missing, nullable, not jsonb, or missing its empty-array default';
  END IF;

  -- (c) the validator function: exists, and is IMMUTABLE. provolatile is
  -- asserted because a later CREATE OR REPLACE that dropped IMMUTABLE would
  -- leave a CHECK constraint whose truth is no longer guaranteed stable.
  fn_oid := to_regprocedure('public.pre_application_prompts_valid(jsonb)')::OID;
  IF fn_oid IS NULL THEN
    RAISE EXCEPTION 'public.pre_application_prompts_valid(jsonb) missing';
  END IF;
  SELECT p.provolatile, p.proisstrict INTO fn FROM pg_proc p WHERE p.oid = fn_oid;
  IF fn.provolatile <> 'i' THEN
    RAISE EXCEPTION 'pre_application_prompts_valid is not IMMUTABLE (provolatile = %)', fn.provolatile;
  END IF;
  IF NOT fn.proisstrict THEN
    RAISE EXCEPTION 'pre_application_prompts_valid is not STRICT';
  END IF;

  -- (c) smoke: a well-formed single prompt passes and an id-only entry (the
  -- exact-keys rule) fails. An always-true or always-false validator would
  -- satisfy the existence checks above but not this one.
  SELECT public.pre_application_prompts_valid('[{"id": "a", "text": "x"}]')
         AND NOT public.pre_application_prompts_valid('[{"id": "a"}]')
    INTO smoke;
  IF smoke IS NOT TRUE THEN
    RAISE EXCEPTION 'pre_application_prompts_valid smoke test failed (expected accept {id,text} / reject {id})';
  END IF;

  -- (c) the CHECK constraint itself must call the validator.
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
   WHERE rel.relname = 'jobs'
     AND c.conname = 'jobs_pre_application_prompts_valid'
     AND c.contype = 'c';
  IF def IS NULL OR def NOT LIKE '%pre_application_prompts_valid%' THEN
    RAISE EXCEPTION 'jobs_pre_application_prompts_valid CHECK missing or does not call the validator: %', COALESCE(def, '<absent>');
  END IF;

  -- (d) job_applications.prompt_answers: jsonb, NOT NULL, default '{}', and
  -- a CHECK carrying both the object test and the byte cap.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'job_applications'
       AND column_name = 'prompt_answers'
       AND data_type = 'jsonb'
       AND is_nullable = 'NO'
       AND column_default LIKE '%{}%'
  ) THEN
    RAISE EXCEPTION 'job_applications.prompt_answers missing, nullable, not jsonb, or missing its empty-object default';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
   WHERE rel.relname = 'job_applications'
     AND c.conname = 'job_applications_prompt_answers_valid'
     AND c.contype = 'c';
  IF def IS NULL
     OR def NOT LIKE '%jsonb_typeof%'
     OR def NOT LIKE '%octet_length%'
     OR def NOT LIKE '%12288%'
  THEN
    RAISE EXCEPTION 'job_applications_prompt_answers_valid CHECK missing or malformed: %', COALESCE(def, '<absent>');
  END IF;

  -- (e) the hire trigger: present on job_applications, NOT internal, and
  -- carrying a WHEN clause. tgqual IS NULL would mean the WHEN was dropped,
  -- which would make every hired -> hired rewrite re-run the gate.
  SELECT t.tgqual IS NOT NULL INTO has_when
    FROM pg_trigger t
   WHERE t.tgname = 'job_applications_hire_requirements_guard'
     AND t.tgrelid = 'public.job_applications'::regclass
     AND NOT t.tgisinternal;
  IF has_when IS NULL THEN
    RAISE EXCEPTION 'job_applications_hire_requirements_guard trigger missing on job_applications';
  END IF;
  IF NOT has_when THEN
    RAISE EXCEPTION 'job_applications_hire_requirements_guard has no WHEN clause (hired -> hired would re-run the gate)';
  END IF;

  -- (e) the function body must still raise under the reviewed constraint
  -- name -- that string is the entire contract parseHireGateError depends on.
  SELECT p.prosrc, p.prosecdef INTO fn
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.enforce_job_application_hire_requirements()')::OID;
  IF fn.prosrc IS NULL THEN
    RAISE EXCEPTION 'public.enforce_job_application_hire_requirements() missing';
  END IF;
  IF fn.prosecdef THEN
    RAISE EXCEPTION 'enforce_job_application_hire_requirements must NOT be SECURITY DEFINER (see header decision 1)';
  END IF;
  IF fn.prosrc NOT LIKE '%job_applications_hire_requirements_check%' THEN
    RAISE EXCEPTION 'enforce_job_application_hire_requirements no longer raises under the job_applications_hire_requirements_check constraint name';
  END IF;
  IF fn.prosrc NOT LIKE '%job_unreadable%' THEN
    RAISE EXCEPTION 'enforce_job_application_hire_requirements lost its fail-closed job_unreadable branch';
  END IF;

  -- (e) 022/080's INSERT guard trigger must be GONE. Its function may (and
  -- should) still exist -- 092 drops that.
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'job_applications_required_docs_guard'
       AND t.tgrelid = 'public.job_applications'::regclass
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'job_applications_required_docs_guard (022/080) is still present -- stage 1 cannot create incomplete applications while it lives';
  END IF;

  -- (f) column privileges on job_applications for jale_whatsapp: the two
  -- granted, and details_requested_at NOT granted. The negative is the point
  -- -- a table-level UPDATE grant, or a copy-paste that added the third
  -- column, would hand a worker session the ability to arm its own stage 2.
  FOREACH col IN ARRAY ARRAY['prompt_answers', 'details_completed_at']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.column_privileges
       WHERE grantee = 'jale_whatsapp' AND table_schema = 'public'
         AND table_name = 'job_applications' AND column_name = col
         AND privilege_type = 'UPDATE'
    ) THEN
      RAISE EXCEPTION 'jale_whatsapp missing UPDATE grant on job_applications.%', col;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
     WHERE grantee = 'jale_whatsapp' AND table_schema = 'public'
       AND table_name = 'job_applications' AND column_name = 'details_requested_at'
       AND privilege_type = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'jale_whatsapp unexpectedly has UPDATE on job_applications.details_requested_at (employer-only column, see part (f))';
  END IF;

  -- (c) jale_public_jobs must be able to read the new jobs column.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.column_privileges
     WHERE grantee = 'jale_public_jobs' AND table_schema = 'public'
       AND table_name = 'jobs' AND column_name = 'pre_application_prompts'
       AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'jale_public_jobs missing SELECT grant on jobs.pre_application_prompts';
  END IF;

  -- (f) worker_application_defaults end state: still RLS ENABLE + FORCE
  -- (079's invariant, which this migration must not relax), all THREE
  -- policies present (079's self, 081's whatsapp_read, and this file's
  -- whatsapp_write), the write policy correctly shaped, and the two new
  -- table privileges actually held.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class rel
    JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public' AND rel.relname = 'worker_application_defaults'
       AND rel.relrowsecurity AND rel.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'worker_application_defaults must keep RLS ENABLE + FORCE';
  END IF;

  SELECT count(*) INTO pol_count
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'worker_application_defaults'
     AND policyname IN (
       'worker_application_defaults_self',
       'worker_application_defaults_whatsapp_read',
       'worker_application_defaults_whatsapp_write'
     );
  IF pol_count <> 3 THEN
    RAISE EXCEPTION 'worker_application_defaults must carry all three policies (079 self, 081 whatsapp_read, 091 whatsapp_write); found %', pol_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'worker_application_defaults'
       AND policyname = 'worker_application_defaults_whatsapp_write'
       AND cmd = 'ALL'
       AND roles = ARRAY['jale_whatsapp']::name[]
       AND qual ILIKE '%current_internal_user_id%'
       AND qual ILIKE '%worker_id%'
       AND with_check ILIKE '%current_internal_user_id%'
       AND with_check ILIKE '%worker_id%'
  ) THEN
    RAISE EXCEPTION 'worker_application_defaults_whatsapp_write missing or wrong shape (expected FOR ALL TO jale_whatsapp with USING + WITH CHECK on worker_id / app.current_internal_user_id)';
  END IF;

  IF NOT has_table_privilege('jale_whatsapp', 'worker_application_defaults', 'INSERT')
     OR NOT has_table_privilege('jale_whatsapp', 'worker_application_defaults', 'UPDATE')
  THEN
    RAISE EXCEPTION 'jale_whatsapp missing INSERT/UPDATE on worker_application_defaults (081 write-back deferral is lifted by this migration)';
  END IF;

  -- No DELETE was granted, and none should have appeared. Same posture 079
  -- documents for jale_admin, except that here it IS assertable:
  -- jale_whatsapp does not own the table, so ownership cannot mask it.
  IF has_table_privilege('jale_whatsapp', 'worker_application_defaults', 'DELETE') THEN
    RAISE EXCEPTION 'jale_whatsapp unexpectedly has DELETE on worker_application_defaults (never granted; overwrite-in-place only)';
  END IF;
END;
$$;

COMMIT;
