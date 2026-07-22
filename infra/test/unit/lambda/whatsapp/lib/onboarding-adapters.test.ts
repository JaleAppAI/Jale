/**
 * Task 2: Workflow Adapters — onboarding-adapters.ts
 *
 * Mocks the AWS SDK at the module boundary (pattern copied from
 * test/unit/lambda/whatsapp/onboarding-conversation.test.ts:32-63) so the
 * adapters under test never touch real AWS.
 */

// ── Mocks (must come before the adapter import) ─────────────────────────

const mockCognitoSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
  AdminGetUserCommand: jest.fn((args) => ({ input: args, __type: 'AdminGetUser' })),
  AdminAddUserToGroupCommand: jest.fn((args) => ({ input: args, __type: 'AdminAddUserToGroup' })),
  AdminEnableUserCommand: jest.fn((args) => ({ input: args, __type: 'AdminEnableUser' })),
  AdminSetUserPasswordCommand: jest.fn((args) => ({ input: args, __type: 'AdminSetUserPassword' })),
  AdminUpdateUserAttributesCommand: jest.fn((args) => ({ input: args, __type: 'AdminUpdateUserAttributes' })),
  AdminCreateUserCommand: jest.fn((args) => ({ input: args, __type: 'AdminCreateUser' })),
  InitiateAuthCommand: jest.fn((args) => ({ input: args, __type: 'InitiateAuth' })),
  RespondToAuthChallengeCommand: jest.fn((args) => ({ input: args, __type: 'RespondToAuthChallenge' })),
  AuthFlowType: { CUSTOM_AUTH: 'CUSTOM_AUTH' },
  ChallengeNameType: { CUSTOM_CHALLENGE: 'CUSTOM_CHALLENGE' },
}));

const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((args) => ({ input: args, __type: 'Invoke' })),
}));

import type { PoolClient } from 'pg';
import {
  createIdentityAdapter,
  createLocationResolver,
  createTrustQuestionGenerator,
  createProfilePersistenceAdapter,
  createOnboardingV2Adapters,
  standardTrustQuestions,
  normalizeTrade,
  type ReconcileUserRowFn,
} from '../../../../../lambda/whatsapp/lib/onboarding-adapters';

// ── helpers ──────────────────────────────────────────────────────────────

function fakeIdToken(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function fixedClock(iso: string) {
  const fixed = new Date(iso);
  return { now: () => fixed };
}

/** A happy-path AdminGetUser response: sub present, all attrs already reconciled. */
function happyAdminGetUserResponse(phone: string) {
  return {
    UserAttributes: [
      { Name: 'sub', Value: 'cognito-sub-1' },
      { Name: 'phone_number', Value: phone },
      { Name: 'phone_number_verified', Value: 'true' },
      { Name: 'custom:user_type', Value: 'worker' },
    ],
    Enabled: true,
    UserStatus: 'CONFIRMED',
  };
}

function mockCognitoDispatch(handlers: Record<string, (cmd: any) => any>) {
  mockCognitoSend.mockImplementation(async (cmd: any) => {
    const handler = handlers[cmd.__type];
    if (!handler) {
      throw new Error(`unhandled cognito command in test: ${cmd.__type}`);
    }
    return handler(cmd);
  });
}

function mockPoolClient(): jest.Mocked<PoolClient> {
  return {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  } as unknown as jest.Mocked<PoolClient>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── IdentityAdapter.issueChallenge ──────────────────────────────────────

describe('IdentityAdapter.issueChallenge', () => {
  const clock = fixedClock('2026-07-22T12:00:00.000Z');
  const reconcileUserRow: ReconcileUserRowFn = jest.fn();

  it('returns sent with a challenge id and expiresAt === now + 5 minutes', async () => {
    mockCognitoDispatch({
      AdminGetUser: () => happyAdminGetUserResponse('whatsapp:+15125550100'),
      AdminAddUserToGroup: () => ({}),
      InitiateAuth: () => ({ Session: 'session-abc' }),
    });

    const identity = createIdentityAdapter({
      userPoolId: 'pool-1',
      clientId: 'client-1',
      clock,
      reconcileUserRow,
    });

    const result = await identity.issueChallenge({
      whatsappNumber: 'whatsapp:+15125550100',
      lang: 'en',
    });

    expect(result.status).toBe('sent');
    if (result.status === 'sent') {
      expect(result.challengeId).toBe('session-abc');
      expect(result.expiresAt.getTime()).toBe(
        clock.now().getTime() + 5 * 60 * 1000,
      );
      // Not the legacy 10-minute TTL.
      expect(result.expiresAt.getTime()).not.toBe(
        clock.now().getTime() + 10 * 60 * 1000,
      );
    }
  });

  it('surfaces a Cognito throttle error as throttled, never throws', async () => {
    mockCognitoDispatch({
      AdminGetUser: () => happyAdminGetUserResponse('whatsapp:+15125550100'),
      AdminAddUserToGroup: () => ({}),
      InitiateAuth: () => {
        const err: any = new Error('Too many requests');
        err.name = 'TooManyRequestsException';
        throw err;
      },
    });

    const identity = createIdentityAdapter({
      userPoolId: 'pool-1',
      clientId: 'client-1',
      clock,
      reconcileUserRow,
    });

    await expect(
      identity.issueChallenge({ whatsappNumber: 'whatsapp:+15125550100', lang: 'en' }),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'throttled', retryAfterSeconds: expect.any(Number) }),
    );
  });
});

// ── IdentityAdapter.verifyChallenge ─────────────────────────────────────

describe('IdentityAdapter.verifyChallenge', () => {
  const clock = fixedClock('2026-07-22T12:00:00.000Z');

  it('returns verified with the reconciled worker UUID on a correct code', async () => {
    const reconcileUserRow: ReconcileUserRowFn = jest.fn().mockResolvedValue({
      userId: 'worker-uuid-1',
      tosVersion: '1.0',
    });
    mockCognitoDispatch({
      RespondToAuthChallenge: () => ({
        AuthenticationResult: { IdToken: fakeIdToken('real-cognito-sub-1') },
      }),
    });

    const identity = createIdentityAdapter({
      userPoolId: 'pool-1',
      clientId: 'client-1',
      clock,
      reconcileUserRow,
    });
    const client = mockPoolClient();

    const result = await identity.verifyChallenge(client, {
      challengeId: 'session-abc',
      whatsappNumber: 'whatsapp:+15125550100',
      code: '123456',
      attempts: 0,
      lockedUntil: null,
    });

    expect(result).toEqual({ status: 'verified', workerId: 'worker-uuid-1' });
    expect(reconcileUserRow).toHaveBeenCalledWith(
      client,
      'real-cognito-sub-1',
      'whatsapp:+15125550100',
    );
  });

  it(
    'counts down attemptsRemaining 2, then 1, on the first two wrong codes, then locks on ' +
      'the third — using a FRESH adapter instance per call, proving the lock survives across ' +
      "separate Lambda invocations because the caller (not the adapter) holds the count",
    async () => {
      mockCognitoDispatch({
        RespondToAuthChallenge: () => ({ Session: 'session-retry' }),
      });

      const baseInput = {
        challengeId: 'session-abc',
        whatsappNumber: 'whatsapp:+15125550199',
        code: '000000',
      };

      // Call 1: brand-new adapter, no prior attempts persisted anywhere.
      const identity1 = createIdentityAdapter({
        userPoolId: 'pool-1',
        clientId: 'client-1',
        clock,
        reconcileUserRow: jest.fn(),
      });
      const first = await identity1.verifyChallenge(mockPoolClient(), {
        ...baseInput,
        attempts: 0,
        lockedUntil: null,
      });
      expect(first).toEqual({ status: 'invalid', attemptsRemaining: 2, attempts: 1 });

      // Call 2: a SECOND, independently-constructed adapter — simulating the
      // next Lambda invocation. The only thing carried forward is the
      // attempt count the caller persisted from call 1's result.
      const identity2 = createIdentityAdapter({
        userPoolId: 'pool-1',
        clientId: 'client-1',
        clock,
        reconcileUserRow: jest.fn(),
      });
      const second = await identity2.verifyChallenge(mockPoolClient(), {
        ...baseInput,
        attempts: first.status === 'invalid' ? first.attempts : 0,
        lockedUntil: null,
      });
      expect(second).toEqual({ status: 'invalid', attemptsRemaining: 1, attempts: 2 });

      // Call 3: a THIRD, independently-constructed adapter.
      const identity3 = createIdentityAdapter({
        userPoolId: 'pool-1',
        clientId: 'client-1',
        clock,
        reconcileUserRow: jest.fn(),
      });
      const third = await identity3.verifyChallenge(mockPoolClient(), {
        ...baseInput,
        attempts: second.status === 'invalid' ? second.attempts : 0,
        lockedUntil: null,
      });
      expect(third.status).toBe('locked');
      if (third.status === 'locked') {
        expect(third.lockedUntil.getTime()).toBe(clock.now().getTime() + 15 * 60 * 1000);
      }
    },
  );

  it('returns expired (not invalid) when the Cognito session has expired', async () => {
    const reconcileUserRow: ReconcileUserRowFn = jest.fn();
    mockCognitoDispatch({
      RespondToAuthChallenge: () => {
        const err: any = new Error('Invalid session for the user, session is expired.');
        err.name = 'NotAuthorizedException';
        throw err;
      },
    });

    const identity = createIdentityAdapter({
      userPoolId: 'pool-1',
      clientId: 'client-1',
      clock,
      reconcileUserRow,
    });
    const client = mockPoolClient();

    const result = await identity.verifyChallenge(client, {
      challengeId: 'session-abc',
      whatsappNumber: 'whatsapp:+15125550188',
      code: '123456',
      attempts: 0,
      lockedUntil: null,
    });

    expect(result).toEqual({ status: 'expired' });
  });

  it('returns locked immediately, without calling Cognito, when a caller-supplied lockedUntil is still in the future', async () => {
    const reconcileUserRow: ReconcileUserRowFn = jest.fn();
    const identity = createIdentityAdapter({
      userPoolId: 'pool-1',
      clientId: 'client-1',
      clock,
      reconcileUserRow,
    });
    const client = mockPoolClient();
    const lockedUntil = new Date(clock.now().getTime() + 5 * 60 * 1000);

    const result = await identity.verifyChallenge(client, {
      challengeId: 'session-abc',
      whatsappNumber: 'whatsapp:+15125550177',
      code: '123456',
      attempts: 3,
      lockedUntil,
    });

    expect(result).toEqual({ status: 'locked', lockedUntil });
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });
});

// ── LocationResolver ─────────────────────────────────────────────────────

describe('LocationResolver.resolve', () => {
  const location = createLocationResolver();

  it('parses a 5-digit body as a zip', () => {
    const result = location.resolve('78701');
    expect(result).not.toBeNull();
    expect(result?.postalCode).toBe('78701');
    expect(result?.source).toBe('zip');
  });

  it('parses "City, ST" as city_state with a null postal code', () => {
    const result = location.resolve('Austin, TX');
    expect(result).not.toBeNull();
    expect(result?.source).toBe('city_state');
    expect(result?.postalCode).toBeNull();
    expect(result?.city).toBe('Austin');
    expect(result?.state).toBe('TX');
  });

  it('returns null for unrecognized input', () => {
    expect(location.resolve('???')).toBeNull();
  });
});

// ── TrustQuestionGenerator ───────────────────────────────────────────────

describe('TrustQuestionGenerator.generate', () => {
  it('returns three bilingual questions with non-empty, distinct text', async () => {
    const generator = createTrustQuestionGenerator();
    const client = mockPoolClient();
    (client.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        {
          questions: [
            { q_en: 'What tools have you used?', q_es: 'Que herramientas has usado?' },
            { q_en: 'How many years of experience?', q_es: 'Cuantos anos de experiencia?' },
            { q_en: 'Describe your last job.', q_es: 'Describe tu ultimo trabajo.' },
          ],
        },
      ],
    });

    const questions = await generator.generate(client, 'electrician');

    expect(questions).not.toBeNull();
    expect(questions).toHaveLength(3);
    const enTexts = new Set(questions!.map((q: { q_en: string }) => q.q_en));
    const esTexts = new Set(questions!.map((q: { q_es: string }) => q.q_es));
    expect(enTexts.size).toBe(3);
    expect(esTexts.size).toBe(3);
    for (const q of questions!) {
      expect(q.q_en.length).toBeGreaterThan(0);
      expect(q.q_es.length).toBeGreaterThan(0);
    }
  });

  it('returns null and does not throw when generation fails', async () => {
    const generator = createTrustQuestionGenerator();
    const client = mockPoolClient();
    (client.query as jest.Mock).mockRejectedValueOnce(new Error('db unreachable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(generator.generate(client, 'plumber')).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    // Sanitized: no phone numbers, OTPs, or raw message bodies in the log.
    const loggedArgs = JSON.stringify(errorSpy.mock.calls);
    expect(loggedArgs).not.toMatch(/\+1\d{10}/);
    expect(loggedArgs).not.toMatch(/whatsapp:/);

    errorSpy.mockRestore();
  });
});

// ── Re-exported trade/trust vocabulary ───────────────────────────────────

describe('standardTrustQuestions', () => {
  it('returns three questions sourced from TRUST_QUESTIONS', () => {
    const questions = standardTrustQuestions('electrician');
    expect(questions).toHaveLength(3);
    for (const q of questions) {
      expect(q.q_en.length).toBeGreaterThan(0);
      expect(q.q_es.length).toBeGreaterThan(0);
    }
  });
});

describe('normalizeTrade', () => {
  it('lowercases and trims', () => {
    expect(normalizeTrade('  WELDING ')).toBe('welding');
  });
});

// ── ProfilePersistenceAdapter ─────────────────────────────────────────────

describe('ProfilePersistenceAdapter', () => {
  const profile = createProfilePersistenceAdapter();

  it('saveName writes through the supplied client and never opens a transaction', async () => {
    const client = mockPoolClient();
    await profile.saveName(client, 'worker-1', 'Jane Doe');

    expect(client.query).toHaveBeenCalled();
    const calls = (client.query as jest.Mock).mock.calls.map((c) => String(c[0]).toUpperCase());
    expect(calls.some((sql) => sql.includes('BEGIN'))).toBe(false);
    expect(calls.some((sql) => sql.includes('COMMIT'))).toBe(false);
    expect(calls.some((sql) => sql.includes('ROLLBACK'))).toBe(false);
  });

  it('saveLocation maps zip -> geocoded_zip through the supplied client', async () => {
    const client = mockPoolClient();
    await profile.saveLocation(client, 'worker-1', {
      city: null,
      state: null,
      postalCode: '78701',
      source: 'zip',
    });

    expect(client.query).toHaveBeenCalled();
    const allParams = (client.query as jest.Mock).mock.calls.flatMap((c) => c[1] ?? []);
    expect(allParams).toContain('geocoded_zip');
  });

  it('saveTrade writes through the supplied client', async () => {
    const client = mockPoolClient();
    await profile.saveTrade(client, 'worker-1', 'welding');
    expect(client.query).toHaveBeenCalled();
  });

  it('saveTrustAnswer writes through the supplied client, targeting worker_trust_assessments (never worker_trust_answers)', async () => {
    const client = mockPoolClient();
    await profile.saveTrustAnswer(client, {
      workerId: 'worker-1',
      professionKey: 'electrician',
      questionIndex: 0,
      answerText: 'Residential',
    });

    expect(client.query).toHaveBeenCalled();
    const calls = (client.query as jest.Mock).mock.calls.map((c) => String(c[0]));
    const upper = calls.map((sql) => sql.toUpperCase());
    expect(upper.some((sql) => sql.includes('BEGIN'))).toBe(false);
    expect(upper.some((sql) => sql.includes('COMMIT'))).toBe(false);
    expect(upper.some((sql) => sql.includes('ROLLBACK'))).toBe(false);
    expect(calls.some((sql) => sql.includes('worker_trust_assessments'))).toBe(true);
    expect(calls.some((sql) => sql.includes('worker_trust_answers'))).toBe(false);
  });

  it('saveTrustAnswer merges into an existing in-progress assessment\'s answers JSONB and routes provenance through rubric_version/scoring_model_id', async () => {
    const client = mockPoolClient();
    (client.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ id: 'assessment-1', answers: [{ question_index: 0, answer_text: 'Residential' }] }],
      rowCount: 1,
    });

    await profile.saveTrustAnswer(client, {
      workerId: 'worker-1',
      professionKey: 'electrician',
      questionIndex: 1,
      answerText: 'Can work alone',
      provenance: { rubricVersion: 'v3', scoringModelId: 'model-x' },
    });

    const calls = (client.query as jest.Mock).mock.calls;
    // Second call is the UPDATE merging the answer.
    const [updateSql, updateParams] = calls[1];
    expect(String(updateSql)).toContain('worker_trust_assessments');
    expect(String(updateSql).toUpperCase()).toContain('UPDATE');
    expect(updateParams).toContain('assessment-1');
    expect(updateParams).toContain('v3');
    expect(updateParams).toContain('model-x');
    const mergedAnswersJson = updateParams.find(
      (p: unknown) => typeof p === 'string' && p.includes('Can work alone'),
    );
    expect(mergedAnswersJson).toBeDefined();
    expect(JSON.parse(mergedAnswersJson)).toHaveLength(2);
  });
});

// ── createOnboardingV2Adapters ────────────────────────────────────────────

describe('createOnboardingV2Adapters', () => {
  it('wires up every adapter surface', () => {
    const reconcileUserRow: ReconcileUserRowFn = jest.fn();
    const adapters = createOnboardingV2Adapters({
      reconcileUserRow,
      userPoolId: 'pool-1',
      clientId: 'client-1',
    });

    expect(typeof adapters.clock.now).toBe('function');
    expect(typeof adapters.identity.issueChallenge).toBe('function');
    expect(typeof adapters.identity.verifyChallenge).toBe('function');
    expect(typeof adapters.location.resolve).toBe('function');
    expect(typeof adapters.trustQuestions.generate).toBe('function');
    expect(typeof adapters.profile.saveName).toBe('function');
  });
});
