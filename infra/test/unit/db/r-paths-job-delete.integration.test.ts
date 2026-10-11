/**
 * r-paths-job-delete.integration.test.ts
 *
 * DELETE /employer/jobs/{jobId} (lambda/api/employer-jobs-delete.ts), driven
 * end to end on its request login, jale_api, against seeded data:
 *
 *   - the job, its applications, its conversations (with their messages and
 *     outbox rows), every job-scoped document -- including one whose worker
 *     has no application left -- and its upload tokens (with their slots) are
 *     all gone afterwards;
 *   - a 'removed' visibility event is enqueued for the published job;
 *   - the worker's vault document and another employer's job, with all of its
 *     rows, are untouched;
 *   - another employer cannot delete the job.
 *
 * Every assertion reads through the superuser, so "gone" means gone from the
 * database.
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
const { handler } = require('../../../lambda/api/employer-jobs-delete');

if (!databaseUrl) {
  test('CONCERN: the job delete DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

interface Scene {
  world: World;
  employerSub: string;
  otherEmployerSub: string;
  jobId: string;
  jobConversations: string[];
  tokenHash: string;
  vaultDocId: string;
  other: { jobId: string; applicationId: string; conversationId: string; documentId: string; tokenHash: string };
}

async function scene(): Promise<Scene> {
  const world = new World(databaseUrl!);
  await world.connect();
  const employer = await world.employer({ companyName: 'Fixture Delete Co' });
  const otherEmployer = await world.employer({ companyName: 'Other Fixture Co' });
  const job = await world.job(employer.id, { title: 'Fixture Job To Delete', publicListing: true });
  const otherJob = await world.job(otherEmployer.id, { title: 'Fixture Job To Keep' });

  const w1 = await world.worker({ fullName: 'Fixture Worker One', whatsappNumber: null });
  const w2 = await world.worker({ fullName: 'Fixture Worker Two' });
  const w3 = await world.worker({ fullName: 'Fixture Worker Three' });

  // Two applicants with conversations; the first with a message and an outbox row.
  const a1 = await world.application(job.id, w1.id);
  const a2 = await world.application(job.id, w2.id);
  const c1 = await world.conversation({ jobId: job.id, employerId: employer.id, workerId: w1.id, applicationId: a1 });
  const c2 = await world.conversation({ jobId: job.id, employerId: employer.id, workerId: w2.id, applicationId: a2 });
  const m1 = await world.message(c1, 'Fixture message');
  await world.outbox(c1, m1, w1.phone!, 'Fixture message');

  // Job-scoped documents: two applicants', and one from a worker with no application.
  await world.document({ workerId: w1.id, jobId: job.id, docType: 'resume' });
  await world.document({ workerId: w2.id, jobId: job.id, docType: 'driver_license' });
  await world.document({ workerId: w3.id, jobId: job.id, docType: 'resume' });
  const vaultDocId = await world.document({ workerId: w1.id, jobId: null, docType: 'driver_license' });

  // An upload token with a slot.
  const token = await world.uploadToken({ jobId: job.id, workerId: w1.id });
  await world.uploadSlot(token.hash, { docType: 'resume' });

  // Another employer's job, with the same worker: none of this may change.
  const otherApplication = await world.application(otherJob.id, w1.id);
  const otherConversation = await world.conversation({
    jobId: otherJob.id, employerId: otherEmployer.id, workerId: w1.id, applicationId: otherApplication,
  });
  const otherDocument = await world.document({ workerId: w1.id, jobId: otherJob.id, docType: 'resume' });
  const otherToken = await world.uploadToken({ jobId: otherJob.id, workerId: w1.id });

  return {
    world,
    employerSub: employer.sub,
    otherEmployerSub: otherEmployer.sub,
    jobId: job.id,
    jobConversations: [c1, c2],
    tokenHash: token.hash,
    vaultDocId,
    other: {
      jobId: otherJob.id,
      applicationId: otherApplication,
      conversationId: otherConversation,
      documentId: otherDocument,
      tokenHash: otherToken.hash,
    },
  };
}

async function count(s: Scene, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await s.world.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return rows[0].n;
}

async function deleteAs(sub: string, jobId: string) {
  return parseResponse(await handler(apiEvent({
    sub,
    httpMethod: 'DELETE',
    resource: '/employer/jobs/{jobId}',
    pathParameters: { jobId },
  })));
}

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'job delete on jale_api', () => {
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

  it('another employer cannot delete the job, and nothing changes', async () => {
    const response = await deleteAs(s.otherEmployerSub, s.jobId);
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden' });
    expect(await count(s, 'jobs WHERE id = $1', [s.jobId])).toBe(1);
    expect(await count(s, 'job_conversations WHERE job_id = $1', [s.jobId])).toBe(2);
    expect(await count(s, 'worker_documents WHERE job_id = $1', [s.jobId])).toBe(3);
    expect(await count(s, 'document_upload_tokens WHERE job_id = $1', [s.jobId])).toBe(1);
    expect(await count(s, 'job_visibility_events WHERE job_id = $1', [s.jobId])).toBe(0);
  });

  it('removes the job and everything scoped to it, enqueues the removal, and leaves the rest alone', async () => {
    const response = await deleteAs(s.employerSub, s.jobId);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ deleted: true, id: s.jobId });

    // Gone: the job and everything scoped to it.
    expect(await count(s, 'jobs WHERE id = $1', [s.jobId])).toBe(0);
    expect(await count(s, 'job_applications WHERE job_id = $1', [s.jobId])).toBe(0);
    expect(await count(s, 'job_conversations WHERE job_id = $1', [s.jobId])).toBe(0);
    expect(await count(s, 'job_conversation_messages WHERE conversation_id = ANY($1::uuid[])', [s.jobConversations])).toBe(0);
    expect(await count(s, 'job_message_outbox WHERE conversation_id = ANY($1::uuid[])', [s.jobConversations])).toBe(0);
    expect(await count(s, 'worker_documents WHERE job_id = $1', [s.jobId])).toBe(0);
    expect(await count(s, 'document_upload_tokens WHERE job_id = $1', [s.jobId])).toBe(0);
    expect(await count(s, 'document_upload_token_slots WHERE token_hash = $1', [s.tokenHash])).toBe(0);

    // Enqueued: one pending 'removed' event for the published job.
    const { rows: events } = await s.world.su.query(
      `SELECT event_kind, status FROM job_visibility_events WHERE job_id = $1`, [s.jobId],
    );
    expect(events).toEqual([{ event_kind: 'removed', status: 'pending' }]);

    // Untouched: the worker's vault document and the other employer's job.
    expect(await count(s, 'worker_documents WHERE id = $1', [s.vaultDocId])).toBe(1);
    expect(await count(s, 'jobs WHERE id = $1', [s.other.jobId])).toBe(1);
    expect(await count(s, 'job_applications WHERE id = $1', [s.other.applicationId])).toBe(1);
    expect(await count(s, 'job_conversations WHERE id = $1', [s.other.conversationId])).toBe(1);
    expect(await count(s, 'worker_documents WHERE id = $1', [s.other.documentId])).toBe(1);
    expect(await count(s, 'document_upload_tokens WHERE token_hash = $1', [s.other.tokenHash])).toBe(1);
  });
});
