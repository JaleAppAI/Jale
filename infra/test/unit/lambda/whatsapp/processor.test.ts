/**
 * Processor Lambda — unit tests for Fix Plan v3 (2026-04-17).
 *
 * The Fix Plan v2 tests were rewritten when processRecord moved from
 * `isDuplicateSid` + post-route stamp to a `whatsapp_processed_messages`
 * claim + outbox lifecycle. These tests cover:
 *
 *   - Fix 3 (ABORT): reconcileUserRow throws when the placeholder has
 *     dependent consent or application rows.
 *   - Fix 4 (atomic claim): processRecord elects one winner on concurrent
 *     MessageSid; duplicate invocations either no-op or resume outbox.
 *   - Fix 5 (outbox): handler replies go into whatsapp_outbox inside the
 *     transaction; sendPendingOutbox drains them AFTER commit; a Twilio
 *     failure leaves state committed but claim status=db_committed so a
 *     retry can resume without re-running side effects.
 *
 * Underlying invariants from v2 (persisted Cognito Session, JWT-decoded
 * cognito_sub reconcile cases A/B/C, `otp_expired_retry` path) are still
 * exercised by the happy-path tests — those flows are unchanged, only the
 * reply-delivery mechanism moved.
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

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();
jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({ connect: mockConnect })),
  setRlsContext: jest.fn(),
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

describe('Processor Lambda — Fix Plan v3 (2026-04-17)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
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

  // ── Fix 4: atomic claim / duplicate detection ───────────────────────────

  describe('Fix 4 — claim lifecycle', () => {
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
  });

  // ── Fix 5: outbox — Twilio failure leaves claim db_committed ────────────

  describe('Fix 5 — outbox resilience to Twilio failure', () => {
    it('Twilio 500 on outbox send: row marked failed, markCompleted NOT called', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-twilio-fail' }] }) // claim
        .mockResolvedValueOnce({ rowCount: 1, rows: [convRow({ conversation_state: 'idle' })] }) // SELECT conv FOR UPDATE
        // handleIdle for "Trabajos": empty jobs list
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT from jobs
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

  // ── Fix 3: ABORT on placeholder with dependent rows ─────────────────────

  describe('Fix 3 — reconcileUserRow ABORT on dependents', () => {
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
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation idle
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox profile_complete
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

      const idleUpdate = mockQuery.mock.calls.find(([sql, params]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string)
        && Array.isArray(params)
        && params.includes('idle'),
      );
      expect(idleUpdate).toBeDefined();
    });

    it('skips trust questions if migration 007 columns are missing', async () => {
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
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation idle
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox profile_complete
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
      const idleUpdate = mockQuery.mock.calls.find(([sql, params]) =>
        /UPDATE whatsapp_conversations SET/i.test(sql as string)
        && Array.isArray(params)
        && params.includes('idle'),
      );
      expect(idleUpdate).toBeDefined();
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
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ message_sid: 'SM-jobs' }] }) // claim
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [convRow({ conversation_state: 'idle', user_id: 'user-1' })],
        })
        .mockResolvedValueOnce({
          rowCount: 2,
          rows: [
            { id: 'job-1', title: 'Electrician', company: 'ABC', location: 'El Paso', pay: '$25/hr' },
            { id: 'job-2', title: 'Plumber', company: 'XYZ', location: 'El Paso', pay: '$22/hr' },
          ],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE conversation recent_jobs
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT outbox job list
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
