-- ============================================================
-- 128_company_limits.sql
-- Run manually AFTER 127_company_billing.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Employer organizations, Phase 2 milestone A, part 2
-- (docs/superpowers/specs/2026-10-15-employer-organizations-design.md,
-- "Billing and limits").
--
-- (1) THE COMPANY USAGE READ (caller jale_api).
--     jale_cap.employer_org_usage(p_lock) returns the caller's company and
--     its company-wide counts: active jobs of every member whatever their
--     membership status (a suspended foreman's active jobs still count),
--     templates of every member, active foremen, billing-suspended foremen
--     (status suspended AND billing_suspended_at set; a suspension for any
--     other reason is not counted) and live pending invites (not accepted,
--     not revoked, not expired), the last column appended so readers that
--     name their columns are unaffected. With p_lock
--     it first takes the company's organizations row FOR NO KEY UPDATE,
--     held to COMMIT: the lock job creation, reactivation and template
--     saves serialise on, and the one the billing enforcer takes below.
--     After the lock it checks the caller again, in a new statement: a
--     downgrade that suspended the caller while they waited for the lock
--     is seen, and the caller is refused (42501).
--     NO KEY UPDATE, not the spec's FOR UPDATE: it conflicts with itself,
--     so the gates serialise the same, but not with the FOR KEY SHARE a
--     foreign-key check takes, so an insert naming the company (a
--     subscription, a member, an invite) never waits for it and a webhook
--     that inserts a subscription and then enforces cannot deadlock against
--     a post. The caller is app.current_internal_user_id and must be an
--     active member; anything else raises 42501. Owned by a new NOLOGIN
--     capability owner, jale_cap_org_limits (107/125's pattern), whose reads
--     are limited to the caller's company by its own policies (through
--     118's org_member_scope). No runtime login gains any right on
--     organizations.
-- (2) BILLING BY COMPANY (caller jale_billing), owned by
--     jale_billing_job_enforcer like 036's and 125's functions:
--       billing_enforce_org_limits(company, job limit, seat limit): under the
--         company lock, first suspends active foremen beyond the seat limit
--         (the earliest joined stay; billing_suspended_at marks them), then
--         pauses active jobs across every member beyond the job limit:
--         the jobs of members still active keep their slots first, the
--         oldest first, so a suspended foreman's jobs are paused before the
--         owner's (billing_paused_at marks them, as in 125; one
--         job_status_events row per paused job with the job's own
--         employer_id, and a 'removed' visibility event for a public job,
--         mirroring the resume), and revokes the newest live pending
--         invites beyond the seats left.
--       billing_restore_org(company, job limit, seat limit): under the same
--         lock, restores marked foremen up to the seats left (earliest
--         marked first, then earliest joined; active foremen and live
--         pending invites hold seats) and clears their mark, then resumes
--         the billing-paused jobs of active members exactly as 125's
--         billing_resume_paused_jobs does per person. A member suspended
--         without the mark (for any other reason) is never restored here,
--         and a foreman still suspended keeps their jobs paused.
--     Both are idempotent. 125's per-person pair stays unchanged for the
--     Lambdas deployed before Phase 2; Phase 3 drops it. The enforcer's
--     rights on jobs and users are unchanged (125's exact set).
-- (3) THE BILLING MARK. organization_members.billing_suspended_at, set only
--     with status = 'suspended' (a CHECK): whoever changes a marked
--     member's status (Phase 3's Team page) clears the mark in the same
--     statement.
--
-- LOCK ORDER. CREATE POLICY and ALTER TABLE hold ACCESS EXCLUSIVE until
-- COMMIT. Everything on organization_members, employer_job_templates, users
-- and jobs (the column, the grants that name it, the policies) is the last
-- section, so the hottest tables are locked for the shortest time.
--
-- REPLAY: refused once jale_cap.employer_org_usage exists.
-- ============================================================
BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Preconditions ────────────────────────────────────────
DO $$
BEGIN
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'migration 128: connect as the migration login itself, without SET ROLE';
  END IF;
  IF to_regprocedure('jale_cap.employer_org_usage(boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 128: already applied (jale_cap.employer_org_usage exists); it is not re-runnable';
  END IF;
  IF to_regprocedure('public.billing_stamp_organization()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.organization_members'::regclass
                     AND polname = 'organization_members_trigger_read') THEN
    RAISE EXCEPTION 'migration 128: apply 127 first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.organization_members'::regclass
              AND attname = 'billing_suspended_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'migration 128: organization_members.billing_suspended_at already exists';
  END IF;
  IF to_regnamespace('jale_cap') IS NULL OR to_regnamespace('jale_internal') IS NULL
     OR to_regnamespace('jale_billing_internal') IS NULL
     OR (SELECT count(*) FROM pg_roles
          WHERE rolname IN ('jale_api', 'jale_billing', 'jale_billing_job_enforcer', 'jale_rls_relationship_reader')) <> 4 THEN
    RAISE EXCEPTION 'migration 128: a schema or role it builds on is missing';
  END IF;
  -- The enforcer is as 036 and 125 left it: a member of nothing, no SET or
  -- INHERIT row in it, and this login's ADMIN row (the window below needs it).
  IF EXISTS (SELECT 1 FROM pg_auth_members am
              WHERE am.member = 'jale_billing_job_enforcer'::regrole
                 OR (am.roleid = 'jale_billing_job_enforcer'::regrole AND (am.inherit_option OR am.set_option)))
     OR NOT EXISTS (SELECT 1 FROM pg_auth_members am
                     WHERE am.roleid = 'jale_billing_job_enforcer'::regrole
                       AND am.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                       AND am.admin_option) THEN
    RAISE EXCEPTION 'migration 128: jale_billing_job_enforcer''s memberships are not as 125 left them';
  END IF;
  -- By catalog row: jale_admin holds no USAGE on jale_billing_internal (036).
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'jale_billing_internal'
         AND p.proname IN ('billing_pause_over_limit_jobs', 'billing_resume_paused_jobs')
         AND pg_get_function_identity_arguments(p.oid) = 'p_user_id uuid, p_active_job_limit integer') <> 2 THEN
    RAISE EXCEPTION 'migration 128: 125''s billing_pause_over_limit_jobs / billing_resume_paused_jobs are missing';
  END IF;
  IF to_regprocedure('public.enqueue_job_visibility_event(uuid, text, text)') IS NULL
     OR NOT has_function_privilege('jale_billing_job_enforcer', 'public.enqueue_job_visibility_event(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 128: the enforcer cannot announce a resumed job (125''s grant is missing)';
  END IF;
END $$;

-- ── 1. The capability owner (107/125's pattern) ─────────────
DO $$
DECLARE
  helper pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO helper FROM pg_catalog.pg_roles WHERE rolname = 'jale_cap_org_limits';
  IF NOT FOUND THEN
    CREATE ROLE jale_cap_org_limits NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    SELECT * INTO helper FROM pg_catalog.pg_roles WHERE rolname = 'jale_cap_org_limits';
  END IF;

  IF helper.rolcanlogin OR helper.rolsuper OR helper.rolcreatedb OR helper.rolcreaterole
     OR helper.rolinherit OR helper.rolreplication OR helper.rolbypassrls THEN
    RAISE EXCEPTION 'migration 128: existing role jale_cap_org_limits has unsafe attributes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members am
     WHERE am.member = helper.oid
        OR (am.roleid = helper.oid
            AND NOT (am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                     AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option))
  ) THEN
    RAISE EXCEPTION 'migration 128: role jale_cap_org_limits has unsafe memberships';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members am
     WHERE am.roleid = helper.oid
       AND am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
       AND am.admin_option
  ) THEN
    EXECUTE format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', 'jale_cap_org_limits', current_user);
  END IF;
END $$;

-- ALTER FUNCTION ... OWNER TO needs the new owner to hold CREATE on the function's schema.
GRANT CREATE ON SCHEMA jale_cap TO jale_cap_org_limits;

-- ── 2. What the capability owner reads ──────────────────────
-- The caller's company only. Its policies go through org_member_scope (118),
-- which is empty unless the caller is an active member. Its policies on
-- organization_members and employer_job_templates are in section 6, with
-- its right on organization_members.billing_suspended_at (added there).
GRANT SELECT (user_id, organization_id, role, status) ON public.organization_members TO jale_cap_org_limits;
GRANT SELECT (id), UPDATE (updated_at) ON public.organizations TO jale_cap_org_limits;
GRANT SELECT (id, employer_id) ON public.employer_job_templates TO jale_cap_org_limits;
-- Live pending invites hold seats; the usage read counts them.
GRANT SELECT (organization_id, expires_at, accepted_at, revoked_at) ON public.organization_invites TO jale_cap_org_limits;

CREATE POLICY organization_invites_cap_org_limits_select ON public.organization_invites
  AS PERMISSIVE FOR SELECT TO jale_cap_org_limits
  USING (organization_id IN (SELECT m.organization_id FROM public.organization_members m
                 WHERE m.user_id = ANY ((SELECT jale_internal.org_member_scope(current_setting('app.current_internal_user_id', true)))::uuid[])));

-- SELECT ... FOR NO KEY UPDATE needs the row to pass an UPDATE policy as
-- well; the owner holds UPDATE on updated_at only for the lock, and never
-- writes it.
CREATE POLICY organizations_cap_org_limits_select ON public.organizations
  AS PERMISSIVE FOR SELECT TO jale_cap_org_limits
  USING (id IN (SELECT m.organization_id FROM public.organization_members m
                 WHERE m.user_id = ANY ((SELECT jale_internal.org_member_scope(current_setting('app.current_internal_user_id', true)))::uuid[])));
CREATE POLICY organizations_cap_org_limits_lock ON public.organizations
  AS PERMISSIVE FOR UPDATE TO jale_cap_org_limits
  USING (id IN (SELECT m.organization_id FROM public.organization_members m
                 WHERE m.user_id = ANY ((SELECT jale_internal.org_member_scope(current_setting('app.current_internal_user_id', true)))::uuid[])))
  WITH CHECK (id IN (SELECT m.organization_id FROM public.organization_members m
                 WHERE m.user_id = ANY ((SELECT jale_internal.org_member_scope(current_setting('app.current_internal_user_id', true)))::uuid[])));

-- The owner's policies call org_member_scope (jale_internal, 118). The
-- schema's and the function's owner grants both, inside its own window.
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_rls_relationship_reader', current_user);
END $$;
SET LOCAL ROLE jale_rls_relationship_reader;
GRANT USAGE ON SCHEMA jale_internal TO jale_cap_org_limits;
GRANT EXECUTE ON FUNCTION jale_internal.org_member_scope(TEXT) TO jale_cap_org_limits;
RESET ROLE;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', 'jale_rls_relationship_reader', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_rls_relationship_reader', current_user, current_user);
END $$;

-- ── 3. What the billing enforcer reads and writes ───────────
-- Columns only. Its policies are open, like 036's on jobs and users: it acts
-- only inside its own definers, on the company the processor names. Its
-- rights and policies on organization_members are in section 6.
GRANT SELECT (id), UPDATE (updated_at) ON public.organizations TO jale_billing_job_enforcer;
GRANT SELECT (id, organization_id, created_at, expires_at, accepted_at, revoked_at),
      UPDATE (revoked_at)
  ON public.organization_invites TO jale_billing_job_enforcer;

CREATE POLICY organizations_billing_job_enforcer_select ON public.organizations
  FOR SELECT TO jale_billing_job_enforcer USING (true);
CREATE POLICY organizations_billing_job_enforcer_lock ON public.organizations
  FOR UPDATE TO jale_billing_job_enforcer USING (true) WITH CHECK (true);
CREATE POLICY organization_invites_billing_job_enforcer_select ON public.organization_invites
  FOR SELECT TO jale_billing_job_enforcer USING (true);
-- Only a pending invite is revoked; an accepted one never changes here.
CREATE POLICY organization_invites_billing_job_enforcer_update ON public.organization_invites
  FOR UPDATE TO jale_billing_job_enforcer USING (accepted_at IS NULL) WITH CHECK (accepted_at IS NULL);

-- ── 4. The company usage read (caller jale_api) ─────────────
CREATE FUNCTION jale_cap.employer_org_usage(p_lock BOOLEAN)
RETURNS TABLE (
  organization_id   UUID,
  active_jobs       INTEGER,
  templates         INTEGER,
  active_foremen    INTEGER,
  suspended_foremen INTEGER,
  pending_invites   INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_caller  TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_org     UUID;
  v_members UUID[];
BEGIN
  IF v_caller IS NULL OR v_caller !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'employer_org_usage: the caller context is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT m.organization_id INTO v_org
    FROM public.organization_members m
   WHERE m.user_id = v_caller::uuid
     AND m.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employer_org_usage: the caller is not an active member of a company' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The company lock, held to COMMIT. Each count below is a new statement,
  -- so in READ COMMITTED it sees what the previous holder committed.
  IF COALESCE(p_lock, false) THEN
    PERFORM 1 FROM public.organizations o WHERE o.id = v_org FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'employer_org_usage: the company row is missing' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- The caller again, in a new statement (a new snapshot): a downgrade that
  -- suspended the caller while they waited for the lock is seen here, and
  -- the caller is refused.
  PERFORM 1 FROM public.organization_members m
   WHERE m.user_id = v_caller::uuid AND m.organization_id = v_org AND m.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employer_org_usage: the caller is not an active member of a company' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT COALESCE(array_agg(m.user_id), ARRAY[]::UUID[]) INTO v_members
    FROM public.organization_members m
   WHERE m.organization_id = v_org;

  RETURN QUERY
  SELECT v_org,
         (SELECT count(*)::INTEGER FROM public.jobs j
           WHERE j.employer_id = ANY (v_members) AND j.status = 'active'),
         (SELECT count(*)::INTEGER FROM public.employer_job_templates t
           WHERE t.employer_id = ANY (v_members)),
         (SELECT count(*)::INTEGER FROM public.organization_members m
           WHERE m.organization_id = v_org AND m.role = 'foreman' AND m.status = 'active'),
         -- Billing-suspended foremen only: a suspension for any other reason
         -- does not come back with a plan change.
         (SELECT count(*)::INTEGER FROM public.organization_members m
           WHERE m.organization_id = v_org AND m.role = 'foreman' AND m.status = 'suspended'
             AND m.billing_suspended_at IS NOT NULL),
         (SELECT count(*)::INTEGER FROM public.organization_invites i
           WHERE i.organization_id = v_org
             AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now());
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.employer_org_usage(boolean) FROM PUBLIC;
-- Granted before the transfer (105's pattern): the owner holds no USAGE on
-- jale_cap, so it could not name the function, and ALTER ... OWNER TO makes
-- the new owner the grantor of this grant.
GRANT EXECUTE ON FUNCTION jale_cap.employer_org_usage(boolean) TO jale_api;

-- Transferred to its owner inside its window.
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_cap_org_limits', current_user);
END $$;
ALTER FUNCTION jale_cap.employer_org_usage(boolean) OWNER TO jale_cap_org_limits;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', 'jale_cap_org_limits', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_cap_org_limits', current_user, current_user);
END $$;

-- ── 5. Billing by company (caller jale_billing) ─────────────
-- Both bodies name organization_members.billing_suspended_at, which section 6
-- adds: PL/pgSQL resolves column names when a statement first runs, not at
-- CREATE FUNCTION.
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', 'jale_billing_job_enforcer', current_user);
END $$;
SET LOCAL ROLE jale_billing_job_enforcer;

CREATE FUNCTION jale_billing_internal.billing_enforce_org_limits(
  p_organization_id    UUID,
  p_active_job_limit   INTEGER,
  p_foreman_seat_limit INTEGER
)
RETURNS TABLE (
  paused_count         INTEGER,
  paused_titles        TEXT[],
  suspended_count      INTEGER,
  suspended_emails     TEXT[],
  revoked_invite_count INTEGER,
  owner_email          TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_members        UUID[];
  v_active_ids     UUID[];
  v_active_foremen INTEGER;
  v_paused_ids     UUID[];
  rec              RECORD;
BEGIN
  IF p_active_job_limit IS NULL OR p_active_job_limit < 0
     OR p_foreman_seat_limit IS NULL OR p_foreman_seat_limit < 0 THEN
    RAISE EXCEPTION 'billing_limit_invalid' USING ERRCODE = '22023';
  END IF;

  -- The company lock job creation takes (jale_cap.employer_org_usage), so a
  -- downgrade and a post never interleave.
  PERFORM 1 FROM public.organizations o WHERE o.id = p_organization_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT u.email INTO owner_email
    FROM public.organization_members m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.organization_id = p_organization_id AND m.role = 'owner' AND m.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_owner_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- (a) Seats first: the earliest-joined active foremen keep theirs; the
  --     most recently joined beyond the limit are suspended and marked.
  --     Before the jobs, so the jobs know who is still active.
  WITH ranked AS MATERIALIZED (
    SELECT m.user_id, row_number() OVER (ORDER BY m.joined_at ASC, m.user_id ASC) AS seat_rank
      FROM public.organization_members m
     WHERE m.organization_id = p_organization_id AND m.role = 'foreman' AND m.status = 'active'
  ), suspended AS (
    UPDATE public.organization_members m
       SET status = 'suspended', status_changed_at = now(), billing_suspended_at = now()
      FROM ranked r
     WHERE m.user_id = r.user_id AND r.seat_rank > p_foreman_seat_limit AND m.status = 'active'
    RETURNING m.user_id, m.joined_at
  )
  SELECT count(*)::INTEGER,
         COALESCE(array_agg(COALESCE(NULLIF(u.email, ''), '(no email on file)') ORDER BY s.joined_at DESC, s.user_id DESC),
                  ARRAY[]::TEXT[])
    INTO suspended_count, suspended_emails
    FROM suspended s
    LEFT JOIN public.users u ON u.id = s.user_id;

  SELECT COALESCE(array_agg(m.user_id), ARRAY[]::UUID[]),
         COALESCE(array_agg(m.user_id) FILTER (WHERE m.status = 'active'), ARRAY[]::UUID[])
    INTO v_members, v_active_ids
    FROM public.organization_members m
   WHERE m.organization_id = p_organization_id;

  -- (b) Jobs: every member's active jobs count, whatever their membership
  --     status. Active members' jobs (after (a)) keep their slots first, the
  --     oldest first; the rest are paused and marked (125's mark), so a
  --     suspended foreman's jobs go before the owner's. billing_restore_org
  --     resumes only active members' jobs, oldest first: the same order back.
  --     A removed or otherwise-suspended member's active jobs still count and
  --     rank last, and billing_restore_org does not resume them.
  WITH ranked AS MATERIALIZED (
    SELECT j.id,
           row_number() OVER (ORDER BY (j.employer_id = ANY (v_active_ids)) DESC, j.created_at ASC, j.id ASC) AS active_rank
      FROM public.jobs j
     WHERE j.employer_id = ANY (v_members) AND j.status = 'active'
  ), paused AS (
    UPDATE public.jobs j
       SET status = 'paused', updated_at = now(), billing_paused_at = now()
      FROM ranked r
     WHERE j.id = r.id AND r.active_rank > p_active_job_limit AND j.status = 'active'
    RETURNING j.title, j.created_at, j.id
  )
  SELECT count(*)::INTEGER, COALESCE(array_agg(p.title ORDER BY p.created_at ASC, p.id ASC), ARRAY[]::TEXT[]),
         COALESCE(array_agg(p.id), ARRAY[]::UUID[])
    INTO paused_count, paused_titles, v_paused_ids
    FROM paused p;

  -- Each paused job is recorded as the resume records it: one
  -- job_status_events row with the job's own employer_id, and a 'removed'
  -- visibility event for a public job, so it leaves the public pages.
  FOR rec IN
    SELECT j.id, j.employer_id, j.public_code, j.public_listing_enabled
      FROM public.jobs j
     WHERE j.id = ANY (v_paused_ids)
     ORDER BY j.created_at ASC, j.id ASC
  LOOP
    INSERT INTO public.job_status_events (job_id, employer_id, from_status, to_status, actor)
    VALUES (rec.id, rec.employer_id, 'active', 'paused', 'billing');
    IF rec.public_listing_enabled AND rec.public_code IS NOT NULL THEN
      PERFORM public.enqueue_job_visibility_event(rec.id, rec.public_code, 'removed');
    END IF;
  END LOOP;

  -- (c) Invites: live pending invites hold seats too; the newest beyond the
  --     seats left are revoked. Expired and accepted invites are left alone.
  SELECT count(*)::INTEGER INTO v_active_foremen
    FROM public.organization_members m
   WHERE m.organization_id = p_organization_id AND m.role = 'foreman' AND m.status = 'active';

  WITH pending AS MATERIALIZED (
    SELECT i.id, row_number() OVER (ORDER BY i.created_at ASC, i.id ASC) AS invite_rank
      FROM public.organization_invites i
     WHERE i.organization_id = p_organization_id
       AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  ), revoked AS (
    UPDATE public.organization_invites i
       SET revoked_at = now()
      FROM pending p
     WHERE i.id = p.id
       AND p.invite_rank > GREATEST(p_foreman_seat_limit - v_active_foremen, 0)
       AND i.accepted_at IS NULL AND i.revoked_at IS NULL
    RETURNING i.id
  )
  SELECT count(*)::INTEGER INTO revoked_invite_count FROM revoked;

  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION jale_billing_internal.billing_enforce_org_limits(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_billing_internal.billing_enforce_org_limits(UUID, INTEGER, INTEGER) TO jale_billing;

CREATE FUNCTION jale_billing_internal.billing_restore_org(
  p_organization_id    UUID,
  p_active_job_limit   INTEGER,
  p_foreman_seat_limit INTEGER
)
RETURNS TABLE (
  resumed_count   INTEGER,
  resumed_titles  TEXT[],
  restored_count  INTEGER,
  restored_emails TEXT[],
  owner_email     TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_members    UUID[];
  v_active_ids UUID[];
  v_held_seats INTEGER;
  v_active     INTEGER;
  v_ids        UUID[];
  v_titles     TEXT[] := ARRAY[]::TEXT[];
  rec          RECORD;
BEGIN
  IF p_active_job_limit IS NULL OR p_active_job_limit < 0
     OR p_foreman_seat_limit IS NULL OR p_foreman_seat_limit < 0 THEN
    RAISE EXCEPTION 'billing_limit_invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.organizations o WHERE o.id = p_organization_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT u.email INTO owner_email
    FROM public.organization_members m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.organization_id = p_organization_id AND m.role = 'owner' AND m.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_owner_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- (a) Seats first: active foremen and live pending invites hold seats.
  --     Only foremen billing suspended come back (billing_suspended_at),
  --     earliest marked first and, within one downgrade, earliest joined
  --     first (the reverse of the suspension order). A member suspended for
  --     another reason, or removed, never comes back here.
  SELECT (SELECT count(*) FROM public.organization_members m
           WHERE m.organization_id = p_organization_id AND m.role = 'foreman' AND m.status = 'active')
       + (SELECT count(*) FROM public.organization_invites i
           WHERE i.organization_id = p_organization_id
             AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now())
    INTO v_held_seats;

  WITH ranked AS MATERIALIZED (
    SELECT m.user_id,
           row_number() OVER (ORDER BY m.billing_suspended_at ASC, m.joined_at ASC, m.user_id ASC) AS restore_rank
      FROM public.organization_members m
     WHERE m.organization_id = p_organization_id AND m.role = 'foreman' AND m.status = 'suspended'
       AND m.billing_suspended_at IS NOT NULL
  ), restored AS (
    UPDATE public.organization_members m
       SET status = 'active', status_changed_at = now(), billing_suspended_at = NULL
      FROM ranked r
     WHERE m.user_id = r.user_id
       AND r.restore_rank <= GREATEST(p_foreman_seat_limit - v_held_seats, 0)
       AND m.status = 'suspended' AND m.billing_suspended_at IS NOT NULL
    RETURNING m.user_id, r.restore_rank
  )
  SELECT count(*)::INTEGER,
         COALESCE(array_agg(COALESCE(NULLIF(u.email, ''), '(no email on file)') ORDER BY s.restore_rank), ARRAY[]::TEXT[])
    INTO restored_count, restored_emails
    FROM restored s
    LEFT JOIN public.users u ON u.id = s.user_id;

  -- (b) Jobs: 125's resume, across the company. Every member's active jobs
  --     hold slots; only the billing-paused jobs of members who are active
  --     now (after (a)) come back. A foreman still suspended keeps theirs
  --     paused: the owner can reactivate or reassign them.
  SELECT COALESCE(array_agg(m.user_id), ARRAY[]::UUID[]),
         COALESCE(array_agg(m.user_id) FILTER (WHERE m.status = 'active'), ARRAY[]::UUID[])
    INTO v_members, v_active_ids
    FROM public.organization_members m
   WHERE m.organization_id = p_organization_id;

  SELECT count(*)::INTEGER INTO v_active
    FROM public.jobs j
   WHERE j.employer_id = ANY (v_members) AND j.status = 'active';

  -- A billing-paused job whose hires already fill it comes back filled
  -- (029's rule): it takes no slot and is not announced or mailed.
  FOR rec IN
    SELECT j.id, j.employer_id
      FROM public.jobs j
     WHERE j.employer_id = ANY (v_active_ids)
       AND j.status = 'paused'
       AND j.billing_paused_at IS NOT NULL
       AND j.workers_hired >= j.number_of_workers_needed
     ORDER BY j.created_at ASC, j.id ASC
       FOR UPDATE OF j
  LOOP
    UPDATE public.jobs j
       SET status = 'filled', billing_paused_at = NULL, updated_at = now()
     WHERE j.id = rec.id;
    INSERT INTO public.job_status_events (job_id, employer_id, from_status, to_status, actor)
    VALUES (rec.id, rec.employer_id, 'paused', 'filled', 'billing');
  END LOOP;

  -- Only jobs billing paused and still paused, with an opening left:
  -- oldest first, as the pause keeps active members' oldest jobs.
  IF p_active_job_limit > v_active THEN
    SELECT COALESCE(array_agg(picked.id ORDER BY picked.created_at ASC, picked.id ASC), ARRAY[]::UUID[])
      INTO v_ids
      FROM (
        SELECT j.id, j.created_at
          FROM public.jobs j
         WHERE j.employer_id = ANY (v_active_ids)
           AND j.status = 'paused'
           AND j.billing_paused_at IS NOT NULL
           AND j.workers_hired < j.number_of_workers_needed
         ORDER BY j.created_at ASC, j.id ASC
         LIMIT p_active_job_limit - v_active
           FOR UPDATE OF j
      ) picked;

    UPDATE public.jobs j
       SET status = 'active', billing_paused_at = NULL, updated_at = now()
     WHERE j.id = ANY (v_ids)
       AND j.status = 'paused'
       AND j.billing_paused_at IS NOT NULL;

    FOR rec IN
      SELECT j.id, j.employer_id, j.title, j.public_code, j.public_listing_enabled
        FROM public.jobs j
       WHERE j.id = ANY (v_ids)
       ORDER BY j.created_at ASC, j.id ASC
    LOOP
      INSERT INTO public.job_status_events (job_id, employer_id, from_status, to_status, actor)
      VALUES (rec.id, rec.employer_id, 'paused', 'active', 'billing');
      IF rec.public_listing_enabled AND rec.public_code IS NOT NULL THEN
        PERFORM public.enqueue_job_visibility_event(rec.id, rec.public_code, 'published');
      END IF;
      v_titles := v_titles || rec.title;
    END LOOP;
  END IF;

  resumed_count := COALESCE(cardinality(v_titles), 0);
  resumed_titles := v_titles;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION jale_billing_internal.billing_restore_org(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_billing_internal.billing_restore_org(UUID, INTEGER, INTEGER) TO jale_billing;

RESET ROLE;
DO $$
BEGIN
  EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', 'jale_billing_job_enforcer', current_user);
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', 'jale_billing_job_enforcer', current_user, current_user);
END $$;

-- ── 6. Last: organization_members, employer_job_templates, users, jobs
-- The billing mark: set only together with a suspension.
ALTER TABLE public.organization_members
  ADD COLUMN billing_suspended_at TIMESTAMPTZ,
  ADD CONSTRAINT organization_members_billing_mark_while_suspended
    CHECK (billing_suspended_at IS NULL OR status = 'suspended');
COMMENT ON COLUMN public.organization_members.billing_suspended_at IS
  'Set by billing_enforce_org_limits when a downgrade suspends this foreman, cleared by billing_restore_org (128). NULL for any other suspension; only a suspended member may carry it.';

GRANT SELECT (user_id, organization_id, role, status, joined_at, status_changed_at, billing_suspended_at),
      UPDATE (status, status_changed_at, billing_suspended_at)
  ON public.organization_members TO jale_billing_job_enforcer;
-- The usage read counts billing-suspended foremen only.
GRANT SELECT (billing_suspended_at) ON public.organization_members TO jale_cap_org_limits;

CREATE POLICY organization_members_cap_org_limits_select ON public.organization_members
  AS PERMISSIVE FOR SELECT TO jale_cap_org_limits
  USING (user_id = ANY ((SELECT jale_internal.org_member_scope(current_setting('app.current_internal_user_id', true)))::uuid[]));
CREATE POLICY organization_members_billing_job_enforcer_select ON public.organization_members
  FOR SELECT TO jale_billing_job_enforcer USING (true);
-- Only foremen are suspended or restored; an owner's row never changes here.
CREATE POLICY organization_members_billing_job_enforcer_update ON public.organization_members
  FOR UPDATE TO jale_billing_job_enforcer USING (role = 'foreman') WITH CHECK (role = 'foreman');

CREATE POLICY employer_job_templates_cap_org_limits_select ON public.employer_job_templates
  AS PERMISSIVE FOR SELECT TO jale_cap_org_limits
  USING (employer_id = ANY ((SELECT jale_internal.org_member_scope(current_setting('app.current_internal_user_id', true)))::uuid[]));

-- employer_job_templates_self (069, TO PUBLIC) is evaluated for every reader
-- of templates and its sub-query reads these three users columns; the
-- owner never returns them.
GRANT SELECT (id, cognito_sub, user_type) ON public.users TO jale_cap_org_limits;
GRANT SELECT (id, employer_id, status) ON public.jobs TO jale_cap_org_limits;

CREATE POLICY jobs_cap_org_limits_select ON public.jobs
  AS PERMISSIVE FOR SELECT TO jale_cap_org_limits
  USING (employer_id = ANY ((SELECT jale_internal.org_member_scope(current_setting('app.current_internal_user_id', true)))::uuid[]));

-- ── Self-check ──────────────────────────────────────────────
DO $$
DECLARE
  spec     RECORD;
  fn_oid   OID;
  info     RECORD;
  offender TEXT;
  v_grants TEXT[];
BEGIN
  SET LOCAL search_path = pg_catalog, pg_temp;

  -- Functions: owner, definer, pinned path, language, exactly their caller.
  -- Looked up by catalog row: jale_admin cannot resolve a name in
  -- jale_billing_internal (036).
  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_cap', 'employer_org_usage', 'p_lock boolean', 'jale_cap_org_limits', 'jale_api'),
      ('jale_billing_internal', 'billing_enforce_org_limits',
       'p_organization_id uuid, p_active_job_limit integer, p_foreman_seat_limit integer', 'jale_billing_job_enforcer', 'jale_billing'),
      ('jale_billing_internal', 'billing_restore_org',
       'p_organization_id uuid, p_active_job_limit integer, p_foreman_seat_limit integer', 'jale_billing_job_enforcer', 'jale_billing'),
      ('jale_billing_internal', 'billing_pause_over_limit_jobs', 'p_user_id uuid, p_active_job_limit integer',
       'jale_billing_job_enforcer', 'jale_billing'),
      ('jale_billing_internal', 'billing_resume_paused_jobs', 'p_user_id uuid, p_active_job_limit integer',
       'jale_billing_job_enforcer', 'jale_billing')
    ) AS t(schema_name, fn_name, fn_args, owner_role, caller)
  LOOP
    fn_oid := NULL;
    SELECT p.oid INTO fn_oid
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = spec.schema_name AND p.proname = spec.fn_name
       AND pg_catalog.pg_get_function_identity_arguments(p.oid) = spec.fn_args;
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef AS definer,
           p.proconfig AS config, l.lanname AS language
      INTO info
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE p.oid = fn_oid;
    IF fn_oid IS NULL OR info.owner_name IS DISTINCT FROM spec.owner_role OR NOT info.definer
       OR info.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
       OR info.language <> 'plpgsql' THEN
      RAISE EXCEPTION 'migration 128: %.% has the wrong owner, security, search_path or language', spec.schema_name, spec.fn_name;
    END IF;
    SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END, ', ')
      INTO offender
      FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
       AND (a.grantee = 0 OR pg_catalog.pg_get_userbyid(a.grantee) <> spec.caller);
    IF offender IS NOT NULL THEN
      RAISE EXCEPTION 'migration 128: %.% is executable by a role other than its owner and caller (%)', spec.schema_name, spec.fn_name, offender;
    END IF;
    IF NOT has_function_privilege(spec.caller, fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 128: % cannot execute %.%', spec.caller, spec.schema_name, spec.fn_name;
    END IF;
  END LOOP;

  -- The billing mark: a nullable timestamptz, allowed only on a suspended member.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'public.organization_members'::regclass AND a.attname = 'billing_suspended_at'
                    AND a.atttypid = 'timestamptz'::regtype AND NOT a.attnotnull AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
                     WHERE c.conrelid = 'public.organization_members'::regclass
                       AND c.conname = 'organization_members_billing_mark_while_suspended' AND c.contype = 'c' AND c.convalidated) THEN
    RAISE EXCEPTION 'migration 128: organization_members.billing_suspended_at or its CHECK is missing';
  END IF;

  -- The new policies, each for exactly its role.
  IF (SELECT count(*) FROM pg_policy p
       WHERE (p.polname, p.polroles) IN (
         ('organization_members_cap_org_limits_select', ARRAY['jale_cap_org_limits'::regrole::oid]),
         ('organizations_cap_org_limits_select', ARRAY['jale_cap_org_limits'::regrole::oid]),
         ('organizations_cap_org_limits_lock', ARRAY['jale_cap_org_limits'::regrole::oid]),
         ('employer_job_templates_cap_org_limits_select', ARRAY['jale_cap_org_limits'::regrole::oid]),
         ('jobs_cap_org_limits_select', ARRAY['jale_cap_org_limits'::regrole::oid]),
         ('organizations_billing_job_enforcer_select', ARRAY['jale_billing_job_enforcer'::regrole::oid]),
         ('organizations_billing_job_enforcer_lock', ARRAY['jale_billing_job_enforcer'::regrole::oid]),
         ('organization_members_billing_job_enforcer_select', ARRAY['jale_billing_job_enforcer'::regrole::oid]),
         ('organization_members_billing_job_enforcer_update', ARRAY['jale_billing_job_enforcer'::regrole::oid]),
         ('organization_invites_billing_job_enforcer_select', ARRAY['jale_billing_job_enforcer'::regrole::oid]),
         ('organization_invites_cap_org_limits_select', ARRAY['jale_cap_org_limits'::regrole::oid]),
         ('organization_invites_billing_job_enforcer_update', ARRAY['jale_billing_job_enforcer'::regrole::oid]))) <> 12 THEN
    RAISE EXCEPTION 'migration 128: the new policy set is not as reviewed';
  END IF;

  -- The capability owner: no login, nothing elevated, NOINHERIT, member of
  -- nothing, no SET or INHERIT window left, and exactly its column rights.
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'jale_cap_org_limits'
              AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit
                   OR r.rolreplication OR r.rolbypassrls))
     OR EXISTS (SELECT 1 FROM pg_auth_members am
                 WHERE am.member = 'jale_cap_org_limits'::regrole
                    OR (am.roleid = 'jale_cap_org_limits'::regrole AND (am.inherit_option OR am.set_option))) THEN
    RAISE EXCEPTION 'migration 128: jale_cap_org_limits has unsafe attributes or memberships';
  END IF;
  SELECT array_agg(c.relname || ':' || a.attname || ':' || p.privilege
                   ORDER BY (c.relname || ':' || a.attname || ':' || p.privilege) COLLATE "C")
    INTO v_grants
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE')) p(privilege)
   WHERE c.oid IN ('public.organizations'::regclass, 'public.organization_members'::regclass, 'public.jobs'::regclass,
                   'public.employer_job_templates'::regclass, 'public.users'::regclass,
                   'public.organization_invites'::regclass)
     AND has_column_privilege('jale_cap_org_limits', c.oid, a.attname, p.privilege);
  IF v_grants IS DISTINCT FROM ARRAY[
    'employer_job_templates:employer_id:SELECT', 'employer_job_templates:id:SELECT',
    'jobs:employer_id:SELECT', 'jobs:id:SELECT', 'jobs:status:SELECT',
    'organization_invites:accepted_at:SELECT', 'organization_invites:expires_at:SELECT',
    'organization_invites:organization_id:SELECT', 'organization_invites:revoked_at:SELECT',
    'organization_members:billing_suspended_at:SELECT',
    'organization_members:organization_id:SELECT', 'organization_members:role:SELECT',
    'organization_members:status:SELECT', 'organization_members:user_id:SELECT',
    'organizations:id:SELECT', 'organizations:updated_at:UPDATE',
    'users:cognito_sub:SELECT', 'users:id:SELECT', 'users:user_type:SELECT'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'migration 128: jale_cap_org_limits column rights are not as reviewed (%)', v_grants;
  END IF;

  -- The enforcer: its rights on jobs and users are 125's exact set, unchanged ...
  SELECT array_agg(c.relname || ':' || a.attname || ':' || p.privilege
                   ORDER BY (c.relname || ':' || a.attname || ':' || p.privilege) COLLATE "C")
    INTO v_grants
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(privilege)
   WHERE c.oid IN ('public.jobs'::regclass, 'public.users'::regclass)
     AND has_column_privilege('jale_billing_job_enforcer', c.oid, a.attname, p.privilege);
  IF v_grants IS DISTINCT FROM ARRAY[
    'jobs:billing_paused_at:SELECT', 'jobs:billing_paused_at:UPDATE', 'jobs:created_at:SELECT',
    'jobs:employer_id:SELECT', 'jobs:id:SELECT', 'jobs:number_of_workers_needed:SELECT', 'jobs:public_code:SELECT',
    'jobs:public_listing_enabled:SELECT', 'jobs:status:SELECT', 'jobs:status:UPDATE', 'jobs:title:SELECT',
    'jobs:updated_at:UPDATE', 'jobs:workers_hired:SELECT',
    'users:email:SELECT', 'users:id:SELECT', 'users:id:UPDATE', 'users:user_type:SELECT'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'migration 128: jale_billing_job_enforcer rights on jobs/users drifted (%)', v_grants;
  END IF;
  -- ... and on the company tables, exactly these.
  SELECT array_agg(c.relname || ':' || a.attname || ':' || p.privilege
                   ORDER BY (c.relname || ':' || a.attname || ':' || p.privilege) COLLATE "C")
    INTO v_grants
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE')) p(privilege)
   WHERE c.oid IN ('public.organizations'::regclass, 'public.organization_members'::regclass, 'public.organization_invites'::regclass)
     AND has_column_privilege('jale_billing_job_enforcer', c.oid, a.attname, p.privilege);
  IF v_grants IS DISTINCT FROM ARRAY[
    'organization_invites:accepted_at:SELECT', 'organization_invites:created_at:SELECT', 'organization_invites:expires_at:SELECT',
    'organization_invites:id:SELECT', 'organization_invites:organization_id:SELECT',
    'organization_invites:revoked_at:SELECT', 'organization_invites:revoked_at:UPDATE',
    'organization_members:billing_suspended_at:SELECT', 'organization_members:billing_suspended_at:UPDATE',
    'organization_members:joined_at:SELECT', 'organization_members:organization_id:SELECT', 'organization_members:role:SELECT',
    'organization_members:status:SELECT', 'organization_members:status:UPDATE',
    'organization_members:status_changed_at:SELECT', 'organization_members:status_changed_at:UPDATE',
    'organization_members:user_id:SELECT',
    'organizations:id:SELECT', 'organizations:updated_at:UPDATE'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'migration 128: jale_billing_job_enforcer rights on the company tables are not as reviewed (%)', v_grants;
  END IF;

  -- No runtime login on organizations; the processor's login still reaches
  -- companies, memberships, jobs and users only through the enforcer.
  IF has_any_column_privilege('jale_api', 'public.organizations', 'SELECT')
     OR has_any_column_privilege('jale_billing', 'public.organizations', 'SELECT')
     OR has_any_column_privilege('jale_billing', 'public.organization_members', 'SELECT')
     OR has_any_column_privilege('jale_billing', 'public.organization_invites', 'SELECT')
     OR has_table_privilege('jale_billing', 'public.jobs', 'SELECT,UPDATE')
     OR has_table_privilege('jale_billing', 'public.users', 'SELECT,UPDATE') THEN
    RAISE EXCEPTION 'migration 128: a runtime login holds a right on the company tables it must not';
  END IF;

  -- Every window is closed, and the enforcer keeps 125's shape: a member of
  -- nothing, no SET or INHERIT row in it, and this login's ADMIN row (036).
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member
     WHERE g.rolname IN ('jale_rls_relationship_reader', 'jale_cap_org_limits', 'jale_billing_job_enforcer')
       AND u.rolname = current_user AND (m.set_option OR m.inherit_option)
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members am
     WHERE am.member = 'jale_billing_job_enforcer'::regrole
        OR (am.roleid = 'jale_billing_job_enforcer'::regrole AND (am.inherit_option OR am.set_option))
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_auth_members am
     WHERE am.roleid = 'jale_billing_job_enforcer'::regrole
       AND am.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND am.admin_option
  ) THEN
    RAISE EXCEPTION 'migration 128: a role window was left open, or jale_billing_job_enforcer''s memberships drifted';
  END IF;
END $$;

COMMIT;
