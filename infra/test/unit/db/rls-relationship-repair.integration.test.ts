import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: relationship RLS repair PostgreSQL gate was not run', () => {
    console.warn('[rls-relationship-repair] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

function roleUrl(base: string, role: string, password: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function asApp<T>(url: string, cognitoSub: string, internalId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [cognitoSub]);
    await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [internalId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}

maybeDescribe('native relationship RLS recursion repair migration 040', () => {
  let adminUrl: string;
  let employer1: { id: string; sub: string };
  let employer2: { id: string; sub: string };
  let worker: { id: string; sub: string };
  let jobId: string;
  let applicationId: string;

  beforeAll(async () => {
    const setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    try {
      if (new URL(databaseUrl!).username !== 'jale_admin') {
        await setup.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
      }
      const users = await setup.query<{ id: string; cognito_sub: string }>(
        `INSERT INTO users (cognito_sub, user_type)
         VALUES ('r39-employer-1', 'employer'), ('r39-employer-2', 'employer'), ('r39-worker-1', 'worker')
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id, cognito_sub`,
      );
      const bySub = new Map(users.rows.map((row) => [row.cognito_sub, row.id]));
      employer1 = { id: bySub.get('r39-employer-1')!, sub: 'r39-employer-1' };
      employer2 = { id: bySub.get('r39-employer-2')!, sub: 'r39-employer-2' };
      worker = { id: bySub.get('r39-worker-1')!, sub: 'r39-worker-1' };
      await setup.query(
        `INSERT INTO worker_profiles (user_id, full_name, location)
         VALUES ($1, 'R39 Worker', 'Austin')
         ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name`,
        [worker.id],
      );
      await setup.query(
        `INSERT INTO worker_skills (worker_id, skill) VALUES ($1, 'carpentry')
         ON CONFLICT DO NOTHING`,
        [worker.id],
      );
      const job = await setup.query<{ id: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, status)
         VALUES ($1, 'R39 active job', 'Austin', 'full-time', 'active') RETURNING id`,
        [employer1.id],
      );
      jobId = job.rows[0].id;
      const application = await setup.query<{ id: string }>(
        `INSERT INTO job_applications (job_id, worker_id, status)
         VALUES ($1, $2, 'pending') RETURNING id`,
        [jobId, worker.id],
      );
      applicationId = application.rows[0].id;
    } finally { await setup.end(); }
    adminUrl = new URL(databaseUrl!).username === 'jale_admin'
      ? databaseUrl!
      : roleUrl(databaseUrl!, 'jale_admin', 'test-admin-pw');
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    const cleanup = new Client({ connectionString: databaseUrl });
    await cleanup.connect();
    try {
      await cleanup.query("DELETE FROM job_applications WHERE id = $1", [applicationId]);
      await cleanup.query('DELETE FROM jobs WHERE id = $1', [jobId]);
      await cleanup.query("DELETE FROM users WHERE cognito_sub LIKE 'r39-%'");
    } finally { await cleanup.end(); }
  });

  it('avoids 42P17 and exposes the applicant worker only to the related employer', async () => {
    const related = await asApp(adminUrl, employer1.sub, employer1.id, (client) =>
      client.query('SELECT id FROM users WHERE id = $1', [worker.id]));
    expect(related.rows).toEqual([{ id: worker.id }]);

    const unrelated = await asApp(adminUrl, employer2.sub, employer2.id, (client) =>
      client.query('SELECT id FROM users WHERE id = $1', [worker.id]));
    expect(unrelated.rows).toEqual([]);
  });

  it('preserves normal employer and worker job/application access', async () => {
    const employerJob = await asApp(adminUrl, employer1.sub, employer1.id, (client) =>
      client.query('SELECT id FROM jobs WHERE id = $1', [jobId]));
    expect(employerJob.rows).toEqual([{ id: jobId }]);
    const employerApplication = await asApp(adminUrl, employer1.sub, employer1.id, (client) =>
      client.query('SELECT id FROM job_applications WHERE id = $1', [applicationId]));
    expect(employerApplication.rows).toEqual([{ id: applicationId }]);
    const workerJob = await asApp(adminUrl, worker.sub, worker.id, (client) =>
      client.query('SELECT id FROM jobs WHERE id = $1', [jobId]));
    expect(workerJob.rows).toEqual([{ id: jobId }]);
    const workerApplication = await asApp(adminUrl, worker.sub, worker.id, (client) =>
      client.query('SELECT id FROM job_applications WHERE id = $1', [applicationId]));
    expect(workerApplication.rows).toEqual([{ id: applicationId }]);

    const relatedProfile = await asApp(adminUrl, employer1.sub, employer1.id, (client) =>
      client.query('SELECT user_id FROM worker_profiles WHERE user_id = $1', [worker.id]));
    expect(relatedProfile.rows).toEqual([{ user_id: worker.id }]);
    const unrelatedProfile = await asApp(adminUrl, employer2.sub, employer2.id, (client) =>
      client.query('SELECT user_id FROM worker_profiles WHERE user_id = $1', [worker.id]));
    expect(unrelatedProfile.rows).toEqual([]);
    const relatedSkill = await asApp(adminUrl, employer1.sub, employer1.id, (client) =>
      client.query('SELECT worker_id FROM worker_skills WHERE worker_id = $1', [worker.id]));
    expect(relatedSkill.rows).toEqual([{ worker_id: worker.id }]);
    const unrelatedSkill = await asApp(adminUrl, employer2.sub, employer2.id, (client) =>
      client.query('SELECT worker_id FROM worker_skills WHERE worker_id = $1', [worker.id]));
    expect(unrelatedSkill.rows).toEqual([]);
  });

  it('returns no applicant rows without identity context and resists temp-schema shadowing', async () => {
    const noContext = new Client({ connectionString: adminUrl });
    await noContext.connect();
    try {
      const result = await noContext.query('SELECT id FROM users WHERE id = $1', [worker.id]);
      expect(result.rows).toEqual([]);
    } finally { await noContext.end(); }

    const shadowed = await asApp(adminUrl, employer1.sub, employer1.id, async (client) => {
      await client.query(
        `CREATE FUNCTION pg_temp.employer_has_applicant_relationship(TEXT, UUID)
         RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS 'SELECT false'`,
      );
      return client.query('SELECT id FROM users WHERE id = $1', [worker.id]);
    });
    expect(shadowed.rows).toEqual([{ id: worker.id }]);
  });

  it('keeps the helper/internal schema narrow and only the PG16 creator ADMIN row', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const role = await client.query(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
                rolreplication, rolbypassrls
           FROM pg_roles
          WHERE rolname = 'jale_rls_relationship_reader'`,
      );
      expect(role.rows[0]).toEqual({
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      });
      const privileges = await client.query(
        `SELECT has_table_privilege('jale_rls_relationship_reader', 'jobs', 'UPDATE') AS jobs_update,
                has_table_privilege('jale_rls_relationship_reader', 'job_applications', 'UPDATE') AS apps_update,
                has_column_privilege('jale_rls_relationship_reader', 'jobs', 'employer_id', 'SELECT') AS employer_read,
                has_column_privilege('jale_rls_relationship_reader', 'jobs', 'title', 'SELECT') AS title_read,
                has_column_privilege('jale_rls_relationship_reader', 'job_applications', 'status', 'SELECT') AS status_read,
                has_schema_privilege('jale_rls_relationship_reader', 'public', 'USAGE') AS public_usage,
                has_schema_privilege('jale_admin', 'jale_internal', 'USAGE') AS admin_usage,
                has_schema_privilege('jale_admin', 'jale_internal', 'CREATE') AS admin_create,
                has_function_privilege(
                  'jale_admin',
                  'jale_internal.employer_has_applicant_relationship(text, uuid)',
                  'EXECUTE'
                ) AS admin_execute`,
      );
      expect(privileges.rows[0]).toEqual({
        jobs_update: false,
        apps_update: false,
        employer_read: true,
        title_read: false,
        status_read: false,
        public_usage: true,
        admin_usage: true,
        admin_create: false,
        admin_execute: true,
      });
      const internalObjects = await client.query(
        `SELECT owner.rolname AS schema_owner,
                function_owner.rolname AS function_owner,
                function.prosecdef,
                function.provolatile,
                function.proconfig,
                NOT EXISTS (
                  SELECT 1 FROM aclexplode(COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))) acl
                   WHERE acl.grantee = 0 AND acl.privilege_type = 'USAGE'
                ) AS no_public_usage,
                NOT EXISTS (
                  SELECT 1 FROM pg_proc function
                  JOIN pg_namespace function_namespace ON function_namespace.oid = function.pronamespace,
                       LATERAL aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
                   WHERE function_namespace.nspname = 'jale_internal'
                     AND function.proname = 'employer_has_applicant_relationship'
                     AND acl.grantee = 0
                     AND acl.privilege_type = 'EXECUTE'
                ) AS no_public_execute
           FROM pg_namespace namespace
           JOIN pg_roles owner ON owner.oid = namespace.nspowner
           JOIN pg_proc function ON function.pronamespace = namespace.oid
             AND function.proname = 'employer_has_applicant_relationship'
           JOIN pg_roles function_owner ON function_owner.oid = function.proowner
          WHERE namespace.nspname = 'jale_internal'`,
      );
      expect(internalObjects.rows[0]).toEqual({
        schema_owner: 'jale_rls_relationship_reader',
        function_owner: 'jale_rls_relationship_reader',
        prosecdef: true,
        provolatile: 's',
        proconfig: ['search_path=pg_catalog, pg_temp'],
        no_public_usage: true,
        no_public_execute: true,
      });
      const membership = await client.query(
        `SELECT member.rolname AS member, granted.rolname AS granted,
                m.admin_option, m.inherit_option, m.set_option, grantor.rolsuper AS grantor_super
           FROM pg_auth_members m
          JOIN pg_roles member ON member.oid = m.member
          JOIN pg_roles granted ON granted.oid = m.roleid
          JOIN pg_roles grantor ON grantor.oid = m.grantor
         WHERE member.rolname = 'jale_rls_relationship_reader'
            OR granted.rolname = 'jale_rls_relationship_reader'`,
      );
      expect(membership.rows).toEqual([{
        member: 'jale_admin',
        granted: 'jale_rls_relationship_reader',
        admin_option: true,
        inherit_option: false,
        set_option: false,
        grantor_super: true,
      }]);

      const policies = await client.query(
        `SELECT policy.polname, array_agg(role.rolname::text ORDER BY role.rolname)::text[] AS roles
           FROM pg_policy policy
           CROSS JOIN LATERAL unnest(policy.polroles) policy_role(oid)
           JOIN pg_roles role ON role.oid = policy_role.oid
          WHERE policy.polname = ANY($1::text[])
          GROUP BY policy.polname`,
        [[
          'jobs_employer_select', 'jobs_employer_insert', 'jobs_employer_update',
          'applications_worker_select', 'applications_worker_insert',
          'applications_employer_select', 'applications_employer_update',
          'jobs_worker_read_active', 'jobs_matching_read', 'applications_matching_read',
          'jobs_read_wa', 'jobapp_whatsapp_select', 'jobapp_whatsapp_insert', 'jobapp_whatsapp_update',
        ]],
      );
      const rolesByPolicy = Object.fromEntries(policies.rows.map((row) => [row.polname, row.roles]));
      for (const name of [
        'jobs_employer_select', 'jobs_employer_insert', 'jobs_employer_update',
        'applications_worker_select', 'applications_worker_insert',
        'applications_employer_select', 'applications_employer_update', 'jobs_worker_read_active',
      ]) expect(rolesByPolicy[name]).toEqual(['jale_admin']);
      expect(rolesByPolicy.jobs_matching_read).toEqual(['jale_matching']);
      expect(rolesByPolicy.applications_matching_read).toEqual(['jale_matching']);
      expect(rolesByPolicy.jobs_read_wa).toEqual(['jale_whatsapp']);
      expect(rolesByPolicy.jobapp_whatsapp_select).toEqual(['jale_whatsapp']);
      expect(rolesByPolicy.jobapp_whatsapp_insert).toEqual(['jale_whatsapp']);
      expect(rolesByPolicy.jobapp_whatsapp_update).toEqual(['jale_whatsapp']);
    } finally { await client.end(); }
  });
});
