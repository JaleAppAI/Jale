-- 037_billing_job_limit_enforcement.sql
-- Enforce reduced employer entitlements without granting jale_billing direct
-- access to users or jobs. PostgreSQL 16 records one unavoidable creator ADMIN
-- row for CREATEROLE-created helpers; it must never carry SET or INHERIT.

BEGIN;

DO $$
DECLARE
  helper pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO helper FROM pg_roles WHERE rolname = 'jale_billing_job_enforcer';
  IF NOT FOUND THEN
    CREATE ROLE jale_billing_job_enforcer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    SELECT * INTO helper FROM pg_roles WHERE rolname = 'jale_billing_job_enforcer';
  END IF;

  IF helper.rolcanlogin OR helper.rolsuper OR helper.rolcreatedb
     OR helper.rolcreaterole OR helper.rolinherit OR helper.rolreplication
     OR helper.rolbypassrls THEN
    RAISE EXCEPTION 'Existing jale_billing_job_enforcer role has unsafe attributes';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles granted ON granted.oid = membership.roleid
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles grantor ON grantor.oid = membership.grantor
     WHERE (granted.rolname = helper.rolname OR member.rolname = helper.rolname)
       AND NOT (
         granted.rolname = helper.rolname
         AND member.rolname = 'jale_admin'
         AND membership.admin_option
         AND NOT membership.inherit_option
         AND NOT membership.set_option
         AND grantor.rolsuper
       )
  ) THEN
    RAISE EXCEPTION 'Existing jale_billing_job_enforcer role has unsafe memberships';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO jale_billing_job_enforcer;
GRANT SELECT (id, user_type, email), UPDATE (id) ON users TO jale_billing_job_enforcer;
GRANT SELECT (id, employer_id, title, status, created_at),
      UPDATE (status, updated_at) ON jobs TO jale_billing_job_enforcer;

DROP POLICY IF EXISTS users_billing_job_enforcer_select ON users;
CREATE POLICY users_billing_job_enforcer_select
  ON users FOR SELECT TO jale_billing_job_enforcer USING (true);
DROP POLICY IF EXISTS users_billing_job_enforcer_lock ON users;
CREATE POLICY users_billing_job_enforcer_lock
  ON users FOR UPDATE TO jale_billing_job_enforcer USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS jobs_billing_job_enforcer_select ON jobs;
CREATE POLICY jobs_billing_job_enforcer_select
  ON jobs FOR SELECT TO jale_billing_job_enforcer USING (true);
DROP POLICY IF EXISTS jobs_billing_job_enforcer_update ON jobs;
CREATE POLICY jobs_billing_job_enforcer_update
  ON jobs FOR UPDATE TO jale_billing_job_enforcer USING (true) WITH CHECK (true);

GRANT jale_billing_job_enforcer TO jale_admin;

DO $$
DECLARE
  internal_schema_owner NAME;
BEGIN
  SELECT owner.rolname INTO internal_schema_owner
    FROM pg_namespace namespace
    JOIN pg_roles owner ON owner.oid = namespace.nspowner
   WHERE namespace.nspname = 'jale_billing_internal';
  IF NOT FOUND THEN
    CREATE SCHEMA jale_billing_internal AUTHORIZATION jale_billing_job_enforcer;
  ELSIF internal_schema_owner <> 'jale_billing_job_enforcer' THEN
    RAISE EXCEPTION 'Existing jale_billing_internal schema has unexpected owner %', internal_schema_owner;
  END IF;
END;
$$;

REVOKE ALL ON SCHEMA jale_billing_internal FROM PUBLIC;
DROP FUNCTION IF EXISTS public.billing_pause_over_limit_jobs(UUID, INTEGER);

SET LOCAL ROLE jale_billing_job_enforcer;
DROP FUNCTION IF EXISTS jale_billing_internal.billing_pause_over_limit_jobs(UUID, INTEGER);
CREATE FUNCTION jale_billing_internal.billing_pause_over_limit_jobs(
  p_user_id UUID,
  p_active_job_limit INTEGER
)
RETURNS TABLE (
  paused_count INTEGER,
  employer_email TEXT,
  paused_titles TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_active_job_limit IS NULL OR p_active_job_limit < 0 THEN
    RAISE EXCEPTION 'billing_active_job_limit_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT u.email INTO employer_email
    FROM public.users u
   WHERE u.id = p_user_id AND u.user_type = 'employer'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_employer_not_found' USING ERRCODE = 'P0002';
  END IF;

  WITH ranked AS MATERIALIZED (
    SELECT j.id,
           row_number() OVER (ORDER BY j.created_at ASC, j.id ASC) AS active_rank
      FROM public.jobs j
     WHERE j.employer_id = p_user_id AND j.status = 'active'
  ), paused AS (
    UPDATE public.jobs j
       SET status = 'paused', updated_at = now()
      FROM ranked r
     WHERE j.id = r.id
       AND r.active_rank > p_active_job_limit
       AND j.status = 'active'
    RETURNING j.title, j.created_at, j.id
  )
  SELECT count(*)::INTEGER,
         COALESCE(array_agg(p.title ORDER BY p.created_at ASC, p.id ASC), ARRAY[]::TEXT[])
    INTO paused_count, paused_titles
    FROM paused p;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION jale_billing_internal.billing_pause_over_limit_jobs(UUID, INTEGER) FROM PUBLIC;
RESET ROLE;

GRANT USAGE ON SCHEMA jale_billing_internal TO jale_billing;
GRANT EXECUTE ON FUNCTION jale_billing_internal.billing_pause_over_limit_jobs(UUID, INTEGER)
  TO jale_billing;
REVOKE jale_billing_job_enforcer FROM jale_admin;

DO $$
DECLARE
  helper pg_roles%ROWTYPE;
  enforcer_function RECORD;
  policy_name NAME;
  actual_column_grants TEXT[];
BEGIN
  SELECT * INTO helper FROM pg_roles WHERE rolname = 'jale_billing_job_enforcer';
  IF NOT FOUND OR helper.rolcanlogin OR helper.rolsuper OR helper.rolcreatedb
     OR helper.rolcreaterole OR helper.rolinherit OR helper.rolreplication
     OR helper.rolbypassrls THEN
    RAISE EXCEPTION 'jale_billing_job_enforcer role attribute invariant failed';
  END IF;

  IF NOT has_column_privilege('jale_billing_job_enforcer', 'users', 'id', 'SELECT')
     OR NOT has_column_privilege('jale_billing_job_enforcer', 'users', 'user_type', 'SELECT')
     OR NOT has_column_privilege('jale_billing_job_enforcer', 'users', 'email', 'SELECT')
     OR NOT has_column_privilege('jale_billing_job_enforcer', 'users', 'id', 'UPDATE')
     OR has_column_privilege('jale_billing_job_enforcer', 'users', 'phone', 'SELECT')
     OR NOT has_column_privilege('jale_billing_job_enforcer', 'jobs', 'id', 'SELECT')
     OR NOT has_column_privilege('jale_billing_job_enforcer', 'jobs', 'employer_id', 'SELECT')
     OR NOT has_column_privilege('jale_billing_job_enforcer', 'jobs', 'title', 'SELECT')
     OR NOT has_column_privilege('jale_billing_job_enforcer', 'jobs', 'status', 'SELECT')
     OR NOT has_column_privilege('jale_billing_job_enforcer', 'jobs', 'created_at', 'SELECT')
     OR NOT has_column_privilege('jale_billing_job_enforcer', 'jobs', 'status', 'UPDATE')
     OR NOT has_column_privilege('jale_billing_job_enforcer', 'jobs', 'updated_at', 'UPDATE')
     OR has_column_privilege('jale_billing_job_enforcer', 'jobs', 'title', 'UPDATE')
     OR has_table_privilege('jale_billing_job_enforcer', 'users', 'INSERT,DELETE')
     OR has_table_privilege('jale_billing_job_enforcer', 'jobs', 'INSERT,DELETE') THEN
    RAISE EXCEPTION 'jale_billing_job_enforcer column privilege invariant failed';
  END IF;

  SELECT array_agg(
    table_name || ':' || column_name || ':' || privilege_type
    ORDER BY table_name, column_name, privilege_type
  ) INTO actual_column_grants
  FROM information_schema.column_privileges
  WHERE grantee = 'jale_billing_job_enforcer'
    AND table_schema = 'public'
    AND table_name IN ('users', 'jobs');
  IF actual_column_grants <> ARRAY[
    'jobs:created_at:SELECT', 'jobs:employer_id:SELECT', 'jobs:id:SELECT',
    'jobs:status:SELECT', 'jobs:status:UPDATE', 'jobs:title:SELECT',
    'jobs:updated_at:UPDATE', 'users:email:SELECT', 'users:id:SELECT',
    'users:id:UPDATE', 'users:user_type:SELECT'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'jale_billing_job_enforcer exact column grant invariant failed';
  END IF;

  FOREACH policy_name IN ARRAY ARRAY[
    'users_billing_job_enforcer_select', 'users_billing_job_enforcer_lock',
    'jobs_billing_job_enforcer_select', 'jobs_billing_job_enforcer_update'
  ]::NAME[] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy policy WHERE policy.polname = policy_name
        AND policy.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'jale_billing_job_enforcer')]
        AND policy.polcmd = CASE WHEN policy_name LIKE '%_select' THEN 'r' ELSE 'w' END
        AND pg_get_expr(policy.polqual, policy.polrelid) = 'true'
        AND (
          (policy_name LIKE '%_select' AND policy.polwithcheck IS NULL)
          OR (policy_name NOT LIKE '%_select'
            AND pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true')
        )
    ) THEN
      RAISE EXCEPTION 'Billing enforcer policy % invariant failed', policy_name;
    END IF;
  END LOOP;

  SELECT schema_owner.rolname AS schema_owner, function_owner.rolname AS function_owner,
         function.oid AS function_oid,
         function.prosecdef, function.provolatile, function.proconfig
    INTO enforcer_function
    FROM pg_namespace namespace
    JOIN pg_roles schema_owner ON schema_owner.oid = namespace.nspowner
    JOIN pg_proc function ON function.pronamespace = namespace.oid
      AND function.proname = 'billing_pause_over_limit_jobs'
    JOIN pg_roles function_owner ON function_owner.oid = function.proowner
   WHERE namespace.nspname = 'jale_billing_internal';
  IF NOT FOUND OR enforcer_function.schema_owner <> 'jale_billing_job_enforcer'
     OR enforcer_function.function_owner <> 'jale_billing_job_enforcer'
     OR NOT enforcer_function.prosecdef OR enforcer_function.provolatile <> 'v'
     OR enforcer_function.proconfig <> ARRAY['search_path=pg_catalog, pg_temp']::TEXT[] THEN
    RAISE EXCEPTION 'Billing enforcer schema/function invariant failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_namespace namespace,
      LATERAL aclexplode(COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))) acl
    WHERE namespace.nspname = 'jale_billing_internal' AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function,
      LATERAL aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
    WHERE function.oid = enforcer_function.function_oid
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ) OR NOT has_schema_privilege('jale_billing', 'jale_billing_internal', 'USAGE')
    OR has_schema_privilege('jale_billing', 'jale_billing_internal', 'CREATE')
    OR NOT has_function_privilege('jale_billing', enforcer_function.function_oid, 'EXECUTE')
    OR has_schema_privilege('jale_admin', 'jale_billing_internal', 'USAGE')
    OR has_function_privilege('jale_admin', enforcer_function.function_oid, 'EXECUTE')
    OR has_table_privilege('jale_billing', 'users', 'SELECT,UPDATE')
    OR has_table_privilege('jale_billing', 'jobs', 'SELECT,UPDATE') THEN
    RAISE EXCEPTION 'Billing enforcer ACL invariant failed';
  END IF;

  IF (SELECT count(*) FROM pg_auth_members membership
       JOIN pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_roles member ON member.oid = membership.member
       JOIN pg_roles grantor ON grantor.oid = membership.grantor
      WHERE granted.rolname = 'jale_billing_job_enforcer'
         OR member.rolname = 'jale_billing_job_enforcer') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_auth_members membership
       JOIN pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_roles member ON member.oid = membership.member
       JOIN pg_roles grantor ON grantor.oid = membership.grantor
      WHERE granted.rolname = 'jale_billing_job_enforcer'
        AND member.rolname = 'jale_admin'
        AND membership.admin_option
        AND NOT membership.inherit_option
        AND NOT membership.set_option
        AND grantor.rolsuper
     ) THEN
    RAISE EXCEPTION 'jale_billing_job_enforcer creator membership invariant failed';
  END IF;
END;
$$;

COMMIT;
