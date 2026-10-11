/**
 * r-paths-referred-jobs.integration.test.ts
 *
 * Migration 103's referred-jobs list on the request login, jale_api, in the
 * shape of worker-referred-jobs-103's role cases:
 *
 *   - POST /worker/referrals/claim with a jobId (worker-referral-claim.ts)
 *     records the job the worker came for (source job_page), and only while
 *     the job is active;
 *   - GET /worker/jobs (worker-jobs-list.ts) pins the worker's open,
 *     unapplied referred job first, with the referred_job reason, and never
 *     a paused or an applied one;
 *   - with the caller context as the request paths set it, only the caller's
 *     rows are returned (record, list, onboarding summary), and a write for
 *     another worker fails; with no setting, or the empty one a warm pooled
 *     connection carries, nothing is returned or written.
 *
 * Fixtures and every verification read go through the superuser.
 */
import type { Pool, PoolClient } from 'pg';
import { createCheckedPool, setRlsContext } from '../../../lambda/lib/db';
import {
  getReferredJobForOnboarding,
  listOpenReferredJobIds,
  recordReferredJob,
} from '../../../lambda/lib/referred-jobs';
import { apiEvent, FIXTURE_TOS_VERSION, parseResponse, World } from './r-paths-world';
import { describeInProfiles, loginClient, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: claimHandler } = require('../../../lambda/api/worker-referral-claim');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: feedHandler } = require('../../../lambda/api/worker-jobs-list');

if (!databaseUrl) {
  test('CONCERN: the referred-jobs DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

interface Scene {
  world: World;
  workerA: { id: string; sub: string };
  workerB: { id: string; sub: string };
  jobOpen: string;
  jobOpenToo: string;
  jobPaused: string;
  jobApplied: string;
  jobOfB: string;
}

async function scene(): Promise<Scene> {
  const world = new World(databaseUrl!);
  await world.connect();
  const employer = await world.employer({ companyName: 'Fixture Referral Co' });
  const jobOpen = (await world.job(employer.id, { title: 'Fixture Referred Job' })).id;
  const jobOpenToo = (await world.job(employer.id, { title: 'Fixture Second Referred Job' })).id;
  const jobPaused = (await world.job(employer.id, { title: 'Fixture Paused Job', status: 'paused' })).id;
  const jobApplied = (await world.job(employer.id, { title: 'Fixture Applied Job' })).id;
  const jobOfB = (await world.job(employer.id, { title: 'Fixture Job Of B' })).id;
  const workerA = await world.worker({ fullName: 'Fixture Worker A' });
  const workerB = await world.worker({ fullName: 'Fixture Worker B' });
  await world.su.query(
    `INSERT INTO worker_referred_jobs (worker_id, job_id, source) VALUES ($1, $2, 'job_page')`,
    [workerB.id, jobOfB],
  );
  return { world, workerA, workerB, jobOpen, jobOpenToo, jobPaused, jobApplied, jobOfB };
}

async function referredOf(s: Scene, workerId: string): Promise<Array<{ job_id: string; source: string }>> {
  const { rows } = await s.world.su.query(
    `SELECT job_id, source FROM worker_referred_jobs WHERE worker_id = $1 ORDER BY last_seen_at DESC, job_id`,
    [workerId],
  );
  return rows;
}

async function claim(sub: string, body: Record<string, unknown>) {
  return parseResponse(await claimHandler(apiEvent({
    sub,
    httpMethod: 'POST',
    resource: '/worker/referrals/claim',
    body,
  })));
}

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'referred jobs on jale_api', () => {
  let s: Scene;
  beforeAll(async () => {
    process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
    mockPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test');
  });
  afterAll(async () => {
    await mockPool?.end();
    mockPool = undefined;
  });
  beforeEach(async () => {
    s = await scene();
  });
  afterEach(async () => {
    await s.world.cleanup();
    await s.world.end();
  });

  it('the claim records the job a worker came for, only while it is active', async () => {
    const recorded = await claim(s.workerA.sub, { jobId: s.jobOpen });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.body.recorded).toEqual([s.jobOpen]);
    expect(await referredOf(s, s.workerA.id)).toEqual([{ job_id: s.jobOpen, source: 'job_page' }]);

    const paused = await claim(s.workerA.sub, { jobId: s.jobPaused });
    expect(paused.statusCode).toBe(200);
    expect(paused.body.recorded).toEqual([]);
    expect(await referredOf(s, s.workerA.id)).toEqual([{ job_id: s.jobOpen, source: 'job_page' }]);
  });

  it("the feed pins the worker's open, unapplied referred jobs first, and never a paused or applied one", async () => {
    await s.world.su.query(
      `INSERT INTO worker_referred_jobs (worker_id, job_id, source, first_seen_at, last_seen_at)
       VALUES ($1, $2, 'share_link', now() - interval '2 days', now() - interval '2 days'),
              ($1, $3, 'job_page',   now() - interval '1 day',  now() - interval '1 day'),
              ($1, $4, 'job_page',   now(), now()),
              ($1, $5, 'typed_code', now(), now())`,
      [s.workerA.id, s.jobOpen, s.jobOpenToo, s.jobPaused, s.jobApplied],
    );
    await s.world.application(s.jobApplied, s.workerA.id);
    // Another worker's application never hides A's job.
    await s.world.application(s.jobOpen, s.workerB.id);

    const response = parseResponse(await feedHandler(apiEvent({ sub: s.workerA.sub, resource: '/worker/jobs' })));
    expect(response.statusCode).toBe(200);
    const jobs: Array<{ id: string; match_reasons: string[] }> = response.body.jobs;
    expect(jobs.slice(0, 2).map((job) => job.id)).toEqual([s.jobOpenToo, s.jobOpen]);
    expect(jobs.slice(0, 2).every((job) => job.match_reasons[0] === 'referred_job')).toBe(true);
    expect(jobs.some((job) => job.id === s.jobPaused || job.id === s.jobApplied)).toBe(false);
  });

  it('with the caller context as the request paths set it, only the caller\'s rows are returned, and a write for another worker fails', async () => {
    const api = loginClient('jale_api');
    await api.connect();
    const c = api as unknown as PoolClient;
    try {
      await api.query('BEGIN');
      await setRlsContext(c, s.workerA.sub);

      expect(await recordReferredJob(c, { workerId: s.workerA.id, jobId: s.jobOpen, source: 'job_page' })).toBe(true);
      expect(await listOpenReferredJobIds(c, s.workerA.id)).toEqual([s.jobOpen]);
      expect(await getReferredJobForOnboarding(c, s.workerA.id)).toMatchObject({ id: s.jobOpen, open: true });

      expect(await listOpenReferredJobIds(c, s.workerB.id)).toEqual([]);
      expect(await getReferredJobForOnboarding(c, s.workerB.id)).toBeNull();

      await api.query('SAVEPOINT foreign_insert');
      await expect(recordReferredJob(c, { workerId: s.workerB.id, jobId: s.jobOpenToo, source: 'job_page' }))
        .rejects.toThrow(/row-level security/);
      await api.query('ROLLBACK TO SAVEPOINT foreign_insert');
      await api.query('SAVEPOINT foreign_refresh');
      await expect(recordReferredJob(c, { workerId: s.workerB.id, jobId: s.jobOfB, source: 'job_page' }))
        .rejects.toThrow(/row-level security/);
      await api.query('ROLLBACK TO SAVEPOINT foreign_refresh');
      await api.query('COMMIT');
    } finally {
      await api.query('ROLLBACK').catch(() => undefined);
      await api.end();
    }

    expect(await referredOf(s, s.workerA.id)).toEqual([{ job_id: s.jobOpen, source: 'job_page' }]);
    expect(await referredOf(s, s.workerB.id)).toEqual([{ job_id: s.jobOfB, source: 'job_page' }]);
  });

  it('without a setting, or with the empty one a warm pooled connection carries, nothing is seen or written', async () => {
    const api = loginClient('jale_api');
    await api.connect();
    const c = api as unknown as PoolClient;
    try {
      await api.query('BEGIN');
      for (const setting of [null, ''] as const) {
        if (setting !== null) {
          await api.query(`SELECT set_config('app.current_user_id', $1, true)`, [setting]);
        }
        const visible = await api.query(
          `SELECT 1 FROM worker_referred_jobs WHERE worker_id = ANY($1::uuid[])`,
          [[s.workerA.id, s.workerB.id]],
        );
        expect(visible.rows).toEqual([]);
        expect(await listOpenReferredJobIds(c, s.workerB.id)).toEqual([]);

        await api.query('SAVEPOINT bare_insert');
        await expect(api.query(
          `INSERT INTO worker_referred_jobs (worker_id, job_id, source) VALUES ($1, $2, 'job_page')`,
          [s.workerA.id, s.jobOpen],
        )).rejects.toThrow(/row-level security/);
        await api.query('ROLLBACK TO SAVEPOINT bare_insert');

        // Through the library: with no worker sub set, the INSERT ... SELECT
        // finds nothing to insert.
        await api.query('SAVEPOINT library_insert');
        await expect(recordReferredJob(c, { workerId: s.workerA.id, jobId: s.jobOpen, source: 'job_page' }))
          .resolves.toBe(false);
        await api.query('ROLLBACK TO SAVEPOINT library_insert');
      }
    } finally {
      await api.query('ROLLBACK').catch(() => undefined);
      await api.end();
    }
    expect(await referredOf(s, s.workerA.id)).toEqual([]);
  });
});
