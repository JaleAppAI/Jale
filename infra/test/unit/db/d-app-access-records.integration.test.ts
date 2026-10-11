/**
 * d-app-access-records.integration.test.ts
 *
 * Every request surface that records the personal data it returns, driven
 * end to end on its real login against a real PostgreSQL bed.
 * Each test asserts the handler's status and the one jale_audit.events row
 * its request wrote: the actor, the surface's categories and record type,
 * the subjects and records it returned, how many, the purpose, the request
 * id and the database login. Field names are names only, never values.
 *
 * Also here:
 *   - one attempt written after a ROLLBACK (a denied candidates read);
 *   - the application-details door on the WhatsApp engine's login: a
 *     read whose snapshot sync names the worker in the change records, and a
 *     refused merge whose state still goes out, with exactly one read record
 *     and none of the merge's writes kept;
 *   - a last test that the surfaces driven here are exactly the registry's
 *     (lib/audit/registry.ts), so a new surface without a case fails.
 *
 * Stand-ins: the S3 presigner returns a fixed URL, the WhatsApp sender
 * records instead of sending, and any other AWS call or network request
 * fails the test. Fixtures: r-paths-world.ts and r-paths-sweep-fixtures.ts,
 * unchanged. Records are read back through the bed's fixture connection.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import { ACCESS_SURFACES, FIELD_NAME_PATTERN, type AccessSurface } from '../../../lambda/lib/audit/registry';
import { fakePhone, FIXTURE_TOS_VERSION } from './r-paths-world';
import { describeInProfiles, loginUrl } from './helpers/login-pool';
import {
  applicationDefaults, closeScene, count, expectStatus, invoke, LogCapture, openScene, seed, sweepEmployer,
  sweepEvent, sweepJob, sweepWorker, type SweepScene, workerPost,
} from './r-paths-sweep-fixtures';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

jest.setTimeout(60_000);

// ── Environment (fake values only), before any handler module loads ───────
process.env.ALLOWED_ORIGIN = 'http://localhost:3000';
process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
process.env.DOCUMENTS_BUCKET = 'fixture-documents-bucket';
process.env.MEDIA_BUCKET = 'fixture-media-bucket';
process.env.PUBLIC_SITE_BASE_URL = 'https://fixture.invalid';
process.env.FRONTEND_BASE_URL = 'https://fixture.invalid';
process.env.EMPLOYER_CANDIDATE_RERANK_QUEUE_URL = 'https://fixture.invalid/queue/candidate-rerank';

// ── The database: each handler gets a checked pool on its real login ───────
let mockCurrentPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return {
    ...actual,
    getDbPool: async () => {
      if (!mockCurrentPool) throw new Error('access records: no login pool is open');
      return mockCurrentPool;
    },
  };
});

// ── AWS SDK clients: the real Command classes, a recording client ──────────
type SentCommand = { constructor: { name: string }; input?: any };
const mockAwsSend = jest.fn(async (service: string, command: SentCommand): Promise<unknown> => {
  if (service === 'sqs' && command.constructor.name === 'SendMessageCommand') {
    return { MessageId: `fixture-message-${randomUUID()}` };
  }
  throw new Error(`access records: unexpected AWS call ${service}:${command.constructor.name}`);
});

function mockSdkModule(moduleName: string, clientName: string, service: string): Record<string, unknown> {
  const actual = jest.requireActual(moduleName);
  class FixtureClient {
    readonly config = {};
    send(command: SentCommand): Promise<unknown> {
      return mockAwsSend(service, command);
    }
    destroy(): void {}
  }
  return { ...actual, [clientName]: FixtureClient };
}

jest.mock('@aws-sdk/client-s3', () => mockSdkModule('@aws-sdk/client-s3', 'S3Client', 's3'));
jest.mock('@aws-sdk/client-sqs', () => mockSdkModule('@aws-sdk/client-sqs', 'SQSClient', 'sqs'));
jest.mock('@aws-sdk/client-cloudwatch-logs', () =>
  mockSdkModule('@aws-sdk/client-cloudwatch-logs', 'CloudWatchLogsClient', 'logs'));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_client: unknown, command: SentCommand) =>
    `https://fixture.invalid/presigned/${encodeURIComponent(String(command.input?.Key ?? ''))}`,
}));
jest.mock('../../../lambda/whatsapp/lib/outbox', () => {
  const actual = jest.requireActual('../../../lambda/whatsapp/lib/outbox');
  return { ...actual, sendTwilioWhatsAppMessage: jest.fn(async () => `fixture-sid-${randomUUID()}`) };
});

type Handler = (event?: any) => Promise<any>;

/** Handlers load lazily, so a module that fails at import fails one test. */
function load(modulePath: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath).handler;
}

interface EventRow {
  kind: string;
  outcome: string;
  actor_kind: string;
  actor_id: string | null;
  channel: string;
  surface: string;
  categories: string[];
  subject_user_ids: string[];
  record_type: string | null;
  record_ids: string[];
  result_count: number;
  field_names: string[];
  purpose_kind: string | null;
  purpose_id: string | null;
  link_expires_at: Date | null;
  part: number;
  parts: number;
  request_id: string;
  db_login: string;
}

interface ChangeRow {
  table_name: string;
  operation: string;
  record_ids: string[];
  subject_user_ids: string[];
  actor_kind: string | null;
  actor_id: string | null;
  channel: string | null;
  surface: string | null;
  request_id: string | null;
  context_status: string;
  db_login: string;
}

async function eventsFor(s: SweepScene, requestId: string): Promise<EventRow[]> {
  const { rows } = await s.world.su.query<EventRow>(
    `SELECT kind::text AS kind, outcome::text AS outcome, actor_kind::text AS actor_kind, actor_id::text AS actor_id,
            channel::text AS channel, surface, categories::text[] AS categories,
            subject_user_ids::text[] AS subject_user_ids, record_type::text AS record_type,
            record_ids::text[] AS record_ids, result_count, field_names::text[] AS field_names,
            purpose_kind::text AS purpose_kind, purpose_id::text AS purpose_id, link_expires_at,
            part, parts, request_id, db_login::text AS db_login
       FROM jale_audit.events
      WHERE request_id = $1
      ORDER BY seq`,
    [requestId],
  );
  return rows;
}

async function changesFor(s: SweepScene, requestId: string): Promise<ChangeRow[]> {
  const { rows } = await s.world.su.query<ChangeRow>(
    `SELECT table_name, operation, record_ids::text[] AS record_ids, subject_user_ids::text[] AS subject_user_ids,
            actor_kind, actor_id::text AS actor_id, channel, surface, request_id, context_status,
            db_login::text AS db_login
       FROM jale_audit.changes
      WHERE request_id = $1
      ORDER BY seq`,
    [requestId],
  );
  return rows;
}

async function lastChangeSeq(s: SweepScene): Promise<string> {
  const { rows } = await s.world.su.query<{ seq: string }>('SELECT COALESCE(max(seq), 0)::text AS seq FROM jale_audit.changes');
  return rows[0].seq;
}

/** Change rows written after `seq` on `table` (schema-qualified) for any of `ids`, as record or subject. */
async function changesSince(s: SweepScene, seq: string, table: string, ids: string[]): Promise<number> {
  const { rows } = await s.world.su.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jale_audit.changes
      WHERE seq > $1::bigint AND table_name = $2
        AND (record_ids && $3::uuid[] OR subject_user_ids && $3::uuid[])`,
    [seq, table, ids],
  );
  return rows[0].n;
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

interface ExpectedRead {
  surface: AccessSurface;
  actorKind: 'employer' | 'worker';
  actorId: string;
  subjects: string[];
  records: string[];
  resultCount: number;
  purpose: { kind: string; id?: string } | null;
  links: boolean;
  login: 'jale_api' | 'jale_whatsapp';
}

describeInProfiles(['request', 'owner-unrestricted'], 'access records on the request paths', () => {
  let scene: SweepScene | undefined;
  let logs: LogCapture;
  let fetchSpy: jest.SpyInstance;
  const driven = new Set<string>();

  async function openWorld(): Promise<SweepScene> {
    scene = await seed(() => openScene(databaseUrl!));
    return scene;
  }

  /** A checked pool on `login` for the duration of `fn`, ended afterwards. */
  async function asLogin<T>(login: string, fn: () => Promise<T>): Promise<T> {
    mockCurrentPool = await createCheckedPool({ connectionString: loginUrl(login), max: 1 }, login, 'test');
    logs.watchPool(mockCurrentPool);
    try {
      return await fn();
    } finally {
      const pool = mockCurrentPool;
      mockCurrentPool = undefined;
      await pool?.end();
    }
  }

  /** An employer with a job and one applicant. */
  async function applicantScene(s: SweepScene, opts: {
    worker?: Parameters<typeof sweepWorker>[1]; job?: Parameters<typeof sweepJob>[2]; status?: string;
  } = {}) {
    const employer = await sweepEmployer(s);
    const worker = await sweepWorker(s, opts.worker);
    const job = await sweepJob(s, employer.id, opts.job);
    const applicationId = await s.world.application(job.id, worker.id, opts.status);
    return { employer, worker, job, applicationId };
  }

  /** The applicant scene plus a conversation about the job. */
  async function conversationScene(s: SweepScene, messages: number) {
    const a = await applicantScene(s);
    const conversationId = await s.world.conversation({
      jobId: a.job.id, employerId: a.employer.id, workerId: a.worker.id, applicationId: a.applicationId,
    });
    for (let i = 0; i < messages; i += 1) await s.world.message(conversationId, `Fixture message ${i + 1}`);
    return { ...a, conversationId };
  }

  /** The request's one read record, checked field by field. */
  async function expectRead(s: SweepScene, requestId: string, expected: ExpectedRead): Promise<EventRow> {
    const rows = await eventsFor(s, requestId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    const entry = ACCESS_SURFACES[expected.surface];
    expect(row).toEqual(expect.objectContaining({
      kind: 'read',
      outcome: 'allowed',
      actor_kind: expected.actorKind,
      actor_id: expected.actorId,
      channel: 'web',
      surface: expected.surface,
      record_type: entry.recordType,
      result_count: expected.resultCount,
      purpose_kind: expected.purpose?.kind ?? null,
      purpose_id: expected.purpose?.id ?? null,
      part: 1,
      parts: 1,
      request_id: requestId,
      db_login: expected.login,
    }));
    expect(sorted(row.categories)).toEqual(sorted(entry.categories));
    expect(sorted(row.subject_user_ids)).toEqual(sorted(expected.subjects));
    expect(sorted(row.record_ids)).toEqual(sorted(expected.records));
    expect(row.field_names.length).toBeGreaterThan(0);
    for (const name of row.field_names) expect(name).toMatch(FIELD_NAME_PATTERN);
    if (expected.links) expect(row.link_expires_at).toBeInstanceOf(Date);
    else expect(row.link_expires_at).toBeNull();
    driven.add(expected.surface);
    return row;
  }

  beforeEach(() => {
    mockAwsSend.mockClear();
    logs = new LogCapture();
    logs.start();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('access records: unexpected network call');
    }) as typeof fetch);
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    logs.stop();
    const closing = scene;
    scene = undefined;
    await closeScene(closing);
  });

  // ── Employer reads of one applicant ────────────────────────────────────

  it('employer.worker_profile: the applicant profile read is recorded for the job', async () => {
    const s = await openWorld();
    const { employer, worker, job, applicationId } = await seed(async () => {
      const a = await applicantScene(s);
      await s.world.workerProfile(a.worker.id, { location: 'Fixture City' });
      return a;
    });
    const event = sweepEvent({
      sub: employer.sub, resource: '/employer/workers/{worker_id}/{action}',
      pathParameters: { worker_id: worker.id, action: 'profile' }, queryStringParameters: { job_id: job.id },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-worker-detail'), event));
    expectStatus(response, 200, logs);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'employer.worker_profile', actorKind: 'employer', actorId: employer.id, subjects: [worker.id],
      records: [applicationId], resultCount: 1, purpose: { kind: 'job', id: job.id }, links: false, login: 'jale_api',
    });
  });

  it('employer.worker_documents: the job documents read is recorded with its link expiry', async () => {
    const s = await openWorld();
    const { employer, worker, job, documentId } = await seed(async () => {
      const a = await applicantScene(s);
      return { ...a, documentId: await s.world.document({ workerId: a.worker.id, jobId: a.job.id, docType: 'resume' }) };
    });
    const event = sweepEvent({
      sub: employer.sub, resource: '/employer/workers/{worker_id}/{action}',
      pathParameters: { worker_id: worker.id, action: 'documents' }, queryStringParameters: { job_id: job.id },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-worker-detail'), event));
    expectStatus(response, 200, logs);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'employer.worker_documents', actorKind: 'employer', actorId: employer.id, subjects: [worker.id],
      records: [documentId], resultCount: 1, purpose: { kind: 'job', id: job.id }, links: true, login: 'jale_api',
    });
  });

  it('employer.worker_posts: the posts read is recorded with its link expiry', async () => {
    const s = await openWorld();
    const { employer, worker, post } = await seed(async () => {
      const a = await applicantScene(s);
      return { ...a, post: await workerPost(s, a.worker.id) };
    });
    const event = sweepEvent({
      sub: employer.sub, resource: '/employer/workers/{worker_id}/{action}',
      pathParameters: { worker_id: worker.id, action: 'posts' },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-worker-detail'), event));
    expectStatus(response, 200, logs);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'employer.worker_posts', actorKind: 'employer', actorId: employer.id, subjects: [worker.id],
      records: [post.postId], resultCount: 1, purpose: null, links: true, login: 'jale_api',
    });
  });

  // ── Employer lists ─────────────────────────────────────────────────────

  it('employer.job_applicants: the applicant list read is recorded for the job', async () => {
    const s = await openWorld();
    const { employer, worker, job, applicationId } = await seed(() => applicantScene(s));
    const event = sweepEvent({
      sub: employer.sub, resource: '/employer/jobs/{jobId}/applicants', pathParameters: { jobId: job.id },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-job-applicants'), event));
    expectStatus(response, 200, logs);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'employer.job_applicants', actorKind: 'employer', actorId: employer.id, subjects: [worker.id],
      records: [applicationId], resultCount: 1, purpose: { kind: 'job', id: job.id }, links: false, login: 'jale_api',
    });
  });

  it('employer.job_candidates: the candidate list read is recorded for the job', async () => {
    const s = await openWorld();
    const { employer, worker, job } = await seed(() => applicantScene(s));
    const event = sweepEvent({
      sub: employer.sub, resource: '/employer/jobs/{jobId}/candidates', pathParameters: { jobId: job.id },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-job-candidates'), event));
    expectStatus(response, 200, logs);
    expect(response.body.total).toBe(1);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'employer.job_candidates', actorKind: 'employer', actorId: employer.id, subjects: [worker.id],
      records: [worker.id], resultCount: 1, purpose: { kind: 'job', id: job.id }, links: false, login: 'jale_api',
    });
  });

  it('employer.job_candidates refused: a candidates read of another employer\'s job rolls back, then records a denied attempt', async () => {
    const s = await openWorld();
    const { stranger, job } = await seed(async () => {
      const a = await applicantScene(s);
      return { stranger: await sweepEmployer(s), job: a.job };
    });
    const event = sweepEvent({
      sub: stranger.sub, resource: '/employer/jobs/{jobId}/candidates', pathParameters: { jobId: job.id },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-job-candidates'), event));
    expectStatus(response, 403, logs);
    const rows = await eventsFor(s, event.requestContext.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      kind: 'attempt', outcome: 'denied', actor_kind: 'employer', actor_id: stranger.id, channel: 'web',
      surface: 'employer.job_candidates', record_type: 'user', subject_user_ids: [], record_ids: [], result_count: 0,
      field_names: [], purpose_kind: 'job', purpose_id: job.id, db_login: 'jale_api',
    }));
  });

  it('employer.applicants_overview: the cross-job applicant list read is recorded', async () => {
    const s = await openWorld();
    const { employer, worker, applicationId } = await seed(() => applicantScene(s));
    const event = sweepEvent({ sub: employer.sub, resource: '/employer/applicants' });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-applicants-overview'), event));
    expectStatus(response, 200, logs);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'employer.applicants_overview', actorKind: 'employer', actorId: employer.id, subjects: [worker.id],
      records: [applicationId], resultCount: 1, purpose: null, links: false, login: 'jale_api',
    });
  });

  it('employer.inbox: the inbox read is recorded with the conversation it lists', async () => {
    const s = await openWorld();
    const { employer, worker, conversationId } = await seed(() => conversationScene(s, 1));
    const event = sweepEvent({ sub: employer.sub, resource: '/employer/inbox' });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-inbox'), event));
    expectStatus(response, 200, logs);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'employer.inbox', actorKind: 'employer', actorId: employer.id, subjects: [worker.id],
      records: [conversationId], resultCount: 1, purpose: null, links: false, login: 'jale_api',
    });
  });

  it('employer.conversations_list: the conversation list read is recorded', async () => {
    const s = await openWorld();
    const { employer, worker, conversationId } = await seed(() => conversationScene(s, 1));
    const event = sweepEvent({ sub: employer.sub, resource: '/employer/conversations' });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-conversations-list'), event));
    expectStatus(response, 200, logs);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'employer.conversations_list', actorKind: 'employer', actorId: employer.id, subjects: [worker.id],
      records: [conversationId], resultCount: 1, purpose: null, links: false, login: 'jale_api',
    });
  });

  // ── One thread ─────────────────────────────────────────────────────────

  it('employer.conversation_detail: the thread read is recorded for its job', async () => {
    const s = await openWorld();
    const { employer, worker, job, conversationId } = await seed(() => conversationScene(s, 2));
    const event = sweepEvent({
      sub: employer.sub, resource: '/employer/conversations/{conversationId}', pathParameters: { conversationId },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-conversations-detail'), event));
    expectStatus(response, 200, logs);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'employer.conversation_detail', actorKind: 'employer', actorId: employer.id, subjects: [worker.id],
      records: [conversationId], resultCount: 2, purpose: { kind: 'job', id: job.id }, links: false, login: 'jale_api',
    });
  });

  it('employer.conversation_create: the new thread it returns is recorded for its job', async () => {
    const s = await openWorld();
    const { employer, worker, job } = await seed(() => applicantScene(s, {
      worker: { whatsappNumber: fakePhone(), lifecycle: 'ready', workflowLanguage: 'es' },
    }));
    const event = sweepEvent({
      sub: employer.sub, httpMethod: 'POST', resource: '/employer/conversations',
      body: { job_id: job.id, worker_id: worker.id, initial_message: 'Fixture hello' },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-conversations-create'), event));
    expectStatus(response, 201, logs);
    const conversationId: string = response.body.conversation.id;
    await expectRead(s, event.requestContext.requestId, {
      surface: 'employer.conversation_create', actorKind: 'employer', actorId: employer.id, subjects: [worker.id],
      records: [conversationId], resultCount: 1, purpose: { kind: 'job', id: job.id }, links: false, login: 'jale_api',
    });
  });

  it('employer.conversation_send: the thread it returns after the send is recorded', async () => {
    const s = await openWorld();
    const { employer, worker, job, conversationId } = await seed(() => conversationScene(s, 1));
    const event = sweepEvent({
      sub: employer.sub, httpMethod: 'POST', resource: '/employer/conversations/{conversationId}/messages',
      pathParameters: { conversationId }, body: { body: 'Fixture follow-up' },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-conversations-send'), event));
    expectStatus(response, 200, logs);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'employer.conversation_send', actorKind: 'employer', actorId: employer.id, subjects: [worker.id],
      records: [conversationId], resultCount: response.body.messages.length, purpose: { kind: 'job', id: job.id },
      links: false, login: 'jale_api',
    });
    expect(response.body.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('employer.conversation_update: the thread it returns after closing it is recorded', async () => {
    const s = await openWorld();
    const { employer, worker, job, conversationId } = await seed(() => conversationScene(s, 1));
    const event = sweepEvent({
      sub: employer.sub, httpMethod: 'PATCH', resource: '/employer/conversations/{conversationId}',
      pathParameters: { conversationId }, body: { status: 'closed' },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-conversations-update'), event));
    expectStatus(response, 200, logs);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'employer.conversation_update', actorKind: 'employer', actorId: employer.id, subjects: [worker.id],
      records: [conversationId], resultCount: 1, purpose: { kind: 'job', id: job.id }, links: false, login: 'jale_api',
    });
  });

  // ── Workers reading their own saved data ───────────────────────────────

  it('worker.application_defaults: the saved answers read is recorded as the worker\'s own', async () => {
    const s = await openWorld();
    const worker = await seed(async () => {
      const w = await sweepWorker(s);
      await applicationDefaults(s, w.id, { work_authorization: true });
      return w;
    });
    const event = sweepEvent({ sub: worker.sub, resource: '/worker/application-defaults' });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-application-defaults-get'), event));
    expectStatus(response, 200, logs);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'worker.application_defaults', actorKind: 'worker', actorId: worker.id, subjects: [worker.id],
      records: [], resultCount: 1, purpose: { kind: 'self' }, links: false, login: 'jale_api',
    });
  });

  it('worker.vault: the vault list read is recorded as the worker\'s own, with its link expiry', async () => {
    const s = await openWorld();
    const { worker, documentId } = await seed(async () => {
      const w = await sweepWorker(s);
      return { worker: w, documentId: await s.world.document({ workerId: w.id, jobId: null, docType: 'resume' }) };
    });
    const event = sweepEvent({ sub: worker.sub, resource: '/worker/vault' });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-documents-list'), event));
    expectStatus(response, 200, logs);
    await expectRead(s, event.requestContext.requestId, {
      surface: 'worker.vault', actorKind: 'worker', actorId: worker.id, subjects: [worker.id],
      records: [documentId], resultCount: 1, purpose: { kind: 'self' }, links: true, login: 'jale_api',
    });
  });

  // ── The application-details door on the WhatsApp engine's login ────────

  /** An applicant to a job that requires a resume, with one in the vault. */
  async function detailsScene(s: SweepScene) {
    const a = await applicantScene(s, { job: { requiredDocs: ['resume'] } });
    const vaultDocumentId = await s.world.document({ workerId: a.worker.id, jobId: null, docType: 'resume' });
    return { ...a, vaultDocumentId };
  }

  it('worker.application_details: the read is recorded, and its snapshot sync names the worker', async () => {
    const s = await openWorld();
    const { worker, job, applicationId } = await seed(() => detailsScene(s));
    const before = await lastChangeSeq(s);
    const event = sweepEvent({
      sub: worker.sub, resource: '/worker/applications/{applicationId}/details', pathParameters: { applicationId },
    });
    const response = await asLogin('jale_whatsapp', () => invoke(load('../../../lambda/api/worker-application-details'), event));
    expectStatus(response, 200, logs);
    const requestId: string = event.requestContext.requestId;
    await expectRead(s, requestId, {
      surface: 'worker.application_details', actorKind: 'worker', actorId: worker.id, subjects: [worker.id],
      records: [applicationId], resultCount: 1, purpose: { kind: 'self' }, links: false, login: 'jale_whatsapp',
    });
    // The read copied the vault resume onto the job: a covered write, named.
    expect(await count(s, `worker_documents WHERE worker_id = $1 AND job_id = $2`, [worker.id, job.id])).toBe(1);
    const changes = await changesFor(s, requestId);
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change).toEqual(expect.objectContaining({
        actor_kind: 'worker', actor_id: worker.id, channel: 'web', surface: 'worker.application_details',
        request_id: requestId, context_status: 'set', db_login: 'jale_whatsapp',
      }));
    }
    expect(changes.map((change) => change.table_name)).toContain('public.worker_documents');
    const { rows: [{ n: unnamed }] } = await s.world.su.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jale_audit.changes
        WHERE seq > $1::bigint AND context_status <> 'set' AND subject_user_ids && $2::uuid[]`,
      [before, [worker.id]],
    );
    expect(unnamed).toBe(0);
  });

  it('worker.application_details refused merge: the state goes out with exactly one read record, and none of the merge\'s writes stay', async () => {
    const s = await openWorld();
    const { worker, job, applicationId } = await seed(() => detailsScene(s));
    const answers = async () => (await s.world.su.query(
      `SELECT application_answers, prompt_answers FROM job_applications WHERE id = $1`, [applicationId])).rows;
    const answersBefore = await answers();
    const before = await lastChangeSeq(s);
    const event = sweepEvent({
      sub: worker.sub, httpMethod: 'POST', resource: '/worker/applications/{applicationId}/details/{action}',
      pathParameters: { applicationId, action: 'answers' }, body: { answers: { years_experience: 7 } },
    });
    const response = await asLogin('jale_whatsapp', () => invoke(load('../../../lambda/api/worker-application-details'), event));
    expectStatus(response, 409, logs);
    // A new application is still in the apply stage, so the details merge is
    // refused; the refusal carries the state, built after the rollback to the
    // write savepoint, in the same transaction.
    expect(response.body.error).toBe('stage_locked');
    expect(response.body.state.application.id).toBe(applicationId);
    const requestId: string = event.requestContext.requestId;
    // Exactly one read record, for the state that went out.
    await expectRead(s, requestId, {
      surface: 'worker.application_details', actorKind: 'worker', actorId: worker.id, subjects: [worker.id],
      records: [applicationId], resultCount: 1, purpose: { kind: 'self' }, links: false, login: 'jale_whatsapp',
    });
    // The snapshot sync and the refused merge were rolled back: no job copy,
    // unchanged answers, and no change record from this request.
    expect(await count(s, `worker_documents WHERE worker_id = $1 AND job_id = $2`, [worker.id, job.id])).toBe(0);
    expect(await answers()).toEqual(answersBefore);
    expect(await changesFor(s, requestId)).toEqual([]);
    expect(await changesSince(s, before, 'public.worker_documents', [worker.id])).toBe(0);
    expect(await changesSince(s, before, 'public.job_applications', [applicationId])).toBe(0);
  });

  it('drives every registered access surface', () => {
    expect(sorted([...driven])).toEqual(sorted(Object.keys(ACCESS_SURFACES)));
  });
});

if (!databaseUrl) {
  test('CONCERN: the access records DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
