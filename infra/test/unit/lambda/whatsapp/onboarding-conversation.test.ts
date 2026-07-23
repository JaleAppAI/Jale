/**
 * Onboarding conversation — full multi-turn conversation test.
 *
 * processor.test.ts (owned by another agent in this sprint) exercises the
 * processor Lambda one handler/state-transition at a time, each with its own
 * hand-built chain of `mockQuery.mockResolvedValueOnce(...)` calls. That is
 * excellent coverage of individual transitions but never proves the *whole*
 * conversation — new -> awaiting_otp -> awaiting_legal -> ... -> idle -> a
 * post-onboarding command — actually chains together across sequential SQS
 * deliveries for one phone number, with state persisted in between turns the
 * way it would be in Postgres.
 *
 * This file closes that gap. Instead of a giant per-turn
 * `mockResolvedValueOnce` chain (which would be ~150 entries deep and
 * unreadable), the Postgres client is replaced with a small in-memory,
 * SQL-pattern-matching fake: one mutable `conv` row and one mutable `user`
 * row that persist across `handler()` invocations exactly like real DB rows
 * would, plus an in-memory `whatsapp_outbox` table that
 * `sendPendingOutbox`'s SELECT/UPDATE calls actually operate against. Each
 * `handler()` call below is a distinct SQS delivery (own MessageSid), so
 * this is as close to "the real conversation, end to end" as a unit test
 * gets without a live Postgres instance.
 *
 * Mock module setup (AWS SDK clients, global.fetch, lib/db, lib/media,
 * lib/job-matching) mirrors processor.test.ts's scaffolding — duplicated
 * here deliberately rather than imported, since this file must not import
 * from or modify processor.test.ts.
 */

// ── Mocks (must come before the handler import) ────────────────────────────

const mockCognitoSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
  AdminCreateUserCommand: jest.fn((args) => ({ input: args, __type: 'AdminCreateUser' })),
  AdminAddUserToGroupCommand: jest.fn((args) => ({ input: args, __type: 'AdminAddUserToGroup' })),
  AdminEnableUserCommand: jest.fn((args) => ({ input: args, __type: 'AdminEnableUser' })),
  AdminGetUserCommand: jest.fn((args) => ({ input: args, __type: 'AdminGetUser' })),
  AdminSetUserPasswordCommand: jest.fn((args) => ({ input: args, __type: 'AdminSetUserPassword' })),
  AdminUpdateUserAttributesCommand: jest.fn((args) => ({ input: args, __type: 'AdminUpdateUserAttributes' })),
  InitiateAuthCommand: jest.fn((args) => ({ input: args, __type: 'InitiateAuth' })),
  RespondToAuthChallengeCommand: jest.fn((args) => ({ input: args, __type: 'RespondToAuthChallenge' })),
  AuthFlowType: { CUSTOM_AUTH: 'CUSTOM_AUTH' },
  ChallengeNameType: { CUSTOM_CHALLENGE: 'CUSTOM_CHALLENGE' },
}));

const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args, __type: 'GetSecretValue' })),
}));

const mockSfnSend = jest.fn();
jest.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: jest.fn(() => ({ send: mockSfnSend })),
  StartExecutionCommand: jest.fn((args) => ({ input: args, __type: 'StartExecution' })),
}), { virtual: true });

const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((args) => ({ input: args, __type: 'Invoke' })),
}));

jest.mock('../../../../lambda/whatsapp/lib/media', () => ({
  detectMediaCategory: jest.fn(),
  buildS3Key: jest.fn((userId: string, mediaId: string, type: string) => `${userId}/${type}/${mediaId}`),
  downloadTwilioMedia: jest.fn(),
  uploadMediaToS3: jest.fn(),
  ALLOWED_PHOTO_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
  ALLOWED_VOICE_TYPES: ['audio/ogg', 'audio/mpeg', 'audio/mp4'],
}));

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();
jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({ connect: mockConnect })),
  setRlsContext: jest.fn(),
  setInternalUserRlsContext: jest.fn((client: any, userId: string) =>
    client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [userId])),
}));

const mockListMatchedJobsForWorker = jest.fn();
jest.mock('../../../../lambda/lib/job-matching', () => ({
  listMatchedJobsForWorker: mockListMatchedJobsForWorker,
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { handler } from '../../../../lambda/whatsapp/processor';

// ── SQS event helpers ───────────────────────────────────────────────────

function makeSqsEvent(params: Record<string, string>): any {
  return {
    Records: [{
      messageId: 'sqs-1',
      receiptHandle: '',
      body: new URLSearchParams(params).toString(),
      attributes: {} as any,
      messageAttributes: {} as any,
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: '',
      awsRegion: 'us-east-2',
    }],
  };
}

const PHONE = '+15125559999';
const FROM = `whatsapp:${PHONE}`;
const CORRECT_OTP = '123456';
const REAL_SUB = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

function fakeIdToken(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.sig`;
}

async function send(params: Record<string, string>): Promise<void> {
  await handler(makeSqsEvent(params), {} as any, {} as any);
}

// ── In-memory fake Postgres client ──────────────────────────────────────
//
// Rather than a ~150-entry mockResolvedValueOnce chain, this small SQL
// pattern-matcher stands in for Postgres across a whole conversation. `conv`
// and `user` are single mutable rows (this test only ever has one phone
// number and one worker) that UPDATE statements mutate in place, and
// `outbox` is a real array that the queue-insert / sendPendingOutbox
// select / sendPendingOutbox update queries all operate against — so state
// genuinely carries across sequential `handler()` calls the way Postgres
// rows would.

interface OutboxRow {
  id: string;
  inbound_message_sid: string;
  sequence: number;
  whatsapp_number: string;
  body: string | null;
  content_template: string | null;
  content_variables: Record<string, unknown> | null;
  status: string;
}

let conv: any = null;
let user: any = null;
let outbox: OutboxRow[] = [];
let processedMessages: Map<string, { status: string }> = new Map();
let outboxSeq = 1;

function resetFakeDb(): void {
  conv = null;
  user = null;
  outbox = [];
  processedMessages = new Map();
  outboxSeq = 1;
}

function extractSetFields(sql: string): Array<{ field: string; paramIndex: number }> {
  const setClauseMatch = sql.match(/SET([\s\S]*?)WHERE/i);
  if (!setClauseMatch) return [];
  const fields: Array<{ field: string; paramIndex: number }> = [];
  const fieldRegex = /(\w+)\s*=\s*\$(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRegex.exec(setClauseMatch[1]))) {
    if (m[1] === 'updated_at') continue;
    fields.push({ field: m[1], paramIndex: parseInt(m[2], 10) - 1 });
  }
  return fields;
}

function applyGenericUpdate(sql: string, params: unknown[], row: Record<string, any>): void {
  for (const { field, paramIndex } of extractSetFields(sql)) {
    let value: any = params[paramIndex];
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
      try { value = JSON.parse(value); } catch { /* not JSON, keep raw string */ }
    }
    row[field] = value;
  }
}

function nextOutboxRow(sid: string, whatsappNumber: string): number {
  return outbox.filter((r) => r.inbound_message_sid === sid).length + 1;
}

function fakeQuery(sql: string, params: unknown[] = []): { rowCount: number; rows: any[] } {
  // ── transaction control ──────────────────────────────────────────────
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) {
    return { rowCount: 0, rows: [] };
  }

  // ── Task 6 v2 routing branch decision ────────────────────────────────
  //
  // routeMessage's fail-closed v2 branch reads DB-backed runtime controls
  // before any legacy handling. This suite drives only legacy phones, so
  // every real row lookup here comes back empty (no whatsapp_runtime_controls
  // row for this test's phone) — isV2Enabled then fails closed to disabled
  // and the state machine below runs bit-identically to before Task 6.
  if (/FROM whatsapp_runtime_controls/i.test(sql)) {
    return { rowCount: 0, rows: [] };
  }

  // ── whatsapp_processed_messages claim lifecycle ─────────────────────
  if (/INSERT INTO whatsapp_processed_messages/i.test(sql)) {
    const [sid, whatsappNumber] = params as string[];
    if (processedMessages.has(sid)) return { rowCount: 0, rows: [] };
    processedMessages.set(sid, { status: 'processing' });
    void whatsappNumber;
    return { rowCount: 1, rows: [{ message_sid: sid }] };
  }
  if (/UPDATE whatsapp_processed_messages\s+SET status = 'db_committed'/i.test(sql)) {
    const [sid] = params as string[];
    const rec = processedMessages.get(sid);
    if (rec) rec.status = 'db_committed';
    return { rowCount: 1, rows: [] };
  }
  if (/UPDATE whatsapp_processed_messages\s+SET status = 'completed'/i.test(sql)) {
    const [sid] = params as string[];
    const rec = processedMessages.get(sid);
    if (rec) rec.status = 'completed';
    return { rowCount: 1, rows: [] };
  }

  // ── whatsapp_conversations ───────────────────────────────────────────
  if (/FROM whatsapp_conversations/i.test(sql) && /FOR UPDATE/i.test(sql)) {
    if (!conv) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{ ...conv }] };
  }
  if (/INSERT INTO whatsapp_conversations/i.test(sql)) {
    const [whatsappNumber, language] = params as string[];
    conv = {
      id: 'conv-1',
      user_id: null,
      whatsapp_number: whatsappNumber,
      language,
      conversation_state: 'new',
      state_context: {},
      otp_attempts: 0,
      otp_expires_at: null,
      last_processed_message_sid: null,
      focused_job_conversation_id: null,
    };
    return { rowCount: 1, rows: [{ ...conv }] };
  }
  if (/UPDATE whatsapp_conversations SET/i.test(sql)) {
    if (!conv) throw new Error('fakeQuery: UPDATE whatsapp_conversations with no conv row');
    applyGenericUpdate(sql, params, conv);
    return { rowCount: 1, rows: [] };
  }

  // ── users: web-worker bypass check (always no match in this test) ───
  if (/SELECT id FROM users\s+WHERE phone = \$1\s+AND user_type = 'worker'\s+AND tos_accepted_at IS NOT NULL/i.test(sql)) {
    return { rowCount: 0, rows: [] };
  }

  // ── users: resolveWorkerIdForWhatsappNumber (relay identity lookup) ──
  if (/FROM users u\s+WHERE u\.user_type = 'worker'\s+AND \(u\.whatsapp_number = \$1 OR u\.phone = \$1\)/i.test(sql)) {
    const [normalized] = params as string[];
    if (user && (user.whatsapp_number === normalized || user.phone === normalized)) {
      return { rowCount: 1, rows: [{ id: user.id }] };
    }
    return { rowCount: 0, rows: [] };
  }

  // ── users: defensive placeholder insert (handleNewOrRestart) ────────
  if (/INSERT INTO users \(cognito_sub, user_type, phone\)/i.test(sql)) {
    const [cognitoSub, phone] = params as string[];
    if (!user) {
      user = {
        id: 'user-1',
        cognito_sub: cognitoSub,
        user_type: 'worker',
        phone,
        whatsapp_number: null,
        full_name: null,
        city: null,
        main_trade: null,
        main_trade_other: null,
        years_experience: null,
        has_transportation: null,
        availability: null,
        tos_version: null,
        tos_accepted_at: null,
        privacy_version: null,
        privacy_accepted_at: null,
        trust_signals: null,
        trust_signals_completed_at: null,
      };
    }
    return { rowCount: 1, rows: [] };
  }

  // ── users: reconcileUserRow — existing-by-realSub lookup (Case A/B) ──
  if (/SELECT id, tos_version FROM users\s+WHERE cognito_sub = \$1 AND user_type = 'worker'/i.test(sql)) {
    const [cognitoSub] = params as string[];
    if (user && user.cognito_sub === cognitoSub) {
      return { rowCount: 1, rows: [{ id: user.id, tos_version: user.tos_version }] };
    }
    return { rowCount: 0, rows: [] };
  }

  // ── users: reconcileUserRow — Case A promote placeholder in place ───
  if (/UPDATE users\s+SET cognito_sub = \$1/i.test(sql)) {
    const [realSub, whatsappNumber] = params as string[];
    if (!user || user.cognito_sub !== whatsappNumber) return { rowCount: 0, rows: [] };
    user.cognito_sub = realSub;
    user.whatsapp_number = whatsappNumber;
    return { rowCount: 1, rows: [{ id: user.id, tos_version: user.tos_version }] };
  }

  // ── users: handleAwaitingLegal cognito_sub lookup ────────────────────
  if (/SELECT cognito_sub FROM users WHERE id = \$1/i.test(sql)) {
    const [id] = params as string[];
    if (user && user.id === id) return { rowCount: 1, rows: [{ cognito_sub: user.cognito_sub }] };
    return { rowCount: 0, rows: [] };
  }

  // ── users: ToS/privacy acceptance ────────────────────────────────────
  if (/UPDATE users\s+SET tos_version = \$2/i.test(sql)) {
    const [id, version] = params as string[];
    if (
      user
      && user.id === id
      && (user.tos_version !== version || user.privacy_version !== version)
    ) {
      user.tos_version = version;
      user.tos_accepted_at = new Date().toISOString();
      user.privacy_version = version;
      user.privacy_accepted_at = new Date().toISOString();
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }
  if (/UPDATE users\s+SET tos_version = \$1/i.test(sql)) {
    const [version, cognitoSub] = params as string[];
    if (user && user.cognito_sub === cognitoSub && user.tos_version !== version) {
      user.tos_version = version;
      user.tos_accepted_at = new Date().toISOString();
      user.privacy_version = version;
      user.privacy_accepted_at = new Date().toISOString();
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }
  if (/INSERT INTO legal_consent_log/i.test(sql)) {
    return { rowCount: 1, rows: [] };
  }

  // ── users: profile-flow reads ────────────────────────────────────────
  if (/SELECT full_name, city, main_trade, main_trade_other,\s*years_experience, has_transportation, availability\s*FROM users WHERE id = \$1/i.test(sql)) {
    const [id] = params as string[];
    if (!user || user.id !== id) return { rowCount: 0, rows: [] };
    const { full_name, city, main_trade, main_trade_other, years_experience, has_transportation, availability } = user;
    return {
      rowCount: 1,
      rows: [{ full_name, city, main_trade, main_trade_other, years_experience, has_transportation, availability }],
    };
  }
  if (/SELECT main_trade FROM users WHERE id = \$1/i.test(sql)) {
    return { rowCount: 1, rows: [{ main_trade: user?.main_trade ?? null }] };
  }
  if (/SELECT trust_signals_completed_at FROM users WHERE id = \$1/i.test(sql)) {
    return { rowCount: 1, rows: [{ trust_signals_completed_at: user?.trust_signals_completed_at ?? null }] };
  }

  // ── users: trust_signals write (known-trade path) ────────────────────
  if (/UPDATE users\s+SET trust_signals = \$1/i.test(sql)) {
    const [signalsJson] = params as string[];
    if (!user) throw new Error('fakeQuery: trust_signals update with no user row');
    user.trust_signals = JSON.parse(signalsJson);
    user.trust_signals_completed_at = new Date().toISOString();
    return { rowCount: 1, rows: [] };
  }

  // ── trade_questions: no seeded rows -> skip the async trust-scorer path
  if (/FROM trade_questions WHERE profession_key/i.test(sql)) {
    return { rowCount: 0, rows: [] };
  }

  // ── information_schema.columns existence checks (always available) ──
  if (/information_schema\.columns/i.test(sql)) {
    return { rowCount: 1, rows: [{ exists: true }] };
  }

  // ── users: flushProfileAndAdvance dynamic profile-field UPDATE ──────
  if (/UPDATE users SET/i.test(sql) && /WHERE id = \$1 AND user_type = 'worker'/i.test(sql)) {
    if (!user) throw new Error('fakeQuery: profile flush with no user row');
    applyGenericUpdate(sql, params, user);
    return { rowCount: 1, rows: [] };
  }

  // ── worker_profiles / worker_skills upsert (profile-flow) ────────────
  if (/INSERT INTO worker_profiles/i.test(sql) || /INSERT INTO worker_skills/i.test(sql)) {
    return { rowCount: 1, rows: [] };
  }

  // ── whatsapp_outbox: queue insert (body or content_template variant) ─
  if (/INSERT INTO whatsapp_outbox/i.test(sql)) {
    const sid = params[0] as string;
    const whatsappNumber = params[1] as string;
    const isTemplate = /content_template/i.test(sql);
    const row: OutboxRow = {
      id: `o-${outboxSeq++}`,
      inbound_message_sid: sid,
      sequence: nextOutboxRow(sid, whatsappNumber),
      whatsapp_number: whatsappNumber,
      body: isTemplate ? null : (params[2] as string),
      content_template: isTemplate ? (params[2] as string) : null,
      content_variables: isTemplate ? (params[3] as Record<string, unknown>) : null,
      status: 'pending',
    };
    outbox.push(row);
    return { rowCount: 1, rows: [] };
  }

  // ── whatsapp_outbox: sendPendingOutbox drain ─────────────────────────
  if (/SELECT id, sequence, whatsapp_number, body, content_template, content_variables\s*\n?\s*FROM whatsapp_outbox/i.test(sql)) {
    const [sid] = params as string[];
    const rows = outbox
      .filter((r) => r.inbound_message_sid === sid && (r.status === 'pending' || r.status === 'failed'))
      .sort((a, b) => a.sequence - b.sequence);
    return { rowCount: rows.length, rows };
  }
  if (/UPDATE whatsapp_outbox\s+SET status = 'sent'/i.test(sql)) {
    const [id] = params as string[];
    const row = outbox.find((r) => r.id === id);
    if (row) row.status = 'sent';
    return { rowCount: 1, rows: [] };
  }

  throw new Error(`onboarding-conversation.test fakeQuery: unhandled SQL:\n${sql}\nparams=${JSON.stringify(params)}`);
}

// ── Outbox assertion helpers ─────────────────────────────────────────────

function outboxForSid(sid: string): OutboxRow[] {
  return outbox.filter((r) => r.inbound_message_sid === sid).sort((a, b) => a.sequence - b.sequence);
}

function firstBodyForSid(sid: string): string | null {
  return outboxForSid(sid).find((r) => r.body !== null)?.body ?? null;
}

function firstTemplateForSid(sid: string): string | null {
  return outboxForSid(sid).find((r) => r.content_template !== null)?.content_template ?? null;
}

// ── Suite ─────────────────────────────────────────────────────────────────

describe('WhatsApp onboarding — full conversation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    resetFakeDb();

    process.env = {
      ...originalEnv,
      WORKER_POOL_ID: 'pool-abc',
      WORKER_CLIENT_ID: 'client-abc',
      TWILIO_SECRET_ARN: 'arn:twilio',
      TWILIO_STATUS_CALLBACK_URL: 'https://callbacks.example.test/prod/whatsapp/status-callback',
      DB_SECRET_ARN: 'arn:db',
      REQUIRED_TOS_VERSION: '1.0',
    };

    mockQuery.mockImplementation((sql: string, params: unknown[]) => fakeQuery(sql, params));
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test',
        authToken: 'tok_test',
        messagingServiceSid: 'MGtest_svc',
        templates: {},
      }),
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ sid: 'SM11111111111111111111111111111111' }),
    });

    mockCognitoSend.mockImplementation(async (command: any) => {
      switch (command.__type) {
        case 'AdminCreateUser':
        case 'AdminSetUserPassword':
          return {};
        case 'InitiateAuth':
          return { Session: `SESSION-${Math.random()}`, ChallengeName: 'CUSTOM_CHALLENGE' };
        case 'RespondToAuthChallenge': {
          const otp = command.input.ChallengeResponses.ANSWER;
          if (otp === CORRECT_OTP) {
            return { AuthenticationResult: { IdToken: fakeIdToken(REAL_SUB) } };
          }
          return { ChallengeName: 'CUSTOM_CHALLENGE', Session: `SESSION-retry-${Math.random()}` };
        }
        default:
          throw new Error(`onboarding-conversation.test: unhandled Cognito command ${command.__type}`);
      }
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('drives new -> awaiting_otp -> awaiting_legal -> building_profile -> building_trust_signal -> idle, then recognizes "help." from idle', async () => {
    // ── Turn 1: "hello" -> new conversation created, OTP requested ──────
    await send({ MessageSid: 'SM-1', From: FROM, Body: 'hello' });

    expect(conv).not.toBeNull();
    expect(conv.conversation_state).toBe('awaiting_otp');
    expect(conv.state_context.cognito_session).toBeTruthy();
    expect(mockCognitoSend).toHaveBeenCalledWith(
      expect.objectContaining({ __type: 'InitiateAuth' }),
    );
    expect(firstBodyForSid('SM-1')).toMatch(/verification code|codigo de verificacion/i);

    // ── Turn 2: correct OTP -> awaiting_legal, legal prompt queued ──────
    await send({ MessageSid: 'SM-2', From: FROM, Body: CORRECT_OTP });

    expect(conv.conversation_state).toBe('awaiting_legal');
    expect(user).not.toBeNull();
    expect(user.cognito_sub).toBe(REAL_SUB);
    expect(firstTemplateForSid('SM-2')).toMatch(/^onboarding_legal_/);

    // ── Turn 3: legal:accept button -> consent recorded, profile flow begins
    await send({ MessageSid: 'SM-3', From: FROM, Body: '', ButtonPayload: 'legal:accept' });

    expect(user.tos_version).toBe('1.0');
    expect(user.tos_accepted_at).toBeTruthy();
    // The code enters the optional voice-vs-text choice before building_profile —
    // assert what the code actually does rather than assuming a fixed state name.
    expect(conv.conversation_state).toBe('awaiting_media_voice');
    expect(firstTemplateForSid('SM-3')).toMatch(/^onboarding_voice_choice_/);

    // ── Turn 4: worker types instead of sending voice -> building_profile
    await send({ MessageSid: 'SM-4', From: FROM, Body: 'texto, prefiero escribir' });

    expect(conv.conversation_state).toBe('building_profile');
    expect(conv.state_context.pending_field).toBe('full_name');
    expect(firstBodyForSid('SM-4')).toMatch(/full name|nombre completo/i);

    // ── Turn 5-6: typed text answers (full_name, city) ───────────────────
    await send({ MessageSid: 'SM-5', From: FROM, Body: 'Luis Worker' });
    expect(conv.state_context.collected.full_name).toBe('Luis Worker');
    expect(conv.state_context.pending_field).toBe('city');

    await send({ MessageSid: 'SM-6', From: FROM, Body: 'Denver' });
    expect(conv.state_context.collected.city).toBe('Denver');
    expect(conv.state_context.pending_field).toBe('main_trade');
    expect(firstTemplateForSid('SM-6')).toMatch(/^onboarding_trade_/);

    // ── Turn 7-9: button-payload answers (main_trade, years_experience,
    //     has_transportation) ───────────────────────────────────────────
    await send({
      MessageSid: 'SM-7', From: FROM, Body: '', ButtonPayload: 'profile:main_trade:electrician',
    });
    expect(conv.state_context.collected.main_trade).toBe('electrician');
    // main_trade !== 'other', so main_trade_other is skipped.
    expect(conv.state_context.pending_field).toBe('years_experience');

    await send({
      MessageSid: 'SM-8', From: FROM, Body: '', ButtonPayload: 'profile:years_experience:2-4',
    });
    expect(conv.state_context.collected.years_experience).toBe('2-4');
    expect(conv.state_context.pending_field).toBe('has_transportation');

    await send({
      MessageSid: 'SM-9', From: FROM, Body: '', ButtonPayload: 'profile:has_transportation:true',
    });
    expect(conv.state_context.collected.has_transportation).toBe(true);
    expect(conv.state_context.pending_field).toBe('availability');

    // ── Turn 10: final profile answer -> flush to users row, advance to
    //     the trust-signal flow (known trade "electrician") ──────────────
    await send({
      MessageSid: 'SM-10', From: FROM, Body: '', ButtonPayload: 'profile:availability:full_time',
    });

    expect(user.full_name).toBe('Luis Worker');
    expect(user.city).toBe('Denver');
    expect(user.main_trade).toBe('electrician');
    expect(user.years_experience).toBe('2-4');
    expect(user.has_transportation).toBe(true);
    expect(user.availability).toBe('full_time');
    expect(conv.conversation_state).toBe('building_trust_signal');
    expect(conv.state_context.trust_step).toBe(0);
    expect(firstTemplateForSid('SM-10')).toMatch(/^trust_choice_/);

    // ── Turn 11-13: trust questions (specialization, seniority, tasks) ──
    await send({ MessageSid: 'SM-11', From: FROM, Body: '1' });
    expect(conv.state_context.trust_step).toBe(1);

    await send({ MessageSid: 'SM-12', From: FROM, Body: '2' });
    expect(conv.state_context.trust_step).toBe(2);

    await send({ MessageSid: 'SM-13', From: FROM, Body: '1' });

    expect(user.trust_signals).toBeTruthy();
    expect(user.trust_signals).toHaveProperty('specialization');
    expect(user.trust_signals).toHaveProperty('seniority');
    expect(user.trust_signals).toHaveProperty('tasks');
    expect(user.trust_signals_completed_at).toBeTruthy();
    // Trust signals complete -> optional photo upload step.
    expect(conv.conversation_state).toBe('awaiting_media_photo');
    expect(conv.state_context.profile_completed).toBe(true);

    // ── Turn 14: skip the optional photo -> idle ─────────────────────────
    await send({ MessageSid: 'SM-14', From: FROM, Body: 'skip' });

    expect(conv.conversation_state).toBe('idle');

    // ── Turn 15: "help." (trailing period) from idle -> tolerant matching
    //     recognizes it as the help command and queues the command menu ──
    await send({ MessageSid: 'SM-15', From: FROM, Body: 'help.' });

    expect(conv.conversation_state).toBe('idle');
    const helpTemplate = firstTemplateForSid('SM-15');
    const helpBody = firstBodyForSid('SM-15');
    if (helpTemplate) {
      // Covers the upcoming interactive list-picker variant (concurrent work):
      // 'help_menu' today, 'help_menu_list_en'/'help_menu_list_es' once added.
      expect(helpTemplate).toMatch(/^help_menu/);
    } else {
      // Current implementation: a plain-body command menu.
      expect(helpBody).toMatch(/commands|comandos/i);
    }
  });

  it('recognizes punctuation-tolerant help variants from a seeded idle conversation', async () => {
    // Seed a conversation already in `idle` with a linked worker, bypassing
    // the full onboarding walk — this isolates the tolerant-matching
    // behavior itself from the rest of the state machine.
    user = {
      id: 'user-seed',
      cognito_sub: REAL_SUB,
      user_type: 'worker',
      phone: PHONE,
      whatsapp_number: PHONE,
      full_name: 'Seed Worker',
      city: 'Denver',
      main_trade: 'electrician',
      main_trade_other: null,
      years_experience: '2-4',
      has_transportation: true,
      availability: 'full_time',
      tos_version: '1.0',
      tos_accepted_at: new Date().toISOString(),
      privacy_version: '1.0',
      privacy_accepted_at: new Date().toISOString(),
      trust_signals: { specialization: {}, seniority: {}, tasks: {} },
      trust_signals_completed_at: new Date().toISOString(),
    };
    conv = {
      id: 'conv-seed',
      user_id: user.id,
      whatsapp_number: PHONE,
      language: 'en',
      conversation_state: 'idle',
      state_context: {},
      otp_attempts: 0,
      otp_expires_at: null,
      last_processed_message_sid: null,
      focused_job_conversation_id: null,
    };

    await send({ MessageSid: 'SM-help-1', From: FROM, Body: '¡Ayuda!' });

    expect(conv.conversation_state).toBe('idle');
    const template = firstTemplateForSid('SM-help-1');
    const body = firstBodyForSid('SM-help-1');
    if (template) {
      expect(template).toMatch(/^help_menu/);
    } else {
      expect(body).toMatch(/commands|comandos/i);
    }
  });
});
