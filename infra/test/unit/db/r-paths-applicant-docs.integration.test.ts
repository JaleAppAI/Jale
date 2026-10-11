/**
 * r-paths-applicant-docs.integration.test.ts
 *
 * GET /employer/jobs/{jobId}/applicants reports, per applicant, the optional
 * documents the worker did NOT provide (`not_provided`). Product rule
 * (2026-10-02): a document counts as provided only when it is attached to
 * THIS job. A vault-only document (job_id NULL), one attached to another job
 * of the same employer, and one attached to another employer's job all count
 * as not provided; duplicates count once.
 *
 * The handler runs end to end against a real PostgreSQL 16 bed:
 *   - on its request login (jale_api), in every profile;
 *   - in the unrestricted profile, also on a login with no row policies, so
 *     the SQL predicates alone must state the rule. That half is the one that
 *     separates the old SQL from the new; the request-login half reads the
 *     same before and after the change.
 */
import type { Pool } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import * as auditRecord from '../../../lambda/lib/audit/record';
import { apiEvent, FIXTURE_TOS_VERSION, parseResponse, World } from './r-paths-world';
import { describeInProfiles, loginPool, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../../lambda/api/employer-job-applicants');

if (!databaseUrl) {
  test('CONCERN: the applicant documents DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

interface Matrix {
  world: World;
  employerSub: string;
  jobId: string;
  workerVault: string;
  workerOther: string;
}

const OPTIONAL_DOCS = ['resume', 'driver_license', 'work_auth_doc', 'certification_doc'];

async function seedMatrix(): Promise<Matrix> {
  const world = new World(databaseUrl!);
  await world.connect();
  const employer = await world.employer({ companyName: 'Fixture Co' });
  const otherEmployer = await world.employer({ companyName: 'Other Fixture Co' });
  const job = await world.job(employer.id, { optionalDocs: OPTIONAL_DOCS });
  const sameEmployerOtherJob = await world.job(employer.id);
  const otherEmployerJob = await world.job(otherEmployer.id);

  // Applicant 1:
  //   resume            vault only (job_id NULL)          -> NOT provided
  //   driver_license    attached to this job, plus a vault copy -> provided once
  //   work_auth_doc     attached to another job of the same employer -> NOT provided
  //   certification_doc two files attached to this job    -> provided once
  const w1 = await world.worker({ fullName: 'Fixture Applicant One' });
  await world.application(job.id, w1.id);
  await world.application(sameEmployerOtherJob.id, w1.id);
  await world.document({ workerId: w1.id, jobId: null, docType: 'resume' });
  await world.document({ workerId: w1.id, jobId: job.id, docType: 'driver_license' });
  await world.document({ workerId: w1.id, jobId: null, docType: 'driver_license' });
  await world.document({ workerId: w1.id, jobId: sameEmployerOtherJob.id, docType: 'work_auth_doc' });
  await world.document({ workerId: w1.id, jobId: job.id, docType: 'certification_doc', certName: 'Fixture cert A' });
  await world.document({ workerId: w1.id, jobId: job.id, docType: 'certification_doc', certName: 'Fixture cert B' });

  // Applicant 2:
  //   resume         attached to this job                 -> provided
  //   work_auth_doc  attached to ANOTHER employer's job   -> NOT provided
  const w2 = await world.worker({ fullName: 'Fixture Applicant Two' });
  await world.application(job.id, w2.id);
  await world.application(otherEmployerJob.id, w2.id);
  await world.document({ workerId: w2.id, jobId: job.id, docType: 'resume' });
  await world.document({ workerId: w2.id, jobId: otherEmployerJob.id, docType: 'work_auth_doc' });

  return { world, employerSub: employer.sub, jobId: job.id, workerVault: w1.id, workerOther: w2.id };
}

async function applicants(m: Matrix): Promise<Record<string, { not_provided: string[] }>> {
  const response = parseResponse(await handler(apiEvent({
    sub: m.employerSub,
    resource: '/employer/jobs/{jobId}/applicants',
    pathParameters: { jobId: m.jobId },
  })));
  expect(response.statusCode).toBe(200);
  const byWorker: Record<string, { not_provided: string[] }> = {};
  for (const applicant of response.body.applicants) byWorker[applicant.worker_id] = applicant;
  expect(Object.keys(byWorker).sort()).toEqual([m.workerVault, m.workerOther].sort());
  return byWorker;
}

function expectRule(m: Matrix, byWorker: Record<string, { not_provided: string[] }>): void {
  expect(byWorker[m.workerVault].not_provided).toEqual(['resume', 'work_auth_doc']);
  expect(byWorker[m.workerOther].not_provided).toEqual(['driver_license', 'work_auth_doc', 'certification_doc']);
}

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'optional documents count only when attached to this job (jale_api)', () => {
  let m: Matrix;
  beforeAll(async () => {
    process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
    m = await seedMatrix();
    mockPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test');
  });
  afterAll(async () => {
    await mockPool?.end();
    mockPool = undefined;
    await m.world.cleanup();
    await m.world.end();
  });

  it('vault-only, other-job and other-employer documents are not provided; duplicates count once', async () => {
    expectRule(m, await applicants(m));
  });
});

describeInProfiles(['owner-unrestricted'], 'the SQL predicates alone state the rule', () => {
  let m: Matrix;
  // Only the handler's SQL predicates are under test in this block. The access
  // record is covered on the request login by d-app-access-records; this login
  // has no EXECUTE on jale_audit.record_event by design, so the record is
  // stubbed here and nowhere else in the file.
  let recordAccess: jest.SpyInstance | undefined;
  beforeAll(async () => {
    process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
    m = await seedMatrix();
    mockPool = loginPool('jale_admin', { max: 1 });
    recordAccess = jest.spyOn(auditRecord, 'recordAccess').mockResolvedValue(undefined);
  });
  afterAll(async () => {
    recordAccess?.mockRestore();
    await mockPool?.end();
    mockPool = undefined;
    await m.world.cleanup();
    await m.world.end();
  });

  it('a vault-only document is not provided by the SQL predicate alone', async () => {
    expectRule(m, await applicants(m));
  });
});
