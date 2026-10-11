/**
 * r-paths-job-visibility-dedupe.integration.test.ts
 *
 * The content-edit path of PATCH /employer/jobs/{jobId}
 * (lambda/api/employer-jobs-update.ts) pings the visibility drain when a
 * published job is edited, unless a 'published' ping for that job is already
 * pending. The dedupe read runs on the request login, jale_api, in the edit's
 * own transaction after the ownership check, with the caller's context set.
 *
 * Driven end to end on jale_api against seeded data:
 *   - the first edit of a published job enqueues one ping, and a repeat edit
 *     with no content change, while that ping is pending, enqueues nothing;
 *   - once the earlier ping has been sent, an edit enqueues a new one;
 *   - another employer's edit is refused and enqueues nothing.
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
const { handler } = require('../../../lambda/api/employer-jobs-update');

if (!databaseUrl) {
  test('CONCERN: the visibility dedupe DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

// A complete edit body. Sending it twice is a repeat edit with no content
// change.
const EDIT = { title: 'Fixture Job', location: 'Fixture City', job_type: 'full-time', trade_category: 'carpenter' };

interface Scene {
  world: World;
  employerSub: string;
  otherEmployerSub: string;
  jobId: string;
  publicCode: string;
}

async function scene(): Promise<Scene> {
  const world = new World(databaseUrl!);
  await world.connect();
  const employer = await world.employer({ companyName: 'Fixture Visibility Co' });
  const otherEmployer = await world.employer({ companyName: 'Other Fixture Co' });
  const job = await world.job(employer.id, { publicListing: true });
  return { world, employerSub: employer.sub, otherEmployerSub: otherEmployer.sub, jobId: job.id, publicCode: job.publicCode };
}

async function editAs(sub: string, jobId: string, body: unknown) {
  return parseResponse(await handler(apiEvent({
    sub,
    httpMethod: 'PATCH',
    resource: '/employer/jobs/{jobId}',
    pathParameters: { jobId },
    body,
  })));
}

async function events(s: Scene): Promise<Array<{ event_kind: string; status: string }>> {
  const { rows } = await s.world.su.query(
    `SELECT event_kind, status FROM job_visibility_events WHERE job_id = $1 ORDER BY created_at, id`,
    [s.jobId],
  );
  return rows;
}

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'the content-edit visibility dedupe on jale_api', () => {
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

  it('a repeat edit with no content change, while the first ping is pending, enqueues nothing', async () => {
    expect((await editAs(s.employerSub, s.jobId, EDIT)).statusCode).toBe(200);
    expect(await events(s)).toEqual([{ event_kind: 'published', status: 'pending' }]);

    expect((await editAs(s.employerSub, s.jobId, EDIT)).statusCode).toBe(200);
    expect(await events(s)).toEqual([{ event_kind: 'published', status: 'pending' }]);
  });

  it('once the earlier ping has been sent, an edit enqueues a new one', async () => {
    await s.world.su.query(
      `INSERT INTO job_visibility_events (job_id, public_code, event_kind, status, sent_at)
       VALUES ($1, $2, 'published', 'sent', now())`,
      [s.jobId, s.publicCode],
    );
    expect((await editAs(s.employerSub, s.jobId, EDIT)).statusCode).toBe(200);
    expect(await events(s)).toEqual([
      { event_kind: 'published', status: 'sent' },
      { event_kind: 'published', status: 'pending' },
    ]);
  });

  it('another employer\'s edit is refused and enqueues nothing', async () => {
    const response = await editAs(s.otherEmployerSub, s.jobId, EDIT);
    expect(response.statusCode).toBe(403);
    expect(await events(s)).toEqual([]);
  });
});
