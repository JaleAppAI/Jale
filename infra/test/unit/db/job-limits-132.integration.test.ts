/**
 * job-limits-132.integration.test.ts
 *
 * Migration 132 on a real PostgreSQL 16 bed:
 *
 *   - the plan catalog allows 15 active jobs on Free and 50 on Pro, and the
 *     template limits stay 2 and 20;
 *   - billing_plans keeps read policies only (132's write policy lasts for
 *     its own transaction);
 *   - the create handler (lambda/api/employer-jobs-create.ts), on the request
 *     login jale_api, creates a free employer's 15th active job and refuses
 *     the 16th with job_limit_reached, and creates a Pro employer's 50th
 *     active job and refuses the 51st.
 *
 * Fixtures and every read that decides an assertion go through the
 * superuser URL; the handler runs on jale_api (login-pool.ts).
 */
import type { Pool } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import { apiEvent, FIXTURE_TOS_VERSION, parseResponse, World } from './r-paths-world';
import { describeInProfiles, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: createJob } = require('../../../lambda/api/employer-jobs-create');

if (!databaseUrl) {
  test('CONCERN: the migration 132 DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const ALL_PROFILES = ['standard', 'request', 'owner-unrestricted'] as const;

const CREATE_BODY = { title: 'Fixture Limit Job', location: 'Fixture City, TX', job_type: 'full-time', trade_category: 'carpenter' };

async function create(sub: string) {
  return parseResponse(await createJob(apiEvent({ sub, httpMethod: 'POST', resource: '/employer/jobs', body: CREATE_BODY })));
}

describeInProfiles([...ALL_PROFILES], 'migration 132: the plan catalog', () => {
  let world: World;
  beforeAll(async () => {
    world = new World(databaseUrl!);
    await world.connect();
  });
  afterAll(async () => {
    await world.end();
  });

  it('allows 15 active jobs on Free and 50 on Pro, and keeps the template limits (2, 20) and the foreman seats from 127 (0, 3)', async () => {
    const { rows } = await world.su.query<{ code: string; entitlements: Record<string, unknown> }>(
      `SELECT code, entitlements FROM billing_plans WHERE code IN ('employer_free', 'employer_pro') ORDER BY code`,
    );
    expect(rows).toEqual([
      { code: 'employer_free', entitlements: { active_job_limit: 15, template_limit: 2, foreman_seat_limit: 0 } },
      { code: 'employer_pro', entitlements: { active_job_limit: 50, template_limit: 20, foreman_seat_limit: 3 } },
    ]);
  });

  it('leaves billing_plans with read policies only', async () => {
    const { rows } = await world.su.query<{ policyname: string; cmd: string }>(
      `SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'billing_plans' ORDER BY policyname`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.policyname)).not.toContain('billing_plans_job_limit_seed');
    expect(rows.filter((row) => row.cmd !== 'SELECT')).toEqual([]);
  });
});

describeInProfiles([...ALL_PROFILES], 'migration 132: job create on jale_api honours the plan limits', () => {
  let world: World;

  beforeAll(async () => {
    process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
    mockPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test');
  });
  afterAll(async () => {
    await mockPool?.end();
    mockPool = undefined;
  });
  beforeEach(async () => {
    world = new World(databaseUrl!);
    await world.connect();
  });
  afterEach(async () => {
    await world.cleanup();
    await world.end();
  });

  /** An employer whose jobs (the handler's included) and subscription leave with the world. */
  async function employer(): Promise<{ id: string; sub: string }> {
    const e = await world.employer({ companyName: 'Fixture Limits Co' });
    world.onCleanup(async () => {
      await world.su.query(`DELETE FROM subscriptions WHERE user_id = $1`, [e.id]);
      await world.su.query(`DELETE FROM job_visibility_events WHERE job_id IN (SELECT id FROM jobs WHERE employer_id = $1)`, [e.id]);
      await world.su.query(`DELETE FROM jobs WHERE employer_id = $1`, [e.id]);
    });
    return e;
  }

  async function activeJobs(employerId: string): Promise<number> {
    const { rows } = await world.su.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM jobs WHERE employer_id = $1 AND status = 'active'`,
      [employerId],
    );
    return rows[0].n;
  }

  it('creates a free employer\'s 15th active job and refuses the 16th', async () => {
    const e = await employer();
    for (let n = 1; n <= 15; n += 1) {
      const response = await create(e.sub);
      expect({ n, status: response.statusCode }).toEqual({ n, status: 201 });
    }
    expect(await activeJobs(e.id)).toBe(15);

    const refused = await create(e.sub);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toEqual({
      error: 'job_limit_reached', plan_code: 'employer_free', active_job_limit: 15, active_jobs: 15,
    });
    expect(await activeJobs(e.id)).toBe(15);
  }, 30_000);

  it('creates a Pro employer\'s 50th active job and refuses the 51st', async () => {
    const e = await employer();
    await world.su.query(`INSERT INTO subscriptions (user_id, plan_code, status) VALUES ($1, 'employer_pro', 'active')`, [e.id]);
    for (let n = 1; n <= 49; n += 1) {
      await world.job(e.id, { title: `Fixture Pro Job ${n}` });
    }

    const fiftieth = await create(e.sub);
    expect(fiftieth.statusCode).toBe(201);
    expect(await activeJobs(e.id)).toBe(50);

    const refused = await create(e.sub);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toEqual({
      error: 'job_limit_reached', plan_code: 'employer_pro', active_job_limit: 50, active_jobs: 50,
    });
    expect(await activeJobs(e.id)).toBe(50);
  }, 30_000);
});
