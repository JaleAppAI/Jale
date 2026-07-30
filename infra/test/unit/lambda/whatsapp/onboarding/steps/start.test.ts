/**
 * Job referrals (migration 055): `handleStartStep` recognises an apply
 * token as a first message, side-effects a parked claim, and otherwise
 * behaves EXACTLY like no code had been sent — same invitation, same
 * cooldown/cap accounting, no `users` row, no OTP. The park attempt is
 * isolated behind a SAVEPOINT so a failure there can never cost the sender
 * their Start invitation. Every DB write below is asserted via a
 * scriptable `client.query` fake (mirrors `onboarding-repository.test.ts`'s
 * style), never a real PoolClient.
 */

import { handleStartStep } from '../../../../../../lambda/whatsapp/onboarding/steps/start';
import { formatApplyToken, parseApplyToken } from '../../../../../../lambda/lib/referral-codes';
import type { PreAuthState } from '../../../../../../lambda/whatsapp/lib/onboarding-repository';
import type { OnboardingV2Deps, OnboardingV2Session, OnboardingV2InboundMessage } from '../../../../../../lambda/whatsapp/onboarding/types';

const PHONE = '+15550001111';
const PHONE_HASH = 'a'.repeat(64);
const NOW = new Date('2026-07-29T12:00:00.000Z');
const RAW_TOKEN = 'ABCD1234';
const JOB_ID = 'bbbbbbbb-0000-0000-0000-000000000001';

function makeSession(overrides: Partial<OnboardingV2Session> = {}): OnboardingV2Session {
  return {
    id: 'conv-1',
    user_id: null,
    whatsapp_number: PHONE,
    language: 'es',
    conversation_state: 'onboarding_v2',
    state_context: {},
    ...overrides,
  };
}

function makeMsg(body: string, messageSid = 'SM1'): OnboardingV2InboundMessage {
  return { from: PHONE, body, messageSid };
}

/**
 * Order-independent dispatcher covering every statement `handleStartStep`'s
 * referral-park path can issue: the SAVEPOINT/RELEASE/ROLLBACK wrapper plus
 * `parkPendingClaim`'s own three possible statements. `failOn`, when given,
 * makes the FIRST call whose SQL matches it throw — simulating a lock
 * timeout/serialization failure/transient error inside the savepoint.
 */
function makeReferralClient(opts: {
  tokenFound: boolean;
  shareCode?: string | null;
  referrerWorkerId?: string | null;
  jobId?: string;
  failOn?: RegExp;
}): jest.Mock {
  return jest.fn(async (sql: string) => {
    if (opts.failOn && opts.failOn.test(sql)) {
      throw new Error('simulated_referral_park_failure');
    }
    if (/^SAVEPOINT/.test(sql) || /^RELEASE SAVEPOINT/.test(sql) || /^ROLLBACK TO SAVEPOINT/.test(sql)) {
      return { rows: [] };
    }
    if (/UPDATE referral_apply_tokens/.test(sql)) {
      return opts.tokenFound
        ? { rows: [{ share_code: opts.shareCode ?? null, job_id: opts.jobId ?? JOB_ID, locale: 'es' }] }
        : { rows: [] };
    }
    if (/FROM job_share_links/.test(sql)) {
      return { rows: [{ referrer_worker_id: opts.referrerWorkerId ?? null }] };
    }
    if (/INSERT INTO referral_pending_claims/.test(sql)) {
      return { rows: [] };
    }
    throw new Error(`referral test client: unexpected query ${sql}`);
  });
}

function makeDeps(): {
  deps: OnboardingV2Deps;
  prompts: unknown[];
  texts: unknown[];
  savedPatches: unknown[];
  issueChallenge: jest.Mock;
} {
  const prompts: unknown[] = [];
  const texts: unknown[] = [];
  const savedPatches: unknown[] = [];
  const issueChallenge = jest.fn(async () => ({
    status: 'sent' as const,
    challengeId: 'chal-issued',
    expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
  }));

  const deps = {
    adapters: {
      identity: { issueChallenge },
    } as any,
    repo: {
      savePreAuthState: async (_c: any, _phoneHash: string, patch: any) => {
        savedPatches.push(patch);
        return {} as PreAuthState;
      },
    } as any,
    enqueueWorkerMessage: async () => {
      throw new Error('enqueueWorkerMessage must never be called from handleStartStep');
    },
    enqueuePreAuthPrompt: async (_c: any, _sid: string, _to: string, prompt: unknown) => {
      prompts.push(prompt);
    },
    enqueuePreAuthText: async (_c: any, _sid: string, _to: string, body: string) => {
      texts.push(body);
    },
    hashNormalizedPhone: (p: string) => `hash:${p}`,
    tosUrl: 'https://jale.example/tos',
    privacyUrl: 'https://jale.example/privacy',
    workflowVersion: 1,
    requiredLegalVersion: '1.0',
    recordLegalAcceptance: async () => undefined,
    voiceIntake: { enabled: false, startTrustTranscription: async () => ({ started: false }), ingestProfileVoiceNote: async () => ({ started: false }) },
  } as unknown as OnboardingV2Deps;

  return { deps, prompts, texts, savedPatches, issueChallenge };
}

const client = { query: jest.fn() } as any;

describe('handleStartStep — job referral code recognition', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    client.query = jest.fn();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('a valid apply token parks a claim (behind a SAVEPOINT), sends the normal invitation, creates no user row and issues no OTP', async () => {
    const { deps, prompts, texts, savedPatches, issueChallenge } = makeDeps();
    client.query = makeReferralClient({ tokenFound: true, shareCode: 'SHARECOD', referrerWorkerId: 'worker-referrer' });

    const body = `${formatApplyToken(RAW_TOKEN)} I want this job`;
    const result = await handleStartStep(client, makeSession(), makeMsg(body), deps, null, PHONE_HASH, NOW);

    expect(result).toEqual({ handled: true, workerId: null, stepKey: 'start.choose_language' });

    // No `users` row and no OTP: the ONLY thing that ever issues an OTP is
    // `deps.adapters.identity.issueChallenge` (a real code sends START/
    // EMPEZAR, never a JALE- token), and the only thing that ever creates a
    // `users` row is that same OTP-verified path — neither ran.
    expect(issueChallenge).not.toHaveBeenCalled();
    expect(savedPatches.some((p: any) => p.currentStepKey === 'identity.verify_otp' || 'providerChallengeId' in p)).toBe(false);

    // SAVEPOINT, consume, share-link lookup, upsert, RELEASE SAVEPOINT —
    // every statement client.query saw at all.
    const statements: string[] = client.query.mock.calls.map((call: any[]) => String(call[0]));
    expect(statements).toEqual([
      'SAVEPOINT referral_park',
      expect.stringMatching(/UPDATE referral_apply_tokens/),
      expect.stringMatching(/FROM job_share_links/),
      expect.stringMatching(/INSERT INTO referral_pending_claims/),
      'RELEASE SAVEPOINT referral_park',
    ]);

    // Exactly the normal start invitation went out — no bound-phase send.
    expect(prompts).toHaveLength(1);
    expect(texts).toHaveLength(0);
  });

  it('a failed park (simulated lock/serialization error on the FIRST statement) still sends the Start invitation and resolves normally', async () => {
    const { deps, prompts, texts } = makeDeps();
    // Fail the FIRST statement parkPendingClaim issues — mirrors a lock
    // timeout/serialization failure. Without the SAVEPOINT wrapper this
    // would abort the whole transaction (Postgres 25P02) and every
    // statement after it — including the invitation send — would fail too.
    client.query = makeReferralClient({ tokenFound: true, failOn: /UPDATE referral_apply_tokens/ });

    const body = formatApplyToken(RAW_TOKEN);
    await expect(
      handleStartStep(client, makeSession(), makeMsg(body), deps, null, PHONE_HASH, NOW),
    ).resolves.toEqual({ handled: true, workerId: null, stepKey: 'start.choose_language' });

    // The invitation still went out — the referral failure never propagated.
    expect(prompts).toHaveLength(1);
    expect(texts).toHaveLength(0);

    const statements: string[] = client.query.mock.calls.map((call: any[]) => String(call[0]));
    expect(statements[0]).toBe('SAVEPOINT referral_park');
    expect(statements).toContain('ROLLBACK TO SAVEPOINT referral_park');
    expect(statements).not.toContain('RELEASE SAVEPOINT referral_park');

    // Only a static error code was logged — never a token, phone, or hash.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = String(consoleErrorSpy.mock.calls[0][0]);
    expect(logged).toContain('ReferralParkFailed');
    expect(logged).not.toContain(RAW_TOKEN);
    expect(logged).not.toContain(PHONE_HASH);
    expect(logged).not.toContain(PHONE);
  });

  it('a failed park (simulated error on the LAST statement, after the token was already consumed) still rolls back cleanly and sends the invitation', async () => {
    const { deps, prompts, texts } = makeDeps();
    // Fail the FINAL statement in parkPendingClaim's sequence — the token
    // has already been marked consumed by the time this throws. Proves the
    // SAVEPOINT boundary spans the WHOLE park attempt (not just its first
    // statement): ROLLBACK TO SAVEPOINT must undo the token consumption
    // too, so a half-completed park never burns a token for nothing.
    client.query = makeReferralClient({ tokenFound: true, shareCode: null, failOn: /INSERT INTO referral_pending_claims/ });

    const body = formatApplyToken(RAW_TOKEN);
    await expect(
      handleStartStep(client, makeSession(), makeMsg(body), deps, null, PHONE_HASH, NOW),
    ).resolves.toEqual({ handled: true, workerId: null, stepKey: 'start.choose_language' });

    expect(prompts).toHaveLength(1);
    expect(texts).toHaveLength(0);

    const statements: string[] = client.query.mock.calls.map((call: any[]) => String(call[0]));
    expect(statements[0]).toBe('SAVEPOINT referral_park');
    expect(statements).toContain('ROLLBACK TO SAVEPOINT referral_park');
    expect(statements).not.toContain('RELEASE SAVEPOINT referral_park');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('parseApplyToken never throws on hostile input (verifying the contract this handler relies on)', () => {
    const hostileInputs: Array<string | null | undefined> = [
      '',
      null,
      undefined,
      'JALE-',
      'JALE',
      'JALE'.repeat(5000),
      `JALE-${'A'.repeat(100000)}`,
      '🔥💥🚀 emoji body with no code',
      '  JALE-ABCD1234 ',
      'مرحبا JALE-ABCD1234 رسالة عربية',
      'jale-l0o1 23',
      'JALE-' + 'I'.repeat(8), // ambiguous-char mapping, still 8 chars after mapping
    ];
    for (const input of hostileInputs) {
      let result: string | null = null;
      expect(() => {
        result = parseApplyToken(input);
      }).not.toThrow();
      expect(result === null || /^[0-9A-HJKMNP-TV-Z]{8}$/.test(result as unknown as string)).toBe(true);
    }
  });

  it('the acknowledgement is byte-identical for a phone with no account, a candidateUserId, and a bound session.user_id', async () => {
    const body = formatApplyToken(RAW_TOKEN);

    // Arm A: no prior account at all.
    const { deps: depsA, prompts: promptsA } = makeDeps();
    client.query = makeReferralClient({ tokenFound: true, shareCode: null });
    await handleStartStep(client, makeSession(), makeMsg(body, 'SM-no-account'), depsA, null, PHONE_HASH, NOW);

    // Arm B: a pre-auth candidateUserId (phone matches an existing account,
    // web-signup-linked, but no gate/run yet).
    const { deps: depsB, prompts: promptsB } = makeDeps();
    client.query = makeReferralClient({ tokenFound: true, shareCode: null });
    const preAuthWithCandidate: PreAuthState = {
      challengeId: 'chal-1',
      phoneHash: PHONE_HASH,
      providerChallengeId: null,
      candidateUserId: 'existing-worker-id',
      preferredLanguage: 'es',
      currentStepKey: 'start.choose_language',
      context: {},
      status: 'pending',
      attempts: 0,
      expiresAt: null,
      lockedUntil: null,
    };
    await handleStartStep(client, makeSession(), makeMsg(body, 'SM-with-candidate'), depsB, preAuthWithCandidate, PHONE_HASH, NOW);

    // Arm C: session.user_id already bound (the shape routeOnboardingV2
    // hands handleStartStep when the conversation row's phone matched an
    // existing account but no gate row exists yet).
    const { deps: depsC, prompts: promptsC } = makeDeps();
    client.query = makeReferralClient({ tokenFound: true, shareCode: null });
    await handleStartStep(
      client,
      makeSession({ user_id: 'existing-worker-id' }),
      makeMsg(body, 'SM-with-user-id'),
      depsC,
      null,
      PHONE_HASH,
      NOW,
    );

    expect(promptsA).toHaveLength(1);
    expect(promptsB).toHaveLength(1);
    expect(promptsC).toHaveLength(1);
    expect(promptsA[0]).toEqual(promptsB[0]);
    expect(promptsA[0]).toEqual(promptsC[0]);
  });

  it('an unknown/expired/already-consumed token behaves exactly like no code: identical invitation, no disclosure', async () => {
    // Baseline: a message carrying no code at all, but also not a language
    // choice (so it takes the same "send the invitation" branch).
    const { deps: depsBaseline, prompts: promptsBaseline } = makeDeps();
    await handleStartStep(client, makeSession(), makeMsg('hola', 'SM-no-code'), depsBaseline, null, PHONE_HASH, NOW);

    // An unknown/expired/consumed token.
    const { deps, prompts } = makeDeps();
    client.query = makeReferralClient({ tokenFound: false });
    const body = formatApplyToken(RAW_TOKEN);
    const result = await handleStartStep(client, makeSession(), makeMsg(body, 'SM-bad-code'), deps, null, PHONE_HASH, NOW);

    expect(result).toEqual({ handled: true, workerId: null, stepKey: 'start.choose_language' });
    expect(prompts).toHaveLength(1);
    expect(promptsBaseline).toHaveLength(1);
    // Deep equality, not just "no suspicious substring" — the two outbound
    // prompts must be indistinguishable.
    expect(prompts[0]).toEqual(promptsBaseline[0]);
  });

  it('no apply token in the body never touches the referral tables at all', async () => {
    const { deps, prompts, issueChallenge } = makeDeps();

    const result = await handleStartStep(client, makeSession(), makeMsg('START'), deps, null, PHONE_HASH, NOW);

    expect(client.query).not.toHaveBeenCalled();
    expect(issueChallenge).toHaveBeenCalledTimes(1);
    expect(result.stepKey).toBe('identity.verify_otp');
    expect(prompts).toHaveLength(1);
  });

  it('sending a code while inside the START cooldown parks the claim but produces no extra outbound message', async () => {
    const { deps, prompts, texts } = makeDeps();
    client.query = makeReferralClient({ tokenFound: true, shareCode: null });

    const session = makeSession();
    const recentlySent: PreAuthState = {
      challengeId: 'chal-2',
      phoneHash: PHONE_HASH,
      providerChallengeId: null,
      candidateUserId: null,
      preferredLanguage: 'es',
      currentStepKey: 'start.choose_language',
      context: { startSendHistory: [new Date(NOW.getTime() - 60 * 1000).toISOString()] },
      status: 'pending',
      attempts: 0,
      expiresAt: null,
      lockedUntil: null,
    };

    const body = formatApplyToken(RAW_TOKEN);
    const result = await handleStartStep(client, session, makeMsg(body), deps, recentlySent, PHONE_HASH, NOW);

    // Cooldown still blocks the invitation resend — the referral code draws
    // on the SAME send budget, it does not bypass it.
    expect(result).toEqual({ handled: true, workerId: null, stepKey: 'start.choose_language' });
    expect(prompts).toHaveLength(0);
    expect(texts).toHaveLength(0);
    // But the claim was still parked: SAVEPOINT, consume token, upsert,
    // RELEASE SAVEPOINT (no share_code lookup since shareCode is null here).
    expect(client.query).toHaveBeenCalledTimes(4);
  });
});
