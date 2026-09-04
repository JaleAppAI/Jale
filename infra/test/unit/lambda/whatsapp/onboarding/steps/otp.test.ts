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
