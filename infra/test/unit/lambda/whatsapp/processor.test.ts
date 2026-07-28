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
            trust_signals_completed_at: '2026-04-29T00:00:00.000Z',
            trust_signals: {
              specialization: { label: 'Commercial' },
              seniority: { label: 'Lead crew' },
              tasks: { label: 'Work panels' },
            },
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
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // findWebRegisteredWorker → no match
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // tryConversationRelay → resolveWorkerIdForWhatsappNumber → no match
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox start_prompt (not-a-greeting fallback)
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
            trust_signals_completed_at: '2026-04-29T00:00:00.000Z',
            trust_signals: {
              specialization: { label: 'Commercial' },
              seniority: { label: 'Lead crew' },
              tasks: { label: 'Work panels' },
            },
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
      expect(body).toContain('Specialty: Commercial');
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
            trust_signals_completed_at: null,
            trust_signals: null,
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
            trust_signals_completed_at: null,
            trust_signals: null,
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
      expect(countQueryByPattern(/FROM users/i)).toBe(0);
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
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'job-1', required_docs: [] }] }) // helper job check
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }) // INSERT job application
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox accepted
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

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
      expect(applicationInsert).toEqual(['job-1', 'user-1']);
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

    it('typed accept with missing required docs sends document-required reply without applying', async () => {
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
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // set internal RLS context
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'job-1', required_docs: ['resume'] }] }) // helper job check
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // missing required docs
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox missing docs
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-missing-docs',
          From: 'whatsapp:+15125551234',
          Body: '1 accept',
        }),
        {} as any,
        {} as any,
      );

      expect(findQueryByPattern(/INSERT INTO job_applications/i)).toBeUndefined();
      expect(outboxBodies()[0]).toContain('Resume');
      expect(outboxBodies()[0]).toContain('requires these documents');
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
        rows: [convRow({ conversation_state: 'building_custom_trust', state_context: {} })],
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
