/**
 * Processor Lambda — unit tests.
 *
 * These tests cover:
 *
 *   - Atomic MessageSid claim: processRecord elects one winner on concurrent
 *     delivery; duplicate invocations either no-op or resume the outbox.
 *   - Outbox resilience: handler replies go into whatsapp_outbox inside the
 *     transaction; sendPendingOutbox drains them after commit; a Twilio
 *     failure leaves claim status=db_committed so a retry resumes without
 *     re-running side effects.
 *   - reconcileUserRow ABORT: throws when the placeholder has dependent
 *     consent or application rows.
 *   - Persisted Cognito Session, JWT-decoded cognito_sub reconcile cases
 *     A/B/C, and `otp_expired_retry` path are exercised by the happy-path tests.
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

const mockDetectMediaCategory = jest.fn();
const mockBuildS3Key = jest.fn((userId: string, mediaId: string, type: string) => `${userId}/${type}/${mediaId}`);
const mockDownloadTwilioMedia = jest.fn();
const mockDownloadTwilioMediaBounded = jest.fn();
const mockUploadMediaToS3 = jest.fn();
const mockSniffPhotoType = jest.fn();
jest.mock('../../../../lambda/whatsapp/lib/media', () => ({
  detectMediaCategory: (contentType: unknown) => mockDetectMediaCategory(contentType),
  buildS3Key: (userId: string, mediaId: string, type: string) => mockBuildS3Key(userId, mediaId, type),
  downloadTwilioMedia: (...args: unknown[]) => mockDownloadTwilioMedia(...args),
  downloadTwilioMediaBounded: (...args: unknown[]) => mockDownloadTwilioMediaBounded(...args),
  uploadMediaToS3: (...args: unknown[]) => mockUploadMediaToS3(...args),
  // Task 15: the media-board post lane's own photo-magic-byte sniff
  // (post-creation.ts imports this from the same './media' module).
  sniffPhotoType: (buf: unknown) => mockSniffPhotoType(buf),
  ALLOWED_PHOTO_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
  ALLOWED_VOICE_TYPES: ['audio/ogg', 'audio/mpeg', 'audio/mp4'],
  MAX_VOICE_BYTES: 16 * 1024 * 1024,
  MAX_DOCUMENT_BYTES: 10 * 1024 * 1024,
}));

// Task 15: the processor's makePostDeps wires moderateImage's real signature
// (bucket, s3Key, versionId) -> Promise<'approved'|'flagged'>. Mocked so
// these tests never construct a real RekognitionClient/call AWS.
const mockModerateImage = jest.fn();
jest.mock('../../../../lambda/lib/moderation', () => ({
  moderateImage: (...args: unknown[]) => mockModerateImage(...args),
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
const mockLoadWorkerPreferredCities = jest.fn();
jest.mock('../../../../lambda/lib/job-matching', () => ({
  listMatchedJobsForWorker: mockListMatchedJobsForWorker,
  loadWorkerPreferredCities: mockLoadWorkerPreferredCities,
  // Real implementation: pure, trivially safe to use unmocked semantics here.
  cityAnchorsFrom: (rows: Array<{ latitude: unknown; longitude: unknown }>) =>
    rows
      .filter((r) => r.latitude !== null && r.longitude !== null)
      .map((r) => ({ latitude: Number(r.latitude), longitude: Number(r.longitude) })),
}));

// ── v2 routing branch mocks ──────────────────────────────────────────────
//
// v2 is the only onboarding lane now. loadRuntimeControls/hashNormalizedPhone
// (still feeding the live voice_intake control) and the router itself
// (routeOnboardingV2) are mocked so tests never issue a real
// `whatsapp_runtime_controls` query (which would shift every strict
// `mockResolvedValueOnce` chain in this file) and so the "v2 routing branch"
// describe block below can assert call counts/args precisely.
// registerCategoryRenderer is spied-but-real (jest.requireActual) so the
// "renderers registered before routing" assertions exercise the real
// registry; onboarding-renderers itself stays real for the same reason.
const mockLoadRuntimeControls = jest.fn();
const mockIsVoiceIntakeEnabled = jest.fn();
const mockHashNormalizedPhone = jest.fn((phone: any) => `hash:${phone}`);
jest.mock('../../../../lambda/whatsapp/lib/runtime-controls', () => ({
  loadRuntimeControls: (client: unknown) => mockLoadRuntimeControls(client),
  isVoiceIntakeEnabled: (controls: unknown, phoneHash: unknown) => mockIsVoiceIntakeEnabled(controls, phoneHash),
  hashNormalizedPhone: (phone: unknown) => mockHashNormalizedPhone(phone),
}));

const mockRouteOnboardingV2 = jest.fn();
jest.mock('../../../../lambda/whatsapp/onboarding-v2', () => ({
  routeOnboardingV2: (client: unknown, session: unknown, msg: unknown, deps: unknown) =>
    mockRouteOnboardingV2(client, session, msg, deps),
}));

const mockCreateOnboardingV2Adapters = jest.fn();
jest.mock('../../../../lambda/whatsapp/lib/onboarding-adapters', () => ({
  createOnboardingV2Adapters: (deps: unknown) => mockCreateOnboardingV2Adapters(deps),
}));

jest.mock('../../../../lambda/whatsapp/lib/onboarding-repository', () => ({
  loadPreAuthStateForUpdate: jest.fn(),
  savePreAuthState: jest.fn(),
  bindVerifiedIdentityAndStartWorkflow: jest.fn(),
  loadWorkerGate: jest.fn(),
  advanceWorkflow: jest.fn(),
  appendTransition: jest.fn(),
  completeOnboarding: jest.fn(),
  clearProfileAnswers: jest.fn(),
  findPreviousStepKey: jest.fn(),
}));

const mockEnqueueWorkerMessage = jest.fn();
const mockRegisterCategoryRenderer = jest.fn();
jest.mock('../../../../lambda/whatsapp/lib/worker-delivery-gateway', () => {
  const actual = jest.requireActual('../../../../lambda/whatsapp/lib/worker-delivery-gateway');
  return {
    ...actual,
    registerCategoryRenderer: (category: unknown, renderer: unknown) => {
      mockRegisterCategoryRenderer(category, renderer);
      return actual.registerCategoryRenderer(category, renderer);
    },
    enqueueWorkerMessage: (client: unknown, input: unknown, now?: unknown) =>
      mockEnqueueWorkerMessage(client, input, now),
  };
});

const mockPublishOutboxWakes = jest.fn();
jest.mock('../../../../lambda/whatsapp/lib/outbox-wake', () => ({
  publishOutboxWakes: (signals: unknown) => mockPublishOutboxWakes(signals),
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { handler } from '../../../../lambda/whatsapp/processor';
import { t } from '../../../../lambda/whatsapp/lib/templates';
import { fillMessage, fieldQuestion, docPrompt } from '../../../../lambda/whatsapp/lib/application-fill-prompts';
import { _clearCategoryRenderersForTests } from '../../../../lambda/whatsapp/lib/worker-delivery-gateway';
import {
  buildSyntheticVoiceInboundBody,
  syntheticVoiceSid,
  type TrustVoiceEventV2,
} from '../../../../lambda/whatsapp/lib/voice-events';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeSqsRecord(params: Record<string, string>): any {
  return {
    messageId: 'sqs-1',
    receiptHandle: '',
    body: new URLSearchParams(params).toString(),
    attributes: {} as any,
    messageAttributes: {} as any,
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: '',
    awsRegion: 'us-east-2',
  };
}

function makeSqsEvent(params: Record<string, string>): any {
  return { Records: [makeSqsRecord(params)] };
}

/** A raw SQS record whose body is the REAL synthetic voice-event encoding
 * (`buildSyntheticVoiceInboundBody`) — not a hand-rolled params object — so
 * these tests exercise the exact wire format the receiver Lambda produces. */
function makeSyntheticVoiceSqsEvent(evt: TrustVoiceEventV2): any {
  return {
    Records: [{
      messageId: 'sqs-voice-1',
      receiptHandle: '',
      body: buildSyntheticVoiceInboundBody(evt),
      attributes: {} as any,
      messageAttributes: {} as any,
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: '',
      awsRegion: 'us-east-2',
    }],
  };
}

function convRow(overrides: Partial<Record<string, any>> = {}): any {
  return {
    id: 'conv-1',
    user_id: null,
    whatsapp_number: '+15125551234',
    language: 'es',
    conversation_state: 'new',
    state_context: {},
    otp_attempts: 0,
    otp_expires_at: null,
    last_processed_message_sid: null,
    ...overrides,
  };
}

/**
 * Helper: assert that `mockQuery` was called with a SQL statement matching
 * the given pattern. Returns the first matching call's params.
 */
function findQueryByPattern(pattern: RegExp): unknown[] | undefined {
  const hit = mockQuery.mock.calls.find(([sql]) => pattern.test(sql as string));
  return hit ? (hit[1] as unknown[]) : undefined;
}

function countQueryByPattern(pattern: RegExp): number {
  return mockQuery.mock.calls.filter(([sql]) => pattern.test(sql as string)).length;
}

function outboxBodies(): string[] {
  return mockQuery.mock.calls
    .filter(([sql]) => /INSERT INTO whatsapp_outbox/i.test(sql as string))
    .filter(([sql]) => !/content_template/i.test(sql as string))
    .map(([, params]) => (params as unknown[])[2] as string);
}

function outboxTemplates(): string[] {
  return mockQuery.mock.calls
    .filter(([sql]) => /INSERT INTO whatsapp_outbox/i.test(sql as string))
    .filter(([sql]) => /content_template/i.test(sql as string))
    .map(([, params]) => (params as unknown[])[2] as string);
}

// ── Suite ─────────────────────────────────────────────────────────────────

describe('Processor Lambda', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockConnect.mockReset();
    mockRelease.mockReset();
    mockListMatchedJobsForWorker.mockReset();
    mockLoadWorkerPreferredCities.mockReset();
    mockLoadWorkerPreferredCities.mockResolvedValue([]);
    process.env = {
      ...originalEnv,
      WORKER_POOL_ID: 'pool-abc',
      WORKER_CLIENT_ID: 'client-abc',
      TWILIO_SECRET_ARN: 'arn:twilio',
      TWILIO_STATUS_CALLBACK_URL: 'https://callbacks.example.test/prod/whatsapp/status-callback',
      DB_SECRET_ARN: 'arn:db',
      REQUIRED_TOS_VERSION: '1.0',
    };

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

    // v2 is the only onboarding lane now — routeMessage always calls
    // routeOnboardingV2 (mocked here). Default passthrough: "not handled",
    // echoing the session's incoming user_id/language back unchanged, so
    // every test that doesn't care about v2 onboarding specifics still
    // reaches the shared idle/help/support/profile/relay handling below
    // exactly as the old v1-disabled path used to. Individual "v2 routing
    // branch" tests override this to assert on the v2-specific plumbing.
    mockLoadRuntimeControls.mockResolvedValue({ disabled: true });
    mockHashNormalizedPhone.mockImplementation((phone: string) => `hash:${phone}`);
    mockRouteOnboardingV2.mockReset();
    mockRouteOnboardingV2.mockImplementation((_client: unknown, session: any) =>
      Promise.resolve({ handled: false, workerId: session?.user_id ?? null }));
    mockCreateOnboardingV2Adapters.mockReset();
    mockCreateOnboardingV2Adapters.mockReturnValue({});
    mockEnqueueWorkerMessage.mockReset();
    mockPublishOutboxWakes.mockReset();
    mockPublishOutboxWakes.mockResolvedValue({ sent: 0, failed: 0 });
    mockRegisterCategoryRenderer.mockClear();
    _clearCategoryRenderersForTests();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ── atomic claim / duplicate detection ──────────────────────────────────

  describe('claim lifecycle', () => {
    it('short-circuits when status=completed (no routeMessage, no Twilio)', async () => {
      mockQuery
        // BEGIN
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        // claim INSERT: conflicts (already claimed)
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        // SELECT status FOR UPDATE
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'completed' }] })
        // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-dup-completed',
          From: 'whatsapp:+15125551234',
          Body: 'Trabajos',
        }),
        {} as any,
        {} as any,
      );

      // No conversation lookup, no Twilio, no outbox send
      expect(countQueryByPattern(/FROM whatsapp_conversations/i)).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(countQueryByPattern(/UPDATE whatsapp_outbox/i)).toBe(0);
    });

    it('resumes outbox when status=db_committed (sendPendingOutbox + markCompleted)', async () => {
      mockQuery
        // BEGIN
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        // claim INSERT: conflicts
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        // SELECT status FOR UPDATE
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'db_committed' }] })
        // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        // sendPendingOutbox: SELECT pending outbox rows
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'o-1', sequence: 1, whatsapp_number: '+15125551234', body: 'hi' }],
        })
        // UPDATE outbox SET status='sent'
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        // markCompleted: UPDATE processed_messages status='completed'
        .mockResolvedValueOnce({ rowCount: 1, rows: [] });

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-resume',
          From: 'whatsapp:+15125551234',
          Body: 'hola',
        }),
        {} as any,
        {} as any,
      );

      // No routeMessage side effects. The only conversation lookup is the
      // db_committed resume path checking whether job-message outbox should drain.
      expect(countQueryByPattern(/FROM whatsapp_conversations/i)).toBe(1);
      // Twilio was called to drain the pending outbox row
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // markCompleted ran
      const completed = findQueryByPattern(
        /UPDATE whatsapp_processed_messages\s+SET status = 'completed'/i,
      );
      expect(completed).toBeDefined();
    });

    it('skips when status=processing (another invocation in flight)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // claim conflict
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'processing' }] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // COMMIT

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-in-flight',
          From: 'whatsapp:+15125551234',
          Body: 'hola',
        }),
        {} as any,
        {} as any,
      );

      // No further work
      expect(countQueryByPattern(/FROM whatsapp_conversations/i)).toBe(0);
      expect(countQueryByPattern(/UPDATE whatsapp_outbox/i)).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── outbox — Twilio failure leaves claim db_committed ───────────────────

  describe('outbox resilience to Twilio failure', () => {
    it('Twilio 500 on outbox send: row marked failed, markCompleted NOT called', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-twilio-fail' }] }) // claim
        .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'idle' })] }) // SELECT conv FOR UPDATE
        // v2 forced-idle writeback (routeOnboardingV2 mocked, handled:false)
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        // queueReply → INSERT whatsapp_outbox (jobs_none)
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        // UPDATE whatsapp_processed_messages status='db_committed'
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        // sendPendingOutbox: one pending row
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'o-1', sequence: 1, whatsapp_number: '+15125551234', body: 'no jobs' }],
        })
        // UPDATE outbox failed
        .mockResolvedValueOnce({ rowCount: 1, rows: [] });
      // Twilio send fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Twilio outage',
      });

      await expect(
        handler(
          makeSqsEvent({
            MessageSid: 'SM-twilio-fail',
            From: 'whatsapp:+15125551234',
            Body: 'Trabajos',
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/Twilio send failed/);

      // The outbox row was marked 'failed' with an incremented attempt_count.
      const failedUpd = findQueryByPattern(
        /UPDATE whatsapp_outbox\s+SET status = \$1/i,
      );
      expect(failedUpd).toBeDefined();
      expect(mockQuery.mock.calls.some(([sql, params]) => (
        /UPDATE whatsapp_outbox\s+SET status = \$1/i.test(sql)
        && params?.[0] === 'failed'
      ))).toBe(true);
      // markCompleted was NOT called (no UPDATE status='completed' in mockQuery calls)
      expect(
        countQueryByPattern(/UPDATE whatsapp_processed_messages\s+SET status = 'completed'/i),
      ).toBe(0);
      // Phase-2 (post-commit Twilio) failures must NOT trigger the error
      // fallback — they already have the db_committed resume path, and an
      // apology here would be a lie (the state advanced fine).
      expect(countQueryByPattern(/#err/)).toBe(0);
    });
  });

  describe('Trust signals and typed jobs', () => {
    it('returns the command menu when a worker sends help', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-help' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'en', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox help_menu_list_en
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-help',
          From: 'whatsapp:+15125551234',
          Body: 'Help',
        }),
        {} as any,
        {} as any,
      );

      expect(outboxTemplates()).toContain('help_menu_list_en');
      const insert = mockQuery.mock.calls.find(([sql, params]) =>
        /INSERT INTO whatsapp_outbox/i.test(sql as string)
        && Array.isArray(params)
        && (params as unknown[])[2] === 'help_menu_list_en',
      );
      const variables = (insert![1] as unknown[])[3] as Record<string, string>;
      expect(variables.__fallback_body).toContain('Commands');
      expect(variables.__fallback_body).toContain('Jobs - See opportunities');
      expect(countQueryByPattern(/FROM jobs/i)).toBe(0);
    });

    it('routes a tapped "command:jobs" list-picker row into the jobs listing path', async () => {
      mockListMatchedJobsForWorker.mockResolvedValue([
        { id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr' },
      ]);

      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-cmd-jobs' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'en', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation recent_jobs
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT template outbox job 1
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-cmd-jobs',
          From: 'whatsapp:+15125551234',
          Body: '',
          ButtonPayload: 'command:jobs',
        }),
        {} as any,
        {} as any,
      );

      expect(mockListMatchedJobsForWorker).toHaveBeenCalledWith(expect.any(Object), 'user-1', {
        limit: 5,
        channel: 'whatsapp',
      });
    });

    it('routes a list-picker ListId "command:jobs" with row-title Body into the jobs listing path', async () => {
      mockListMatchedJobsForWorker.mockResolvedValue([
        { id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr' },
      ]);

      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-listid-jobs' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'en', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation recent_jobs
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT template outbox job 1
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-listid-jobs',
          From: 'whatsapp:+15125551234',
          Body: 'Jobs',
          ListId: 'command:jobs',
        }),
        {} as any,
        {} as any,
      );

      expect(mockListMatchedJobsForWorker).toHaveBeenCalledWith(expect.any(Object), 'user-1', {
        limit: 5,
        channel: 'whatsapp',
      });
    });

    it('routes Body "command:profile" (no ButtonPayload) to the profile path', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-cmd-profile' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'en', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            phone: '+15125551234',
            whatsapp_number: '+15125551234',
            full_name: 'Luis Gomez',
            city: '79928',
            main_trade: 'electrician',
            main_trade_other: null,
            years_experience: '10+',
            has_transportation: true,
            availability: 'flexible',
            trust_assessment_profession_key: null,
            trust_assessment_status: null,
            trust_assessment_answers: null,
            trust_assessment_questions: null,
          }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox profile
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-cmd-profile',
          From: 'whatsapp:+15125551234',
          Body: 'command:profile',
        }),
        {} as any,
        {} as any,
      );

      const body = outboxBodies()[0];
      expect(body).toContain('Your profile');
      expect(body).toContain('Name: Luis Gomez');
    });

    it('queues the help list-picker template (with plain-text fallback) when a worker sends help', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-help' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'en', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox help_menu_list_en
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-help',
          From: 'whatsapp:+15125551234',
          Body: 'Help',
        }),
        {} as any,
        {} as any,
      );

      expect(outboxTemplates()).toEqual(['help_menu_list_en']);
      expect(outboxBodies()).toEqual([]);
      const helpPrompt = mockQuery.mock.calls.find(([sql, params]) =>
        /INSERT INTO whatsapp_outbox/i.test(sql as string)
        && /content_template/i.test(sql as string)
        && Array.isArray(params)
        && (params as unknown[]).includes('help_menu_list_en')
      );
      expect(helpPrompt).toBeDefined();
      const contentVariables = (helpPrompt![1] as unknown[])[3] as Record<string, string>;
      expect(contentVariables.__fallback_body).toContain('Commands');
      expect(contentVariables.__fallback_body).toContain('Jobs - See opportunities');
      expect(countQueryByPattern(/FROM jobs/i)).toBe(0);
    });

    it('queues the Spanish help list-picker template for an ES conversation', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-help-es' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'es', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox help_menu_list_es
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-help-es',
          From: 'whatsapp:+15125551234',
          Body: 'Ayuda',
        }),
        {} as any,
        {} as any,
      );

      expect(outboxTemplates()).toEqual(['help_menu_list_es']);
      const helpPrompt = mockQuery.mock.calls.find(([sql, params]) =>
        /INSERT INTO whatsapp_outbox/i.test(sql as string)
        && /content_template/i.test(sql as string)
        && Array.isArray(params)
        && (params as unknown[]).includes('help_menu_list_es')
      );
      expect(helpPrompt).toBeDefined();
      const contentVariables = (helpPrompt![1] as unknown[])[3] as Record<string, string>;
      expect(contentVariables.__fallback_body).toEqual(t('help_menu', 'es'));
    });

    it('does not treat a near-match like "help me" as the help command', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-help-nomatch' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'new', language: 'en', user_id: null })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // tryConversationRelay → resolveWorkerIdForWhatsappNumber → no match
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox idle_help (not-a-command fallback)
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-help-nomatch',
          From: 'whatsapp:+15125551234',
          Body: 'help me',
        }),
        {} as any,
        {} as any,
      );

      expect(outboxTemplates()).not.toContain('help_menu_list_en');
      expect(outboxTemplates()).not.toContain('help_menu_list_es');
    });

    it('creates a support case for a linked worker before focused-thread relay', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-support' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'idle',
            language: 'en',
            user_id: 'user-1',
            focused_job_conversation_id: 'job-conv-1',
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ cognito_sub: 'worker-sub-1' }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ case_id: 'case-1', created: true }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT support_ack outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-support',
          From: 'whatsapp:+15125551234',
          Body: 'Support',
        }),
        {} as any,
        {} as any,
      );

      expect(findQueryByPattern(/FROM create_admin_support_case/i)).toEqual([
        'user-1',
        'conv-1',
        'Worker requested WhatsApp support',
        'Support',
      ]);
      expect(outboxBodies()).toContain(t('support_ack', 'en'));
      expect(countQueryByPattern(/INSERT INTO job_conversation_messages/i)).toBe(0);
    });

    it('acknowledges an existing open support case without creating another', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-support-existing' }] })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'es', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ cognito_sub: 'worker-sub-1' }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ case_id: 'case-1', created: false }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT support_ack_existing outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-support-existing',
          From: 'whatsapp:+15125551234',
          Body: 'soporte',
        }),
        {} as any,
        {} as any,
      );

      expect(countQueryByPattern(/FROM create_admin_support_case/i)).toBe(1);
      expect(outboxBodies()).toContain(t('support_ack_existing', 'es'));
    });

    it('requires signup for a pre-OTP support command and does not create a case', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-support-pre-otp' }] })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'awaiting_otp', language: 'en', user_id: null })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // verified-phone worker resolution
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT support_needs_signup outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-support-pre-otp',
          From: 'whatsapp:+15125551234',
          Body: 'support',
        }),
        {} as any,
        {} as any,
      );

      expect(findQueryByPattern(/create_admin_support_case/i)).toBeUndefined();
      expect(outboxBodies()).toContain(t('support_needs_signup', 'en'));
    });

    it('creates a support case for an unlinked conversation resolved by verified phone without binding it', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-support-phone' }] })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'awaiting_otp', language: 'en', user_id: null })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'phone-worker-1' }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ cognito_sub: 'phone-worker-sub-1' }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ case_id: 'case-phone-1', created: true }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT support_ack outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-support-phone',
          From: 'whatsapp:+15125551234',
          Body: 'support',
        }),
        {} as any,
        {} as any,
      );

      expect(findQueryByPattern(/FROM create_admin_support_case/i)).toEqual([
        'phone-worker-1',
        'conv-1',
        'Worker requested WhatsApp support',
        'support',
      ]);
      expect(outboxBodies()).toContain(t('support_ack', 'en'));
      // The support case uses the phone-resolved worker id, but the
      // conversation row itself is never bound to it — only the v2 forced
      // idle writeback (unconditional on every turn) touches this row, and
      // its user_id stays whatever the (unhandled) v2 session carried, never
      // the phone-worker-1 support lookup result.
      const conversationWrites = mockQuery.mock.calls.filter(([sql]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string));
      expect(conversationWrites.every(([, params]) =>
        !(params as unknown[])?.includes('phone-worker-1'))).toBe(true);
    });

    // R2-C8: `users.trust_signals` / `trust_signals_completed_at` (the v1
    // three-question lane) no longer have a writer and no longer have a
    // reader — `formatProfileSummary`'s legacy branch is gone and 091 drops
    // the columns. A worker with no `worker_trust_assessments` row now gets
    // the plain "not set" line, never a v1 specialty/level/main-work block.
    it('returns profile details for a linked worker profile command', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-profile' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'en', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            phone: '+15125551234',
            whatsapp_number: '+15125551234',
            full_name: 'Luis Gomez',
            city: '79928',
            main_trade: 'electrician',
            main_trade_other: null,
            years_experience: '10+',
            has_transportation: true,
            availability: 'flexible',
            trust_assessment_profession_key: null,
            trust_assessment_status: null,
            trust_assessment_answers: null,
            trust_assessment_questions: null,
          }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox profile
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-profile',
          From: 'whatsapp:+15125551234',
          Body: 'profile',
        }),
        {} as any,
        {} as any,
      );

      const body = outboxBodies()[0];
      expect(body).toContain('Your profile');
      expect(body).toContain('Name: Luis Gomez');
      expect(body).toContain('Trade: Electrician');
      // The trust block degrades to "Not set" — no v1 fallback rendering.
      expect(body).toContain('Trust\nNot set');
      expect(body).not.toMatch(/Specialty|Level|Main work/);
      // ...and the summary query no longer even SELECTs the dead columns.
      expect(countQueryByPattern(/u\.trust_signals/i)).toBe(0);
      expect(countQueryByPattern(/UPDATE users/i)).toBe(0);
    });

    it('includes custom trust assessment answers for a Spanish profile command', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-profile-custom' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'es', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            phone: '+15125551234',
            whatsapp_number: '+15125551234',
            full_name: 'Luis Gomez',
            city: '79928',
            main_trade: 'other',
            main_trade_other: 'Drywall',
            years_experience: '10+',
            has_transportation: true,
            availability: 'flexible',
            trust_assessment_profession_key: 'drywall',
            trust_assessment_status: 'scored',
            trust_assessment_answers: [
              {
                q_en: 'What types of drywall installations have you worked on?',
                answer_text: 'Hago drywall residencial y comercial.',
              },
            ],
            trust_assessment_questions: [
              {
                q_en: 'What types of drywall installations have you worked on?',
                q_es: 'En que tipos de instalaciones de paneles de yeso has trabajado?',
              },
            ],
          }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox profile
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-profile-custom',
          From: 'whatsapp:+15125551234',
          Body: 'perfil',
        }),
        {} as any,
        {} as any,
      );

      const body = outboxBodies()[0];
      expect(body).toContain('Tu perfil');
      expect(body).toContain('Oficio: Drywall');
      expect(body).toContain('Estado: Evaluado');
      expect(body).toContain('Preguntas de confianza');
      expect(body).toContain('En que tipos de instalaciones de paneles de yeso has trabajado?');
      expect(body).toContain('Hago drywall residencial y comercial.');
      expect(body).not.toContain('Puntaje:');
      expect(body).not.toContain('75');
      const profileQuery = mockQuery.mock.calls.find(([sql]) =>
        /FROM users u/i.test(sql as string)
        && /worker_trust_assessments/i.test(sql as string)
      );
      expect(profileQuery?.[0]).not.toContain('trade_competency_score');
      expect(profileQuery?.[0]).not.toContain('competency_score');
    });

    it('does not consume an in-progress profile answer when profile command is sent', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-profile-mid-flow' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'building_profile',
            language: 'es',
            user_id: 'user-1',
            state_context: { next_field: 'city' },
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            phone: '+15125551234',
            whatsapp_number: '+15125551234',
            full_name: 'Luis Gomez',
            city: '79928',
            main_trade: 'electrician',
            main_trade_other: null,
            years_experience: '10+',
            has_transportation: true,
            availability: 'flexible',
          }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox profile
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-profile-mid-flow',
          From: 'whatsapp:+15125551234',
          Body: 'perfil',
        }),
        {} as any,
        {} as any,
      );

      expect(outboxBodies()[0]).toContain('Tu perfil');
      expect(findQueryByPattern(/UPDATE users\s+SET city/i)).toBeUndefined();
      // handleProfileCommand itself never writes whatsapp_conversations — the
      // ONLY conversation write in this turn is the unconditional v2
      // forced-idle writeback (asserted separately by the 'v2 routing
      // branch' suite), proving the in-progress pending field was never
      // touched by the profile command.
      expect(countQueryByPattern(/UPDATE whatsapp_conversations SET/i)).toBe(1);
    });

    it('asks the worker to finish onboarding when profile command has no linked user', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-profile-not-ready' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'en', user_id: null })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox profile_not_ready
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-profile-not-ready',
          From: 'whatsapp:+15125551234',
          Body: 'profile',
        }),
        {} as any,
        {} as any,
      );

      expect(outboxBodies()[0]).toContain('Your profile is not ready yet');
      // Scoped to handleProfileCommand's own profile-lookup query (aliased
      // `u`) — the web-worker bypass check upstream also queries `users`
      // (unaliased, by phone) and correctly found no match here, which is
      // not what this assertion protects.
      expect(countQueryByPattern(/FROM users u\b/i)).toBe(0);
    });

    it('idle (legacy) worker sending a voice note gets the "not supported here" reply, never idle_help', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-idle-voice' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'en', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox voice_note_not_supported
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-idle-voice',
          From: 'whatsapp:+15125551234',
          Body: '',
          NumMedia: '1',
          MediaUrl0: 'https://api.twilio.com/media/ME999',
          MediaSid0: 'ME999',
          MediaContentType0: 'audio/ogg',
        }),
        {} as any,
        {} as any,
      );

      expect(outboxBodies()[0]).toBe(t('voice_note_not_supported', 'en'));
      expect(countQueryByPattern(/FROM jobs/i)).toBe(0);
    });

    // Task 1/A1: a photo CAPTIONED with a jobs command must run that
    // command, not be discarded in favor of the unrelated voice-note reply
    // — before the voice-note copy landed, a captioned command already
    // worked here.
    it('a ready worker\'s photo captioned with a jobs command runs that command, never the voice-note reply', async () => {
      mockListMatchedJobsForWorker.mockResolvedValue([
        { id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr' },
      ]);

      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-jobs-caption' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation recent_jobs
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT template outbox job 1
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-jobs-caption',
          From: 'whatsapp:+15125551234',
          Body: 'Trabajos',
          NumMedia: '1',
          MediaUrl0: 'https://api.twilio.com/media/ME998',
          MediaSid0: 'ME998',
          MediaContentType0: 'image/jpeg',
        }),
        {} as any,
        {} as any,
      );

      expect(mockListMatchedJobsForWorker).toHaveBeenCalledWith(expect.any(Object), 'user-1', {
        limit: 5,
        channel: 'whatsapp',
      });
      expect(outboxBodies()).not.toContain(t('voice_note_not_supported', 'en'));
    });

    it('stores recent job ids when an idle worker asks for jobs', async () => {
      mockListMatchedJobsForWorker.mockResolvedValue([
        { id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr' },
        { id: 'job-2', title: 'Plumber', company: 'XYZ', location: 'El Paso', pay: '$22/hr' },
      ]);

      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-jobs' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation recent_jobs
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT template outbox job 1
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT template outbox job 2
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-jobs',
          From: 'whatsapp:+15125551234',
          Body: 'Trabajos',
        }),
        {} as any,
        {} as any,
      );

      const update = mockQuery.mock.calls.find(([sql, params]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string)
        && Array.isArray(params)
        && typeof params[1] === 'string'
        && (params[1] as string).includes('recent_jobs'),
      );
      expect(update).toBeDefined();
      expect(JSON.parse((update![1] as unknown[])[1] as string).recent_jobs).toEqual([
        'job-1',
        'job-2',
      ]);
      expect(mockListMatchedJobsForWorker).toHaveBeenCalledWith(expect.any(Object), 'user-1', {
        limit: 5,
        channel: 'whatsapp',
      });
    });

    it('filters the jobs list to the worker preferred cities', async () => {
      mockLoadWorkerPreferredCities.mockResolvedValue([
        { city_key: 'el-paso-tx', latitude: 31.7619, longitude: -106.485 },
        { city_key: 'las-cruces-nm', latitude: null, longitude: null },
      ]);
      mockListMatchedJobsForWorker.mockResolvedValue([
        { id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso, TX', pay: '$25/hr' },
        { id: 'job-2', title: 'Plumber', company: 'XYZ', location: 'El Paso, TX', pay: '$22/hr' },
        { id: 'job-3', title: 'Framer', company: 'FrameCo', location: 'El Paso, TX', pay: '$24/hr' },
        { id: 'job-4', title: 'Painter', company: 'PaintCo', location: 'Las Cruces, NM', pay: '$21/hr' },
        { id: 'job-5', title: 'Roofer', company: 'RoofCo', location: 'El Paso, TX', pay: '$27/hr' },
      ]);

      // Dispatch on SQL substrings instead of positional chaining: this test
      // only cares about the matcher's inputs, not the exact query count.
      mockQuery.mockImplementation((sql: string) => {
        if (/INSERT INTO whatsapp_processed_messages/i.test(sql)) {
          return Promise.resolve({ rowCount: 1, rows: [{ message_sid: 'SM-city-jobs' }] });
        }
        if (/FROM whatsapp_conversations/i.test(sql) && /SELECT/i.test(sql)) {
          return Promise.resolve({
            rowCount: 1,
            rows: [convRow({ conversation_state: 'idle', user_id: 'user-1' })],
          });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      });

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-city-jobs',
          From: 'whatsapp:+15125551234',
          Body: 'Jobs',
        }),
        {} as any,
        {} as any,
      );

      expect(mockLoadWorkerPreferredCities).toHaveBeenCalledWith(expect.any(Object), 'user-1');
      expect(mockListMatchedJobsForWorker).toHaveBeenCalledTimes(1);
      expect(mockListMatchedJobsForWorker).toHaveBeenCalledWith(expect.any(Object), 'user-1', {
        limit: 5,
        channel: 'whatsapp',
        cityKeys: ['el-paso-tx', 'las-cruces-nm'],
        cityAnchors: [{ latitude: 31.7619, longitude: -106.485 }],
      });
    });

    it('tops up with out-of-city jobs when the preferred cities run short, deduped and capped at 5', async () => {
      mockLoadWorkerPreferredCities.mockResolvedValue([
        { city_key: 'el-paso-tx', latitude: 31.7619, longitude: -106.485 },
      ]);
      mockListMatchedJobsForWorker.mockImplementation(
        async (_client: unknown, _workerId: string, options: { cityKeys?: string[]; excludeCityKeys?: string[] }) => {
          if (options.cityKeys) {
            return [
              { id: 'job-city-1', title: 'Electrician', company: 'ABC', location: 'El Paso, TX', pay: '$25/hr' },
              // Referral pin: fetched by id with no city filter, so it can also
              // surface from the exclude-cities fallback below.
              { id: 'job-referral', title: 'Welder', company: 'WeldCo', location: 'Austin, TX', pay: '$30/hr' },
            ];
          }
          return [
            { id: 'job-referral', title: 'Welder', company: 'WeldCo', location: 'Austin, TX', pay: '$30/hr' },
            { id: 'job-out-1', title: 'Plumber', company: 'XYZ', location: 'Austin, TX', pay: '$22/hr' },
            { id: 'job-out-2', title: 'Framer', company: 'FrameCo', location: 'Dallas, TX', pay: '$24/hr' },
            { id: 'job-out-3', title: 'Painter', company: 'PaintCo', location: 'Houston, TX', pay: '$21/hr' },
            { id: 'job-out-4', title: 'Roofer', company: 'RoofCo', location: 'Austin, TX', pay: '$27/hr' },
          ];
        },
      );

      mockQuery.mockImplementation((sql: string) => {
        if (/INSERT INTO whatsapp_processed_messages/i.test(sql)) {
          return Promise.resolve({ rowCount: 1, rows: [{ message_sid: 'SM-topup-jobs' }] });
        }
        if (/FROM whatsapp_conversations/i.test(sql) && /SELECT/i.test(sql)) {
          return Promise.resolve({
            rowCount: 1,
            rows: [convRow({ conversation_state: 'idle', user_id: 'user-1' })],
          });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      });

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-topup-jobs',
          From: 'whatsapp:+15125551234',
          Body: 'Jobs',
        }),
        {} as any,
        {} as any,
      );

      expect(mockListMatchedJobsForWorker).toHaveBeenCalledTimes(2);
      expect(mockListMatchedJobsForWorker).toHaveBeenNthCalledWith(1, expect.any(Object), 'user-1', {
        limit: 5,
        channel: 'whatsapp',
        cityKeys: ['el-paso-tx'],
        cityAnchors: [{ latitude: 31.7619, longitude: -106.485 }],
      });
      expect(mockListMatchedJobsForWorker).toHaveBeenNthCalledWith(2, expect.any(Object), 'user-1', {
        limit: 5,
        channel: 'whatsapp',
        excludeCityKeys: ['el-paso-tx'],
        cityAnchors: [{ latitude: 31.7619, longitude: -106.485 }],
      });

      // City jobs first, then out-of-city fill: deduped (job-referral appears
      // once) and capped at the WhatsApp limit of 5.
      const update = mockQuery.mock.calls.find(([sql, params]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string)
        && Array.isArray(params)
        && typeof params[1] === 'string'
        && (params[1] as string).includes('recent_jobs'),
      );
      expect(update).toBeDefined();
      expect(JSON.parse((update![1] as unknown[])[1] as string).recent_jobs).toEqual([
        'job-city-1',
        'job-referral',
        'job-out-1',
        'job-out-2',
        'job-out-3',
      ]);
    });

    it('queues one job alert template per matched job from the shared matcher', async () => {
      mockListMatchedJobsForWorker.mockResolvedValue([
        { id: 'job-drywall', title: 'Drywall finisher', company: 'FinishPro', location: 'El Paso, TX 79928', pay: '$30/hr' },
        { id: 'job-sheetrock', title: 'Sheetrock hanger', company: 'BoardCo', location: 'El Paso, TX 79928', pay: '$28/hr' },
        { id: 'job-patch', title: 'Patch and texture tech', company: 'RepairCo', location: 'El Paso, TX 79936', pay: '$26/hr' },
      ]);

      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-ranked-jobs' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', user_id: 'worker-1', language: 'en' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation recent_jobs
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT template outbox job 1
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT template outbox job 2
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT template outbox job 3
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-ranked-jobs',
          From: 'whatsapp:+15125551234',
          Body: 'Jobs',
        }),
        {} as any,
        {} as any,
      );

      expect(mockListMatchedJobsForWorker).toHaveBeenCalledWith(expect.any(Object), 'worker-1', {
        limit: 5,
        channel: 'whatsapp',
      });

      const update = mockQuery.mock.calls.find(([sql, params]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string)
        && Array.isArray(params)
        && typeof params[1] === 'string'
        && (params[1] as string).includes('recent_jobs')
        && (params[1] as string).includes('job-drywall')
      );
      expect(JSON.parse((update![1] as unknown[])[1] as string).recent_jobs).toEqual([
        'job-drywall',
        'job-sheetrock',
        'job-patch',
      ]);

      const templateInserts = mockQuery.mock.calls.filter(([sql]) =>
        /INSERT INTO whatsapp_outbox/i.test(sql as string)
        && /content_template/i.test(sql as string)
      );
      expect(templateInserts).toHaveLength(3);
      expect(templateInserts[0][1]).toEqual(expect.arrayContaining([
        'SM-ranked-jobs',
        '+15125551234',
        'job_alert_en',
        expect.objectContaining({ '1': 'Drywall finisher', '5': 'job-job-drywall' }),
      ]));
      expect(templateInserts[1][1]).toEqual(expect.arrayContaining([
        'SM-ranked-jobs',
        '+15125551234',
        'job_alert_en',
        expect.objectContaining({ '1': 'Sheetrock hanger', '5': 'job-job-sheetrock' }),
      ]));
    });

    // Task 4 (WhatsApp pay localization): the '4' template variable is built
    // from the structured pay_min/pay_max/pay_interval fields when present,
    // falling back to the raw legacy `pay_raw` string, then to a localized
    // "not specified" placeholder -- never the English-only stored `pay`.
    async function runJobsKeywordWithSingleJob(
      language: 'en' | 'es',
      job: Record<string, unknown>,
    ): Promise<string> {
      mockListMatchedJobsForWorker.mockResolvedValue([job]);

      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-pay-localized' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', user_id: 'worker-1', language })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation recent_jobs
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT template outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-pay-localized',
          From: 'whatsapp:+15125551234',
          Body: language === 'es' ? 'Trabajos' : 'Jobs',
        }),
        {} as any,
        {} as any,
      );

      const templateInsert = mockQuery.mock.calls.find(([sql]) =>
        /INSERT INTO whatsapp_outbox/i.test(sql as string)
        && /content_template/i.test(sql as string),
      );
      expect(templateInsert).toBeDefined();
      const variables = (templateInsert![1] as unknown[])[3] as Record<string, string>;
      return variables['4'];
    }

    it('renders Spanish structured pay text in the job template for an ES worker', async () => {
      const pay = await runJobsKeywordWithSingleJob('es', {
        id: 'job-drywall', title: 'Drywall finisher', company: 'FinishPro', location: 'El Paso, TX',
        pay: '$30/hr', pay_min: 15, pay_max: 20, pay_interval: 'hourly',
      });
      expect(pay).toBe('$15-$20/hora');
    });

    it('renders English structured pay text in the job template for an EN worker', async () => {
      const pay = await runJobsKeywordWithSingleJob('en', {
        id: 'job-drywall', title: 'Drywall finisher', company: 'FinishPro', location: 'El Paso, TX',
        pay: '$30/hr', pay_min: 15, pay_max: 20, pay_interval: 'hourly',
      });
      expect(pay).toBe('$15-$20/hour');
    });

    it('falls back to the raw legacy pay string when structured fields are all null', async () => {
      const pay = await runJobsKeywordWithSingleJob('es', {
        id: 'job-legacy', title: 'Legacy job', company: 'OldCo', location: 'El Paso, TX',
        pay_min: null, pay_max: null, pay_interval: null, pay_raw: 'Negotiable',
      });
      expect(pay).toBe('Negotiable');
    });

    it('falls back to a localized "not specified" placeholder when everything is null', async () => {
      const esPay = await runJobsKeywordWithSingleJob('es', {
        id: 'job-blank', title: 'Blank job', company: 'NoCo', location: 'El Paso, TX',
        pay_min: null, pay_max: null, pay_interval: null, pay_raw: null,
      });
      expect(esPay).toBe('Pago no especificado');
    });

    it('falls back to the English "not specified" placeholder for an EN worker with no pay data', async () => {
      const enPay = await runJobsKeywordWithSingleJob('en', {
        id: 'job-blank', title: 'Blank job', company: 'NoCo', location: 'El Paso, TX',
        pay_min: null, pay_max: null, pay_interval: null, pay_raw: null,
      });
      expect(enPay).toBe('Pay not specified');
    });

    // ── Task 9 helpers: arming the application-fill flow at accept ────────
    //
    // Every accept now runs seedAnswersFromDefaults + computeNextStep
    // (application-fill.ts) INSIDE handleJobAction, before deciding between
    // the legacy job_accepted/job_already_applied reply (no gaps) and
    // arming the fill (a gap exists). These push exactly the queries those
    // functions issue, in the order they issue them, onto the same
    // monolithic `mockQuery` queue every other test in this suite uses.
    function ok(rowCount = 1): { rowCount: number; rows: unknown[] } {
      return { rowCount, rows: [] };
    }

    // seedAnswersFromDefaults: deps.setRls (a real setInternalUserRlsContext
    // call per this file's db mock) + the worker_application_defaults
    // SELECT. With no defaults row, it short-circuits there -- no
    // job_applications SELECT, no UPDATE.
    function mockSeedNoDefaults(): void {
      mockQuery.mockResolvedValueOnce(ok()); // deps.setRls
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // worker_application_defaults SELECT -- no row
    }

    // Sprint 23: the fill lane derives every step from the shared engine's
    // single `loadRequirementSnapshot` SELECT (application-requirements.ts's
    // SNAPSHOT_SQL) instead of computeNextStep's old job/doc query pair. The
    // document SYNC (set_config + copyRequiredDocumentSnapshots + a re-read)
    // only runs when the job asks for at least one document, so this helper
    // mirrors that branch exactly -- a job with no docs is still ONE query.
    //
    // Defaults are STAGE 2 (`details_requested_at` set): the lane's stage
    // gate exits an apply-stage application as `details_not_requested`, so
    // an apply-stage default would silently turn every fill test into an
    // exit test.
    function mockFillSnapshotRow(
      row: Partial<{
        worker_id: string; job_id: string; application_status: string;
        application_answers: Record<string, unknown>; job_status: string;
        required_fields: string[]; required_docs: string[]; optional_docs: string[];
        details_requested_at: string | null; details_completed_at: string | null;
        pre_application_prompts: unknown; prompt_answers: Record<string, string>;
      }> = {},
      haveDocs: string[] = [],
    ): void {
      const full = {
        id: 'app-1', worker_id: 'user-1', job_id: 'job-1',
        application_status: 'pending', application_answers: {}, prompt_answers: {},
        details_requested_at: '2026-09-01T00:00:00.000Z', details_completed_at: null,
        applied_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
        job_status: 'active', job_title: 'Electrician',
        required_fields: [], optional_fields: [], required_docs: [], optional_docs: [],
        certification_requirements: null, pre_application_prompts: null,
        have_docs: haveDocs,
        ...row,
      };
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [full] });

      const docTypes = Array.from(new Set([...(full.required_docs ?? []), ...(full.optional_docs ?? [])]));
      if (docTypes.length === 0) return;
      mockQuery.mockResolvedValueOnce(ok()); // setInternalUserRlsContext (the sync writes worker_documents)
      if (docTypes.some((d) => d !== 'certification_doc')) mockQuery.mockResolvedValueOnce(ok()); // non-cert snapshot copy
      if (docTypes.includes('certification_doc')) mockQuery.mockResolvedValueOnce(ok()); // cert snapshot copy
      mockQuery.mockResolvedValueOnce({
        rowCount: haveDocs.length,
        rows: haveDocs.map((doc_type) => ({ doc_type })),
      });
    }

    // The engine's `mergeFieldAnswers`, which the per-turn field merge now
    // goes through: its OWN snapshot load, then the size-guarded merge, then
    // the worker_application_defaults write-back WhatsApp never had before.
    // `markDetailsCompleteIfDone` is handed the in-memory snapshot, so it
    // issues its UPDATE only when nothing is left -- callers that expect
    // completion add that mock themselves.
    function mockFieldMergeQueries(
      row: Parameters<typeof mockFillSnapshotRow>[0] = {},
      haveDocs: string[] = [],
    ): void {
      mockFillSnapshotRow(row, haveDocs);
      mockQuery.mockResolvedValueOnce(ok()); // SAVEPOINT application_requirements_merge
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ total: 64 }] }); // merge UPDATE ... RETURNING length(...)
      mockQuery.mockResolvedValueOnce(ok()); // RELEASE SAVEPOINT
      mockQuery.mockResolvedValueOnce(ok()); // INSERT INTO worker_application_defaults ... ON CONFLICT
    }

    // armFill's company lookup for the intro/completion copy.
    function mockCompanyLookup(company = 'ABC'): void {
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ company }] });
    }

    // buildFillDeps' updateStateContext -> updateConversation's
    // `UPDATE whatsapp_conversations SET state_context = ...` write (arming,
    // switching, or promptNextStep's fill_last_prompt_at stamp).
    function mockStateContextUpdate(): void {
      mockQuery.mockResolvedValueOnce(ok());
    }

    // The tail every SQS record runs after handleJobAction returns,
    // regardless of how many outbox rows/state writes happened in between:
    // mark the claim db_committed, COMMIT, then the post-commit
    // sendPendingOutbox drain (mocked to see zero pending rows, matching
    // every other accept test in this file -- this suite asserts outbox
    // CONTENT via the INSERT calls themselves, never the Twilio-send drain),
    // then markCompleted.
    function mockRecordTail(): void {
      mockQuery.mockResolvedValueOnce(ok()); // processed db_committed
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // COMMIT
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // no pending outbox rows
      mockQuery.mockResolvedValueOnce(ok()); // markCompleted
    }

    // Review finding (coverage gap): parses every `UPDATE whatsapp_conversations`
    // call's actual state_context JSON payload (updateConversation's params
    // are [id, ...values], so the JSON-serialized state_context is params[1])
    // so tests can assert on the WRITTEN PATCH CONTENT -- not just "some
    // update ran" or a brittle substring match -- confirming the arm/switch
    // write both sets fill_application_id to the new application AND scrubs
    // pending_picker/fill_pending/fill_cert_more_pending in that SAME write.
    function stateContextUpdates(): Record<string, unknown>[] {
      return mockQuery.mock.calls
        .filter(([sql]) => /UPDATE whatsapp_conversations/i.test(sql as string))
        .map(([, params]) => JSON.parse((params as unknown[])[1] as string) as Record<string, unknown>);
    }

    it('typed accept uses the stored recent job id', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-accept' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'idle',
            user_id: 'user-1',
            state_context: { recent_jobs: ['job-1', 'job-2'] },
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr' }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // applyWorkerToJob: setInternalUserRlsContext
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'job-1', required_docs: [], optional_docs: [] }] }) // applyWorkerToJob: job check
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }); // INSERT job application
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // INSERT outbox accepted
      mockRecordTail();

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-accept',
          From: 'whatsapp:+15125551234',
          Body: '1 aceptar',
        }),
        {} as any,
        {} as any,
      );

      const applicationInsert = findQueryByPattern(/INSERT INTO job_applications/i);
      // prompt_answers starts '{}' on this surface: an accept is a one-tap
      // reply that cannot carry answers.
      expect(applicationInsert).toEqual(['job-1', 'user-1', JSON.stringify({})]);
      // Sprint 23: no prompts on this job, so the confirmation is the whole
      // reply -- nothing is collected and no lane is armed.
      expect(outboxBodies()).toContain(t('job_accepted', 'es'));
    });

    // Task 4 (WhatsApp pay localization): the "<n> info"/"<n> informacion"
    // job-details text block used to COALESCE(pay, 'Pay not specified') in
    // SQL -- an English fallback even for a Spanish conversation. It now
    // renders via the same structured-first/legacy-second/localized-third
    // fallback chain as the job template.
    async function runTypedInfoAction(
      language: 'en' | 'es',
      jobRow: Record<string, unknown>,
    ): Promise<string> {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-info' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'idle',
            user_id: 'user-1',
            language,
            state_context: { recent_jobs: ['job-1'] },
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({ rowCount: 1, rows: [jobRow] }) // job lookup
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox job-details text
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      // `parseTypedJobAction` (flows.ts) only recognizes the literal verb
      // "info" -- there is no separate Spanish verb for it -- so both
      // locales are exercised through the same typed command text; the
      // conversation's stored language is what drives the localized reply.
      await handler(
        makeSqsEvent({
          MessageSid: 'SM-info',
          From: 'whatsapp:+15125551234',
          Body: '1 info',
        }),
        {} as any,
        {} as any,
      );

      const textInsert = mockQuery.mock.calls.find(([sql, params]) =>
        /INSERT INTO whatsapp_outbox/i.test(sql as string)
        && Array.isArray(params)
        && typeof params[2] === 'string'
        && (params[2] as string).includes(jobRow.title as string),
      );
      expect(textInsert).toBeDefined();
      return (textInsert![1] as unknown[])[2] as string;
    }

    it('renders Spanish structured pay text in the job-details block for an ES worker', async () => {
      const body = await runTypedInfoAction('es', {
        id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso',
        pay_min: 15, pay_max: 20, pay_interval: 'hourly', pay_raw: '$25/hr',
      });
      expect(body).toContain('$15-$20/hora');
      expect(body).toContain('Detalles del trabajo');
    });

    it('renders English structured pay text in the job-details block for an EN worker', async () => {
      const body = await runTypedInfoAction('en', {
        id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso',
        pay_min: 15, pay_max: 20, pay_interval: 'hourly', pay_raw: '$25/hr',
      });
      expect(body).toContain('$15-$20/hour');
      expect(body).toContain('Job details');
    });

    it('falls back to the raw legacy pay string in the job-details block when structured fields are null', async () => {
      const body = await runTypedInfoAction('es', {
        id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso',
        pay_min: null, pay_max: null, pay_interval: null, pay_raw: 'Negociable',
      });
      expect(body).toContain('Negociable');
    });

    it('falls back to a localized "not specified" placeholder in the job-details block when everything is null', async () => {
      const esBody = await runTypedInfoAction('es', {
        id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso',
        pay_min: null, pay_max: null, pay_interval: null, pay_raw: null,
      });
      expect(esBody).toContain('Pago no especificado');
    });

    // §4.2a: relaying a non-OTP reply while awaiting_otp is CONVERSATION-SCOPED.
    // It must NOT bind identity (no user_id / conversation_state write) — account
    // access still requires a completed OTP. The reply is still relayed to the
    // worker's open employer thread, and the cognito_session is preserved.
    it('relays worker text to an open employer conversation while awaiting OTP WITHOUT binding identity', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-worker-reply' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'awaiting_otp',
            user_id: 'worker-1',
            language: 'es',
            state_context: { cognito_session: 'stale-session' },
            otp_expires_at: new Date(Date.now() + 60_000),
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ tos_version: '1.0' }] }) // legal-wall tos-gate (relay is compliance-gated)
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'job-conv-1', application_id: 'app-1' }] }) // single open job conversation
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT worker message
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE job conversation timestamps
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE application status
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no waiting employer messages
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE whatsapp_conversations focus column
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending whatsapp_outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set job outbox actor
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending job outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // clear job outbox actor
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-worker-reply',
          From: 'whatsapp:+15125551234',
          Body: 'Buenas tardes',
        }),
        {} as any,
        {} as any,
      );

      expect(mockCognitoSend).not.toHaveBeenCalled();
      // The reply was relayed into the open employer thread.
      expect(findQueryByPattern(/INSERT INTO job_conversation_messages/i)).toEqual([
        'job-conv-1',
        'Buenas tardes',
        'SM-worker-reply',
        'whatsapp:+15125551234',
      ]);

      // §4.2a: the RELAY code's own write is ONLY the focus-column update — it
      // must not set user_id, must not flip the state, and must not clear
      // state_context to '{}'. (A separate, unconditional v2 forced-idle
      // writeback also runs earlier in this turn — that's expected,
      // documented v2 behavior covered by the 'v2 routing branch' suite, not
      // what this test protects.)
      const convUpdate = mockQuery.mock.calls.find(([sql]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string)
        && /focused_job_conversation_id/i.test(sql as string));
      expect(convUpdate).toBeTruthy();
      const [convUpdateSql, convUpdateParams] = convUpdate as [string, unknown[]];
      expect(convUpdateSql).toMatch(/focused_job_conversation_id/);
      expect(convUpdateSql).not.toMatch(/\buser_id\b\s*=/);
      expect(convUpdateSql).not.toMatch(/conversation_state\s*=/);
      // The cleared-context binding params are gone.
      expect(convUpdateParams).not.toContain('idle');
      expect(convUpdateParams).not.toContain('{}');
      expect(convUpdateParams).toContain('job-conv-1');
    });

    it('opens an employer conversation from a WhatsApp button before OTP routing', async () => {
      const conversationId = '11111111-2222-3333-4444-555555555555';
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-open-conversation' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'awaiting_otp',
            user_id: 'worker-1',
            language: 'es',
            state_context: { cognito_session: 'stale-session' },
            otp_expires_at: new Date(Date.now() + 60_000),
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ tos_version: '1.0' }] }) // legal-wall tos-gate (open is compliance-gated)
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: conversationId, application_id: 'app-1', worker_thread_number: 1, job_title: 'Plomero', company: 'ACME' }] }) // open job conversation
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE job conversation reply window
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE application status
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'msg-1', body: 'Employer says hello' }] }) // waiting employer messages
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT job outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE employer message queued
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // reset WhatsApp conversation to idle
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending whatsapp_outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set job outbox actor
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            id: 'job-outbox-1',
            message_id: 'msg-1',
            whatsapp_number: '+15125551234',
            body: '🏢 ACME — Plomero (#1)\nEmployer says hello',
            content_template: null,
            content_variables: null,
          }],
        }) // pending job outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // mark job outbox sent
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // mark message sent
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // clear job outbox actor
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-open-conversation',
          From: 'whatsapp:+15125551234',
          Body: 'Abrir conversacion',
          ButtonPayload: `conversation:open:${conversationId}`,
        }),
        {} as any,
        {} as any,
      );

      expect(mockCognitoSend).not.toHaveBeenCalled();
      expect(findQueryByPattern(/INSERT INTO job_message_outbox/i)).toEqual([
        conversationId,
        'msg-1',
        '+15125551234',
        '🏢 ACME — Plomero (#1)\nEmployer says hello',
      ]);
      // R10: opening a conversation must NOT reset onboarding. The focus update
      // sets focused_job_conversation_id + state_context (pending_picker cleared,
      // all other collected answers preserved) + last_processed_message_sid.
      // It must not set user_id or flip conversation_state. (A separate,
      // unconditional v2 forced-idle writeback also runs earlier in this
      // turn — expected v2 behavior, not what this test protects.)
      const convOpenUpdate = mockQuery.mock.calls.find(([sql]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string)
        && /focused_job_conversation_id/i.test(sql as string));
      expect(convOpenUpdate).toBeTruthy();
      const [convOpenSql, convOpenParams] = convOpenUpdate as [string, unknown[]];
      expect(convOpenSql).toMatch(/focused_job_conversation_id/);
      expect(convOpenSql).not.toMatch(/\buser_id\b\s*=/);
      expect(convOpenSql).not.toMatch(/conversation_state\s*=/);
      // state_context IS written (to clear pending_picker) but must preserve session
      expect(convOpenSql).toMatch(/state_context\s*=/);
      expect(convOpenParams).toEqual(['conv-1', conversationId, '{"cognito_session":"stale-session"}', 'SM-open-conversation']);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Employer+says+hello'),
        }),
      );
    });

    it('opens latest employer conversation when Twilio sends button label text without ButtonPayload', async () => {
      const conversationId = '11111111-2222-3333-4444-555555555555';
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-open-text' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'awaiting_otp',
            user_id: 'worker-1',
            language: 'es',
            state_context: { cognito_session: 'stale-session' },
            otp_expires_at: new Date(Date.now() + 60_000),
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ tos_version: '1.0' }] }) // legal-wall tos-gate (open is compliance-gated)
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: conversationId, application_id: 'app-1', worker_thread_number: 1, job_title: 'Plomero', company: 'ACME' }] }) // latest open job conversation
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE job conversation reply window
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE application status
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'msg-1', body: 'Employer says hello' }] }) // waiting employer messages
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT job outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE employer message queued
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // reset WhatsApp conversation to idle
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending whatsapp_outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set job outbox actor
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            id: 'job-outbox-1',
            message_id: 'msg-1',
            whatsapp_number: '+15125551234',
            body: '🏢 ACME — Plomero (#1)\nEmployer says hello',
            content_template: null,
            content_variables: null,
          }],
        }) // pending job outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // mark job outbox sent
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // mark message sent
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // clear job outbox actor
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-open-text',
          From: 'whatsapp:+15125551234',
          Body: 'Abrir',
        }),
        {} as any,
        {} as any,
      );

      expect(mockCognitoSend).not.toHaveBeenCalled();
      expect(findQueryByPattern(/INSERT INTO job_message_outbox/i)).toEqual([
        conversationId,
        'msg-1',
        '+15125551234',
        '🏢 ACME — Plomero (#1)\nEmployer says hello',
      ]);
      // R10: same as the button path — opening via text action writes the focus
      // column and state_context (pending_picker cleared, existing fields preserved)
      // but never resets identity or conversation_state. (A separate,
      // unconditional v2 forced-idle writeback also runs earlier in this
      // turn — expected v2 behavior, not what this test protects.)
      const convOpenTextUpdate = mockQuery.mock.calls.find(([sql]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string)
        && /focused_job_conversation_id/i.test(sql as string));
      expect(convOpenTextUpdate).toBeTruthy();
      const [convOpenTextSql, convOpenTextParams] = convOpenTextUpdate as [string, unknown[]];
      expect(convOpenTextSql).toMatch(/focused_job_conversation_id/);
      expect(convOpenTextSql).not.toMatch(/\buser_id\b\s*=/);
      expect(convOpenTextSql).not.toMatch(/conversation_state\s*=/);
      // state_context IS written (to clear pending_picker) but must preserve session
      expect(convOpenTextSql).toMatch(/state_context\s*=/);
      expect(convOpenTextParams).toEqual(['conv-1', conversationId, '{"cognito_session":"stale-session"}', 'SM-open-text']);
    });

    it('routes idle worker text to its focused employer conversation (focus column)', async () => {
      const activeConversationId = '11111111-2222-3333-4444-555555555555';
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-active-reply' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'idle',
            user_id: 'worker-1',
            language: 'es',
            focused_job_conversation_id: activeConversationId,
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ tos_version: '1.0' }] }) // legal-wall tos-gate
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: activeConversationId, application_id: 'app-1' }],
        }) // focused job conversation lookup
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT worker message
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE job conversation timestamps
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE application status
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no waiting employer messages
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending whatsapp_outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set job outbox actor
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending job outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // clear job outbox actor
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-active-reply',
          From: 'whatsapp:+15125551234',
          Body: 'Buenas tardes',
        }),
        {} as any,
        {} as any,
      );

      const activeConversationLookup = mockQuery.mock.calls.find(([sql, params]) =>
        /FROM job_conversations/i.test(sql as string)
        && Array.isArray(params)
        && params[0] === activeConversationId
        && params[1] === 'worker-1'
      );
      expect(activeConversationLookup).toBeTruthy();
      expect(findQueryByPattern(/INSERT INTO job_conversation_messages/i)).toEqual([
        activeConversationId,
        'Buenas tardes',
        'SM-active-reply',
        'whatsapp:+15125551234',
      ]);
    });

    // ── Sprint 23: accept is STAGE 1 ONLY ────────────────────────────────
    //
    // Every "accept arms the fill" case that used to live here is gone with
    // the behavior. An accept now creates the row and, at most, asks the
    // employer's own pre_application_prompts. The stage-2 collector is armed
    // exclusively by `armFill`, reached from the details-requested template's
    // Start button, an `aplicaciones` pick, or the idle fallback -- covered
    // below and, for the arm itself, in application-fill.test.ts.
    //
    // The `guard_blocked` case is deleted rather than adapted: 091 drops the
    // 022 trigger that raised it and the union member is gone, so the branch
    // it exercised is unsatisfiable.
    it('typed accept on a job with required docs does NOT arm stage 2', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-missing-docs' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'idle',
            user_id: 'user-1',
            language: 'en',
            state_context: { recent_jobs: ['job-1'] },
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr' }],
        }) // handleJobAction's own job SELECT
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // applyWorkerToJob: setInternalUserRlsContext
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'job-1', required_docs: ['resume'], optional_docs: [] }],
        }) // applyWorkerToJob: job check -- no allow_incomplete_docs GUC any more (091 dropped the guard)
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }],
        }) // INSERT job application
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // document snapshot copy (non-cert) -- nothing to copy
        .mockResolvedValueOnce(ok()); // INSERT outbox job_accepted
      mockRecordTail();

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-missing-docs',
          From: 'whatsapp:+15125551234',
          Body: '1 accept',
        }),
        {} as any,
        {} as any,
      );

      const bodies = outboxBodies();
      expect(bodies).toContain(t('job_accepted', 'en'));
      expect(bodies).not.toContain(docPrompt('resume', 'en'));
      // Nothing armed: no state_context write at all on this turn.
      expect(stateContextUpdates().some((sc) => sc.fill_application_id === 'app-1')).toBe(false);
    });

    it('typed accept on a job with pre_application_prompts asks the first prompt instead of confirming', async () => {
      const prompts = [
        { id: 'p1', text: 'Do you have your own tools?' },
        { id: 'p2', text: 'When can you start?' },
      ];
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-accept-prompts' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'idle',
            user_id: 'user-1',
            language: 'en',
            state_context: { recent_jobs: ['job-1'] },
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr',
            pre_application_prompts: prompts,
          }],
        }) // handleJobAction's own job SELECT -- now carries the prompts
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // applyWorkerToJob: setInternalUserRlsContext
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'job-1', required_docs: [], optional_docs: [], pre_application_prompts: prompts }],
        }) // applyWorkerToJob: job check
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }],
        }); // INSERT job application (prompt_answers starts '{}')
      // armPromptLane -> advance: an UNSYNCED snapshot load (prompts need no
      // document sync), then the arm write, then the first question.
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'app-1', worker_id: 'user-1', job_id: 'job-1',
          application_status: 'pending', application_answers: {}, prompt_answers: {},
          details_requested_at: null, details_completed_at: null,
          applied_at: 'ts', updated_at: 'ts',
          job_status: 'active', job_title: 'Electrician',
          required_fields: [], optional_fields: [], required_docs: [], optional_docs: [],
          certification_requirements: null, pre_application_prompts: prompts, have_docs: [],
        }],
      });
      mockStateContextUpdate(); // prompt_application_id armed, fill keys scrubbed
      mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox: first prompt
      mockRecordTail();

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-accept-prompts',
          From: 'whatsapp:+15125551234',
          Body: '1 accept',
        }),
        {} as any,
        {} as any,
      );

      const bodies = outboxBodies();
      expect(bodies).toContain(
        fillMessage('prompt_ask', 'en', { i: '1', n: '2', text: 'Do you have your own tools?' }),
      );
      // The confirmation waits until the last prompt is answered.
      expect(bodies).not.toContain(t('job_accepted', 'en'));
      const armWrite = stateContextUpdates().find((sc) => sc.prompt_application_id === 'app-1');
      expect(armWrite).toBeDefined();
      // Mutual exclusion: arming the prompt lane clears every fill key.
      expect(armWrite?.fill_application_id).toBeNull();
      expect(armWrite?.fill_pending).toBeNull();
      expect(armWrite?.applications_menu).toBeNull();
    });

    it('already_applied on a promptless job confirms with job_already_applied and arms nothing', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-reapply' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'idle',
            user_id: 'user-1',
            language: 'en',
            state_context: { recent_jobs: ['job-1'] },
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr' }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // applyWorkerToJob: setInternalUserRlsContext
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'job-1', required_docs: [], optional_docs: [] }],
        }) // applyWorkerToJob: job check
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // INSERT ... ON CONFLICT DO NOTHING -- already applied
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }],
        }) // existing application lookup
        .mockResolvedValueOnce(ok()); // INSERT outbox job_already_applied
      mockRecordTail();

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-reapply',
          From: 'whatsapp:+15125551234',
          Body: '1 accept',
        }),
        {} as any,
        {} as any,
      );

      expect(outboxBodies()).toContain(t('job_already_applied', 'en'));
      // Nothing armed. (The v2 forced-idle writeback is itself an
      // `UPDATE whatsapp_conversations`, so this asserts on the KEYS rather
      // than on "no write happened".)
      expect(stateContextUpdates().some((sc) => 'prompt_application_id' in sc || 'fill_application_id' in sc)).toBe(false);
    });

    // ── Sprint 23: the three doors into stage 2 ──────────────────────────
    describe('application stage-2 entry points', () => {
      // The fuller tail: these turns resolve to a bound worker, so
      // processRecord's Phase 2 also drains the job-message outbox.
      function mockBoundWorkerTail(): void {
        mockQuery
          .mockResolvedValueOnce(ok()) // processed db_committed
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending whatsapp_outbox rows
          .mockResolvedValueOnce(ok()) // set job outbox actor
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending job outbox rows
          .mockResolvedValueOnce(ok()) // clear job outbox actor
          .mockResolvedValueOnce(ok()); // markCompleted
      }

      function mockConvTurn(sid: string, stateContext: Record<string, unknown> = {}): void {
        mockQuery
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: sid }] }) // claim
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [convRow({
              conversation_state: 'idle',
              user_id: 'user-1',
              language: 'en',
              state_context: stateContext,
            })],
          })
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // v2 forced-idle writeback
      }

      it('the Start button arms stage 2: seeds defaults, scrubs both lanes, sends the intro then the first question', async () => {
        mockConvTurn('SM-app-start');
        mockFillSnapshotRow({ required_fields: ['work_authorization'] }); // handleApplicationStart's own load
        mockSeedNoDefaults();
        mockStateContextUpdate(); // arm write
        mockFillSnapshotRow({ required_fields: ['work_authorization'] }); // armFill's post-seed counts
        mockCompanyLookup('ABC');
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox intro
        mockFillSnapshotRow({ required_fields: ['work_authorization'] }); // promptNextStep's re-derive
        mockStateContextUpdate(); // fill_last_prompt_at stamp
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox field question
        mockBoundWorkerTail();

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-app-start',
            From: 'whatsapp:+15125551234',
            Body: '',
            ButtonPayload: 'application:start:app-aaaaaaaa-0000-4000-8000-00000000000a',
          }),
          {} as any,
          {} as any,
        );

        const bodies = outboxBodies();
        expect(bodies).toContain(
          fillMessage('intro', 'en', { company: 'ABC', n_fields: '1', n_docs: '0' }),
        );
        expect(bodies).toContain(fieldQuestion('work_authorization', 'en'));
        const armWrite = stateContextUpdates().find((sc) => typeof sc.fill_application_id === 'string');
        expect(armWrite).toBeDefined();
        expect(armWrite?.prompt_application_id).toBeNull();
        expect(armWrite?.applications_menu).toBeNull();
      });

      it('the Start button for ANOTHER worker\'s application is ignored silently', async () => {
        mockConvTurn('SM-app-start-foreign');
        // jobapp_whatsapp_select is USING (true), so ownership is ours to
        // enforce -- and the refusal must not confirm the id exists.
        mockFillSnapshotRow({ worker_id: 'someone-else', required_fields: ['work_authorization'] });
        mockBoundWorkerTail();

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-app-start-foreign',
            From: 'whatsapp:+15125551234',
            Body: '',
            ButtonPayload: 'application:start:app-aaaaaaaa-0000-4000-8000-00000000000a',
          }),
          {} as any,
          {} as any,
        );

        expect(outboxBodies()).toEqual([]);
        expect(stateContextUpdates().some((sc) => 'fill_application_id' in sc)).toBe(false);
      });

      it('the Start button before the employer asked replies application_not_requested_yet', async () => {
        mockConvTurn('SM-app-start-early');
        mockFillSnapshotRow({ details_requested_at: null, required_fields: ['work_authorization'] });
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox
        mockBoundWorkerTail();

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-app-start-early',
            From: 'whatsapp:+15125551234',
            Body: '',
            ButtonPayload: 'application:start:app-aaaaaaaa-0000-4000-8000-00000000000a',
          }),
          {} as any,
          {} as any,
        );

        expect(outboxBodies()).toEqual([t('application_not_requested_yet', 'en')]);
        expect(stateContextUpdates().some((sc) => 'fill_application_id' in sc)).toBe(false);
      });

      it('the Later button writes NOTHING and just acknowledges', async () => {
        mockConvTurn('SM-app-later');
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox ack
        mockBoundWorkerTail();

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-app-later',
            From: 'whatsapp:+15125551234',
            Body: '',
            ButtonPayload: 'application:later:app-aaaaaaaa-0000-4000-8000-00000000000a',
          }),
          {} as any,
          {} as any,
        );

        expect(outboxBodies()).toEqual([t('application_later_ack', 'en')]);
        // Locked decision: Later is not a DB write -- the application is not
        // even READ, let alone updated.
        expect(stateContextUpdates().some((sc) => 'fill_application_id' in sc)).toBe(false);
        expect(countQueryByPattern(/FROM job_applications/i)).toBe(0);
      });

      it('"applications" is answered by the list even while a fill is armed -- it never reaches the fill lane', async () => {
        mockConvTurn('SM-app-list', { fill_application_id: 'app-1' });
        mockQuery.mockResolvedValueOnce(ok()); // setInternalUserRlsContext (070's jobs_worker_read_applied)
        mockQuery.mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            id: 'app-9', title: 'Painter', status: 'contacted',
            needs_details: true, company_name: 'RM Construction',
          }],
        }); // the one applications SELECT
        mockStateContextUpdate(); // applications_menu armed
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox list
        mockBoundWorkerTail();

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-app-list',
            From: 'whatsapp:+15125551234',
            Body: 'applications',
          }),
          {} as any,
          {} as any,
        );

        const body = outboxBodies()[0];
        expect(body).toContain(t('applications_header', 'en'));
        expect(body).toContain('1) Painter - RM Construction - Under review - Details needed');
        expect(body).toContain(t('applications_footer', 'en'));
        // The armed fill never saw the word: no field question, no re-derive
        // beyond the list's own SELECT.
        expect(outboxBodies()).toHaveLength(1);
        const menuWrite = stateContextUpdates().find((sc) => sc.applications_menu);
        expect((menuWrite?.applications_menu as { ids: string[] }).ids).toEqual(['app-9']);
      });

      it('the idle fallback sends the applications list instead of idle_help when the employer is waiting', async () => {
        // The third door into stage 2: a worker who replied to the
        // details-requested notification in their own words instead of
        // tapping anything. Without this they got "I did not understand
        // that" while an employer sat waiting on them.
        mockConvTurn('SM-idle-needs-details');
        mockQuery
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ tos_version: '1.0' }] }) // relay: workerHasAcceptedTos
          .mockResolvedValueOnce(ok()) // relay: setInternalUserRlsContext
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // relay: accepted open threads -- none
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // relay: unaccepted open threads -- none
        mockQuery.mockResolvedValueOnce(ok()); // idle fallback: setInternalUserRlsContext
        mockQuery.mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            id: 'app-9', title: 'Painter', status: 'contacted',
            needs_details: true, company_name: 'RM Construction',
          }],
        }); // idle fallback: the applications SELECT
        mockStateContextUpdate(); // applications_menu armed
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox list
        mockBoundWorkerTail();

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-idle-needs-details',
            From: 'whatsapp:+15125551234',
            Body: 'zzz zzz',
          }),
          {} as any,
          {} as any,
        );

        const bodies = outboxBodies();
        expect(bodies).not.toContain(t('idle_help', 'en'));
        expect(bodies[0]).toContain(t('applications_header', 'en'));
        expect(bodies[0]).toContain(t('applications_footer', 'en'));
      });

      it('the idle fallback still says idle_help when nothing needs details', async () => {
        mockConvTurn('SM-idle-no-details');
        mockQuery
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ tos_version: '1.0' }] }) // relay: workerHasAcceptedTos
          .mockResolvedValueOnce(ok()) // relay: setInternalUserRlsContext
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // relay: accepted open threads
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // relay: unaccepted open threads
        mockQuery.mockResolvedValueOnce(ok()); // idle fallback: setInternalUserRlsContext
        mockQuery.mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            id: 'app-9', title: 'Painter', status: 'pending',
            needs_details: false, company_name: 'RM Construction',
          }],
        }); // nothing outstanding
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox idle_help
        mockBoundWorkerTail();

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-idle-no-details',
            From: 'whatsapp:+15125551234',
            Body: 'zzz zzz',
          }),
          {} as any,
          {} as any,
        );

        expect(outboxBodies()).toEqual([t('idle_help', 'en')]);
        // Nothing is armed when there is nothing to pick.
        expect(stateContextUpdates().some((sc) => sc.applications_menu)).toBe(false);
      });

      it('recovers an application payload that arrived in the BODY, not ButtonPayload', async () => {
        // findKnownPayload's `application:` prefix is what makes the
        // ListId / InteractiveData / ChannelMetadata / raw-Body recovery
        // paths work for these taps; without it the worker's Later tap would
        // be read as ordinary free text.
        mockConvTurn('SM-app-body-payload');
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox ack
        mockBoundWorkerTail();

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-app-body-payload',
            From: 'whatsapp:+15125551234',
            Body: 'application:later:app-aaaaaaaa-0000-4000-8000-00000000000a',
          }),
          {} as any,
          {} as any,
        );

        expect(outboxBodies()).toEqual([t('application_later_ack', 'en')]);
      });

      it('a bare digit against the armed menu dispatches exactly like the Start button', async () => {
        mockConvTurn('SM-app-pick', {
          applications_menu: { ids: ['aaaaaaaa-0000-4000-8000-00000000000a'], at: Date.now() },
        });
        mockFillSnapshotRow({ required_fields: ['work_authorization'] });
        mockSeedNoDefaults();
        mockStateContextUpdate(); // arm write
        mockFillSnapshotRow({ required_fields: ['work_authorization'] });
        mockCompanyLookup('ABC');
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox intro
        mockFillSnapshotRow({ required_fields: ['work_authorization'] });
        mockStateContextUpdate(); // fill_last_prompt_at stamp
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox field question
        mockBoundWorkerTail();

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-app-pick',
            From: 'whatsapp:+15125551234',
            Body: '1',
          }),
          {} as any,
          {} as any,
        );

        expect(outboxBodies()).toContain(fieldQuestion('work_authorization', 'en'));
      });
    });

    describe('Task 10: fill-lane dispatch precedence', () => {
      it('exact "trabajos" escapes to the jobs listing, then the dispatch tail re-prompts the pending field question', async () => {
        mockListMatchedJobsForWorker.mockResolvedValue([
          { id: 'job-2', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr' },
        ]);

        mockQuery
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-fill-trabajos' }] }) // claim
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [convRow({
              conversation_state: 'idle',
              user_id: 'user-1',
              // Spanish: "trabajos" is itself an ES_LANG_WORDS entry
              // (flows.ts's detectCommandLanguage), so starting the
              // conversation already in Spanish avoids an unrelated
              // language-switch UPDATE query between the v2 writeback and
              // the Task 10 seam.
              language: 'es',
              state_context: { fill_application_id: 'app-1' },
            })],
          })
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
          // Task 10 seam: handleFillMessage's jobId refresh, then it
          // escapes (exact jobs keyword, spec §6.3) -- handled:false.
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ job_id: 'job-1' }] })
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context (jobs listing)
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation recent_jobs
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // INSERT template outbox job-2
        mockFillSnapshotRow({ required_fields: ['work_authorization'], application_answers: {} }); // dispatch-tail re-prompt
        mockStateContextUpdate(); // fill_last_prompt_at stamp
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox field question
        mockRecordTail();

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-fill-trabajos',
            From: 'whatsapp:+15125551234',
            Body: 'trabajos',
          }),
          {} as any,
          {} as any,
        );

        expect(mockListMatchedJobsForWorker).toHaveBeenCalled();
        expect(outboxTemplates()).toContain('job_alert_es');
        expect(outboxBodies()).toContain(fieldQuestion('work_authorization', 'es'));
      });

      it('help command escapes and the dispatch tail re-prompts (no prior cooldown)', async () => {
        mockQuery
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-fill-help' }] }) // claim
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [convRow({
              conversation_state: 'idle',
              user_id: 'user-1',
              language: 'en',
              state_context: { fill_application_id: 'app-1' },
            })],
          })
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ job_id: 'job-1' }] }) // Task 10 seam: jobId refresh, then escapes (help)
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // INSERT outbox help_menu_list_en
        mockFillSnapshotRow({ required_fields: ['work_authorization'], application_answers: {} }); // dispatch-tail re-prompt
        mockStateContextUpdate(); // fill_last_prompt_at stamp
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox field question
        mockRecordTail();

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-fill-help',
            From: 'whatsapp:+15125551234',
            Body: 'help',
          }),
          {} as any,
          {} as any,
        );

        expect(outboxTemplates()).toContain('help_menu_list_en');
        expect(outboxBodies()).toContain(fieldQuestion('work_authorization', 'en'));
      });

      it('dispatch-tail cooldown: an escape within 30s of the last fill prompt gets NO re-prompt', async () => {
        mockQuery
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-fill-cooldown' }] }) // claim
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [convRow({
              conversation_state: 'idle',
              user_id: 'user-1',
              language: 'en',
              // The fill's last prompt landed 5s ago -- well inside
              // REPROMPT_COOLDOWN_MS (30s, onboarding-language.ts).
              state_context: { fill_application_id: 'app-1', fill_last_prompt_at: Date.now() - 5_000 },
            })],
          })
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ job_id: 'job-1' }] }) // Task 10 seam: jobId refresh, then escapes (help)
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // INSERT outbox help_menu_list_en
        mockRecordTail(); // no computeNextStep / re-prompt queries -- cooldown suppresses the tail entirely

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-fill-cooldown',
            From: 'whatsapp:+15125551234',
            Body: 'help',
          }),
          {} as any,
          {} as any,
        );

        expect(outboxTemplates()).toContain('help_menu_list_en');
        // No re-derive of the fill's current step -- the tail never ran.
        expect(countQueryByPattern(/FROM job_applications ja/i)).toBe(0);
      });

      it('CANCELAR mid-fill is handled entirely by the seam -- no tail re-prompt, no other routing', async () => {
        mockQuery
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-fill-cancel' }] }) // claim
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [convRow({
              conversation_state: 'idle',
              user_id: 'user-1',
              language: 'en',
              state_context: { fill_application_id: 'app-1' },
            })],
          })
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
          // Task 10 seam: CANCELAR short-circuits handleFillMessage BEFORE
          // any query (isFillCancel guard) -- the two queries below are its
          // OWN scrub write + canceled reply, not a jobId lookup.
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE state_context (fill scrub)
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // INSERT outbox canceled
        // handled:true returns `conv.user_id` ('user-1') from routeMessage,
        // so processRecord's Phase 2 also drains the job-message outbox for
        // that actor -- the fuller tail (not the plain 4-query
        // mockRecordTail()) is needed here, same as any other handled turn
        // that resolves to a bound worker.
        mockQuery
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending whatsapp_outbox rows
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set job outbox actor
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending job outbox rows
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // clear job outbox actor
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-fill-cancel',
            From: 'whatsapp:+15125551234',
            Body: 'CANCELAR',
          }),
          {} as any,
          {} as any,
        );

        expect(outboxBodies()).toEqual([fillMessage('canceled', 'en')]);
        // handled:true returns immediately -- routeReadyWorkerCommands (and
        // therefore the dispatch tail) never runs.
        expect(countQueryByPattern(/FROM job_applications ja/i)).toBe(0);
      });

      it('relay-override is consumed once: the free text still relays to the focused employer, then the fill re-prompts', async () => {
        const activeConversationId = '22222222-3333-4444-5555-666666666666';
        mockQuery
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-fill-relay' }] }) // claim
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [convRow({
              conversation_state: 'idle',
              user_id: 'worker-1',
              language: 'es',
              focused_job_conversation_id: activeConversationId,
              state_context: {
                fill_application_id: 'app-fill-1',
                fill_relay_override: true,
                fill_last_prompt_at: Date.now() - 60_000, // outside the cooldown
              },
            })],
          })
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
          // Task 10 seam: jobId refresh, then the relay-override clear+fall-through.
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ job_id: 'job-fill-1' }] })
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE state_context clearing fill_relay_override
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ tos_version: '1.0' }] }) // legal-wall tos-gate
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [{ id: activeConversationId, application_id: 'app-1' }],
          }) // focused job conversation lookup
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT worker message
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE job conversation timestamps
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE application status
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // no waiting employer messages
        mockFillSnapshotRow({ worker_id: 'worker-1', job_id: 'job-fill-1', required_fields: ['work_authorization'], application_answers: {} }); // dispatch-tail re-prompt
        mockStateContextUpdate(); // fill_last_prompt_at stamp
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox field question
        mockQuery
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending whatsapp_outbox rows
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set job outbox actor
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending job outbox rows
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // clear job outbox actor
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-fill-relay',
            From: 'whatsapp:+15125551234',
            Body: 'Hola, tengo una pregunta',
          }),
          {} as any,
          {} as any,
        );

        // The message relayed to the employer thread exactly as if no fill
        // were armed...
        expect(findQueryByPattern(/INSERT INTO job_conversation_messages/i)).toEqual([
          activeConversationId,
          'Hola, tengo una pregunta',
          'SM-fill-relay',
          'whatsapp:+15125551234',
        ]);
        // ...clearing the one-turn override in the same write (never a
        // separate later write)...
        const overrideClears = stateContextUpdates().filter((sc) => sc.fill_relay_override === null);
        expect(overrideClears.length).toBeGreaterThanOrEqual(1);
        // ...and the fill still re-prompts afterward, cooldown-permitting.
        expect(outboxBodies()).toContain(fieldQuestion('work_authorization', 'es'));
      });

      // Review finding (Important, coverage gap): every test above is an
      // ESCAPE scenario (handled:false) -- none exercises the far more
      // common turn where the seam's answer IS the fill's own field
      // answer. This drives a plain deterministic answer ("1" for
      // work_authorization) all the way through `routeMessage` and
      // confirms: the merge UPDATE ran with the validated value, the next
      // question was queued on the SAME inbound SID, and the dispatch tail
      // never double-prompts (handled:true returns immediately from the
      // seam, before `routeReadyWorkerCommands`/`maybeRepromptFill` ever
      // run -- there is exactly one job_applications JOIN jobs SELECT
      // before the merge and exactly one after, never a third from a
      // tail re-derive).
      it('a plain field answer flows through the seam end-to-end: merges the value, queues the next prompt on the same inbound SID, and the dispatch tail does not double-prompt', async () => {
        mockQuery
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-fill-answer' }] }) // claim
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [convRow({
              conversation_state: 'idle',
              user_id: 'user-1',
              language: 'en',
              state_context: { fill_application_id: 'app-1' },
            })],
          })
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
          // Task 10 seam: handleFillMessage's jobId refresh.
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ job_id: 'job-1' }] });
        // computeNextStep (current step): work_authorization is outstanding.
        mockFillSnapshotRow({ required_fields: ['work_authorization', 'date_available'], application_answers: {} });
        // Sprint 23: the merge goes through the shared engine's
        // `mergeFieldAnswers` -- deps.setRls first (the defaults write-back
        // lands on FORCE-RLS worker_application_defaults), then the engine's
        // own snapshot load, the size-guarded merge, and the write-back.
        mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // set internal RLS context
        mockFieldMergeQueries({ required_fields: ['work_authorization', 'date_available'], application_answers: {} });
        // sendNextStepPrompt's own re-derive: date_available remains.
        mockFillSnapshotRow({
          required_fields: ['work_authorization', 'date_available'],
          application_answers: { work_authorization: true },
        });
        mockStateContextUpdate(); // fill_last_prompt_at stamp
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox: next field question
        // handled:true returns `conv.user_id` ('user-1') from routeMessage,
        // so processRecord's Phase 2 also drains the job-message outbox for
        // that actor -- same fuller tail as the CANCELAR/relay-override
        // tests above (not the plain 4-query mockRecordTail()).
        mockQuery
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending whatsapp_outbox rows
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set job outbox actor
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending job outbox rows
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // clear job outbox actor
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-fill-answer',
            From: 'whatsapp:+15125551234',
            Body: '1',
          }),
          {} as any,
          {} as any,
        );

        // The merge ran with the validated value.
        const mergeUpdate = mockQuery.mock.calls.find(([sql, params]) =>
          /UPDATE job_applications/i.test(sql as string)
          && Array.isArray(params)
          && params[0] === JSON.stringify({ work_authorization: true }),
        );
        expect(mergeUpdate).toBeDefined();

        // The next-step prompt was queued on the SAME inbound SID.
        const outboxInserts = mockQuery.mock.calls.filter(([sql, params]) =>
          /INSERT INTO whatsapp_outbox/i.test(sql as string)
          && Array.isArray(params)
          && params[0] === 'SM-fill-answer',
        );
        const promptInsert = outboxInserts.find(([, params]) =>
          (params as unknown[])[2] === fieldQuestion('date_available', 'en'));
        expect(promptInsert).toBeDefined();

        // The dispatch tail did NOT double-prompt: exactly one
        // whatsapp_outbox INSERT this turn, and exactly THREE snapshot loads
        // (the current-step derive, mergeFieldAnswers' own re-read, and
        // sendNextStepPrompt's re-derive) -- handled:true returns
        // immediately from the seam, so routeReadyWorkerCommands (and
        // therefore maybeRepromptFill) never runs and adds a fourth.
        expect(outboxInserts.length).toBe(1);
        expect(countQueryByPattern(/FROM job_applications ja/i)).toBe(3);
      });

      // Task 11: the seam gate itself (routeMessage) now fires when EITHER
      // fill_application_id OR fill_offer_application_id is set. Every test
      // above only ever exercises the first key -- this locks down the
      // WIRING for the second: with no fill_application_id at all, the seam
      // still gives handleFillMessage first refusal, which (per
      // application-fill.test.ts's own exhaustive coverage of
      // `resolveOfferOnlyTurn`) arms the offered application and prompts its
      // first gap on an affirmative reply.
      it('the seam fires when only fill_offer_application_id is set: "1" arms the offered application and prompts its first gap', async () => {
        mockQuery
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-fill-offer-accept' }] }) // claim
          .mockResolvedValueOnce({
            rowCount: 1,
            rows: [convRow({
              conversation_state: 'idle',
              user_id: 'user-1',
              language: 'en',
              // No fill_application_id at all -- only the continue-other offer.
              state_context: { fill_offer_application_id: 'app-2' },
            })],
          })
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // v2 forced-idle writeback
        mockStateContextUpdate(); // resolveOfferOnlyTurn's accept write (offer cleared, fill_application_id armed)
        mockFillSnapshotRow({ required_fields: ['work_authorization'], application_answers: {} }); // promptNextStep's re-derive
        mockStateContextUpdate(); // fill_last_prompt_at stamp
        mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox: first field question
        mockQuery
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending whatsapp_outbox rows
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set job outbox actor
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending job outbox rows
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // clear job outbox actor
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

        await handler(
          makeSqsEvent({
            MessageSid: 'SM-fill-offer-accept',
            From: 'whatsapp:+15125551234',
            Body: '1',
          }),
          {} as any,
          {} as any,
        );

        // The offer was consumed and turned into an armed fill in ONE write.
        const armWrite = stateContextUpdates().find((sc) => sc.fill_application_id === 'app-2');
        expect(armWrite).toBeDefined();
        expect(armWrite?.fill_offer_application_id).toBeNull();

        expect(outboxBodies()).toContain(fieldQuestion('work_authorization', 'en'));

        // Regression guard (Task 11 review, Critical): the outbox assertion
        // above alone does NOT catch a stale `ctx.stateContext` -- the mock
        // for computeNextStep's SELECT returns its canned row unconditionally,
        // regardless of what `applicationId` param it was actually called
        // with, so a `buildFillDeps.updateStateContext` that REASSIGNS
        // `conv.state_context` (instead of mutating it in place) would leave
        // `resolveOfferOnlyTurn`'s `ctx.stateContext.fill_application_id`
        // `undefined` post-arm, and `computeNextStep(client, undefined)`
        // would still "pass" this far since the mock never inspects params.
        // Assert on the CAPTURED param directly: the offered id, never
        // `undefined`.
        const computeNextStepCalls = mockQuery.mock.calls.filter(
          ([sql]) => /FROM job_applications ja JOIN jobs j/i.test(sql as string),
        );
        expect(computeNextStepCalls).toHaveLength(1);
        expect(computeNextStepCalls[0][1]).toEqual(['app-2']);
      });
    });
  });

  // ── R2-C6: the 053 web-worker bypass lane is GONE ──────────────────────
  //
  // Migration 053's `bypass_onboarding_for_web_worker` used to shunt a
  // worker who had signed up on the website straight to `lifecycle='ready'`
  // on their first WhatsApp message, ahead of `routeOnboardingV2` and gated
  // on `!conv.user_id && !voiceEvent`. R2 deleted that lane: web signup now
  // drives the SAME engine (`start_web_onboarding_workflow`, migration 086),
  // so a web worker's phone already has a real `worker_workflow_runs` row
  // and the ordinary pre-auth -> OTP -> bind path must resume it. These two
  // cases are the regression lock: routeMessage must issue NO phone lookup
  // of its own and hand every unbound first message to the v2 lane. The
  // replacement path itself is proven end-to-end against real PostgreSQL in
  // test/unit/db/web-worker-whatsapp-crossover.integration.test.ts.
  describe('no web-worker bypass lane', () => {
    it('hands an unbound conversation\'s first message straight to the v2 lane', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-no-bypass' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'new', language: 'en', user_id: null })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // tryConversationRelay → no match
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox idle_help
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-no-bypass',
          From: 'whatsapp:+15125551234',
          Body: 'random text',
        }),
        {} as any,
        {} as any,
      );

      expect(mockRouteOnboardingV2).toHaveBeenCalledTimes(1);
      // The eligibility lookup (`SELECT id FROM users WHERE phone = $1 ...`)
      // and the definer it guarded are both gone.
      expect(countQueryByPattern(/FROM users\s+WHERE phone/i)).toBe(0);
      expect(countQueryByPattern(/bypass_onboarding_for_web_worker/i)).toBe(0);
    });

    it('does the same on a synthetic voice-pipeline re-entry for an unbound conversation', async () => {
      mockRouteOnboardingV2.mockResolvedValue({
        handled: true,
        workerId: null,
        stepKey: 'trust.question.2',
      });

      const evt: TrustVoiceEventV2 = {
        version: 'v2',
        kind: 'trust_answer',
        status: 'COMPLETED',
        phone: '+15125551234',
        runId: 'run-1',
        stepKey: 'trust.question.1',
        language: 'en',
        origMessageSid: 'SM00000000000000000000000000000z',
        startedAt: '2026-07-27T00:00:00.000Z',
        questionIndex: 0,
        transcript: 'five years of experience',
        executionArn: 'arn:aws:states:us-east-2:000000000000:execution:fake-trust-voice-pipeline:vt-test',
      };
      const syntheticSid = syntheticVoiceSid(evt.origMessageSid, evt.kind);

      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: syntheticSid }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'onboarding_v2',
            user_id: null,
            whatsapp_number: '+15125551234',
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback (state_context only)
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(makeSyntheticVoiceSqsEvent(evt), {} as any, {} as any);

      expect(mockRouteOnboardingV2).toHaveBeenCalledTimes(1);
      expect(countQueryByPattern(/FROM users\s+WHERE phone/i)).toBe(0);
      expect(countQueryByPattern(/bypass_onboarding_for_web_worker/i)).toBe(0);
    });
  });

  // ── Task 15: media-board post lane wiring ───────────────────────────────
  //
  // handleIdle's own hook (Step 3) and the discard sites outside it (Step 4)
  // wire Task 14's pure post-creation.ts lane into the real processor. These
  // five cases are the task brief's mandatory list; the idle-voice-note
  // regression lock (case 2 -- no download/secret fetch for audio) is the
  // PRE-EXISTING "idle (legacy) worker sending a voice note..." test above
  // (~line 1100), deliberately left untouched.
  describe('Task 15: media-board post lane wiring', () => {
    const DISCARD_NOTICE_EN =
      "(I've set aside your unfinished post — send the photos again anytime.)";

    beforeEach(() => {
      process.env.MEDIA_BUCKET_NAME = 'jale-worker-media-test';
    });

    function stateContextUpdates(): Record<string, unknown>[] {
      return mockQuery.mock.calls
        .filter(([sql]) => /UPDATE whatsapp_conversations/i.test(sql as string))
        .map(([, params]) => JSON.parse((params as unknown[])[1] as string) as Record<string, unknown>);
    }

    /** Dispatches on SQL substrings (only claim + conv-select matter here) --
     * see the "filters the jobs list to the worker preferred cities" test
     * above for the same pattern. Every other query (BEGIN/COMMIT, RLS
     * set_config, the lane's own outbox/state writes, the post-commit
     * "no pending outbox rows" drain) is content-agnostic to these tests, so
     * a generic empty-result fallback is safe. */
    function mockConvRowRouting(conv: unknown): void {
      mockQuery.mockImplementation((sql: string) => {
        if (/INSERT INTO whatsapp_processed_messages/i.test(sql)) {
          return Promise.resolve({ rowCount: 1, rows: [{ message_sid: 'SM-post-lane' }] });
        }
        if (/FROM whatsapp_conversations/i.test(sql) && /SELECT/i.test(sql)) {
          return Promise.resolve({ rowCount: 1, rows: [conv] });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      });
    }

    it('1. idle worker sending a photo with no draft starts one and queues the classify prompt', async () => {
      mockDetectMediaCategory.mockReturnValue('photo');
      mockSniffPhotoType.mockReturnValue('image/jpeg');
      mockDownloadTwilioMediaBounded.mockResolvedValue(Buffer.from('fake-jpeg-bytes'));
      mockUploadMediaToS3.mockResolvedValue('v-1');

      mockConvRowRouting(convRow({
        conversation_state: 'idle',
        user_id: 'user-1',
        language: 'en',
        state_context: {},
      }));

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-post-lane',
          From: 'whatsapp:+15125551234',
          Body: '',
          NumMedia: '1',
          MediaUrl0: 'https://api.twilio.com/media/MEpost1',
          MediaSid0: 'MEpost1',
          MediaContentType0: 'image/jpeg',
        }),
        {} as any,
        {} as any,
      );

      expect(outboxTemplates()).toContain('onboarding_photo_type_en');
      expect(mockDownloadTwilioMediaBounded).toHaveBeenCalledTimes(1);
      expect(mockUploadMediaToS3).toHaveBeenCalledWith(
        'jale-worker-media-test',
        expect.stringMatching(/^user-1\/posts\/.+\.jpg$/),
        expect.any(Buffer),
        'image/jpeg',
      );
      const draftWrite = stateContextUpdates().find((sc) => sc.post_draft != null);
      expect(draftWrite).toBeDefined();
      const draft = draftWrite!.post_draft as {
        stage: string;
        media: { s3_version_id: string | null }[];
      };
      expect(draft.stage).toBe('classify');
      expect(draft.media).toHaveLength(1);
      expect(draft.media[0].s3_version_id).toBe('v-1');
    });

    // Case 2 (regression lock: idle worker + audio, no download/secret
    // fetch) is the pre-existing "idle (legacy) worker sending a voice
    // note..." test above (~line 1100) -- its CURRENT mock sequence is
    // deliberately left untouched; it stays green because
    // handlePostLaneMessage's own category gate (Task 14) returns
    // `handled: false` for non-photo media before touching `client` or
    // `deps.downloadMedia` at all.

    it('3. help command with an active draft discards it (with notice) before replying with the help menu', async () => {
      const draft = {
        post_id: 'post-1',
        stage: 'collecting',
        media: [{
          s3_key: 'user-1/posts/post-1/a.jpg', s3_version_id: 'v1',
          content_type: 'image/jpeg', file_size: 100, sort_order: 0,
        }],
        caption: null,
        started_at: new Date().toISOString(),
      };
      mockConvRowRouting(convRow({
        conversation_state: 'idle',
        user_id: 'user-1',
        language: 'en',
        state_context: { post_draft: draft },
      }));

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-post-lane',
          From: 'whatsapp:+15125551234',
          Body: 'help',
        }),
        {} as any,
        {} as any,
      );

      expect(outboxBodies()).toContain(DISCARD_NOTICE_EN);
      expect(outboxTemplates()).toContain('help_menu_list_en');
      const discardWrite = stateContextUpdates().find((sc) => sc.post_draft === null);
      expect(discardWrite).toBeDefined();
    });

    it('4. jobs keyword with an active draft discards it (with notice) and still lists jobs', async () => {
      mockListMatchedJobsForWorker.mockResolvedValue([
        { id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr' },
      ]);
      const draft = {
        post_id: 'post-1',
        stage: 'classify',
        media: [{
          s3_key: 'user-1/posts/post-1/a.jpg', s3_version_id: null,
          content_type: 'image/jpeg', file_size: 10, sort_order: 0,
        }],
        caption: null,
        started_at: new Date().toISOString(),
      };
      mockConvRowRouting(convRow({
        conversation_state: 'idle',
        user_id: 'user-1',
        language: 'en',
        state_context: { post_draft: draft },
      }));

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-post-lane',
          From: 'whatsapp:+15125551234',
          Body: 'jobs',
        }),
        {} as any,
        {} as any,
      );

      expect(outboxBodies()).toContain(DISCARD_NOTICE_EN);
      expect(outboxTemplates()).toContain('job_alert_en');
      const discardWrite = stateContextUpdates().find((sc) => sc.post_draft === null);
      expect(discardWrite).toBeDefined();
      expect(mockListMatchedJobsForWorker).toHaveBeenCalled();
    });

    it('5. a job-accept button tap with an active draft discards it (with notice) before the prompt lane asks', async () => {
      function ok(rowCount = 1): { rowCount: number; rows: unknown[] } {
        return { rowCount, rows: [] };
      }
      // A job-alert BUTTON tap is the one accept path that never reaches
      // handleIdle's own discard hook (Step 3), so this is the only case
      // that exercises step 4.2's guard inside handleJobAction itself.
      //
      // Sprint 23: accept no longer arms the fill, so the guard now protects
      // the PROMPT lane's free-text turns instead -- the job needs
      // pre_application_prompts for the discard site to be reached at all,
      // because a promptless accept solicits nothing.
      const prompts = [{ id: 'p1', text: 'Do you have your own tools?' }];

      const draft = {
        post_id: 'post-1',
        stage: 'classify',
        media: [{
          s3_key: 'user-1/posts/post-1/a.jpg', s3_version_id: null,
          content_type: 'image/jpeg', file_size: 10, sort_order: 0,
        }],
        caption: null,
        started_at: new Date().toISOString(),
      };

      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-accept-draft' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'idle',
            user_id: 'user-1',
            language: 'en',
            state_context: { post_draft: draft },
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr',
            pre_application_prompts: prompts,
          }],
        }) // handleJobAction's own job SELECT
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // applyWorkerToJob: setInternalUserRlsContext
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'job-1', required_docs: [], optional_docs: [], pre_application_prompts: prompts }],
        }) // applyWorkerToJob: job check
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }],
        }); // INSERT job application
      mockQuery.mockResolvedValueOnce(ok()); // discard: UPDATE whatsapp_conversations (post_draft -> null)
      mockQuery.mockResolvedValueOnce(ok()); // discard: INSERT outbox discarded_for_command reply
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'app-1', worker_id: 'user-1', job_id: 'job-1',
          application_status: 'pending', application_answers: {}, prompt_answers: {},
          details_requested_at: null, details_completed_at: null,
          applied_at: 'ts', updated_at: 'ts',
          job_status: 'active', job_title: 'Electrician',
          required_fields: [], optional_fields: [], required_docs: [], optional_docs: [],
          certification_requirements: null, pre_application_prompts: prompts, have_docs: [],
        }],
      }); // armPromptLane's snapshot load
      mockQuery.mockResolvedValueOnce(ok()); // arm: UPDATE whatsapp_conversations (prompt_application_id set)
      mockQuery.mockResolvedValueOnce(ok()); // INSERT outbox: first prompt
      mockQuery.mockResolvedValueOnce(ok()); // processed db_committed
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // COMMIT
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // no pending outbox rows
      mockQuery.mockResolvedValueOnce(ok()); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-accept-draft',
          From: 'whatsapp:+15125551234',
          Body: '',
          ButtonPayload: 'accept:job-job-1',
        }),
        {} as any,
        {} as any,
      );

      const bodies = outboxBodies();
      expect(bodies).toContain(DISCARD_NOTICE_EN);
      expect(bodies).toContain(
        fillMessage('prompt_ask', 'en', { i: '1', n: '1', text: 'Do you have your own tools?' }),
      );
      const discardWrite = stateContextUpdates().find((sc) => sc.post_draft === null);
      expect(discardWrite).toBeDefined();
      const armWrite = stateContextUpdates().find((sc) => sc.prompt_application_id === 'app-1');
      expect(armWrite).toBeDefined();
    });

    // ── C2 (final-review, critical): forward draft <-> relay gap ─────────
    //
    // A worker with a focused employer thread OR an armed pending_picker is
    // mid a structured-input flow that owns their next reply -- the post
    // lane's entry gate (handleIdle, above the voice-note check) must not
    // start a draft for either. Before this fix, an empty-body photo from a
    // focused worker started a draft here; the bot's own solicited
    // caption/classify prompt text was then indistinguishable from the
    // worker's actual next message, and `tryConversationRelay` (which only
    // gates on a non-empty body) would relay it straight to the employer.
    it('6. idle photo with a focused employer thread does NOT start a draft (falls to existing media handling)', async () => {
      mockConvRowRouting(convRow({
        conversation_state: 'idle',
        user_id: 'user-1',
        language: 'en',
        state_context: {},
        focused_job_conversation_id: 'employer-conv-1',
      }));

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-post-lane',
          From: 'whatsapp:+15125551234',
          Body: '',
          NumMedia: '1',
          MediaUrl0: 'https://api.twilio.com/media/MEfocused1',
          MediaSid0: 'MEfocused1',
          MediaContentType0: 'image/jpeg',
        }),
        {} as any,
        {} as any,
      );

      // Falls through to the pre-existing "not supported here" voice/media
      // reply instead of ever entering the post lane.
      expect(outboxTemplates()).not.toContain('onboarding_photo_type_en');
      expect(outboxBodies()).toContain(t('voice_note_not_supported', 'en'));
      expect(mockDownloadTwilioMediaBounded).not.toHaveBeenCalled();
      expect(mockUploadMediaToS3).not.toHaveBeenCalled();
      const draftWrite = stateContextUpdates().find((sc) => sc.post_draft != null);
      expect(draftWrite).toBeUndefined();
    });

    it('7. idle photo with an armed pending_picker does NOT start a draft (falls to existing media handling)', async () => {
      mockConvRowRouting(convRow({
        conversation_state: 'idle',
        user_id: 'user-1',
        language: 'en',
        state_context: { pending_picker: { kind: 'chats', threads: [] } },
      }));

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-post-lane',
          From: 'whatsapp:+15125551234',
          Body: '',
          NumMedia: '1',
          MediaUrl0: 'https://api.twilio.com/media/MEpicker1',
          MediaSid0: 'MEpicker1',
          MediaContentType0: 'image/jpeg',
        }),
        {} as any,
        {} as any,
      );

      expect(outboxTemplates()).not.toContain('onboarding_photo_type_en');
      expect(outboxBodies()).toContain(t('voice_note_not_supported', 'en'));
      expect(mockDownloadTwilioMediaBounded).not.toHaveBeenCalled();
      expect(mockUploadMediaToS3).not.toHaveBeenCalled();
      const draftWrite = stateContextUpdates().find((sc) => sc.post_draft != null);
      expect(draftWrite).toBeUndefined();
    });
  });
});

// ── v2 routing branch (Task 6, fail-closed processor integration) ──────────
//
// Top-level (not nested under `describe('Processor Lambda', ...)`) and
// entirely self-contained: its own beforeEach sets every env var and mock
// this suite needs, independent of any other describe block's setup.
describe('v2 routing branch', () => {
  const originalEnv = process.env;
  const PHONE = '+15125551234';
  const FROM = `whatsapp:${PHONE}`;

  function makeFifoSqsRecord(
    params: Record<string, string>,
    groupId: string,
    dedupeId: string,
  ): any {
    return {
      messageId: 'sqs-fifo-1',
      receiptHandle: '',
      body: new URLSearchParams(params).toString(),
      attributes: { MessageGroupId: groupId } as any,
      messageAttributes: {} as any,
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: '',
      awsRegion: 'us-east-2',
      messageDeduplicationId: dedupeId,
    };
  }

  function makeFifoSqsEvent(
    params: Record<string, string>,
    groupId: string,
    dedupeId: string,
  ): any {
    return { Records: [makeFifoSqsRecord(params, groupId, dedupeId)] };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockConnect.mockReset();
    mockRelease.mockReset();
    mockListMatchedJobsForWorker.mockReset();
    mockLoadWorkerPreferredCities.mockReset();
    mockLoadWorkerPreferredCities.mockResolvedValue([]);
    process.env = {
      ...originalEnv,
      WORKER_POOL_ID: 'pool-abc',
      WORKER_CLIENT_ID: 'client-abc',
      TWILIO_SECRET_ARN: 'arn:twilio',
      TWILIO_STATUS_CALLBACK_URL: 'https://callbacks.example.test/prod/whatsapp/status-callback',
      DB_SECRET_ARN: 'arn:db',
      REQUIRED_TOS_VERSION: '1.0',
    };

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

    mockLoadRuntimeControls.mockResolvedValue({ disabled: true });
    mockHashNormalizedPhone.mockImplementation((phone: string) => `hash:${phone}`);
    mockRouteOnboardingV2.mockReset();
    mockCreateOnboardingV2Adapters.mockReset();
    mockCreateOnboardingV2Adapters.mockReturnValue({});
    mockEnqueueWorkerMessage.mockReset();
    mockPublishOutboxWakes.mockReset();
    mockPublishOutboxWakes.mockResolvedValue({ sent: 0, failed: 0 });
    mockRegisterCategoryRenderer.mockClear();
    _clearCategoryRenderersForTests();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('calls routeOnboardingV2 exactly once when controls report the phone enabled', async () => {
    mockRouteOnboardingV2.mockResolvedValue({
      handled: true,
      workerId: null,
      stepKey: 'start.choose_language',
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-on' }] }) // claim
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({ conversation_state: 'new', language: 'es' })],
      }) // SELECT conv FOR UPDATE (existing)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback (state_context)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox: none pending
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeSqsEvent({ MessageSid: 'SM-v2-on', From: FROM, Body: 'hola' }),
      {} as any,
      {} as any,
    );

    expect(mockRouteOnboardingV2).toHaveBeenCalledTimes(1);
    const deps = mockRouteOnboardingV2.mock.calls[0][3] as { tosUrl: string; privacyUrl: string };
    expect(deps.tosUrl).toBe('https://jaleapp.ai/legal/terms');
    expect(deps.privacyUrl).toBe('https://jaleapp.ai/legal/privacy');
    expect(JSON.stringify(deps)).not.toContain('jale.app');
  });

  it('registers onboarding/security renderers before routing, resolving real functions (not renderer_unavailable)', async () => {
    mockRouteOnboardingV2.mockResolvedValue({
      handled: true,
      workerId: null,
      stepKey: 'start.choose_language',
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-reg' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'new' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeSqsEvent({ MessageSid: 'SM-v2-reg', From: FROM, Body: 'hola' }),
      {} as any,
      {} as any,
    );

    const registeredCategories = mockRegisterCategoryRenderer.mock.calls.map(([cat]) => cat);
    expect(registeredCategories).toEqual(expect.arrayContaining(['onboarding', 'security']));
    for (const [, renderer] of mockRegisterCategoryRenderer.mock.calls) {
      expect(typeof renderer).toBe('function');
    }
    // Registration happened strictly before the router ran.
    const lastRegisterOrder = Math.max(
      ...mockRegisterCategoryRenderer.mock.invocationCallOrder,
    );
    const routeOrder = mockRouteOnboardingV2.mock.invocationCallOrder[0];
    expect(lastRegisterOrder).toBeLessThan(routeOrder);
  });

  it('passes hashNormalizedPhone output to isVoiceIntakeEnabled and never the raw phone', async () => {
    mockRouteOnboardingV2.mockResolvedValue({ handled: false, workerId: null });
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-hash' }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({ conversation_state: 'idle', language: 'es' })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 forced-idle writeback
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // help-prompt outbox insert
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeSqsEvent({ MessageSid: 'SM-v2-hash', From: FROM, Body: 'ayuda' }),
      {} as any,
      {} as any,
    );

    expect(mockHashNormalizedPhone).toHaveBeenCalledWith(PHONE);
    const hashResult = mockHashNormalizedPhone.mock.results[0].value;
    expect(mockIsVoiceIntakeEnabled).toHaveBeenCalledWith(expect.anything(), hashResult);
    for (const call of mockIsVoiceIntakeEnabled.mock.calls) {
      expect(call).not.toContain(PHONE);
      expect(call).not.toContain(FROM);
    }
  });

  it('opens exactly one BEGIN and one COMMIT for a v2-routed message', async () => {
    mockRouteOnboardingV2.mockResolvedValue({
      handled: true,
      workerId: null,
      stepKey: 'start.choose_language',
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-tx' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'new' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeSqsEvent({ MessageSid: 'SM-v2-tx', From: FROM, Body: 'hola' }),
      {} as any,
      {} as any,
    );

    expect(countQueryByPattern(/^\s*BEGIN\s*$/i)).toBe(1);
    expect(countQueryByPattern(/^\s*COMMIT\s*$/i)).toBe(1);
  });

  it('publishes a worker-intent wake only after a newly materialized v2 outbox row commits', async () => {
    mockEnqueueWorkerMessage.mockResolvedValue({
      intentId: 'intent-1',
      decision: { action: 'allow', reason: 'worker_onboarding' },
      outboxMaterialized: true,
    });
    mockRouteOnboardingV2.mockImplementation(async (client: unknown, _session: unknown, _msg: unknown, deps: any) => {
      await deps.enqueueWorkerMessage(client, { category: 'onboarding' });
      return { handled: true, workerId: null, stepKey: 'profile.name' };
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-worker-wake' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'new', user_id: 'worker-1' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await handler(
      makeSqsEvent({ MessageSid: 'SM-v2-worker-wake', From: FROM, Body: 'Accept' }),
      {} as any,
      {} as any,
    );

    expect(mockPublishOutboxWakes).toHaveBeenCalledWith({ workerIntent: true, domain: false });
    const commitIndex = mockQuery.mock.calls.findIndex(([sql]) => /^COMMIT$/.test(sql as string));
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(mockQuery.mock.invocationCallOrder[commitIndex])
      .toBeLessThan(mockPublishOutboxWakes.mock.invocationCallOrder[0]);
  });

  it('publishes a domain wake only after v2 onboarding completion commits', async () => {
    mockRouteOnboardingV2.mockImplementation(async (client: unknown, _session: unknown, _msg: unknown, deps: any) => {
      await deps.repo.completeOnboarding(client, 'worker-1');
      return { handled: true, workerId: null, stepKey: 'complete' };
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-domain-wake' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'new', user_id: 'worker-1' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await handler(
      makeSqsEvent({ MessageSid: 'SM-v2-domain-wake', From: FROM, Body: 'Continue' }),
      {} as any,
      {} as any,
    );

    expect(mockPublishOutboxWakes).toHaveBeenCalledWith({ workerIntent: false, domain: true });
    const commitIndex = mockQuery.mock.calls.findIndex(([sql]) => /^COMMIT$/.test(sql as string));
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(mockQuery.mock.invocationCallOrder[commitIndex])
      .toBeLessThan(mockPublishOutboxWakes.mock.invocationCallOrder[0]);
  });

  it('does not publish a wake when the transaction rolls back after materializing work', async () => {
    mockEnqueueWorkerMessage.mockResolvedValue({
      intentId: 'intent-2',
      decision: { action: 'allow', reason: 'worker_onboarding' },
      outboxMaterialized: true,
    });
    mockRouteOnboardingV2.mockImplementation(async (client: unknown, _session: unknown, _msg: unknown, deps: any) => {
      await deps.enqueueWorkerMessage(client, { category: 'onboarding' });
      throw new Error('transition failed');
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-worker-rollback' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'new', user_id: 'worker-1' })] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // ROLLBACK
      // Error fallback (2026-07-26): runs on its own tx after the rollback.
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN (fallback)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // cooldown SELECT
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-worker-rollback#err' }] }) // #err claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ language: 'es' }] }) // conv language
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // outbox INSERT (apology)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT (fallback)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // sendPendingOutbox(#err): none pending

    await expect(handler(
      makeSqsEvent({ MessageSid: 'SM-v2-worker-rollback', From: FROM, Body: 'Accept' }),
      {} as any,
      {} as any,
    )).rejects.toThrow('transition failed');

    expect(countQueryByPattern(/^ROLLBACK$/)).toBe(1);
    expect(mockPublishOutboxWakes).not.toHaveBeenCalled();
  });
  it('runs no legacy state-transition SQL for a v2-routed phone', async () => {
    mockRouteOnboardingV2.mockResolvedValue({
      handled: true,
      workerId: null,
      stepKey: 'legal.review',
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-nolegacy' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'new' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback (state_context only)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeSqsEvent({ MessageSid: 'SM-v2-nolegacy', From: FROM, Body: 'hola' }),
      {} as any,
      {} as any,
    );

    expect(countQueryByPattern(/INSERT INTO whatsapp_outbox/i)).toBe(0);
    expect(countQueryByPattern(/UPDATE users SET/i)).toBe(0);
    expect(findQueryByPattern(/UPDATE whatsapp_conversations SET conversation_state/i)).toBeUndefined();
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it('durably hands a ready (not-handled) v2 result to shared idle routing', async () => {
    mockRouteOnboardingV2.mockImplementation(async (_client, session: any) => {
      session.language = 'en';
      session.state_context = { ...session.state_context, v2Ready: true };
      return {
        handled: false,
        handoff: 'ready',
        workerId: 'worker-ready-1',
        stepKey: 'ready',
      };
    });
    mockListMatchedJobsForWorker.mockResolvedValue([
      { id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr' },
      { id: 'job-2', title: 'Plumber', company: 'XYZ', location: 'El Paso', pay: '$22/hr' },
    ]);

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-ready-jobs' }] }) // claim
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({ conversation_state: 'new', user_id: 'worker-ready-1', language: 'es' })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // v2 state_context writeback
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // recent_jobs writeback
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // job 1 outbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // job 2 outbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeSqsEvent({ MessageSid: 'SM-v2-ready-jobs', From: FROM, Body: 'Trabajos' }),
      {} as any,
      {} as any,
    );

    expect(mockListMatchedJobsForWorker).toHaveBeenCalledWith(expect.any(Object), 'worker-ready-1', {
      limit: 5,
      channel: 'whatsapp',
    });
    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(findQueryByPattern(/SET conversation_state = 'awaiting_otp'/i)).toBeUndefined();

    const conversationWrites = mockQuery.mock.calls.filter(([sql]) =>
      /UPDATE whatsapp_conversations SET/i.test(sql as string));
    const readyWrite = conversationWrites.find(([sql]) =>
      /user_id\s*=/.test(sql as string)
      && /conversation_state\s*=/.test(sql as string)
      && /language\s*=/.test(sql as string)
      && /state_context\s*=/.test(sql as string));
    expect(readyWrite).toBeDefined();
    expect(readyWrite![1]).toEqual([
      'conv-1',
      JSON.stringify({ v2Ready: true }),
      'worker-ready-1',
      'en',
      'idle',
    ]);
    const jobsContextWrite = conversationWrites.find(([sql]) =>
      /last_processed_message_sid\s*=/.test(sql as string));
    expect(JSON.parse(jobsContextWrite![1][1] as string)).toEqual({
      v2Ready: true,
      recent_jobs: ['job-1', 'job-2'],
    });
  });

  it('skips the legacy idle-language-detection write for a v2-routed idle phone', async () => {
    // Guards placement: the v2 branch must sit above routeMessage's
    // idle-language-detection block (its own legacy UPDATE), not just above
    // the state-machine switch. conv.language is 'es' and the body is an
    // English greeting, which WOULD trigger a legacy `language` UPDATE if
    // this message ever reached that block.
    mockRouteOnboardingV2.mockResolvedValue({
      handled: true,
      workerId: null,
      stepKey: 'start.choose_language',
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-idle-lang' }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({ conversation_state: 'idle', language: 'es' })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback (state_context only)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeSqsEvent({ MessageSid: 'SM-v2-idle-lang', From: FROM, Body: 'hello' }),
      {} as any,
      {} as any,
    );

    expect(mockRouteOnboardingV2).toHaveBeenCalledTimes(1);
    expect(findQueryByPattern(/UPDATE whatsapp_conversations SET language/i)).toBeUndefined();
  });

  it('propagates a v2-path error out of the handler, rolls back, and never falls through to legacy', async () => {
    mockRouteOnboardingV2.mockRejectedValue(new Error('v2 dependency missing'));

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-err' }] }) // claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'new' })] }) // SELECT conv
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // ROLLBACK
      // Error fallback (2026-07-26): its own tx, after the rollback. The
      // apology is suppressed here (cooldown row present) to keep this
      // test's focus on error propagation, not fallback delivery.
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN (fallback)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] }) // cooldown: recent #err exists
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-err#err' }] }) // #err claim
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT (fallback)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // sendPendingOutbox(#err): none

    await expect(
      handler(
        makeSqsEvent({ MessageSid: 'SM-v2-err', From: FROM, Body: 'hola' }),
        {} as any,
        {} as any,
      ),
    ).rejects.toThrow('v2 dependency missing');

    expect(countQueryByPattern(/^\s*ROLLBACK\s*$/i)).toBe(1);
    // The MAIN transaction never commits — the fallback's own COMMIT is the
    // only one, and the db_committed flip (the main tx's last write) never
    // happens.
    expect(countQueryByPattern(/^\s*COMMIT\s*$/i)).toBe(1);
    expect(countQueryByPattern(/SET status = 'db_committed'/i)).toBe(0);
    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('routes to v2 with every WHATSAPP_* env var unset, when the control is enabled', async () => {
    const withoutWhatsappEnv = { ...process.env };
    for (const key of Object.keys(withoutWhatsappEnv)) {
      if (key.startsWith('WHATSAPP_')) delete withoutWhatsappEnv[key];
    }
    process.env = withoutWhatsappEnv;

    mockRouteOnboardingV2.mockResolvedValue({
      handled: true,
      workerId: null,
      stepKey: 'start.choose_language',
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-noenv' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'new' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeSqsEvent({ MessageSid: 'SM-v2-noenv', From: FROM, Body: 'hola' }),
      {} as any,
      {} as any,
    );

    expect(mockRouteOnboardingV2).toHaveBeenCalledTimes(1);
  });

  it('routes a FIFO-shaped SQS record through the v2 branch exactly once', async () => {
    mockRouteOnboardingV2.mockResolvedValue({
      handled: true,
      workerId: null,
      stepKey: 'start.choose_language',
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-fifo' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'new' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeFifoSqsEvent(
        { MessageSid: 'SM-v2-fifo', From: FROM, Body: 'hola' },
        'group-1',
        'dedupe-1',
      ),
      {} as any,
      {} as any,
    );

    expect(mockRouteOnboardingV2).toHaveBeenCalledTimes(1);
  });

  it('persists a v2 router state_context mutation back via updateConversation', async () => {
    mockRouteOnboardingV2.mockImplementation(async (_client: any, session: any) => {
      session.state_context = {
        ...session.state_context,
        v2TrustQuestions: ['custom question 1'],
      };
      return { handled: true, workerId: null, stepKey: 'trust.question.1' };
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-ctx' }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({ conversation_state: 'idle', state_context: {} })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeSqsEvent({ MessageSid: 'SM-v2-ctx', From: FROM, Body: 'answer' }),
      {} as any,
      {} as any,
    );

    const writebackParams = findQueryByPattern(/UPDATE whatsapp_conversations SET state_context/i);
    expect(writebackParams).toBeDefined();
    const serialized = (writebackParams as unknown[])[1] as string;
    expect(serialized).toContain('v2TrustQuestions');
    expect(serialized).toContain('custom question 1');
  });

  // ── Task 2/6: voice-note media fields + synthetic voice-event plumbing ──

  it('media fields (numMedia/mediaUrl/mediaSid/mediaContentType) survive into the v2 message', async () => {
    mockRouteOnboardingV2.mockResolvedValue({
      handled: true,
      workerId: null,
      stepKey: 'trust.question.1',
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-v2-media' }] }) // claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'onboarding_v2', user_id: 'worker-1' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeSqsEvent({
        MessageSid: 'SM-v2-media',
        From: FROM,
        Body: '',
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.com/media/ME123',
        MediaSid0: 'ME1234567890',
        MediaContentType0: 'audio/ogg',
      }),
      {} as any,
      {} as any,
    );

    expect(mockRouteOnboardingV2).toHaveBeenCalledTimes(1);
    const msg = mockRouteOnboardingV2.mock.calls[0][2] as Record<string, unknown>;
    expect(msg.numMedia).toBe(1);
    expect(msg.mediaUrl).toBe('https://api.twilio.com/media/ME123');
    expect(msg.mediaSid).toBe('ME1234567890');
    expect(msg.mediaContentType).toBe('audio/ogg');
    expect(msg.voiceEvent).toBeUndefined();
  });

  it('a synthetic #vt voice-completion record claims via whatsapp_processed_messages and routes with voiceEvent populated', async () => {
    mockRouteOnboardingV2.mockResolvedValue({
      handled: true,
      workerId: null,
      stepKey: 'trust.question.2',
    });

    const evt: TrustVoiceEventV2 = {
      version: 'v2',
      kind: 'trust_answer',
      status: 'COMPLETED',
      phone: PHONE,
      runId: 'run-1',
      stepKey: 'trust.question.1',
      language: 'en',
      origMessageSid: 'SM00000000000000000000000000000v',
      startedAt: '2026-07-27T00:00:00.000Z',
      questionIndex: 0,
      transcript: 'five years of experience',
      executionArn: 'arn:aws:states:us-east-2:000000000000:execution:fake-trust-voice-pipeline:vt-test',
    };
    const syntheticSid = syntheticVoiceSid(evt.origMessageSid, evt.kind);

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: syntheticSid }] }) // claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'onboarding_v2', user_id: 'worker-1', whatsapp_number: PHONE })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSyntheticVoiceSqsEvent(evt), {} as any, {} as any);

    const claimParams = findQueryByPattern(/INSERT INTO whatsapp_processed_messages/i);
    expect(claimParams).toBeDefined();
    expect((claimParams as unknown[])[0]).toBe(syntheticSid);

    expect(mockRouteOnboardingV2).toHaveBeenCalledTimes(1);
    const msg = mockRouteOnboardingV2.mock.calls[0][2] as Record<string, unknown>;
    expect(msg.voiceEvent).toMatchObject({
      kind: 'trust_answer',
      status: 'COMPLETED',
      transcript: 'five years of experience',
    });
    expect(msg.messageSid).toBe(syntheticSid);
  });

  it('a duplicate synthetic #vt sid no-ops (already claimed, status=completed)', async () => {

    const evt: TrustVoiceEventV2 = {
      version: 'v2',
      kind: 'trust_answer',
      status: 'COMPLETED',
      phone: PHONE,
      runId: 'run-1',
      stepKey: 'trust.question.1',
      language: 'en',
      origMessageSid: 'SM00000000000000000000000000000w',
      startedAt: '2026-07-27T00:00:00.000Z',
      questionIndex: 0,
      transcript: 'answer',
      executionArn: 'arn:aws:states:us-east-2:000000000000:execution:fake-trust-voice-pipeline:vt-test',
    };
    const syntheticSid = syntheticVoiceSid(evt.origMessageSid, evt.kind);

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // claim INSERT: conflicts (already claimed)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'completed' }] }) // SELECT status FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // COMMIT

    await handler(makeSyntheticVoiceSqsEvent(evt), {} as any, {} as any);

    expect(mockRouteOnboardingV2).not.toHaveBeenCalled();
    expect(countQueryByPattern(/FROM whatsapp_conversations/i)).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Error fallback (2026-07-26 incident: silence on step-handler throw) ────
//
// Top-level for the same reason as 'v2 routing branch': these tests own
// their entire mockQuery script including the ROLLBACK and the fallback's
// second transaction.
describe('error fallback', () => {
  const originalEnv = process.env;
  const PHONE = '+15125551234';
  const FROM = `whatsapp:${PHONE}`;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockConnect.mockReset();
    mockRelease.mockReset();
    process.env = {
      ...originalEnv,
      WORKER_POOL_ID: 'pool-abc',
      WORKER_CLIENT_ID: 'client-abc',
      TWILIO_SECRET_ARN: 'arn:twilio',
      TWILIO_STATUS_CALLBACK_URL: 'https://callbacks.example.test/prod/whatsapp/status-callback',
      DB_SECRET_ARN: 'arn:db',
      REQUIRED_TOS_VERSION: '1.0',
    };
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
      json: async () => ({ sid: 'SM22222222222222222222222222222222' }),
    });
    mockLoadRuntimeControls.mockResolvedValue({ disabled: false });
    mockRouteOnboardingV2.mockReset();
    mockCreateOnboardingV2Adapters.mockReset();
    mockCreateOnboardingV2Adapters.mockReturnValue({});
    mockPublishOutboxWakes.mockReset();
    mockPublishOutboxWakes.mockResolvedValue({ sent: 0, failed: 0 });
    _clearCategoryRenderersForTests();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  /** Scripts the main tx up to the router throw: BEGIN, claim, conv. */
  function scriptMainTxUntilThrow(sid: string) {
    mockRouteOnboardingV2.mockRejectedValue(new Error('step boom'));
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: sid }] }) // claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'new', language: 'es' })] }) // conv FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // ROLLBACK
  }

  it('sends ONE apology via a synthetic #err claim and still rethrows for SQS retry/DLQ', async () => {
    const sid = 'SMfallback000000000000000000000001';
    scriptMainTxUntilThrow(sid);
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN (fallback tx)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // cooldown SELECT: none recent
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: `${sid}#err` }] }) // #err claim
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ language: 'es' }] }) // conv language
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // outbox INSERT (apology)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'ob-1', sequence: 1, whatsapp_number: PHONE, body: 'apology', content_template: null, content_variables: null }],
      }) // sendPendingOutbox: one pending
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // outbox UPDATE sent

    // The rethrow is the retry/DLQ pin: fallback must never swallow it.
    await expect(
      handler(makeSqsEvent({ MessageSid: sid, From: FROM, Body: '79928' }), {} as any, {} as any),
    ).rejects.toThrow('step boom');

    // Synthetic claim row: failed status + truncated error, keyed by #err.
    const claimParams = findQueryByPattern(/INSERT INTO whatsapp_processed_messages[\s\S]*last_error/i);
    expect(claimParams).toBeDefined();
    expect((claimParams as unknown[])[0]).toBe(`${sid}#err`);
    expect((claimParams as unknown[])[2]).toContain('step boom');

    // Exactly one apology queued, against the synthetic sid, in Spanish.
    const outboxParams = findQueryByPattern(/INSERT INTO whatsapp_outbox/i);
    expect(outboxParams).toBeDefined();
    expect((outboxParams as unknown[])[0]).toBe(`${sid}#err`);
    expect(String((outboxParams as unknown[])[2])).toContain('algo salio mal');

    // Exactly one Twilio send.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('is idempotent across SQS retries: the second run claims nothing and sends nothing', async () => {
    const sid = 'SMfallback000000000000000000000002';

    // Run 1 — full fallback.
    scriptMainTxUntilThrow(sid);
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN (fallback)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // cooldown: none
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: `${sid}#err` }] }) // #err claim wins
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ language: 'es' }] }) // conv language
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // outbox INSERT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'ob-1', sequence: 1, whatsapp_number: PHONE, body: 'apology', content_template: null, content_variables: null }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // outbox UPDATE sent
    await expect(
      handler(makeSqsEvent({ MessageSid: sid, From: FROM, Body: '79928' }), {} as any, {} as any),
    ).rejects.toThrow('step boom');

    // Run 2 — same record redelivered. The REAL sid re-claims cleanly
    // (rollback discarded run 1's claim), the step throws again, and the
    // fallback's #err insert now CONFLICTS: no new outbox row, and the
    // drain finds nothing pending (already sent).
    scriptMainTxUntilThrow(sid);
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN (fallback)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // cooldown: the #err row is excluded by sid <> $2
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // #err claim: ON CONFLICT DO NOTHING
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // sendPendingOutbox: nothing pending
    await expect(
      handler(makeSqsEvent({ MessageSid: sid, From: FROM, Body: '79928' }), {} as any, {} as any),
    ).rejects.toThrow('step boom');

    // One outbox INSERT and one Twilio call TOTAL across both runs.
    expect(countQueryByPattern(/INSERT INTO whatsapp_outbox/i)).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('suppresses the apology (but still claims #err) inside the 30-minute per-phone cooldown', async () => {
    const sid = 'SMfallback000000000000000000000003';
    scriptMainTxUntilThrow(sid);
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN (fallback)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] }) // cooldown: a recent #err exists
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: `${sid}#err` }] }) // #err claim still recorded
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // sendPendingOutbox: nothing pending
    await expect(
      handler(makeSqsEvent({ MessageSid: sid, From: FROM, Body: '79928' }), {} as any, {} as any),
    ).rejects.toThrow('step boom');

    expect(countQueryByPattern(/INSERT INTO whatsapp_outbox/i)).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    // Forensics row still written.
    expect(findQueryByPattern(/INSERT INTO whatsapp_processed_messages[\s\S]*last_error/i)).toBeDefined();
  });

  it('never masks the original error when the fallback itself fails', async () => {
    const sid = 'SMfallback000000000000000000000004';
    scriptMainTxUntilThrow(sid);
    mockQuery
      .mockRejectedValueOnce(new Error('db is down')) // BEGIN (fallback) explodes
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // fallback's own ROLLBACK
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      handler(makeSqsEvent({ MessageSid: sid, From: FROM, Body: '79928' }), {} as any, {} as any),
    ).rejects.toThrow('step boom'); // the ORIGINAL error, not 'db is down'

    expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('error fallback failed'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('does not fire for a lost claim race (no throw, nothing user-visible attempted)', async () => {
    const sid = 'SMfallback000000000000000000000005';
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // claim: lost the race
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'completed' }] }) // existing status
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // COMMIT

    await handler(makeSqsEvent({ MessageSid: sid, From: FROM, Body: 'hola' }), {} as any, {} as any);

    expect(countQueryByPattern(/#err/)).toBe(0);
    expect(mockRouteOnboardingV2).not.toHaveBeenCalled();
  });
});

// ── Voice-note transcription kickoff (T-transcription-language-id) ────────
//
// startTrustTranscription/ingestProfileVoiceNote are not exported — the only
// way to reach the real production code is to have routeOnboardingV2's mock
// implementation call through `deps.voiceIntake.*` directly, mirroring the
// `deps.repo.completeOnboarding`/`deps.enqueueWorkerMessage` pattern used
// elsewhere in this file. These tests assert the Step Functions execution
// input the pipeline construct now receives no longer carries a
// `languageCode` field (language identification moved into the Transcribe
// job itself — see voice-transcription-pipeline.ts) while every other
// pipeline-required field is still present.
describe('voice-note transcription kickoff (languageCode removed)', () => {
  const originalEnv = process.env;
  const PHONE = '+15125551234';
  const FROM = `whatsapp:${PHONE}`;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockConnect.mockReset();
    mockRelease.mockReset();
    process.env = {
      ...originalEnv,
      WORKER_POOL_ID: 'pool-abc',
      WORKER_CLIENT_ID: 'client-abc',
      TWILIO_SECRET_ARN: 'arn:twilio',
      TWILIO_STATUS_CALLBACK_URL: 'https://callbacks.example.test/prod/whatsapp/status-callback',
      DB_SECRET_ARN: 'arn:db',
      REQUIRED_TOS_VERSION: '1.0',
      MEDIA_BUCKET_NAME: 'jale-worker-media-test',
      TRUST_PIPELINE_STATE_MACHINE_ARN: 'arn:aws:states:us-east-2:000000000000:stateMachine:fake-trust-voice-pipeline',
      AI_PIPELINE_STATE_MACHINE_ARN: 'arn:aws:states:us-east-2:000000000000:stateMachine:fake-profile-voice-pipeline',
    };

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

    mockDetectMediaCategory.mockReturnValue('voice');
    mockDownloadTwilioMedia.mockResolvedValue(Buffer.from('fake-voice-audio'));
    mockUploadMediaToS3.mockResolvedValue(undefined);

    mockLoadRuntimeControls.mockResolvedValue({ disabled: true });
    mockHashNormalizedPhone.mockImplementation((phone: string) => `hash:${phone}`);
    mockRouteOnboardingV2.mockReset();
    mockCreateOnboardingV2Adapters.mockReset();
    mockCreateOnboardingV2Adapters.mockReturnValue({});
    mockEnqueueWorkerMessage.mockReset();
    mockPublishOutboxWakes.mockReset();
    mockPublishOutboxWakes.mockResolvedValue({ sent: 0, failed: 0 });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('trust-answer voice note: StartExecutionCommand input has no languageCode key', async () => {
    mockRouteOnboardingV2.mockImplementation(async (_client: unknown, _session: unknown, _msg: unknown, deps: any) => {
      await deps.voiceIntake.startTrustTranscription({
        workerId: 'worker-1',
        phone: PHONE,
        runId: 'run-1',
        stepKey: 'trust.question.1',
        questionIndex: 0,
        language: 'es',
        mediaUrl: 'https://api.twilio.com/media/ME00000000000000000000000000000001',
        mediaContentType: 'audio/ogg',
        inboundMessageSid: 'SM-trust-voice-note-1',
      });
      return { handled: true, workerId: null, stepKey: 'trust.question.1' };
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-trust-voice-note-1' }] }) // claim
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({ conversation_state: 'onboarding_v2', user_id: 'worker-1' })],
      }) // conv row — user_id SET to skip the web-worker bypass query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ cognito_sub: 'sub-worker-1' }] }) // setWorkerRlsContextByUserId: cognito_sub lookup
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT worker_profile_media
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback (state_context)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // flip claim to db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox: nothing pending
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeSqsEvent({ MessageSid: 'SM-trust-voice-note-1', From: FROM, Body: '' }),
      {} as any,
      {} as any,
    );

    expect(mockSfnSend).toHaveBeenCalledTimes(1);
    const sentInput = JSON.parse((mockSfnSend.mock.calls[0][0] as any).input.input);
    expect(sentInput).not.toHaveProperty('languageCode');
    expect(sentInput.transcriptionJobName).toEqual(expect.stringContaining('jale-vt-'));
    expect(sentInput.mediaS3Uri).toEqual(expect.stringContaining('s3://jale-worker-media-test/'));
    expect(sentInput.mediaBucketName).toBe('jale-worker-media-test');
    expect(sentInput.transcriptOutputKey).toEqual(expect.stringContaining('/transcripts/'));
    expect(sentInput.v2.language).toBe('es');
  });

  it('profile voice intake: StartExecutionCommand input has no languageCode key', async () => {
    mockRouteOnboardingV2.mockImplementation(async (_client: unknown, _session: unknown, _msg: unknown, deps: any) => {
      await deps.voiceIntake.ingestProfileVoiceNote({
        workerId: 'worker-2',
        phone: PHONE,
        runId: 'run-2',
        stepKey: 'profile.voice_processing',
        language: 'en',
        mediaUrl: 'https://api.twilio.com/media/ME00000000000000000000000000000002',
        mediaContentType: 'audio/ogg',
        inboundMessageSid: 'SM-profile-voice-note-1',
      });
      return { handled: true, workerId: null, stepKey: 'profile.voice_processing' };
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-profile-voice-note-1' }] }) // claim
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({ conversation_state: 'onboarding_v2', user_id: 'worker-2', language: 'en' })],
      }) // conv row — user_id SET to skip the web-worker bypass query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ cognito_sub: 'sub-worker-2' }] }) // setWorkerRlsContextByUserId: cognito_sub lookup
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT worker_profile_media
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // updateConversation writeback (state_context)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // flip claim to db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sendPendingOutbox: nothing pending
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(
      makeSqsEvent({ MessageSid: 'SM-profile-voice-note-1', From: FROM, Body: '' }),
      {} as any,
      {} as any,
    );

    expect(mockSfnSend).toHaveBeenCalledTimes(1);
    const sentInput = JSON.parse((mockSfnSend.mock.calls[0][0] as any).input.input);
    expect(sentInput).not.toHaveProperty('languageCode');
    expect(sentInput.transcriptionJobName).toEqual(expect.stringContaining('jale-vp-'));
    expect(sentInput.mediaS3Uri).toEqual(expect.stringContaining('s3://jale-worker-media-test/'));
    expect(sentInput.mediaBucketName).toBe('jale-worker-media-test');
    expect(sentInput.transcriptOutputKey).toEqual(expect.stringContaining('/transcripts/'));
    expect(sentInput.language).toBe('en');
  });
});
