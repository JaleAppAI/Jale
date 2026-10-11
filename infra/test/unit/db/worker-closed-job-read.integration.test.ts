import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: worker closed-job read PostgreSQL gate was not run', () => {
    console.warn('[worker-closed-job-read] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
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

maybeDescribe('worker applied-job visibility migration 070', () => {
  let adminUrl: string;
  let employer: { id: string; sub: string };
  let employerWithApp: { id: string; sub: string };
  let applicant: { id: string; sub: string };
  let bystander: { id: string; sub: string };
  let closedJobId: string;
  let closedNoAppJobId: string;
  let pausedJobId: string;

  beforeAll(async () => {
    const setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    try {
      if (new URL(databaseUrl!).username !== 'jale_admin') {
        await setup.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
      }
      // Pre-clean residue from a prior crashed run: users are reused via
      // ON CONFLICT, so stale R70 jobs/applications would break the
      // exact-equality assertions below.
      await setup.query(
        `DELETE FROM job_applications WHERE job_id IN (SELECT id FROM jobs WHERE title LIKE 'R70 %')`,
      );
      await setup.query(`DELETE FROM jobs WHERE title LIKE 'R70 %'`);
      const users = await setup.query<{ id: string; cognito_sub: string }>(
        `INSERT INTO users (cognito_sub, user_type)
         VALUES ('r70-employer-1', 'employer'), ('r70-employer-2', 'employer'),
                ('r70-worker-1', 'worker'), ('r70-worker-2', 'worker')
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id, cognito_sub`,
      );
      const bySub = new Map(users.rows.map((row) => [row.cognito_sub, row.id]));
      employer = { id: bySub.get('r70-employer-1')!, sub: 'r70-employer-1' };
      employerWithApp = { id: bySub.get('r70-employer-2')!, sub: 'r70-employer-2' };
      applicant = { id: bySub.get('r70-worker-1')!, sub: 'r70-worker-1' };
      bystander = { id: bySub.get('r70-worker-2')!, sub: 'r70-worker-2' };

      const jobs = await setup.query<{ id: string; title: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, status)
         VALUES ($1, 'R70 closed applied', 'Austin', 'full-time', 'closed'),
                ($1, 'R70 closed unapplied', 'Austin', 'full-time', 'closed'),
                ($1, 'R70 paused applied', 'Austin', 'full-time', 'paused')
         RETURNING id, title`,
        [employer.id],
      );
      const byTitle = new Map(jobs.rows.map((row) => [row.title, row.id]));
      closedJobId = byTitle.get('R70 closed applied')!;
      closedNoAppJobId = byTitle.get('R70 closed unapplied')!;
      pausedJobId = byTitle.get('R70 paused applied')!;

      // applicant applied to the closed and paused jobs; the second EMPLOYER
      // account also holds an application row on the closed job — the policy's
      // user_type guard must deny it cross-employer job reads regardless.
      await setup.query(
        `INSERT INTO job_applications (job_id, worker_id, status)
         VALUES ($1, $2, 'pending'), ($3, $2, 'pending'), ($1, $4, 'pending')`,
        [closedJobId, applicant.id, pausedJobId, employerWithApp.id],
      );
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
      await cleanup.query(
        `DELETE FROM job_applications WHERE job_id IN (SELECT id FROM jobs WHERE title LIKE 'R70 %')`,
      );
      await cleanup.query(`DELETE FROM jobs WHERE title LIKE 'R70 %'`);
      await cleanup.query(`DELETE FROM users WHERE cognito_sub LIKE 'r70-%'`);
    } finally { await cleanup.end(); }
  });

  it('lets an applicant read their closed job, and nobody else', async () => {
    const applied = await asApp(adminUrl, applicant.sub, applicant.id, (client) =>
      client.query('SELECT id FROM jobs WHERE id = $1', [closedJobId]));
    expect(applied.rows).toEqual([{ id: closedJobId }]);

    const unapplied = await asApp(adminUrl, applicant.sub, applicant.id, (client) =>
      client.query('SELECT id FROM jobs WHERE id = $1', [closedNoAppJobId]));
    expect(unapplied.rows).toEqual([]);

    const otherWorker = await asApp(adminUrl, bystander.sub, bystander.id, (client) =>
      client.query('SELECT id FROM jobs WHERE id = $1', [closedJobId]));
    expect(otherWorker.rows).toEqual([]);
  });

  it('revives the detail query shape: status=active OR worker-applied', async () => {
    // This is the exact WHERE arm in worker-jobs-detail.ts that is dead code
    // under pre-070 RLS; migration 070 must make it live for applicants only.
    const detailShape = `SELECT j.id FROM jobs j
        WHERE j.id = $1
          AND (j.status = 'active' OR EXISTS (
            SELECT 1 FROM job_applications ja
             WHERE ja.job_id = j.id AND ja.worker_id = $2))`;
    const applicantRows = await asApp(adminUrl, applicant.sub, applicant.id, (client) =>
      client.query(detailShape, [closedJobId, applicant.id]));
    expect(applicantRows.rows).toEqual([{ id: closedJobId }]);

    const bystanderRows = await asApp(adminUrl, bystander.sub, bystander.id, (client) =>
      client.query(detailShape, [closedJobId, bystander.id]));
    expect(bystanderRows.rows).toEqual([]);
  });

  it('denies an employer account the applied-job policy (user_type guard)', async () => {
    const crossEmployer = await asApp(adminUrl, employerWithApp.sub, employerWithApp.id, (client) =>
      client.query('SELECT id FROM jobs WHERE id = $1', [closedJobId]));
    expect(crossEmployer.rows).toEqual([]);
  });

  it('keeps the owning employer view and fails closed without identity context', async () => {
    const own = await asApp(adminUrl, employer.sub, employer.id, (client) =>
      client.query('SELECT id FROM jobs WHERE id = $1', [closedJobId]));
    expect(own.rows).toEqual([{ id: closedJobId }]);

    const noContext = new Client({ connectionString: adminUrl });
    await noContext.connect();
    try {
      const result = await noContext.query('SELECT id FROM jobs WHERE id = $1', [closedJobId]);
      expect(result.rows).toEqual([]);
    } finally { await noContext.end(); }
  });

  it('serves the applications-list shape: paused coalesced, company via employer_display_name', async () => {
    const rows = await asApp(adminUrl, applicant.sub, applicant.id, (client) =>
      client.query(
        `SELECT j.title AS job_title,
                employer_display_name(j.employer_id) AS company_name,
                CASE WHEN j.status = 'paused' THEN 'closed' ELSE j.status END AS job_status
           FROM job_applications a
           JOIN jobs j ON j.id = a.job_id
          WHERE a.worker_id = $1
          ORDER BY j.title`,
        [applicant.id],
      ));
    // No employer_profiles row is seeded, so the 031 fallback name proves the
    // function is callable under a worker context and falls back correctly.
    // (The local gate applies migrations as superuser, so this does NOT
    // exercise 031's gated-policy ownership path — prod parity only.)
    expect(rows.rows).toEqual([
      { job_title: 'R70 closed applied', company_name: 'Empleador', job_status: 'closed' },
      { job_title: 'R70 paused applied', company_name: 'Empleador', job_status: 'closed' },
    ]);
  });
});
