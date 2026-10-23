-- ============================================================
-- 134_org_team_members.sql
-- Run manually AFTER 133_org_team_invites.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Employer organizations, Phase 3 milestone A, part 2: member removal, the
-- owner's team lists, the caller's membership and the desired Cognito state
-- (docs/superpowers/specs/2026-10-15-employer-organizations-design.md,
-- "Reassignment and removal", "Removing or suspending a member").
--
-- (1) THE DEFINERS, owned by 133's jale_cap_org_team, each SECURITY DEFINER
--     with a pinned search_path and exactly one caller:
--       org_team_remove_member (jale_api, the company's active owner): takes
--         the company lock through 133's org_team_locked_owner_org(), then
--         removes a foreman who has no job left; outcomes removed, not_owner,
--         not_found, is_owner, already_removed, has_jobs. It moves no job:
--         remove-with-reassign (Task 9's handler) moves them first, in the
--         same transaction and under the same company lock;
--       org_team_members / org_team_invites (jale_api, the company's active
--         owner, 42501 otherwise): the Team page's lists, read only, no lock;
--         removed members are left out of the members list (least privilege:
--         the owner never receives a removed member's email, and the list
--         stays bounded);
--       org_team_membership (jale_api, any employer login): the caller's own
--         membership in any status, zero rows without one;
--       org_member_access (jale_billing): the Cognito state every foreman
--         should have, by company or changed since a time (the catch-up
--         sync), for the billing processor and the team handlers to apply
--         after COMMIT. Owners are never listed.
-- (2) NO ROW LOCKS. As in 133: the only lock is the company row's (128's
--     order, organizations first); the reads after it are plain, and the one
--     UPDATE names the member already classified and checks ROW_COUNT = 1.
-- (3) THE BILLING MARK. A removal clears billing_suspended_at (128's CHECK
--     allows the mark only on a suspended row).
-- (4) THE INVITES INDEX. organization_invites (organization_id, email), for
--     member access and membership, which read a company's invites for an
--     email whatever their state (133's one-pending index covers pending
--     invites only).
-- No runtime login gains any right on a table.
--
-- LOCK ORDER (128's: organizations, invites, members, jobs). The invites
-- index comes before everything on employer_profiles, jobs and users (their
-- grants and policies), which is the last section.
--
-- REPLAY: refused once jale_cap.org_team_remove_member exists.
-- ============================================================
BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Preconditions ────────────────────────────────────────
DO $$
BEGIN
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'migration 134: connect as the migration login itself, without SET ROLE';
  END IF;
  IF to_regprocedure('jale_cap.org_team_remove_member(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 134: already applied (jale_cap.org_team_remove_member exists); it is not re-runnable';
  END IF;
  -- 133 as committed: its owner, its company-lock helper and its accept.
  IF to_regprocedure('jale_cap.org_team_invite_accept(bytea)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                     WHERE p.oid = to_regprocedure('jale_cap.org_team_locked_owner_org()')
                       AND r.rolname = 'jale_cap_org_team' AND p.prosecdef
                       AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
                       AND pg_get_function_result(p.oid) = 'uuid') THEN
    RAISE EXCEPTION 'migration 134: apply 133 first (jale_cap.org_team_locked_owner_org is missing or not jale_cap_org_team''s definer)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'jale_cap_org_team'
              AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit
                   OR r.rolreplication OR r.rolbypassrls))
     OR EXISTS (SELECT 1 FROM pg_auth_members am WHERE am.member = 'jale_cap_org_team'::regrole)
     OR NOT EXISTS (SELECT 1 FROM pg_auth_members am
                     WHERE am.roleid = 'jale_cap_org_team'::regrole
                       AND am.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                       AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option) THEN
    RAISE EXCEPTION 'migration 134: jale_cap_org_team is not as 133 left it (attributes, a membership of its own, or the migration login''s closed admin grant)';
  END IF;
  -- 133's twelve policies, the company lock's among them, and no other for the owner.
  IF (SELECT count(*) FROM pg_policy p
       WHERE p.polpermissive AND p.polroles = ARRAY['jale_cap_org_team'::regrole::oid]
         AND (p.polrelid, p.polname) IN (
           ('public.organizations'::regclass, 'organizations_cap_org_team_select'),
           ('public.organizations'::regclass, 'organizations_cap_org_team_lock'),
           ('public.organization_invites'::regclass, 'organization_invites_cap_org_team_select'),
           ('public.organization_invites'::regclass, 'organization_invites_cap_org_team_insert'),
           ('public.organization_invites'::regclass, 'organization_invites_cap_org_team_update'),
           ('public.organization_members'::regclass, 'organization_members_cap_org_team_select'),
           ('public.organization_members'::regclass, 'organization_members_cap_org_team_insert'),
           ('public.organization_members'::regclass, 'organization_members_cap_org_team_update'),
           ('public.users'::regclass, 'users_cap_org_team_select'),
           ('public.email_outbox'::regclass, 'email_outbox_cap_org_team_select'),
           ('public.email_outbox'::regclass, 'email_outbox_cap_org_team_insert'),
           ('public.email_outbox'::regclass, 'email_outbox_cap_org_team_delete'))) <> 12
     OR (SELECT count(*) FROM pg_policy p WHERE 'jale_cap_org_team'::regrole::oid = ANY (p.polroles)) <> 12 THEN
    RAISE EXCEPTION 'migration 134: the jale_cap_org_team policy set is not 133''s';
  END IF;
  -- The rights the bodies read through, exactly as 133 granted them (133's
  -- self-check array), and none yet on employer_profiles or jobs.
  IF NOT has_schema_privilege('jale_cap_org_team', 'jale_cap', 'USAGE')
     OR NOT has_schema_privilege('jale_cap_org_team', 'jale_cap', 'CREATE')
     OR NOT has_schema_privilege('jale_billing', 'jale_cap', 'USAGE')
     OR NOT has_function_privilege('jale_cap_org_team', 'public.employer_display_name(uuid)', 'EXECUTE')
     OR (SELECT array_agg(c.relname || ':' || a.attname || ':' || p.privilege
                          ORDER BY (c.relname || ':' || a.attname || ':' || p.privilege) COLLATE "C")
           FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
          WHERE c.oid IN ('public.organizations'::regclass, 'public.organization_invites'::regclass,
                          'public.organization_members'::regclass, 'public.users'::regclass, 'public.email_outbox'::regclass,
                          'public.employer_profiles'::regclass, 'public.jobs'::regclass)
            AND has_column_privilege('jale_cap_org_team', c.oid, a.attname, p.privilege))
        IS DISTINCT FROM ARRAY[
    'email_outbox:attempt_count:SELECT', 'email_outbox:body_html:INSERT', 'email_outbox:body_text:INSERT',
    'email_outbox:created_at:SELECT', 'email_outbox:id:SELECT', 'email_outbox:idempotency_key:INSERT',
    'email_outbox:recipient_email:INSERT', 'email_outbox:source_id:INSERT', 'email_outbox:source_id:SELECT',
    'email_outbox:source_type:INSERT', 'email_outbox:source_type:SELECT', 'email_outbox:status:SELECT',
    'email_outbox:subject:INSERT',
    'organization_invites:accepted_at:SELECT', 'organization_invites:accepted_at:UPDATE',
    'organization_invites:contact_name:INSERT', 'organization_invites:contact_name:SELECT',
    'organization_invites:created_at:SELECT', 'organization_invites:email:INSERT', 'organization_invites:email:SELECT',
    'organization_invites:expires_at:INSERT', 'organization_invites:expires_at:SELECT', 'organization_invites:expires_at:UPDATE',
    'organization_invites:id:SELECT', 'organization_invites:invited_by:INSERT', 'organization_invites:invited_by:SELECT',
    'organization_invites:last_sent_at:INSERT', 'organization_invites:last_sent_at:SELECT', 'organization_invites:last_sent_at:UPDATE',
    'organization_invites:organization_id:INSERT', 'organization_invites:organization_id:SELECT',
    'organization_invites:revoked_at:SELECT', 'organization_invites:revoked_at:UPDATE',
    'organization_invites:token_hash:INSERT', 'organization_invites:token_hash:SELECT', 'organization_invites:token_hash:UPDATE',
    'organization_members:billing_suspended_at:SELECT', 'organization_members:billing_suspended_at:UPDATE',
    'organization_members:invited_by:INSERT', 'organization_members:invited_by:SELECT', 'organization_members:invited_by:UPDATE',
    'organization_members:joined_at:INSERT', 'organization_members:joined_at:SELECT', 'organization_members:joined_at:UPDATE',
    'organization_members:organization_id:INSERT', 'organization_members:organization_id:SELECT',
    'organization_members:role:INSERT', 'organization_members:role:SELECT',
    'organization_members:status:INSERT', 'organization_members:status:SELECT', 'organization_members:status:UPDATE',
    'organization_members:status_changed_at:INSERT', 'organization_members:status_changed_at:SELECT',
    'organization_members:status_changed_at:UPDATE',
    'organization_members:user_id:INSERT', 'organization_members:user_id:SELECT',
    'organizations:id:SELECT', 'organizations:updated_at:UPDATE',
    'users:cognito_sub:SELECT', 'users:email:SELECT', 'users:id:SELECT', 'users:user_type:SELECT'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'migration 134: jale_cap_org_team''s rights are not as 133 left them';
  END IF;
  -- 128: the enforcer whose revocations the member access reflects, and the
  -- billing mark allowed only on a suspended row.
  -- (By the catalog: the migration login holds no USAGE on jale_billing_internal.)
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'jale_billing_internal' AND p.proname = 'billing_enforce_org_limits'
                    AND pg_get_function_identity_arguments(p.oid) = 'p_organization_id uuid, p_active_job_limit integer, p_foreman_seat_limit integer')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.organization_members'::regclass AND c.contype = 'c'
                       AND c.conname = 'organization_members_billing_mark_while_suspended'
                       AND pg_get_constraintdef(c.oid) = 'CHECK (((billing_suspended_at IS NULL) OR (status = ''suspended''::text)))') THEN
    RAISE EXCEPTION 'migration 134: 128''s enforcer or billing-mark check is missing';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('jale_api', 'jale_billing')) <> 2 THEN
    RAISE EXCEPTION 'migration 134: a role it builds on is missing';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
       WHERE NOT a.attisdropped AND a.attnum > 0
         AND ((a.attrelid = 'public.employer_profiles'::regclass AND a.attname IN ('user_id', 'contact_name'))
           OR (a.attrelid = 'public.jobs'::regclass AND a.attname IN ('id', 'employer_id', 'status'))
           OR (a.attrelid = 'public.users'::regclass AND a.attname = 'full_name'))) <> 6
     OR EXISTS (SELECT 1 FROM pg_policy p
                 WHERE p.polname IN ('employer_profiles_cap_org_team_select', 'jobs_cap_org_team_select'))
     OR to_regclass('public.organization_invites_by_org_email') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 134: employer_profiles, jobs or users are not as expected, or a 134 policy or index already exists';
  END IF;
END $$;

-- ── 1. Functions ────────────────────────────────────────────
-- Created as jale_admin, closed to PUBLIC, granted to their one caller before
-- the transfer (128's pattern: ALTER ... OWNER TO makes the new owner the
-- grantor), then transferred inside the owner's window. The bodies name
-- employer_profiles, jobs and users.full_name, whose rights section 2 grants:
-- PL/pgSQL resolves names when a statement first runs.

CREATE FUNCTION jale_cap.org_team_remove_member(p_user_id UUID)
RETURNS TABLE (outcome TEXT, cognito_sub TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_org    UUID;
  v_member RECORD;
  v_sub    TEXT;
  v_n      INTEGER;
BEGIN
  -- 1. The company lock (128's order: organizations first), for its active
  --    owner only.
  v_org := jale_cap.org_team_locked_owner_org();
  IF v_org IS NULL THEN
    RETURN QUERY SELECT 'not_owner'::text, NULL::text; RETURN;
  END IF;

  -- 2. The member, of this company only, read plainly after the lock: every
  --    writer of organization_members holds it.
  SELECT m.role, m.status INTO v_member
    FROM public.organization_members m
   WHERE m.user_id = p_user_id AND m.organization_id = v_org;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text; RETURN;
  END IF;
  IF v_member.role = 'owner' THEN
    RETURN QUERY SELECT 'is_owner'::text, NULL::text; RETURN;
  END IF;
  IF v_member.status = 'removed' THEN
    RETURN QUERY SELECT 'already_removed'::text, NULL::text; RETURN;
  END IF;

  -- 3. Any job that still names the member, whatever its status. Remove-with-
  --    reassign (Task 9) moves the member's jobs before calling this, in the
  --    same transaction: that is safe because the company lock is taken
  --    first (the handler's employer_org_usage(true), then here again in the
  --    same transaction), and every writer of a company's jobs and members
  --    (a post, 128's enforcer and restorer, 133's accepts) holds it, so
  --    neither the jobs nor the member row change in between. A post in
  --    flight commits before this reads (the lock waits for it): has_jobs.
  PERFORM 1 FROM public.jobs j WHERE j.employer_id = p_user_id LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'has_jobs'::text, NULL::text; RETURN;
  END IF;

  -- 4. Removed: the billing mark goes (128's CHECK allows it only on a
  --    suspended row), the status change is stamped.
  UPDATE public.organization_members m
     SET status = 'removed', billing_suspended_at = NULL, status_changed_at = pg_catalog.now()
   WHERE m.user_id = p_user_id AND m.organization_id = v_org AND m.role = 'foreman' AND m.status <> 'removed';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'org_team_remove_member: membership changed under the company lock' USING ERRCODE = 'P0001'; END IF;

  -- 5. The sub the handler disables after COMMIT.
  SELECT u.cognito_sub INTO v_sub FROM public.users u WHERE u.id = p_user_id;
  RETURN QUERY SELECT 'removed'::text, v_sub;
END;
$fn$;

CREATE FUNCTION jale_cap.org_team_members()
RETURNS TABLE (
  user_id           UUID,
  email             TEXT,
  display_name      TEXT,
  role              TEXT,
  status            TEXT,
  billing_suspended BOOLEAN,
  joined_at         TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ,
  active_jobs       INTEGER,
  open_jobs         INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_org    UUID;
BEGIN
  -- The company's active owner only. A read: no lock.
  IF v_caller ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT m.organization_id INTO v_org FROM public.organization_members m
     WHERE m.user_id = v_caller::uuid AND m.role = 'owner' AND m.status = 'active';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'org_team: the caller is not the active owner' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The active and suspended members, the owner first. A removed member is
  -- left out here, not by the handler: the owner never receives their email,
  -- and the list stays bounded (a re-invite shows in org_team_invites). A
  -- job counts for the member it names: active, and open (active or paused).
  RETURN QUERY
  SELECT m.user_id, u.email,
         COALESCE(NULLIF(pg_catalog.btrim(ep.contact_name), ''), NULLIF(pg_catalog.btrim(u.full_name), ''), u.email),
         m.role, m.status, m.billing_suspended_at IS NOT NULL, m.joined_at, m.status_changed_at,
         (SELECT pg_catalog.count(*)::integer FROM public.jobs j
           WHERE j.employer_id = m.user_id AND j.status = 'active'),
         (SELECT pg_catalog.count(*)::integer FROM public.jobs j
           WHERE j.employer_id = m.user_id AND j.status IN ('active', 'paused'))
    FROM public.organization_members m
    JOIN public.users u ON u.id = m.user_id
    LEFT JOIN public.employer_profiles ep ON ep.user_id = m.user_id
   WHERE m.organization_id = v_org AND m.status <> 'removed'
   ORDER BY (m.role = 'owner') DESC, m.joined_at, m.user_id;
END;
$fn$;

CREATE FUNCTION jale_cap.org_team_invites()
RETURNS TABLE (
  invite_id    UUID,
  email        TEXT,
  contact_name TEXT,
  created_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  expired      BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_org    UUID;
BEGIN
  -- The company's active owner only. A read: no lock.
  IF v_caller ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT m.organization_id INTO v_org FROM public.organization_members m
     WHERE m.user_id = v_caller::uuid AND m.role = 'owner' AND m.status = 'active';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'org_team: the caller is not the active owner' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Pending invites (not accepted or revoked), expired ones included and
  -- flagged, newest first. The token hash never leaves.
  RETURN QUERY
  SELECT i.id, i.email, i.contact_name, i.created_at, i.expires_at, i.last_sent_at,
         i.expires_at <= pg_catalog.now()
    FROM public.organization_invites i
   WHERE i.organization_id = v_org AND i.accepted_at IS NULL AND i.revoked_at IS NULL
   ORDER BY i.created_at DESC, i.id;
END;
$fn$;

CREATE FUNCTION jale_cap.org_team_membership()
RETURNS TABLE (
  user_id         UUID,
  organization_id UUID,
  role            TEXT,
  status          TEXT,
  company_name    TEXT,
  has_live_invite BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_sub    TEXT := pg_catalog.current_setting('app.current_user_id', true);
  v_user   RECORD;
  v_member RECORD;
  v_owner  UUID;
BEGIN
  IF v_sub IS NULL OR v_sub = '' THEN
    RAISE EXCEPTION 'org_team_membership: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The caller, an employer login; zero rows for anyone else.
  SELECT u.id, pg_catalog.lower(pg_catalog.btrim(u.email)) AS email INTO v_user
    FROM public.users u WHERE u.cognito_sub = v_sub AND u.user_type = 'employer';
  IF NOT FOUND THEN RETURN; END IF;

  -- Their membership in any status; zero rows without one.
  SELECT m.organization_id, m.role, m.status INTO v_member
    FROM public.organization_members m WHERE m.user_id = v_user.id;
  IF NOT FOUND THEN RETURN; END IF;

  -- The company's name as every Phase 3 reader shows it: its active owner's.
  SELECT m.user_id INTO v_owner
    FROM public.organization_members m
   WHERE m.organization_id = v_member.organization_id AND m.role = 'owner' AND m.status = 'active';

  RETURN QUERY
  SELECT v_user.id, v_member.organization_id, v_member.role::text, v_member.status::text,
         public.employer_display_name(v_owner),
         EXISTS (SELECT 1 FROM public.organization_invites i
                  WHERE i.organization_id = v_member.organization_id AND i.email = v_user.email
                    AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > pg_catalog.now());
END;
$fn$;

-- The Cognito state each foreman should have. Enabled: an active foreman, or
-- a removed one with a live invite of the same company to their email (a
-- re-invite enables them at send, Deviation 1). Changed: the latest of their
-- status change and, over that company's invites for their email, a create,
-- a send, a revoke or an expiry already passed. By company: every foreman of
-- it. By time: foremen changed after p_since, newest first, at most p_limit,
-- so a re-invite of a long-removed member sorts first.
CREATE FUNCTION jale_cap.org_member_access(
  p_organization_id UUID        DEFAULT NULL,
  p_since           TIMESTAMPTZ DEFAULT NULL,
  p_limit           INTEGER     DEFAULT NULL
)
RETURNS TABLE (user_id UUID, cognito_sub TEXT, enabled BOOLEAN, changed_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  IF (p_organization_id IS NULL) = (p_since IS NULL) THEN
    RAISE EXCEPTION 'org_member_access: set exactly one of p_organization_id and p_since' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_organization_id IS NOT NULL AND p_limit IS NOT NULL THEN
    RAISE EXCEPTION 'org_member_access: p_limit goes only with p_since' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_since IS NOT NULL AND (p_limit IS NULL OR p_limit < 1 OR p_limit > 1000) THEN
    RAISE EXCEPTION 'org_member_access: p_limit must be between 1 and 1000' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH foremen AS (
    SELECT m.user_id, m.organization_id, m.status, m.status_changed_at, u.cognito_sub,
           pg_catalog.lower(pg_catalog.btrim(u.email)) AS email
      FROM public.organization_members m
      JOIN public.users u ON u.id = m.user_id
     WHERE m.role = 'foreman'
       AND (p_organization_id IS NULL OR m.organization_id = p_organization_id)
  ), state AS (
    SELECT f.user_id, f.cognito_sub,
           (f.status = 'active'
            OR (f.status = 'removed'
                AND EXISTS (SELECT 1 FROM public.organization_invites i
                             WHERE i.organization_id = f.organization_id AND i.email = f.email
                               AND i.accepted_at IS NULL AND i.revoked_at IS NULL
                               AND i.expires_at > pg_catalog.now()))) AS enabled,
           GREATEST(f.status_changed_at,
                    (SELECT pg_catalog.max(GREATEST(i.created_at, i.last_sent_at, i.revoked_at,
                                                    CASE WHEN i.expires_at <= pg_catalog.now() THEN i.expires_at END))
                       FROM public.organization_invites i
                      WHERE i.organization_id = f.organization_id AND i.email = f.email)) AS changed_at
      FROM foremen f
  )
  SELECT s.user_id, s.cognito_sub, s.enabled, s.changed_at
    FROM state s
   WHERE p_since IS NULL OR s.changed_at > p_since
   ORDER BY s.changed_at DESC, s.user_id
   LIMIT p_limit;
END;
$fn$;

REVOKE ALL ON FUNCTION jale_cap.org_team_remove_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_team_members() FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_team_invites() FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_team_membership() FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_cap.org_member_access(uuid, timestamptz, integer) FROM PUBLIC;
-- Granted before the transfer (128 :300-304): the owner becomes the grantor.
GRANT EXECUTE ON FUNCTION jale_cap.org_team_remove_member(uuid) TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.org_team_members() TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.org_team_invites() TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.org_team_membership() TO jale_api;
GRANT EXECUTE ON FUNCTION jale_cap.org_member_access(uuid, timestamptz, integer) TO jale_billing;

-- Transferred to their owner inside its window (128 :306-316).
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_cap_org_team', current_user);
END $$;
ALTER FUNCTION jale_cap.org_team_remove_member(uuid) OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_team_members() OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_team_invites() OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_team_membership() OWNER TO jale_cap_org_team;
ALTER FUNCTION jale_cap.org_member_access(uuid, timestamptz, integer) OWNER TO jale_cap_org_team;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', 'jale_cap_org_team', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_cap_org_team', current_user, current_user);
END $$;

-- ── 2. The invites index ────────────────────────────────────
-- 128's lock order: invites before members and jobs. Member access and
-- membership read a company's invites for one email whatever their state;
-- 133's organization_invites_one_pending covers pending invites only.
CREATE INDEX organization_invites_by_org_email ON public.organization_invites (organization_id, email);

-- ── 3. Last: profiles, jobs, users ──────────────────────────
-- Columns only, under open policies: each function's caller check (the
-- company's active owner, the caller's own login, or jale_billing's company
-- and time keys) is the boundary, as in 133.
GRANT SELECT (user_id, contact_name) ON public.employer_profiles TO jale_cap_org_team;
CREATE POLICY employer_profiles_cap_org_team_select ON public.employer_profiles AS PERMISSIVE FOR SELECT TO jale_cap_org_team USING (true);
GRANT SELECT (id, employer_id, status) ON public.jobs TO jale_cap_org_team;
CREATE POLICY jobs_cap_org_team_select ON public.jobs AS PERMISSIVE FOR SELECT TO jale_cap_org_team USING (true);
-- The team list's display name falls back to the login's full name (133's
-- users_cap_org_team_select keeps the read to employer logins).
GRANT SELECT (full_name) ON public.users TO jale_cap_org_team;

-- ── 4. Self-check ───────────────────────────────────────────
DO $$
DECLARE
  spec     RECORD;
  fn_oid   OID;
  info     RECORD;
  offender TEXT;
  v_grants TEXT[];
BEGIN
  SET LOCAL search_path = pg_catalog, pg_temp;

  -- Every function: owner, definer, pinned path, language, exactly its caller.
  FOR spec IN
    SELECT * FROM (VALUES
      ('org_team_remove_member', 'p_user_id uuid', 'jale_api'),
      ('org_team_members', '', 'jale_api'),
      ('org_team_invites', '', 'jale_api'),
      ('org_team_membership', '', 'jale_api'),
      ('org_member_access', 'p_organization_id uuid, p_since timestamp with time zone, p_limit integer', 'jale_billing')
    ) AS t(fn_name, fn_args, caller)
  LOOP
    fn_oid := NULL;
    SELECT p.oid INTO fn_oid
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'jale_cap' AND p.proname = spec.fn_name
       AND pg_catalog.pg_get_function_identity_arguments(p.oid) = spec.fn_args;
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef AS definer,
           p.proconfig AS config, l.lanname AS language
      INTO info
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE p.oid = fn_oid;
    IF fn_oid IS NULL OR info.owner_name IS DISTINCT FROM 'jale_cap_org_team' OR NOT info.definer
       OR info.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
       OR info.language <> 'plpgsql' THEN
      RAISE EXCEPTION 'migration 134: jale_cap.% has the wrong owner, security, search_path or language', spec.fn_name;
    END IF;
    SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END, ', ')
      INTO offender
      FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
       AND (a.grantee = 0 OR pg_catalog.pg_get_userbyid(a.grantee) <> spec.caller);
    IF offender IS NOT NULL THEN
      RAISE EXCEPTION 'migration 134: jale_cap.% is executable by a role other than its owner and caller (%)', spec.fn_name, offender;
    END IF;
    IF NOT has_function_privilege(spec.caller, fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 134: % cannot execute jale_cap.%', spec.caller, spec.fn_name;
    END IF;
  END LOOP;

  -- The two new policies, open SELECTs for exactly the owner; fourteen in all for it.
  IF (SELECT count(*) FROM pg_policy p
       WHERE p.polpermissive AND p.polcmd = 'r' AND p.polroles = ARRAY['jale_cap_org_team'::regrole::oid]
         AND pg_get_expr(p.polqual, p.polrelid) = 'true' AND p.polwithcheck IS NULL
         AND (p.polrelid, p.polname) IN (
           ('public.employer_profiles'::regclass, 'employer_profiles_cap_org_team_select'),
           ('public.jobs'::regclass, 'jobs_cap_org_team_select'))) <> 2
     OR (SELECT count(*) FROM pg_policy p WHERE 'jale_cap_org_team'::regrole::oid = ANY (p.polroles)) <> 14 THEN
    RAISE EXCEPTION 'migration 134: the jale_cap_org_team policy set is not as reviewed';
  END IF;

  -- The capability owner's column rights: 133's plus employer_profiles,
  -- jobs and users.full_name, reads only.
  SELECT array_agg(c.relname || ':' || a.attname || ':' || p.privilege
                   ORDER BY (c.relname || ':' || a.attname || ':' || p.privilege) COLLATE "C")
    INTO v_grants
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
   WHERE c.oid IN ('public.organizations'::regclass, 'public.organization_invites'::regclass,
                   'public.organization_members'::regclass, 'public.users'::regclass, 'public.email_outbox'::regclass,
                   'public.employer_profiles'::regclass, 'public.jobs'::regclass)
     AND has_column_privilege('jale_cap_org_team', c.oid, a.attname, p.privilege);
  IF v_grants IS DISTINCT FROM ARRAY[
    'email_outbox:attempt_count:SELECT', 'email_outbox:body_html:INSERT', 'email_outbox:body_text:INSERT',
    'email_outbox:created_at:SELECT', 'email_outbox:id:SELECT', 'email_outbox:idempotency_key:INSERT',
    'email_outbox:recipient_email:INSERT', 'email_outbox:source_id:INSERT', 'email_outbox:source_id:SELECT',
    'email_outbox:source_type:INSERT', 'email_outbox:source_type:SELECT', 'email_outbox:status:SELECT',
    'email_outbox:subject:INSERT',
    'employer_profiles:contact_name:SELECT', 'employer_profiles:user_id:SELECT',
    'jobs:employer_id:SELECT', 'jobs:id:SELECT', 'jobs:status:SELECT',
    'organization_invites:accepted_at:SELECT', 'organization_invites:accepted_at:UPDATE',
    'organization_invites:contact_name:INSERT', 'organization_invites:contact_name:SELECT',
    'organization_invites:created_at:SELECT', 'organization_invites:email:INSERT', 'organization_invites:email:SELECT',
    'organization_invites:expires_at:INSERT', 'organization_invites:expires_at:SELECT', 'organization_invites:expires_at:UPDATE',
    'organization_invites:id:SELECT', 'organization_invites:invited_by:INSERT', 'organization_invites:invited_by:SELECT',
    'organization_invites:last_sent_at:INSERT', 'organization_invites:last_sent_at:SELECT', 'organization_invites:last_sent_at:UPDATE',
    'organization_invites:organization_id:INSERT', 'organization_invites:organization_id:SELECT',
    'organization_invites:revoked_at:SELECT', 'organization_invites:revoked_at:UPDATE',
    'organization_invites:token_hash:INSERT', 'organization_invites:token_hash:SELECT', 'organization_invites:token_hash:UPDATE',
    'organization_members:billing_suspended_at:SELECT', 'organization_members:billing_suspended_at:UPDATE',
    'organization_members:invited_by:INSERT', 'organization_members:invited_by:SELECT', 'organization_members:invited_by:UPDATE',
    'organization_members:joined_at:INSERT', 'organization_members:joined_at:SELECT', 'organization_members:joined_at:UPDATE',
    'organization_members:organization_id:INSERT', 'organization_members:organization_id:SELECT',
    'organization_members:role:INSERT', 'organization_members:role:SELECT',
    'organization_members:status:INSERT', 'organization_members:status:SELECT', 'organization_members:status:UPDATE',
    'organization_members:status_changed_at:INSERT', 'organization_members:status_changed_at:SELECT',
    'organization_members:status_changed_at:UPDATE',
    'organization_members:user_id:INSERT', 'organization_members:user_id:SELECT',
    'organizations:id:SELECT', 'organizations:updated_at:UPDATE',
    'users:cognito_sub:SELECT', 'users:email:SELECT', 'users:full_name:SELECT', 'users:id:SELECT', 'users:user_type:SELECT'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'migration 134: jale_cap_org_team column rights are not as reviewed (%)', v_grants;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c
              WHERE c.relkind IN ('r', 'p') AND c.oid <> 'public.email_outbox'::regclass
                AND has_table_privilege('jale_cap_org_team', c.oid, 'DELETE, TRUNCATE, TRIGGER')) THEN
    RAISE EXCEPTION 'migration 134: jale_cap_org_team holds a table right beyond 133''s';
  END IF;

  -- The invites index, exactly.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'organization_invites_by_org_email'
                  AND indexdef = 'CREATE INDEX organization_invites_by_org_email ON public.organization_invites USING btree (organization_id, email)') THEN
    RAISE EXCEPTION 'migration 134: organization_invites_by_org_email is missing or drifted';
  END IF;

  -- Every window is closed, and the owner is a member of nothing.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member
     WHERE g.rolname = 'jale_cap_org_team' AND (m.set_option OR m.inherit_option)
  ) OR EXISTS (SELECT 1 FROM pg_auth_members am WHERE am.member = 'jale_cap_org_team'::regrole) THEN
    RAISE EXCEPTION 'migration 134: the jale_cap_org_team window was left open, or it is a member of a role';
  END IF;
END $$;

COMMIT;
