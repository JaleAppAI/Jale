/**
 * d-app-whatsapp-context.integration.test.ts
 *
 * The change records for the work done on the WhatsApp
 * engine's login, jale_whatsapp. Each test drives a real entry point end to
 * end against a real PostgreSQL bed and reads back the jale_audit.changes
 * rows its request id produced:
 *
 *   - an inbound message from a number that is not bound yet, carrying the
 *     sign-up code: the account it creates is written by an anonymous actor
 *     with no id; anything after the bind is the worker's, never the other
 *     way round;
 *   - a bound worker's message (a support request) names the worker;
 *   - the platform's own work names the platform, with no id: the profile
 *     written from a voice note, the admin reply drain, and the delivery
 *     status callback.
 *
 * Request ids are the Lambda invocation ids (API Gateway's for the status
 * callback), never a provider message id. Every test also checks that its
 * request left no change record without a context about the people it
 * touched.
 *
 * Stand-ins: Cognito answers the code with an id token built here; Secrets
 * Manager hands out a provider credential generated per run; S3 and
 * Bedrock answer the voice-note pipeline; the outbox's per-message sender is
 * replaced, and the admin drain's provider call is answered by a stand-in
 * for fetch. Any other AWS call or network request fails the test.
 * Fixtures: r-paths-world.ts and r-paths-sweep-fixtures.ts, unchanged.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import { fakePhone, FIXTURE_TOS_VERSION } from './r-paths-world';
import { describeInProfiles, loginUrl } from './helpers/login-pool';
import {
  closeScene, count, expectStatus, invoke, LogCapture, openScene, run, seed, sweepEvent, sweepWorker, type SweepScene,
} from './r-paths-sweep-fixtures';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

jest.setTimeout(60_000);

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');
const sha256 = (raw: string): string => createHash('sha256').update(raw).digest('hex');

// ── Environment (fake values only), before any handler module loads ───────
const STATUS_CALLBACK_URL = 'https://fixture.invalid/whatsapp/status-callback';
process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
process.env.TWILIO_SECRET_ARN = 'fixture-twilio-secret';
process.env.TWILIO_STATUS_CALLBACK_URL = STATUS_CALLBACK_URL;
process.env.WORKER_POOL_ID = 'fixture-worker-pool';
process.env.WORKER_CLIENT_ID = 'fixture-worker-client';
process.env.MEDIA_BUCKET_NAME = 'fixture-media-bucket';
process.env.BEDROCK_MODEL_ID = 'fixture-model';
process.env.AI_EXTRACTION_CONFIDENCE_THRESHOLD = '0.75';
process.env.AI_INDUSTRY_KEYWORDS = '["electrician"]';

/** The provider credential every stand-in hands out, generated per run. */
const mockTwilioSecret = {
  accountSid: `AC${hex(16)}`,
  authToken: hex(16),
  messagingServiceSid: `MG${hex(16)}`,
  templates: {},
};

// ── The database: each entry point gets a checked pool on its real login ───
let mockCurrentPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return {
    ...actual,
    getDbPool: async () => {
      if (!mockCurrentPool) throw new Error('whatsapp context: no login pool is open');
      return mockCurrentPool;
    },
  };
});

// ── AWS SDK clients: the real Command classes, a recording client ──────────
type SentCommand = { constructor: { name: string }; input?: any };

/** What the stand-ins answer for the test in progress. */
const mockScript = { idToken: '', transcript: '', extraction: '' };

const mockAwsSend = jest.fn(async (service: string, command: SentCommand): Promise<unknown> => {
  switch (`${service}:${command.constructor.name}`) {
    case 'cognito:RespondToAuthChallengeCommand':
      return { AuthenticationResult: { IdToken: mockScript.idToken } };
    case 'secrets:GetSecretValueCommand':
      return { SecretString: JSON.stringify(mockTwilioSecret) };
    case 's3:GetObjectCommand':
      return { Body: { transformToString: async () => mockScript.transcript } };
    case 'bedrock:ConverseCommand':
      return { output: { message: { content: [{ text: mockScript.extraction }] } } };
    case 'sqs:SendMessageCommand':
      return { MessageId: `fixture-message-${randomUUID()}` };
    case 'lambda:InvokeCommand':
      return { StatusCode: 202 };
    default:
      throw new Error(`whatsapp context: unexpected AWS call ${service}:${command.constructor.name}`);
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

jest.mock('@aws-sdk/client-cognito-identity-provider', () =>
  mockSdkModule('@aws-sdk/client-cognito-identity-provider', 'CognitoIdentityProviderClient', 'cognito'));
jest.mock('@aws-sdk/client-secrets-manager', () =>
  mockSdkModule('@aws-sdk/client-secrets-manager', 'SecretsManagerClient', 'secrets'));
jest.mock('@aws-sdk/client-s3', () => mockSdkModule('@aws-sdk/client-s3', 'S3Client', 's3'));
jest.mock('@aws-sdk/client-bedrock-runtime', () =>
  mockSdkModule('@aws-sdk/client-bedrock-runtime', 'BedrockRuntimeClient', 'bedrock'));
jest.mock('@aws-sdk/client-sqs', () => mockSdkModule('@aws-sdk/client-sqs', 'SQSClient', 'sqs'));
jest.mock('@aws-sdk/client-lambda', () => mockSdkModule('@aws-sdk/client-lambda', 'LambdaClient', 'lambda'));
jest.mock('@aws-sdk/client-sfn', () => mockSdkModule('@aws-sdk/client-sfn', 'SFNClient', 'sfn'));

// The per-message reply sender: replies stay queued. The admin drain keeps
// its real sender, whose provider call the fetch stand-in answers.
jest.mock('../../../lambda/whatsapp/lib/outbox', () => {
  const actual = jest.requireActual('../../../lambda/whatsapp/lib/outbox');
  return { ...actual, sendPendingOutbox: jest.fn(async () => undefined) };
});

type EntryPoint = (event?: any, context?: any, callback?: any) => Promise<any>;

/** Entry points load lazily, so a module that fails at import fails one test. */
function load(modulePath: string): EntryPoint {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath).handler;
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

/** Change rows without a context (`unset` or `invalid`) written after `seq` about any of `subjects`. */
async function unnamedSince(s: SweepScene, seq: string, subjects: string[]): Promise<number> {
  const { rows } = await s.world.su.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jale_audit.changes
      WHERE seq > $1::bigint AND context_status <> 'set' AND subject_user_ids && $2::uuid[]`,
    [seq, subjects],
  );
  return rows[0].n;
}

/** Every change row of the request names `actor` on WhatsApp; returns the tables written. */
function expectNamed(changes: ChangeRow[], actor: { kind: string; id: string | null; surface: string; requestId: string }): string[] {
  expect(changes.length).toBeGreaterThan(0);
  for (const change of changes) {
    expect(change).toEqual(expect.objectContaining({
      actor_kind: actor.kind,
      actor_id: actor.id,
      channel: 'whatsapp',
      surface: actor.surface,
      request_id: actor.requestId,
      context_status: 'set',
      db_login: 'jale_whatsapp',
    }));
  }
  return [...new Set(changes.map((change) => change.table_name))].sort();
}

/** An unsigned id token whose only claim is the account sub. */
function idTokenFor(sub: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub })}.fixture-signature`;
}

/** One inbound WhatsApp message as the receiver queues it. */
function inboundRecord(input: { sid: string; number: string; body: string }) {
  const body = new URLSearchParams({ MessageSid: input.sid, From: `whatsapp:${input.number}`, Body: input.body, NumMedia: '0' });
  return {
    Records: [{
      messageId: `fixture-sqs-${randomUUID()}`,
      receiptHandle: 'fixture-receipt',
      body: body.toString(),
      attributes: { ApproximateReceiveCount: '1' },
      messageAttributes: {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: 'fixture-queue',
      awsRegion: 'fixture-region',
    }],
  };
}

/** Rows these tests create outside what World and the sweep scene remove. */
interface WhatsAppRows {
  numbers: string[];
  sids: string[];
  subs: string[];
  caseIds: string[];
}

describeInProfiles(['request', 'owner-unrestricted'], 'change records on the WhatsApp engine\'s login', () => {
  let scene: SweepScene | undefined;
  let rows: WhatsAppRows;
  let logs: LogCapture;
  let fetchSpy: jest.SpyInstance;

  async function openWorld(): Promise<SweepScene> {
    const s = await seed(() => openScene(databaseUrl!));
    scene = s;
    // Registered after the scene's own cleanup, so it runs first.
    s.world.onCleanup(async () => {
      const su = s.world.su;
      const users = [...s.world.users];
      await su.query(
        `DELETE FROM admin_case_events WHERE case_id IN (
           SELECT id FROM admin_cases WHERE id = ANY($1::uuid[]) OR user_id = ANY($2::uuid[])
              OR user_id IN (SELECT id FROM users WHERE cognito_sub = ANY($3::text[])))`,
        [rows.caseIds, users, rows.subs],
      );
      await su.query(`DELETE FROM whatsapp_outbox WHERE whatsapp_number = ANY($1::text[]) OR source_id = ANY($2::uuid[])`,
        [rows.numbers, rows.caseIds]);
      await su.query(
        `DELETE FROM admin_cases WHERE id = ANY($1::uuid[]) OR user_id = ANY($2::uuid[])
            OR user_id IN (SELECT id FROM users WHERE cognito_sub = ANY($3::text[]))`,
        [rows.caseIds, users, rows.subs],
      );
      await su.query(`DELETE FROM whatsapp_processed_messages WHERE message_sid = ANY($1::text[]) OR whatsapp_number = ANY($2::text[])`,
        [rows.sids, rows.numbers]);
      await su.query(`DELETE FROM worker_identity_challenges WHERE phone_hash = ANY($1::text[])`, [rows.numbers.map(sha256)]);
      await su.query(`DELETE FROM worker_profile_ai_extractions WHERE user_id = ANY($1::uuid[])`, [users]);
      await su.query(`DELETE FROM whatsapp_conversations WHERE whatsapp_number = ANY($1::text[])`, [rows.numbers]);
      if (rows.subs.length > 0) {
        await su.query(`DELETE FROM legal_consent_log WHERE user_id IN (SELECT id FROM users WHERE cognito_sub = ANY($1::text[]))`,
          [rows.subs]);
        await su.query(`DELETE FROM users WHERE cognito_sub = ANY($1::text[])`, [rows.subs]);
      }
    });
    return s;
  }

  /** A checked pool on jale_whatsapp for the duration of `fn`, ended afterwards. */
  async function asWhatsApp<T>(fn: () => Promise<T>): Promise<T> {
    mockCurrentPool = await createCheckedPool({ connectionString: loginUrl('jale_whatsapp'), max: 2 }, 'jale_whatsapp', 'test');
    logs.watchPool(mockCurrentPool);
    try {
      return await fn();
    } finally {
      const pool = mockCurrentPool;
      mockCurrentPool = undefined;
      await pool?.end();
    }
  }

  /** An admin case about `userId` and its pending reply on WhatsApp. */
  async function adminReply(s: SweepScene, userId: string, number: string, outbox: { status: string; sid?: string }) {
    const { rows: [supportCase] } = await s.world.su.query<{ id: string }>(
      `INSERT INTO admin_cases (case_type, status, summary, user_id) VALUES ('help_request', 'open', 'Fixture case', $1) RETURNING id`,
      [userId],
    );
    rows.caseIds.push(supportCase.id);
    await s.world.su.query(
      `INSERT INTO whatsapp_outbox (sequence, whatsapp_number, body, status, source_type, source_id, idempotency_key, twilio_message_sid,
                                    twilio_delivery_status)
       VALUES (1, $1, 'Fixture reply', $2, 'admin_case', $3, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE 'sent' END)`,
      [number, outbox.status, supportCase.id, `fixture-admin-reply:${randomUUID()}`, outbox.sid ?? null],
    );
    return supportCase.id;
  }

  beforeEach(() => {
    mockAwsSend.mockClear();
    rows = { numbers: [], sids: [], subs: [], caseIds: [] };
    logs = new LogCapture();
    logs.start();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('whatsapp context: unexpected network call');
    }) as typeof fetch);
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    logs.stop();
    const closing = scene;
    scene = undefined;
    await closeScene(closing);
  });

  // ── The inbound processor ──────────────────────────────────────────────

  it('an unbound number\'s sign-up code: the account is written by an anonymous actor, never the number', async () => {
    const s = await openWorld();
    const number = fakePhone();
    const sid = `SM${hex(16)}`;
    const sub = `fixture-wa-${randomUUID()}`;
    rows.numbers.push(number);
    rows.sids.push(sid);
    rows.subs.push(sub);
    await seed(() => s.world.su.query(
      `INSERT INTO worker_identity_challenges (phone_hash, provider_challenge_id, preferred_language, current_step_key, status, attempts, expires_at)
       VALUES ($1, $2, 'en', 'identity.verify_otp', 'pending', 0, now() + interval '10 minutes')`,
      [sha256(number), `fixture-session-${randomUUID()}`],
    ));
    mockScript.idToken = idTokenFor(sub);
    const before = await lastChangeSeq(s);
    const invocationId = randomUUID();
    await asWhatsApp(() => run(
      () => load('../../../lambda/whatsapp/processor')(inboundRecord({ sid, number, body: '123456' }), { awsRequestId: invocationId }, () => undefined),
      logs,
    ));
    const { rows: [account] } = await s.world.su.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub = $1`, [sub]);
    expect(account).toBeDefined();
    expect(await count(s, `whatsapp_conversations WHERE whatsapp_number = $1 AND user_id = $2`, [number, account.id])).toBe(1);

    const changes = await changesFor(s, invocationId);
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change).toEqual(expect.objectContaining({
        channel: 'whatsapp', surface: 'whatsapp.inbound', request_id: invocationId, context_status: 'set', db_login: 'jale_whatsapp',
      }));
      expect([['anonymous', null], ['worker', account.id]]).toContainEqual([change.actor_kind, change.actor_id]);
    }
    // The account itself is written before the bind, by an anonymous actor.
    const accountRows = changes.filter((change) => change.table_name === 'public.users');
    expect(accountRows.map((change) => change.operation)).toContain('insert');
    for (const change of accountRows) expect([change.actor_kind, change.actor_id]).toEqual(['anonymous', null]);
    // Once the worker is named, nothing after is anonymous.
    const firstWorker = changes.findIndex((change) => change.actor_kind === 'worker');
    if (firstWorker >= 0) {
      expect(changes.slice(firstWorker).every((change) => change.actor_kind === 'worker')).toBe(true);
    }
    expect(await unnamedSince(s, before, [account.id])).toBe(0);
  });

  it('a bound worker\'s support request names the worker', async () => {
    const s = await openWorld();
    const worker = await seed(() => sweepWorker(s, { lifecycle: 'ready', workflowLanguage: 'en', whatsappLanguage: 'en' }));
    const number = worker.phone!;
    const sid = `SM${hex(16)}`;
    rows.numbers.push(number);
    rows.sids.push(sid);
    const before = await lastChangeSeq(s);
    const invocationId = randomUUID();
    await asWhatsApp(() => run(
      () => load('../../../lambda/whatsapp/processor')(inboundRecord({ sid, number, body: 'support' }), { awsRequestId: invocationId }, () => undefined),
      logs,
    ));
    expect(await count(s, `admin_cases WHERE user_id = $1`, [worker.id])).toBe(1);
    const tables = expectNamed(await changesFor(s, invocationId), {
      kind: 'worker', id: worker.id, surface: 'whatsapp.inbound', requestId: invocationId,
    });
    expect(tables).toContain('public.admin_cases');
    expect(await unnamedSince(s, before, [worker.id])).toBe(0);
  });

  // ── Platform work on the shared login ─────────────────────────────────

  it('the profile written from a voice note names the platform, with no id', async () => {
    const s = await openWorld();
    const worker = await seed(() => sweepWorker(s, { whatsappLanguage: 'en' }));
    const number = worker.phone!;
    const sid = `MM${hex(16)}`;
    rows.numbers.push(number);
    rows.sids.push(sid);
    const { rows: [conversation] } = await s.world.su.query<{ id: string }>(
      `SELECT id FROM whatsapp_conversations WHERE user_id = $1`, [worker.id]);
    // The voice note itself, as the processor claimed it; the reply hangs off it.
    await seed(() => s.world.su.query(
      `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status) VALUES ($1, $2, 'completed')`,
      [sid, number],
    ));
    mockScript.transcript = JSON.stringify({ results: { transcripts: [{ transcript: 'Fixture voice note' }] } });
    mockScript.extraction = JSON.stringify({
      extracted_fields: { full_name: 'Fixture Voice Name' },
      confidence_scores: { full_name: 0.95 },
      summary_en: 'Fixture summary.',
      summary_es: 'Resumen de prueba.',
    });
    const before = await lastChangeSeq(s);
    const invocationId = randomUUID();
    await asWhatsApp(() => run(() => load('../../../lambda/whatsapp/ai-profile-writer')({
      userId: worker.id,
      conversationId: conversation.id,
      inboundMessageSid: sid,
      whatsappNumber: number,
      language: 'en',
      mediaBucketName: 'fixture-media-bucket',
      transcriptOutputKey: `${worker.id}/transcripts/fixture.json`,
      status: 'transcription_complete',
    }, { awsRequestId: invocationId }, () => undefined), logs));
    expect(await count(s, `users WHERE id = $1 AND full_name = 'Fixture Voice Name'`, [worker.id])).toBe(1);
    const tables = expectNamed(await changesFor(s, invocationId), {
      kind: 'platform', id: null, surface: 'whatsapp.ai_profile', requestId: invocationId,
    });
    expect(tables).toEqual(['public.users']);
    expect(await unnamedSince(s, before, [worker.id])).toBe(0);
  });

  it('the admin reply drain names the platform, with no id, when it records the delivery on the case', async () => {
    const s = await openWorld();
    const worker = await seed(() => sweepWorker(s));
    const number = worker.phone!;
    rows.numbers.push(number);
    const caseId = await seed(() => adminReply(s, worker.id, number, { status: 'pending' }));
    const sentSid = `SM${hex(16)}`;
    fetchSpy.mockImplementation((async () => ({
      ok: true, status: 201, json: async () => ({ sid: sentSid }),
    })) as unknown as typeof fetch);
    const before = await lastChangeSeq(s);
    const invocationId = randomUUID();
    await asWhatsApp(() => run(() => load('../../../lambda/whatsapp/admin-outbox-dispatcher')({}, { awsRequestId: invocationId }), logs));
    expect(await count(s, `admin_cases WHERE id = $1 AND details->>'lastOutboundTwilioSid' = $2`, [caseId, sentSid])).toBe(1);
    const changes = await changesFor(s, invocationId);
    const tables = expectNamed(changes, { kind: 'platform', id: null, surface: 'whatsapp.admin_outbox', requestId: invocationId });
    expect(tables).toEqual(['public.admin_cases']);
    expect(changes.some((change) => change.record_ids.includes(caseId))).toBe(true);
    expect(await unnamedSince(s, before, [worker.id])).toBe(0);
  });

  it('the delivery status callback names the platform, with no id, when it records the delivery on the case', async () => {
    const s = await openWorld();
    const worker = await seed(() => sweepWorker(s));
    const number = worker.phone!;
    const sentSid = `SM${hex(16)}`;
    rows.numbers.push(number);
    const caseId = await seed(() => adminReply(s, worker.id, number, { status: 'sent', sid: sentSid }));
    const params = { MessageSid: sentSid, MessageStatus: 'delivered' };
    const signed = STATUS_CALLBACK_URL + Object.keys(params).sort().map((key) => `${key}${params[key as keyof typeof params]}`).join('');
    const signature = createHmac('sha1', mockTwilioSecret.authToken).update(signed).digest('base64');
    const event = sweepEvent({
      httpMethod: 'POST', resource: '/whatsapp/status-callback',
      body: new URLSearchParams(params).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
    });
    const before = await lastChangeSeq(s);
    const response = await asWhatsApp(() => invoke(load('../../../lambda/whatsapp/status-callback'), event));
    expectStatus(response, 200, logs);
    expect(await count(s, `admin_cases WHERE id = $1 AND details->>'lastOutboundTwilioStatus' = 'delivered'`, [caseId])).toBe(1);
    const requestId: string = event.requestContext.requestId;
    const changes = await changesFor(s, requestId);
    const tables = expectNamed(changes, { kind: 'platform', id: null, surface: 'whatsapp.status_callback', requestId });
    expect(tables).toEqual(['public.admin_cases']);
    expect(changes.some((change) => change.record_ids.includes(caseId))).toBe(true);
    expect(await unnamedSince(s, before, [worker.id])).toBe(0);
  });
});

if (!databaseUrl) {
  test('CONCERN: the WhatsApp change context DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
