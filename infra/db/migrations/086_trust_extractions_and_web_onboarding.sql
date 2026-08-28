-- ============================================================
-- 086_trust_extractions_and_web_onboarding.sql
-- Run manually AFTER 085_employer_trust_assessment_read.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Sprint 22 release 1, four independent parts in one forward-only file:
--
--   Part 1  worker_trust_extractions -- structured skills/tools/safety
--           signals a new jale_ai Lambda extracts from the three trust
--           answers a worker already gave (012's worker_trust_assessments).
--           Written only by jale_ai; read by the worker (both lanes) and
--           by an employer the worker has actually applied to, through the
--           recursion-safe 020b/038 helper, exactly as 085 did for the
--           assessment itself.
--
--   Part 2  Two SECURITY DEFINER entry points for the WEB onboarding door
--           (WS3). The web Lambda runs as jale_whatsapp -- the role that
--           owns the onboarding state machine's grants -- but it arrives
--           holding a Cognito sub, not an internal id, and cannot write
--           worker_onboarding_state / worker_workflow_runs for an identity
--           it has not itself bound. Same reasoning as 047/053: the writes
--           go through catalog-path definers, never through a caller-set
--           GUC on a raw table.
--
--   Part 3  Carry-over from the 077 structured-jobs work: give
--           jobs.certification_requirements the '[]' default it should
--           always have had, and backfill the NULLs 077 left behind. The
--           column stays NULLABLE -- 077's CHECK already tolerates NULL and
--           adding NOT NULL here would be a lock-taking behavior change
--           the application has not been prepared for. The backfill runs
--           through 067's jale_location_backfill helper role, because a
--           bare UPDATE as jale_admin on FORCE-RLS jobs matches zero rows
--           (the 065 -> 067 lesson).
--
--   Part 4  Reword the five seeded trade_questions rows (012:36-61) and
--           DROP the AI-generated cache rows (is_seeded = false). The seeded
--           rows were multiple-choice descriptors for the WhatsApp button
--           flow; the trust panel now wants the worker's own words. All
--           three questions per trade become OPEN questions, and none may
--           ask about years/seniority or offer numbered options. The
--           non-seeded rows were produced by the RETIRED Nova prompt, which
--           explicitly asked for a seniority/level question, so they carry
--           the same defect and cannot be reworded by hand -- they are
--           deleted so the next worker on that trade regenerates through
--           the new prompt on a cache miss.
--
-- >>> DEPLOY ORDER (operator-enforced, this file cannot check it) <<<
-- Part 4's DELETE is only correct once the sprint-22 R1-A
-- infra/lambda/ai/question-generator.ts prompt is DEPLOYED. That rewrite is
-- what forbids years/seniority/level and multiple-choice in generated
-- questions. The retired prompt actively ASKS for a seniority question
-- ("ask what level they can work at, such as helper, independently, or
-- lead"), so applying 086 against the old Lambda would regenerate the exact
-- defect this removes -- and stamp it as fresh, which is strictly worse than
-- leaving the stale rows in place. Apply 086 WITH or AFTER that deploy.
-- There is no marker in the database that identifies which prompt produced a
-- row, so no self-audit below can enforce this; it is a release-sequencing
-- constraint on R1 as a whole.
--
-- NOT idempotent, by design: Part 1's bare CREATE TABLE aborts the whole
-- transaction with 42P07 on a second apply rather than silently half-
-- replaying. Forward-only (ADR-005).
--
-- Non-ASCII is deliberately avoided in the Spanish strings below, matching
-- every migration 001-085 and 012's own seed text.
-- ============================================================

BEGIN;

-- ============================================================
-- Part 1 -- worker_trust_extractions
-- ============================================================

CREATE TABLE worker_trust_extractions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE on both parents: an extraction is a derived view of
  -- one assessment and has no meaning once that assessment (or the worker)
  -- is gone. user_id is denormalized from the assessment so the RLS
  -- policies below stay FLAT -- no join back through
  -- worker_trust_assessments, which is itself FORCE RLS (012:88).
  assessment_id     UUID        NOT NULL
                      REFERENCES worker_trust_assessments(id) ON DELETE CASCADE,
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','extracting','completed','failed')),
  -- Shape (all keys optional, all values arrays of objects):
  --   {"skills":[{"label_en":..,"label_es":..,"source":[0,2]}],
  --    "tools":[...], "experience_signals":[...],
  --    "safety":[...], "notable":[...]}
  -- `source` indexes back into worker_trust_assessments.answers so the UI
  -- can show which answer a skill came from.
  extracted         JSONB       NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(extracted) = 'object'),
  summary_en        TEXT        CHECK (summary_en IS NULL OR char_length(summary_en) <= 600),
  summary_es        TEXT        CHECK (summary_es IS NULL OR char_length(summary_es) <= 600),
  model_id          TEXT,
  -- Bumping extractor_version re-runs every worker through a new prompt or
  -- rubric without destroying the previous output, so a regression can be
  -- compared side by side. The UNIQUE below is what makes the extractor
  -- Lambda's per-(assessment, version) retry idempotent.
  extractor_version TEXT        NOT NULL,
  error             TEXT        CHECK (error IS NULL OR char_length(error) <= 2000),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT worker_trust_extractions_assessment_version
    UNIQUE (assessment_id, extractor_version)
);

CREATE INDEX idx_worker_trust_extractions_user
  ON worker_trust_extractions (user_id, created_at DESC);

-- Shared trigger function from 001:40, same wiring as 082:180.
CREATE TRIGGER worker_trust_extractions_updated_at
  BEFORE UPDATE ON worker_trust_extractions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE worker_trust_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_trust_extractions FORCE ROW LEVEL SECURITY;

-- Every policy names its roles explicitly (the 020b rule): a policy with no
-- TO clause applies to PUBLIC.

-- The extractor Lambda. Only role that may write.
CREATE POLICY wte_ai_service_rows ON worker_trust_extractions
  FOR ALL TO jale_ai
  USING (true)
  WITH CHECK (true);

-- Worker self, internal-id lane (WhatsApp processor / web door).
CREATE POLICY wte_worker_own_internal ON worker_trust_extractions
  FOR SELECT TO jale_whatsapp
  USING (user_id::text = current_setting('app.current_internal_user_id', true));

-- Employer read, gated on the recursion-safe applicant-relationship helper
-- (020b:234 / 038:140). SELECT only: employers never write extractions.
CREATE POLICY wte_employer_applicant_read ON worker_trust_extractions
  FOR SELECT TO jale_admin
  USING (jale_internal.employer_has_applicant_relationship(
           current_setting('app.current_internal_user_id', true), user_id));

-- Worker self, Cognito-sub lane (API handlers before internal-id
-- resolution), mirroring 083's worker_posts_self_sub.
CREATE POLICY wte_worker_own_sub ON worker_trust_extractions
  FOR SELECT TO jale_admin
  USING (user_id = (SELECT id FROM users
                    WHERE cognito_sub = current_setting('app.current_user_id', true)));

-- ── Grants ───────────────────────────────────────────────────
-- jale_ai writes; everyone else reads. jale_whatsapp must NEVER get
-- INSERT/UPDATE here: an extraction is a model output, and a worker-facing
-- role that could write one could forge its own skills.
GRANT SELECT, INSERT, UPDATE ON worker_trust_extractions TO jale_ai;
GRANT SELECT ON worker_trust_extractions TO jale_whatsapp;
GRANT SELECT ON worker_trust_extractions TO jale_admin;

-- ============================================================
-- Part 2 -- web-door SECURITY DEFINER entry points
-- ============================================================

-- ── resolve_worker_internal_id ──────────────────────────────
-- users has FORCE ROW LEVEL SECURITY (002:10-11), so even jale_admin -- the
-- definer owner -- is subject to policy and a bare lookup by cognito_sub
-- returns zero rows. Rather than introduce a new policy on users, this
-- reuses the existing users_worker_reconcile policy (027:271) by setting
-- app.worker_reconcile_sub, exactly as 052's stage/promote functions do.
-- No new read surface on users is created by this migration.
--
-- The set_config is transaction-local (is_local = true), so it is confined
-- to the caller's transaction and disappears at COMMIT/ROLLBACK -- but it
-- IS visible to the rest of that transaction, same as 027/052.
CREATE OR REPLACE FUNCTION public.resolve_worker_internal_id(
  p_cognito_sub TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_cognito_sub IS NULL OR pg_catalog.btrim(p_cognito_sub) = '' THEN
    RAISE EXCEPTION 'invalid cognito sub' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.worker_reconcile_sub', p_cognito_sub, true);

  SELECT u.id INTO v_id
    FROM public.users u
   WHERE u.cognito_sub = p_cognito_sub
     AND u.user_type = 'worker';

  -- NULL for "no such worker" and for "exists but is an employer": the
  -- caller must not be able to tell those apart.
  RETURN v_id;
END $$;

ALTER FUNCTION public.resolve_worker_internal_id(TEXT) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.resolve_worker_internal_id(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_worker_internal_id(TEXT) TO jale_whatsapp;

-- ── start_web_onboarding_workflow ───────────────────────────
-- CALLER CONTRACT: the web Lambda MUST run
--     SET LOCAL app.onboarding_bind_user_id = '<the resolved worker uuid>';
-- in the same transaction before calling this, or the call raises 42501.
-- That GUC is the same one 042/046/047/053 pin, and it is load-bearing
-- twice over: it is the authorization gate here, and it is the key to
-- 042's users_onboarding_bind_definer SELECT policy (042:390-395) without
-- which the worker-existence check below could not see the row at all.
--
-- Idempotent by construction: one advisory lock per identity serializes a
-- double-submit, an existing ACTIVE run is returned untouched (042's
-- worker_workflow_one_active partial unique index would otherwise raise
-- 23505), and a worker already at lifecycle='ready' with a completed run
-- gets that run back rather than being dragged into onboarding again.
--
-- Deliberately NOT copied from 047/053: their
-- `ON CONFLICT (user_id) DO UPDATE SET lifecycle = ...` would clobber a
-- 'ready' worker back to 'onboarding'. This only ever INSERTs a MISSING
-- state row and never rewrites an existing one.
CREATE OR REPLACE FUNCTION public.start_web_onboarding_workflow(
  p_user_id UUID,
  p_preferred_language TEXT,
  p_workflow_version INTEGER
) RETURNS TABLE (onboarding_state_id UUID, run_id UUID, created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_state UUID;
  v_lifecycle TEXT;
  v_run UUID;
BEGIN
  IF p_user_id IS NULL
     OR p_preferred_language IS NULL OR p_preferred_language NOT IN ('en', 'es')
     OR p_workflow_version IS NULL OR p_workflow_version <= 0 THEN
    RAISE EXCEPTION 'invalid web onboarding start request' USING ERRCODE = '22023';
  END IF;

  IF current_setting('app.onboarding_bind_user_id', true) IS DISTINCT FROM p_user_id::text THEN
    RAISE EXCEPTION 'web onboarding start is not bound to this worker'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  IF NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = p_user_id AND u.user_type = 'worker'
  ) THEN
    RAISE EXCEPTION 'worker not found' USING ERRCODE = '23503';
  END IF;

  SELECT s.id, s.lifecycle INTO v_state, v_lifecycle
    FROM public.worker_onboarding_state s
   WHERE s.user_id = p_user_id
   FOR UPDATE;

  IF v_state IS NULL THEN
    INSERT INTO public.worker_onboarding_state (user_id, lifecycle, lifecycle_changed_at)
      VALUES (p_user_id, 'onboarding', pg_catalog.now())
      ON CONFLICT (user_id) DO NOTHING
      RETURNING id, lifecycle INTO v_state, v_lifecycle;

    -- DO NOTHING returns no row on conflict; the advisory lock makes this
    -- branch unreachable in practice, but a lock taken on a hash collision
    -- partner is not a guarantee, so re-read rather than return NULL.
    IF v_state IS NULL THEN
      SELECT s.id, s.lifecycle INTO v_state, v_lifecycle
        FROM public.worker_onboarding_state s
       WHERE s.user_id = p_user_id
       FOR UPDATE;
    END IF;
  END IF;

  SELECT r.id INTO v_run
    FROM public.worker_workflow_runs r
   WHERE r.user_id = p_user_id AND r.status = 'active'
   ORDER BY r.created_at DESC, r.id DESC
   LIMIT 1 FOR UPDATE;
  IF v_run IS NOT NULL THEN
    RETURN QUERY SELECT v_state, v_run, false;
    RETURN;
  END IF;

  IF v_lifecycle = 'ready' THEN
    SELECT r.id INTO v_run
      FROM public.worker_workflow_runs r
     WHERE r.user_id = p_user_id AND r.status = 'completed'
     ORDER BY r.completed_at DESC NULLS LAST, r.created_at DESC, r.id DESC
     LIMIT 1 FOR UPDATE;
    IF v_run IS NOT NULL THEN
      RETURN QUERY SELECT v_state, v_run, false;
      RETURN;
    END IF;
  END IF;

  -- 'legal.review' is the web door's first step and is valid under both
  -- 042's original CHECK and 050's widened one. lock_version and context
  -- take their column defaults (0 / '{}').
  INSERT INTO public.worker_workflow_runs
    (user_id, workflow_version, current_step_key, status, preferred_language, context)
    VALUES (p_user_id, p_workflow_version, 'legal.review', 'active', p_preferred_language, '{}'::jsonb)
    RETURNING id INTO v_run;

  INSERT INTO public.worker_workflow_transitions
    (run_id, from_step_key, to_step_key, inbound_message_sid, reason, metadata)
    VALUES (v_run, NULL, 'legal.review', NULL, 'web_start', '{}'::jsonb);

  RETURN QUERY SELECT v_state, v_run, true;
END $$;

ALTER FUNCTION public.start_web_onboarding_workflow(UUID, TEXT, INTEGER) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.start_web_onboarding_workflow(UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_web_onboarding_workflow(UUID, TEXT, INTEGER) TO jale_whatsapp;

-- ============================================================
-- Part 3 -- jobs.certification_requirements default + backfill
-- ============================================================
-- 077:73 added the column as a nullable JSONB with
-- `CHECK (... IS NULL OR jsonb_typeof(...) = 'array')` and no default, so
-- every job created before the structured-fields deploy reads NULL and
-- every handler has to COALESCE. Give it the empty array both as the
-- go-forward default and as the value for the existing NULLs. NOT NULL is
-- deliberately NOT added: the CHECK still permits NULL and the write paths
-- have not been audited for it.
--
-- THE BACKFILL CANNOT RUN AS PLAIN jale_admin. jobs is FORCE ROW LEVEL
-- SECURITY (003:81-82), every jobs policy keys on app.current_user_id, and
-- the bastion runner never sets it -- which is exactly how migration 065's
-- backfill silently updated 0 rows and had to be repaired by 067. So this
-- reuses 067's helper role and its established pattern: a one-shot UPDATE
-- policy, SET ROLE for the duration, verify, then revoke.
--
-- The jobs_updated_at trigger (003:28) is disabled for the duration too:
-- filling in a default the row always semantically had must not make every
-- pre-077 job look freshly edited.

DO $$
BEGIN
  -- 067 creates this role and keeps the membership; recreate defensively so
  -- an out-of-order manual apply fails with a clear message, not 42501.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jale_location_backfill') THEN
    CREATE ROLE jale_location_backfill
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO jale_location_backfill;
GRANT SELECT, UPDATE ON jobs TO jale_location_backfill;
GRANT jale_location_backfill TO jale_admin WITH SET TRUE, INHERIT FALSE;

-- 067 keeps jobs_location_backfill_select in place for its monitoring query;
-- recreated here so this migration does not depend on that being true.
DROP POLICY IF EXISTS jobs_location_backfill_select ON jobs;
CREATE POLICY jobs_location_backfill_select
  ON jobs FOR SELECT TO jale_location_backfill USING (true);
DROP POLICY IF EXISTS jobs_cert_backfill_update ON jobs;
CREATE POLICY jobs_cert_backfill_update
  ON jobs FOR UPDATE TO jale_location_backfill USING (true) WITH CHECK (true);

ALTER TABLE jobs ALTER COLUMN certification_requirements SET DEFAULT '[]'::jsonb;
ALTER TABLE jobs DISABLE TRIGGER jobs_updated_at;

SET ROLE jale_location_backfill;

UPDATE jobs SET certification_requirements = '[]'::jsonb
 WHERE certification_requirements IS NULL;

-- Verified from INSIDE the role: as plain jale_admin this count reads 0
-- forever whether or not the backfill worked -- RLS, not truth (067:18).
DO $$
DECLARE
  v_remaining INTEGER;
BEGIN
  SELECT count(*) INTO v_remaining FROM public.jobs WHERE certification_requirements IS NULL;
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'migration 086: % jobs rows still have a NULL certification_requirements', v_remaining;
  END IF;
END;
$$;

RESET ROLE;

ALTER TABLE jobs ENABLE TRIGGER jobs_updated_at;

-- One-shot: the write grant and policy do not outlive this transaction.
DROP POLICY IF EXISTS jobs_cert_backfill_update ON jobs;
REVOKE UPDATE ON jobs FROM jale_location_backfill;

-- ============================================================
-- Part 4 -- reseed the five seeded trade_questions rows as OPEN questions
-- ============================================================
-- 012's seeds were descriptors for a multiple-choice WhatsApp button flow.
-- The trust panel now shows the worker's own words, so all three questions
-- become open-ended: (1) specialisation plus what they actually did on the
-- last job, (2) how they start a job site they have never seen, (3) a time
-- something went wrong and what they did about it.
--
-- Scoped to is_seeded = true so an AI-generated cache row for a custom
-- trade is never rewritten by this migration.

UPDATE trade_questions SET questions = '[
  {"q_en":"What kind of electrical work do you specialize in, and what did you install or repair on your last job: panels, circuits, fixtures?",
   "q_es":"En que tipo de trabajo electrico te especializas y que instalaste o reparaste en tu ultimo trabajo: tableros, circuitos, luminarias?"},
  {"q_en":"You arrive at a site you have never seen before and the client points at a panel. What is the first thing you do?",
   "q_es":"Llegas a una obra que nunca has visto y el cliente te senala un tablero. Que es lo primero que haces?"},
  {"q_en":"Tell us about a time something went wrong on an electrical job: a short, a failed inspection, a wrong circuit. What happened and what did you do?",
   "q_es":"Cuentanos de una vez que algo salio mal en un trabajo electrico: un corto, una inspeccion reprobada, un circuito equivocado. Que paso y que hiciste?"}
]'::jsonb
 WHERE is_seeded = true AND profession_key = 'electrician';

UPDATE trade_questions SET questions = '[
  {"q_en":"What kind of plumbing do you specialize in, and what did you rough-in or install on your last job: supply lines, drains, fixtures?",
   "q_es":"En que tipo de plomeria te especializas y que instalaste en tu ultimo trabajo: lineas de agua, drenajes, muebles sanitarios?"},
  {"q_en":"You arrive at a job you have never seen and the owner says there is a leak somewhere. What is the first thing you do?",
   "q_es":"Llegas a un trabajo que nunca has visto y el dueno te dice que hay una fuga en algun lado. Que es lo primero que haces?"},
  {"q_en":"Tell us about a time a plumbing job went wrong: a leak after you finished, a fitting that failed, a line you had to open again. What happened and what did you do?",
   "q_es":"Cuentanos de una vez que un trabajo de plomeria salio mal: una fuga despues de terminar, una conexion que fallo, una linea que tuviste que abrir otra vez. Que paso y que hiciste?"}
]'::jsonb
 WHERE is_seeded = true AND profession_key = 'plumber';

UPDATE trade_questions SET questions = '[
  {"q_en":"What kind of carpentry do you specialize in, and what did you build on your last job: framing, doors, cabinets, finish trim?",
   "q_es":"En que tipo de carpinteria te especializas y que construiste en tu ultimo trabajo: estructura, puertas, gabinetes, acabados?"},
  {"q_en":"You arrive at a site you have never seen with the plans in hand. What is the first thing you do before you cut anything?",
   "q_es":"Llegas a una obra que nunca has visto con los planos en la mano. Que es lo primero que haces antes de cortar algo?"},
  {"q_en":"Tell us about a time a carpentry job went wrong: a bad measurement, warped material, something that did not fit. What happened and what did you do?",
   "q_es":"Cuentanos de una vez que un trabajo de carpinteria salio mal: una medida equivocada, material torcido, algo que no encajo. Que paso y que hiciste?"}
]'::jsonb
 WHERE is_seeded = true AND profession_key = 'carpenter';

UPDATE trade_questions SET questions = '[
  {"q_en":"What kind of concrete work do you specialize in, and what did you form, pour, or finish on your last job?",
   "q_es":"En que tipo de trabajo de concreto te especializas y que cimbraste, colaste o acabaste en tu ultimo trabajo?"},
  {"q_en":"You arrive at a pour you have never seen before. What is the first thing you check before the truck backs in?",
   "q_es":"Llegas a un colado que nunca has visto. Que es lo primero que revisas antes de que se acerque el camion?"},
  {"q_en":"Tell us about a time a pour went wrong: the weather turned, a form moved, a slab cracked. What happened and what did you do?",
   "q_es":"Cuentanos de una vez que un colado salio mal: cambio el clima, se movio una cimbra, se agrieto una losa. Que paso y que hiciste?"}
]'::jsonb
 WHERE is_seeded = true AND profession_key = 'concrete';

UPDATE trade_questions SET questions = '[
  {"q_en":"What kind of painting do you specialize in, and what did you prep and coat on your last job: interior walls, exteriors, spray work?",
   "q_es":"En que tipo de pintura te especializas y que preparaste y pintaste en tu ultimo trabajo: paredes interiores, exteriores, trabajo con pistola?"},
  {"q_en":"You arrive at a room you have never seen and the walls are in bad shape. What is the first thing you do?",
   "q_es":"Llegas a un cuarto que nunca has visto y las paredes estan en mal estado. Que es lo primero que haces?"},
  {"q_en":"Tell us about a time a paint job went wrong: peeling, bleed-through, a color the client rejected. What happened and what did you do?",
   "q_es":"Cuentanos de una vez que un trabajo de pintura salio mal: se descarapelo, se transparento, o el cliente rechazo el color. Que paso y que hiciste?"}
]'::jsonb
 WHERE is_seeded = true AND profession_key = 'painting';

-- Drop every AI-generated cache row. These came from the retired Nova prompt
-- (see the DEPLOY ORDER note at the top) and each carries a seniority/level
-- question the trust scorer cannot grade. There is no way to reword them in
-- SQL -- they are per-trade free text -- so the cache is emptied and the
-- generator refills it, one trade at a time, on the next cache miss:
-- custom-trust.ts / ai-profile-writer.ts both fall through to the
-- question-generator Lambda when the SELECT returns no row.
--
-- Safe to delete:
--   * No foreign key anywhere references trade_questions (checked across
--     001-085). 060's trade_aliases only "mirrors" its shape; it is a
--     separate table keyed on trade_key with no FK and is untouched here.
--   * In-flight WhatsApp onboarding is unaffected: trust-seed.ts copies the
--     three questions into worker_workflow_runs.context
--     (state_context.v2TrustQuestions) at seed time and never re-reads this
--     table for that run.
--   * processor.ts's profile summary LEFT JOINs this table purely to render
--     the question text next to a stored answer, and
--     displayQuestionForAnswer() already falls back to the q_en captured on
--     the answer row itself, so an already-assessed worker loses nothing but
--     the Spanish rendering of a question they have already answered.
--
-- jale_admin has no explicit DELETE grant on trade_questions (012:30 grants
-- only SELECT/INSERT/UPDATE) but OWNS the table, and an owner's implicit
-- privileges cannot be revoked -- the same reason worker_trust_extractions
-- relies on RLS rather than grants to keep jale_admin read-only.
DELETE FROM trade_questions WHERE is_seeded = false;

-- ============================================================
-- Self-audit. On RDS there is no Jest: these DO blocks are the only thing
-- that verifies this migration in production.
-- ============================================================
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Part 1: RLS is both ENABLEd and FORCEd, and no policy leaks to PUBLIC.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
     WHERE c.oid = 'public.worker_trust_extractions'::regclass
       AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'migration 086: worker_trust_extractions is missing ENABLE/FORCE ROW LEVEL SECURITY';
  END IF;

  SELECT count(*) INTO v_count FROM pg_catalog.pg_policies
   WHERE schemaname = 'public' AND tablename = 'worker_trust_extractions';
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'migration 086: expected 4 policies on worker_trust_extractions, found %', v_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
     WHERE p.polrelid = 'public.worker_trust_extractions'::regclass
       AND p.polroles = ARRAY[0]::oid[]
  ) THEN
    RAISE EXCEPTION 'migration 086: a worker_trust_extractions policy applies to PUBLIC';
  END IF;

  -- jale_whatsapp is read-only here, forever.
  IF pg_catalog.has_table_privilege('jale_whatsapp', 'public.worker_trust_extractions', 'INSERT')
     OR pg_catalog.has_table_privilege('jale_whatsapp', 'public.worker_trust_extractions', 'UPDATE')
     OR pg_catalog.has_table_privilege('jale_whatsapp', 'public.worker_trust_extractions', 'DELETE') THEN
    RAISE EXCEPTION 'migration 086: jale_whatsapp holds write privileges on worker_trust_extractions';
  END IF;
  IF NOT pg_catalog.has_table_privilege('jale_whatsapp', 'public.worker_trust_extractions', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('jale_admin', 'public.worker_trust_extractions', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('jale_ai', 'public.worker_trust_extractions', 'INSERT') THEN
    RAISE EXCEPTION 'migration 086: worker_trust_extractions grants are incomplete';
  END IF;

  -- Part 2: owner, SECURITY DEFINER, pinned search_path, no PUBLIC EXECUTE.
  SELECT count(*) INTO v_count
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.proname IN ('resolve_worker_internal_id', 'start_web_onboarding_workflow')
     AND r.rolname = 'jale_admin'
     AND p.prosecdef
     AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
     AND NOT pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'migration 086 definer self-audit failed (owner/SECURITY DEFINER/search_path/PUBLIC ACL): % of 2 conforming', v_count;
  END IF;

  IF NOT pg_catalog.has_function_privilege('jale_whatsapp',
       'public.resolve_worker_internal_id(text)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('jale_whatsapp',
       'public.start_web_onboarding_workflow(uuid,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 086: jale_whatsapp cannot execute the web-door definers';
  END IF;

  -- Part 3. The row-level check already ran inside the backfill role above
  -- (as jale_admin it would read 0 whether or not the UPDATE worked); what
  -- is left to verify here is the column default and that the jobs
  -- updated_at trigger was re-enabled ('O' = origin, i.e. enabled).
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attrdef d
     JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.jobs'::regclass
      AND a.attname = 'certification_requirements'
      AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) = '''[]''::jsonb'
  ) THEN
    RAISE EXCEPTION 'migration 086: jobs.certification_requirements default was not set';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = 'public.jobs'::regclass
       AND t.tgname = 'jobs_updated_at'
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'migration 086: jobs_updated_at trigger was left disabled';
  END IF;

  IF pg_catalog.has_table_privilege('jale_location_backfill', 'public.jobs', 'UPDATE') THEN
    RAISE EXCEPTION 'migration 086: jale_location_backfill still holds UPDATE on jobs';
  END IF;

  -- Part 4: exactly five seeded rows, three open questions each, no
  -- years/seniority wording and no numbered options in either language.
  SELECT count(*) INTO v_count FROM public.trade_questions
   WHERE is_seeded = true
     AND profession_key IN ('electrician','plumber','carpenter','concrete','painting');
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'migration 086: expected 5 seeded trade_questions rows, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.trade_questions t
   WHERE t.is_seeded = true
     AND t.profession_key IN ('electrician','plumber','carpenter','concrete','painting')
     AND (
       jsonb_array_length(t.questions) <> 3
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(t.questions) q
          WHERE q->>'q_en' IS NULL OR q->>'q_es' IS NULL
            -- The Spanish patterns use `.` where an accent would sit
            -- (a.os / cu.nto / antig.edad) so they catch both the accented
            -- and unaccented spellings while keeping this file ASCII, and
            -- \m..\M so "cuentanos" and "planos" are not false positives.
            OR q->>'q_en' ~* '(\myears\M|how long|\mseniority\M)'
            OR q->>'q_en' ~ '[1-3]\. '
            OR q->>'q_es' ~* '(\ma.os\M|cu.nto tiempo|antig.edad)'
            OR q->>'q_es' ~ '[1-3]\. '
       )
     );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'migration 086: % seeded trade_questions rows are not 3 open q_en/q_es questions', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.trade_questions WHERE is_seeded = false;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'migration 086: % AI-generated trade_questions rows survived the cache purge', v_count;
  END IF;
END;
$$;

COMMIT;

-- ============================================================
-- VERIFICATION -- run after applying (connect as jale_admin):
--
-- SELECT relrowsecurity, relforcerowsecurity FROM pg_class
--   WHERE oid = 'worker_trust_extractions'::regclass;
--
-- SELECT policyname, cmd, roles FROM pg_policies
--   WHERE tablename = 'worker_trust_extractions';
--   -- 4 rows; roles must never be {public}.
--
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--   WHERE table_name = 'worker_trust_extractions'
--     AND grantee IN ('jale_ai','jale_whatsapp','jale_admin');
--   -- jale_whatsapp and jale_admin: SELECT only.
--
-- Recursion smoke (must not raise 42P17):
-- SET app.current_internal_user_id = '00000000-0000-4000-8000-000000000000';
-- SELECT count(*) FROM worker_trust_extractions;
--
-- Web-door smoke (as jale_whatsapp, inside one transaction):
-- BEGIN;
--   SELECT public.resolve_worker_internal_id('<cognito-sub>');
--   SET LOCAL app.onboarding_bind_user_id = '<that uuid>';
--   SELECT * FROM public.start_web_onboarding_workflow('<that uuid>', 'es', 1);
-- ROLLBACK;
--
-- SELECT count(*) FROM jobs WHERE certification_requirements IS NULL;  -- 0
-- SELECT profession_key, jsonb_array_length(questions) FROM trade_questions
--   WHERE is_seeded = true;  -- 5 rows, all 3
-- SELECT count(*) FROM trade_questions WHERE is_seeded = false;  -- 0
--   (refills itself as workers with custom trades come through the
--    question-generator Lambda)
-- ============================================================
