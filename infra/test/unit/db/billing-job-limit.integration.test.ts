import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: billing job-limit PostgreSQL gate was not run', () => {
    console.warn('[billing-job-limit] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}

const maybeDescribe = databaseUrl ? describe : describe.skip;

function urlForRole(base: string, role: string, password: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = password;
  return url.toString();
}

maybeDescribe('billing job-limit enforcement migration 036', () => {
  let employerId: string;
  let billingUrl: string;

  beforeAll(async () => {
    const setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    try {
      await setup.query(`ALTER ROLE jale_billing WITH PASSWORD 'test-billing-pw'`);
      const employer = await setup.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type, email)
         VALUES ('b3-limit-employer', 'employer', 'limit-employer@example.com')
         ON CONFLICT (cognito_sub) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
      );
      employerId = employer.rows[0].id;
      await setup.query('DELETE FROM jobs WHERE employer_id = $1', [employerId]);
      await setup.query(
        `INSERT INTO jobs (id, employer_id, title, location, job_type, status, created_at)
         VALUES
           ('10000000-0000-4000-8000-000000000001', $1, 'Oldest active', 'Austin', 'full-time', 'active', '2026-01-01'),
           ('10000000-0000-4000-8000-000000000002', $1, 'Second active', 'Austin', 'full-time', 'active', '2026-01-02'),
           ('10000000-0000-4000-8000-000000000003', $1, 'Newest active', 'Austin', 'full-time', 'active', '2026-01-03'),
           ('10000000-0000-4000-8000-000000000004', $1, 'Already paused', 'Austin', 'full-time', 'paused', '2026-01-04'),
           ('10000000-0000-4000-8000-000000000005', $1, 'Filled job', 'Austin', 'full-time', 'filled', '2026-01-05'),
           ('10000000-0000-4000-8000-000000000006', $1, 'Closed job', 'Austin', 'full-time', 'closed', '2026-01-06')`,
        [employerId],
      );
    } finally {
      await setup.end();
    }
    billingUrl = urlForRole(databaseUrl!, 'jale_billing', 'test-billing-pw');
  });

  afterAll(async () => {
    if (!databaseUrl || !employerId) return;
    const cleanup = new Client({ connectionString: databaseUrl });
    await cleanup.connect();
    try {
      await cleanup.query('DELETE FROM jobs WHERE employer_id = $1', [employerId]);
      await cleanup.query("DELETE FROM users WHERE cognito_sub = 'b3-limit-employer'");
    } finally { await cleanup.end(); }
  });

  it('keeps the oldest active job, pauses newer active jobs, and repeats as a no-op', async () => {
    const billing = new Client({ connectionString: billingUrl });
    await billing.connect();
    try {
      const first = await billing.query(
        'SELECT * FROM jale_billing_internal.billing_pause_over_limit_jobs($1, $2)',
        [employerId, 1],
      );
      expect(first.rows[0]).toEqual({
        paused_count: 2,
        employer_email: 'limit-employer@example.com',
        paused_titles: ['Second active', 'Newest active'],
      });
      const second = await billing.query(
        'SELECT * FROM jale_billing_internal.billing_pause_over_limit_jobs($1, $2)',
        [employerId, 1],
      );
      expect(second.rows[0].paused_count).toBe(0);
      expect(second.rows[0].paused_titles).toEqual([]);
    } finally { await billing.end(); }

    const verify = new Client({ connectionString: databaseUrl });
    await verify.connect();
    try {
      const rows = await verify.query<{ title: string; status: string }>(
        'SELECT title, status FROM jobs WHERE employer_id = $1 ORDER BY created_at',
        [employerId],
      );
      expect(Object.fromEntries(rows.rows.map((row) => [row.title, row.status]))).toEqual({
        'Oldest active': 'active',
        'Second active': 'paused',
        'Newest active': 'paused',
        'Already paused': 'paused',
        'Filled job': 'filled',
        'Closed job': 'closed',
      });
    } finally { await verify.end(); }
  });

  it('rejects a negative limit and direct jale_billing job updates with 42501', async () => {
    const billing = new Client({ connectionString: billingUrl });
    await billing.connect();
    try {
      await expect(billing.query(
        'SELECT * FROM jale_billing_internal.billing_pause_over_limit_jobs($1, -1)',
        [employerId],
      ))
        .rejects.toMatchObject({ code: '22023' });
      await expect(billing.query("UPDATE jobs SET status = 'closed' WHERE employer_id = $1", [employerId]))
        .rejects.toMatchObject({ code: '42501' });
      await expect(billing.query('SELECT id FROM users WHERE id = $1', [employerId]))
        .rejects.toMatchObject({ code: '42501' });
      await expect(billing.query('SELECT id FROM jobs WHERE employer_id = $1', [employerId]))
        .rejects.toMatchObject({ code: '42501' });
    } finally { await billing.end(); }
  });

  it('keeps the enforcer role, schema, function, and creator row narrowly scoped', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const role = await client.query(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
                rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = 'jale_billing_job_enforcer'`,
      );
      expect(role.rows[0]).toEqual({
        rolcanlogin: false, rolsuper: false, rolcreatedb: false,
        rolcreaterole: false, rolinherit: false, rolreplication: false,
        rolbypassrls: false,
      });
      const privileges = await client.query(
        `SELECT has_column_privilege('jale_billing_job_enforcer', 'users', 'email', 'SELECT') AS email_read,
                has_column_privilege('jale_billing_job_enforcer', 'users', 'phone', 'SELECT') AS phone_read,
                has_column_privilege('jale_billing_job_enforcer', 'jobs', 'status', 'UPDATE') AS status_update,
                has_column_privilege('jale_billing_job_enforcer', 'jobs', 'title', 'UPDATE') AS title_update,
                has_table_privilege('jale_billing', 'users', 'SELECT') AS billing_users_read,
                has_table_privilege('jale_billing', 'jobs', 'SELECT') AS billing_jobs_read,
                has_table_privilege('jale_billing', 'jobs', 'UPDATE') AS billing_jobs_update,
                has_schema_privilege('jale_billing', 'jale_billing_internal', 'USAGE') AS billing_usage,
                has_schema_privilege('jale_billing', 'jale_billing_internal', 'CREATE') AS billing_create,
                has_function_privilege(
                  'jale_billing',
                  'jale_billing_internal.billing_pause_over_limit_jobs(uuid, integer)',
                  'EXECUTE'
                ) AS billing_execute`,
      );
      expect(privileges.rows[0]).toEqual({
        email_read: true,
        phone_read: false,
        status_update: true,
        title_update: false,
        billing_users_read: false,
        billing_jobs_read: false,
        billing_jobs_update: false,
        billing_usage: true,
        billing_create: false,
        billing_execute: true,
      });
      const objects = await client.query(
        `SELECT schema_owner.rolname AS schema_owner,
                function_owner.rolname AS function_owner,
                function.prosecdef, function.proconfig,
                NOT EXISTS (
                  SELECT 1 FROM aclexplode(COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))) acl
                   WHERE acl.grantee = 0 AND acl.privilege_type = 'USAGE'
                ) AS no_public_usage,
                NOT EXISTS (
                  SELECT 1 FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
                   WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
                ) AS no_public_execute
           FROM pg_namespace namespace
           JOIN pg_roles schema_owner ON schema_owner.oid = namespace.nspowner
           JOIN pg_proc function ON function.pronamespace = namespace.oid
             AND function.proname = 'billing_pause_over_limit_jobs'
           JOIN pg_roles function_owner ON function_owner.oid = function.proowner
          WHERE namespace.nspname = 'jale_billing_internal'`,
      );
      expect(objects.rows[0]).toEqual({
        schema_owner: 'jale_billing_job_enforcer',
        function_owner: 'jale_billing_job_enforcer',
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        no_public_usage: true,
        no_public_execute: true,
      });
      const membership = await client.query(
        `SELECT member.rolname AS member, granted.rolname AS granted,
                membership.admin_option, membership.inherit_option,
                membership.set_option, grantor.rolsuper AS grantor_super
           FROM pg_auth_members membership
           JOIN pg_roles member ON member.oid = membership.member
           JOIN pg_roles granted ON granted.oid = membership.roleid
           JOIN pg_roles grantor ON grantor.oid = membership.grantor
          WHERE member.rolname = 'jale_billing_job_enforcer'
             OR granted.rolname = 'jale_billing_job_enforcer'`,
      );
      expect(membership.rows).toEqual([{
        member: 'jale_admin',
        granted: 'jale_billing_job_enforcer',
        admin_option: true,
        inherit_option: false,
        set_option: false,
        grantor_super: true,
      }]);
    } finally { await client.end(); }
  });
});
