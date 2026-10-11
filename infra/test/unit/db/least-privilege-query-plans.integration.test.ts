/**
 * least-privilege-query-plans.integration.test.ts -- the relationship
 * predicates and the job feed stay index-driven at volume.
 *
 * Once every request runs on an enforced login, the copied policies call
 * jale_internal.employer_has_applicant_relationship and
 * worker_has_application for each row they consider, and the worker job feed
 * filters out applied jobs with a NOT EXISTS on job_applications. With the
 * table at production-like volume, a sequential scan in any of them would
 * multiply into every request. This suite seeds 200 employers, 400 jobs and
 * 10,000 applications, refreshes the planner statistics, and runs each query
 * as the role that runs it when deployed, under EXPLAIN (ANALYZE, FORMAT JSON):
 *   - the two relationship predicates' own bodies, read from the catalog, as
 *     their owner;
 *   - the feed's applied-job filter, as the request login with a worker's
 *     context.
 * No plan may contain a Seq Scan on job_applications. Timings are printed,
 * never gated on.
 *
 * Connection: JALE_TEST_DATABASE_URL (the bed's superuser URL) for the
 * fixtures and the definer-owner plans; the request login signs in through
 * helpers/login-pool.
 */
import { Client } from 'pg';
import { withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: least-privilege query plans PostgreSQL gate was not run', () => {
    console.warn('[least-privilege-query-plans] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const EMPLOYERS = 200;
const JOBS_PER_EMPLOYER = 2;
const WORKERS = 2000;
const APPLICATIONS_PER_WORKER = 5;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

/** Every node of a plan tree, subplans and init plans included. */
function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

function seqScansOnApplications(explain: Array<{ Plan: PlanNode }>): string[] {
  return nodes(explain[0].Plan)
    .filter((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'job_applications')
    .map((node) => node['Node Type']);
}

type ExplainRow = { 'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }> };

maybeDescribe('least-privilege query plans at volume', () => {
  let su: Client;
  const prefix = `lp-qp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let sampleEmployer = '';
  let sampleWorker = '';
  let sampleWorkerSub = '';
  let sampleJob = '';

  /** A predicate's own body, from the catalog, with its parameters bound to literals. */
  async function predicateBody(signature: string, bindings: Record<string, string>): Promise<string> {
    const { rows } = await su.query<{ prosrc: string }>(
      'SELECT prosrc FROM pg_catalog.pg_proc WHERE oid = pg_catalog.to_regprocedure($1)', [signature]);
    let body = rows[0].prosrc.trim().replace(/;\s*$/, '');
    for (const [name, literal] of Object.entries(bindings)) {
      body = body.replace(new RegExp(`\\b${name}\\b`, 'g'), literal);
    }
    return body;
  }

  /** EXPLAIN ANALYZE as `role` (a NOLOGIN owner) inside a rolled-back transaction of the fixture connection. */
  async function explainAsOwner(role: string, sql: string) {
    await su.query('BEGIN');
    try {
      await su.query(`SET LOCAL ROLE ${role}`);
      const { rows } = await su.query<ExplainRow>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
      return rows[0]['QUERY PLAN'];
    } finally {
      await su.query('ROLLBACK');
    }
  }

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    await su.query(
      `INSERT INTO public.users (cognito_sub, user_type)
       SELECT $1 || '-employer-' || g, 'employer' FROM generate_series(1, $2::int) AS g`,
      [prefix, EMPLOYERS],
    );
    await su.query(
      `INSERT INTO public.users (cognito_sub, user_type)
       SELECT $1 || '-worker-' || g, 'worker' FROM generate_series(1, $2::int) AS g`,
      [prefix, WORKERS],
    );
    await su.query(
      `INSERT INTO public.jobs (employer_id, title, location, job_type, status, number_of_workers_needed)
       SELECT u.id, 'Least-privilege plan fixture ' || g, 'Austin', 'full-time', 'active', 50
         FROM public.users u, generate_series(1, $2::int) AS g
        WHERE u.cognito_sub LIKE $1 || '-employer-%'`,
      [prefix, JOBS_PER_EMPLOYER],
    );
    // Each worker applies to APPLICATIONS_PER_WORKER distinct jobs, spread over every employer.
    await su.query(
      `WITH jobs AS (
         SELECT j.id, row_number() OVER (ORDER BY j.id) - 1 AS n, count(*) OVER () AS total
           FROM public.jobs j JOIN public.users u ON u.id = j.employer_id
          WHERE u.cognito_sub LIKE $1 || '-employer-%'
       ), workers AS (
         SELECT u.id, row_number() OVER (ORDER BY u.id) - 1 AS n
           FROM public.users u WHERE u.cognito_sub LIKE $1 || '-worker-%'
       )
       INSERT INTO public.job_applications (job_id, worker_id)
       SELECT jobs.id, workers.id
         FROM workers, generate_series(0, $2::int - 1) AS k, jobs
        WHERE jobs.n = (workers.n * 7 + k * 83) % jobs.total`,
      [prefix, APPLICATIONS_PER_WORKER],
    );
    await su.query('ANALYZE public.users');
    await su.query('ANALYZE public.jobs');
    await su.query('ANALYZE public.job_applications');

    const sample = (await su.query<{ employer: string; worker: string; sub: string; job: string }>(
      `SELECT j.employer_id AS employer, ja.worker_id AS worker, w.cognito_sub AS sub, ja.job_id AS job
         FROM public.job_applications ja
         JOIN public.jobs j ON j.id = ja.job_id
         JOIN public.users w ON w.id = ja.worker_id
        WHERE w.cognito_sub LIKE $1 || '-worker-%'
        ORDER BY w.cognito_sub LIMIT 1`,
      [prefix],
    )).rows[0];
    sampleEmployer = sample.employer;
    sampleWorker = sample.worker;
    sampleWorkerSub = sample.sub;
    sampleJob = sample.job;
  }, 300_000);

  afterAll(async () => {
    if (!su) return;
    await su.query(
      `DELETE FROM public.jobs WHERE employer_id IN (SELECT id FROM public.users WHERE cognito_sub LIKE $1 || '-employer-%')`, [prefix]);
    await su.query(`DELETE FROM public.users WHERE cognito_sub LIKE $1 || '-%'`, [prefix]);
    await su.end();
  }, 300_000);

  it('seeds at least 10,000 applications across 200 employers', async () => {
    const { rows } = await su.query<{ applications: number; employers: number }>(
      `SELECT count(*)::int AS applications, count(DISTINCT j.employer_id)::int AS employers
         FROM public.job_applications ja JOIN public.jobs j ON j.id = ja.job_id
         JOIN public.users u ON u.id = j.employer_id
        WHERE u.cognito_sub LIKE $1 || '-employer-%'`,
      [prefix],
    );
    expect(rows[0].applications).toBeGreaterThanOrEqual(10_000);
    expect(rows[0].employers).toBe(EMPLOYERS);
  });

  it('employer_has_applicant_relationship: no Seq Scan on job_applications', async () => {
    const body = await predicateBody('jale_internal.employer_has_applicant_relationship(text, uuid)', {
      p_employer_internal_id: `'${sampleEmployer}'::text`,
      p_worker_id: `'${sampleWorker}'::uuid`,
    });
    const plan = await explainAsOwner('jale_rls_relationship_reader', body);
    console.log(`[query-plans] employer_has_applicant_relationship: ${plan[0]['Execution Time']} ms`);
    expect(seqScansOnApplications(plan)).toEqual([]);
  });

  it('worker_has_application: no Seq Scan on job_applications', async () => {
    const body = await predicateBody('jale_internal.worker_has_application(text, uuid)', {
      p_worker_internal_id: `'${sampleWorker}'::text`,
      p_job_id: `'${sampleJob}'::uuid`,
    });
    const plan = await explainAsOwner('jale_rls_relationship_reader', body);
    console.log(`[query-plans] worker_has_application: ${plan[0]['Execution Time']} ms`);
    expect(seqScansOnApplications(plan)).toEqual([]);
  });

  it('the job feed\'s applied-job filter, on the request login as a worker: no Seq Scan on job_applications', async () => {
    // The feed's eligibility and not-applied predicates (lambda/lib/job-matching.ts:
    // JOB_ELIGIBLE_STATUS and jobNotAppliedPredicate), in its own order and limit.
    const feed = `SELECT j.id
                    FROM jobs j
                   WHERE j.status = 'active'
                     AND NOT EXISTS (
                       SELECT 1
                         FROM job_applications ja
                        WHERE ja.job_id = j.id
                          AND ja.worker_id = $1
                     )
                   ORDER BY j.created_at DESC, j.id DESC
                   LIMIT 200`;
    const plan = await withLoginClient('jale_api', async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [sampleWorkerSub]);
        await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [sampleWorker]);
        const { rows } = await client.query<ExplainRow>(`EXPLAIN (ANALYZE, FORMAT JSON) ${feed}`, [sampleWorker]);
        return rows[0]['QUERY PLAN'];
      } finally {
        await client.query('ROLLBACK');
      }
    });
    console.log(`[query-plans] job feed applied-job filter: ${plan[0]['Execution Time']} ms`);
    expect(seqScansOnApplications(plan)).toEqual([]);
  });
});
