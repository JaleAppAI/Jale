/**
 * r-paths-share-link-claim.integration.test.ts
 *
 * POST /worker/referrals/claim (lambda/api/worker-referral-claim.ts, with
 * lib/referral-attribution.ts) on its request login, jale_api. A share code
 * is a capability token: share codes resolve through the lookup function,
 * jale_cap.resolve_share_link, and listing links returns only the caller's
 * own.
 *
 *   - a valid code resolves: first-touch credit is written and the link's job
 *     is recorded on the worker's referred-jobs list;
 *   - a revoked code and an unknown code give "no link": a 200 with
 *     claimed: false and nothing recorded or credited;
 *   - listing links returns only the caller's own: a worker gets none of
 *     another referrer's links, even one whose code it just resolved, and
 *     the referrer gets only its own.
 */
import type { Pool } from 'pg';
import { createCheckedPool, setRlsContext } from '../../../lambda/lib/db';
import { apiEvent, fakeShareCode, FIXTURE_TOS_VERSION, parseResponse, World } from './r-paths-world';
import { describeInProfiles, loginPool, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../../lambda/api/worker-referral-claim');

if (!databaseUrl) {
  test('CONCERN: the share link claim DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

interface Scene {
  world: World;
  jobId: string;
  referrer: { id: string; sub: string };
  validCode: string;
  revokedCode: string;
}

async function scene(): Promise<Scene> {
  const world = new World(databaseUrl!);
  await world.connect();
  const employer = await world.employer({ companyName: 'Fixture Referral Co' });
  const job = await world.job(employer.id, { title: 'Fixture Referred Job' });
  const referrer = await world.worker({ fullName: 'Fixture Referrer' });
  const validCode = await world.shareLink({ jobId: job.id, referrerWorkerId: referrer.id, channel: 'whatsapp' });
  const revokedCode = await world.shareLink({ jobId: job.id, referrerWorkerId: referrer.id, channel: 'sms', revoked: true });
  return { world, jobId: job.id, referrer: { id: referrer.id, sub: referrer.sub }, validCode, revokedCode };
}

async function claim(sub: string, shareCode: string) {
  return parseResponse(await handler(apiEvent({
    sub,
    httpMethod: 'POST',
    resource: '/worker/referrals/claim',
    body: { shareCode },
  })));
}

async function creditOf(s: Scene, workerId: string) {
  const { rows } = await s.world.su.query(
    `SELECT first_share_code, first_job_id, first_referrer_worker_id FROM worker_attribution WHERE worker_id = $1`,
    [workerId],
  );
  return rows;
}

async function referredOf(s: Scene, workerId: string) {
  const { rows } = await s.world.su.query(
    `SELECT job_id, source FROM worker_referred_jobs WHERE worker_id = $1`,
    [workerId],
  );
  return rows;
}

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'share codes on jale_api resolve through the capability function', () => {
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

  it('a valid code resolves: the referral is credited and the job recorded', async () => {
    const claimer = await s.world.worker({ fullName: 'Fixture Claimer' });
    const response = await claim(claimer.sub, s.validCode);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ claimed: true, recorded: [s.jobId] });
    expect(await creditOf(s, claimer.id)).toEqual([
      { first_share_code: s.validCode, first_job_id: s.jobId, first_referrer_worker_id: s.referrer.id },
    ]);
    expect(await referredOf(s, claimer.id)).toEqual([{ job_id: s.jobId, source: 'share_link' }]);
  });

  it('a revoked code gives no link: nothing credited, nothing recorded', async () => {
    const claimer = await s.world.worker({ fullName: 'Fixture Claimer' });
    const response = await claim(claimer.sub, s.revokedCode);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ claimed: false, recorded: [] });
    expect(await creditOf(s, claimer.id)).toEqual([]);
    expect(await referredOf(s, claimer.id)).toEqual([]);
  });

  it('an unknown code gives no link: nothing credited, nothing recorded', async () => {
    const claimer = await s.world.worker({ fullName: 'Fixture Claimer' });
    let unknown = fakeShareCode();
    while (unknown === s.validCode || unknown === s.revokedCode) unknown = fakeShareCode();
    const response = await claim(claimer.sub, unknown);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ claimed: false, recorded: [] });
    expect(await creditOf(s, claimer.id)).toEqual([]);
  });

  it('listing links returns only the caller\'s own', async () => {
    const claimer = await s.world.worker({ fullName: 'Fixture Claimer' });
    const pool = loginPool('jale_api', { max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setRlsContext(client, claimer.sub);
      // The function resolves the code for the claimer ...
      const resolved = await client.query(`SELECT job_id FROM jale_cap.resolve_share_link($1)`, [s.validCode]);
      expect(resolved.rows).toEqual([{ job_id: s.jobId }]);
      // ... but the table shows the claimer none of the referrer's links.
      const listed = await client.query(`SELECT code FROM job_share_links`);
      expect(listed.rows.filter((row) => row.code === s.validCode || row.code === s.revokedCode)).toEqual([]);
      const direct = await client.query(`SELECT code FROM job_share_links WHERE code = $1`, [s.validCode]);
      expect(direct.rowCount).toBe(0);
      await client.query('ROLLBACK');

      // The referrer reads its own links, revoked one included.
      await client.query('BEGIN');
      await setRlsContext(client, s.referrer.sub);
      const own = await client.query(`SELECT code FROM job_share_links WHERE job_id = $1 ORDER BY code`, [s.jobId]);
      expect(own.rows.map((row) => row.code).sort()).toEqual([s.validCode, s.revokedCode].sort());
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });
});
