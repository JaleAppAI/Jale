-- ============================================================
-- 118_employer_organizations.sql
-- Run manually AFTER 117_admin_queues.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
-- 116 stays free for the job-message sweeper repair.
--
-- Employer organizations, Phase 1 milestone A
-- (docs/superpowers/specs/2026-10-15-employer-organizations-design.md).
--
-- (1) MEMBERSHIP. organization_members puts every employer login in exactly
--     one company (organizations, 034) as 'owner' or 'foreman', with status
--     'active' | 'suspended' | 'removed'. One active owner per company; an
--     owner is always active. organization_invites is created empty for
--     Phase 3 (no runtime access yet).
-- (2) ORG HELPERS, owned by jale_rls_relationship_reader like 038's
--     predicate, reading only the four membership columns; every one
--     returns false / '{}' for a caller that is NULL or not a uuid:
--       jale_internal.is_org_owner_of(caller, member)  -- single-row checks
--       jale_internal.shares_org_with(caller, member)
--       jale_internal.org_owner_scope(caller, active_only) -> uuid[]
--       jale_internal.org_member_scope(caller)          -> uuid[]
--     Row policies use the array helpers as x = ANY ((SELECT ...)::uuid[]),
--     one evaluation per statement (without the cast, ANY ((SELECT ...))
--     parses as the subquery form: uuid = uuid[]). Nothing else changes
--     access in this migration (owner-wide access is 119).
-- (3) READS FOR jale_api. A login reads its own membership row; an active
--     owner reads every member row of their company. organizations stays
--     unreadable by every runtime login.
-- (4) SIGN-UP BOOTSTRAP. public.employer_ensure_organization(name), called by
--     the post-confirmation Lambda as jale_api with app.current_user_id set,
--     creates the caller's company and owner membership once; workers are
--     refused. It opens the transaction-local gate app.org_bootstrap, which
--     admits jale_admin to organizations / organization_members.
-- (4b) DISPLAY NAME. employer_display_name(person) returns the company
--     name from the active owner's employer_profiles row (unchanged for a
--     one-person company), so a foreman is shown under their company.
-- (5) ACTORS. jobs.created_by_user_id (stamped on insert from employer_id;
--     on the first employer_id change, a NULL is filled from the old
--     employer_id, so COALESCE(created_by_user_id, employer_id) is always
--     the poster; no FK, a history column);
--     job_conversation_messages.sender_user_id (stamped on insert: the
--     session's app.current_internal_user_id for an employer message, NULL
--     otherwise; an UPDATE never changes it; no FK, a history column);
--     job_application_status_events.actor_user_id (the session's
--     app.current_internal_user_id, NULL when unset or not a uuid).
-- (6) BACK-FILL. Every existing employer becomes the active owner of a
--     one-person company named after employer_profiles.company_name, else
--     users.full_name, else 'Employer'. The users read it needs
--     (users_org_bootstrap_read) exists only for the back-fill: it is
--     dropped again before COMMIT. It runs last, so the ACCESS EXCLUSIVE
--     lock its CREATE POLICY takes on users is held for the shortest time.
-- ============================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── Preconditions ───────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION 'migration 118: public.organizations (034) is missing';
  END IF;
  IF to_regclass('public.organization_members') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 118: organization_members already exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
     WHERE n.nspname = 'jale_internal' AND r.rolname = 'jale_rls_relationship_reader'
  ) THEN
    RAISE EXCEPTION 'migration 118: schema jale_internal is missing or not owned by jale_rls_relationship_reader (020b/038)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.employer_profiles'::regclass
       AND p.polname = 'employer_profiles_name_lookup'
       AND p.polcmd = 'r'
       AND p.polpermissive
       AND p.polroles = ARRAY['jale_admin'::regrole::oid]
       AND pg_get_expr(p.polqual, p.polrelid) = $q$(current_setting('app.employer_name_lookup'::text, true) = 'on'::text)$q$
  ) THEN
    RAISE EXCEPTION 'migration 118: employer_profiles_name_lookup (031) missing or drifted; the back-fill would lose company names';
  END IF;
  IF to_regprocedure('public.capture_job_application_status_event()') IS NULL THEN
    RAISE EXCEPTION 'migration 118: public.capture_job_application_status_event() (099) is missing';
  END IF;
END $$;

-- ── (1) Membership and invites ──────────────────────────────
CREATE TABLE public.organization_members (
  user_id           UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  organization_id   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  role              TEXT NOT NULL CHECK (role IN ('owner', 'foreman')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  invited_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  joined_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organization_members_owner_always_active CHECK (role <> 'owner' OR status = 'active')
);
CREATE UNIQUE INDEX organization_members_one_active_owner
  ON public.organization_members (organization_id) WHERE role = 'owner' AND status = 'active';
CREATE INDEX organization_members_by_organization ON public.organization_members (organization_id);
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members FORCE ROW LEVEL SECURITY;

CREATE TABLE public.organization_invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL CHECK (email <> '' AND email = lower(btrim(email))),
  contact_name    TEXT,
  token_hash      BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  invited_by      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  accepted_at     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  CONSTRAINT organization_invites_one_outcome CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX organization_invites_one_pending
  ON public.organization_invites (organization_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
ALTER TABLE public.organization_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invites FORCE ROW LEVEL SECURITY;
-- No policies on organization_invites: Phase 3 adds its readers and writers.

-- ── (2) Org helpers (owned by the relationship reader) ──────
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_rls_relationship_reader', current_user);
END $$;

GRANT SELECT (user_id, organization_id, role, status) ON public.organization_members TO jale_rls_relationship_reader;
CREATE POLICY organization_members_relationship_reader ON public.organization_members
  AS PERMISSIVE FOR SELECT TO jale_rls_relationship_reader
  USING (true);

SET LOCAL ROLE jale_rls_relationship_reader;

-- Every helper returns at once for a caller that is NULL or not a uuid, then
-- compares owner_row.user_id / caller_row.user_id = p_caller_id::uuid: a uuid
-- comparison the primary key serves (the column is never cast to text).

-- True when the caller is the active owner of p_member_id's company (true
-- for the owner themself). Single-row checks: the capability functions and
-- the applicant predicate (119).
CREATE FUNCTION jale_internal.is_org_owner_of(p_caller_id TEXT, p_member_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF p_caller_id IS NULL OR p_caller_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.organization_members owner_row
      JOIN public.organization_members member_row
        ON member_row.organization_id = owner_row.organization_id
     WHERE owner_row.user_id = p_caller_id::uuid
       AND owner_row.role = 'owner'
       AND owner_row.status = 'active'
       AND member_row.user_id = p_member_id
  );
END;
$fn$;

-- True when the caller is an active member of p_member_id's company. No
-- condition on the member's status: a removed or suspended member's rows
-- (templates) stay with the company.
CREATE FUNCTION jale_internal.shares_org_with(p_caller_id TEXT, p_member_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF p_caller_id IS NULL OR p_caller_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.organization_members caller_row
      JOIN public.organization_members member_row
        ON member_row.organization_id = caller_row.organization_id
     WHERE caller_row.user_id = p_caller_id::uuid
       AND caller_row.status = 'active'
       AND member_row.user_id = p_member_id
  );
END;
$fn$;

-- The active owner's company, as member user ids: every status, or only
-- status = 'active' with p_active_only. '{}' for anyone else. Row policies
-- use it as x = ANY ((SELECT ...)::uuid[]), evaluated once per statement.
CREATE FUNCTION jale_internal.org_owner_scope(p_caller_id TEXT, p_active_only BOOLEAN)
RETURNS UUID[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF p_caller_id IS NULL OR p_caller_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN '{}'::uuid[];
  END IF;
  RETURN COALESCE((
    SELECT array_agg(member_row.user_id)
      FROM public.organization_members owner_row
      JOIN public.organization_members member_row
        ON member_row.organization_id = owner_row.organization_id
     WHERE owner_row.user_id = p_caller_id::uuid
       AND owner_row.role = 'owner'
       AND owner_row.status = 'active'
       AND (NOT COALESCE(p_active_only, false) OR member_row.status = 'active')
  ), '{}'::uuid[]);
END;
$fn$;

-- An active member's company (any role), as member user ids of every
-- status. '{}' for anyone else. Company-shared reads (templates, 119).
CREATE FUNCTION jale_internal.org_member_scope(p_caller_id TEXT)
RETURNS UUID[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF p_caller_id IS NULL OR p_caller_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN '{}'::uuid[];
  END IF;
  RETURN COALESCE((
    SELECT array_agg(member_row.user_id)
      FROM public.organization_members caller_row
      JOIN public.organization_members member_row
        ON member_row.organization_id = caller_row.organization_id
     WHERE caller_row.user_id = p_caller_id::uuid
       AND caller_row.status = 'active'
  ), '{}'::uuid[]);
END;
$fn$;

REVOKE ALL ON FUNCTION jale_internal.is_org_owner_of(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_internal.shares_org_with(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_internal.org_owner_scope(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_internal.org_member_scope(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_internal.is_org_owner_of(TEXT, UUID) TO jale_admin, jale_api;
GRANT EXECUTE ON FUNCTION jale_internal.shares_org_with(TEXT, UUID) TO jale_admin, jale_api;
GRANT EXECUTE ON FUNCTION jale_internal.org_owner_scope(TEXT, BOOLEAN) TO jale_admin, jale_api;
GRANT EXECUTE ON FUNCTION jale_internal.org_member_scope(TEXT) TO jale_admin, jale_api;

RESET ROLE;

DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET FALSE', 'jale_rls_relationship_reader', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_rls_relationship_reader', current_user, current_user);
END $$;

-- ── (3) Membership reads for jale_api ───────────────────────
GRANT SELECT (user_id, organization_id, role, status, joined_at) ON public.organization_members TO jale_api;

CREATE POLICY organization_members_self_read ON public.organization_members
  AS PERMISSIVE FOR SELECT TO jale_api
  USING (user_id = (SELECT users.id FROM public.users
                     WHERE users.cognito_sub = current_setting('app.current_user_id', true)));

CREATE POLICY organization_members_owner_read ON public.organization_members
  AS PERMISSIVE FOR SELECT TO jale_api
  USING (user_id = ANY ((SELECT jale_internal.org_owner_scope(current_setting('app.current_internal_user_id', true), false))::uuid[]));

-- ── (4) Sign-up bootstrap ───────────────────────────────────
CREATE POLICY organizations_org_bootstrap ON public.organizations
  AS PERMISSIVE FOR ALL TO jale_admin
  USING (current_setting('app.org_bootstrap', true) = 'on')
  WITH CHECK (current_setting('app.org_bootstrap', true) = 'on');

CREATE POLICY organization_members_org_bootstrap ON public.organization_members
  AS PERMISSIVE FOR ALL TO jale_admin
  USING (current_setting('app.org_bootstrap', true) = 'on')
  WITH CHECK (current_setting('app.org_bootstrap', true) = 'on');

CREATE FUNCTION public.employer_ensure_organization(p_company_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_sub  TEXT := pg_catalog.current_setting('app.current_user_id', true);
  v_user UUID;
  v_type TEXT;
  v_full TEXT;
  v_org  UUID;
BEGIN
  IF v_sub IS NULL OR v_sub = '' THEN
    RAISE EXCEPTION 'employer_ensure_organization: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- users_isolation_select (002, PUBLIC) shows the caller's own row.
  SELECT u.id, u.user_type, u.full_name INTO v_user, v_type, v_full
    FROM public.users u
   WHERE u.cognito_sub = v_sub;
  IF NOT FOUND OR v_type IS DISTINCT FROM 'employer' THEN
    RAISE EXCEPTION 'employer_ensure_organization: only an employer login has a company' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM pg_catalog.set_config('app.org_bootstrap', 'on', true);

  SELECT m.organization_id INTO v_org
    FROM public.organization_members m
   WHERE m.user_id = v_user;

  IF NOT FOUND THEN
    INSERT INTO public.organizations (name)
    VALUES (COALESCE(NULLIF(pg_catalog.btrim(p_company_name), ''), NULLIF(pg_catalog.btrim(v_full), ''), 'Employer'))
    RETURNING id INTO v_org;
    INSERT INTO public.organization_members (user_id, organization_id, role, status)
    VALUES (v_user, v_org, 'owner', 'active');
  END IF;

  PERFORM pg_catalog.set_config('app.org_bootstrap', 'off', true);
  RETURN v_org;
END;
$fn$;
ALTER FUNCTION public.employer_ensure_organization(TEXT) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.employer_ensure_organization(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employer_ensure_organization(TEXT) TO jale_api;

-- ── (4b) The company name follows the owner ────────────────
-- employer_display_name (031) named a person by their own profile. A member
-- is named by their company: the active owner's employer_profiles row. For
-- today's one-person companies the owner is the person, so nothing changes.
CREATE POLICY organization_members_name_lookup ON public.organization_members
  AS PERMISSIVE FOR SELECT TO jale_admin
  USING (current_setting('app.employer_name_lookup', true) = 'on');

CREATE OR REPLACE FUNCTION employer_display_name(p_employer_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name  TEXT;
  v_owner UUID;
BEGIN
  -- Transaction-local; only definer bodies set it (031, 064, here).
  PERFORM set_config('app.employer_name_lookup', 'on', true);
  SELECT owner_row.user_id INTO v_owner
    FROM organization_members member_row
    JOIN organization_members owner_row
      ON owner_row.organization_id = member_row.organization_id
     AND owner_row.role = 'owner'
     AND owner_row.status = 'active'
   WHERE member_row.user_id = p_employer_id;
  SELECT NULLIF(ep.company_name, '')
    INTO v_name
    FROM employer_profiles ep
   WHERE ep.user_id = COALESCE(v_owner, p_employer_id);
  RETURN COALESCE(v_name, 'Empleador');
END;
$$;

-- ── (5) Actor columns ───────────────────────────────────────
-- No foreign key: a history column. An ON DELETE SET NULL would run an
-- UPDATE OF created_by_user_id, which jobs_stamp_created_by turns back into
-- the old value.
ALTER TABLE public.jobs ADD COLUMN created_by_user_id UUID;
COMMENT ON COLUMN public.jobs.created_by_user_id IS
  'Who posted the job (history; no FK, it keeps the id even after that person is deleted). NULL only for jobs created before migration 118 whose employer_id never changed: read COALESCE(created_by_user_id, employer_id).';

CREATE FUNCTION public.jobs_stamp_created_by()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by_user_id := NEW.employer_id;
  ELSE
    NEW.created_by_user_id := COALESCE(OLD.created_by_user_id, OLD.employer_id);
  END IF;
  RETURN NEW;
END;
$fn$;
ALTER FUNCTION public.jobs_stamp_created_by() OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.jobs_stamp_created_by() FROM PUBLIC;

CREATE TRIGGER jobs_stamp_created_by
  BEFORE INSERT OR UPDATE OF employer_id, created_by_user_id ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_stamp_created_by();

-- No foreign key, like jobs.created_by_user_id: a history column, and an
-- ON DELETE SET NULL would be an UPDATE OF sender_user_id, which
-- job_messages_stamp_sender turns back into the old value.
ALTER TABLE public.job_conversation_messages ADD COLUMN sender_user_id UUID;
COMMENT ON COLUMN public.job_conversation_messages.sender_user_id IS
  'The person who sent an employer message (sender_type = employer), stamped on insert by job_messages_stamp_sender from app.current_internal_user_id and never changed by an UPDATE (history; no FK, it keeps the id even after that person is deleted). NULL for worker and system messages, when that setting is unset or not a uuid, and for messages before migration 118.';

-- The database, not the caller, says who sent an employer message: the
-- session's app.current_internal_user_id (resolveEmployerActor sets it), or
-- NULL when it is unset or not a uuid. Any other sender gets NULL. A value
-- supplied by the INSERT is always overwritten, and an UPDATE keeps the
-- stamped value.
CREATE FUNCTION public.job_messages_stamp_sender()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_caller TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.sender_user_id := OLD.sender_user_id;
  ELSIF NEW.sender_type = 'employer'
     AND v_caller ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    NEW.sender_user_id := v_caller::uuid;
  ELSE
    NEW.sender_user_id := NULL;
  END IF;
  RETURN NEW;
END;
$fn$;
ALTER FUNCTION public.job_messages_stamp_sender() OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.job_messages_stamp_sender() FROM PUBLIC;

CREATE TRIGGER job_messages_stamp_sender
  BEFORE INSERT OR UPDATE OF sender_user_id ON public.job_conversation_messages
  FOR EACH ROW EXECUTE FUNCTION public.job_messages_stamp_sender();

ALTER TABLE public.job_application_status_events ADD COLUMN actor_user_id UUID;
COMMENT ON COLUMN public.job_application_status_events.actor_user_id IS
  'users.id in app.current_internal_user_id when the status changed; NULL when unset or not a uuid, and for events before migration 118. No FK: an event must never fail a status change.';

CREATE OR REPLACE FUNCTION public.capture_job_application_status_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_from   TEXT;
  v_caller TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_actor  UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_from := OLD.status;
  END IF;
  IF v_caller ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    v_actor := v_caller::uuid;
  END IF;
  INSERT INTO public.job_application_status_events (application_id, job_id, from_status, to_status, actor_user_id)
  VALUES (NEW.id, NEW.job_id, v_from, NEW.status, v_actor);
  RETURN NULL;
END;
$fn$;

-- ── (6) Back-fill: every employer owns a one-person company ──
-- Last, so the ACCESS EXCLUSIVE lock CREATE POLICY takes on users is held
-- for the shortest time before COMMIT.
-- jale_admin reads users under FORCE RLS. This policy lets it see employer
-- rows while the bootstrap gate is open; it exists only for the back-fill
-- and is dropped at the end of this section (DDL is transactional, so it
-- never exists outside this migration's transaction).
CREATE POLICY users_org_bootstrap_read ON public.users
  AS PERMISSIVE FOR SELECT TO jale_admin
  USING (current_setting('app.org_bootstrap', true) = 'on' AND user_type = 'employer');

SELECT set_config('app.org_bootstrap', 'on', true);
SELECT set_config('app.employer_name_lookup', 'on', true);

CREATE TEMP TABLE org_backfill ON COMMIT DROP AS
SELECT u.id                  AS user_id,
       gen_random_uuid()     AS organization_id,
       COALESCE(NULLIF(btrim(ep.company_name), ''), NULLIF(btrim(u.full_name), ''), 'Employer') AS name,
       u.created_at          AS joined_at
  FROM public.users u
  LEFT JOIN public.employer_profiles ep ON ep.user_id = u.id
 WHERE u.user_type = 'employer';

INSERT INTO public.organizations (id, name, created_at, updated_at)
SELECT organization_id, name, joined_at, joined_at FROM org_backfill;

INSERT INTO public.organization_members (user_id, organization_id, role, status, joined_at, status_changed_at)
SELECT user_id, organization_id, 'owner', 'active', joined_at, joined_at FROM org_backfill;

DO $$
DECLARE
  v_employers BIGINT;
  v_owners    BIGINT;
BEGIN
  SELECT count(*) INTO v_employers FROM public.users WHERE user_type = 'employer';
  SELECT count(*) INTO v_owners FROM public.organization_members WHERE role = 'owner' AND status = 'active';
  IF v_employers <> v_owners THEN
    RAISE EXCEPTION 'migration 118: back-fill made % owners for % employer users', v_owners, v_employers;
  END IF;
END $$;

SELECT set_config('app.employer_name_lookup', 'off', true);
SELECT set_config('app.org_bootstrap', 'off', true);

DROP POLICY users_org_bootstrap_read ON public.users;

-- ── Self-check ──────────────────────────────────────────────
DO $$
DECLARE
  v_sig TEXT;
BEGIN
  SET LOCAL search_path = pg_catalog, pg_temp;

  -- The four helpers: present, owned by the relationship reader, definer,
  -- stable, pinned search_path, no PUBLIC execute, executable by jale_api
  -- and jale_admin.
  FOREACH v_sig IN ARRAY ARRAY[
    'jale_internal.is_org_owner_of(text, uuid)', 'jale_internal.shares_org_with(text, uuid)',
    'jale_internal.org_owner_scope(text, boolean)', 'jale_internal.org_member_scope(text)'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'migration 118: org helper % is missing', v_sig;
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.oid = to_regprocedure(v_sig)
            AND r.rolname = 'jale_rls_relationship_reader'
            AND p.prosecdef
            AND p.provolatile = 's'
            AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::TEXT[]
       )
       OR has_function_privilege('public', to_regprocedure(v_sig), 'EXECUTE')
       OR NOT has_function_privilege('jale_api', to_regprocedure(v_sig), 'EXECUTE')
       OR NOT has_function_privilege('jale_admin', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 118: org helper % drifted', v_sig;
    END IF;
  END LOOP;

  -- The temporary SET window on the relationship reader is closed again.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member
     WHERE g.rolname = 'jale_rls_relationship_reader' AND u.rolname = current_user
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'migration 118: the jale_rls_relationship_reader SET window was left open';
  END IF;

  -- The reader sees only the four membership columns.
  IF NOT has_column_privilege('jale_rls_relationship_reader', 'public.organization_members', 'role', 'SELECT')
     OR has_column_privilege('jale_rls_relationship_reader', 'public.organization_members', 'invited_by', 'SELECT')
     OR has_table_privilege('jale_rls_relationship_reader', 'public.organization_members', 'UPDATE') THEN
    RAISE EXCEPTION 'migration 118: jale_rls_relationship_reader privileges on organization_members drifted';
  END IF;

  -- jale_api: reads membership columns, never writes; no access to organizations or invites.
  IF NOT has_column_privilege('jale_api', 'public.organization_members', 'organization_id', 'SELECT')
     OR has_table_privilege('jale_api', 'public.organization_members', 'INSERT')
     OR has_table_privilege('jale_api', 'public.organization_members', 'UPDATE')
     OR has_table_privilege('jale_api', 'public.organization_members', 'DELETE')
     OR has_any_column_privilege('jale_api', 'public.organizations', 'SELECT')
     OR has_any_column_privilege('jale_api', 'public.organization_invites', 'SELECT')
     OR has_table_privilege('jale_api', 'public.organizations', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('jale_api', 'public.organization_invites', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'migration 118: jale_api privileges on the organization tables drifted';
  END IF;

  -- No runtime login (the access manifest's login set) holds any right on
  -- organizations or organization_invites: only the definers reach them.
  FOREACH v_sig IN ARRAY ARRAY[
    'jale_api', 'jale_api_public', 'jale_job_email_sender', 'jale_job_visibility_drain', 'jale_job_digest',
    'jale_job_ses_feedback', 'jale_job_retention', 'jale_posture', 'jale_whatsapp', 'jale_ai', 'jale_billing',
    'jale_public_jobs', 'jale_matching', 'jale_admin_console'
  ] LOOP
    CONTINUE WHEN to_regrole(v_sig) IS NULL;
    IF has_table_privilege(v_sig, 'public.organizations', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_any_column_privilege(v_sig, 'public.organizations', 'SELECT, INSERT, UPDATE, REFERENCES')
       OR has_table_privilege(v_sig, 'public.organization_invites', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_any_column_privilege(v_sig, 'public.organization_invites', 'SELECT, INSERT, UPDATE, REFERENCES') THEN
      RAISE EXCEPTION 'migration 118: login % holds a right on organizations or organization_invites', v_sig;
    END IF;
  END LOOP;

  -- Exactly the reviewed policy set on the new table.
  IF (SELECT array_agg(polname ORDER BY polname) FROM pg_policy WHERE polrelid = 'public.organization_members'::regclass)
     IS DISTINCT FROM ARRAY['organization_members_name_lookup', 'organization_members_org_bootstrap', 'organization_members_owner_read',
                            'organization_members_relationship_reader', 'organization_members_self_read']::name[] THEN
    RAISE EXCEPTION 'migration 118: organization_members policy set drifted';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.organization_invites'::regclass) THEN
    RAISE EXCEPTION 'migration 118: organization_invites must have no policies yet';
  END IF;

  -- The bootstrap definer.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = to_regprocedure('public.employer_ensure_organization(text)')
       AND r.rolname = 'jale_admin' AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::TEXT[]
  ) OR has_function_privilege('public', to_regprocedure('public.employer_ensure_organization(text)'), 'EXECUTE')
     OR NOT has_function_privilege('jale_api', to_regprocedure('public.employer_ensure_organization(text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 118: employer_ensure_organization drifted';
  END IF;

  -- The replaced display-name definer keeps its owner and pinned search_path.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = to_regprocedure('public.employer_display_name(uuid)')
       AND r.rolname = 'jale_admin' AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::TEXT[]
  ) THEN
    RAISE EXCEPTION 'migration 118: employer_display_name drifted';
  END IF;

  -- The actor columns and the two stamping triggers.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.jobs'::regclass AND attname = 'created_by_user_id' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.job_conversation_messages'::regclass AND attname = 'sender_user_id' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.job_application_status_events'::regclass AND attname = 'actor_user_id' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.jobs'::regclass AND tgname = 'jobs_stamp_created_by' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.job_conversation_messages'::regclass
                       AND tgname = 'job_messages_stamp_sender' AND NOT tgisinternal
                       AND tgfoid = to_regprocedure('public.job_messages_stamp_sender()')) THEN
    RAISE EXCEPTION 'migration 118: an actor column or a stamping trigger is missing';
  END IF;
  -- job_messages_stamp_sender fires BEFORE INSERT OR UPDATE OF sender_user_id,
  -- FOR EACH ROW (tgtype ROW 1 | BEFORE 2 | INSERT 4 | UPDATE 16 = 23).
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.job_conversation_messages'::regclass
       AND t.tgname = 'job_messages_stamp_sender'
       AND t.tgenabled = 'O'
       AND t.tgtype = 23
       AND cardinality(t.tgattr::int2[]) = 1
       AND (SELECT a.attnum FROM pg_attribute a
             WHERE a.attrelid = 'public.job_conversation_messages'::regclass
               AND a.attname = 'sender_user_id') = ANY (t.tgattr::int2[])
  ) THEN
    RAISE EXCEPTION 'migration 118: job_messages_stamp_sender must fire BEFORE INSERT OR UPDATE OF sender_user_id FOR EACH ROW';
  END IF;
  -- created_by_user_id and sender_user_id are history columns: no foreign key.
  IF EXISTS (SELECT 1 FROM pg_constraint c
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
              WHERE c.contype = 'f'
                AND ((c.conrelid = 'public.jobs'::regclass AND a.attname = 'created_by_user_id')
                  OR (c.conrelid = 'public.job_conversation_messages'::regclass AND a.attname = 'sender_user_id'))) THEN
    RAISE EXCEPTION 'migration 118: jobs.created_by_user_id and job_conversation_messages.sender_user_id must have no foreign key';
  END IF;
  -- Both trigger functions: jale_admin, invoker, pinned search_path, no PUBLIC execute.
  FOREACH v_sig IN ARRAY ARRAY['public.jobs_stamp_created_by()', 'public.job_messages_stamp_sender()'] LOOP
    IF NOT EXISTS (
         SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.oid = to_regprocedure(v_sig)
            AND r.rolname = 'jale_admin' AND NOT p.prosecdef
            AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::TEXT[]
       ) OR has_function_privilege('public', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 118: trigger function % is missing or drifted', v_sig;
    END IF;
  END LOOP;

  -- The back-fill's users read is gone again.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.users'::regclass AND polname = 'users_org_bootstrap_read') THEN
    RAISE EXCEPTION 'migration 118: users_org_bootstrap_read must not outlive the back-fill';
  END IF;

  -- The gates are closed at the end of the migration.
  IF current_setting('app.org_bootstrap', true) IS DISTINCT FROM 'off'
     OR current_setting('app.employer_name_lookup', true) IS DISTINCT FROM 'off' THEN
    RAISE EXCEPTION 'migration 118: a gate was left open';
  END IF;
END $$;

COMMIT;
