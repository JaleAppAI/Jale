import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: employer trust-assessment read RLS PostgreSQL gate was not run', () => {
    console.warn('[rls-trust-assessment-employer-read] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
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

maybeDescribe('migration 084 employer read access to worker_trust_assessments', () => {
  let adminUrl: string;
  let employer1: { id: string; sub: string };
  let employer2: { id: string; sub: string };
  let worker: { id: string; sub: string };
  let jobId: string;
  let applicationId: string;
  let assessmentId: string;

  beforeAll(async () => {
    const setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    try {
      if (new URL(databaseUrl!).username !== 'jale_admin') {
        await setup.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
      }
      const users = await setup.query<{ id: string; cognito_sub: string }>(
        `INSERT INTO users (cognito_sub, user_type)
         VALUES ('t84-employer-1', 'employer'), ('t84-employer-2', 'employer'), ('t84-worker-1', 'worker')
         ON CONFLICT (cognito_sub) DO UPDATE SET updated_at = now()
         RETURNING id, cognito_sub`,
      );
      const bySub = new Map(users.rows.map((row) => [row.cognito_sub, row.id]));
      employer1 = { id: bySub.get('t84-employer-1')!, sub: 't84-employer-1' };
      employer2 = { id: bySub.get('t84-employer-2')!, sub: 't84-employer-2' };
      worker = { id: bySub.get('t84-worker-1')!, sub: 't84-worker-1' };

      const job = await setup.query<{ id: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, status)
         VALUES ($1, 'T84 active job', 'Austin', 'full-time', 'active') RETURNING id`,
        [employer1.id],
      );
      jobId = job.rows[0].id;
      const application = await setup.query<{ id: string }>(
        `INSERT INTO job_applications (job_id, worker_id, status)
         VALUES ($1, $2, 'pending') RETURNING id`,
        [jobId, worker.id],
      );
      applicationId = application.rows[0].id;

      // ON CONFLICT targets 012's partial unique index (user_id, profession_key)
      // WHERE status IN ('pending','scoring','scored'), so a rerun after a
      // crashed prior pass (before afterAll's DELETE ran) updates in place
      // instead of tripping idx_worker_trust_assessments_active.
      const assessment = await setup.query<{ id: string }>(
        `INSERT INTO worker_trust_assessments
           (user_id, profession_key, answers, status, competency_score, score_components)
         VALUES ($1, 'electrician',
                 '[{"question_index":0,"q_en":"q","answer_text":"a","answer_source":"text","answered_at":"2026-01-01T00:00:00Z"}]'::jsonb,
                 'scored', 72,
                 '{"specific_knowledge":20,"practical_experience":22,"safety_awareness":15,"communication_clarity":15}'::jsonb)
         ON CONFLICT (user_id, profession_key) WHERE status IN ('pending', 'scoring', 'scored')
         DO UPDATE SET status = EXCLUDED.status,
                        competency_score = EXCLUDED.competency_score,
                        score_components = EXCLUDED.score_components,
                        answers = EXCLUDED.answers
         RETURNING id`,
        [worker.id],
      );
      assessmentId = assessment.rows[0].id;
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
      await cleanup.query('DELETE FROM worker_trust_assessments WHERE id = $1', [assessmentId]);
      await cleanup.query('DELETE FROM job_applications WHERE id = $1', [applicationId]);
      await cleanup.query('DELETE FROM jobs WHERE id = $1', [jobId]);
      await cleanup.query("DELETE FROM users WHERE cognito_sub LIKE 't84-%'");
    } finally { await cleanup.end(); }
  });

  it('lets the related employer read the applicant trust assessment', async () => {
    const related = await asApp(adminUrl, employer1.sub, employer1.id, (client) =>
      client.query('SELECT * FROM worker_trust_assessments WHERE user_id = $1', [worker.id]));
    expect(related.rows).toHaveLength(1);
    expect(related.rows[0].id).toBe(assessmentId);
  });

  it('returns no rows for an employer with no applicant relationship', async () => {
    const unrelated = await asApp(adminUrl, employer2.sub, employer2.id, (client) =>
      client.query('SELECT * FROM worker_trust_assessments WHERE user_id = $1', [worker.id]));
    expect(unrelated.rows).toEqual([]);
  });

  it("preserves the worker's own-row read path (wta_worker_own_rows, unchanged by 084)", async () => {
    const own = await asApp(adminUrl, worker.sub, worker.id, (client) =>
      client.query('SELECT id FROM worker_trust_assessments WHERE id = $1', [assessmentId]));
    expect(own.rows).toEqual([{ id: assessmentId }]);
  });

  it('defines wta_employer_applicant_read as a SELECT-only policy on jale_admin using the recursion-safe predicate', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const policy = await client.query<{ roles: string[]; cmd: string; qual: string }>(
        `SELECT roles::text[] AS roles, cmd, qual
           FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'worker_trust_assessments'
            AND policyname = 'wta_employer_applicant_read'`,
      );
      expect(policy.rows).toHaveLength(1);
      expect(policy.rows[0].roles).toEqual(['jale_admin']);
      expect(policy.rows[0].cmd).toBe('SELECT');
      expect(policy.rows[0].qual).toContain('employer_has_applicant_relationship');
    } finally { await client.end(); }
  });

  // jale_whatsapp's grants on worker_trust_assessments must reflect migration
  // 049's state (which added rubric_version/scoring_model_id read+write and
  // answers UPDATE on top of 012's base columns), not 012's alone -- 084 must
  // not have widened or narrowed jale_whatsapp's column-scoped access at all.
  it("keeps jale_whatsapp's worker_trust_assessments grants column-scoped per migration 049, untouched by 084", async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const privileges = await client.query<{
        status_read: boolean;
        rubric_read: boolean;
        rubric_insert: boolean;
        answers_update: boolean;
        rubric_update: boolean;
        model_update: boolean;
        broad_select: boolean;
        broad_insert: boolean;
        broad_update: boolean;
      }>(`SELECT
        has_column_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'status', 'SELECT') AS status_read,
        has_column_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'rubric_version', 'SELECT') AS rubric_read,
        has_column_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'rubric_version', 'INSERT') AS rubric_insert,
        has_column_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'answers', 'UPDATE') AS answers_update,
        has_column_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'rubric_version', 'UPDATE') AS rubric_update,
        has_column_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'scoring_model_id', 'UPDATE') AS model_update,
        has_table_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'SELECT') AS broad_select,
        has_table_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'INSERT') AS broad_insert,
        has_table_privilege('jale_whatsapp', 'public.worker_trust_assessments', 'UPDATE') AS broad_update`);

      expect(privileges.rows[0]).toEqual({
        status_read: true,
        rubric_read: true,
        rubric_insert: true,
        answers_update: true,
        rubric_update: true,
        model_update: true,
        broad_select: false,
        broad_insert: false,
        broad_update: false,
      });

      // jale_whatsapp must not appear on the new employer-read policy.
      const policyRoles = await client.query<{ roles: string[] }>(
        `SELECT roles::text[] AS roles
           FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'worker_trust_assessments'
            AND policyname = 'wta_employer_applicant_read'`,
      );
      expect(policyRoles.rows[0].roles).not.toContain('jale_whatsapp');
    } finally { await client.end(); }
  });
});
