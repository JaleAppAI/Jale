-- ============================================================
-- 138_org_worker_naming.sql
-- Run manually AFTER 137_user_tutorial_settings.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Employer organizations, Phase 4: worker-facing naming
-- (docs/superpowers/specs/2026-10-15-employer-organizations-design.md,
-- "What workers see", "Reassignment and removal", "Phase 4").
--
-- (1) THE DEFINERS, owned by 133's jale_cap_org_team, each SECURITY DEFINER
--     with a pinned search_path:
--       employer_contact_name (jale_api, jale_whatsapp; and its owner, which
--         calls it from org_job_moved): the person workers see for an
--         employer login, NULLIF(btrim(employer_profiles.contact_name), ''),
--         NULL without a profile. employer_profiles is keyed by user_id
--         (016), so there is at most one row. No caller check: a contact
--         name is what every worker-facing message of that employer shows;
--         nothing else of the profile is returned. STABLE: the chat picker
--         and the job detail call it per row;
--       org_job_moved (jale_api, the company's active owner): called by the
--         reassign and remove-with-reassign handlers after their jobs UPDATE
--         and before COMMIT (and before org_team_remove_member, so the old
--         holder is still a member). Refused (P0001, DETAIL
--         org_job_moved_refused) unless the caller is the active owner of
--         the company both holders are current (not removed) members of, the
--         holders differ, and every job now names the new holder; a malformed
--         argument raises 22023. Then:
--           - one system notice per OPEN conversation of the jobs (135's
--             foreign key already moved them with their job), unanswered
--             invites included: 'Conversación transferida a <n> /
--             Conversation moved to <n>', <n> the new holder's contact name
--             (every run of whitespace one space, trimmed, clipped to 80) or
--             'otro miembro' / 'another member'. created_at is
--             clock_timestamp(), so the notice sorts after any message that
--             committed while the move ran. Readers
--             are inside the company, so no company name. The row is
--             outbound, so the employer inbox's unread badge (newest inbound
--             row) is unaffected; no trigger touches job_conversations, so
--             the worker's reply window (last_worker_message_at), the read
--             mark and last_message_at stay as they were. 118's
--             job_messages_stamp_sender sets sender_user_id NULL on a system
--             row, as on every other system row;
--           - on a removal only (p_removed), hire contacts that name the old
--             holder -- hire_contact_name equal to their contact name
--             (lower, btrim), or hire_contact_phone's digits matching their
--             employer_profiles.phone's digits (the last 10 when both have at
--             least 10, else all of them; never empty) -- become the new
--             holder's cleaned contact name (as in the notice, so 125's CHECK
--             holds) with no phone: the new holder never offered their number
--             to the worker. hire_details_updated_at is stamped on exactly
--             those rows, as the employer's own save stamps it (the worker
--             and employer views date the details from it; 135's nudge claim
--             never reads it). Only the listed jobs' applications change.
--             Rows stay as they are when the new holder has no contact name;
--             a set field keeps the hire out of 135's nudge.
--         Not idempotent: a repeat call writes the notice again. Callers
--         pass only the ids their UPDATE ... RETURNING moved and skip the
--         call when none moved (an empty array is 22023).
--         Returns the number of notices written.
-- (2) NO ROW LOCKS. The handlers hold the company lock (employer_org_usage
--     (true)) for the whole transaction; this reads plainly after it.
-- (3) THE RIGHTS. Columns only, each under a permissive policy for exactly
--     the owner: open, as in 134, because org_job_moved's caller check is the
--     boundary; the message insert is limited to an outbound system row.
--     job_applications is audited (111), but hire_contact_name and
--     hire_contact_phone are not covered columns (audit-change-log.json), so
--     the re-point leaves no change record, like the employer's own
--     hire-details save.
-- No runtime login gains any right on a table.
--
-- LOCK ORDER. The functions lock no table. Everything on employer_profiles,
-- job_applications, job_conversations and job_conversation_messages (their
-- grants and policies) is the last section, parents before children. CREATE
-- POLICY takes ACCESS EXCLUSIVE on its table, so from each policy until
-- COMMIT every read and every write of job_applications, job_conversations
-- and job_conversation_messages waits. Apply in a quiet window.
-- AT RUN TIME org_job_moved runs after the handler's jobs UPDATE (row locks
-- on the moved jobs) and then updates job_applications. A worker's status
-- write locks its application first and then waits on the job through 023's
-- hired-count trigger, so the two can form a rare cycle: PostgreSQL aborts
-- one side with 40P01, which the move handlers answer as retryable (Task 6).
--
-- REPLAY: refused once jale_cap.org_job_moved exists.
-- ============================================================
BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Preconditions ────────────────────────────────────────
DO $$
BEGIN
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'migration 138: connect as the migration login itself, without SET ROLE';
  END IF;
  -- 135 as committed: conversations follow their job.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.job_conversations'::regclass AND conname = 'job_conversations_job_employer_fkey') THEN
    RAISE EXCEPTION 'migration 138: apply 135 first (job_conversations_job_employer_fkey is missing)';
  END IF;
  IF to_regprocedure('jale_cap.org_job_moved(uuid[], uuid, uuid, boolean)') IS NOT NULL
     OR to_regprocedure('jale_cap.employer_contact_name(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 138: already applied (jale_cap.org_job_moved exists); it is not re-runnable';
  END IF;
  -- 134's definers, by 133's owner.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = to_regprocedure('jale_cap.org_team_remove_member(uuid)')
                    AND r.rolname = 'jale_cap_org_team' AND p.prosecdef
                    AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'migration 138: apply 134 first (jale_cap.org_team_remove_member is missing or not jale_cap_org_team''s definer)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'jale_cap_org_team'
              AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit
                   OR r.rolreplication OR r.rolbypassrls))
     OR EXISTS (SELECT 1 FROM pg_auth_members am WHERE am.member = 'jale_cap_org_team'::regrole)
     OR NOT EXISTS (SELECT 1 FROM pg_auth_members am
                     WHERE am.roleid = 'jale_cap_org_team'::regrole
                       AND am.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                       AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option) THEN
    RAISE EXCEPTION 'migration 138: jale_cap_org_team is not as 133 left it (attributes, a membership of its own, or the migration login''s closed admin grant)';
  END IF;
  -- 134's fourteen policies for the owner, the two the new bodies read through among them.
  IF (SELECT count(*) FROM pg_policy p WHERE 'jale_cap_org_team'::regrole::oid = ANY (p.polroles)) <> 14
     OR (SELECT count(*) FROM pg_policy p
          WHERE p.polpermissive AND p.polcmd = 'r' AND p.polroles = ARRAY['jale_cap_org_team'::regrole::oid]
            AND pg_get_expr(p.polqual, p.polrelid) = 'true'
            AND (p.polrelid, p.polname) IN (
              ('public.employer_profiles'::regclass, 'employer_profiles_cap_org_team_select'),
              ('public.jobs'::regclass, 'jobs_cap_org_team_select'),
              ('public.organization_members'::regclass, 'organization_members_cap_org_team_select'))) <> 3 THEN
    RAISE EXCEPTION 'migration 138: the jale_cap_org_team policy set is not 134''s';
  END IF;
  -- The rights the bodies read through, as 133 and 134 granted them, and
  -- none yet on the four tables this migration opens.
  IF NOT has_schema_privilege('jale_cap_org_team', 'jale_cap', 'USAGE')
     OR NOT has_schema_privilege('jale_cap_org_team', 'jale_cap', 'CREATE')
     OR NOT has_schema_privilege('jale_api', 'jale_cap', 'USAGE')
     OR NOT has_schema_privilege('jale_whatsapp', 'jale_cap', 'USAGE')
     OR (SELECT array_agg(c.relname || ':' || a.attname || ':' || p.privilege
                          ORDER BY (c.relname || ':' || a.attname || ':' || p.privilege) COLLATE "C")
           FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
          WHERE c.oid IN ('public.employer_profiles'::regclass, 'public.jobs'::regclass,
                          'public.job_applications'::regclass, 'public.job_conversations'::regclass,
                          'public.job_conversation_messages'::regclass)
            AND has_column_privilege('jale_cap_org_team', c.oid, a.attname, p.privilege))
        IS DISTINCT FROM ARRAY[
    'employer_profiles:contact_name:SELECT', 'employer_profiles:user_id:SELECT',
    'jobs:employer_id:SELECT', 'jobs:id:SELECT', 'jobs:status:SELECT'
  ]::TEXT[]
     OR NOT has_column_privilege('jale_cap_org_team', 'public.organization_members', 'organization_id', 'SELECT')
     OR NOT has_column_privilege('jale_cap_org_team', 'public.organization_members', 'user_id', 'SELECT')
     OR NOT has_column_privilege('jale_cap_org_team', 'public.organization_members', 'role', 'SELECT')
     OR NOT has_column_privilege('jale_cap_org_team', 'public.organization_members', 'status', 'SELECT') THEN
    RAISE EXCEPTION 'migration 138: jale_cap_org_team''s rights are not as 134 left them';
  END IF;
  -- The columns the bodies name, and the CHECKs they write within.
  IF (SELECT count(*) FROM pg_attribute a
       WHERE NOT a.attisdropped AND a.attnum > 0
         AND ((a.attrelid = 'public.employer_profiles'::regclass AND a.attname IN ('user_id', 'contact_name', 'phone'))
           OR (a.attrelid = 'public.job_applications'::regclass
               AND a.attname IN ('id', 'job_id', 'hire_contact_name', 'hire_contact_phone', 'hire_details_updated_at'))
           OR (a.attrelid = 'public.job_conversations'::regclass AND a.attname IN ('id', 'job_id', 'status'))
           OR (a.attrelid = 'public.job_conversation_messages'::regclass
               AND a.attname IN ('conversation_id', 'sender_type', 'direction', 'body', 'status', 'created_at')))) <> 17
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.job_applications'::regclass AND c.conname = 'job_applications_hire_contact_name_check')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgrelid = 'public.job_conversation_messages'::regclass AND t.tgname = 'job_messages_stamp_sender'
                       AND t.tgfoid = to_regprocedure('public.job_messages_stamp_sender()')) THEN
    RAISE EXCEPTION 'migration 138: employer_profiles, job_applications, job_conversations or job_conversation_messages are not as expected';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy p
              WHERE p.polname IN ('job_conversations_cap_org_team_select', 'job_conversation_messages_cap_org_team_insert',
                                  'job_applications_cap_org_team_select', 'job_applications_cap_org_team_update')) THEN
    RAISE EXCEPTION 'migration 138: a 138 policy already exists';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('jale_api', 'jale_whatsapp')) <> 2 THEN
    RAISE EXCEPTION 'migration 138: a role it builds on is missing';
  END IF;
END $$;

-- ── 1. Functions ────────────────────────────────────────────
-- Created as jale_admin, closed to PUBLIC, granted to their callers before
-- the transfer (128's pattern: ALTER ... OWNER TO makes the new owner the
-- grantor), then transferred inside the owner's window. The bodies name
-- job_conversations, job_conversation_messages, job_applications and
-- employer_profiles.phone, whose rights section 2 grants: PL/pgSQL resolves
-- names when a statement first runs.

CREATE FUNCTION jale_cap.employer_contact_name(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_name TEXT;
BEGIN
  -- One row at most: employer_profiles is keyed by user_id (016).
  SELECT NULLIF(pg_catalog.btrim(ep.contact_name), '') INTO v_name
    FROM public.employer_profiles ep
   WHERE ep.user_id = p_user_id;
  RETURN v_name;
END;
$fn$;

CREATE FUNCTION jale_cap.org_job_moved(p_job_ids UUID[], p_from UUID, p_to UUID, p_removed BOOLEAN)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller  TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_jobs    UUID[];
  v_org     UUID;
  v_members INTEGER;
  v_moved   INTEGER;
  v_to_name TEXT;
  v_from_name  TEXT;
  v_from_phone TEXT;
  v_n       INTEGER;
BEGIN
  -- 1. The arguments.
  IF p_job_ids IS NULL OR pg_catalog.cardinality(p_job_ids) = 0 OR pg_catalog.array_position(p_job_ids, NULL) IS NOT NULL
     OR p_from IS NULL OR p_to IS NULL OR p_removed IS NULL THEN
    RAISE EXCEPTION 'org_job_moved: malformed argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_jobs := ARRAY(SELECT DISTINCT u FROM pg_catalog.unnest(p_job_ids) AS u);

  -- 2. The caller is the active owner of the company both holders are
  --    current members of; the holders differ; every job names the new one.
  IF v_caller ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT m.organization_id INTO v_org FROM public.organization_members m
     WHERE m.user_id = v_caller::uuid AND m.role = 'owner' AND m.status = 'active';
  END IF;
  SELECT pg_catalog.count(*)::integer INTO v_members FROM public.organization_members m
   WHERE m.organization_id = v_org AND m.user_id IN (p_from, p_to) AND m.status <> 'removed';
  SELECT pg_catalog.count(*)::integer INTO v_moved FROM public.jobs j
   WHERE j.id = ANY (v_jobs) AND j.employer_id = p_to;
  IF v_org IS NULL OR p_from = p_to OR v_members <> 2 OR v_moved <> pg_catalog.cardinality(v_jobs) THEN
    RAISE EXCEPTION 'org_job_moved: the caller is not the active owner of both holders, or a job does not name the new holder'
      USING ERRCODE = 'P0001', DETAIL = 'org_job_moved_refused';
  END IF;

  -- 3. The notice, on every open conversation of the jobs (an unanswered
  --    invite included). The readers are inside the company: no company name.
  --    The name: every run of whitespace one space, trimmed, clipped to 80,
  --    trimmed again (125's CHECK on hire_contact_name, which reuses it).
  --    clock_timestamp(): after any message that committed during the move.
  v_to_name := NULLIF(pg_catalog.btrim(pg_catalog."left"(
                 pg_catalog.btrim(pg_catalog.regexp_replace(jale_cap.employer_contact_name(p_to), '\s+', ' ', 'g')), 80)), '');
  INSERT INTO public.job_conversation_messages (conversation_id, sender_type, direction, body, status, created_at)
  SELECT jc.id, 'system', 'outbound',
         'Conversación transferida a ' || COALESCE(v_to_name, 'otro miembro')
           || ' / Conversation moved to ' || COALESCE(v_to_name, 'another member'),
         'sent', pg_catalog.clock_timestamp()
    FROM public.job_conversations jc
   WHERE jc.job_id = ANY (v_jobs) AND jc.status = 'open';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- 4. On a removal, hire contacts naming the old holder name the new one,
  --    without a phone, and the details are re-dated. Only the listed jobs'
  --    applications. Nothing changes when the new holder has no name. A
  --    phone matches on its last 10 digits when both sides have at least 10
  --    (a country code on one side only), else on all of them; never empty.
  IF p_removed AND v_to_name IS NOT NULL THEN
    v_from_name := pg_catalog.lower(jale_cap.employer_contact_name(p_from));
    SELECT NULLIF(pg_catalog.regexp_replace(ep.phone, '\D', '', 'g'), '') INTO v_from_phone
      FROM public.employer_profiles ep WHERE ep.user_id = p_from;
    UPDATE public.job_applications ja
       SET hire_contact_name = v_to_name, hire_contact_phone = NULL, hire_details_updated_at = pg_catalog.now()
      FROM (SELECT a.id,
                   NULLIF(pg_catalog.regexp_replace(a.hire_contact_phone, '\D', '', 'g'), '') AS digits
              FROM public.job_applications a
             WHERE a.job_id = ANY (v_jobs)) d
     WHERE ja.id = d.id
       AND (pg_catalog.lower(pg_catalog.btrim(ja.hire_contact_name)) = v_from_name
            OR (pg_catalog.char_length(d.digits) >= 10 AND pg_catalog.char_length(v_from_phone) >= 10
                AND pg_catalog."right"(d.digits, 10) = pg_catalog."right"(v_from_phone, 10))
            OR ((pg_catalog.char_length(d.digits) < 10 OR pg_catalog.char_length(v_from_phone) < 10)
                AND d.digits = v_from_phone));
  END IF;

  RETURN v_n;
END;
$fn$;

REVOKE ALL ON FUNCTION jale_cap.employer_contact_name(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_job_moved(uuid[], uuid, uuid, boolean) FROM PUBLIC;
-- Granted before the transfer (128 :300-304): the owner becomes the grantor.
-- The owner calls employer_contact_name from org_job_moved as its owner.
GRANT EXECUTE ON FUNCTION jale_cap.employer_contact_name(uuid) TO jale_api, jale_whatsapp;
GRANT EXECUTE ON FUNCTION jale_cap.org_job_moved(uuid[], uuid, uuid, boolean) TO jale_api;

-- Transferred to their owner inside its window (128 :306-316).
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_cap_org_team', current_user);
END $$;
ALTER FUNCTION jale_cap.employer_contact_name(uuid) OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_job_moved(uuid[], uuid, uuid, boolean) OWNER TO jale_cap_org_team;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', 'jale_cap_org_team', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_cap_org_team', current_user, current_user);
END $$;

-- ── 2. Last: profiles, applications, conversations, messages ──
-- Columns only, under policies for exactly the owner: open, as in 134,
-- because org_job_moved's caller check (the company's active owner, both
-- holders its members, every job on the new holder) is the boundary; a
-- message the owner writes is an outbound system row.
GRANT SELECT (phone) ON public.employer_profiles TO jale_cap_org_team;
GRANT SELECT (id, job_id, hire_contact_name, hire_contact_phone, hire_details_updated_at),
      UPDATE (hire_contact_name, hire_contact_phone, hire_details_updated_at)
  ON public.job_applications TO jale_cap_org_team;
CREATE POLICY job_applications_cap_org_team_select ON public.job_applications AS PERMISSIVE FOR SELECT TO jale_cap_org_team USING (true);
CREATE POLICY job_applications_cap_org_team_update ON public.job_applications AS PERMISSIVE FOR UPDATE TO jale_cap_org_team USING (true) WITH CHECK (true);
GRANT SELECT (id, job_id, status) ON public.job_conversations TO jale_cap_org_team;
CREATE POLICY job_conversations_cap_org_team_select ON public.job_conversations AS PERMISSIVE FOR SELECT TO jale_cap_org_team USING (true);
GRANT INSERT (conversation_id, sender_type, direction, body, status, created_at) ON public.job_conversation_messages TO jale_cap_org_team;
CREATE POLICY job_conversation_messages_cap_org_team_insert ON public.job_conversation_messages AS PERMISSIVE FOR INSERT TO jale_cap_org_team
  WITH CHECK (sender_type = 'system' AND direction = 'outbound');

-- ── 3. Self-check ───────────────────────────────────────────
DO $$
DECLARE
  spec     RECORD;
  fn_oid   OID;
  info     RECORD;
  offender TEXT;
  v_grants TEXT[];
BEGIN
  SET LOCAL search_path = pg_catalog, pg_temp;

  -- Both functions: owner, definer, pinned path, language, result, exactly their callers.
  FOR spec IN
    SELECT * FROM (VALUES
      ('employer_contact_name', 'p_user_id uuid', 'text', ARRAY['jale_api', 'jale_whatsapp'], 's'),
      ('org_job_moved', 'p_job_ids uuid[], p_from uuid, p_to uuid, p_removed boolean', 'integer', ARRAY['jale_api'], 'v')
    ) AS t(fn_name, fn_args, fn_result, callers, volatility)
  LOOP
    fn_oid := NULL;
    SELECT p.oid INTO fn_oid
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'jale_cap' AND p.proname = spec.fn_name
       AND pg_catalog.pg_get_function_identity_arguments(p.oid) = spec.fn_args;
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef AS definer,
           p.proconfig AS config, l.lanname AS language, pg_catalog.pg_get_function_result(p.oid) AS result,
           p.provolatile::text AS volatility
      INTO info
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE p.oid = fn_oid;
    IF fn_oid IS NULL OR info.owner_name IS DISTINCT FROM 'jale_cap_org_team' OR NOT info.definer
       OR info.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
       OR info.language <> 'plpgsql' OR info.result <> spec.fn_result OR info.volatility <> spec.volatility THEN
      RAISE EXCEPTION 'migration 138: jale_cap.% has the wrong owner, security, search_path, language, result or volatility', spec.fn_name;
    END IF;
    SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END, ', ')
      INTO offender
      FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
       AND (a.grantee = 0 OR NOT (pg_catalog.pg_get_userbyid(a.grantee) = ANY (spec.callers)));
    IF offender IS NOT NULL THEN
      RAISE EXCEPTION 'migration 138: jale_cap.% is executable by a role other than its owner and callers (%)', spec.fn_name, offender;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.unnest(spec.callers) AS c(name)
                WHERE NOT has_function_privilege(c.name, fn_oid, 'EXECUTE'))
       OR NOT has_function_privilege('jale_cap_org_team', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 138: a caller of jale_cap.% cannot execute it', spec.fn_name;
    END IF;
  END LOOP;

  -- The four new policies, for exactly the owner; eighteen in all for it.
  IF (SELECT count(*) FROM pg_policy p
       WHERE p.polpermissive AND p.polroles = ARRAY['jale_cap_org_team'::regrole::oid]
         AND ((p.polrelid = 'public.job_applications'::regclass AND p.polname = 'job_applications_cap_org_team_select'
               AND p.polcmd = 'r' AND pg_get_expr(p.polqual, p.polrelid) = 'true' AND p.polwithcheck IS NULL)
           OR (p.polrelid = 'public.job_applications'::regclass AND p.polname = 'job_applications_cap_org_team_update'
               AND p.polcmd = 'w' AND pg_get_expr(p.polqual, p.polrelid) = 'true'
               AND pg_get_expr(p.polwithcheck, p.polrelid) = 'true')
           OR (p.polrelid = 'public.job_conversations'::regclass AND p.polname = 'job_conversations_cap_org_team_select'
               AND p.polcmd = 'r' AND pg_get_expr(p.polqual, p.polrelid) = 'true' AND p.polwithcheck IS NULL)
           OR (p.polrelid = 'public.job_conversation_messages'::regclass AND p.polname = 'job_conversation_messages_cap_org_team_insert'
               AND p.polcmd = 'a' AND p.polqual IS NULL
               AND pg_get_expr(p.polwithcheck, p.polrelid) = '((sender_type = ''system''::text) AND (direction = ''outbound''::text))'))) <> 4
     OR (SELECT count(*) FROM pg_policy p WHERE 'jale_cap_org_team'::regrole::oid = ANY (p.polroles)) <> 18 THEN
    RAISE EXCEPTION 'migration 138: the jale_cap_org_team policy set is not as reviewed';
  END IF;

  -- The capability owner's column rights on the tables 138 touches.
  SELECT array_agg(c.relname || ':' || a.attname || ':' || p.privilege
                   ORDER BY (c.relname || ':' || a.attname || ':' || p.privilege) COLLATE "C")
    INTO v_grants
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
   WHERE c.oid IN ('public.employer_profiles'::regclass, 'public.job_applications'::regclass,
                   'public.job_conversations'::regclass, 'public.job_conversation_messages'::regclass)
     AND has_column_privilege('jale_cap_org_team', c.oid, a.attname, p.privilege);
  IF v_grants IS DISTINCT FROM ARRAY[
    'employer_profiles:contact_name:SELECT', 'employer_profiles:phone:SELECT', 'employer_profiles:user_id:SELECT',
    'job_applications:hire_contact_name:SELECT', 'job_applications:hire_contact_name:UPDATE',
    'job_applications:hire_contact_phone:SELECT', 'job_applications:hire_contact_phone:UPDATE',
    'job_applications:hire_details_updated_at:SELECT', 'job_applications:hire_details_updated_at:UPDATE',
    'job_applications:id:SELECT', 'job_applications:job_id:SELECT',
    'job_conversation_messages:body:INSERT', 'job_conversation_messages:conversation_id:INSERT',
    'job_conversation_messages:created_at:INSERT', 'job_conversation_messages:direction:INSERT', 'job_conversation_messages:sender_type:INSERT',
    'job_conversation_messages:status:INSERT',
    'job_conversations:id:SELECT', 'job_conversations:job_id:SELECT', 'job_conversations:status:SELECT'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'migration 138: jale_cap_org_team column rights are not as reviewed (%)', v_grants;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c
              WHERE c.relkind IN ('r', 'p') AND c.oid <> 'public.email_outbox'::regclass
                AND has_table_privilege('jale_cap_org_team', c.oid, 'DELETE, TRUNCATE, TRIGGER')) THEN
    RAISE EXCEPTION 'migration 138: jale_cap_org_team holds a table right beyond 133''s';
  END IF;

  -- The window is closed, and the owner is a member of nothing.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
     WHERE g.rolname = 'jale_cap_org_team' AND (m.set_option OR m.inherit_option)
  ) OR EXISTS (SELECT 1 FROM pg_auth_members am WHERE am.member = 'jale_cap_org_team'::regrole) THEN
    RAISE EXCEPTION 'migration 138: the jale_cap_org_team window was left open, or it is a member of a role';
  END IF;
END $$;

COMMIT;
