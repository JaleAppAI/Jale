/**
 * Sprint 24 A3 (review 1): the RESEND path of `handleOtpStep` when the OTP's
 * SMS could not be sent.
 *
 * `issueChallenge` returns `{ status: 'send_failed' }` when Cognito surfaces
 * a `UserLambdaValidationException` -- CreateAuthChallenge's Twilio send
 * failed (e.g. 21408, region not enabled). Before A3 that came back as a
 * THROW, which DLQ'd the inbound record: the worker got silence and the
 * message was gone. This step must answer instead, and must not charge a
 * send that never happened to the 3-per-hour resend budget.
 *
 * Same style as `steps/start.test.ts`: hand-rolled deps and a scriptable
 * `client.query` fake, no shared harness (`test/helpers/whatsapp-v2-harness.ts`
 * is another lane's file).
 */

import { handleOtpStep } from '../../../../../../lambda/whatsapp/onboarding/steps/otp';
import { t } from '../../../../../../lambda/whatsapp/lib/templates';
import type { PreAuthState } from '../../../../../../lambda/whatsapp/lib/onboarding-repository';
import type {
  OnboardingV2Deps,
  OnboardingV2Session,
  OnboardingV2InboundMessage,
} from '../../../../../../lambda/whatsapp/onboarding/types';

const PHONE = '+15550001111';
const PHONE_HASH = 'a'.repeat(64);
const NOW = new Date('2026-09-04T12:00:00.000Z');
/** Well outside the 60s resend cooldown and the 3/hour cap. */
const OLD_SEND = new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString();

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

function makePreAuth(overrides: Partial<PreAuthState> = {}): PreAuthState {
  return {
    challengeId: 'chal-local',
    phoneHash: PHONE_HASH,
    providerChallengeId: 'chal-provider',
    candidateUserId: 'worker-candidate',
    preferredLanguage: 'es',
    currentStepKey: 'identity.verify_otp',
    context: { otpSendHistory: [OLD_SEND] },
    status: 'pending',
    attempts: 0,
    expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
    lockedUntil: null,
    ...overrides,
  };
}

function makeMsg(
  overrides: Partial<OnboardingV2InboundMessage> = {},
): OnboardingV2InboundMessage {
  return { from: PHONE, body: 'reenviar', messageSid: 'SM-otp-resend', ...overrides };
}

function makeDeps(issueChallenge: jest.Mock): {
  deps: OnboardingV2Deps;
  texts: string[];
  prompts: unknown[];
  savedPatches: Array<Record<string, unknown>>;
} {
  const texts: string[] = [];
  const prompts: unknown[] = [];
  const savedPatches: Array<Record<string, unknown>> = [];

  const deps = {
    adapters: {
      identity: {
        issueChallenge,
        verifyChallenge: async () => {
          throw new Error('verifyChallenge must never run on the RESEND path');
        },
      },
    } as any,
    repo: {
      savePreAuthState: async (_c: any, _phoneHash: string, patch: Record<string, unknown>) => {
        savedPatches.push(patch);
        return {} as PreAuthState;
      },
    } as any,
    enqueueWorkerMessage: async () => {
      throw new Error('enqueueWorkerMessage must never be called pre-auth');
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
    voiceIntake: {
      enabled: false,
      startTrustTranscription: async () => ({ started: false }),
      ingestProfileVoiceNote: async () => ({ started: false }),
    },
  } as unknown as OnboardingV2Deps;

  return { deps, texts, prompts, savedPatches };
}

const client = { query: jest.fn() } as any;

describe('handleOtpStep — a resent OTP whose SMS could not be sent', () => {
  beforeEach(() => {
    client.query = jest.fn(async () => ({ rowCount: 0, rows: [] }));
  });

  it('answers in the worker language, stays on the OTP step, and persists nothing', async () => {
    const issueChallenge = jest.fn(async () => ({ status: 'send_failed' as const }));
    const { deps, texts, prompts, savedPatches } = makeDeps(issueChallenge);

    const result = await handleOtpStep(
      client,
      makeSession(),
      makeMsg(),
      deps,
      makePreAuth(),
      PHONE_HASH,
      NOW,
    );

    // The record is ACKED, not DLQ'd: nothing thrown, handled true.
    expect(result).toEqual({ handled: true, workerId: null, stepKey: 'identity.verify_otp' });

    // Exactly the send-failure copy, in the worker's language, once.
    expect(texts).toEqual([t('v2_otp_send_failed', 'es')]);
    // Not the OTP prompt: implying a code is on its way would be a lie.
    expect(prompts).toHaveLength(0);

    // Nothing persisted. The previously issued challenge is still the live
    // one, so overwriting providerChallengeId/expiresAt would invalidate a
    // code the worker may still be able to use -- and a send that never
    // happened must not be charged to the 3-per-hour budget.
    expect(savedPatches).toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('answers in English when that is the worker language', async () => {
    const issueChallenge = jest.fn(async () => ({ status: 'send_failed' as const }));
    const { deps, texts } = makeDeps(issueChallenge);

    await handleOtpStep(
      client,
      makeSession({ language: 'en' }),
      makeMsg({ body: 'resend' }),
      deps,
      makePreAuth({ preferredLanguage: 'en' }),
      PHONE_HASH,
      NOW,
    );

    expect(texts).toEqual([t('v2_otp_send_failed', 'en')]);
    expect(texts[0]).not.toBe(t('v2_otp_send_failed', 'es'));
  });

  it('reaches the same branch from the Resend BUTTON, not just the typed word', async () => {
    const issueChallenge = jest.fn(async () => ({ status: 'send_failed' as const }));
    const { deps, texts, savedPatches } = makeDeps(issueChallenge);

    const result = await handleOtpStep(
      client,
      makeSession(),
      makeMsg({ body: '', interactivePayload: 'otp:resend' } as Partial<OnboardingV2InboundMessage>),
      deps,
      makePreAuth(),
      PHONE_HASH,
      NOW,
    );

    expect(result.handled).toBe(true);
    expect(texts).toEqual([t('v2_otp_send_failed', 'es')]);
    expect(savedPatches).toEqual([]);
  });

  it('CONTRAST: a resend that does send charges the budget and stores the new challenge', async () => {
    // Proves the assertions above are not vacuous -- the same harness DOES
    // record a save when the send succeeds.
    const expiresAt = new Date(NOW.getTime() + 5 * 60 * 1000);
    const issueChallenge = jest.fn(async () => ({
      status: 'sent' as const,
      challengeId: 'chal-new',
      expiresAt,
    }));
    const { deps, prompts, savedPatches } = makeDeps(issueChallenge);

    await handleOtpStep(client, makeSession(), makeMsg(), deps, makePreAuth(), PHONE_HASH, NOW);

    expect(savedPatches).toHaveLength(1);
    expect(savedPatches[0]).toMatchObject({ providerChallengeId: 'chal-new', expiresAt });
    expect((savedPatches[0].context as { otpSendHistory: string[] }).otpSendHistory).toEqual([
      OLD_SEND,
      NOW.toISOString(),
    ]);
    expect(prompts).toHaveLength(1);
  });

  it('a send failure never logs the phone number, the code, or provider text', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const issueChallenge = jest.fn(async () => ({ status: 'send_failed' as const }));
      const { deps } = makeDeps(issueChallenge);

      await handleOtpStep(client, makeSession(), makeMsg(), deps, makePreAuth(), PHONE_HASH, NOW);

      const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls]
        .map((call) => call.map((arg) => String(arg)).join(' '))
        .join('\n');
      expect(logged).not.toContain(PHONE);
      expect(logged).not.toContain(PHONE_HASH);
      expect(logged).not.toContain('21408');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

// ── Sprint 27: the WhatsApp door's apply token at the OTP step ───────────

const RAW_TOKEN = 'ABCD1234';
const JOB_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const WORKER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PREFILL_ES = `Quiero postularme a este trabajo: JALE-${RAW_TOKEN}`;
const PREFILL_EN = `I want to apply for this job: JALE-${RAW_TOKEN}`;
/** The approved copy, verbatim. */
const ACK_OTP_ES = 'Recibimos tu solicitud para: Finish Carpenter - Acme Builders. Escribe el codigo que te enviamos para continuar.';
const ACK_OTP_EN = 'Got it: Finish Carpenter - Acme Builders. Enter the code we sent you to continue.';
const ENTER_CODE_ES = 'Escribe el codigo que te enviamos para continuar.';

/**
 * Order-independent fake for every statement the token and ready-bind paths
 * can issue. Anything else throws, so an unexpected statement is loud.
 */
function referralClient(opts: {
  tokenFound?: boolean;
  jobActive?: boolean;
  claim?: { job_id: string; share_code: string | null } | null;
  openUnapplied?: boolean;
  failOn?: RegExp;
} = {}): jest.Mock {
  return jest.fn(async (sql: string) => {
    if (opts.failOn && opts.failOn.test(sql)) throw new Error('simulated_referral_failure');
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) /.test(sql)) return { rows: [], rowCount: 0 };
    if (/UPDATE referral_apply_tokens/.test(sql)) {
      return opts.tokenFound
        ? { rows: [{ share_code: null, job_id: JOB_ID, locale: 'es' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO referral_pending_claims/.test(sql)) return { rows: [], rowCount: 1 };
    if (/UPDATE referral_pending_claims/.test(sql)) {
      return opts.claim ? { rows: [opts.claim], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO worker_attribution/.test(sql)) return { rows: [], rowCount: 1 };
    if (/INSERT INTO worker_referred_jobs/.test(sql)) return { rows: [], rowCount: 1 };
    if (/FROM jobs j/.test(sql) && /NOT EXISTS/.test(sql)) {
      return opts.openUnapplied === false ? { rows: [], rowCount: 0 } : { rows: [{ open: 1 }], rowCount: 1 };
    }
    if (/FROM jobs\s+WHERE id = \$1\s+AND status = 'active'/.test(sql)) {
      return opts.jobActive === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{ title: 'Finish Carpenter', company: 'Acme Builders' }], rowCount: 1 };
    }
    throw new Error(`otp test client: unexpected query ${sql}`);
  });
}

function makeTokenDeps(opts: {
  verifyChallenge?: jest.Mock;
  readyGate?: boolean;
} = {}) {
  const texts: string[] = [];
  const prompts: unknown[] = [];
  const savedPatches: Array<Record<string, unknown>> = [];
  const issueChallenge = jest.fn(async () => ({
    status: 'sent' as const,
    challengeId: 'chal-new',
    expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
  }));
  const verifyChallenge = opts.verifyChallenge ?? jest.fn(async () => {
    throw new Error('verifyChallenge must never receive an apply token');
  });
  const setInternalUserRlsContext = jest.fn(async () => undefined);
  const enqueueWorkerMessage = jest.fn(async () => {
    throw new Error('the OTP step never sends a bound-step message on these paths');
  });
  const bindVerifiedIdentityAndStartWorkflow = jest.fn(async () => (opts.readyGate === false
    ? {
        userId: WORKER_ID, lifecycle: 'onboarding', runId: 'run-1', workflowVersion: 1,
        currentStepKey: 'legal.review', status: 'active', preferredLanguage: 'es', lockVersion: 0,
      }
    : {
        // Migration 087: a web-completed worker's COMPLETED run is adopted.
        userId: WORKER_ID, lifecycle: 'ready', runId: 'run-1', workflowVersion: 1,
        currentStepKey: 'trust.question.3', status: 'completed', preferredLanguage: 'es', lockVersion: 7,
      }));

  const deps = {
    adapters: { identity: { issueChallenge, verifyChallenge } } as any,
    repo: {
      setInternalUserRlsContext,
      bindVerifiedIdentityAndStartWorkflow,
      savePreAuthState: async (_c: any, _phoneHash: string, patch: Record<string, unknown>) => {
        savedPatches.push(patch);
        return {} as PreAuthState;
      },
    } as any,
    enqueueWorkerMessage,
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
    voiceIntake: {
      enabled: false,
      startTrustTranscription: async () => ({ started: false }),
      ingestProfileVoiceNote: async () => ({ started: false }),
    },
  } as unknown as OnboardingV2Deps;

  return {
    deps, texts, prompts, savedPatches, issueChallenge, verifyChallenge,
    setInternalUserRlsContext, enqueueWorkerMessage,
  };
}

function sqlOf(query: jest.Mock): string[] {
  return query.mock.calls.map(([sql]) => String(sql));
}

describe('handleOtpStep — an apply token while a code is pending', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  it('is never checked as a code: no verify, attempts untouched, the token parks, and the reply names the job', async () => {
    const query = referralClient({ tokenFound: true });
    const { deps, texts, prompts, savedPatches, issueChallenge, verifyChallenge } = makeTokenDeps();

    const result = await handleOtpStep(
      { query } as any, makeSession(), makeMsg({ body: PREFILL_ES, messageSid: 'SM-token' }), deps,
      makePreAuth({ attempts: 1 }), PHONE_HASH, NOW,
    );

    expect(result).toEqual({ handled: true, workerId: null, stepKey: 'identity.verify_otp' });
    // The identity adapter never saw the body, so the 3-attempt counter (and
    // with it the 15-minute lock) cannot have moved.
    expect(verifyChallenge).not.toHaveBeenCalled();
    expect(savedPatches).toEqual([]);
    // No new challenge, and no "we sent you a code" prompt re-sent.
    expect(issueChallenge).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(0);

    // Parked behind its own SAVEPOINT, exactly like the first-message park.
    const sql = sqlOf(query);
    expect(sql[0]).toMatch(/^SAVEPOINT /);
    expect(sql.some((s) => /UPDATE referral_apply_tokens/.test(s))).toBe(true);
    expect(sql.some((s) => /INSERT INTO referral_pending_claims/.test(s))).toBe(true);
    expect(sql.some((s) => /^RELEASE SAVEPOINT /.test(s))).toBe(true);

    expect(texts).toEqual([ACK_OTP_ES]);
  });

  it('answers in English for a worker whose pre-auth language is English', async () => {
    const query = referralClient({ tokenFound: true });
    const { deps, texts } = makeTokenDeps();

    await handleOtpStep(
      { query } as any, makeSession({ language: 'en' }), makeMsg({ body: PREFILL_EN }), deps,
      makePreAuth({ preferredLanguage: 'en' }), PHONE_HASH, NOW,
    );

    expect(texts).toEqual([ACK_OTP_EN]);
  });

  it('an unparkable token (unknown, consumed or expired) asks for the code -- still never checked as one', async () => {
    const query = referralClient({ tokenFound: false });
    const { deps, texts, prompts, savedPatches, verifyChallenge } = makeTokenDeps();

    await handleOtpStep({ query } as any, makeSession(), makeMsg({ body: PREFILL_ES }), deps, makePreAuth(), PHONE_HASH, NOW);

    expect(verifyChallenge).not.toHaveBeenCalled();
    expect(savedPatches).toEqual([]);
    expect(prompts).toHaveLength(0);
    expect(texts).toEqual([ENTER_CODE_ES]);
  });

  it('a parked token whose job is no longer active asks for the code instead of naming it', async () => {
    const query = referralClient({ tokenFound: true, jobActive: false });
    const { deps, texts } = makeTokenDeps();

    await handleOtpStep({ query } as any, makeSession(), makeMsg({ body: PREFILL_ES }), deps, makePreAuth(), PHONE_HASH, NOW);

    expect(texts).toEqual([ENTER_CODE_ES]);
  });

  it('a failed park rolls back its savepoint, logs a static metric, and still asks for the code', async () => {
    const query = referralClient({ tokenFound: true, failOn: /UPDATE referral_apply_tokens/ });
    const { deps, texts, verifyChallenge } = makeTokenDeps();

    await expect(handleOtpStep(
      { query } as any, makeSession(), makeMsg({ body: PREFILL_ES }), deps, makePreAuth(), PHONE_HASH, NOW,
    )).resolves.toEqual({ handled: true, workerId: null, stepKey: 'identity.verify_otp' });

    expect(verifyChallenge).not.toHaveBeenCalled();
    expect(sqlOf(query).some((s) => /^ROLLBACK TO SAVEPOINT /.test(s))).toBe(true);
    expect(texts).toEqual([ENTER_CODE_ES]);
    const logged = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(logged).toContain('ReferralParkFailed');
    expect(logged).not.toContain(RAW_TOKEN);
    expect(logged).not.toContain(PHONE_HASH);
    expect(logged).not.toContain(PHONE);
  });

  it('a LOCKED worker sending a token: no verify, and the lock is left exactly as it was', async () => {
    const query = referralClient({ tokenFound: true });
    const { deps, savedPatches, verifyChallenge } = makeTokenDeps();

    await handleOtpStep(
      { query } as any, makeSession(), makeMsg({ body: PREFILL_ES }), deps,
      makePreAuth({ attempts: 3, status: 'locked', lockedUntil: new Date(NOW.getTime() + 10 * 60 * 1000) }),
      PHONE_HASH, NOW,
    );

    expect(verifyChallenge).not.toHaveBeenCalled();
    expect(savedPatches).toEqual([]);
  });

  it('CONTRAST: a plain 6-digit code still goes to the identity adapter', async () => {
    const query = referralClient();
    const verifyChallenge = jest.fn(async () => ({
      status: 'invalid' as const, attemptsRemaining: 2, attempts: 1, rotatedChallengeId: null,
    }));
    const { deps, savedPatches } = makeTokenDeps({ verifyChallenge });

    await handleOtpStep({ query } as any, makeSession(), makeMsg({ body: '123456' }), deps, makePreAuth(), PHONE_HASH, NOW);

    expect(verifyChallenge).toHaveBeenCalledTimes(1);
    expect(savedPatches).toEqual([{ attempts: 1 }]);
    // No referral statement for a body that carries no token.
    expect(query).not.toHaveBeenCalled();
  });
});

describe('handleOtpStep — a READY worker verifies: the handoff carries the claimed job', () => {
  const verified = () => jest.fn(async () => ({ status: 'verified' as const, workerId: WORKER_ID }));

  it('hands off as consumedAsOtp with the claimed job when it is open and unapplied -- and sends nothing itself', async () => {
    const query = referralClient({ claim: { job_id: JOB_ID, share_code: null } });
    const { deps, texts, prompts, setInternalUserRlsContext, enqueueWorkerMessage } = makeTokenDeps({
      verifyChallenge: verified(),
    });

    const result = await handleOtpStep(
      { query } as any, makeSession(), makeMsg({ body: '123456', messageSid: 'SM-otp-ready' }), deps,
      makePreAuth(), PHONE_HASH, NOW,
    );

    expect(result).toEqual({
      handled: false,
      handoff: 'ready',
      workerId: WORKER_ID,
      stepKey: 'ready',
      consumedAsOtp: true,
      referredJobId: JOB_ID,
    });
    // The card is the processor's to send; this step stays silent.
    expect(texts).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    expect(enqueueWorkerMessage).not.toHaveBeenCalled();

    // The internal-user setting is in place before the claim writes anything
    // (migration 103's jale_whatsapp policy keys on it).
    const claimIdx = sqlOf(query).findIndex((s) => /UPDATE referral_pending_claims/.test(s));
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    expect(setInternalUserRlsContext.mock.invocationCallOrder[0])
      .toBeLessThan(query.mock.invocationCallOrder[claimIdx]);
    expect(sqlOf(query)).toContain('SAVEPOINT referral_ready_bind');
    expect(sqlOf(query)).toContain('RELEASE SAVEPOINT referral_ready_bind');
  });

  it('with nothing parked for this phone the handoff is consumedAsOtp alone', async () => {
    const query = referralClient({ claim: null });
    const { deps } = makeTokenDeps({ verifyChallenge: verified() });

    const result = await handleOtpStep({ query } as any, makeSession(), makeMsg({ body: '123456' }), deps, makePreAuth(), PHONE_HASH, NOW);

    expect(result).toEqual({
      handled: false, handoff: 'ready', workerId: WORKER_ID, stepKey: 'ready', consumedAsOtp: true,
    });
  });

  it('a claimed job that closed -- or that this worker already applied to -- carries no referredJobId', async () => {
    const query = referralClient({ claim: { job_id: JOB_ID, share_code: null }, openUnapplied: false });
    const { deps } = makeTokenDeps({ verifyChallenge: verified() });

    const result = await handleOtpStep({ query } as any, makeSession(), makeMsg({ body: '123456' }), deps, makePreAuth(), PHONE_HASH, NOW);

    expect(result).toEqual({
      handled: false, handoff: 'ready', workerId: WORKER_ID, stepKey: 'ready', consumedAsOtp: true,
    });
  });

  it('a failing claim is contained by its savepoint: consumedAsOtp alone, and a static metric', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const query = referralClient({ claim: { job_id: JOB_ID, share_code: null }, failOn: /UPDATE referral_pending_claims/ });
      const { deps } = makeTokenDeps({ verifyChallenge: verified() });

      const result = await handleOtpStep({ query } as any, makeSession(), makeMsg({ body: '123456' }), deps, makePreAuth(), PHONE_HASH, NOW);

      expect(result).toEqual({
        handled: false, handoff: 'ready', workerId: WORKER_ID, stepKey: 'ready', consumedAsOtp: true,
      });
      expect(sqlOf(query)).toContain('ROLLBACK TO SAVEPOINT referral_ready_bind');
      const logged = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(logged).toContain('ReferralReadyBindClaimFailed');
      expect(logged).not.toContain(PHONE_HASH);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a worker still onboarding is NOT handed off: the bind prompts their step as before', async () => {
    const query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const enqueued: unknown[] = [];
    const { deps } = makeTokenDeps({ verifyChallenge: verified(), readyGate: false });
    (deps as any).enqueueWorkerMessage = async (_c: unknown, input: unknown) => {
      enqueued.push(input);
      return { intentId: 'i-1', decision: {}, outboxMaterialized: true };
    };

    const result = await handleOtpStep({ query } as any, makeSession(), makeMsg({ body: '123456' }), deps, makePreAuth(), PHONE_HASH, NOW);

    expect(result).toEqual({ handled: true, workerId: WORKER_ID, stepKey: 'legal.review' });
    expect(enqueued).toHaveLength(1);
  });
});

/**
 * RESEND while the three-strike lock is still active.
 *
 * The verify path saves `status: 'locked', lockedUntil: now + 15 min`. A
 * RESEND during that window used to issue a fresh Cognito code and then ask
 * `save_worker_pre_auth` (042) to clear the lock, which it refuses ("active
 * pre-auth lock cannot be cleared or reduced"): the transaction rolled back,
 * SQS redelivered, every retry texted another code, and the record ended in
 * the DLQ with no reply. The step must answer with the lock message and touch
 * nothing.
 */
describe('handleOtpStep — RESEND while the lock is still active', () => {
  const locked = (lockedUntil: Date, overrides: Partial<PreAuthState> = {}) =>
    makePreAuth({ status: 'locked', attempts: 2, lockedUntil, ...overrides });

  it('replies with the minutes left, issues no code, and persists nothing', async () => {
    const issueChallenge = jest.fn();
    const { deps, texts, prompts, savedPatches } = makeDeps(issueChallenge);

    const result = await handleOtpStep(
      client, makeSession(), makeMsg(), deps,
      locked(new Date(NOW.getTime() + 10 * 60 * 1000)), PHONE_HASH, NOW,
    );

    expect(issueChallenge).not.toHaveBeenCalled();
    expect(savedPatches).toEqual([]);
    expect(prompts).toEqual([]);
    expect(texts).toEqual([t('v2_otp_locked', 'es', { minutes: '10' })]);
    expect(result).toEqual({ handled: true, workerId: null, stepKey: 'identity.verify_otp' });
  });

  it('rounds a partial minute up, so the worker never retries too early', async () => {
    const issueChallenge = jest.fn();
    const { deps, texts } = makeDeps(issueChallenge);

    await handleOtpStep(
      client, makeSession(), makeMsg({ body: 'resend' }), deps,
      locked(new Date(NOW.getTime() + 9.5 * 60 * 1000), { preferredLanguage: 'en' }), PHONE_HASH, NOW,
    );

    expect(issueChallenge).not.toHaveBeenCalled();
    expect(texts).toEqual([t('v2_otp_locked', 'en', { minutes: '10' })]);
  });

  it('answers the Resend BUTTON the same way', async () => {
    const issueChallenge = jest.fn();
    const { deps, texts, savedPatches } = makeDeps(issueChallenge);

    await handleOtpStep(
      client, makeSession(),
      makeMsg({ body: '', interactivePayload: 'otp:resend' } as Partial<OnboardingV2InboundMessage>),
      deps, locked(new Date(NOW.getTime() + 15 * 60 * 1000)), PHONE_HASH, NOW,
    );

    expect(issueChallenge).not.toHaveBeenCalled();
    expect(savedPatches).toEqual([]);
    expect(texts).toEqual([t('v2_otp_locked', 'es', { minutes: '15' })]);
  });

  it('reports the lock ahead of the resend cooldown', async () => {
    // A send 10s ago would trip the 60s cooldown; the lock is the reason that matters.
    const issueChallenge = jest.fn();
    const { deps, texts } = makeDeps(issueChallenge);
    const recentSend = new Date(NOW.getTime() - 10 * 1000).toISOString();

    await handleOtpStep(
      client, makeSession(), makeMsg(), deps,
      locked(new Date(NOW.getTime() + 5 * 60 * 1000), { context: { otpSendHistory: [recentSend] } }),
      PHONE_HASH, NOW,
    );

    expect(texts).toEqual([t('v2_otp_locked', 'es', { minutes: '5' })]);
  });

  it('CONTRAST: once the lock has run out, RESEND issues a new code and clears the lock', async () => {
    const expiresAt = new Date(NOW.getTime() + 5 * 60 * 1000);
    const issueChallenge = jest.fn(async () => ({ status: 'sent' as const, challengeId: 'chal-new', expiresAt }));
    const { deps, prompts, savedPatches } = makeDeps(issueChallenge);

    await handleOtpStep(
      client, makeSession(), makeMsg(), deps,
      locked(new Date(NOW.getTime() - 60 * 1000)), PHONE_HASH, NOW,
    );

    expect(issueChallenge).toHaveBeenCalledTimes(1);
    expect(savedPatches).toHaveLength(1);
    expect(savedPatches[0]).toMatchObject({
      status: 'pending', attempts: 0, lockedUntil: null, providerChallengeId: 'chal-new',
    });
    expect(prompts).toHaveLength(1);
  });
});
