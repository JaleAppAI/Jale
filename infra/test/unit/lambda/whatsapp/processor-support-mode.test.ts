/**
 * Processor Lambda -- WhatsApp support mode, end to end through the REAL
 * onboarding router.
 *
 * processor.test.ts mocks `routeOnboardingV2`, so an unregistered number's
 * SOPORTE looks routable there while in production the onboarding engine
 * answers every message from a number that has not finished onboarding.
 * Here the engine is real and the database is a fake that answers by SQL
 * shape (not by call position), so these tests show what a worker at the
 * start step, at the code step or mid-onboarding actually gets back.
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

jest.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: jest.fn(() => ({ send: jest.fn() })),
  StartExecutionCommand: jest.fn((args) => ({ input: args })),
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn((args) => ({ input: args })),
}));

// The real sniffers, with the network edges replaced.
const mockDownload = jest.fn();
const mockUploadSupportMedia = jest.fn();
jest.mock('../../../../lambda/whatsapp/lib/media', () => ({
  ...jest.requireActual('../../../../lambda/whatsapp/lib/media'),
  downloadTwilioMediaBounded: (...args: unknown[]) => mockDownload(...args),
  uploadSupportMediaToS3: (...args: unknown[]) => mockUploadSupportMedia(...args),
}));

jest.mock('../../../../lambda/lib/moderation', () => ({ moderateImage: jest.fn() }));

const mockQuery = jest.fn();
jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({
    connect: () => Promise.resolve({ query: mockQuery, release: jest.fn() }),
  })),
  setRlsContext: jest.fn(),
  setInternalUserRlsContext: jest.fn((client: any, userId: string) =>
    client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [userId])),
}));

jest.mock('../../../../lambda/whatsapp/lib/runtime-controls', () => ({
  loadRuntimeControls: jest.fn(async () => ({ disabled: true })),
  isVoiceIntakeEnabled: jest.fn(() => false),
  hashNormalizedPhone: jest.fn((phone: string) => `hash:${phone}`),
}));

jest.mock('../../../../lambda/whatsapp/lib/outbox-wake', () => ({
  publishOutboxWakes: jest.fn(async () => ({ sent: 0, failed: 0 })),
}));

jest.mock('../../../../lambda/lib/audit/context');

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { handler } from '../../../../lambda/whatsapp/processor';
import { t } from '../../../../lambda/whatsapp/lib/templates';
import {
  buildSyntheticVoiceInboundBody,
  type TrustVoiceEventV2,
} from '../../../../lambda/whatsapp/lib/voice-events';

// ── The fake database ──────────────────────────────────────────────────────

const PHONE = '+15550102000';
const CONV_ID = 'conv-support-1';
const ADMIN_BASE_URL = 'https://admin.example.test';

interface World {
  conv: Record<string, unknown>;
  preAuth: Record<string, unknown> | null;
  gate: Record<string, unknown> | null;
  supportState: { case_open: boolean; idle: boolean; reentry_case_id: string | null };
  appendResult: { appended: boolean; status_changed: boolean; media_id: string | null };
  openedCase: { case_id: string; created: boolean };
}

let world: World;

function convRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONV_ID,
    user_id: null,
    whatsapp_number: PHONE,
    language: 'es',
    conversation_state: 'new',
    state_context: {},
    otp_attempts: 0,
    otp_expires_at: null,
    last_processed_message_sid: null,
    focused_job_conversation_id: null,
    support_case_id: null,
    support_last_activity_at: null,
    ...overrides,
  };
}

function preAuthRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'challenge-1',
    phone_hash: `hash:${PHONE}`,
    provider_challenge_id: 'provider-session-1',
    candidate_user_id: null,
    preferred_language: 'en',
    current_step_key: 'identity.verify_otp',
    context: {},
    status: 'pending',
    attempts: 0,
    expires_at: new Date(Date.now() + 5 * 60_000),
    locked_until: null,
    ...overrides,
  };
}

function inMode(caseId = 'case-1', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return convRow({ support_case_id: caseId, support_last_activity_at: new Date(), ...overrides });
}

/**
 * What the database would hold after the turn's own writes, so a second
 * turn sees them: the conversation's support columns, and the re-entry the
 * definer stops offering once a MENU exit is recorded after the reply.
 */
function applyWrites(sql: string, params: unknown[]): void {
  if (/UPDATE whatsapp_conversations/.test(sql) && /SET support_case_id = NULL/.test(sql)) {
    world.conv = { ...world.conv, support_case_id: null, support_last_activity_at: null };
  } else if (/UPDATE whatsapp_conversations/.test(sql) && /SET support_case_id = \$2/.test(sql)) {
    world.conv = { ...world.conv, support_case_id: params[1], support_last_activity_at: new Date() };
  }
  if (/support_record_mode_change/.test(sql)) {
    const [caseId, , entered, reason] = params;
    if (entered === false && reason === 'menu' && world.supportState.reentry_case_id === caseId) {
      world.supportState = { ...world.supportState, reentry_case_id: null };
    }
  }
}

function respond(sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
  applyWrites(sql, params);
  const one = (row: unknown) => ({ rows: [row], rowCount: 1 });
  if (/INSERT INTO whatsapp_processed_messages/.test(sql)) return one({ message_sid: params[0] });
  if (/FROM whatsapp_conversations\s+WHERE whatsapp_number = \$1\s+FOR UPDATE/.test(sql)) return one({ ...world.conv });
  if (/support_mode_state\(/.test(sql)) return one(world.supportState);
  if (/support_open_case\(/.test(sql)) return one(world.openedCase);
  if (/support_append_message\(/.test(sql)) return one(world.appendResult);
  if (/load_worker_pre_auth/.test(sql)) return world.preAuth ? one(world.preAuth) : { rows: [], rowCount: 0 };
  if (/save_worker_pre_auth/.test(sql)) {
    return one({ ...(world.preAuth ?? preAuthRow({ current_step_key: 'start.choose_language' })) });
  }
  if (/FROM worker_onboarding_state/.test(sql)) return world.gate ? one(world.gate) : { rows: [], rowCount: 0 };
  return { rows: [], rowCount: 0 };
}

function calls(pattern: RegExp): unknown[][] {
  return mockQuery.mock.calls.filter(([sql]) => pattern.test(String(sql))).map(([, params]) => params as unknown[]);
}

/** Plain text replies queued for this inbound message. */
function textReplies(): string[] {
  return mockQuery.mock.calls
    .filter(([sql]) => /INSERT INTO whatsapp_outbox/.test(String(sql)) && !/content_template/.test(String(sql)))
    .map(([, params]) => (params as unknown[])[2] as string);
}

/** Template (interactive) replies queued for this inbound message. */
function templateReplies(): string[] {
  return mockQuery.mock.calls
    .filter(([sql]) => /INSERT INTO whatsapp_outbox/.test(String(sql)) && /content_template/.test(String(sql)))
    .map(([, params]) => (params as unknown[])[2] as string);
}

const READY_GATE = {
  user_id: 'worker-1', lifecycle: 'ready', run_id: 'run-1', workflow_version: 1,
  current_step_key: 'trust.question.3', status: 'completed', preferred_language: 'es', lock_version: 9,
};

/** Starts the next turn of the same conversation with a fresh call log. */
function nextTurn(): void {
  mockQuery.mockClear();
  mockCognitoSend.mockClear();
}

function inbound(params: Record<string, string>): any {
  return {
    Records: [{
      messageId: 'sqs-1',
      receiptHandle: '',
      body: new URLSearchParams({ From: `whatsapp:${PHONE}`, MessageSid: 'SM-support-mode-1', ...params }).toString(),
      attributes: {} as any,
      messageAttributes: {} as any,
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: '',
      awsRegion: 'us-east-2',
    }],
  };
}

async function send(params: Record<string, string>): Promise<void> {
  await handler(inbound(params), {} as any, {} as any);
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(60)]);

describe('Processor -- WhatsApp support mode through the real onboarding router', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => respond(String(sql), params));
    world = {
      conv: convRow(),
      preAuth: null,
      gate: null,
      supportState: { case_open: false, idle: true, reentry_case_id: null },
      appendResult: { appended: true, status_changed: false, media_id: null },
      openedCase: { case_id: 'case-new', created: true },
    };
    process.env = {
      ...originalEnv,
      WORKER_POOL_ID: 'pool-fixture',
      WORKER_CLIENT_ID: 'client-fixture',
      TWILIO_SECRET_ARN: 'fixture-twilio-secret',
      TWILIO_STATUS_CALLBACK_URL: 'https://callbacks.example.test/prod/whatsapp/status-callback',
      DB_SECRET_ARN: 'fixture-db-secret',
      REQUIRED_TOS_VERSION: '1.0',
      ADMIN_BASE_URL,
      SUPPORT_MEDIA_BUCKET: 'fixture-support-media',
    };
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_fixture', authToken: 'fixture-token', messagingServiceSid: 'MG_fixture', templates: {},
      }),
    });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ sid: `SM${'1'.repeat(32)}` }) });
    mockCognitoSend.mockRejectedValue(Object.assign(new Error('session is expired'), { name: 'NotAuthorizedException' }));
    mockDownload.mockResolvedValue(JPEG);
    mockUploadSupportMedia.mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ── T1: SOPORTE reaches the team from any number ───────────────────────

  it('T1: an unregistered number typing "Soporte." opens a case and enters support mode instead of the start step', async () => {
    await send({ Body: 'Soporte.' });

    expect(templateReplies()).toEqual([]); // no start invitation
    expect(calls(/support_open_case\(/)).toEqual([[CONV_ID, null, 'es', 'Soporte.', ADMIN_BASE_URL]]);
    expect(textReplies()).toEqual([t('support_mode_entered', 'es')]);
    expect(calls(/load_worker_pre_auth/)).toHaveLength(0); // the engine never saw it
    expect(calls(/SET support_case_id = \$2/)).toEqual([[CONV_ID, 'case-new']]);
    expect(calls(/support_record_mode_change/)).toEqual([['case-new', CONV_ID, true, 'command']]);
  });

  it('T1: "Support" is answered, and recorded, in English even on a conversation that defaulted to Spanish', async () => {
    await send({ Body: 'Support' });

    expect(calls(/support_open_case\(/)).toEqual([[CONV_ID, null, 'en', 'Support', ADMIN_BASE_URL]]);
    expect(textReplies()).toEqual([t('support_mode_entered', 'en')]);
  });

  it('F5: "Support" leaves the bot language alone: no conversation write sets it', async () => {
    world.conv = convRow({ user_id: 'worker-1', conversation_state: 'idle', language: 'es' });

    await send({ Body: 'Support', NumMedia: '1', MediaUrl0: 'https://media.example.test/m/9', MediaContentType0: 'image/jpeg' });

    expect(calls(/support_open_case\(/)[0][2]).toBe('en');
    expect(textReplies()).toEqual([t('support_mode_entered', 'en')]);
    // The photo sent with the keyword is recorded in the keyword's language.
    expect(calls(/support_append_message\(/).map((p) => p[5])).toEqual(['en']);
    const languageWrites = mockQuery.mock.calls
      .filter(([sql]) => /UPDATE whatsapp_conversations/.test(String(sql)) && /language/.test(String(sql)));
    expect(languageWrites).toEqual([]);
    expect(world.conv.language).toBe('es');
  });

  it('T1: a worker mid-onboarding typing SOPORTE at a free-text step enters support mode; nothing is saved as an answer', async () => {
    world.conv = convRow({ user_id: 'worker-1', conversation_state: 'idle' });
    world.gate = {
      user_id: 'worker-1', lifecycle: 'onboarding', run_id: 'run-1', workflow_version: 1,
      current_step_key: 'trust.question.2', status: 'active', preferred_language: 'es', lock_version: 3,
    };

    await send({ Body: 'Soporte' });

    expect(calls(/support_open_case\(/)).toEqual([[CONV_ID, 'worker-1', 'es', 'Soporte', ADMIN_BASE_URL]]);
    expect(calls(/FROM worker_onboarding_state/)).toHaveLength(0);
    expect(textReplies()).toEqual([t('support_mode_entered', 'es')]);
  });

  // ── T2: in the mode the bot is quiet and the team gets everything ──────

  it('T2: text in the mode goes to the case with no reply', async () => {
    world.conv = inMode();
    world.supportState = { case_open: true, idle: false, reentry_case_id: null };

    await send({ Body: 'No me llega el codigo' });

    expect(calls(/support_append_message\(/)).toEqual([['case-1', CONV_ID, 'text', 'No me llega el codigo', null, 'es']]);
    expect(calls(/INSERT INTO whatsapp_outbox/)).toHaveLength(0);
    expect(calls(/load_worker_pre_auth/)).toHaveLength(0);
    expect(calls(/SET support_last_activity_at = now\(\)/)).toEqual([[CONV_ID]]);
  });

  it('T2: SOPORTE again in the mode is just another message, with no second acknowledgement', async () => {
    world.conv = inMode();
    world.supportState = { case_open: true, idle: false, reentry_case_id: null };

    await send({ Body: 'SOPORTE' });

    expect(calls(/support_open_case\(/)).toHaveLength(0);
    expect(calls(/support_append_message\(/)).toEqual([['case-1', CONV_ID, 'text', 'SOPORTE', null, 'es']]);
    expect(calls(/INSERT INTO whatsapp_outbox/)).toHaveLength(0);
  });

  it('T2: a photo in the mode is downloaded, stored under the case and added to it', async () => {
    world.conv = inMode();
    world.supportState = { case_open: true, idle: false, reentry_case_id: null };

    await send({ Body: 'mi credencial', NumMedia: '1', MediaUrl0: 'https://media.example.test/m/1', MediaContentType0: 'image/png' });

    expect(mockDownload).toHaveBeenCalledWith('https://media.example.test/m/1', 'AC_fixture', 'fixture-token', 10 * 1024 * 1024);
    expect(mockUploadSupportMedia).toHaveBeenCalledTimes(1);
    const [bucket, key, body, contentType] = mockUploadSupportMedia.mock.calls[0];
    expect(bucket).toBe('fixture-support-media');
    expect(key).toMatch(/^support\/case-1\/[0-9a-f-]{36}\.jpg$/);
    expect(body).toBe(JPEG);
    expect(contentType).toBe('image/jpeg'); // the bytes, not MediaContentType0
    const [append] = calls(/support_append_message\(/);
    expect(append.slice(0, 4)).toEqual(['case-1', CONV_ID, 'media', 'mi credencial']);
    expect(JSON.parse(append[4] as string)).toEqual({
      s3Key: key, mediaType: 'image', contentType: 'image/jpeg', byteSize: JPEG.length,
    });
    expect(calls(/INSERT INTO whatsapp_outbox/)).toHaveLength(0);
  });

  it('T2: an unsupported file gets the one notice, and the case shows it could not be received', async () => {
    world.conv = inMode();
    world.supportState = { case_open: true, idle: false, reentry_case_id: null };
    mockDownload.mockResolvedValue(GIF);

    await send({ Body: '', NumMedia: '1', MediaUrl0: 'https://media.example.test/m/2', MediaContentType0: 'image/gif' });

    expect(mockUploadSupportMedia).not.toHaveBeenCalled();
    expect(calls(/support_append_message\(/)).toEqual([
      ['case-1', CONV_ID, 'text', '[attachment could not be received]', null, 'es'],
    ]);
    expect(textReplies()).toEqual([t('support_media_unsupported', 'es')]);
  });

  it('T2: an attachment that cannot be downloaded is treated the same way', async () => {
    world.conv = inMode();
    world.supportState = { case_open: true, idle: false, reentry_case_id: null };
    mockDownload.mockRejectedValue(new Error('download failed'));

    await send({ Body: '', NumMedia: '1', MediaUrl0: 'https://media.example.test/m/3', MediaContentType0: 'audio/ogg' });

    expect(calls(/support_append_message\(/)).toEqual([
      ['case-1', CONV_ID, 'text', '[attachment could not be received]', null, 'es'],
    ]);
    expect(textReplies()).toEqual([t('support_media_unsupported', 'es')]);
  });

  it('T2: MENU leaves the mode and a ready worker gets the help menu', async () => {
    world.conv = inMode('case-1', { user_id: 'worker-1', conversation_state: 'idle' });
    world.supportState = { case_open: true, idle: false, reentry_case_id: null };
    world.gate = {
      user_id: 'worker-1', lifecycle: 'ready', run_id: 'run-1', workflow_version: 1,
      current_step_key: 'trust.question.3', status: 'completed', preferred_language: 'es', lock_version: 9,
    };

    await send({ Body: 'Menú' });

    expect(calls(/support_record_mode_change/)).toEqual([['case-1', CONV_ID, false, 'menu']]);
    expect(calls(/SET support_case_id = NULL/)).toEqual([[CONV_ID]]);
    expect(calls(/support_append_message\(/)).toHaveLength(0);
    expect(templateReplies()).toEqual(['help_menu_list_es']);
  });

  it('T2: MENU at the code step leaves the mode and asks for the code without spending an attempt', async () => {
    world.conv = inMode();
    world.supportState = { case_open: true, idle: false, reentry_case_id: null };
    world.preAuth = preAuthRow({ preferred_language: 'en' });

    await send({ Body: 'MENU' });

    expect(calls(/support_record_mode_change/)).toEqual([['case-1', CONV_ID, false, 'menu']]);
    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(textReplies()).toEqual([t('v2_otp_enter_code', 'en')]);
    expect(calls(/save_worker_pre_auth/)).toHaveLength(0);
  });

  it('T2: MENU at the start step leaves the mode and re-sends the start invitation', async () => {
    world.conv = inMode();
    world.supportState = { case_open: true, idle: false, reentry_case_id: null };

    await send({ Body: 'menu' });

    expect(calls(/support_record_mode_change/)).toEqual([['case-1', CONV_ID, false, 'menu']]);
    expect(templateReplies()).toEqual(['v2_onboarding_start_es']);
  });

  it('F4: a button tap in the mode reaches the bot and ends the mode; the next text goes to the bot, not the case', async () => {
    world.conv = inMode('case-1', { user_id: 'worker-1', conversation_state: 'idle' });
    world.gate = READY_GATE;
    world.supportState = { case_open: true, idle: false, reentry_case_id: null };

    await send({ Body: 'Ayuda', ButtonPayload: 'command:help' });

    expect(calls(/support_append_message\(/)).toHaveLength(0);
    expect(calls(/support_record_mode_change/)).toEqual([['case-1', CONV_ID, false, 'menu']]);
    expect(calls(/SET support_case_id = NULL/)).toEqual([[CONV_ID]]);
    expect(templateReplies()).toEqual(['help_menu_list_es']); // the bot answered the tap

    nextTurn();
    await send({ Body: 'trabajos', MessageSid: 'SM-support-mode-2' });

    expect(calls(/support_append_message\(/)).toHaveLength(0);
    expect(calls(/support_record_mode_change/)).toHaveLength(0);
    expect(calls(/INSERT INTO whatsapp_outbox/).length).toBeGreaterThan(0); // the bot answered
    // The case itself is untouched: nothing here closes or reopens it.
    expect(calls(/support_open_case\(/)).toHaveLength(0);
  });

  it('F4: a 6-digit code at the code step goes to verification and ends the mode; the next text goes to the bot (D-W1)', async () => {
    world.conv = inMode();
    world.supportState = { case_open: true, idle: false, reentry_case_id: null };
    world.preAuth = preAuthRow();

    await send({ Body: '123456' });

    expect(calls(/support_append_message\(/)).toHaveLength(0);
    expect(calls(/support_record_mode_change/)).toEqual([['case-1', CONV_ID, false, 'menu']]);
    expect(calls(/SET support_case_id = NULL/)).toEqual([[CONV_ID]]);
    const verify = mockCognitoSend.mock.calls.map(([cmd]) => cmd).find((cmd) => cmd.__type === 'RespondToAuthChallenge');
    expect(verify?.input.ChallengeResponses.ANSWER).toBe('123456');

    nextTurn();
    await send({ Body: 'Juan Perez', MessageSid: 'SM-support-mode-2' });

    expect(calls(/support_append_message\(/)).toHaveLength(0);
    expect(calls(/load_worker_pre_auth/).length).toBeGreaterThan(0); // the engine had it
  });

  it('F4: a button tap while a re-entry is open also hands the next text to the bot', async () => {
    world.conv = convRow({ user_id: 'worker-1', conversation_state: 'idle' });
    world.gate = READY_GATE;
    world.supportState = { case_open: false, idle: true, reentry_case_id: 'case-9' };

    await send({ Body: 'Ayuda', ButtonPayload: 'command:help' });

    expect(calls(/support_record_mode_change/)).toEqual([['case-9', CONV_ID, false, 'menu']]);
    expect(templateReplies()).toEqual(['help_menu_list_es']);

    nextTurn();
    await send({ Body: 'trabajos', MessageSid: 'SM-support-mode-2' });

    expect(calls(/support_append_message\(/)).toHaveLength(0);
    expect(calls(/SET support_case_id = \$2/)).toHaveLength(0);
  });

  it('F4: a button tap with no mode and no re-entry changes nothing', async () => {
    await send({ Body: 'Ayuda', ButtonPayload: 'command:help' });

    expect(calls(/support_record_mode_change/)).toHaveLength(0);
    expect(calls(/support_append_message\(/)).toHaveLength(0);
    expect(calls(/load_worker_pre_auth/).length).toBeGreaterThan(0); // the engine had it
  });

  it('T2: a voice-pipeline event passes straight to the onboarding engine', async () => {
    world.conv = inMode();
    world.supportState = { case_open: true, idle: false, reentry_case_id: null };
    const evt: TrustVoiceEventV2 = {
      version: 'v2', kind: 'trust_answer', status: 'COMPLETED', phone: PHONE, runId: 'run-1',
      stepKey: 'trust.question.1', language: 'es', origMessageSid: 'SM-voice-origin', startedAt: new Date().toISOString(),
      questionIndex: 0, transcript: 'cinco anos', executionArn: 'fixture-execution',
    };

    await handler({
      Records: [{
        messageId: 'sqs-voice', receiptHandle: '', body: buildSyntheticVoiceInboundBody(evt),
        attributes: {} as any, messageAttributes: {} as any, md5OfBody: '', eventSource: 'aws:sqs',
        eventSourceARN: '', awsRegion: 'us-east-2',
      }],
    } as any, {} as any, {} as any);

    expect(calls(/support_mode_state\(/)).toHaveLength(0);
    expect(calls(/support_append_message\(/)).toHaveLength(0);
  });

  // ── T3: the mode ends by itself ────────────────────────────────────────

  it('T3: after 24 quiet hours the mode ends once and the message routes normally', async () => {
    world.conv = inMode();
    world.supportState = { case_open: true, idle: true, reentry_case_id: null };

    await send({ Body: 'hola' });

    expect(calls(/support_record_mode_change/)).toEqual([['case-1', CONV_ID, false, 'idle']]);
    expect(calls(/SET support_case_id = NULL/)).toEqual([[CONV_ID]]);
    expect(calls(/support_append_message\(/)).toHaveLength(0);
    expect(templateReplies()).toEqual(['v2_onboarding_start_es']);
  });

  it('T3: once the team closed the case the mode ends as resolved and the message routes normally', async () => {
    world.conv = inMode();
    world.supportState = { case_open: false, idle: false, reentry_case_id: null };

    await send({ Body: 'hola' });

    expect(calls(/support_record_mode_change/)).toEqual([['case-1', CONV_ID, false, 'resolved']]);
    expect(calls(/support_append_message\(/)).toHaveLength(0);
    expect(templateReplies()).toEqual(['v2_onboarding_start_es']);
  });

  // ── T4: answering the team re-enters the mode ──────────────────────────

  it('T4: free text within 72 hours of an admin reply re-enters the mode silently and reaches the case', async () => {
    world.supportState = { case_open: false, idle: true, reentry_case_id: 'case-9' };

    await send({ Body: 'Gracias, ya pude entrar' });

    expect(calls(/SET support_case_id = \$2/)).toEqual([[CONV_ID, 'case-9']]);
    expect(calls(/support_record_mode_change/)).toEqual([['case-9', CONV_ID, true, 'reentry']]);
    expect(calls(/support_append_message\(/)).toEqual([['case-9', CONV_ID, 'text', 'Gracias, ya pude entrar', null, 'es']]);
    expect(calls(/INSERT INTO whatsapp_outbox/)).toHaveLength(0);
    expect(calls(/load_worker_pre_auth/)).toHaveLength(0);
  });

  it('T4: MENU never re-enters the mode', async () => {
    world.supportState = { case_open: false, idle: true, reentry_case_id: 'case-9' };

    await send({ Body: 'MENU' });

    expect(calls(/SET support_case_id = \$2/)).toHaveLength(0);
    expect(calls(/support_append_message\(/)).toHaveLength(0);
    expect(templateReplies()).toEqual(['v2_onboarding_start_es']);
  });

  it('F1: MENU outside the mode ends the 72-hour re-entry: the next typed command reaches the bot', async () => {
    world.conv = convRow({ user_id: 'worker-1', conversation_state: 'idle' });
    world.gate = READY_GATE;
    world.supportState = { case_open: true, idle: true, reentry_case_id: 'case-9' };

    await send({ Body: 'MENU' });

    expect(calls(/support_record_mode_change/)).toEqual([['case-9', CONV_ID, false, 'menu']]);
    expect(calls(/support_append_message\(/)).toHaveLength(0);
    expect(templateReplies()).toEqual(['help_menu_list_es']);

    nextTurn();
    await send({ Body: 'trabajos', MessageSid: 'SM-support-mode-2' });

    expect(calls(/support_append_message\(/)).toHaveLength(0);
    expect(calls(/SET support_case_id = \$2/)).toHaveLength(0);
    expect(calls(/support_record_mode_change/)).toHaveLength(0);
    expect(calls(/INSERT INTO whatsapp_outbox/).length).toBeGreaterThan(0); // the bot answered
  });

  it('F1: MENU with no re-entry open records nothing', async () => {
    world.conv = convRow({ user_id: 'worker-1', conversation_state: 'idle' });
    world.gate = READY_GATE;

    await send({ Body: 'MENU' });

    expect(calls(/support_record_mode_change/)).toHaveLength(0);
  });
});
