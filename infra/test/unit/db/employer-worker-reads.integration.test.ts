/**
 * employer-worker-reads.integration.test.ts
 *
 * PostgreSQL-backed gate for the two employer-facing applicant reads, run
 * against REAL PostgreSQL 16 with migrations 001-086 applied.
 *
 * These two handlers are covered by unit suites that `jest.mock` the whole of
 * `lambda/lib/db`, so NOTHING in the repository ever hands their SQL to a
 * planner or to the RLS policies that govern it. That gap is not theoretical:
 * it is what let `SELECT id, ...` ship in the documents query, where three of
 * the four joined relations expose `id` and PostgreSQL answers 42702
 * ("column reference is ambiguous") -- a 500 on every employer documents
 * request, with a green unit suite.
 *
 * So this executes the EXPORTED query text, not a copy. A copy would drift
 * from the handler the first time either was edited, and drift is precisely
 * the failure mode the unit tests already have.
 *
 * Everything -- seed and assertions alike -- happens in ONE transaction on
 * ONE connection, which is rolled back. `SET LOCAL ROLE jale_admin` is what
 * subjects the superuser session to RLS (a superuser that has SET ROLE'd to a
 * non-superuser role is no longer exempt), the same approach as
 * trust-extractions-086.integration.test.ts, so no role passwords are needed.
 * Seeding happens under `RESET ROLE`, which is the point of doing it in the
 * same transaction: rows that are not yet committed are invisible to a second
 * connection.
 *
 * Set JALE_TEST_DATABASE_URL to a superuser connection string for an
 * isolated, disposable database (see db/local/bootstrap-testbed.sh).
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EMPLOYER_WORKER_DOCS_SQL } from '../../../lambda/api/employer-worker-docs';
import { TRUST_EXTRACTION_SQL } from '../../../lambda/api/employer-worker-profile';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: employer applicant-read PostgreSQL gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[employer-worker-reads] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a ' +
        'disposable PostgreSQL 16 database with migrations 001-086 applied to run the ' +
        'real-PostgreSQL gate for the employer documents and trust-extraction reads.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

const maybeDescribe = databaseUrl ? describe : describe.skip;

maybeDescribe('employer applicant reads against real PostgreSQL', () => {
  const suffix = randomUUID().slice(0, 8);
  const subs = {
    employerA: `t22d-employer-a-${suffix}`,
    employerB: `t22d-employer-b-${suffix}`,
    worker: `t22d-worker-${suffix}`,
  };

  let client: Client;
  let employerA: string;
  let employerB: string;
  let worker: string;
  let jobId: string;
  let assessmentId: string;
  let scenario = 0;

  /**
   * Runs `fn` as jale_admin with the two RLS session variables the handlers
   * bind, then hands the session back to the superuser so the next scenario
   * can seed or re-bind. Both GUCs are transaction-local and this whole suite
   * is one transaction, so every scenario sets both explicitly rather than
   * inheriting whatever the previous one left behind.
   */
  async function asEmployer<T>(
    cognitoSub: string,
    internalId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    // A SAVEPOINT per scenario. Everything shares one transaction, so without
    // it the first statement that RAISES (an ambiguous column is a raise, not
    // an empty result) aborts the transaction and every later scenario fails
    // with "current transaction is aborted" -- burying the one real cause
    // under five imposters.
    const savepoint = `s_${(scenario += 1)}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [cognitoSub]);
    await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [internalId]);
    await client.query('SET LOCAL ROLE jale_admin');
    try {
      const result = await fn();
      await client.query('RESET ROLE');
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
      await client.query('RESET ROLE').catch(() => undefined);
      throw error;
    }
  }

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');

    const insertUser = async (sub: string, type: 'worker' | 'employer'): Promise<string> =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO users (cognito_sub, user_type) VALUES ($1, $2) RETURNING id`,
          [sub, type],
        )
      ).rows[0].id;

    employerA = await insertUser(subs.employerA, 'employer');
    employerB = await insertUser(subs.employerB, 'employer');
    worker = await insertUser(subs.worker, 'worker');

    jobId = (
      await client.query<{ id: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, status)
         VALUES ($1, 'R2-D docs gate', 'Austin', 'full-time', 'active') RETURNING id`,
        [employerA],
      )
    ).rows[0].id;

    await client.query(
      `INSERT INTO job_applications (job_id, worker_id, status) VALUES ($1, $2, 'pending')`,
      [jobId, worker],
    );

    // Two documents, one of them the retired `ssn` type. The SQL returns
    // both: dropping `ssn` is an application-layer decision in the handler
    // (it is filtered before a presigned URL is ever minted), NOT something
    // RLS or this query knows about. Asserting 2 here is what keeps those two
    // layers honestly separated.
    await client.query(
      `INSERT INTO worker_documents
         (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, $2, 'resume', 'documents/r2d/resume.pdf', 'resume.pdf', 1024, 'application/pdf'),
              ($1, $2, 'ssn', 'documents/r2d/ssn.pdf', 'social-security-card.pdf', 512, 'application/pdf')`,
      [worker, jobId],
    );

    assessmentId = (
      await client.query<{ id: string }>(
        `INSERT INTO worker_trust_assessments (user_id, profession_key, answers, status)
         VALUES ($1, 'electrician', '[]'::jsonb, 'scored') RETURNING id`,
        [worker],
      )
    ).rows[0].id;

    await client.query(
      `INSERT INTO worker_trust_extractions
         (assessment_id, user_id, status, extracted, summary_en, summary_es,
          model_id, extractor_version, error)
       VALUES ($1, $2, 'completed', '{"skills":[]}'::jsonb, 'EN summary', 'ES summary',
               'us.amazon.nova-lite-v1:0', 'r2d-gate-1', 'a leaked failure string')`,
      [assessmentId, worker],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  });

  describe('employer-worker-docs SQL', () => {
    it('runs at all -- an unqualified column would be 42702, not an empty result', async () => {
      // The regression this file exists for. `id` is exposed by
      // worker_documents, job_applications, jobs AND users, so the failure is
      // a raise at parse time: every employer documents request 500s.
      const rows = await asEmployer(subs.employerA, employerA, async () =>
        (await client.query(EMPLOYER_WORKER_DOCS_SQL, [worker, jobId, subs.employerA])).rows,
      );
      expect(Array.isArray(rows)).toBe(true);
    });

    it('returns both of the applicant documents to the employer who owns the job', async () => {
      const rows = await asEmployer(subs.employerA, employerA, async () =>
        (await client.query<{ id: string; doc_type: string; file_name: string }>(
          EMPLOYER_WORKER_DOCS_SQL,
          [worker, jobId, subs.employerA],
        )).rows,
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.doc_type).sort()).toEqual(['resume', 'ssn']);
      // `wd.id`, so the id is the DOCUMENT's -- not the application's, the
      // job's or the employer's, each of which the joins also expose.
      const resume = rows.find((row) => row.doc_type === 'resume')!;
      const documentIds = await client.query<{ id: string }>(
        `SELECT id FROM worker_documents WHERE worker_id = $1 AND doc_type = 'resume'`,
        [worker],
      );
      expect(resume.id).toBe(documentIds.rows[0].id);
      expect(resume.id).not.toBe(jobId);
    });

    it('returns nothing to an employer with no application from this worker', async () => {
      const rows = await asEmployer(subs.employerB, employerB, async () =>
        (await client.query(EMPLOYER_WORKER_DOCS_SQL, [worker, jobId, subs.employerB])).rows,
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('employer-worker-profile trust-extraction SQL', () => {
    it('returns the extraction to the employer the worker applied to', async () => {
      const rows = await asEmployer(subs.employerA, employerA, async () =>
        (await client.query<Record<string, unknown>>(TRUST_EXTRACTION_SQL, [assessmentId, worker])).rows,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('completed');
      expect(rows[0].summary_en).toBe('EN summary');
      // The seed deliberately fills `error` and `model_id`. Neither is in the
      // select list, so neither can reach the response even by accident.
      expect(rows[0]).not.toHaveProperty('error');
      expect(rows[0]).not.toHaveProperty('model_id');
    });

    it('is refused the two columns 086 leaves out of the reader grant', async () => {
      // jale_admin OWNS this table, so the column grant is declarative for it
      // (086 says so in as many words) -- but the policy set is not, and this
      // pins the shape the grant describes for the day the API lane moves to
      // a non-owner role. Selecting them must at minimum not be something the
      // shipped query does.
      expect(TRUST_EXTRACTION_SQL).not.toContain('error');
      expect(TRUST_EXTRACTION_SQL).not.toContain('model_id');
    });

    it('returns nothing to an unrelated employer', async () => {
      const rows = await asEmployer(subs.employerB, employerB, async () =>
        (await client.query(TRUST_EXTRACTION_SQL, [assessmentId, worker])).rows,
      );
      expect(rows).toHaveLength(0);
    });

    it('returns nothing when the internal-user lane is not bound', async () => {
      // wte_employer_applicant_read is keyed ENTIRELY on
      // app.current_internal_user_id. A handler that bound only the Cognito-sub
      // lane would read empty and render "no extraction" for every applicant --
      // a silent wrong answer, not an error.
      const rows = await asEmployer(subs.employerA, '', async () =>
        (await client.query(TRUST_EXTRACTION_SQL, [assessmentId, worker])).rows,
      );
      expect(rows).toHaveLength(0);
    });
  });
});
