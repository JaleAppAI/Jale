/**
 * d-app-change-context.integration.test.ts
 *
 * The change records name the actor the request states before
 * its first covered write. Each test drives a real web entry point on
 * its real login against a real PostgreSQL bed and reads back the
 * jale_audit.changes rows its request id produced:
 *
 *   - profile saves by a worker and by an employer name them by users.id;
 *   - entry points that write in a second transaction (a vault upload
 *     confirm, a new post) and a delete that reaches covered rows only
 *     through a cascade (a job) name their actor too;
 *   - a document upload link's holder (confirm and submit), a worker signing
 *     up on the web and a confirmed sign-up are named by kind alone: actor
 *     id NULL, the context still `set`;
 *   - an update that changes no covered column (an application's status)
 *     leaves no change record at all, which is the rule the static writer
 *     check (test/unit/lambda/audit-writers.test.ts) is built on.
 *
 * Every test also checks that its request left no change record without a
 * context (`unset` or `invalid`) on the subjects it touched, so a covered
 * write outside the stated context would fail it.
 *
 * Stand-ins: Cognito, SQS, S3 and image moderation answer from a recording
 * client; any other AWS call or network request fails the test. Fixtures: r-paths-world.ts
 * and r-paths-sweep-fixtures.ts, unchanged.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import { fakePhone, FIXTURE_TOS_VERSION } from './r-paths-world';
import { describeInProfiles, loginUrl } from './helpers/login-pool';
import {
  closeScene, count, createdSub, expectStatus, invoke, LogCapture, openScene, run, seed, sweepEmployer, sweepEvent,
  sweepJob, sweepWorker, SWEEP_NAME, type SweepScene,
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
process.env.WORKER_POOL_ID = 'fixture-worker-pool';
process.env.DLQ_URL = 'https://fixture.invalid/queue/post-confirmation-dlq';

// ── The database: each handler gets a checked pool on its real login ───────
let mockCurrentPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return {
    ...actual,
    getDbPool: async () => {
      if (!mockCurrentPool) throw new Error('change context: no login pool is open');
      return mockCurrentPool;
    },
  };
});

// ── AWS SDK clients: the real Command classes, a recording client ──────────
type SentCommand = { constructor: { name: string }; input?: any };

/** The account sub the sign-up stand-in reports for the user it "created". */
let signupSub = '';

/** S3 HeadObject: an encrypted, versioned 2 KiB object typed by its key's extension. */
function headObject(key: string): Record<string, unknown> {
  const contentType = key.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
  return { ContentLength: 2048, ContentType: contentType, ServerSideEncryption: 'AES256', VersionId: 'fixture-version-1' };
}

const mockAwsSend = jest.fn(async (service: string, command: SentCommand): Promise<unknown> => {
  switch (`${service}:${command.constructor.name}`) {
    case 's3:HeadObjectCommand': return headObject(String(command.input?.Key));
    case 'rekognition:DetectModerationLabelsCommand': return { ModerationLabels: [] };
    case 'sqs:SendMessageCommand': return { MessageId: `fixture-message-${randomUUID()}` };
    case 'cognito:AdminCreateUserCommand': return {};
    case 'cognito:AdminGetUserCommand': return { Username: 'fixture', UserAttributes: [{ Name: 'sub', Value: signupSub }] };
    case 'cognito:AdminAddUserToGroupCommand': return {};
    case 'cognito:AdminSetUserPasswordCommand': return {};
    default: throw new Error(`change context: unexpected AWS call ${service}:${command.constructor.name}`);
  }
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
jest.mock('@aws-sdk/client-rekognition', () => mockSdkModule('@aws-sdk/client-rekognition', 'RekognitionClient', 'rekognition'));
jest.mock('@aws-sdk/client-cognito-identity-provider', () =>
  mockSdkModule('@aws-sdk/client-cognito-identity-provider', 'CognitoIdentityProviderClient', 'cognito'));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async () => 'https://fixture.invalid/presigned/object',
}));

type Handler = (event?: any, context?: any) => Promise<any>;

/** Handlers load lazily, so a module that fails at import fails one test. */
function load(modulePath: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath).handler;
}

interface ChangeRow {
  table_name: string;
  operation: string;
  record_ids: string[];
  subject_user_ids: string[];
  changed_fields: string[];
  actor_kind: string | null;
  actor_id: string | null;
  channel: string | null;
  surface: string | null;
  request_id: string | null;
  context_status: string;
  db_login: string;
}

async function changesFor(s: SweepScene, requestId: string): Promise<ChangeRow[]> {
  const { rows } = await s.world.su.query<ChangeRow>(
    `SELECT table_name, operation, record_ids::text[] AS record_ids, subject_user_ids::text[] AS subject_user_ids,
            changed_fields::text[] AS changed_fields, actor_kind, actor_id::text AS actor_id, channel, surface,
            request_id, context_status, db_login::text AS db_login
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

/** Change rows of any context written after `seq` on `table` for any of `ids`, as record or subject. */
async function changesSince(s: SweepScene, seq: string, table: string, ids: string[]): Promise<number> {
  const { rows } = await s.world.su.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jale_audit.changes
      WHERE seq > $1::bigint AND table_name = $2
        AND (record_ids && $3::uuid[] OR subject_user_ids && $3::uuid[])`,
    [seq, table, ids],
  );
  return rows[0].n;
}

/** Change rows without a context (`unset` or `invalid`) written after `seq` about any of `subjects`. */
async function unnamedSince(s: SweepScene, seq: string, subjects: string[]): Promise<number> {
  const { rows } = await s.world.su.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jale_audit.changes
      WHERE seq > $1::bigint AND context_status <> 'set' AND subject_user_ids && $2::uuid[]`,
    [seq, subjects],
  );
  return rows[0].n;
}

/** Every change row of the request names `actor` and its context; returns the tables written. */
function expectNamed(changes: ChangeRow[], actor: {
  kind: string; id: string | null; channel: string; surface: string; requestId: string; login: string;
}): string[] {
  expect(changes.length).toBeGreaterThan(0);
  for (const change of changes) {
    expect(change).toEqual(expect.objectContaining({
      actor_kind: actor.kind,
      actor_id: actor.id,
      channel: actor.channel,
      surface: actor.surface,
      request_id: actor.requestId,
      context_status: 'set',
      db_login: actor.login,
    }));
  }
  return [...new Set(changes.map((change) => change.table_name))].sort();
}

describeInProfiles(['request', 'owner-unrestricted'], 'change records name the request\'s actor', () => {
  let scene: SweepScene | undefined;
  let logs: LogCapture;
  let fetchSpy: jest.SpyInstance;

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

  beforeEach(() => {
    mockAwsSend.mockClear();
    signupSub = '';
    logs = new LogCapture();
    logs.start();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('change context: unexpected network call');
    }) as typeof fetch);
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    logs.stop();
    const closing = scene;
    scene = undefined;
    await closeScene(closing);
  });

  // ── Signed-in actors, named by users.id ────────────────────────────────

  it('a worker\'s profile save names the worker in every change record it writes', async () => {
    const s = await openWorld();
    const worker = await seed(() => sweepWorker(s));
    const before = await lastChangeSeq(s);
    const event = sweepEvent({
      sub: worker.sub, httpMethod: 'PATCH', resource: '/worker/profile',
      body: { full_name: `${SWEEP_NAME} Worker Saved`, skills: ['framing'], availability: 'full_time', bio: 'Fixture bio' },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-profile-update'), event));
    expectStatus(response, 200, logs);
    const tables = expectNamed(await changesFor(s, event.requestContext.requestId), {
      kind: 'worker', id: worker.id, channel: 'web', surface: 'worker.profile_update',
      requestId: event.requestContext.requestId, login: 'jale_api',
    });
    expect(tables).toEqual(expect.arrayContaining(['public.users', 'public.worker_profiles', 'public.worker_skills']));
    expect(await unnamedSince(s, before, [worker.id])).toBe(0);
  });

  it('an employer\'s profile save names the employer in every change record it writes', async () => {
    const s = await openWorld();
    const employer = await seed(() => sweepEmployer(s));
    const before = await lastChangeSeq(s);
    const event = sweepEvent({
      sub: employer.sub, httpMethod: 'PATCH', resource: '/employer/profile',
      body: { company_name: `${SWEEP_NAME} Saved Co`, city: 'Fixture City' },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-profile'), event));
    expectStatus(response, 200, logs);
    const tables = expectNamed(await changesFor(s, event.requestContext.requestId), {
      kind: 'employer', id: employer.id, channel: 'web', surface: 'employer.profile_update',
      requestId: event.requestContext.requestId, login: 'jale_api',
    });
    expect(tables).toEqual(expect.arrayContaining(['public.users', 'public.employer_profiles']));
    expect(await unnamedSince(s, before, [employer.id])).toBe(0);
  });

  it('a vault upload confirm, written in its second transaction, names the worker', async () => {
    const s = await openWorld();
    const worker = await seed(() => sweepWorker(s));
    const before = await lastChangeSeq(s);
    const s3Key = `documents/vault/${worker.id}/resume/${randomUUID()}.pdf`;
    const event = sweepEvent({
      sub: worker.sub, httpMethod: 'POST', resource: '/worker/vault/{doc_type}', pathParameters: { doc_type: 'confirm' },
      body: { s3_key: s3Key, doc_type: 'resume', file_name: 'resume.pdf', file_size: 2048, mime_type: 'application/pdf' },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-vault-dispatch'), event));
    expectStatus(response, 201, logs);
    const tables = expectNamed(await changesFor(s, event.requestContext.requestId), {
      kind: 'worker', id: worker.id, channel: 'web', surface: 'worker.document_confirm',
      requestId: event.requestContext.requestId, login: 'jale_api',
    });
    expect(tables).toEqual(['public.worker_documents']);
    expect(await unnamedSince(s, before, [worker.id])).toBe(0);
  });

  it('a new post, written in its second transaction, names the worker', async () => {
    const s = await openWorld();
    const worker = await seed(() => sweepWorker(s));
    const before = await lastChangeSeq(s);
    const postId = randomUUID();
    const event = sweepEvent({
      sub: worker.sub, httpMethod: 'POST', resource: '/worker/posts',
      body: { post_id: postId, caption: 'Fixture caption', items: [{ s3_key: `${worker.id}/posts/${postId}/${randomUUID()}.jpg`, sort_order: 0 }] },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-post-create'), event));
    expectStatus(response, 201, logs);
    const tables = expectNamed(await changesFor(s, event.requestContext.requestId), {
      kind: 'worker', id: worker.id, channel: 'web', surface: 'worker.post_create',
      requestId: event.requestContext.requestId, login: 'jale_api',
    });
    expect(tables).toEqual(['public.worker_post_media', 'public.worker_posts']);
    expect(await unnamedSince(s, before, [worker.id])).toBe(0);
  });

  it('a job delete, which reaches covered rows only through its cascade, names the employer', async () => {
    const s = await openWorld();
    const { employer, worker, job, applicationId } = await seed(async () => {
      const e = await sweepEmployer(s);
      const w = await sweepWorker(s);
      const j = await sweepJob(s, e.id);
      return { employer: e, worker: w, job: j, applicationId: await s.world.application(j.id, w.id) };
    });
    const before = await lastChangeSeq(s);
    const event = sweepEvent({
      sub: employer.sub, httpMethod: 'DELETE', resource: '/employer/jobs/{jobId}', pathParameters: { jobId: job.id },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-jobs-delete'), event));
    expectStatus(response, 200, logs);
    const changes = await changesFor(s, event.requestContext.requestId);
    const tables = expectNamed(changes, {
      kind: 'employer', id: employer.id, channel: 'web', surface: 'employer.job_delete',
      requestId: event.requestContext.requestId, login: 'jale_api',
    });
    expect(tables).toContain('public.job_applications');
    expect(changes.some((change) => change.operation === 'delete' && change.record_ids.includes(applicationId))).toBe(true);
    expect(await unnamedSince(s, before, [worker.id, employer.id])).toBe(0);
  });

  // ── Actors without an id: named by kind, the context still set ─────────

  /** An applicant to a job that requires a resume, holding an upload link for it. */
  async function linkScene(s: SweepScene, slot: { confirmed: boolean }) {
    const employer = await sweepEmployer(s);
    const worker = await sweepWorker(s);
    const job = await sweepJob(s, employer.id, { requiredDocs: ['resume'] });
    await s.world.application(job.id, worker.id);
    const token = await s.world.uploadToken({ jobId: job.id, workerId: worker.id });
    const s3Key = await s.world.uploadSlot(token.hash, {
      docType: 'resume', s3Key: `documents/${job.id}/${worker.id}/resume/${randomUUID()}.pdf`, confirmed: slot.confirmed,
    });
    return { worker, job, token, s3Key };
  }

  it('a document link holder\'s upload confirm names a token holder with no id', async () => {
    const s = await openWorld();
    const { worker, job, token, s3Key } = await seed(() => linkScene(s, { confirmed: false }));
    const before = await lastChangeSeq(s);
    const event = sweepEvent({
      httpMethod: 'POST', resource: '/worker/documents/{action}', pathParameters: { action: 'confirm' },
      body: { token: token.raw, s3_key: s3Key, doc_type: 'resume', file_name: 'resume.pdf', file_size: 2048, mime_type: 'application/pdf' },
    });
    const response = await asLogin('jale_api_public', () => invoke(load('../../../lambda/api/worker-documents-dispatch'), event));
    expectStatus(response, 200, logs);
    const tables = expectNamed(await changesFor(s, event.requestContext.requestId), {
      kind: 'token_holder', id: null, channel: 'web', surface: 'token_holder.document_confirm',
      requestId: event.requestContext.requestId, login: 'jale_api_public',
    });
    expect(tables).toContain('public.worker_documents');
    expect(await count(s, `worker_documents WHERE worker_id = $1 AND job_id = $2 AND s3_key = $3`, [worker.id, job.id, s3Key])).toBe(1);
    expect(await unnamedSince(s, before, [worker.id])).toBe(0);
  });

  it('a document link holder\'s submit names a token holder with no id', async () => {
    const s = await openWorld();
    const { worker, token } = await seed(() => linkScene(s, { confirmed: true }));
    const before = await lastChangeSeq(s);
    const event = sweepEvent({
      httpMethod: 'POST', resource: '/worker/documents/{action}', pathParameters: { action: 'submit' }, body: { token: token.raw },
    });
    const response = await asLogin('jale_api_public', () => invoke(load('../../../lambda/api/worker-documents-dispatch'), event));
    expectStatus(response, 200, logs);
    const changes = await changesFor(s, event.requestContext.requestId);
    const tables = expectNamed(changes, {
      kind: 'token_holder', id: null, channel: 'web', surface: 'token_holder.document_submit',
      requestId: event.requestContext.requestId, login: 'jale_api_public',
    });
    expect(tables).toEqual(['public.document_upload_tokens']);
    // The token hash is a credential: the record names the worker, never the token.
    expect(changes[0].subject_user_ids).toEqual([worker.id]);
    expect(changes[0].record_ids).toEqual([]);
    expect(await unnamedSince(s, before, [worker.id])).toBe(0);
  });

  it('a web sign-up names an anonymous actor with no id', async () => {
    const s = await openWorld();
    signupSub = createdSub(s, 'signup');
    const before = await lastChangeSeq(s);
    const event = sweepEvent({ httpMethod: 'POST', resource: '/auth/worker/signup', body: { phone: fakePhone() } });
    const response = await asLogin('jale_api_public', () => invoke(load('../../../lambda/auth/worker-web-signup'), event));
    expectStatus(response, 200, logs);
    const tables = expectNamed(await changesFor(s, event.requestContext.requestId), {
      kind: 'anonymous', id: null, channel: 'web', surface: 'auth.worker_web_signup',
      requestId: event.requestContext.requestId, login: 'jale_api_public',
    });
    expect(tables).toEqual(['public.users']);
    const { rows: [account] } = await s.world.su.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub = $1`, [signupSub]);
    expect(account).toBeDefined();
    expect(await unnamedSince(s, before, [account.id])).toBe(0);
  });

  it('a confirmed sign-up names an anonymous actor with no id, by the invocation id', async () => {
    const s = await openWorld();
    const sub = createdSub(s, 'confirm');
    const before = await lastChangeSeq(s);
    const invocationId = randomUUID();
    const event = {
      version: '1',
      triggerSource: 'PostConfirmation_ConfirmSignUp',
      region: 'fixture-region',
      userPoolId: 'fixture-employer-pool',
      userName: sub,
      callerContext: { awsSdkVersion: 'fixture', clientId: 'fixture-client' },
      request: {
        userAttributes: { sub, 'custom:user_type': 'employer', email: `${sub}@fixture.invalid`, name: `${SWEEP_NAME} Employer` },
      },
      response: {},
    };
    const result = await asLogin('jale_api', () => run(
      () => load('../../../lambda/post-confirmation/index')(event, { awsRequestId: invocationId }), logs));
    expect(result).toBe(event);
    const tables = expectNamed(await changesFor(s, invocationId), {
      kind: 'anonymous', id: null, channel: 'web', surface: 'auth.post_confirmation', requestId: invocationId, login: 'jale_api',
    });
    expect(tables).toEqual(['public.users']);
    const { rows: [account] } = await s.world.su.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub = $1`, [sub]);
    expect(account).toBeDefined();
    expect(await unnamedSince(s, before, [account.id])).toBe(0);
  });

  // ── A write of no covered column leaves no change record ───────────────

  it('an application status change writes the status and leaves no change record', async () => {
    const s = await openWorld();
    const { employer, worker, job, applicationId } = await seed(async () => {
      const e = await sweepEmployer(s);
      const w = await sweepWorker(s, { whatsappNumber: fakePhone(), lifecycle: 'onboarding', workflowLanguage: 'es' });
      const j = await sweepJob(s, e.id);
      return { employer: e, worker: w, job: j, applicationId: await s.world.application(j.id, w.id) };
    });
    const before = await lastChangeSeq(s);
    const event = sweepEvent({
      sub: employer.sub, httpMethod: 'PATCH', resource: '/employer/jobs/{jobId}/applicants/{workerId}',
      pathParameters: { jobId: job.id, workerId: worker.id }, body: { status: 'details_requested' },
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-application-status-update'), event));
    expectStatus(response, 200, logs);
    expect(await count(s, `job_applications WHERE id = $1 AND status = 'details_requested'`, [applicationId])).toBe(1);
    expect(await changesSince(s, before, 'public.job_applications', [applicationId])).toBe(0);
    expect(await changesFor(s, event.requestContext.requestId)).toEqual([]);
  });
});

if (!databaseUrl) {
  test('CONCERN: the change context DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
