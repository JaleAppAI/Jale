/**
 * r-paths-job-matching-geo.integration.test.ts
 *
 * Distance scoring on both logins that run the job matcher (lib/job-matching.ts):
 *   - jale_api, through GET /worker/jobs (lambda/api/worker-jobs-list.ts),
 *     driven end to end;
 *   - jale_whatsapp, the WhatsApp "jobs" keyword path, which calls the same
 *     two matcher functions with the worker's internal id set.
 *
 * The matcher selects the coordinate columns of jobs, worker_profiles and
 * worker_preferred_cities directly. These tests seed real coordinates and
 * assert that the nearby job is scored by distance, both from the worker's
 * own map pin and from a preferred city's centroid, while a job far away is
 * not.
 */
import type { Pool, PoolClient } from 'pg';
import { createCheckedPool, setInternalUserRlsContext } from '../../../lambda/lib/db';
import { cityAnchorsFrom, listMatchedJobsForWorker, loadWorkerPreferredCities } from '../../../lambda/lib/job-matching';
import { apiEvent, FIXTURE_TOS_VERSION, parseResponse, World } from './r-paths-world';
import { describeInProfiles, loginPool, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../../lambda/api/worker-jobs-list');

if (!databaseUrl) {
  test('CONCERN: the job matching distance DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

// A fictional pair of points: NEAR sits on the worker, FAR is ~1,900 miles away.
const NEAR = { latitude: 31.7619, longitude: -106.485 };
const FAR = { latitude: 40.7128, longitude: -74.006 };
const DISTANCE_REASON = /^distance_under_/;

interface Scene {
  world: World;
  nearJobId: string;
  farJobId: string;
  cityKey: string;
  pinned: { id: string; sub: string };
  byCity: { id: string; sub: string };
}

async function scene(): Promise<Scene> {
  const world = new World(databaseUrl!);
  await world.connect();
  const suffix = Math.random().toString(36).slice(2, 8);
  const cityKey = `fixture-near-${suffix}-tx`;
  const employer = await world.employer({ companyName: 'Fixture Geo Co' });
  const near = await world.job(employer.id, { title: 'Fixture Near Job', ...NEAR, cityKey });
  const far = await world.job(employer.id, { title: 'Fixture Far Job', ...FAR });

  // Worker 1 has a map pin on NEAR and no preferred cities.
  const pinned = await world.worker({ fullName: 'Fixture Pinned Worker' });
  await world.workerProfile(pinned.id, { ...NEAR, location: 'Fixture City' });

  // Worker 2 has no map pin; a preferred city's centroid anchors the score.
  const byCity = await world.worker({ fullName: 'Fixture City Worker' });
  await world.preferredCity(byCity.id, { cityKey, city: 'Fixture Near', state: 'TX', ...NEAR });

  return { world, nearJobId: near.id, farJobId: far.id, cityKey, pinned, byCity };
}

type Listed = { id: string; match_reasons: string[] };

function reasonsOf(jobs: Listed[], id: string): string[] | undefined {
  return jobs.find((job) => job.id === id)?.match_reasons;
}

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'distance scoring on jale_api (GET /worker/jobs)', () => {
  let s: Scene;
  beforeAll(async () => {
    process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
    s = await scene();
    mockPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test');
  });
  afterAll(async () => {
    await mockPool?.end();
    mockPool = undefined;
    await s.world.cleanup();
    await s.world.end();
  });

  it('scores the nearby job by distance from the worker\'s own coordinates, and not the far one', async () => {
    const response = parseResponse(await handler(apiEvent({ sub: s.pinned.sub, resource: '/worker/jobs' })));
    expect(response.statusCode).toBe(200);
    const jobs: Listed[] = response.body.jobs;
    expect(reasonsOf(jobs, s.nearJobId)).toContain('distance_under_5_miles');
    const far = reasonsOf(jobs, s.farJobId);
    expect(far).toBeDefined();
    expect(far!.some((reason) => DISTANCE_REASON.test(reason))).toBe(false);
  });

  it('scores by distance from a preferred city\'s centroid when the worker has no coordinates', async () => {
    const response = parseResponse(await handler(apiEvent({ sub: s.byCity.sub, resource: '/worker/jobs' })));
    expect(response.statusCode).toBe(200);
    expect(reasonsOf(response.body.jobs, s.nearJobId)).toContain('distance_under_5_miles');
  });
});

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'distance scoring on jale_whatsapp (the matcher with the worker context set)', () => {
  let s: Scene;
  let pool: Pool;
  beforeAll(async () => {
    s = await scene();
    pool = loginPool('jale_whatsapp', { max: 1 });
  });
  afterAll(async () => {
    await pool.end();
    await s.world.cleanup();
    await s.world.end();
  });

  async function asWorker<T>(workerId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setInternalUserRlsContext(client, workerId);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  it('scores the nearby job by distance from the worker\'s own coordinates, and not the far one', async () => {
    const jobs = await asWorker(s.pinned.id, (client) =>
      listMatchedJobsForWorker(client, s.pinned.id, { limit: 100, channel: 'whatsapp' }));
    expect(reasonsOf(jobs, s.nearJobId)).toContain('distance_under_5_miles');
    const far = reasonsOf(jobs, s.farJobId);
    expect(far).toBeDefined();
    expect(far!.some((reason) => DISTANCE_REASON.test(reason))).toBe(false);
  });

  it('reads the preferred city\'s centroid and scores by distance from it', async () => {
    const jobs = await asWorker(s.byCity.id, async (client) => {
      const cities = await loadWorkerPreferredCities(client, s.byCity.id);
      expect(cities).toEqual([
        expect.objectContaining({ city_key: s.cityKey, latitude: expect.anything(), longitude: expect.anything() }),
      ]);
      const cityAnchors = cityAnchorsFrom(cities);
      expect(cityAnchors).toHaveLength(1);
      return listMatchedJobsForWorker(client, s.byCity.id, {
        limit: 100, channel: 'whatsapp', cityKeys: [s.cityKey], cityAnchors,
      });
    });
    expect(reasonsOf(jobs, s.nearJobId)).toContain('distance_under_5_miles');
  });
});
