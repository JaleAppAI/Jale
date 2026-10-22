/**
 * job-shift-periods.integration.test.ts
 *
 * Migration 128 (contract K2, shift choices) on a real PostgreSQL 16 bed,
 * through the real logins:
 *
 *   - jobs.shift_periods is NOT NULL DEFAULT '{}', so a job written without
 *     it reads as no shift chosen; jobs_shift_periods_valid refuses a value
 *     outside the four periods, a NULL element and a fifth item;
 *   - who reads it: jale_public_jobs through its column grant; jale_api,
 *     jale_whatsapp and jale_matching through the table-level SELECT they
 *     already hold; jale_job_digest keeps its column list and cannot;
 *   - the handlers on real rows (jale_api, and jale_public_jobs for the
 *     public page): create stores the periods in canonical order, the field
 *     edit keeps them when the key is omitted, replaces them when it is sent
 *     and clears them on [], every reader returns an array, and a saved
 *     template carries them into the job created from it.
 *
 * Fixtures and every read that decides an assertion go through the
 * superuser URL; code under test runs on its own login (login-pool.ts).
 */
import type { Pool } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import { apiEvent, FIXTURE_TOS_VERSION, parseResponse, World } from './r-paths-world';
import { describeInProfiles, loginUrl, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

let mockPool: Pool | undefined;
let mockPublicPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return {
    ...actual,
    getDbPool: async () => {
      if (!mockPool) throw new Error('shift periods suite: no request pool is open');
      return mockPool;
    },
    getPublicJobsDbPool: async () => {
      if (!mockPublicPool) throw new Error('shift periods suite: no public pool is open');
      return mockPublicPool;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: jobsCreate } = require('../../../lambda/api/employer-jobs-create');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: jobsUpdate } = require('../../../lambda/api/employer-jobs-update');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: jobsDetail } = require('../../../lambda/api/employer-jobs-detail');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: workerJobDetail } = require('../../../lambda/api/worker-jobs-detail');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: publicJob } = require('../../../lambda/api/public-job');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: templatesSave } = require('../../../lambda/api/employer-templates-save');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: templatesList } = require('../../../lambda/api/employer-templates-list');

if (!databaseUrl) {
  test('CONCERN: the migration 128 DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const ALL_PROFILES = ['standard', 'request', 'owner-unrestricted'] as const;
const ALL_PERIODS = ['day', 'evening', 'night', 'overnight'];

/** The SQLSTATE `promise` fails with, or null when it succeeds. */
async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

async function storedPeriods(world: World, jobId: string): Promise<unknown> {
  const { rows } = await world.su.query('SELECT shift_periods FROM public.jobs WHERE id = $1', [jobId]);
  return rows[0]?.shift_periods;
}

describeInProfiles([...ALL_PROFILES], 'migration 128: the column and its CHECK', () => {
  let world: World;
  let jobId: string;

  beforeAll(async () => {
    world = new World(databaseUrl!);
    await world.connect();
    const employer = await world.employer({ companyName: 'Fixture Shift Co' });
    jobId = (await world.job(employer.id, { title: 'Fixture Shift Job' })).id;
  });
  afterAll(async () => {
    await world.cleanup();
    await world.end();
  });

  const write = (value: unknown) =>
    world.su.query('UPDATE public.jobs SET shift_periods = $2::text[] WHERE id = $1', [jobId, value]);

  it('reads as an empty array on a job written without it', async () => {
    expect(await storedPeriods(world, jobId)).toEqual([]);
  });

  it('accepts every period, and the empty array', async () => {
    expect(await sqlState(write(ALL_PERIODS))).toBeNull();
    expect(await storedPeriods(world, jobId)).toEqual(ALL_PERIODS);
    expect(await sqlState(write([]))).toBeNull();
    expect(await storedPeriods(world, jobId)).toEqual([]);
  });

  it.each([
    ['a value outside the four periods', ['day', 'afternoon']],
    ['a NULL element', ['day', null]],
    ['a fifth item', ['day', 'evening', 'night', 'overnight', 'day']],
  ])('refuses %s (23514)', async (_label, value) => {
    expect(await sqlState(write(value))).toBe('23514');
  });

  it('refuses NULL for the whole value (23502)', async () => {
    expect(await sqlState(write(null))).toBe('23502');
  });

  it('accepts a duplicate on its own, so the API parser is what keeps values canonical', async () => {
    expect(await sqlState(write(['day', 'day']))).toBeNull();
    await write([]);
  });
});

describeInProfiles([...ALL_PROFILES], 'migration 128: who can read the column', () => {
  let world: World;
  let publicCode: string;

  beforeAll(async () => {
    world = new World(databaseUrl!);
    await world.connect();
    const employer = await world.employer({ companyName: 'Fixture Shift Reader Co' });
    const job = await world.job(employer.id, { title: 'Fixture Public Shift Job', publicListing: true });
    publicCode = job.publicCode;
    await world.su.query(`UPDATE public.jobs SET shift_periods = '{day,night}' WHERE id = $1`, [job.id]);
  });
  afterAll(async () => {
    await world.cleanup();
    await world.end();
  });

  it('jale_public_jobs reads it on a publicly listed job, through its column grant', async () => {
    const rows = await withLoginClient('jale_public_jobs', async (client) =>
      (await client.query('SELECT shift_periods FROM public.jobs WHERE public_code = $1', [publicCode])).rows);
    expect(rows).toEqual([{ shift_periods: ['day', 'night'] }]);
  });

  it('jale_public_jobs still holds no table-wide SELECT on jobs (42501 on a column outside its list)', async () => {
    const state = await withLoginClient('jale_public_jobs', (client) =>
      sqlState(client.query('SELECT employer_id FROM public.jobs LIMIT 0')));
    expect(state).toBe('42501');
  });

  it.each(['jale_api', 'jale_whatsapp', 'jale_matching'])('%s reads it through the rights it already holds', async (login) => {
    const state = await withLoginClient(login, (client) =>
      sqlState(client.query('SELECT shift_periods FROM public.jobs LIMIT 0')));
    expect(state).toBeNull();
    const { rows } = await world.su.query(
      `SELECT pg_catalog.has_column_privilege($1, 'public.jobs', 'shift_periods', 'SELECT') AS can_read,
              pg_catalog.has_table_privilege($1, 'public.jobs', 'SELECT') AS table_wide`,
      [login],
    );
    expect(rows).toEqual([{ can_read: true, table_wide: true }]);
  });

  it('jale_job_digest cannot read it (42501), and still reads its own nine columns', async () => {
    const denied = await withLoginClient('jale_job_digest', (client) =>
      sqlState(client.query('SELECT shift_periods FROM public.jobs LIMIT 0')));
    expect(denied).toBe('42501');
    const ownColumns = await withLoginClient('jale_job_digest', (client) => sqlState(client.query(
      `SELECT id, employer_id, status, title, location, job_type, description, required_docs, created_at
         FROM public.jobs LIMIT 0`,
    )));
    expect(ownColumns).toBeNull();
  });
});

describeInProfiles([...ALL_PROFILES], 'migration 128: the handlers on real rows', () => {
  let world: World;
  let employer: { id: string; sub: string };
  let apiPool: Pool;
  let publicPool: Pool;

  beforeAll(async () => {
    process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
    apiPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test');
    publicPool = await createCheckedPool({ connectionString: loginUrl('jale_public_jobs'), max: 1 }, 'jale_public_jobs', 'test');
    mockPool = apiPool;
    mockPublicPool = publicPool;
  });
  afterAll(async () => {
    mockPool = undefined;
    mockPublicPool = undefined;
    await apiPool.end();
    await publicPool.end();
  });
  beforeEach(async () => {
    world = new World(databaseUrl!);
    await world.connect();
    employer = await world.employer({ companyName: 'Fixture Shift Handler Co' });
    // Jobs the create handler writes are not tracked by the world. A job is
    // publicly listed by default (056), so a field edit queues a visibility
    // ping for it; that outbox has no foreign key, so it goes first.
    const employerId = employer.id;
    world.onCleanup(async () => {
      await world.su.query(
        'DELETE FROM public.job_visibility_events WHERE job_id IN (SELECT id FROM public.jobs WHERE employer_id = $1)',
        [employerId],
      );
      await world.su.query('DELETE FROM public.jobs WHERE employer_id = $1', [employerId]);
    });
  });
  afterEach(async () => {
    await world.cleanup();
    await world.end();
  });

  const BASE_JOB = { title: 'Fixture Shift Crew', location: 'Fixture City, TX', job_type: 'full-time', trade_category: 'carpenter' };

  const create = async (body: Record<string, unknown>) => parseResponse(await jobsCreate(apiEvent({
    sub: employer.sub, httpMethod: 'POST', resource: '/employer/jobs', body: { ...BASE_JOB, ...body },
  })));
  const edit = async (jobId: string, body: Record<string, unknown>) => parseResponse(await jobsUpdate(apiEvent({
    sub: employer.sub, httpMethod: 'PATCH', resource: '/employer/jobs/{jobId}', pathParameters: { jobId },
    body: { ...BASE_JOB, ...body },
  })));
  const detail = async (jobId: string) => parseResponse(await jobsDetail(apiEvent({
    sub: employer.sub, resource: '/employer/jobs/{jobId}', pathParameters: { jobId },
  })));

  it('create stores the periods once each, in canonical order, and returns them', async () => {
    const response = await create({ shift_periods: ['night', 'day', 'night'] });
    expect(response.statusCode).toBe(201);
    expect(response.body.shift_periods).toEqual(['day', 'night']);
    expect(await storedPeriods(world, response.body.id)).toEqual(['day', 'night']);
  });

  it('create without the field stores none', async () => {
    const response = await create({});
    expect(response.statusCode).toBe(201);
    expect(response.body.shift_periods).toEqual([]);
    expect(await storedPeriods(world, response.body.id)).toEqual([]);
  });

  it('the field edit keeps them when the key is omitted, replaces them when sent, and clears them on []', async () => {
    const jobId = (await create({ shift_periods: ['evening', 'day'] })).body.id;

    const omitted = await edit(jobId, { description: 'Edited without the shift control' });
    expect(omitted.statusCode).toBe(200);
    expect(omitted.body.shift_periods).toEqual(['day', 'evening']);
    expect(await storedPeriods(world, jobId)).toEqual(['day', 'evening']);

    const replaced = await edit(jobId, { shift_periods: ['overnight'] });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body.shift_periods).toEqual(['overnight']);
    expect(await storedPeriods(world, jobId)).toEqual(['overnight']);

    const cleared = await edit(jobId, { shift_periods: [] });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body.shift_periods).toEqual([]);
    expect(await storedPeriods(world, jobId)).toEqual([]);
  });

  it('refuses an invalid value with the work_days error shape, and leaves the stored value alone', async () => {
    const jobId = (await create({ shift_periods: ['day'] })).body.id;
    const refused = await edit(jobId, { shift_periods: ['day', 'afternoon'] });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toEqual({ error: 'invalid_shift_periods', valid: ALL_PERIODS });
    expect(await storedPeriods(world, jobId)).toEqual(['day']);
  });

  it('employer detail, worker detail and the public page return them', async () => {
    const created = await create({ shift_periods: ['night', 'day'] });
    const jobId = created.body.id;
    await world.su.query('UPDATE public.jobs SET public_listing_enabled = true WHERE id = $1', [jobId]);
    const { rows } = await world.su.query('SELECT public_code FROM public.jobs WHERE id = $1', [jobId]);
    const worker = await world.worker();

    const employerView = await detail(jobId);
    expect(employerView.statusCode).toBe(200);
    expect(employerView.body.shift_periods).toEqual(['day', 'night']);

    const workerView = parseResponse(await workerJobDetail(apiEvent({
      sub: worker.sub, resource: '/worker/jobs/{jobId}', pathParameters: { jobId },
    })));
    expect(workerView.statusCode).toBe(200);
    expect(workerView.body.shift_periods).toEqual(['day', 'night']);

    const publicView = parseResponse(await publicJob(apiEvent({
      resource: '/public/jobs/{code}', pathParameters: { code: rows[0].public_code },
    })));
    expect(publicView.statusCode).toBe(200);
    expect(publicView.body.shift_periods).toEqual(['day', 'night']);
  });

  it('a template saved with periods lists them, and a job created from it stores them', async () => {
    const saved = parseResponse(await templatesSave(apiEvent({
      sub: employer.sub, httpMethod: 'POST', resource: '/employer/templates',
      body: { name: 'Fixture shift template', payload: { ...BASE_JOB, shift_periods: ['overnight', 'evening', 'evening'] } },
    })));
    expect(saved.statusCode).toBe(201);
    expect(saved.body.payload.shift_periods).toEqual(['evening', 'overnight']);

    const listed = parseResponse(await templatesList(apiEvent({ sub: employer.sub, resource: '/employer/templates' })));
    expect(listed.statusCode).toBe(200);
    const template = listed.body.templates.find((t: { id: string }) => t.id === saved.body.id);
    expect(template.payload.shift_periods).toEqual(['evening', 'overnight']);

    const created = await create({ ...template.payload, template_id: template.id });
    expect(created.statusCode).toBe(201);
    expect(await storedPeriods(world, created.body.id)).toEqual(['evening', 'overnight']);
  });

  it('every reader returns [] for a job written without the field', async () => {
    const old = await world.job(employer.id, { title: 'Fixture Older Job', publicListing: true });
    const worker = await world.worker();

    expect((await detail(old.id)).body.shift_periods).toEqual([]);
    const workerView = parseResponse(await workerJobDetail(apiEvent({
      sub: worker.sub, resource: '/worker/jobs/{jobId}', pathParameters: { jobId: old.id },
    })));
    expect(workerView.body.shift_periods).toEqual([]);
    const publicView = parseResponse(await publicJob(apiEvent({
      resource: '/public/jobs/{code}', pathParameters: { code: old.publicCode },
    })));
    expect(publicView.statusCode).toBe(200);
    expect(publicView.body.shift_periods).toEqual([]);
  });
});
