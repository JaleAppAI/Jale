-- ============================================================
-- 135_org_team_carry_overs.sql
-- Run manually AFTER 134_org_team_members.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Employer organizations, Phase 3 milestone A, part 3: the carry-overs
-- (docs/superpowers/specs/2026-10-15-employer-organizations-design.md,
-- "Reassignment and removal", "Removing or suspending a member", "Digest
-- emails").
--
-- (1) CONVERSATIONS FOLLOW THEIR JOB. jobs gains UNIQUE (id, employer_id),
--     and job_conversations a foreign key (job_id, employer_id) to it, ON
--     UPDATE CASCADE ON DELETE CASCADE. Changing jobs.employer_id (an owner's
--     reassignment, a remove-with-reassign) moves every conversation of the
--     job, open and closed, in the same statement, on any path. The request
--     login needs no right for it (it holds UPDATE on four other columns of
--     job_conversations only, 106): a referential action runs as the table's
--     owner and ignores row security. 105's job_conversations_application_guard
--     fires on the moved rows and passes, because the job already names the
--     new employer; the open-conversation index (job_id, employer_id,
--     worker_id) cannot collide, because all of a job's conversations move
--     together. 025's job-only cascade stays beside it.
--     In-flight job_message_outbox rows need nothing: they name a
--     conversation and the worker's number, never an employer, so they stay
--     pending, are sent to the same worker (the sweeper flushes by worker),
--     and an employer-side flush now runs as the new employer.
-- (2) THE HIRE-DETAILS NUDGE GOES TO A PERSON WHO CAN ACT. 125's
--     jale_cap.claim_hire_details_nudges keeps its signature, result, owner,
--     caller and row lock; only its final SELECT changes: employer_id and
--     employer_email are now the recipient -- the job's employer when they
--     are an active member or have no company, otherwise their company's
--     active owner (one per company, 118). A suspended or removed member is
--     never nudged while their company has its owner (always active, 118); the
--     owner gets one row per application, as before.
--     Its owner, jale_cap_hire_nudges, reads four organization_members
--     columns and the active owners' users rows for it.
-- (3) THE OWNER'S DIGEST COVERS THE COMPANY. Five permissive SELECT policies
--     for jale_job_digest, each 119's jale_api owner policy with TO
--     jale_job_digest (jobs, job_applications, employer_candidate_rankings,
--     worker_profiles, worker_skills), so listEmployerCandidates reads a
--     member's job for its company's active owner. The digest login may call
--     jale_internal.org_owner_scope and org_member_scope (the producer reads
--     org_member_scope to skip a suspended or removed member, Task 10), and
--     resolve them in jale_internal. These policies go to a login, not to a
--     capability owner.
-- NO ROW LOCK is added: the only one is 125's claim's own FOR UPDATE OF ja
-- SKIP LOCKED (two sweeps never claim one row), unchanged.
--
-- LOCK ORDER. The function and the helper grants lock no table. Last, in
-- 128's order (members before jobs): organization_members, users, the five
-- digest tables (the hottest, job_applications and jobs, last), then the
-- jobs index and unique constraint, then the conversations foreign key,
-- whose validation reads every conversation once. job_conversations gains a
-- (job_id, employer_id) index first: a move of many jobs (remove-with-
-- reassign) and both delete cascades look a job's conversations up by it.
-- CREATE POLICY takes ACCESS EXCLUSIVE on its table, so from each policy
-- until COMMIT every read and every write of organization_members, users
-- and the five digest tables (jobs and job_applications included) waits,
-- through the jobs unique-index build, the conversations index build and
-- the foreign key's validation. Writes to job_conversations wait from its
-- index build until COMMIT. Apply in a quiet window.
-- The policies stay ahead of the indexes and the foreign key: attaching the
-- unique constraint takes ACCESS EXCLUSIVE on jobs, so building them first
-- would lock jobs before organization_members and users (against 128's
-- order) and hold the hottest table through every policy.
--
-- DRY RUN. The preconditions count conversations that name another
-- employer than their job's (105's guard has refused new ones since 105) and
-- refuse with the count; ADD CONSTRAINT would abort on the first one with
-- 23503 anyway.
--
-- REPLAY: refused once job_conversations_job_employer_fkey (or
-- jobs_id_employer_id_key, or job_conversations_job_id_employer_id_idx) exists.
-- ============================================================
BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Preconditions ────────────────────────────────────────
DO $$
DECLARE
  v_mismatched BIGINT;
BEGIN
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'migration 135: connect as the migration login itself, without SET ROLE';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.job_conversations'::regclass AND conname = 'job_conversations_job_employer_fkey')
     OR EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_id_employer_id_key')
     OR to_regclass('public.jobs_id_employer_id_key') IS NOT NULL
     OR to_regclass('public.job_conversations_job_id_employer_id_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 135: already applied (job_conversations_job_employer_fkey exists); it is not re-runnable';
  END IF;
  -- 134 as committed.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure('jale_cap.org_team_remove_member(uuid)')
                    AND r.rolname = 'jale_cap_org_team' AND p.prosecdef)
     OR to_regprocedure('jale_cap.org_member_access(uuid, timestamp with time zone, integer)') IS NULL THEN
    RAISE EXCEPTION 'migration 135: apply 134 first (jale_cap.org_team_remove_member is missing or not jale_cap_org_team''s definer)';
  END IF;
  -- 105's guard, enabled, and 025's job-only cascade.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.job_conversations'::regclass
                    AND t.tgname = 'job_conversations_application_guard' AND t.tgenabled = 'O'
                    AND t.tgfoid = to_regprocedure('jale_cap.job_conversation_application_guard()'))
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.job_conversations'::regclass AND c.conname = 'job_conversations_job_id_fkey'
                       AND pg_get_constraintdef(c.oid) = 'FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE') THEN
    RAISE EXCEPTION 'migration 135: 105''s job_conversations_application_guard or 025''s job_conversations_job_id_fkey is missing or disabled';
  END IF;
  -- 125's claim, exactly: its owner's definer, its result, its one caller.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure('jale_cap.claim_hire_details_nudges(integer)')
                    AND r.rolname = 'jale_cap_hire_nudges' AND p.prosecdef
                    AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
                    AND pg_get_function_result(p.oid) = 'TABLE(application_id uuid, job_id uuid, employer_id uuid, employer_email text, worker_name text, job_title text, kind text, requested_at timestamp with time zone)')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = to_regprocedure('jale_cap.claim_hire_details_nudges(integer)')
                   AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
                   AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) <> 'jale_job_digest'))
     OR NOT has_function_privilege('jale_job_digest', 'jale_cap.claim_hire_details_nudges(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 135: 125''s jale_cap.claim_hire_details_nudges is missing or not as 125 left it';
  END IF;
  -- The two owners whose windows open here: safe attributes, a member of
  -- nothing, and the migration login's closed admin grant.
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'jale_cap_hire_nudges'
              AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit
                   OR r.rolreplication OR r.rolbypassrls))
     OR EXISTS (SELECT 1 FROM pg_auth_members am WHERE am.member = 'jale_cap_hire_nudges'::regrole)
     OR (SELECT count(*) FROM pg_auth_members am
          WHERE am.roleid IN ('jale_cap_hire_nudges'::regrole, 'jale_rls_relationship_reader'::regrole)
            AND am.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
            AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option) <> 2 THEN
    RAISE EXCEPTION 'migration 135: jale_cap_hire_nudges or jale_rls_relationship_reader is not as left (attributes, a membership of its own, or the migration login''s closed admin grant)';
  END IF;
  -- The nudge owner's policies are 125's five, and it reads no organization_members column yet.
  IF (SELECT count(*) FROM pg_policy p WHERE 'jale_cap_hire_nudges'::regrole::oid = ANY (p.polroles)) <> 5
     OR EXISTS (SELECT 1 FROM pg_attribute a
                 WHERE a.attrelid = 'public.organization_members'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                   AND has_column_privilege('jale_cap_hire_nudges', a.attrelid, a.attname, 'SELECT')) THEN
    RAISE EXCEPTION 'migration 135: jale_cap_hire_nudges''s policies or rights are not as 125 left them';
  END IF;
  -- The org helpers (118) and the five 119 policies the digest policies copy.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure('jale_internal.org_owner_scope(text, boolean)')
                    AND r.rolname = 'jale_rls_relationship_reader')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                     WHERE p.oid = to_regprocedure('jale_internal.org_member_scope(text)')
                       AND r.rolname = 'jale_rls_relationship_reader')
     OR (SELECT count(*) FROM pg_policy p
          WHERE p.polpermissive AND p.polcmd = 'r' AND p.polroles = ARRAY['jale_api'::regrole::oid]
            AND (p.polrelid, p.polname) IN (
              ('public.jobs'::regclass, 'jobs_org_owner_select'),
              ('public.job_applications'::regclass, 'applications_org_owner_select'),
              ('public.employer_candidate_rankings'::regclass, 'employer_candidate_rankings_org_owner_read'),
              ('public.worker_profiles'::regclass, 'worker_profiles_org_owner_read'),
              ('public.worker_skills'::regclass, 'worker_skills_org_owner_read'))) <> 5
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jale_job_digest') THEN
    RAISE EXCEPTION 'migration 135: 118''s org helpers, 119''s owner policies or jale_job_digest are missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy p
              WHERE p.polname IN ('organization_members_cap_hire_nudges_select', 'users_cap_hire_nudges_org_owner_select',
                                  'jobs_job_digest_org_owner_select', 'applications_job_digest_org_owner_select',
                                  'employer_candidate_rankings_job_digest_org_owner_read',
                                  'worker_profiles_job_digest_org_owner_read', 'worker_skills_job_digest_org_owner_read')) THEN
    RAISE EXCEPTION 'migration 135: a 135 policy already exists';
  END IF;

  -- The dry run: every conversation must already name its job's employer.
  -- The migration login reads both tables under FORCE ROW LEVEL SECURITY, so
  -- the count goes through the admin analytics read policies (jobs' from 089,
  -- job_conversations' from 114), opened
  -- for this one statement and closed again; both must be there, or the
  -- count would be a silent zero.
  IF (SELECT count(*) FROM pg_policy p
       WHERE p.polcmd = 'r' AND p.polpermissive AND p.polroles = ARRAY['jale_admin'::regrole::oid]
         AND pg_get_expr(p.polqual, p.polrelid) = '(current_setting(''app.admin_analytics_read''::text, true) = ''on''::text)'
         AND (p.polrelid, p.polname) IN (('public.jobs'::regclass, 'jobs_admin_analytics_read'),
                                         ('public.job_conversations'::regclass, 'job_conversations_admin_analytics_read'))) <> 2 THEN
    RAISE EXCEPTION 'migration 135: the admin analytics read policies on jobs (089) and job_conversations (114) are missing; the dry run cannot see the rows';
  END IF;
  PERFORM set_config('app.admin_analytics_read', 'on', true);
  SELECT count(*) INTO v_mismatched
    FROM public.job_conversations jc
    LEFT JOIN public.jobs j ON j.id = jc.job_id
   WHERE j.employer_id IS DISTINCT FROM jc.employer_id;
  PERFORM set_config('app.admin_analytics_read', 'off', true);
  IF v_mismatched <> 0 THEN
    RAISE EXCEPTION 'migration 135: % conversation(s) name another employer than their job''s; fix them with support before applying', v_mismatched;
  END IF;
END $$;

-- ── 1. The nudge goes to someone who can act ────────────────
-- Replaced by its 125 owner inside its window (119's pattern): owner, EXECUTE
-- grant and signature are kept. 125 :717-778, with only the final SELECT's
-- recipient changed (marked).
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_cap_hire_nudges', current_user);
END $$;
SET LOCAL ROLE jale_cap_hire_nudges;

CREATE OR REPLACE FUNCTION jale_cap.claim_hire_details_nudges(
  p_limit INTEGER
)
RETURNS TABLE (
  application_id UUID,
  job_id         UUID,
  employer_id    UUID,
  employer_email TEXT,
  worker_name    TEXT,
  job_title      TEXT,
  kind           TEXT,
  requested_at   TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'claim_hire_details_nudges: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Returns and locks the due rows; stamps nothing. The caller stamps each
  -- row with mark_hire_details_nudged once its email is queued, in the same
  -- transaction, so a row whose email never went stays due.
  RETURN QUERY
  WITH due AS MATERIALIZED (
    SELECT ja.id, ja.job_id, ja.worker_id,
           COALESCE(ja.hire_details_reminded_at, ja.hired_at) AS due_at,
           CASE WHEN ja.hire_details_reminded_at IS NOT NULL
                     AND (ja.hire_details_nudged_at IS NULL
                          OR ja.hire_details_reminded_at > ja.hire_details_nudged_at)
                THEN 'remind' ELSE 'auto' END AS nudge_kind,
           ja.hire_details_reminded_at AS reminded_at
      FROM public.job_applications ja
     WHERE ja.status = 'hired'
       AND ja.hire_start_date IS NULL
       AND ja.hire_report_location IS NULL
       AND ja.hire_contact_name IS NULL
       AND ja.hire_contact_phone IS NULL
       AND ja.hire_notes IS NULL
       AND ((ja.hire_details_nudged_at IS NULL
             AND ja.hired_at <= pg_catalog.now() - interval '24 hours'
             AND ja.hired_at > pg_catalog.now() - interval '7 days')
         OR (ja.hire_details_reminded_at IS NOT NULL
             AND (ja.hire_details_nudged_at IS NULL OR ja.hire_details_reminded_at > ja.hire_details_nudged_at)))
     ORDER BY COALESCE(ja.hire_details_reminded_at, ja.hired_at), ja.id
     LIMIT p_limit
       FOR UPDATE OF ja SKIP LOCKED
  )
  -- 135: the recipient. The job's employer when they are an active member
  -- or have no company; otherwise (suspended or removed) their company's
  -- active owner -- at most one per company (118), so still one row per
  -- application. A company with no active owner falls back to the employer.
  SELECT d.id, d.job_id, r.id, r.email,
         COALESCE(NULLIF(pg_catalog.btrim(wp.full_name), ''), NULLIF(pg_catalog.btrim(w.full_name), '')),
         j.title, d.nudge_kind, d.reminded_at
    FROM due d
    JOIN public.jobs j ON j.id = d.job_id
    LEFT JOIN public.organization_members em ON em.user_id = j.employer_id
    LEFT JOIN public.organization_members om
           ON om.organization_id = em.organization_id AND om.role = 'owner' AND om.status = 'active'
    JOIN public.users r
      ON r.id = CASE WHEN em.user_id IS NULL OR em.status = 'active' THEN j.employer_id
                     ELSE COALESCE(om.user_id, j.employer_id) END
    LEFT JOIN public.users w ON w.id = d.worker_id
    LEFT JOIN public.worker_profiles wp ON wp.user_id = d.worker_id
   ORDER BY d.due_at, d.id;
END;
$fn$;

RESET ROLE;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', 'jale_cap_hire_nudges', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_cap_hire_nudges', current_user, current_user);
END $$;

-- ── 2. The digest login's org helpers ───────────────────────
-- Only the helpers' owner may grant them (129's pattern). USAGE lets the
-- producer call org_member_scope by name (Task 10); the policies below call
-- org_owner_scope.
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_rls_relationship_reader', current_user);
END $$;
SET LOCAL ROLE jale_rls_relationship_reader;
GRANT USAGE ON SCHEMA jale_internal TO jale_job_digest;
GRANT EXECUTE ON FUNCTION jale_internal.org_owner_scope(TEXT, BOOLEAN) TO jale_job_digest;
GRANT EXECUTE ON FUNCTION jale_internal.org_member_scope(TEXT) TO jale_job_digest;
RESET ROLE;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', 'jale_rls_relationship_reader', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_rls_relationship_reader', current_user, current_user);
END $$;

-- ── 3. Last: members, users, the digest tables, jobs, conversations ──
-- The nudge's recipient: the job's member and their company's active owner.
-- Open, like 125's own policies: the claim has no caller, and its due rows
-- are the boundary.
GRANT SELECT (user_id, organization_id, role, status) ON public.organization_members TO jale_cap_hire_nudges;
CREATE POLICY organization_members_cap_hire_nudges_select ON public.organization_members
  AS PERMISSIVE FOR SELECT TO jale_cap_hire_nudges
  USING (true);
-- An owner with no job of their own is not in 125's users_cap_hire_nudges_select.
CREATE POLICY users_cap_hire_nudges_org_owner_select ON public.users
  AS PERMISSIVE FOR SELECT TO jale_cap_hire_nudges
  USING (id IN (SELECT m.user_id FROM public.organization_members m WHERE m.role = 'owner' AND m.status = 'active'));

-- The owner's digest: 119's jale_api owner policies, for jale_job_digest.
CREATE POLICY employer_candidate_rankings_job_digest_org_owner_read ON public.employer_candidate_rankings AS PERMISSIVE FOR SELECT TO jale_job_digest
  USING (EXISTS (SELECT 1 FROM public.jobs j
                  WHERE j.id = employer_candidate_rankings.job_id
                    AND j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));
CREATE POLICY worker_profiles_job_digest_org_owner_read ON public.worker_profiles AS PERMISSIVE FOR SELECT TO jale_job_digest
  USING (EXISTS (SELECT 1 FROM public.job_applications ja JOIN public.jobs j ON j.id = ja.job_id
                  WHERE ja.worker_id = worker_profiles.user_id
                    AND j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));
CREATE POLICY worker_skills_job_digest_org_owner_read ON public.worker_skills AS PERMISSIVE FOR SELECT TO jale_job_digest
  USING (EXISTS (SELECT 1 FROM public.job_applications ja JOIN public.jobs j ON j.id = ja.job_id
                  WHERE ja.worker_id = worker_skills.worker_id
                    AND j.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));
CREATE POLICY applications_job_digest_org_owner_select ON public.job_applications AS PERMISSIVE FOR SELECT TO jale_job_digest
  USING (job_id IN (SELECT jobs.id FROM public.jobs
                     WHERE jobs.employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[])));
CREATE POLICY jobs_job_digest_org_owner_select ON public.jobs AS PERMISSIVE FOR SELECT TO jale_job_digest
  USING (employer_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]));

-- The key the conversations reference: built, then attached.
CREATE UNIQUE INDEX jobs_id_employer_id_key ON public.jobs (id, employer_id);
ALTER TABLE public.jobs ADD CONSTRAINT jobs_id_employer_id_key UNIQUE USING INDEX jobs_id_employer_id_key;

-- The referencing side's lookup: every key change or delete on jobs finds
-- the job's conversations by it (025's job_id cascade had no index either).
CREATE INDEX job_conversations_job_id_employer_id_idx ON public.job_conversations (job_id, employer_id);

-- Validated in this statement: a mismatched row aborts with 23503.
ALTER TABLE public.job_conversations
  ADD CONSTRAINT job_conversations_job_employer_fkey FOREIGN KEY (job_id, employer_id)
  REFERENCES public.jobs (id, employer_id) ON UPDATE CASCADE ON DELETE CASCADE;

-- ── 4. Self-check ───────────────────────────────────────────
DO $$
DECLARE
  spec     RECORD;
  info     RECORD;
  offender TEXT;
  v_grants TEXT[];
BEGIN
  SET LOCAL search_path = pg_catalog, pg_temp;

  -- The key and the foreign key, exactly, and validated.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.jobs'::regclass AND c.conname = 'jobs_id_employer_id_key'
                    AND c.contype = 'u' AND c.convalidated
                    AND pg_get_constraintdef(c.oid) = 'UNIQUE (id, employer_id)')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.job_conversations'::regclass AND c.conname = 'job_conversations_job_employer_fkey'
                       AND c.contype = 'f' AND c.convalidated AND NOT c.condeferrable
                       AND c.confrelid = 'public.jobs'::regclass
                       AND pg_get_constraintdef(c.oid) = 'FOREIGN KEY (job_id, employer_id) REFERENCES public.jobs(id, employer_id) ON UPDATE CASCADE ON DELETE CASCADE') THEN
    RAISE EXCEPTION 'migration 135: jobs_id_employer_id_key or job_conversations_job_employer_fkey is missing, drifted or not validated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'job_conversations_job_id_employer_id_idx'
                  AND indexdef = 'CREATE INDEX job_conversations_job_id_employer_id_idx ON public.job_conversations USING btree (job_id, employer_id)') THEN
    RAISE EXCEPTION 'migration 135: job_conversations_job_id_employer_id_idx is missing or drifted';
  END IF;

  -- The claim: 125's owner, definer, path, language, result and one caller,
  -- now routing the recipient.
  SELECT pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef AS definer, p.proconfig AS config,
         l.lanname AS language, pg_get_function_result(p.oid) AS result, p.prosrc AS src
    INTO info
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = to_regprocedure('jale_cap.claim_hire_details_nudges(integer)');
  IF info.owner_name IS DISTINCT FROM 'jale_cap_hire_nudges' OR NOT info.definer
     OR info.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] OR info.language <> 'plpgsql'
     OR info.result <> 'TABLE(application_id uuid, job_id uuid, employer_id uuid, employer_email text, worker_name text, job_title text, kind text, requested_at timestamp with time zone)'
     OR position('LEFT JOIN public.organization_members em ON em.user_id = j.employer_id' IN info.src) = 0
     OR position('SKIP LOCKED' IN info.src) = 0 THEN
    RAISE EXCEPTION 'migration 135: jale_cap.claim_hire_details_nudges has the wrong owner, security, search_path, result or body';
  END IF;
  SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ')
    INTO offender
    FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
   WHERE p.oid = to_regprocedure('jale_cap.claim_hire_details_nudges(integer)') AND a.privilege_type = 'EXECUTE'
     AND a.grantee <> p.proowner AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) <> 'jale_job_digest');
  IF offender IS NOT NULL
     OR NOT has_function_privilege('jale_job_digest', 'jale_cap.claim_hire_details_nudges(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 135: jale_cap.claim_hire_details_nudges is not executable by exactly jale_job_digest (%)', offender;
  END IF;

  -- The nudge owner's two new policies, open where 125's are, seven in all.
  -- (Deparsed under this block's search_path, so the table is qualified.)
  IF (SELECT count(*) FROM pg_policy p
       WHERE p.polpermissive AND p.polcmd = 'r' AND p.polroles = ARRAY['jale_cap_hire_nudges'::regrole::oid]
         AND p.polwithcheck IS NULL
         AND ((p.polrelid = 'public.organization_members'::regclass AND p.polname = 'organization_members_cap_hire_nudges_select'
               AND pg_get_expr(p.polqual, p.polrelid) = 'true')
           OR (p.polrelid = 'public.users'::regclass AND p.polname = 'users_cap_hire_nudges_org_owner_select'
               AND pg_get_expr(p.polqual, p.polrelid) = '(id IN ( SELECT m.user_id
   FROM public.organization_members m
  WHERE ((m.role = ''owner''::text) AND (m.status = ''active''::text))))'))) <> 2
     OR (SELECT count(*) FROM pg_policy p WHERE 'jale_cap_hire_nudges'::regrole::oid = ANY (p.polroles)) <> 7 THEN
    RAISE EXCEPTION 'migration 135: the jale_cap_hire_nudges policy set is not as reviewed';
  END IF;
  SELECT array_agg(a.attname || ':' || p.privilege ORDER BY (a.attname || ':' || p.privilege) COLLATE "C")
    INTO v_grants
    FROM pg_attribute a
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
   WHERE a.attrelid = 'public.organization_members'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege('jale_cap_hire_nudges', a.attrelid, a.attname, p.privilege);
  IF v_grants IS DISTINCT FROM ARRAY['organization_id:SELECT', 'role:SELECT', 'status:SELECT', 'user_id:SELECT']::TEXT[] THEN
    RAISE EXCEPTION 'migration 135: jale_cap_hire_nudges organization_members rights are not as reviewed (%)', v_grants;
  END IF;

  -- The five digest policies: each 119's jale_api twin, for jale_job_digest only.
  FOR spec IN
    SELECT * FROM (VALUES
      ('public.jobs', 'jobs_job_digest_org_owner_select', 'jobs_org_owner_select'),
      ('public.job_applications', 'applications_job_digest_org_owner_select', 'applications_org_owner_select'),
      ('public.employer_candidate_rankings', 'employer_candidate_rankings_job_digest_org_owner_read', 'employer_candidate_rankings_org_owner_read'),
      ('public.worker_profiles', 'worker_profiles_job_digest_org_owner_read', 'worker_profiles_org_owner_read'),
      ('public.worker_skills', 'worker_skills_job_digest_org_owner_read', 'worker_skills_org_owner_read')
    ) AS t(rel, pol, twin)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
        JOIN pg_policy t ON t.polrelid = p.polrelid AND t.polname = spec.twin
       WHERE p.polrelid = spec.rel::regclass AND p.polname = spec.pol
         AND p.polpermissive AND p.polcmd = 'r' AND p.polwithcheck IS NULL
         AND p.polroles = ARRAY['jale_job_digest'::regrole::oid]
         AND t.polroles = ARRAY['jale_api'::regrole::oid] AND t.polcmd = 'r'
         AND pg_get_expr(p.polqual, p.polrelid) = pg_get_expr(t.polqual, t.polrelid)) THEN
      RAISE EXCEPTION 'migration 135: % is missing or is not 119''s % for jale_job_digest', spec.pol, spec.twin;
    END IF;
  END LOOP;

  -- The digest login reaches the two helpers, and nothing more in jale_internal.
  IF NOT has_schema_privilege('jale_job_digest', 'jale_internal', 'USAGE')
     OR has_schema_privilege('jale_job_digest', 'jale_internal', 'CREATE')
     OR NOT has_function_privilege('jale_job_digest', 'jale_internal.org_owner_scope(text, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('jale_job_digest', 'jale_internal.org_member_scope(text)', 'EXECUTE')
     OR has_function_privilege('jale_job_digest', 'jale_internal.is_org_owner_of(text, uuid)', 'EXECUTE')
     OR has_function_privilege('jale_job_digest', 'jale_internal.shares_org_with(text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 135: jale_job_digest''s reach into jale_internal is not as reviewed';
  END IF;

  -- Both windows are closed, and the nudge owner is a member of nothing.
  IF EXISTS (SELECT 1 FROM pg_auth_members m
              WHERE m.roleid IN ('jale_cap_hire_nudges'::regrole, 'jale_rls_relationship_reader'::regrole)
                AND (m.set_option OR m.inherit_option))
     OR EXISTS (SELECT 1 FROM pg_auth_members am WHERE am.member = 'jale_cap_hire_nudges'::regrole) THEN
    RAISE EXCEPTION 'migration 135: the jale_cap_hire_nudges or jale_rls_relationship_reader window was left open';
  END IF;
END $$;

COMMIT;
