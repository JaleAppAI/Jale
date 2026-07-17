-- 038_rls_relationship_recursion_repair.sql
-- Repair the users -> applications/jobs -> users RLS recursion without a
-- superuser/BYPASSRLS helper. The dedicated NOLOGIN role can read only the
-- relationship columns required by the SECURITY DEFINER predicate.

BEGIN;

DO $$
DECLARE
  helper pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO helper
    FROM pg_roles
   WHERE rolname = 'jale_rls_relationship_reader';

  IF NOT FOUND THEN
    CREATE ROLE jale_rls_relationship_reader
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    SELECT * INTO helper FROM pg_roles WHERE rolname = 'jale_rls_relationship_reader';
  END IF;

  IF helper.rolcanlogin OR helper.rolsuper OR helper.rolcreatedb
     OR helper.rolcreaterole OR helper.rolinherit OR helper.rolreplication
     OR helper.rolbypassrls THEN
    RAISE EXCEPTION 'Existing jale_rls_relationship_reader role has unsafe attributes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_auth_members membership
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
    RAISE EXCEPTION 'Existing jale_rls_relationship_reader role has unsafe memberships';
  END IF;
END;
$$;

-- The original migration-003 policies were created without TO and therefore
-- applied to PUBLIC, including the helper role. Retarget them to the web app
-- role. Migration-007's worker marketplace policy has the same issue.
ALTER POLICY jobs_employer_select       ON jobs             TO jale_admin;
ALTER POLICY jobs_employer_insert       ON jobs             TO jale_admin;
ALTER POLICY jobs_employer_update       ON jobs             TO jale_admin;
ALTER POLICY applications_worker_select ON job_applications TO jale_admin;
ALTER POLICY applications_worker_insert ON job_applications TO jale_admin;
ALTER POLICY applications_employer_select ON job_applications TO jale_admin;
ALTER POLICY applications_employer_update ON job_applications TO jale_admin;
ALTER POLICY jobs_worker_read_active    ON jobs             TO jale_admin;

GRANT SELECT (worker_id, job_id) ON job_applications TO jale_rls_relationship_reader;
GRANT SELECT (id, employer_id) ON jobs TO jale_rls_relationship_reader;
GRANT USAGE ON SCHEMA public TO jale_rls_relationship_reader;

DROP POLICY IF EXISTS job_applications_relationship_reader ON job_applications;
CREATE POLICY job_applications_relationship_reader
  ON job_applications FOR SELECT TO jale_rls_relationship_reader
  USING (true);

DROP POLICY IF EXISTS jobs_relationship_reader ON jobs;
CREATE POLICY jobs_relationship_reader
  ON jobs FOR SELECT TO jale_rls_relationship_reader
  USING (true);

-- Temporarily permit the migration owner to SET ROLE. The helper creates and
-- owns both the locked schema and function, so no ownership transfer depends
-- on CREATE privileges in public.
GRANT jale_rls_relationship_reader TO jale_admin;

DO $$
DECLARE
  internal_schema_owner NAME;
BEGIN
  SELECT owner.rolname INTO internal_schema_owner
    FROM pg_namespace namespace
    JOIN pg_roles owner ON owner.oid = namespace.nspowner
   WHERE namespace.nspname = 'jale_internal';

  IF NOT FOUND THEN
    CREATE SCHEMA jale_internal AUTHORIZATION jale_rls_relationship_reader;
  ELSIF internal_schema_owner <> 'jale_rls_relationship_reader' THEN
    RAISE EXCEPTION 'Existing jale_internal schema has unexpected owner %', internal_schema_owner;
  END IF;
END;
$$;

SET LOCAL ROLE jale_rls_relationship_reader;
REVOKE ALL ON SCHEMA jale_internal FROM PUBLIC;
RESET ROLE;

-- Remove the dependent policy before refreshing the function. Recreating as
-- the helper is rerun-safe and cannot preserve an unexpected prior owner.
DROP POLICY IF EXISTS users_employer_applicant_read ON users;

DO $$
DECLARE
  predicate_owner NAME;
BEGIN
  SELECT owner.rolname INTO predicate_owner
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN pg_roles owner ON owner.oid = function.proowner
   WHERE namespace.nspname = 'jale_internal'
     AND function.proname = 'employer_has_applicant_relationship'
     AND function.proargtypes = '25 2950'::pg_catalog.oidvector;

  IF FOUND AND predicate_owner <> 'jale_rls_relationship_reader' THEN
    RAISE EXCEPTION 'Existing relationship predicate has unexpected owner %', predicate_owner;
  END IF;
END;
$$;

SET LOCAL ROLE jale_rls_relationship_reader;
DROP FUNCTION IF EXISTS jale_internal.employer_has_applicant_relationship(TEXT, UUID);
CREATE FUNCTION jale_internal.employer_has_applicant_relationship(
  p_employer_internal_id TEXT,
  p_worker_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.job_applications ja
      JOIN public.jobs j ON j.id = ja.job_id
     WHERE ja.worker_id = p_worker_id
       AND j.employer_id::TEXT = p_employer_internal_id
  );
$$;
REVOKE ALL ON FUNCTION jale_internal.employer_has_applicant_relationship(TEXT, UUID) FROM PUBLIC;
GRANT USAGE ON SCHEMA jale_internal TO jale_admin;
GRANT EXECUTE ON FUNCTION jale_internal.employer_has_applicant_relationship(TEXT, UUID) TO jale_admin;
RESET ROLE;
REVOKE jale_rls_relationship_reader FROM jale_admin;

CREATE POLICY users_employer_applicant_read
  ON users FOR SELECT TO jale_admin
  USING (
    user_type = 'worker'
    AND jale_internal.employer_has_applicant_relationship(
      current_setting('app.current_internal_user_id', true),
      id
    )
  );

-- Fail closed if the helper, predicate, ACL, or confirmed retarget set differs
-- from the reviewed PostgreSQL 16 security model.
DO $$
DECLARE
  predicate RECORD;
  policy_name NAME;
BEGIN
  IF (SELECT count(*) FROM pg_auth_members membership
       JOIN pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_roles member ON member.oid = membership.member
       JOIN pg_roles grantor ON grantor.oid = membership.grantor
      WHERE granted.rolname = 'jale_rls_relationship_reader'
         OR member.rolname = 'jale_rls_relationship_reader') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_auth_members membership
       JOIN pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_roles member ON member.oid = membership.member
       JOIN pg_roles grantor ON grantor.oid = membership.grantor
      WHERE granted.rolname = 'jale_rls_relationship_reader'
        AND member.rolname = 'jale_admin'
        AND membership.admin_option
        AND NOT membership.inherit_option
        AND NOT membership.set_option
        AND grantor.rolsuper
     ) THEN
    RAISE EXCEPTION 'jale_rls_relationship_reader creator membership invariant failed';
  END IF;

  IF NOT has_column_privilege('jale_rls_relationship_reader', 'jobs', 'id', 'SELECT')
     OR NOT has_column_privilege('jale_rls_relationship_reader', 'jobs', 'employer_id', 'SELECT')
     OR NOT has_column_privilege('jale_rls_relationship_reader', 'job_applications', 'worker_id', 'SELECT')
     OR NOT has_column_privilege('jale_rls_relationship_reader', 'job_applications', 'job_id', 'SELECT')
     OR has_column_privilege('jale_rls_relationship_reader', 'jobs', 'title', 'SELECT')
     OR has_column_privilege('jale_rls_relationship_reader', 'job_applications', 'status', 'SELECT')
     OR has_table_privilege('jale_rls_relationship_reader', 'jobs', 'UPDATE')
     OR has_table_privilege('jale_rls_relationship_reader', 'job_applications', 'UPDATE') THEN
    RAISE EXCEPTION 'jale_rls_relationship_reader column privilege invariant failed';
  END IF;

  SELECT owner.rolname AS owner_name, function.prosecdef, function.provolatile,
         function.proconfig
    INTO predicate
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN pg_roles owner ON owner.oid = function.proowner
   WHERE function.oid = to_regprocedure(
     'jale_internal.employer_has_applicant_relationship(TEXT, UUID)'
   );
  IF NOT FOUND OR predicate.owner_name <> 'jale_rls_relationship_reader'
     OR NOT predicate.prosecdef OR predicate.provolatile <> 's'
     OR predicate.proconfig <> ARRAY['search_path=pg_catalog, pg_temp']::TEXT[] THEN
    RAISE EXCEPTION 'Relationship predicate definition invariant failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_namespace namespace,
         LATERAL aclexplode(COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))) acl
     WHERE namespace.nspname = 'jale_internal'
       AND acl.grantee = 0 AND acl.privilege_type IN ('USAGE', 'CREATE')
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function,
         LATERAL aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
     WHERE function.oid = to_regprocedure(
       'jale_internal.employer_has_applicant_relationship(TEXT, UUID)'
     ) AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'jale_internal PUBLIC privilege invariant failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_namespace namespace
    JOIN pg_roles owner ON owner.oid = namespace.nspowner
    WHERE namespace.nspname = 'jale_internal'
      AND owner.rolname = 'jale_rls_relationship_reader'
  ) OR NOT has_schema_privilege('jale_admin', 'jale_internal', 'USAGE')
    OR has_schema_privilege('jale_admin', 'jale_internal', 'CREATE')
    OR NOT has_function_privilege(
      'jale_admin',
      'jale_internal.employer_has_applicant_relationship(TEXT, UUID)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'jale_internal owner or jale_admin privilege invariant failed';
  END IF;

  FOREACH policy_name IN ARRAY ARRAY[
    'jobs_employer_select', 'jobs_employer_insert', 'jobs_employer_update',
    'applications_worker_select', 'applications_worker_insert',
    'applications_employer_select', 'applications_employer_update',
    'jobs_worker_read_active'
  ]::NAME[] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy policy
       WHERE policy.polname = policy_name
         AND policy.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'jale_admin')]
    ) THEN
      RAISE EXCEPTION 'Policy % role invariant failed', policy_name;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
