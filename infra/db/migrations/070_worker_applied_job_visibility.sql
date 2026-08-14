-- ============================================================
-- 070_worker_applied_job_visibility.sql
-- Run manually AFTER 069_employer_job_templates.sql, connected as jale_admin
-- (NOT the RDS master user). Forward-only (ADR-005).
--
-- Close-job feature: workers must keep read access to jobs they applied to,
-- in ANY status. Today the only worker-facing SELECT policy on jobs is
-- jobs_worker_read_active (007, status='active'), so the moment an employer
-- closes a job the applicant's GET /worker/applications row vanishes and
-- GET /worker/jobs/{id} 404s (its OR-worker-has-applied clause is dead code
-- under RLS).
--
-- A naive EXISTS(job_applications ...) policy on jobs recurses at plan time
-- (42P17): applications_employer_select subqueries jobs. Same class of
-- failure 020b and 038 repaired. Fix: a SECURITY DEFINER predicate owned by
-- the 038 NOLOGIN helper (jale_rls_relationship_reader), whose USING(true)
-- policies and column grants on job_applications(worker_id, job_id) already
-- cover this — NO new grants (038's negative invariants forbid widening).
--
-- Documented constraints (accepted in the design spec):
--   * RLS is row-level: every current and future jobs column is visible to
--     applicants of that job. Employer-private data must never live on jobs.
--   * Access lasts as long as the application row exists (rows are never
--     deleted today). A future withdraw/block feature needs a carve-out here.
--
-- Deploy order: apply this BEFORE the worker-applications-list /
-- worker-jobs-detail Lambda deploy. The policy is purely additive, so the
-- old code keeps working in either order.
-- ============================================================
BEGIN;

-- The 038 helper must already exist with its reviewed attribute set; this
-- migration must not run against a database that skipped 038.
DO $$
DECLARE
  helper pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO helper
    FROM pg_roles
   WHERE rolname = 'jale_rls_relationship_reader';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'jale_rls_relationship_reader missing - apply migration 038 first';
  END IF;
  IF helper.rolcanlogin OR helper.rolsuper OR helper.rolcreatedb
     OR helper.rolcreaterole OR helper.rolinherit OR helper.rolreplication
     OR helper.rolbypassrls THEN
    RAISE EXCEPTION 'Existing jale_rls_relationship_reader role has unsafe attributes';
  END IF;
END;
$$;

-- Refuse to replace a predicate someone else planted (038 pattern; oidvector
-- '25 2950' pins the TEXT, UUID signature).
DO $$
DECLARE
  predicate_owner NAME;
BEGIN
  SELECT owner.rolname INTO predicate_owner
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN pg_roles owner ON owner.oid = function.proowner
   WHERE namespace.nspname = 'jale_internal'
     AND function.proname = 'worker_has_application'
     AND function.proargtypes = '25 2950'::pg_catalog.oidvector;

  IF FOUND AND predicate_owner <> 'jale_rls_relationship_reader' THEN
    RAISE EXCEPTION 'Existing worker_has_application predicate has unexpected owner %', predicate_owner;
  END IF;
END;
$$;

-- Recreate the dependent policy from scratch below; drop it before touching
-- the function it references.
DROP POLICY IF EXISTS jobs_worker_read_applied ON jobs;

-- Temporarily add SET capability so this session can create the function AS
-- the helper. Plain PG16 records a self-grant while RDS updates its rdsadmin
-- grant; the cleanup below handles both shapes (038 pattern, lines 90-165).
GRANT jale_rls_relationship_reader TO jale_admin
  WITH SET TRUE, INHERIT FALSE;

SET LOCAL ROLE jale_rls_relationship_reader;
DROP FUNCTION IF EXISTS jale_internal.worker_has_application(TEXT, UUID);
CREATE FUNCTION jale_internal.worker_has_application(
  -- TEXT, not UUID: current_setting() returns text, and after any transaction
  -- has set the GUC on a pooled connection its reset value is '' — a UUID
  -- parameter would raise 22P02 on every later read of jobs. '' and NULL both
  -- fail closed under the ::TEXT comparison.
  p_worker_internal_id TEXT,
  p_job_id UUID
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
     WHERE ja.job_id = p_job_id
       AND ja.worker_id::TEXT = p_worker_internal_id
  );
$$;
REVOKE ALL ON FUNCTION jale_internal.worker_has_application(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_internal.worker_has_application(TEXT, UUID) TO jale_admin;
RESET ROLE;
-- Disable SET on the selected grantor row, then remove any plain-PG self-grant.
GRANT jale_rls_relationship_reader TO jale_admin
  WITH SET FALSE, INHERIT FALSE;
REVOKE jale_rls_relationship_reader FROM jale_admin GRANTED BY jale_admin;

-- Permissive: ORs with jobs_worker_read_active (007). The caller-is-worker
-- guard copies 007's cognito-sub idiom verbatim — verified acyclic post-038
-- (users policies for jale_admin never subquery jobs/job_applications
-- directly; the 038 definer predicate is opaque to the planner).
CREATE POLICY jobs_worker_read_applied
  ON jobs FOR SELECT TO jale_admin
  USING (
    (SELECT user_type FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)) = 'worker'
    AND jale_internal.worker_has_application(
      current_setting('app.current_internal_user_id', true),
      id
    )
  );

-- Fail closed if the helper, predicate, ACL, or policy differs from the
-- reviewed PostgreSQL 16 security model (038's five invariant categories).
DO $$
DECLARE
  predicate RECORD;
BEGIN
  -- 1. Exactly one helper membership row: the superuser-granted ADMIN row.
  IF (SELECT count(*) FROM pg_auth_members membership
       JOIN pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_roles member ON member.oid = membership.member
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

  -- 2. Column grants unchanged: exactly what 038 granted, nothing more.
  IF NOT has_column_privilege('jale_rls_relationship_reader', 'job_applications', 'worker_id', 'SELECT')
     OR NOT has_column_privilege('jale_rls_relationship_reader', 'job_applications', 'job_id', 'SELECT')
     OR has_column_privilege('jale_rls_relationship_reader', 'jobs', 'title', 'SELECT')
     OR has_column_privilege('jale_rls_relationship_reader', 'job_applications', 'status', 'SELECT')
     OR has_table_privilege('jale_rls_relationship_reader', 'jobs', 'UPDATE')
     OR has_table_privilege('jale_rls_relationship_reader', 'job_applications', 'UPDATE') THEN
    RAISE EXCEPTION 'jale_rls_relationship_reader column privilege invariant failed';
  END IF;

  -- 3. Predicate owner / SECURITY DEFINER / STABLE / pinned search_path.
  SELECT owner.rolname AS owner_name, function.prosecdef, function.provolatile,
         function.proconfig
    INTO predicate
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN pg_roles owner ON owner.oid = function.proowner
   WHERE function.oid = to_regprocedure(
     'jale_internal.worker_has_application(TEXT, UUID)'
   );
  IF NOT FOUND OR predicate.owner_name <> 'jale_rls_relationship_reader'
     OR NOT predicate.prosecdef OR predicate.provolatile <> 's'
     OR predicate.proconfig <> ARRAY['search_path=pg_catalog, pg_temp']::TEXT[] THEN
    RAISE EXCEPTION 'worker_has_application predicate definition invariant failed';
  END IF;

  -- 4. No PUBLIC on the schema or the predicate; jale_admin keeps USAGE and
  --    EXECUTE (all five 038 invariant categories, spec §1).
  IF EXISTS (
    SELECT 1 FROM pg_namespace namespace,
         LATERAL aclexplode(COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))) acl
     WHERE namespace.nspname = 'jale_internal'
       AND acl.grantee = 0 AND acl.privilege_type IN ('USAGE', 'CREATE')
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function,
         LATERAL aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
     WHERE function.oid = to_regprocedure(
       'jale_internal.worker_has_application(TEXT, UUID)'
     ) AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ) OR NOT has_schema_privilege('jale_admin', 'jale_internal', 'USAGE')
    OR NOT has_function_privilege(
    'jale_admin',
    'jale_internal.worker_has_application(TEXT, UUID)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'worker_has_application PUBLIC/EXECUTE privilege invariant failed';
  END IF;

  -- 5. The new policy targets exactly jale_admin.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy policy
     WHERE policy.polname = 'jobs_worker_read_applied'
       AND policy.polrelid = 'public.jobs'::regclass
       AND policy.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'jale_admin')]
  ) THEN
    RAISE EXCEPTION 'jobs_worker_read_applied policy role invariant failed';
  END IF;
END;
$$;

COMMIT;
