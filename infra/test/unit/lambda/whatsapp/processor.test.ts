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
  SignUpCommand: jest.fn((args) => ({ input: args, __type: 'SignUp' })),
  AdminConfirmSignUpCommand: jest.fn((args) => ({ input: args, __type: 'AdminConfirmSignUp' })),
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
}));

const mockListMatchedJobsForWorker = jest.fn();
jest.mock('../../../../lambda/lib/job-matching', () => ({
  listMatchedJobsForWorker: mockListMatchedJobsForWorker,
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { handler } from '../../../../lambda/whatsapp/processor';

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
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'OK' });
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

      // No routeMessage side effects (no conversation lookup)
      expect(countQueryByPattern(/FROM whatsapp_conversations/i)).toBe(0);
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

    it('first-mover path: claim succeeds, routeMessage runs, status → db_committed → completed', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        // claim INSERT: succeeds (returns row)
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-new' }] })
        // SELECT conversation FOR UPDATE — returns empty (new conversation)
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        // INSERT whatsapp_conversations
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'new' })],
        });
      // handleNewOrRestart begins here; we route via the 'new' → greeting path.
      // SignUp + AdminConfirmSignUp succeed (empty responses).
      mockCognitoSend
        .mockResolvedValueOnce({}) // SignUp
        .mockResolvedValueOnce({}) // AdminConfirmSignUp
        .mockResolvedValueOnce({
          Session: 'INIT-SESSION',
          ChallengeName: 'CUSTOM_CHALLENGE',
        }); // InitiateAuth
      mockQuery
        // Defensive INSERT users
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        // UPDATE whatsapp_conversations (state transition + session persist)
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        // queueReply → INSERT whatsapp_outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        // UPDATE whatsapp_processed_messages status='db_committed'
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        // sendPendingOutbox: SELECT pending rows
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'o-1', sequence: 1, whatsapp_number: '+15125551234', body: 'welcome' }],
        })
        // UPDATE outbox status='sent'
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        // markCompleted
        .mockResolvedValueOnce({ rowCount: 1, rows: [] });

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-new',
          From: 'whatsapp:+15125551234',
          Body: 'Hola',
        }),
        {} as any,
        {} as any,
      );

      // Claim INSERT hit the processed_messages table with the right SID
      const claim = findQueryByPattern(
        /INSERT INTO whatsapp_processed_messages/i,
      );
      expect(claim).toContain('SM-new');

      // Exactly one Twilio call (the welcome message) across the whole flow.
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Regression: the outbox insert must cast the reused SID parameter.
      // Without this, Postgres can infer $1 as both text and varchar and
      // crash with 42P08 before the conversation state commits.
      const outboxInsert = mockQuery.mock.calls.find(([sql]) =>
        /INSERT INTO whatsapp_outbox/i.test(sql as string),
      )?.[0] as string | undefined;
      expect(outboxInsert).toContain('$1::varchar');

      // Final state: status='completed'
      const completed = findQueryByPattern(
        /UPDATE whatsapp_processed_messages\s+SET status = 'completed'/i,
      );
      expect(completed).toBeDefined();
    });

    it('does not start onboarding for a new conversation unless the worker sends hola or hello', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-new-jobs' }] }) // claim
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT conversation FOR UPDATE
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'new' })],
        }) // INSERT whatsapp_conversations
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox start_prompt
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{
            id: 'o-1',
            sequence: 1,
            whatsapp_number: '+15125551234',
            body: 'Envia "Hola" o "Hello" para empezar.',
          }],
        }) // sendPendingOutbox: SELECT pending rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE outbox sent
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-new-jobs',
          From: 'whatsapp:+15125551234',
          Body: 'Trabajos',
        }),
        {} as any,
        {} as any,
      );

      expect(mockCognitoSend).not.toHaveBeenCalled();
      expect(outboxBodies()[0]).toBe('Envia "Hola" o "Hello" para empezar.');
      expect(countQueryByPattern(/INSERT INTO users/i)).toBe(0);
      expect(countQueryByPattern(/FROM jobs/i)).toBe(0);
    });
  });

  // ── outbox — Twilio failure leaves claim db_committed ───────────────────

  describe('outbox resilience to Twilio failure', () => {
    it('Twilio 500 on outbox send: row marked failed, markCompleted NOT called', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-twilio-fail' }] }) // claim
        .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'idle' })] }) // SELECT conv FOR UPDATE
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
        /UPDATE whatsapp_outbox\s+SET status = 'failed'/i,
      );
      expect(failedUpd).toBeDefined();
      // markCompleted was NOT called (no UPDATE status='completed' in mockQuery calls)
      expect(
        countQueryByPattern(/UPDATE whatsapp_processed_messages\s+SET status = 'completed'/i),
      ).toBe(0);
    });
  });

  // ── ABORT on placeholder with dependent rows ─────────────────────────────

  describe('reconcileUserRow ABORT on dependents', () => {
    const realSub = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

    it('throws when placeholder has dependent legal_consent_log rows', async () => {
      // Build IdToken that decodes to realSub
      const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: realSub })).toString('base64url');
      const idToken = `${header}.${payload}.sig`;

      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN (outer)
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-otp-ok' }] }) // claim
        // SELECT conv FOR UPDATE — awaiting_otp with session
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'awaiting_otp',
            otp_attempts: 0,
            otp_expires_at: new Date(Date.now() + 5 * 60 * 1000),
            state_context: { cognito_session: 'SESSION-OK' },
          })],
        });
      // RespondToAuthChallenge succeeds
      mockCognitoSend.mockResolvedValueOnce({
        AuthenticationResult: { IdToken: idToken },
      });
      // reconcileUserRow: realSub row already exists (Case B)
      mockQuery
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'u-real', tos_version: null }],
        })
        // UPDATE users (link whatsapp to real-sub row)
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        // has_deps check → TRUE (placeholder has dependent rows)
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'u-placeholder' }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ has_deps: true }],
        });

      await expect(
        handler(
          makeSqsEvent({
            MessageSid: 'SM-otp-ok',
            From: 'whatsapp:+15125551234',
            Body: '123456',
          }),
          {} as any,
          {} as any,
        ),
      ).rejects.toThrow(/aborting reconcile.*manual ops merge required/);

      // DELETE FROM users was NEVER issued
      expect(countQueryByPattern(/DELETE FROM users/i)).toBe(0);
    });

    it('proceeds with DELETE when placeholder has no dependents', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: realSub })).toString('base64url');
      const idToken = `${header}.${payload}.sig`;

      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN (outer)
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-otp-ok' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'awaiting_otp',
            otp_attempts: 0,
            otp_expires_at: new Date(Date.now() + 5 * 60 * 1000),
            state_context: { cognito_session: 'SESSION-OK' },
          })],
        });
      mockCognitoSend.mockResolvedValueOnce({
        AuthenticationResult: { IdToken: idToken },
      });
      mockQuery
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'u-real', tos_version: '1.0' }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE users (link)
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'u-placeholder' }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ has_deps: false }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ has_deps: false }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // DELETE
        // Rest of the OTP-success path: updateConversation, enterProfileBuilderOrIdle, etc.
        // Stub them out with generous mocks to let the handler run to completion.
        .mockResolvedValue({ rowCount: 1, rows: [] });

      try {
        await handler(
          makeSqsEvent({
            MessageSid: 'SM-otp-ok',
            From: 'whatsapp:+15125551234',
            Body: '123456',
          }),
          {} as any,
          {} as any,
        );
      } catch {
        // The handler may still throw at a later stub boundary — we only
        // care here that the ABORT check passed and DELETE ran.
      }

      // DELETE FROM users WAS issued
      expect(countQueryByPattern(/DELETE FROM users/i)).toBeGreaterThan(0);
    });
  });

  describe('Trust signals and typed jobs', () => {
    it('accepts legal terms from a rich quick-reply payload', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-legal-button' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'awaiting_legal',
            user_id: 'user-1',
            language: 'en',
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ cognito_sub: 'worker-sub' }] }) // SELECT user
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE users consent
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT tos log
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT privacy log
        .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // SELECT profile fields
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation awaiting_media_voice
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT legal_accepted
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT ask_media_voice
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(makeSqsEvent({
        MessageSid: 'SM-legal-button',
        From: 'whatsapp:+15125551234',
        Body: '',
        ButtonPayload: 'legal:accept',
      }), {} as any, {} as any);

      expect(findQueryByPattern(/UPDATE users\s+SET tos_version/i)).toBeDefined();
      const convUpdate = mockQuery.mock.calls.find(([sql, params]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string)
        && Array.isArray(params)
        && (params as unknown[]).includes('awaiting_media_voice')
      );
      expect(convUpdate).toBeDefined();
      const mediaPrompt = mockQuery.mock.calls.find(([sql, params]) =>
        /INSERT INTO whatsapp_outbox/i.test(sql as string)
        && /content_template/i.test(sql as string)
        && Array.isArray(params)
        && (params as unknown[]).includes('onboarding_voice_choice_en')
      );
      expect(mediaPrompt).toBeDefined();
    });

    it('re-prompts legal terms as a rich quick-reply prompt', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-legal-reprompt' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'awaiting_legal',
            user_id: 'user-1',
            language: 'en',
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT legal prompt
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(makeSqsEvent({
        MessageSid: 'SM-legal-reprompt',
        From: 'whatsapp:+15125551234',
        Body: 'maybe',
      }), {} as any, {} as any);

      const legalPrompt = mockQuery.mock.calls.find(([sql, params]) =>
        /INSERT INTO whatsapp_outbox/i.test(sql as string)
        && /content_template/i.test(sql as string)
        && Array.isArray(params)
        && (params as unknown[]).includes('onboarding_legal_en')
      );
      expect(legalPrompt).toBeDefined();
    });

    it('accepts profile answers from matching rich payloads', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-profile-button' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'building_profile',
            user_id: 'user-1',
            language: 'en',
            state_context: {
              pending_field: 'has_transportation',
              collected: {
                full_name: 'Luis Worker',
                city: 'Denver',
                main_trade: 'electrician',
                years_experience: '2-4',
              },
              field_sids: {},
            },
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // SELECT profile fields
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation next field
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT ask_availability
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(makeSqsEvent({
        MessageSid: 'SM-profile-button',
        From: 'whatsapp:+15125551234',
        Body: '',
        ButtonPayload: 'profile:has_transportation:true',
      }), {} as any, {} as any);

      const convUpdate = mockQuery.mock.calls.find(([sql, params]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string)
        && Array.isArray(params)
        && (params as unknown[]).some((value) =>
          typeof value === 'string' && value.includes('"has_transportation":true')
        )
      );
      expect(convUpdate).toBeDefined();
      const stateJson = (convUpdate![1] as unknown[]).find((value) =>
        typeof value === 'string' && value.includes('pending_field')
      );
      expect(JSON.parse(String(stateJson))).toMatchObject({
        pending_field: 'availability',
        collected: { has_transportation: true },
      });
      const templateInsert = mockQuery.mock.calls.find(([sql, params]) =>
        /INSERT INTO whatsapp_outbox/i.test(sql as string)
        && /content_template/i.test(sql as string)
        && Array.isArray(params)
        && (params as unknown[]).includes('onboarding_availability_en')
      );
      expect(templateInsert).toBeDefined();
    });

    it('re-prompts trust questions as rich quick-reply prompts', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-trust-invalid' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'building_trust_signal',
            user_id: 'user-1',
            language: 'en',
            state_context: { trust_step: 0, trust_answers: [] },
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] }) // users.trust_signals exists
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] }) // users.trust_signals_completed_at exists
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ main_trade: 'electrician' }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT trust prompt
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(makeSqsEvent({
        MessageSid: 'SM-trust-invalid',
        From: 'whatsapp:+15125551234',
        Body: 'bad',
      }), {} as any, {} as any);

      const trustPrompt = mockQuery.mock.calls.find(([sql, params]) =>
        /INSERT INTO whatsapp_outbox/i.test(sql as string)
        && /content_template/i.test(sql as string)
        && Array.isArray(params)
        && (params as unknown[]).includes('trust_choice_en')
      );
      expect(trustPrompt).toBeDefined();
    });

    it('writes final trust signals and moves the conversation to idle', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-trust-3' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'building_trust_signal',
            user_id: 'user-1',
            state_context: {
              trust_step: 2,
              trust_answers: [
                {
                  questionKey: 'specialization',
                  optionKey: 'opt_0',
                  label: 'Residential',
                  answeredAt: '2026-04-24T00:00:00.000Z',
                },
                {
                  questionKey: 'seniority',
                  optionKey: 'opt_1',
                  label: 'Can work alone',
                  answeredAt: '2026-04-24T00:01:00.000Z',
                },
              ],
            },
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] }) // users.trust_signals exists
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] }) // users.trust_signals_completed_at exists
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ main_trade: 'electrician' }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE users trust_signals
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT seeded trade questions
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation awaiting_media_photo
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox profile_complete
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox photo prompt
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-trust-3',
          From: 'whatsapp:+15125551234',
          Body: '2',
        }),
        {} as any,
        {} as any,
      );

      const trustUpdate = findQueryByPattern(/UPDATE users\s+SET trust_signals/i);
      expect(trustUpdate).toBeDefined();
      const signals = JSON.parse(trustUpdate![0] as string);
      expect(signals).toHaveProperty('specialization');
      expect(signals).toHaveProperty('seniority');
      expect(signals).toHaveProperty('tasks');
      const trustSql = mockQuery.mock.calls.find(([sql]) =>
        /UPDATE users\s+SET trust_signals/i.test(sql as string),
      )?.[0] as string;
      expect(trustSql).not.toMatch(/updated_at/i);

      const photoUpdate = mockQuery.mock.calls.find(([sql, params]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string)
        && Array.isArray(params)
        && params.includes('awaiting_media_photo'),
      );
      expect(photoUpdate).toBeDefined();
    });

    it('skips trust questions if migration 006 columns are missing', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-trust-missing' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({
            conversation_state: 'building_trust_signal',
            user_id: 'user-1',
            state_context: { trust_step: 0, trust_answers: [] },
          })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: false }] }) // users.trust_signals missing
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation awaiting_media_photo
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox profile_complete
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox photo prompt
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // processed db_committed
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no pending outbox rows
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

      await handler(
        makeSqsEvent({
          MessageSid: 'SM-trust-missing',
          From: 'whatsapp:+15125551234',
          Body: '1',
        }),
        {} as any,
        {} as any,
      );

      expect(findQueryByPattern(/UPDATE users\s+SET trust_signals/i)).toBeUndefined();
      const photoUpdate = mockQuery.mock.calls.find(([sql, params]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string)
        && Array.isArray(params)
        && params.includes('awaiting_media_photo'),
      );
      expect(photoUpdate).toBeDefined();
    });

    it('returns the command menu when a worker sends help', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-help' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'en', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox help_menu
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

      expect(outboxBodies()[0]).toContain('Commands');
      expect(outboxBodies()[0]).toContain('Jobs - See opportunities');
      expect(countQueryByPattern(/FROM jobs/i)).toBe(0);
    });

    it('returns profile details for a linked worker profile command', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-profile' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', language: 'en', user_id: 'user-1' })],
        })
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
      expect(countQueryByPattern(/UPDATE whatsapp_conversations SET/i)).toBe(0);
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
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr' }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT job application
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
  });
});

describe('awaiting_media_photo state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWILIO_SECRET_ARN = 'arn:twilio';
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test',
        authToken: 'tok_test',
        messagingServiceSid: 'MGtest_svc',
        templates: {},
      }),
    });
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'OK' });
  });

  test('text message (skip) transitions to awaiting_media_voice', async () => {
    const { detectMediaCategory } = require('../../../../lambda/whatsapp/lib/media');
    detectMediaCategory.mockReturnValue(null);

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM001' }] }) // claim
      .mockResolvedValueOnce({                                                   // SELECT conv FOR UPDATE
        rowCount: 1,
        rows: [convRow({
          conversation_state: 'awaiting_media_photo',
          user_id: 'user-1',
          language: 'en',
        })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE whatsapp_conversations
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox ask_media_voice
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed_messages db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox (empty)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSqsEvent({
      MessageSid: 'SM001',
      From: 'whatsapp:+15125551234',
      Body: 'skip',
      NumMedia: '0',
    }), {} as any, {} as any);

    const convUpdate = mockQuery.mock.calls.find(([sql, params]) =>
      /UPDATE whatsapp_conversations SET/i.test(sql as string)
      && Array.isArray(params)
      && (params as unknown[]).includes('awaiting_media_voice')
    );
    expect(convUpdate).toBeDefined();
    const voicePrompt = mockQuery.mock.calls.find(([sql, params]) =>
      /INSERT INTO whatsapp_outbox/i.test(sql as string)
      && /content_template/i.test(sql as string)
      && Array.isArray(params)
      && (params as unknown[]).includes('onboarding_voice_choice_en')
    );
    expect(voicePrompt).toBeDefined();
  });

  test('valid photo triggers S3 upload and asks classification', async () => {
    const { detectMediaCategory, downloadTwilioMedia, uploadMediaToS3 } =
      require('../../../../lambda/whatsapp/lib/media');
    detectMediaCategory.mockReturnValue('photo');
    downloadTwilioMedia.mockResolvedValue(Buffer.from('fake-image'));
    uploadMediaToS3.mockResolvedValue(undefined);
    process.env.MEDIA_BUCKET_NAME = 'jale-worker-media-test';

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM002' }] }) // claim
      .mockResolvedValueOnce({                                                   // SELECT conv FOR UPDATE
        rowCount: 1,
        rows: [convRow({ conversation_state: 'awaiting_media_photo', user_id: 'user-1' })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ cognito_sub: 'worker-sub' }] }) // SELECT worker for RLS
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT worker_profile_media
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE whatsapp_conversations
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox ask_media_photo_type
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed_messages db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox (empty)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSqsEvent({
      MessageSid: 'SM002',
      From: 'whatsapp:+15125551234',
      Body: '',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/0',
      MediaSid0: 'MMtest-photo',
      MediaContentType0: 'image/jpeg',
    }), {} as any, {} as any);

    expect(uploadMediaToS3).toHaveBeenCalled();
    const mediaInsert = mockQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO worker_profile_media/.test(sql)
    );
    expect(mediaInsert).toBeDefined();
    expect(mediaInsert![1]).toEqual(expect.arrayContaining(['MMtest-photo', 'image/jpeg']));
    expect((mediaInsert![1] as unknown[]).filter((value) => value === 'image/jpeg')).toHaveLength(1);
    const outboxInsert = mockQuery.mock.calls.find(([sql, params]) =>
      /INSERT INTO whatsapp_outbox/.test(sql as string)
      && /content_template/i.test(sql as string)
      && Array.isArray(params)
      && (params as unknown[]).includes('onboarding_photo_type_es')
    );
    expect(outboxInsert).toBeDefined();
  });

  test('invalid media content type replies gracefully and stays in state', async () => {
    const { detectMediaCategory } = require('../../../../lambda/whatsapp/lib/media');
    detectMediaCategory.mockReturnValue(null);

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM003' }] }) // claim
      .mockResolvedValueOnce({                                                   // SELECT conv FOR UPDATE
        rowCount: 1,
        rows: [convRow({ conversation_state: 'awaiting_media_photo', user_id: 'user-1' })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox media_photo_invalid
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed_messages db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox (empty)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSqsEvent({
      MessageSid: 'SM003',
      From: 'whatsapp:+15125551234',
      Body: '',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/0',
      MediaContentType0: 'application/pdf',
    }), {} as any, {} as any);

    // State should NOT advance — no UPDATE whatsapp_conversations to new state
    const convUpdate = mockQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE whatsapp_conversations/.test(sql)
    );
    expect(convUpdate).toBeUndefined();
  });
});

describe('awaiting_media_voice state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWILIO_SECRET_ARN = 'arn:twilio';
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test',
        authToken: 'tok_test',
        messagingServiceSid: 'MGtest_svc',
        templates: {},
      }),
    });
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'OK' });
  });

  test('text message (skip) transitions to building_profile and asks first profile question', async () => {
    const { detectMediaCategory } = require('../../../../lambda/whatsapp/lib/media');
    detectMediaCategory.mockReturnValue(null);

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM004' }] }) // claim
      .mockResolvedValueOnce({                                                   // SELECT conv FOR UPDATE
        rowCount: 1,
        rows: [convRow({
          conversation_state: 'awaiting_media_voice',
          user_id: 'user-1',
          language: 'en',
        })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // SELECT profile fields
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE whatsapp_conversations
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox profile_intro
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox ask_name
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed_messages db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox (empty)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSqsEvent({
      MessageSid: 'SM004',
      From: 'whatsapp:+15125551234',
      Body: 'skip',
      NumMedia: '0',
    }), {} as any, {} as any);

    const convUpdate = mockQuery.mock.calls.find(([sql, params]) =>
      /UPDATE whatsapp_conversations SET/i.test(sql as string)
      && Array.isArray(params)
      && (params as unknown[]).includes('building_profile')
    );
    expect(convUpdate).toBeDefined();
    const stateJson = (convUpdate![1] as unknown[]).find((value) =>
      typeof value === 'string' && value.includes('pending_field')
    );
    expect(JSON.parse(String(stateJson))).toMatchObject({
      pending_field: 'full_name',
      collected: {},
      field_sids: {},
    });

    const outboxBodiesForSkip = outboxBodies();
    expect(outboxBodiesForSkip.length).toBeGreaterThanOrEqual(2);
    expect(outboxBodiesForSkip.join('\n').toLowerCase()).toContain('full name');
  });

  test('spanish text choice transitions to text profile and asks first question in spanish', async () => {
    const { detectMediaCategory } = require('../../../../lambda/whatsapp/lib/media');
    detectMediaCategory.mockReturnValue(null);

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM004-es' }] }) // claim
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({
          conversation_state: 'awaiting_media_voice',
          user_id: 'user-1',
          language: 'es',
        })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // SELECT profile fields
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE whatsapp_conversations
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox profile_intro
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox ask_name
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed_messages db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox (empty)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSqsEvent({
      MessageSid: 'SM004-es',
      From: 'whatsapp:+15125551234',
      Body: 'texto',
      NumMedia: '0',
    }), {} as any, {} as any);

    const convUpdate = mockQuery.mock.calls.find(([sql, params]) =>
      /UPDATE whatsapp_conversations SET/i.test(sql as string)
      && Array.isArray(params)
      && (params as unknown[]).includes('building_profile')
    );
    expect(convUpdate).toBeDefined();
    const stateJson = (convUpdate![1] as unknown[]).find((value) =>
      typeof value === 'string' && value.includes('pending_field')
    );
    expect(JSON.parse(String(stateJson))).toMatchObject({
      pending_field: 'full_name',
    });

    const outboxBodiesForTextChoice = outboxBodies();
    expect(outboxBodiesForTextChoice.length).toBeGreaterThanOrEqual(2);
    expect(outboxBodiesForTextChoice.join('\n').toLowerCase()).toContain('nombre completo');
  });

  test('valid voice message starts Step Functions execution and transitions to processing_ai', async () => {
    const { detectMediaCategory, downloadTwilioMedia, uploadMediaToS3 } =
      require('../../../../lambda/whatsapp/lib/media');
    detectMediaCategory.mockReturnValue('voice');
    downloadTwilioMedia.mockResolvedValue(Buffer.from('fake-audio'));
    uploadMediaToS3.mockResolvedValue(undefined);
    mockSfnSend.mockResolvedValue({ executionArn: 'arn:aws:states:us-east-2:123:execution:test:run-1' });
    process.env.AI_PIPELINE_STATE_MACHINE_ARN = 'arn:aws:states:us-east-2:123:stateMachine:test';
    process.env.MEDIA_BUCKET_NAME = 'jale-worker-media-test';

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM005' }] }) // claim
      .mockResolvedValueOnce({                                                   // SELECT conv FOR UPDATE
        rowCount: 1,
        rows: [convRow({ conversation_state: 'awaiting_media_voice', user_id: 'user-1' })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ cognito_sub: 'worker-sub' }] }) // SELECT worker for RLS
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT worker_profile_media
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE whatsapp_conversations
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox ai_processing_ack
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed_messages db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox (empty)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSqsEvent({
      MessageSid: 'SM005',
      From: 'whatsapp:+15125551234',
      Body: '',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/0',
      MediaSid0: 'MMtest-voice',
      MediaContentType0: 'audio/ogg',
    }), {} as any, {} as any);

    expect(mockSfnSend).toHaveBeenCalledTimes(1);
    const mediaInsert = mockQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO worker_profile_media/.test(sql)
    );
    expect(mediaInsert).toBeDefined();
    expect(mediaInsert![1]).toEqual(expect.arrayContaining(['MMtest-voice', 'audio/ogg']));
    expect((mediaInsert![1] as unknown[]).filter((value) => value === 'audio/ogg')).toHaveLength(1);
    const convUpdate = mockQuery.mock.calls.find(([sql, params]) =>
      /UPDATE whatsapp_conversations SET/i.test(sql as string)
      && Array.isArray(params)
      && (params as unknown[]).includes('processing_ai')
    );
    expect(convUpdate).toBeDefined();
    const outboxInsert = mockQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO whatsapp_outbox/.test(sql)
    );
    expect(outboxInsert).toBeDefined();
  });
});

describe('building_profile custom trade handoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWILIO_SECRET_ARN = 'arn:twilio';
    process.env.QUESTION_GENERATOR_ARN = 'arn:aws:lambda:us-east-2:123:function:question-generator';
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test',
        authToken: 'tok_test',
        messagingServiceSid: 'MGtest_svc',
        templates: {},
      }),
    });
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'OK' });
  });

  test('last text profile answer for other trade generates custom questions and asks Q1 in spanish', async () => {
    const customQuestions = [
      { q_en: 'What welding work do you do?', q_es: 'Que tipo de soldadura haces?' },
      { q_en: 'What is your level?', q_es: 'Cual es tu nivel?' },
      { q_en: 'What tasks do you do most?', q_es: 'Que tareas haces mas?' },
    ];
    mockLambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify(customQuestions)),
    });

    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-custom-final' }] }) // claim
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({
          conversation_state: 'building_profile',
          user_id: 'user-1',
          language: 'es',
          state_context: {
            pending_field: 'availability',
            collected: {
              full_name: 'Luis Worker',
              city: 'Denver',
              main_trade: 'other',
              main_trade_other: 'Soldador',
              years_experience: '10+',
              has_transportation: true,
            },
            field_sids: {},
          },
        })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // SELECT profile fields before compute next
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE users
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPSERT worker_profiles
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ main_trade_other: 'Soldador' }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // existing WTA
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // cached trade_questions
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation building_custom_trust
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox Q1
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSqsEvent({
      MessageSid: 'SM-custom-final',
      From: 'whatsapp:+15125551234',
      Body: '1',
      NumMedia: '0',
    }), {} as any, {} as any);

    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(Buffer.from(mockLambdaSend.mock.calls[0][0].input.Payload).toString());
    expect(payload).toEqual({ professionKey: 'soldador', professionRaw: 'Soldador' });

    const customStateUpdate = mockQuery.mock.calls.find(([sql, params]) =>
      /UPDATE whatsapp_conversations SET/i.test(sql as string)
      && Array.isArray(params)
      && (params as unknown[]).includes('building_custom_trust')
    );
    expect(customStateUpdate).toBeDefined();
    const stateJson = (customStateUpdate![1] as unknown[]).find((value) =>
      typeof value === 'string' && value.includes('custom_trust_questions')
    );
    expect(JSON.parse(String(stateJson))).toMatchObject({
      custom_trust_step: 0,
      custom_trust_profession: 'Soldador',
      custom_trust_questions: customQuestions,
    });
    expect(outboxBodies()).toContain('Que tipo de soldadura haces?');
  });
});

describe('processing_ai state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWILIO_SECRET_ARN = 'arn:twilio';
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test',
        authToken: 'tok_test',
        messagingServiceSid: 'MGtest_svc',
        templates: {},
      }),
    });
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'OK' });
  });

  test('any inbound message replies with ai_processing_wait and does not change state', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM006' }] }) // claim
      .mockResolvedValueOnce({                                                   // SELECT conv FOR UPDATE
        rowCount: 1,
        rows: [convRow({ conversation_state: 'processing_ai', user_id: 'user-1' })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox ai_processing_wait
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed_messages db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox (empty)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSqsEvent({
      MessageSid: 'SM006',
      From: 'whatsapp:+15125551234',
      Body: 'are you done yet?',
      NumMedia: '0',
    }), {} as any, {} as any);

    const outboxInsert = mockQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO whatsapp_outbox/.test(sql)
    );
    expect(outboxInsert).toBeDefined();
    // State should NOT change — still processing_ai
    const convUpdate = mockQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE whatsapp_conversations/.test(sql) && /building_profile/.test(sql)
    );
    expect(convUpdate).toBeUndefined();
  });
});

// ── interactivePayload extraction from Body (WhatsApp List Picker fix) ──────
//
// Twilio's WhatsApp List Picker integration delivers the tapped row's response
// value in the message Body, not in ButtonPayload / InteractiveData /
// ChannelMetadata. processRecord now falls back to findKnownPayload(body) when
// the other three sources are empty, with a 256-char cap on the body length.
describe('interactivePayload extraction from Body', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TWILIO_SECRET_ARN = 'arn:twilio';
    process.env.WORKER_POOL_ID = 'pool-abc';
    process.env.WORKER_CLIENT_ID = 'client-abc';
    process.env.DB_SECRET_ARN = 'arn:db';
    process.env.REQUIRED_TOS_VERSION = '1.0';
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid: 'AC_test',
        authToken: 'tok_test',
        messagingServiceSid: 'MGtest_svc',
        templates: {},
      }),
    });
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'OK' });
  });

  // Test A — Body-as-payload is accepted on the trade prompt.
  test('A: Body containing profile:main_trade:other is accepted and advances pending field', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-bodypayload-A' }] }) // claim
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({
          conversation_state: 'building_profile',
          user_id: 'user-1',
          language: 'es',
          state_context: {
            pending_field: 'main_trade',
            collected: { full_name: 'Luis Worker', city: 'El Paso' },
            field_sids: {},
          },
        })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // SELECT profile fields (loadProfileFromDb)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation -> pending=main_trade_other
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox (ask_trade_freetext plain text)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox (empty)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSqsEvent({
      MessageSid: 'SM-bodypayload-A',
      From: 'whatsapp:+15125551234',
      Body: 'profile:main_trade:other',
    }), {} as any, {} as any);

    // Pending advances to main_trade_other (the conditional freetext branch).
    const convUpdate = mockQuery.mock.calls.find(([sql, params]) =>
      /UPDATE whatsapp_conversations SET/i.test(sql as string)
      && Array.isArray(params)
      && (params as unknown[]).some((value) =>
        typeof value === 'string' && value.includes('"pending_field":"main_trade_other"')
      )
    );
    expect(convUpdate).toBeDefined();

    // Collected.main_trade is captured as 'other'.
    const stateJson = (convUpdate![1] as unknown[]).find((value) =>
      typeof value === 'string' && value.includes('pending_field')
    );
    expect(JSON.parse(String(stateJson))).toMatchObject({
      pending_field: 'main_trade_other',
      collected: { main_trade: 'other' },
    });

    // No profile_reprompt was enqueued.
    const reprompt = outboxBodies().find((b) => /Terminemos tu perfil primero/.test(b ?? ''));
    expect(reprompt).toBeUndefined();
  });

  // Test B1 — Plain-text answer on a freetext field still works (no false positives).
  test('B1: plain-text answer on freetext field (city) is accepted and advances to main_trade', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-bodypayload-B1' }] }) // claim
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({
          conversation_state: 'building_profile',
          user_id: 'user-1',
          language: 'es',
          state_context: {
            pending_field: 'city',
            collected: { full_name: 'Luis Worker' },
            field_sids: {},
          },
        })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // SELECT profile fields
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation -> pending=main_trade
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox (onboarding_trade_es rich)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSqsEvent({
      MessageSid: 'SM-bodypayload-B1',
      From: 'whatsapp:+15125551234',
      Body: '79928',
    }), {} as any, {} as any);

    const convUpdate = mockQuery.mock.calls.find(([sql, params]) =>
      /UPDATE whatsapp_conversations SET/i.test(sql as string)
      && Array.isArray(params)
      && (params as unknown[]).some((value) =>
        typeof value === 'string' && value.includes('"pending_field":"main_trade"')
      )
    );
    expect(convUpdate).toBeDefined();
    const stateJson = (convUpdate![1] as unknown[]).find((value) =>
      typeof value === 'string' && value.includes('pending_field')
    );
    expect(JSON.parse(String(stateJson))).toMatchObject({
      pending_field: 'main_trade',
      collected: { city: '79928' },
    });
  });

  // Test B2 — Numeric answer on a button field still works.
  test('B2: numeric Body "2" on main_trade resolves to "plumber" and advances to years_experience', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-bodypayload-B2' }] }) // claim
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({
          conversation_state: 'building_profile',
          user_id: 'user-1',
          language: 'es',
          state_context: {
            pending_field: 'main_trade',
            collected: { full_name: 'Luis Worker', city: 'El Paso' },
            field_sids: {},
          },
        })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // SELECT profile fields
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation -> pending=years_experience
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox (onboarding_experience_es rich)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSqsEvent({
      MessageSid: 'SM-bodypayload-B2',
      From: 'whatsapp:+15125551234',
      Body: '2',
    }), {} as any, {} as any);

    const convUpdate = mockQuery.mock.calls.find(([sql, params]) =>
      /UPDATE whatsapp_conversations SET/i.test(sql as string)
      && Array.isArray(params)
      && (params as unknown[]).some((value) =>
        typeof value === 'string' && value.includes('"pending_field":"years_experience"')
      )
    );
    expect(convUpdate).toBeDefined();
    const stateJson = (convUpdate![1] as unknown[]).find((value) =>
      typeof value === 'string' && value.includes('pending_field')
    );
    expect(JSON.parse(String(stateJson))).toMatchObject({
      pending_field: 'years_experience',
      collected: { main_trade: 'plumber' },
    });
  });

  // Test C — Real precedence: ButtonPayload beats Body even when both are valid payloads.
  test('C: ButtonPayload wins over a competing Body payload', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-bodypayload-C' }] }) // claim
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({
          conversation_state: 'building_profile',
          user_id: 'user-1',
          language: 'es',
          state_context: {
            pending_field: 'main_trade',
            collected: { full_name: 'Luis Worker', city: 'El Paso' },
            field_sids: {},
          },
        })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // SELECT profile fields
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed db_committed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    await handler(makeSqsEvent({
      MessageSid: 'SM-bodypayload-C',
      From: 'whatsapp:+15125551234',
      ButtonPayload: 'profile:main_trade:electrician',
      Body: 'profile:main_trade:other',
    }), {} as any, {} as any);

    const convUpdate = mockQuery.mock.calls.find(([sql, params]) =>
      /UPDATE whatsapp_conversations SET/i.test(sql as string)
      && Array.isArray(params)
      && (params as unknown[]).some((value) =>
        typeof value === 'string' && value.includes('pending_field')
      )
    );
    expect(convUpdate).toBeDefined();
    const stateJson = (convUpdate![1] as unknown[]).find((value) =>
      typeof value === 'string' && value.includes('pending_field')
    );
    const state = JSON.parse(String(stateJson));
    expect(state.collected.main_trade).toBe('electrician');
    expect(state.collected.main_trade).not.toBe('other');
    // 'electrician' is not the conditional 'other' branch, so pending advances
    // straight to years_experience.
    expect(state.pending_field).toBe('years_experience');
  });

  // Test D — Oversized Body is ignored by the fallback (safety cap pinned).
  test('D: Body over 256 chars is not used as payload fallback; profile_reprompt fires', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-bodypayload-D' }] }) // claim
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [convRow({
          conversation_state: 'building_profile',
          user_id: 'user-1',
          language: 'es',
          state_context: {
            pending_field: 'main_trade',
            collected: { full_name: 'Luis Worker', city: 'El Paso' },
            field_sids: {},
          },
        })],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox (profile_reprompt plain text)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE processed db_committed (post-route stamp)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT pending outbox
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // markCompleted

    const oversizedBody = 'profile:main_trade:' + 'x'.repeat(300);
    expect(oversizedBody.length).toBeGreaterThan(256);

    await handler(makeSqsEvent({
      MessageSid: 'SM-bodypayload-D',
      From: 'whatsapp:+15125551234',
      Body: oversizedBody,
    }), {} as any, {} as any);

    // No conversation state advance — invalid answer just re-prompts.
    const convAdvance = mockQuery.mock.calls.find(([sql, params]) =>
      /UPDATE whatsapp_conversations SET/i.test(sql as string)
      && Array.isArray(params)
      && (params as unknown[]).some((value) =>
        typeof value === 'string' && /"pending_field":"(?!main_trade")/.test(value)
      )
    );
    expect(convAdvance).toBeUndefined();

    // The plain-text profile_reprompt body was enqueued.
    const reprompt = outboxBodies().find((b) => /Terminemos tu perfil primero/.test(b ?? ''));
    expect(reprompt).toBeDefined();
  });
});
