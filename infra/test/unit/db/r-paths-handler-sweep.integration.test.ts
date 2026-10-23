/**
 * r-paths-handler-sweep.integration.test.ts
 *
 * Every Lambda that uses the shared application login
 * today, driven end to end on the dedicated least-privilege login it moves
 * to. Each exported handler is called with a realistic event against seeded
 * data on a real PostgreSQL bed; AWS, Stripe, Twilio and Google are replaced
 * by in-process stand-ins, the database is real. Each test asserts the
 * expected status (or the job's summary) plus at least one durable effect
 * read back through the superuser, or a non-empty body built from seeded
 * rows. The pool is the real boot path: createCheckedPool, which runs the
 * login's identity and posture check before serving anything.
 *
 * Handlers covered, with the login each test connects as (55 Lambdas, 62
 * tests: one per handler, one per route for dispatchers and GET/PATCH pairs):
 *
 *   jale_api, dual (worker or employer):
 *     PayReferenceLambda, AcceptTosLambda
 *   jale_api, worker:
 *     WorkerProfileLambda, WorkerApplicationDefaultsGetLambda,
 *     WorkerJobsListLambda, WorkerJobsDetailLambda, WorkerJobsApplyLambda,
 *     WorkerApplicationsListLambda, WorkerProfileUpdateLambda,
 *     WorkerVaultDispatch (upload-url, confirm), WorkerDocumentsList,
 *     WorkerDocDelete, WorkerPostsDispatch (upload-urls), WorkerPostCreate,
 *     WorkerPostsList, WorkerPostDelete, WorkerJobShareLambda,
 *     WorkerReferralClaimLambda
 *   jale_api, employer:
 *     EmployerDigestSettingsLambda (GET, PATCH), EmployerProfileLambda (GET,
 *     PATCH), EmployerJobsListLambda, EmployerJobsCreateLambda,
 *     EmployerJobsDetailLambda, EmployerJobsUpdateLambda,
 *     EmployerJobsDeleteLambda, EmployerJobApplicantsLambda,
 *     EmployerApplicationStatusUpdateLambda, EmployerConversationsListLambda,
 *     EmployerConversationsDetailLambda, EmployerConversationsCreateLambda,
 *     EmployerConversationsSendLambda, EmployerConversationsUpdateLambda,
 *     EmployerConversationsReadLambda, EmployerInboxLambda,
 *     EmployerApplicantsOverviewLambda, EmployerTemplatesListLambda,
 *     EmployerTemplatesSaveLambda, EmployerTemplatesDeleteLambda,
 *     EmployerJobCandidatesLambda, GetBillingLambda, CheckoutLambda,
 *     PortalLambda, EmployerUploadToken, EmployerWorkerDetail (profile,
 *     documents, posts), EmployerJobPublicListingLambda,
 *     EmployerJobShareLambda
 *   jale_api, Cognito trigger:
 *     PostConfirmationLambda
 *   jale_api_public (unauthenticated):
 *     WorkerWebSignupLambda, WorkerDocumentsDispatch (upload-url, confirm,
 *     submit), DigestUnsubscribeLambda
 *   jobs:
 *     EmailOutboxSweeperLambda        on jale_job_email_sender
 *     VisibilityOutboxDrainLambda     on jale_job_visibility_drain
 *     EmployerDigestProducerLambda    on jale_job_digest
 *     SesFeedbackHandlerLambda        on jale_job_ses_feedback
 *     ReferralRetentionSweeperLambda  on jale_job_retention
 *
 * Exclusions: none. Every listed handler runs this way. The visibility
 * drain's signed service-account assertion uses an RSA key generated per run,
 * and its two Google endpoints are answered by a stand-in for fetch.
 *
 * Out of scope: Lambdas that already run on a dedicated service login (the
 * public job pages, the billing processor, matching, the WhatsApp engine and
 * the two web doors it serves) and the Lambdas with no database access. Each
 * keeps its own suites.
 *
 * Stand-ins, so the only network traffic is to the local bed:
 *   - AWS SDK: the real Command classes with a recording client; the presigner
 *     returns a fixed URL. Secrets Manager, DynamoDB, Bedrock and Step
 *     Functions answer with an error, so an unplanned call fails the test.
 *   - Whole modules for secrets and providers: lib/unsubscribe-secret,
 *     lib/google-indexing-secret, lib/stripe-client, and the WhatsApp sender
 *     (whatsapp/lib/outbox sendTwilioWhatsAppMessage). No secret material.
 *   - fetch fails unless the drain test installs answers for its two calls.
 *
 * The five jobs act on every eligible row of the bed, not only this suite's,
 * so their tests seed rows that sort first and assert on those rows alone.
 *
 * Fixtures: r-paths-world.ts and r-paths-sweep-fixtures.ts. Every account,
 * job and reference row carries a `Fixture Sweep` / `fixture-sweep-` marker,
 * and each test removes everything it seeded or caused, children first.
 * A seeding error reads SEED FAILED and a cleanup error CLEANUP FAILED; any
 * other failure is the handler on its login, with the handler's own log
 * appended to the message.
 */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import { fakePhone, FIXTURE_TOS_VERSION } from './r-paths-world';
import { describeInProfiles, loginUrl } from './helpers/login-pool';
import {
  applicationDefaults, applyToken, billingCustomer, closeScene, count, createdSub, digestSettings,
  emailOutbox, expectStatus, expectThat, invoke, jobTemplate, LogCapture, openScene, pendingClaim, run,
  seed, setTosVersion, shareOpen, subscription, sweepEmployer, sweepEvent, sweepJob, sweepWorker,
  SWEEP_NAME, SWEEP_SUB_PREFIX, type SweepScene, visibilityEvent, wageReference, workerPost,
  zoneAwayFromHourBoundary,
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
process.env.EMAIL_FROM_ADDRESS = 'no-reply@fixture.invalid';
process.env.WORKER_POOL_ID = 'fixture-worker-pool';
process.env.EMPLOYER_CANDIDATE_RERANK_QUEUE_URL = 'https://fixture.invalid/queue/candidate-rerank';
process.env.DLQ_URL = 'https://fixture.invalid/queue/post-confirmation-dlq';

const RETURN_URL_BASE = 'http://localhost:3000/en/employer/billing';

// ── The database: each handler gets a checked pool on its future login ─────
let mockCurrentPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return {
    ...actual,
    getDbPool: async () => {
      if (!mockCurrentPool) throw new Error('handler sweep: no login pool is open');
      return mockCurrentPool;
    },
  };
});

// ── AWS SDK clients: the real Command classes, a recording client ──────────
type SentCommand = { constructor: { name: string }; input?: any };
const mockAwsSend = jest.fn(async (service: string, command: SentCommand): Promise<unknown> => awsResponse(service, command));

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
jest.mock('@aws-sdk/client-lambda', () => mockSdkModule('@aws-sdk/client-lambda', 'LambdaClient', 'lambda'));
jest.mock('@aws-sdk/client-sesv2', () => mockSdkModule('@aws-sdk/client-sesv2', 'SESv2Client', 'ses'));
jest.mock('@aws-sdk/client-cognito-identity-provider', () =>
  mockSdkModule('@aws-sdk/client-cognito-identity-provider', 'CognitoIdentityProviderClient', 'cognito'));
jest.mock('@aws-sdk/client-secrets-manager', () =>
  mockSdkModule('@aws-sdk/client-secrets-manager', 'SecretsManagerClient', 'secrets'));
jest.mock('@aws-sdk/client-rekognition', () => mockSdkModule('@aws-sdk/client-rekognition', 'RekognitionClient', 'rekognition'));
jest.mock('@aws-sdk/client-dynamodb', () => mockSdkModule('@aws-sdk/client-dynamodb', 'DynamoDBClient', 'dynamodb'));
jest.mock('@aws-sdk/client-bedrock-runtime', () =>
  mockSdkModule('@aws-sdk/client-bedrock-runtime', 'BedrockRuntimeClient', 'bedrock'));
jest.mock('@aws-sdk/client-sfn', () => mockSdkModule('@aws-sdk/client-sfn', 'SFNClient', 'sfn'));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_client: unknown, command: SentCommand) =>
    `https://fixture.invalid/presigned/${encodeURIComponent(String(command.input?.Key ?? ''))}`,
}));

/** The account sub the sign-up stand-in reports for the user it "created". */
let signupSub = '';

/** S3 HeadObject: an encrypted, versioned 2 KiB object typed by its key's extension. */
function headObject(key: string): Record<string, unknown> {
  const contentType = key.endsWith('.pdf') ? 'application/pdf'
    : key.endsWith('.png') ? 'image/png'
      : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return { ContentLength: 2048, ContentType: contentType, ServerSideEncryption: 'AES256', VersionId: 'fixture-version-1' };
}

async function awsResponse(service: string, command: SentCommand): Promise<unknown> {
  const name = command.constructor.name;
  switch (`${service}:${name}`) {
    case 's3:HeadObjectCommand': return headObject(String(command.input?.Key));
    case 's3:DeleteObjectCommand': return {};
    case 'sqs:SendMessageCommand': return { MessageId: `fixture-message-${randomUUID()}` };
    case 'lambda:InvokeCommand': return { StatusCode: 202 };
    case 'ses:SendEmailCommand': return { MessageId: `fixture-ses-${randomUUID()}` };
    case 'rekognition:DetectModerationLabelsCommand': return { ModerationLabels: [] };
    case 'cognito:AdminCreateUserCommand': return {};
    case 'cognito:AdminGetUserCommand': return { Username: 'fixture', UserAttributes: [{ Name: 'sub', Value: signupSub }] };
    case 'cognito:AdminAddUserToGroupCommand': return {};
    case 'cognito:AdminSetUserPasswordCommand': return {};
    default: throw new Error(`handler sweep: unexpected AWS call ${service}:${name}`);
  }
}

function awsCalls(service: string, commandName: string): SentCommand[] {
  return mockAwsSend.mock.calls
    .filter(([s, command]) => s === service && command.constructor.name === commandName)
    .map(([, command]) => command);
}

// ── Secrets, providers and messaging: whole modules, never secret material ─
jest.mock('../../../lambda/lib/unsubscribe-secret', () => ({
  getUnsubscribeSecret: async () => 'fixture-unsubscribe-signing-key',
  clearUnsubscribeSecretCache: () => undefined,
}));

let mockIndexingPem: string | undefined;
function mockIndexingKey(): { client_email: string; private_key: string } {
  // Generated per run and never stored: the drain signs a real RS256 assertion.
  mockIndexingPem ??= generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  return { client_email: 'fixture-indexer@fixture.invalid', private_key: mockIndexingPem };
}
jest.mock('../../../lambda/lib/google-indexing-secret', () => ({
  getGoogleIndexingServiceAccountKey: async () => mockIndexingKey(),
  clearGoogleIndexingSecretCache: () => undefined,
}));

const mockStripe = {
  customers: { create: jest.fn(async () => ({ id: `fixture-customer-${randomUUID()}` })) },
  checkout: {
    sessions: {
      create: jest.fn(async () => ({
        id: `fixture-session-${randomUUID()}`,
        url: 'https://fixture.invalid/checkout/session',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      })),
    },
  },
  billingPortal: {
    sessions: {
      create: jest.fn(async (params: { customer: string }) => ({ url: `https://fixture.invalid/portal/${params.customer}` })),
    },
  },
};
jest.mock('../../../lambda/lib/stripe-client', () => {
  const actual = jest.requireActual('../../../lambda/lib/stripe-client');
  return {
    ...actual,
    getStripeSecret: async () => ({
      secretKey: 'fixture-stripe-key',
      priceIdEmployerPro: 'fixture-price-pro',
      portalConfigurationId: 'fixture-portal-configuration',
    }),
    getStripe: async () => mockStripe,
  };
});

const mockWhatsAppSends: Array<{ to: string; template: string | null; body: string | null }> = [];
jest.mock('../../../lambda/whatsapp/lib/outbox', () => {
  const actual = jest.requireActual('../../../lambda/whatsapp/lib/outbox');
  return {
    ...actual,
    sendTwilioWhatsAppMessage: jest.fn(async (to: string, row: { body: string | null; content_template: string | null }) => {
      mockWhatsAppSends.push({ to, template: row.content_template, body: row.body });
      return `fixture-sid-${randomUUID()}`;
    }),
  };
});

type Handler = (event?: any) => Promise<any>;

/** Handlers load lazily, so a module that fails at import fails one test. */
function load(modulePath: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath).handler;
}

const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

if (!databaseUrl) {
  test('CONCERN: the handler sweep DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

describeInProfiles(['request', 'owner-unrestricted'], 'handler sweep: every listed Lambda on its dedicated login', () => {
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

  beforeEach(() => {
    mockAwsSend.mockClear();
    mockWhatsAppSends.length = 0;
    signupSub = '';
    logs = new LogCapture();
    logs.start();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('handler sweep: unexpected network call');
    }) as typeof fetch);
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    logs.stop();
    const closing = scene;
    scene = undefined;
    await closeScene(closing);
  });

  // ── jale_api: dual ───────────────────────────────────────────────────

  it('PayReferenceLambda on jale_api: 200 with the seeded metro wage reference', async () => {
    const s = await openWorld();
    const { worker, area } = await seed(async () => ({ worker: await sweepWorker(s), area: await wageReference(s, 'carpenter') }));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/pay-reference'), sweepEvent({
      sub: worker.sub, resource: '/pay-reference', queryStringParameters: { trade: 'carpenter', city_key: area.cityKey },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({
      trade_category: 'carpenter', p25_hourly: area.p25, p50_hourly: area.p50, p75_hourly: area.p75,
      area_kind: 'metro', area_label: 'Fixture Metro', source_tier: 'metro', data_vintage: 'fixture-vintage',
    });
  });

  it('AcceptTosLambda on jale_api: 200, the accepted version and two consent rows are stored', async () => {
    const s = await openWorld();
    const worker = await seed(async () => {
      const w = await sweepWorker(s);
      await setTosVersion(s, w.id, null);
      return w;
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/legal/accept-tos'), sweepEvent({
      sub: worker.sub, httpMethod: 'POST', resource: '/legal/accept', body: { tosVersion: FIXTURE_TOS_VERSION },
      headers: { 'User-Agent': 'fixture-agent' },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ accepted: true, version: FIXTURE_TOS_VERSION });
    const { rows: user } = await s.world.su.query(`SELECT tos_version, privacy_version FROM users WHERE id = $1`, [worker.id]);
    expect(user).toEqual([{ tos_version: FIXTURE_TOS_VERSION, privacy_version: FIXTURE_TOS_VERSION }]);
    const { rows: consents } = await s.world.su.query(
      `SELECT document_type FROM legal_consent_log WHERE user_id = $1 ORDER BY document_type`, [worker.id],
    );
    expect(consents).toEqual([{ document_type: 'privacy' }, { document_type: 'tos' }]);
  });

  // ── jale_api: worker ─────────────────────────────────────────────────

  it('WorkerProfileLambda on jale_api: 200 with the worker\'s own profile', async () => {
    const s = await openWorld();
    const worker = await seed(async () => {
      const w = await sweepWorker(s);
      await s.world.workerProfile(w.id, { location: 'Fixture City' });
      return w;
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-profile'), sweepEvent({
      sub: worker.sub, resource: '/worker/profile',
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual(expect.objectContaining({
      id: worker.id, user_type: 'worker', full_name: `${SWEEP_NAME} Worker`, location: 'Fixture City',
    }));
  });

  it('WorkerApplicationDefaultsGetLambda on jale_api: 200 with the stored reusable answers only', async () => {
    const s = await openWorld();
    const worker = await seed(async () => {
      const w = await sweepWorker(s);
      await applicationDefaults(s, w.id, { work_authorization: true, date_available: '2026-11-02' });
      return w;
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-application-defaults-get'), sweepEvent({
      sub: worker.sub, resource: '/worker/application-defaults',
    })));
    expectStatus(response, 200, logs);
    expect(response.body.answers).toEqual({ work_authorization: true });
    expect(response.body.updated_at).toEqual(expect.any(String));
  });

  it('WorkerJobsListLambda on jale_api: 200 listing the seeded active job', async () => {
    const s = await openWorld();
    const { worker, job } = await seed(async () => {
      const employer = await sweepEmployer(s);
      return { worker: await sweepWorker(s), job: await sweepJob(s, employer.id) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-jobs-list'), sweepEvent({
      sub: worker.sub, resource: '/worker/jobs',
    })));
    expectStatus(response, 200, logs);
    // The feed's company is the job's own `company` column with a 'Jale'
    // fallback (lib/job-matching.ts). The World leaves it unset, as the
    // employer create path does, so the fallback is what the worker sees.
    expect(response.body.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: job.id, title: `${SWEEP_NAME} Job`, company: 'Jale', company_name: 'Jale' }),
    ]));
  });

  it('WorkerJobsDetailLambda on jale_api: 200 with the job and the worker\'s application', async () => {
    const s = await openWorld();
    const { worker, job, applicationId } = await seed(() => applicantScene(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-jobs-detail'), sweepEvent({
      sub: worker.sub, resource: '/worker/jobs/{jobId}', pathParameters: { jobId: job.id },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual(expect.objectContaining({
      id: job.id, title: `${SWEEP_NAME} Job`, company_name: `${SWEEP_NAME} Co`,
      already_applied: true, application_status: 'pending', application_id: applicationId,
    }));
  });

  it('WorkerJobsApplyLambda on jale_api: 201 and an application row', async () => {
    const s = await openWorld();
    const { worker, job } = await seed(async () => {
      const employer = await sweepEmployer(s);
      return { worker: await sweepWorker(s), job: await sweepJob(s, employer.id) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-jobs-apply'), sweepEvent({
      sub: worker.sub, httpMethod: 'POST', resource: '/worker/jobs/{jobId}/apply',
      pathParameters: { jobId: job.id }, body: {},
    })));
    expectStatus(response, 201, logs);
    expect(response.body).toEqual(expect.objectContaining({ job_id: job.id, status: 'pending' }));
    expect(await count(s, `job_applications WHERE job_id = $1 AND worker_id = $2 AND status = 'pending'`, [job.id, worker.id])).toBe(1);
  });

  it('WorkerApplicationsListLambda on jale_api: 200 listing the worker\'s application', async () => {
    const s = await openWorld();
    const { worker, job, applicationId } = await seed(() => applicantScene(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-applications-list'), sweepEvent({
      sub: worker.sub, resource: '/worker/applications',
    })));
    expectStatus(response, 200, logs);
    expect(response.body.applications).toEqual([
      expect.objectContaining({ application_id: applicationId, job_id: job.id, company_name: `${SWEEP_NAME} Co` }),
    ]);
  });

  it('WorkerProfileUpdateLambda on jale_api: 200 and the name, profile and skills are stored', async () => {
    const s = await openWorld();
    const worker = await seed(() => sweepWorker(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-profile-update'), sweepEvent({
      sub: worker.sub, httpMethod: 'PATCH', resource: '/worker/profile',
      body: {
        full_name: `${SWEEP_NAME} Worker Updated`, main_trade: 'carpenter', skills: ['Framing', 'framing'],
        availability: 'full_time', years_experience: '2-4', bio: 'Fixture bio',
      },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual(expect.objectContaining({
      user_id: worker.id, skills: ['framing'], availability: 'full_time', bio: 'Fixture bio',
    }));
    const { rows: user } = await s.world.su.query(`SELECT full_name, main_trade FROM users WHERE id = $1`, [worker.id]);
    expect(user).toEqual([{ full_name: `${SWEEP_NAME} Worker Updated`, main_trade: 'carpenter' }]);
    expect(await count(s, `worker_profiles WHERE user_id = $1 AND bio = 'Fixture bio'`, [worker.id])).toBe(1);
    expect(await count(s, `worker_skills WHERE worker_id = $1 AND skill = 'framing'`, [worker.id])).toBe(1);
  });

  it('WorkerVaultDispatch upload-url on jale_api: 200 with a presigned URL under the worker\'s vault prefix', async () => {
    const s = await openWorld();
    const worker = await seed(() => sweepWorker(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-vault-dispatch'), sweepEvent({
      sub: worker.sub, httpMethod: 'POST', resource: '/worker/vault/{doc_type}', pathParameters: { doc_type: 'upload-url' },
      body: { doc_type: 'resume', mime_type: 'application/pdf' },
    })));
    expectStatus(response, 200, logs);
    expect(response.body.url).toEqual(expect.any(String));
    expect(response.body.s3_key).toMatch(new RegExp(`^documents/vault/${worker.id}/resume/[0-9a-f-]{36}\\.pdf$`));
  });

  it('WorkerVaultDispatch confirm on jale_api: 201 and a vault document row', async () => {
    const s = await openWorld();
    const worker = await seed(() => sweepWorker(s));
    const s3Key = `documents/vault/${worker.id}/resume/${randomUUID()}.pdf`;
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-vault-dispatch'), sweepEvent({
      sub: worker.sub, httpMethod: 'POST', resource: '/worker/vault/{doc_type}', pathParameters: { doc_type: 'confirm' },
      body: { s3_key: s3Key, doc_type: 'resume', file_name: 'resume.pdf', file_size: 2048, mime_type: 'application/pdf' },
    })));
    expectStatus(response, 201, logs);
    expect(response.body).toEqual(expect.objectContaining({ doc_type: 'resume', s3_key: s3Key, file_name: 'resume.pdf' }));
    expect(await count(s, `worker_documents WHERE worker_id = $1 AND job_id IS NULL AND doc_type = 'resume' AND s3_key = $2`,
      [worker.id, s3Key])).toBe(1);
  });

  it('WorkerDocumentsList on jale_api: 200 listing the worker\'s vault document', async () => {
    const s = await openWorld();
    const { worker, documentId } = await seed(async () => {
      const w = await sweepWorker(s);
      return { worker: w, documentId: await s.world.document({ workerId: w.id, jobId: null, docType: 'resume' }) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-documents-list'), sweepEvent({
      sub: worker.sub, resource: '/worker/vault',
    })));
    expectStatus(response, 200, logs);
    expect(response.body.documents).toEqual([
      expect.objectContaining({ id: documentId, doc_type: 'resume', url: expect.any(String) }),
    ]);
  });

  it('WorkerDocDelete on jale_api: an id on another type\'s route is a 404 that keeps the row, then 204 and the vault document is gone', async () => {
    const s = await openWorld();
    const { worker, documentId, licenseId } = await seed(async () => {
      const w = await sweepWorker(s);
      return {
        worker: w,
        documentId: await s.world.document({ workerId: w.id, jobId: null, docType: 'resume' }),
        licenseId: await s.world.document({ workerId: w.id, jobId: null, docType: 'driver_license' }),
      };
    });
    const deleteDocument = (docType: string, id?: string) => asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-doc-delete'), sweepEvent({
      sub: worker.sub, httpMethod: 'DELETE', resource: '/worker/vault/{doc_type}', pathParameters: { doc_type: docType },
      ...(id ? { queryStringParameters: { id } } : {}),
    })));

    // The worker's own driver_license row, addressed by its id through the
    // resume route: nothing is deleted.
    const byIdElsewhere = await deleteDocument('resume', licenseId);
    expectStatus(byIdElsewhere, 404, logs);
    expect(await count(s, `worker_documents WHERE id = $1`, [licenseId])).toBe(1);
    expect(awsCalls('s3', 'DeleteObjectCommand')).toHaveLength(0);

    const response = await deleteDocument('resume');
    expectStatus(response, 204, logs);
    expect(await count(s, `worker_documents WHERE id = $1`, [documentId])).toBe(0);
    expect(await count(s, `worker_documents WHERE id = $1`, [licenseId])).toBe(1);
    expect(awsCalls('s3', 'DeleteObjectCommand')).toHaveLength(1);
  });

  it('WorkerPostsDispatch upload-urls on jale_api: 200 with upload URLs under the worker\'s post prefix', async () => {
    const s = await openWorld();
    const worker = await seed(() => sweepWorker(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-posts-dispatch'), sweepEvent({
      sub: worker.sub, httpMethod: 'POST', resource: '/worker/posts/{post_id}', pathParameters: { post_id: 'upload-urls' },
      body: { items: [{ mime_type: 'image/jpeg', file_size: 2048 }] },
    })));
    expectStatus(response, 200, logs);
    expect(response.body.post_id).toMatch(UUID);
    expect(response.body.uploads).toEqual([{
      url: expect.any(String),
      s3_key: expect.stringMatching(new RegExp(`^${worker.id}/posts/${response.body.post_id}/[0-9a-f-]{36}\\.jpg$`)),
    }]);
  });

  it('WorkerPostCreate on jale_api: 201 and the post with its moderated media', async () => {
    const s = await openWorld();
    const worker = await seed(() => sweepWorker(s));
    const postId = randomUUID();
    const s3Key = `${worker.id}/posts/${postId}/${randomUUID()}.jpg`;
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-post-create'), sweepEvent({
      sub: worker.sub, httpMethod: 'POST', resource: '/worker/posts',
      body: { post_id: postId, caption: 'Fixture caption', items: [{ s3_key: s3Key, sort_order: 0 }] },
    })));
    expectStatus(response, 201, logs);
    expect(response.body).toEqual({
      post: expect.objectContaining({ id: postId, caption: 'Fixture caption', source: 'web' }), flagged_count: 0,
    });
    expect(await count(s, `worker_posts WHERE id = $1 AND worker_id = $2 AND status = 'published'`, [postId, worker.id])).toBe(1);
    expect(await count(s, `worker_post_media WHERE post_id = $1 AND s3_key = $2 AND moderation_status = 'approved'`,
      [postId, s3Key])).toBe(1);
  });

  it('WorkerPostsList on jale_api: 200 listing the worker\'s published post', async () => {
    const s = await openWorld();
    const { worker, post } = await seed(async () => {
      const w = await sweepWorker(s);
      return { worker: w, post: await workerPost(s, w.id) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-posts-list'), sweepEvent({
      sub: worker.sub, resource: '/worker/posts',
    })));
    expectStatus(response, 200, logs);
    expect(response.body.posts).toEqual([expect.objectContaining({
      id: post.postId,
      media: [expect.objectContaining({ id: post.mediaId, moderation_status: 'approved', url: expect.any(String) })],
    })]);
  });

  it('WorkerPostDelete on jale_api: 200 and the post is marked deleted', async () => {
    const s = await openWorld();
    const { worker, post } = await seed(async () => {
      const w = await sweepWorker(s);
      return { worker: w, post: await workerPost(s, w.id) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-post-delete'), sweepEvent({
      sub: worker.sub, httpMethod: 'DELETE', resource: '/worker/posts/{post_id}', pathParameters: { post_id: post.postId },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ deleted: true });
    expect(await count(s, `worker_posts WHERE id = $1 AND status = 'deleted'`, [post.postId])).toBe(1);
  });

  it('WorkerJobShareLambda on jale_api: 200 and a share link for the worker', async () => {
    const s = await openWorld();
    const { worker, job } = await seed(async () => {
      const employer = await sweepEmployer(s);
      return { worker: await sweepWorker(s), job: await sweepJob(s, employer.id, { publicListing: true }) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-job-share'), sweepEvent({
      sub: worker.sub, httpMethod: 'POST', resource: '/worker/jobs/{jobId}/share', pathParameters: { jobId: job.id },
      body: { channel: 'whatsapp' },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({
      code: expect.any(String), channel: 'whatsapp',
      share_url: `https://fixture.invalid/j/${job.publicCode}?r=${response.body.code}`,
    });
    expect(await count(s, `job_share_links WHERE code = $1 AND job_id = $2 AND referrer_worker_id = $3 AND channel = 'whatsapp'`,
      [response.body.code, job.id, worker.id])).toBe(1);
  });

  it('WorkerReferralClaimLambda on jale_api: 200, the referral is credited and the job recorded', async () => {
    const s = await openWorld();
    const { claimer, referrer, job, code } = await seed(async () => {
      const employer = await sweepEmployer(s);
      const j = await sweepJob(s, employer.id);
      const r = await sweepWorker(s);
      return { claimer: await sweepWorker(s), referrer: r, job: j, code: await s.world.shareLink({ jobId: j.id, referrerWorkerId: r.id }) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/worker-referral-claim'), sweepEvent({
      sub: claimer.sub, httpMethod: 'POST', resource: '/worker/referrals/claim', body: { shareCode: code },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ claimed: true, recorded: [job.id] });
    const { rows: credit } = await s.world.su.query(
      `SELECT first_share_code, first_job_id, first_referrer_worker_id FROM worker_attribution WHERE worker_id = $1`, [claimer.id],
    );
    expect(credit).toEqual([{ first_share_code: code, first_job_id: job.id, first_referrer_worker_id: referrer.id }]);
    expect(await count(s, `worker_referred_jobs WHERE worker_id = $1 AND job_id = $2`, [claimer.id, job.id])).toBe(1);
  });

  // ── jale_api: employer ───────────────────────────────────────────────

  it('EmployerDigestSettingsLambda GET on jale_api: 200 with the stored settings', async () => {
    const s = await openWorld();
    const employer = await seed(async () => {
      const e = await sweepEmployer(s);
      await digestSettings(s, e.id, { enabled: true, sendHourLocal: 9, timezone: 'America/Chicago', language: 'es' });
      return e;
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-digest-settings'), sweepEvent({
      sub: employer.sub, httpMethod: 'GET', resource: '/employer/settings/digest',
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ enabled: true, send_hour_local: 9, timezone: 'America/Chicago', language: 'es' });
  });

  it('EmployerDigestSettingsLambda PATCH on jale_api: 200 and the settings are stored', async () => {
    const s = await openWorld();
    const employer = await seed(() => sweepEmployer(s));
    const settings = { enabled: true, send_hour_local: 7, timezone: 'America/New_York', language: 'en' };
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-digest-settings'), sweepEvent({
      sub: employer.sub, httpMethod: 'PATCH', resource: '/employer/settings/digest', body: settings,
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual(settings);
    const { rows } = await s.world.su.query(
      `SELECT enabled, send_hour_local, timezone, language FROM employer_digest_settings WHERE employer_id = $1`, [employer.id],
    );
    expect(rows).toEqual([settings]);
  });

  it('EmployerProfileLambda GET on jale_api: 200 with the employer\'s profile', async () => {
    const s = await openWorld();
    const employer = await seed(() => sweepEmployer(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-profile'), sweepEvent({
      sub: employer.sub, httpMethod: 'GET', resource: '/employer/profile',
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual(expect.objectContaining({
      id: employer.id, user_type: 'employer', company_name: `${SWEEP_NAME} Co`,
    }));
  });

  it('EmployerProfileLambda PATCH on jale_api: 200 and the profile is stored', async () => {
    const s = await openWorld();
    const employer = await seed(() => sweepEmployer(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-profile'), sweepEvent({
      sub: employer.sub, httpMethod: 'PATCH', resource: '/employer/profile',
      body: { company_name: `${SWEEP_NAME} Renamed Co`, city: 'Fixture City', hiring_trades: ['carpenter'], company_size: '1-10' },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual(expect.objectContaining({
      id: employer.id, company_name: `${SWEEP_NAME} Renamed Co`, hiring_trades: ['carpenter'], company_size: '1-10',
    }));
    const { rows } = await s.world.su.query(
      `SELECT ep.company_name, ep.city, u.full_name FROM employer_profiles ep JOIN users u ON u.id = ep.user_id WHERE ep.user_id = $1`,
      [employer.id],
    );
    expect(rows).toEqual([{ company_name: `${SWEEP_NAME} Renamed Co`, city: 'Fixture City', full_name: `${SWEEP_NAME} Renamed Co` }]);
  });

  it('EmployerJobsListLambda on jale_api: 200 listing the employer\'s job with its applicant count', async () => {
    const s = await openWorld();
    const { employer, job } = await seed(() => applicantScene(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-jobs-list'), sweepEvent({
      sub: employer.sub, resource: '/employer/jobs',
    })));
    expectStatus(response, 200, logs);
    expect(response.body.jobs).toEqual([expect.objectContaining({ id: job.id, title: `${SWEEP_NAME} Job`, applicant_count: 1 })]);
  });

  it('EmployerJobsCreateLambda on jale_api: 201 and a job row', async () => {
    const s = await openWorld();
    const employer = await seed(() => sweepEmployer(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-jobs-create'), sweepEvent({
      sub: employer.sub, httpMethod: 'POST', resource: '/employer/jobs',
      body: { title: `${SWEEP_NAME} Created Job`, location: 'Fixture City, TX', job_type: 'full-time', trade_category: 'carpenter' },
    })));
    expectStatus(response, 201, logs);
    expect(response.body).toEqual(expect.objectContaining({ id: expect.stringMatching(UUID), title: `${SWEEP_NAME} Created Job` }));
    expect(await count(s, `jobs WHERE id = $1 AND employer_id = $2 AND title = $3`,
      [response.body.id, employer.id, `${SWEEP_NAME} Created Job`])).toBe(1);
  });

  it('EmployerJobsDetailLambda on jale_api: 200 with the job', async () => {
    const s = await openWorld();
    const { employer, job } = await seed(() => applicantScene(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-jobs-detail'), sweepEvent({
      sub: employer.sub, resource: '/employer/jobs/{jobId}', pathParameters: { jobId: job.id },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual(expect.objectContaining({
      id: job.id, title: `${SWEEP_NAME} Job`, public_code: job.publicCode, applicant_count: 1,
    }));
  });

  it('EmployerJobsUpdateLambda on jale_api: 200, the job is paused and its removal is enqueued', async () => {
    const s = await openWorld();
    const { employer, job } = await seed(async () => {
      const e = await sweepEmployer(s);
      return { employer: e, job: await sweepJob(s, e.id, { publicListing: true }) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-jobs-update'), sweepEvent({
      sub: employer.sub, httpMethod: 'PATCH', resource: '/employer/jobs/{jobId}', pathParameters: { jobId: job.id },
      body: { status: 'paused' },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual(expect.objectContaining({ id: job.id, status: 'paused' }));
    expect(await count(s, `jobs WHERE id = $1 AND status = 'paused'`, [job.id])).toBe(1);
    const { rows: events } = await s.world.su.query(
      `SELECT event_kind, status FROM job_visibility_events WHERE job_id = $1`, [job.id],
    );
    expect(events).toEqual([{ event_kind: 'removed', status: 'pending' }]);
  });

  it('EmployerJobsDeleteLambda on jale_api: 200 and the job and its application are gone', async () => {
    const s = await openWorld();
    const { employer, job, applicationId } = await seed(() => applicantScene(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-jobs-delete'), sweepEvent({
      sub: employer.sub, httpMethod: 'DELETE', resource: '/employer/jobs/{jobId}', pathParameters: { jobId: job.id },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ deleted: true, id: job.id });
    expect(await count(s, `jobs WHERE id = $1`, [job.id])).toBe(0);
    expect(await count(s, `job_applications WHERE id = $1`, [applicationId])).toBe(0);
  });

  it('EmployerJobApplicantsLambda on jale_api: 200 listing the applicant', async () => {
    const s = await openWorld();
    const { employer, worker, job, applicationId } = await seed(() => applicantScene(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-job-applicants'), sweepEvent({
      sub: employer.sub, resource: '/employer/jobs/{jobId}/applicants', pathParameters: { jobId: job.id },
    })));
    expectStatus(response, 200, logs);
    expect(response.body.total).toBe(1);
    expect(response.body.applicants).toEqual([expect.objectContaining({
      application_id: applicationId, worker_id: worker.id, full_name: `${SWEEP_NAME} Worker`, status: 'pending',
    })]);
  });

  it('EmployerApplicationStatusUpdateLambda on jale_api: 200, details requested and the worker notification enqueued', async () => {
    const s = await openWorld();
    const { employer, worker, job, applicationId } = await seed(() => applicantScene(s, {
      worker: { whatsappNumber: fakePhone(), lifecycle: 'onboarding', workflowLanguage: 'es' },
    }));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-application-status-update'), sweepEvent({
      sub: employer.sub, httpMethod: 'PATCH', resource: '/employer/jobs/{jobId}/applicants/{workerId}',
      pathParameters: { jobId: job.id, workerId: worker.id }, body: { status: 'details_requested' },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual(expect.objectContaining({
      application_id: applicationId, status: 'details_requested', notified: true,
    }));
    expect(await count(s, `job_applications WHERE id = $1 AND status = 'details_requested' AND details_requested_at IS NOT NULL`,
      [applicationId])).toBe(1);
    expect(await count(s, `worker_message_intents WHERE user_id = $1 AND source_type = 'application_stage' AND source_id = $2`,
      [worker.id, applicationId])).toBe(1);
  });

  it('EmployerConversationsListLambda on jale_api: 200 listing the conversation', async () => {
    const s = await openWorld();
    const { employer, worker, conversationId } = await seed(async () => {
      const a = await applicantScene(s);
      const c = await s.world.conversation({ jobId: a.job.id, employerId: a.employer.id, workerId: a.worker.id, applicationId: a.applicationId });
      await s.world.message(c, 'Fixture message');
      return { ...a, conversationId: c };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-conversations-list'), sweepEvent({
      sub: employer.sub, resource: '/employer/conversations',
    })));
    expectStatus(response, 200, logs);
    expect(response.body.conversations).toEqual([expect.objectContaining({ id: conversationId, worker_id: worker.id })]);
  });

  it('EmployerConversationsDetailLambda on jale_api: 200 with the conversation and its messages', async () => {
    const s = await openWorld();
    const { employer, conversationId, messageId } = await seed(async () => {
      const a = await applicantScene(s);
      const c = await s.world.conversation({ jobId: a.job.id, employerId: a.employer.id, workerId: a.worker.id, applicationId: a.applicationId });
      return { ...a, conversationId: c, messageId: await s.world.message(c, 'Fixture message') };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-conversations-detail'), sweepEvent({
      sub: employer.sub, resource: '/employer/conversations/{conversationId}', pathParameters: { conversationId },
    })));
    expectStatus(response, 200, logs);
    expect(response.body.conversation).toEqual(expect.objectContaining({ id: conversationId }));
    expect(response.body.messages).toEqual([expect.objectContaining({ id: messageId, body: 'Fixture message' })]);
  });

  it('EmployerConversationsCreateLambda on jale_api: 201, the conversation and message are stored and the invite sent', async () => {
    const s = await openWorld();
    const { employer, worker, job, applicationId } = await seed(() => applicantScene(s, {
      worker: { whatsappNumber: fakePhone(), lifecycle: 'ready', workflowLanguage: 'es' },
    }));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-conversations-create'), sweepEvent({
      sub: employer.sub, httpMethod: 'POST', resource: '/employer/conversations',
      body: { job_id: job.id, worker_id: worker.id, initial_message: 'Fixture hello from the sweep' },
    })));
    expectStatus(response, 201, logs);
    const conversationId = response.body.conversation?.id;
    expect(response.body.messages).toEqual([expect.objectContaining({ body: 'Fixture hello from the sweep' })]);
    expect(await count(s, `job_conversations WHERE id = $1 AND job_id = $2 AND employer_id = $3 AND worker_id = $4`,
      [conversationId, job.id, employer.id, worker.id])).toBe(1);
    expect(await count(s, `job_conversation_messages WHERE conversation_id = $1 AND body = 'Fixture hello from the sweep'`,
      [conversationId])).toBe(1);
    const { rows: outbox } = await s.world.su.query(
      `SELECT send_kind, status, content_template FROM job_message_outbox WHERE conversation_id = $1`, [conversationId],
    );
    expect(outbox).toEqual([{ send_kind: 'template', status: 'sent', content_template: expect.stringMatching(/^employer_message_invite_(es|en)$/) }]);
    expect(mockWhatsAppSends).toHaveLength(1);
    expect(await count(s, `job_applications WHERE id = $1 AND status = 'contacted'`, [applicationId])).toBe(1);
  });

  it('EmployerConversationsSendLambda on jale_api: 200, the message is stored and a deferred worker intent enqueued', async () => {
    const s = await openWorld();
    const { employer, worker, conversationId } = await seed(async () => {
      const a = await applicantScene(s, { worker: { whatsappNumber: fakePhone(), lifecycle: 'onboarding', workflowLanguage: 'es' } });
      const c = await s.world.conversation({ jobId: a.job.id, employerId: a.employer.id, workerId: a.worker.id, applicationId: a.applicationId });
      return { ...a, conversationId: c };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-conversations-send'), sweepEvent({
      sub: employer.sub, httpMethod: 'POST', resource: '/employer/conversations/{conversationId}/messages',
      pathParameters: { conversationId }, body: { body: 'Fixture follow-up from the sweep' },
    })));
    expectStatus(response, 200, logs);
    expect(response.body.conversation).toEqual(expect.objectContaining({ id: conversationId }));
    const { rows: messages } = await s.world.su.query(
      `SELECT id, status FROM job_conversation_messages WHERE conversation_id = $1 AND body = 'Fixture follow-up from the sweep'`,
      [conversationId],
    );
    expect(messages).toEqual([{ id: expect.any(String), status: 'waiting_worker_reply' }]);
    expect(await count(s, `worker_message_intents WHERE user_id = $1 AND source_type = 'job_conversation_message'
                             AND source_id = $2 AND status = 'deferred'`, [worker.id, messages[0].id])).toBe(1);
    expect(mockWhatsAppSends).toHaveLength(0);
  });

  it('EmployerConversationsUpdateLambda on jale_api: 200 and the conversation is closed', async () => {
    const s = await openWorld();
    const { employer, conversationId } = await seed(async () => {
      const a = await applicantScene(s);
      return { ...a, conversationId: await s.world.conversation({ jobId: a.job.id, employerId: a.employer.id, workerId: a.worker.id, applicationId: a.applicationId }) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-conversations-update'), sweepEvent({
      sub: employer.sub, httpMethod: 'PATCH', resource: '/employer/conversations/{conversationId}',
      pathParameters: { conversationId }, body: { status: 'closed' },
    })));
    expectStatus(response, 200, logs);
    expect(response.body.conversation).toEqual(expect.objectContaining({ id: conversationId, status: 'closed' }));
    expect(await count(s, `job_conversations WHERE id = $1 AND status = 'closed' AND closed_at IS NOT NULL`, [conversationId])).toBe(1);
  });

  it('EmployerConversationsReadLambda on jale_api: 200 and the read time is stored', async () => {
    const s = await openWorld();
    const { employer, conversationId } = await seed(async () => {
      const a = await applicantScene(s);
      return { ...a, conversationId: await s.world.conversation({ jobId: a.job.id, employerId: a.employer.id, workerId: a.worker.id, applicationId: a.applicationId }) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-conversations-read'), sweepEvent({
      sub: employer.sub, httpMethod: 'POST', resource: '/employer/conversations/{conversationId}/read',
      pathParameters: { conversationId },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ conversation_id: conversationId, employer_last_read_at: expect.any(String) });
    expect(await count(s, `job_conversations WHERE id = $1 AND employer_last_read_at IS NOT NULL`, [conversationId])).toBe(1);
  });

  it('EmployerInboxLambda on jale_api: 200 with the applicant\'s inbox item', async () => {
    const s = await openWorld();
    const { employer, worker, applicationId, conversationId } = await seed(async () => {
      const a = await applicantScene(s);
      const c = await s.world.conversation({ jobId: a.job.id, employerId: a.employer.id, workerId: a.worker.id, applicationId: a.applicationId });
      await s.world.message(c, 'Fixture message');
      return { ...a, conversationId: c };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-inbox'), sweepEvent({
      sub: employer.sub, resource: '/employer/inbox',
    })));
    expectStatus(response, 200, logs);
    expect(response.body.items).toEqual([expect.objectContaining({
      application_id: applicationId, worker_id: worker.id, conversation_id: conversationId,
    })]);
  });

  it('EmployerApplicantsOverviewLambda on jale_api: 200 listing the applicants', async () => {
    const s = await openWorld();
    // Details requested from two applicants of a job that requires one
    // document. The first attached it to this job, so nothing is outstanding
    // and details_status reads complete before details_completed_at is
    // stamped, as the per-job list reads it. The second holds it only in the
    // vault, which does not count for this job, so it reads requested.
    const { employer, worker, job, applicationId, vaultOnly } = await seed(async () => {
      const a = await applicantScene(s, { status: 'details_requested', job: { requiredDocs: ['resume'] } });
      const other = await sweepWorker(s);
      const otherApplicationId = await s.world.application(a.job.id, other.id, 'details_requested');
      await s.world.su.query(
        `UPDATE job_applications SET details_requested_at = now() WHERE id = ANY($1::uuid[])`,
        [[a.applicationId, otherApplicationId]],
      );
      await s.world.document({ workerId: a.worker.id, jobId: a.job.id, docType: 'resume' });
      await s.world.document({ workerId: other.id, jobId: null, docType: 'resume' });
      return { ...a, vaultOnly: { worker: other, applicationId: otherApplicationId } };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-applicants-overview'), sweepEvent({
      sub: employer.sub, resource: '/employer/applicants',
    })));
    expectStatus(response, 200, logs);
    expect(response.body.total).toBe(2);
    const byId = new Map(response.body.applicants.map((item: { application_id: string }) => [item.application_id, item]));
    expect(byId.get(applicationId)).toEqual(expect.objectContaining({
      worker_id: worker.id, job_id: job.id, details_status: 'complete',
    }));
    expect(byId.get(vaultOnly.applicationId)).toEqual(expect.objectContaining({
      worker_id: vaultOnly.worker.id, job_id: job.id, details_status: 'requested',
    }));
    for (const item of response.body.applicants) {
      expect(item).not.toHaveProperty('have_docs');
      expect(item).not.toHaveProperty('details_requested_at');
    }
  });

  it('EmployerTemplatesListLambda on jale_api: 200 listing the template', async () => {
    const s = await openWorld();
    const { employer, templateId } = await seed(async () => {
      const e = await sweepEmployer(s);
      return { employer: e, templateId: await jobTemplate(s, e.id, `${SWEEP_NAME} Template`) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-templates-list'), sweepEvent({
      sub: employer.sub, resource: '/employer/templates',
    })));
    expectStatus(response, 200, logs);
    expect(response.body.templates).toEqual([expect.objectContaining({ id: templateId, name: `${SWEEP_NAME} Template` })]);
  });

  it('EmployerTemplatesSaveLambda on jale_api: 201 and a template row', async () => {
    const s = await openWorld();
    const employer = await seed(() => sweepEmployer(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-templates-save'), sweepEvent({
      sub: employer.sub, httpMethod: 'POST', resource: '/employer/templates',
      body: {
        name: `${SWEEP_NAME} Template`,
        payload: { title: `${SWEEP_NAME} Template Job`, location: 'Fixture City, TX', job_type: 'full-time', trade_category: 'carpenter' },
      },
    })));
    expectStatus(response, 201, logs);
    expect(response.body).toEqual(expect.objectContaining({ id: expect.stringMatching(UUID), name: `${SWEEP_NAME} Template` }));
    expect(await count(s, `employer_job_templates WHERE id = $1 AND employer_id = $2`, [response.body.id, employer.id])).toBe(1);
  });

  it('EmployerTemplatesDeleteLambda on jale_api: 204 and the template is gone', async () => {
    const s = await openWorld();
    const { employer, templateId } = await seed(async () => {
      const e = await sweepEmployer(s);
      return { employer: e, templateId: await jobTemplate(s, e.id, `${SWEEP_NAME} Template`) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-templates-delete'), sweepEvent({
      sub: employer.sub, httpMethod: 'DELETE', resource: '/employer/templates/{templateId}', pathParameters: { templateId },
    })));
    expectStatus(response, 204, logs);
    expect(await count(s, `employer_job_templates WHERE id = $1`, [templateId])).toBe(0);
  });

  it('EmployerJobCandidatesLambda on jale_api: 200 listing the candidate', async () => {
    const s = await openWorld();
    const { employer, worker, job, applicationId } = await seed(() => applicantScene(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-job-candidates'), sweepEvent({
      sub: employer.sub, resource: '/employer/jobs/{jobId}/candidates', pathParameters: { jobId: job.id },
    })));
    expectStatus(response, 200, logs);
    expect(response.body.total).toBe(1);
    expect(response.body.candidates).toEqual([expect.objectContaining({ application_id: applicationId, worker_id: worker.id })]);
  });

  it('GetBillingLambda on jale_api: 200 with the active subscription\'s plan', async () => {
    const s = await openWorld();
    const employer = await seed(async () => {
      const e = await sweepEmployer(s);
      await subscription(s, e.id, 'employer_pro', 'active');
      return e;
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/billing/get-billing'), sweepEvent({
      sub: employer.sub, resource: '/employer/billing',
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual(expect.objectContaining({
      planCode: 'employer_pro', activeJobLimit: 50, templateLimit: 20, activeJobUsage: 0,
      subscription: expect.objectContaining({ plan_code: 'employer_pro', status: 'active' }),
    }));
  });

  it('CheckoutLambda on jale_api: 200, the operation succeeded and the customer is stored', async () => {
    const s = await openWorld();
    const employer = await seed(() => sweepEmployer(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/billing/checkout'), sweepEvent({
      sub: employer.sub, httpMethod: 'POST', resource: '/employer/billing/checkout',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { planCode: 'employer_pro', successUrl: `${RETURN_URL_BASE}?checkout=success`, cancelUrl: `${RETURN_URL_BASE}?checkout=cancel` },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ url: 'https://fixture.invalid/checkout/session', sessionId: expect.stringMatching(/^fixture-session-/) });
    expect(await count(s, `billing_operations WHERE actor_user_id = $1 AND operation_type = 'subscription_checkout' AND status = 'succeeded'`,
      [employer.id])).toBe(1);
    expect(await count(s, `billing_customers WHERE user_id = $1 AND provider_customer_id LIKE 'fixture-customer-%'`, [employer.id])).toBe(1);
  });

  it('PortalLambda on jale_api: 200 with a portal session for the stored customer', async () => {
    const s = await openWorld();
    const { employer, customerId } = await seed(async () => {
      const e = await sweepEmployer(s);
      return { employer: e, customerId: await billingCustomer(s, e.id) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/billing/portal'), sweepEvent({
      sub: employer.sub, httpMethod: 'POST', resource: '/employer/billing/portal', body: { returnUrl: RETURN_URL_BASE },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ url: `https://fixture.invalid/portal/${customerId}` });
  });

  it('EmployerUploadToken on jale_api: 201 and an upload token for the applicant', async () => {
    const s = await openWorld();
    const { employer, worker, job } = await seed(() => applicantScene(s));
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-upload-token'), sweepEvent({
      sub: employer.sub, httpMethod: 'POST', resource: '/employer/upload-tokens', body: { job_id: job.id, worker_id: worker.id },
    })));
    expectStatus(response, 201, logs);
    expect(response.body.upload_url).toMatch(/^https:\/\/fixture\.invalid\/en\/upload\/[0-9a-f]{64}$/);
    const raw = String(response.body.upload_url).split('/').pop()!;
    expect(await count(s, `document_upload_tokens WHERE token_hash = $1 AND worker_id = $2 AND job_id = $3 AND used = false`,
      [sha256(raw), worker.id, job.id])).toBe(1);
  });

  it('EmployerWorkerDetail profile on jale_api: 200 with the applicant\'s profile', async () => {
    const s = await openWorld();
    const { employer, worker, job, applicationId } = await seed(async () => {
      const a = await applicantScene(s);
      await s.world.workerProfile(a.worker.id, { location: 'Fixture City' });
      return a;
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-worker-detail'), sweepEvent({
      sub: employer.sub, resource: '/employer/workers/{worker_id}/{action}',
      pathParameters: { worker_id: worker.id, action: 'profile' }, queryStringParameters: { job_id: job.id },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual(expect.objectContaining({
      worker_id: worker.id, application_id: applicationId, application_status: 'pending', location: 'Fixture City',
    }));
  });

  it('EmployerWorkerDetail documents on jale_api: 200 listing the applicant\'s job document', async () => {
    const s = await openWorld();
    const { employer, worker, job, documentId } = await seed(async () => {
      const a = await applicantScene(s);
      return { ...a, documentId: await s.world.document({ workerId: a.worker.id, jobId: a.job.id, docType: 'resume' }) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-worker-detail'), sweepEvent({
      sub: employer.sub, resource: '/employer/workers/{worker_id}/{action}',
      pathParameters: { worker_id: worker.id, action: 'documents' }, queryStringParameters: { job_id: job.id },
    })));
    expectStatus(response, 200, logs);
    expect(response.body.documents).toEqual([expect.objectContaining({ id: documentId, doc_type: 'resume', url: expect.any(String) })]);
  });

  it('EmployerWorkerDetail posts on jale_api: 200 listing the applicant\'s approved post', async () => {
    const s = await openWorld();
    const { employer, worker, post } = await seed(async () => {
      const a = await applicantScene(s);
      return { ...a, post: await workerPost(s, a.worker.id) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-worker-detail'), sweepEvent({
      sub: employer.sub, resource: '/employer/workers/{worker_id}/{action}',
      pathParameters: { worker_id: worker.id, action: 'posts' },
    })));
    expectStatus(response, 200, logs);
    expect(response.body.posts).toEqual([expect.objectContaining({
      id: post.postId, media: [expect.objectContaining({ id: post.mediaId, moderation_status: 'approved' })],
    })]);
  });

  it('EmployerJobPublicListingLambda on jale_api: 200, the job is listed and its publication enqueued', async () => {
    const s = await openWorld();
    const { employer, job } = await seed(async () => {
      const e = await sweepEmployer(s);
      return { employer: e, job: await sweepJob(s, e.id) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-job-public-listing'), sweepEvent({
      sub: employer.sub, httpMethod: 'PATCH', resource: '/employer/jobs/{jobId}/public-listing', pathParameters: { jobId: job.id },
      body: { enabled: true },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ id: job.id, public_code: job.publicCode, public_listing_enabled: true });
    expect(await count(s, `jobs WHERE id = $1 AND public_listing_enabled`, [job.id])).toBe(1);
    const { rows: events } = await s.world.su.query(`SELECT event_kind, status FROM job_visibility_events WHERE job_id = $1`, [job.id]);
    expect(events).toEqual([{ event_kind: 'published', status: 'pending' }]);
  });

  it('EmployerJobShareLambda on jale_api: 200 and a share link for the employer', async () => {
    const s = await openWorld();
    const { employer, job } = await seed(async () => {
      const e = await sweepEmployer(s);
      return { employer: e, job: await sweepJob(s, e.id, { publicListing: true }) };
    });
    const response = await asLogin('jale_api', () => invoke(load('../../../lambda/api/employer-job-share'), sweepEvent({
      sub: employer.sub, httpMethod: 'POST', resource: '/employer/jobs/{jobId}/share', pathParameters: { jobId: job.id },
      body: { channel: 'copy_link' },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({
      code: expect.any(String), channel: 'copy_link',
      share_url: `https://fixture.invalid/j/${job.publicCode}?r=${response.body.code}`,
    });
    expect(await count(s, `job_share_links WHERE code = $1 AND job_id = $2 AND referrer_employer_id = $3`,
      [response.body.code, job.id, employer.id])).toBe(1);
  });

  // ── jale_api: Cognito trigger ────────────────────────────────────────

  it('PostConfirmationLambda on jale_api: returns the event and the account row exists', async () => {
    const s = await openWorld();
    const sub = createdSub(s, 'confirm');
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
    const result = await asLogin('jale_api', () => run(() => load('../../../lambda/post-confirmation/index')(event), logs));
    expect(result).toBe(event);
    const { rows } = await s.world.su.query(`SELECT user_type, email, full_name FROM users WHERE cognito_sub = $1`, [sub]);
    expectThat(rows.length === 1, 'expected the account row for the confirmed user', logs);
    expect(rows).toEqual([{ user_type: 'employer', email: `${sub}@fixture.invalid`, full_name: `${SWEEP_NAME} Employer` }]);
    expect(awsCalls('sqs', 'SendMessageCommand')).toHaveLength(0);
  });

  // ── jale_api_public: unauthenticated ─────────────────────────────────

  it('WorkerWebSignupLambda on jale_api_public: 200 and a worker account row', async () => {
    const s = await openWorld();
    signupSub = createdSub(s, 'signup');
    const phone = fakePhone();
    const response = await asLogin('jale_api_public', () => invoke(load('../../../lambda/auth/worker-web-signup'), sweepEvent({
      httpMethod: 'POST', resource: '/auth/worker/signup', body: { phone },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ ok: true });
    expect(await count(s, `users WHERE cognito_sub = $1 AND user_type = 'worker' AND phone = $2`, [signupSub, phone])).toBe(1);
    expect(awsCalls('cognito', 'AdminSetUserPasswordCommand')).toHaveLength(1);
  });

  it('WorkerDocumentsDispatch upload-url on jale_api_public: 200 and an issued upload slot', async () => {
    const s = await openWorld();
    const { worker, job, token } = await seed(async () => {
      const a = await applicantScene(s, { job: { requiredDocs: ['resume'] } });
      return { ...a, token: await s.world.uploadToken({ jobId: a.job.id, workerId: a.worker.id }) };
    });
    const response = await asLogin('jale_api_public', () => invoke(load('../../../lambda/api/worker-documents-dispatch'), sweepEvent({
      httpMethod: 'POST', resource: '/worker/documents/{action}', pathParameters: { action: 'upload-url' },
      body: { token: token.raw, doc_type: 'resume', mime_type: 'application/pdf' },
    })));
    expectStatus(response, 200, logs);
    expect(response.body.url).toEqual(expect.any(String));
    expect(response.body.s3_key).toMatch(new RegExp(`^documents/${job.id}/${worker.id}/resume/[0-9a-f-]{36}\\.pdf$`));
    expect(await count(s, `document_upload_token_slots WHERE token_hash = $1 AND doc_type = 'resume' AND issued_s3_key = $2
                             AND confirmed_at IS NULL`, [token.hash, response.body.s3_key])).toBe(1);
  });

  it('WorkerDocumentsDispatch confirm on jale_api_public: 200, the slot is confirmed and the document stored', async () => {
    const s = await openWorld();
    const { worker, job, token, s3Key } = await seed(async () => {
      const a = await applicantScene(s, { job: { requiredDocs: ['resume'] } });
      const t = await s.world.uploadToken({ jobId: a.job.id, workerId: a.worker.id });
      const key = await s.world.uploadSlot(t.hash, {
        docType: 'resume', s3Key: `documents/${a.job.id}/${a.worker.id}/resume/${randomUUID()}.pdf`,
      });
      return { ...a, token: t, s3Key: key };
    });
    const response = await asLogin('jale_api_public', () => invoke(load('../../../lambda/api/worker-documents-dispatch'), sweepEvent({
      httpMethod: 'POST', resource: '/worker/documents/{action}', pathParameters: { action: 'confirm' },
      body: { token: token.raw, s3_key: s3Key, doc_type: 'resume', file_name: 'resume.pdf', file_size: 2048, mime_type: 'application/pdf' },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ success: true });
    expect(await count(s, `worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = 'resume' AND s3_key = $3`,
      [worker.id, job.id, s3Key])).toBe(1);
    expect(await count(s, `document_upload_token_slots WHERE token_hash = $1 AND doc_type = 'resume' AND confirmed_at IS NOT NULL`,
      [token.hash])).toBe(1);
  });

  it('WorkerDocumentsDispatch submit on jale_api_public: 200 and the token is marked used', async () => {
    const s = await openWorld();
    const token = await seed(async () => {
      const a = await applicantScene(s, { job: { requiredDocs: ['resume'] } });
      const t = await s.world.uploadToken({ jobId: a.job.id, workerId: a.worker.id });
      await s.world.uploadSlot(t.hash, { docType: 'resume', confirmed: true });
      return t;
    });
    const response = await asLogin('jale_api_public', () => invoke(load('../../../lambda/api/worker-documents-dispatch'), sweepEvent({
      httpMethod: 'POST', resource: '/worker/documents/{action}', pathParameters: { action: 'submit' }, body: { token: token.raw },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ success: true });
    expect(await count(s, `document_upload_tokens WHERE token_hash = $1 AND used AND used_at IS NOT NULL`, [token.hash])).toBe(1);
  });

  it('DigestUnsubscribeLambda on jale_api_public: 200 and the employer\'s digest is switched off', async () => {
    const s = await openWorld();
    const employer = await seed(async () => {
      const e = await sweepEmployer(s);
      await digestSettings(s, e.id, { enabled: true, sendHourLocal: 8, timezone: 'America/Chicago', language: 'en' });
      return e;
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mintUnsubscribeToken } = require('../../../lambda/lib/unsubscribe-token');
    const token: string = await mintUnsubscribeToken(employer.id, 1);
    const response = await asLogin('jale_api_public', () => invoke(load('../../../lambda/notifications/unsubscribe'), sweepEvent({
      httpMethod: 'POST', resource: '/public/employer-digest/unsubscribe', body: { token },
    })));
    expectStatus(response, 200, logs);
    expect(response.body).toEqual({ status: 'unsubscribed' });
    expect(await count(s, `employer_digest_settings WHERE employer_id = $1 AND NOT enabled`, [employer.id])).toBe(1);
  });

  // ── jobs ─────────────────────────────────────────────────────────────

  it('EmailOutboxSweeperLambda on jale_job_email_sender: sends the pending rows of both producers and records their message ids', async () => {
    const s = await openWorld();
    const rows = await seed(async () => {
      const employer = await sweepEmployer(s);
      const digestTo = `${SWEEP_SUB_PREFIX}${randomUUID()}@fixture.invalid`;
      const pauseTo = `${SWEEP_SUB_PREFIX}${randomUUID()}@fixture.invalid`;
      const digest = await emailOutbox(s, { sourceType: 'employer_digest', sourceId: employer.id, recipientEmail: digestTo });
      // The billing processor's row: its source is the subscription, not a
      // user, so the scene's cleanup by user does not reach it.
      const pause = await emailOutbox(s, { sourceType: 'billing_pause', sourceId: randomUUID(), recipientEmail: pauseTo });
      s.world.onCleanup(() => s.world.su.query(`DELETE FROM email_outbox WHERE id = $1`, [pause]));
      return [{ id: digest, to: digestTo }, { id: pause, to: pauseTo }];
    });
    await asLogin('jale_job_email_sender', () => run(() => load('../../../lambda/billing/email-outbox-sweeper')(), logs));
    for (const row of rows) {
      const sends = awsCalls('ses', 'SendEmailCommand').filter((command) => command.input?.Destination?.ToAddresses?.[0] === row.to);
      expectThat(sends.length === 1, `expected one send to each seeded recipient, saw ${sends.length}`, logs);
    }
    const { rows: stored } = await s.world.su.query(
      `SELECT source_type, status, attempt_count, ses_message_id, sent_at IS NOT NULL AS has_sent_at
         FROM email_outbox WHERE id = ANY($1::uuid[]) ORDER BY source_type`,
      [rows.map((row) => row.id)],
    );
    expect(stored).toEqual(['billing_pause', 'employer_digest'].map((sourceType) => ({
      source_type: sourceType, status: 'sent', attempt_count: 1,
      ses_message_id: expect.stringMatching(/^fixture-ses-/), has_sent_at: true,
    })));
  });

  it('VisibilityOutboxDrainLambda on jale_job_visibility_drain: notifies the indexing endpoint and marks the event sent', async () => {
    const s = await openWorld();
    const { job, eventId } = await seed(async () => {
      const employer = await sweepEmployer(s);
      const j = await sweepJob(s, employer.id, { publicListing: true });
      return { job: j, eventId: await visibilityEvent(s, j.id, j.publicCode, 'published') };
    });
    const published: Array<{ url: string; type: string }> = [];
    fetchSpy.mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ access_token: 'fixture-access' }), { status: 200 });
      }
      if (url.endsWith('urlNotifications:publish')) {
        published.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 200 });
      }
      throw new Error('handler sweep: unexpected network call');
    }) as typeof fetch);
    const result = await asLogin('jale_job_visibility_drain', () => run(() => load('../../../lambda/referrals/visibility-outbox-drain')(), logs));
    expectThat(result.sent >= 1, `expected at least one notification sent, got ${JSON.stringify(result)}`, logs);
    expect(published).toEqual(expect.arrayContaining([{ url: `https://fixture.invalid/en/j/${job.publicCode}`, type: 'URL_UPDATED' }]));
    expect(await count(s, `job_visibility_events WHERE id = $1 AND status = 'sent' AND sent_at IS NOT NULL`, [eventId])).toBe(1);
  });

  it('EmployerDigestProducerLambda on jale_job_digest: queues one digest per due employer and advances its watermark', async () => {
    const s = await openWorld();
    const { employer, notDue } = await seed(async () => {
      const a = await applicantScene(s);
      const b = await applicantScene(s);
      const zone = await zoneAwayFromHourBoundary(s);
      await digestSettings(s, a.employer.id, { enabled: true, sendHourLocal: 'now', timezone: zone, language: 'en' });
      // Twelve hours away from now in the same zone: enabled, but not due.
      const { rows: [later] } = await s.world.su.query<{ hour: number }>(
        `SELECT ((date_part('hour', now() AT TIME ZONE $1::text)::int + 12) % 24) AS hour`, [zone],
      );
      await digestSettings(s, b.employer.id, { enabled: true, sendHourLocal: later.hour, timezone: zone, language: 'en' });
      return { ...a, notDue: b.employer };
    });
    const summary = await asLogin('jale_job_digest', () => run(() => load('../../../lambda/notifications/employer-digest-producer')(), logs));
    expectThat(summary.queued >= 1, `expected the seeded employer's digest to be queued, got ${JSON.stringify(summary)}`, logs);
    const { rows: queued } = await s.world.su.query(
      `SELECT status, recipient_email, headers->>'unsubscribe_url' AS unsubscribe_url
         FROM email_outbox WHERE source_type = 'employer_digest' AND source_id = $1`,
      [employer.id],
    );
    expect(queued).toEqual([{
      status: 'pending', recipient_email: `${employer.id}@fixture.invalid`,
      unsubscribe_url: expect.stringMatching(/^https:\/\/fixture\.invalid\/api\/public\/employer-digest\/unsubscribe\?token=/),
    }]);
    expect(await count(s, `employer_digest_settings WHERE employer_id = $1 AND last_sent_at IS NOT NULL`, [employer.id])).toBe(1);
    // The employer who is not due gets nothing, and keeps its watermark.
    expect(await count(s, `email_outbox WHERE source_type = 'employer_digest' AND source_id = $1`, [notDue.id])).toBe(0);
    expect(await count(s, `employer_digest_settings WHERE employer_id = $1 AND last_sent_at IS NULL`, [notDue.id])).toBe(1);
  });

  it('SesFeedbackHandlerLambda on jale_job_ses_feedback: a permanent bounce of a digest switches the digest off', async () => {
    const s = await openWorld();
    const messageId = `fixture-ses-${randomUUID()}`;
    const employer = await seed(async () => {
      const e = await sweepEmployer(s);
      await digestSettings(s, e.id, { enabled: true, sendHourLocal: 8, timezone: 'America/Chicago', language: 'en' });
      await emailOutbox(s, {
        sourceType: 'employer_digest', sourceId: e.id, recipientEmail: `${SWEEP_SUB_PREFIX}${randomUUID()}@fixture.invalid`,
        status: 'sent', sesMessageId: messageId,
      });
      return e;
    });
    const event = {
      Records: [{
        Sns: { Message: JSON.stringify({ eventType: 'Bounce', bounce: { bounceType: 'Permanent' }, mail: { messageId } }) },
      }],
    };
    const summary = await asLogin('jale_job_ses_feedback', () => run(() => load('../../../lambda/notifications/ses-feedback-handler')(event), logs));
    expect(summary).toEqual({ processed: 1, disabled: 1, transient: 0, unknownMessage: 0, notDigest: 0, malformed: 0 });
    const { rows } = await s.world.su.query(
      `SELECT enabled, unsubscribe_token_version FROM employer_digest_settings WHERE employer_id = $1`, [employer.id],
    );
    expect(rows).toEqual([{ enabled: false, unsubscribe_token_version: 2 }]);
  });

  it('ReferralRetentionSweeperLambda on jale_job_retention: deletes expired referral rows and keeps fresh ones', async () => {
    const s = await openWorld();
    const rows = await seed(async () => {
      const employer = await sweepEmployer(s);
      const job = await sweepJob(s, employer.id);
      return {
        expiredToken: await applyToken(s, job.id, '8 days'),
        freshToken: await applyToken(s, job.id, null),
        expiredClaim: await pendingClaim(s, job.id, '31 days'),
        freshClaim: await pendingClaim(s, job.id, null),
        oldOpen: await shareOpen(s, job.id, '401 days'),
        recentOpen: await shareOpen(s, job.id, '1 day'),
      };
    });
    const result = await asLogin('jale_job_retention', () => run(() => load('../../../lambda/referrals/retention-sweeper')(), logs));
    expectThat(result.tokensDeleted >= 1 && result.claimsDeleted >= 1 && result.opensDeleted >= 1,
      `expected each expired row deleted, got ${JSON.stringify(result)}`, logs);
    expect(await count(s, `referral_apply_tokens WHERE token_hash = ANY($1::text[])`, [[rows.expiredToken]])).toBe(0);
    expect(await count(s, `referral_apply_tokens WHERE token_hash = $1`, [rows.freshToken])).toBe(1);
    expect(await count(s, `referral_pending_claims WHERE phone_hash = $1`, [rows.expiredClaim])).toBe(0);
    expect(await count(s, `referral_pending_claims WHERE phone_hash = $1`, [rows.freshClaim])).toBe(1);
    expect(await count(s, `job_share_opens WHERE id = $1`, [rows.oldOpen])).toBe(0);
    expect(await count(s, `job_share_opens WHERE id = $1`, [rows.recentOpen])).toBe(1);
  });
});
