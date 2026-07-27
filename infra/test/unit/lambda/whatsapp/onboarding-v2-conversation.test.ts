/**
 * Task 7: Deterministic Conversation Testbed for the WhatsApp v2 onboarding
 * lane — the lane's freeze gate.
 *
 * Drives WHOLE onboarding conversations end to end through the real
 * `routeOnboardingV2` router via `createWhatsAppV2Harness()`
 * (`../../../helpers/whatsapp-v2-harness`, outside `roots`, not a
 * `.test.ts`). No AWS SDK, no PostgreSQL, no `jest.useFakeTimers()` — the
 * clock is a plain object advanced only by `harness.advanceTime()`.
 */

import { createWhatsAppV2Harness, HARNESS_CLIENT } from '../../../helpers/whatsapp-v2-harness';
import { createReleaseRenderer } from '../../../../lambda/whatsapp/lib/onboarding-renderers';

describe('complete onboarding end to end', () => {
  it('Spanish: entry -> language -> OTP -> legal -> name -> location -> trade -> three trust answers -> ready', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110001' });

    await h.sendText('hola'); // not a language choice: (re)sends the invitation
    expect(h.getSentMessages().some((m) => m.phase === 'pre_auth_prompt')).toBe(true);

    await h.sendText('EMPEZAR');
    expect(h.getState().preAuth?.preferredLanguage).toBe('es');

    await h.sendText(h.lastIssuedOtpCode());
    expect(h.getState().gate?.currentStepKey).toBe('legal.review');
    expect(h.getState().workerId).toBeTruthy();

    await h.sendText('ACEPTAR');
    expect(h.getState().gate?.currentStepKey).toBe('profile.name');
    expect(h.getLegalConsents()).toHaveLength(1);

    await h.sendText('Maria Lopez');
    expect(h.getState().gate?.currentStepKey).toBe('profile.location');
    expect(h.getWorkerProfile()?.name).toBe('Maria Lopez');

    await h.sendText('Austin, TX');
    expect(h.getState().gate?.currentStepKey).toBe('profile.trade');
    expect(h.getWorkerProfile()?.location).toEqual({ city: 'Austin', state: 'TX', postalCode: null, source: 'city_state' });

    await h.sendText('plomero'); // free-typed Spanish trade word is not a canonical slug — expect reprompt.
    expect(h.getState().gate?.currentStepKey).toBe('profile.trade');

    await h.sendText('plumber');
    expect(h.getState().gate?.currentStepKey).toBe('profile.experience');

    // V1/V2 parity: years_experience, has_transportation, availability are
    // now asked before trust, same as the '1'-answer canned path.
    await h.sendText('1'); // years_experience -> profile.transportation
    await h.sendText('1'); // has_transportation -> profile.availability
    await h.sendText('1'); // availability -> trust.question.1
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');

    await h.sendText('1');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.2');
    await h.sendText('1');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.3');
    await h.sendText('1');

    expect(h.getCompletions()).toHaveLength(1);
    expect(h.getState().gate?.status).toBe('completed');
  });

  it('English: entry -> language -> OTP -> legal -> name -> location -> trade -> three trust answers -> ready', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110010' });

    await h.driveToStep('legal.review', { lang: 'en' });
    expect(h.getState().gate?.currentStepKey).toBe('legal.review');

    await h.sendText('ACCEPT');
    expect(h.getLegalConsents()).toHaveLength(1);

    await h.sendText('Jose Martinez');
    await h.sendText('78701');
    expect(h.getWorkerProfile()?.location).toEqual({ city: null, state: null, postalCode: '78701', source: 'zip' });

    await h.sendText('electrician');
    expect(h.getState().gate?.currentStepKey).toBe('profile.experience');

    await h.sendText('1'); // years_experience -> profile.transportation
    await h.sendText('1'); // has_transportation -> profile.availability
    await h.sendText('1'); // availability -> trust.question.1
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');

    await h.sendText('1');
    await h.sendText('1');
    await h.sendText('1');

    expect(h.getCompletions()).toHaveLength(1);
    expect(h.getState().gate?.status).toBe('completed');

    // Ready confirmation is C6's release lane, never this router's job.
    const readySends = h.getSentMessages().filter((m) => (m.sourceType ?? '').includes('v2_ready'));
    expect(readySends).toHaveLength(0);
  });
});

describe('state_context durability across turns (round-tripped, not object-identity reuse)', () => {
  it('a standard-trade question set survives the JSON round trip: an invalid option index at Q2 reprompts rather than being silently accepted as free text', async () => {
    // This is the discriminating case: '99' is invalid as a standard-trade
    // OPTION INDEX, but WOULD be silently accepted as free text if
    // `v2TrustSource`/`v2ProfileTrade` were lost between turns (defaulting
    // to 'fallback' free-text handling) — so this only passes if the
    // harness's persist-then-reload-with-a-JSON-round-trip actually
    // preserves what `profile.trade` wrote into state_context.
    const h = createWhatsAppV2Harness({ phone: '+15551110400' });
    await h.driveToStep('trust.question.2', { trade: 'carpenter' });
    expect(h.getState().stateContext.v2TrustSource).toBe('standard');

    const result = await h.sendText('99');

    expect(result.stepKey).toBe('trust.question.2'); // reprompted, NOT advanced
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.2');
  });

  it('a generated custom-trade question set survives the round trip across all three answers', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110401' });
    await h.driveToStep('trust.question.1', { trade: 'other', customProfession: 'dog groomer' });
    const questionsAtQ1 = h.getState().stateContext.v2TrustQuestions;
    expect(questionsAtQ1).toHaveLength(3);

    await h.sendText('a first answer');
    const questionsAtQ2 = h.getState().stateContext.v2TrustQuestions;
    // Same generated content, not regenerated or lost, after a full
    // persist/round-trip/reload cycle.
    expect(questionsAtQ2).toEqual(questionsAtQ1);

    await h.sendText('a second answer');
    await h.sendText('a third answer');
    expect(h.getCompletions()).toHaveLength(1);
  });
});

describe('cross-language command answered in command language, prompts stay preferred', () => {
  it('a Spanish worker typing TRABAJOS mid-flow gets the blocked reply in Spanish; the NEXT step prompt stays Spanish', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110020' });
    await h.driveToStep('legal.review', { lang: 'es' });

    await h.sendText('TRABAJOS');
    const blockedReply = h.getSentMessages().at(-1);
    expect(blockedReply?.lang).toBe('es');
    expect(h.getState().gate?.currentStepKey).toBe('legal.review'); // gate blocked it, no advance

    await h.sendText('ACEPTAR');
    const nextPrompt = h.getSentMessages().at(-1);
    expect(nextPrompt?.lang).toBe('es'); // preference untouched by the one-off command
  });
});

describe('IDIOMA/LANGUAGE mid-flow preference change persists', () => {
  it('an English-bound worker typing IDIOMA switches subsequent prompts to Spanish, durably across turns (state_context round trip)', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110030' });
    await h.driveToStep('legal.review', { lang: 'en' });
    expect(h.getState().gate?.preferredLanguage).toBe('en');

    await h.sendText('IDIOMA');
    expect(h.getState().gate?.preferredLanguage).toBe('es');
    const confirmSend = h.getSentMessages().at(-1);
    expect(confirmSend?.lang).toBe('es');

    // Persisted in state_context, not just an in-memory mutation — verify it
    // survives a JSON round trip (mirrors the processor's DB writeback).
    const persisted = JSON.parse(JSON.stringify(h.getState().stateContext));
    expect(persisted.v2PreferredLanguageOverride).toBe('es');

    // "accept" is bilingual (both 'accept' and 'aceptar' are recognized),
    // so this advances the step — but the NEXT prompt still honors the
    // Spanish override, proving persistence isn't limited to a single reply.
    await h.sendText('ACCEPT');
    expect(h.getState().gate?.currentStepKey).toBe('profile.name');
    const namePrompt = h.getSentMessages().at(-1);
    expect(namePrompt?.lang).toBe('es'); // override still in effect after advancing
  });

  it('a Spanish-bound worker typing LANGUAGE switches subsequent prompts to English', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110031' });
    await h.driveToStep('legal.review', { lang: 'es' });

    await h.sendText('LANGUAGE');
    expect(h.getState().gate?.preferredLanguage).toBe('en');
    expect(h.getSentMessages().at(-1)?.lang).toBe('en');

    await h.sendText('ACCEPT');
    expect(h.getState().gate?.currentStepKey).toBe('profile.name');
    expect(h.getSentMessages().at(-1)?.lang).toBe('en');
  });
});

describe('start cooldown: 1 per 10 minutes, at most 5 per 24 hours', () => {
  it('blocks an immediate resend, allows after 10 minutes, and caps at 5/24h', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110040' });

    await h.sendText('hi');
    const afterFirst = h.getSentMessages().filter((m) => m.phase === 'pre_auth_prompt').length;
    expect(afterFirst).toBe(1);

    h.advanceTime(2 * 60 * 1000);
    await h.sendText('hi');
    expect(h.getSentMessages().filter((m) => m.phase === 'pre_auth_prompt')).toHaveLength(1);

    for (let i = 0; i < 4; i++) {
      h.advanceTime(11 * 60 * 1000);
      await h.sendText('hi');
    }
    expect(h.getSentMessages().filter((m) => m.phase === 'pre_auth_prompt')).toHaveLength(5);

    h.advanceTime(11 * 60 * 1000);
    await h.sendText('hi');
    expect(h.getSentMessages().filter((m) => m.phase === 'pre_auth_prompt')).toHaveLength(5);
  });
});

describe('OTP lifecycle', () => {
  it('succeeds with the correct code and binds identity at legal.review', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110050' });
    await h.driveToStep('legal.review', { lang: 'en' });
    expect(h.getState().workerId).toBeTruthy();
    expect(h.getState().gate?.currentStepKey).toBe('legal.review');
  });

  it('a wrong code followed by the CORRECT code verifies (rotated session persisted across turns)', async () => {
    // The 2026-07-26 regression, pinned at conversation level: Cognito
    // consumes the presented session on every wrong answer and only the
    // rotated one may be resubmitted (the fake identity adapter models
    // this faithfully — the stale id resolves to 'expired'). A router that
    // fails to persist rotatedChallengeId into providerChallengeId breaks
    // exactly here: the correct code on attempt 2 would report "expired"
    // instead of binding.
    const h = createWhatsAppV2Harness({ phone: '+15551110060' });
    await h.sendText('START');
    const originalChallengeId = h.getState().preAuth?.providerChallengeId;

    const wrong = await h.sendWrongOtp();
    expect(wrong.workerId).toBeNull();
    expect(h.getState().preAuth?.attempts).toBe(1);
    // The rotation must be durably persisted, not just returned.
    const rotatedChallengeId = h.getState().preAuth?.providerChallengeId;
    expect(rotatedChallengeId).toBeTruthy();
    expect(rotatedChallengeId).not.toBe(originalChallengeId);

    const result = await h.sendText(h.lastIssuedOtpCode());
    expect(result.workerId).toBeTruthy();
    expect(result.stepKey).toBe('legal.review');
  });

  it('expires 5 minutes after issuance', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110051' });
    await h.sendText('START');
    h.advanceTime(5 * 60 * 1000 + 1);
    const result = await h.sendText('123456');
    expect(result.stepKey).toBe('identity.verify_otp');
    expect(result.workerId).toBeNull();
    expect(h.getState().preAuth?.status).toBe('expired');
  });

  it('a resend invalidates the prior code (supersede)', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110052' });
    await h.sendText('START');
    const priorChallengeId = h.getState().preAuth?.providerChallengeId;

    h.advanceTime(61 * 1000); // past the 60s resend cooldown
    await h.sendText('RESEND');
    const newChallengeId = h.getState().preAuth?.providerChallengeId;
    expect(newChallengeId).not.toBe(priorChallengeId);

    // The OLD challenge's code no longer verifies — the router only ever
    // checks the CURRENT providerChallengeId, so a stale code (unknown to
    // the new challenge) is rejected as invalid.
    const result = await h.sendText('999999');
    expect(result.stepKey).toBe('identity.verify_otp');
    expect(result.workerId).toBeNull();
  });

  it('treats the otp:resend button as a resend without consuming a verification attempt', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110059' });
    await h.sendText('START');
    const priorChallengeId = h.getState().preAuth?.providerChallengeId;
    const priorAttempts = h.getState().preAuth?.attempts;

    h.advanceTime(61 * 1000);
    await h.pressButton('otp:resend', { body: 'Resend' });
    const resentChallengeId = h.getState().preAuth?.providerChallengeId;
    expect(resentChallengeId).not.toBe(priorChallengeId);
    expect(h.getState().preAuth?.attempts).toBe(priorAttempts);

    await h.pressButton('otp:resend', { body: 'Resend' });
    expect(h.getState().preAuth?.providerChallengeId).toBe(resentChallengeId);
    expect(h.getState().preAuth?.attempts).toBe(priorAttempts);
  });

  it('enforces a 60-second resend cooldown', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110053' });
    // The initial START-triggered challenge is recorded in `otpSendHistory`
    // (send #1 of the hourly cap), but this test stays under the 3/hour cap
    // and only exercises the 60-second cooldown between successive resends.
    await h.sendText('START');
    h.advanceTime(61 * 1000);
    await h.sendText('RESEND'); // resend #1 — past the 60s cooldown, still under cap
    const firstResendId = h.getState().preAuth?.providerChallengeId;

    await h.sendText('RESEND'); // resend #2, immediate — under 60s, blocked
    expect(h.getState().preAuth?.providerChallengeId).toBe(firstResendId);

    h.advanceTime(61 * 1000);
    await h.sendText('RESEND'); // now past 60s — allowed
    expect(h.getState().preAuth?.providerChallengeId).not.toBe(firstResendId);
  });

  it('caps OTP sends at 3 total per hour — the initial challenge counts', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110054' });
    // The initial START-triggered challenge IS the first of the three hourly
    // sends: it is recorded in `otpSendHistory`, so only two further RESENDs
    // are allowed before the cap bites.
    await h.sendText('START'); // send #1 of 3 (initial challenge)

    h.advanceTime(61 * 1000);
    await h.sendText('RESEND'); // send #2 of 3
    h.advanceTime(61 * 1000);
    await h.sendText('RESEND'); // send #3 of 3
    const idAfterThird = h.getState().preAuth?.providerChallengeId;

    h.advanceTime(61 * 1000);
    await h.sendText('RESEND'); // send #4 — blocked, cap reached
    expect(h.getState().preAuth?.providerChallengeId).toBe(idAfterThird);
  });

  it('three wrong attempts lock for 15 minutes, then recovers after the lock expires', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110055' });
    await h.sendText('START');

    await h.sendText('111111');
    await h.sendText('222222');
    const lockedResult = await h.sendText('333333');
    expect(lockedResult.stepKey).toBe('identity.verify_otp');
    expect(h.getState().preAuth?.status).toBe('locked');

    // Still locked immediately after — even the correct code is rejected
    // (the fake identity adapter checks lockedUntil before the code itself).
    const correctCode = h.lastIssuedOtpCode();
    const stillLocked = await h.sendText(correctCode);
    expect(stillLocked.workerId).toBeNull();
    expect(stillLocked.stepKey).toBe('identity.verify_otp');

    h.advanceTime(15 * 60 * 1000 + 1);
    // Recovery: the lock (15 min) has expired, but so has the original
    // 5-minute OTP challenge by now — the worker must request a fresh code.
    // RESEND is unaffected by a lapsed lock (only wrong-CODE attempts were
    // gated), so this is allowed and clears the lock/attempt bookkeeping.
    await h.sendText('RESEND');
    expect(h.getState().preAuth?.status).toBe('pending');
    expect(h.getState().preAuth?.lockedUntil).toBeNull();

    const freshCode = h.lastIssuedOtpCode();
    expect(freshCode).not.toBe(correctCode);
    const result = await h.sendText(freshCode);
    expect(result.stepKey).toBe('legal.review');
    expect(result.workerId).toBeTruthy();
  });
});

describe('an existing-phone candidate cannot bind before OTP', () => {
  it('a phone matching an existing account still requires OTP verification before any bound step is reachable', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110060' });
    h.seedExistingWorker('existing-worker-1');

    // Even though the conversation's user_id is already linked to an
    // account (web-signup style candidate), there is no active workflow
    // run yet — a bound-step command like ACCEPT must NOT bind or advance.
    const result = await h.sendText('ACCEPT');
    expect(result.workerId).toBeNull();
    expect(h.getState().gate).toBeNull();

    await h.sendText('START');
    const verifyResult = await h.sendText('123456'); // wrong code
    expect(verifyResult.workerId).toBeNull();
    expect(h.getState().gate).toBeNull();
  });
});

describe("Manuel's exact sequence", () => {
  it('an unbound awaiting_otp worker sending Accept never reaches legal, never records consent, and the legal prompt is presented exactly once total', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110070' });

    await h.sendText('START'); // -> identity.verify_otp, unbound
    expect(h.getState().gate).toBeNull();

    // "Accept" arrives while still unbound and awaiting the OTP code — this
    // is consumed as a (wrong) OTP code, not a legal decision.
    const acceptResult = await h.sendText('Accept');
    expect(acceptResult.workerId).toBeNull();
    expect(acceptResult.stepKey).toBe('identity.verify_otp');
    expect(h.getLegalConsents()).toHaveLength(0);
    expect(h.getLegalPromptPresentations()).toHaveLength(0);

    // Now verify for real, with the correct code (one wrong attempt so far
    // — still well under the 3-strike lock).
    await h.sendText(h.lastIssuedOtpCode());
    expect(h.getState().gate?.currentStepKey).toBe('legal.review');
    expect(h.getLegalPromptPresentations()).toHaveLength(1);
    expect(h.getLegalConsents()).toHaveLength(0);

    await h.sendText('ACCEPT');
    expect(h.getLegalConsents()).toHaveLength(1);
    // Still exactly one legal.review PRESENTATION across the whole
    // conversation (accepting doesn't re-present it).
    expect(h.getLegalPromptPresentations()).toHaveLength(1);
  });
});

describe('legal.review', () => {
  it('Accept advances to profile.name and records exactly one consent', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110080' });
    await h.driveToStep('legal.review');
    await h.sendText('ACCEPT');
    expect(h.getState().gate?.currentStepKey).toBe('profile.name');
    expect(h.getLegalConsents()).toHaveLength(1);
    expect(h.getCanonicalLegalConsents()).toEqual([{
      workerId: h.getState().workerId,
      documentVersion: '1.0',
    }]);
  });

  it('Decline stays on legal.review with status declined and records no consent', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110081' });
    await h.driveToStep('legal.review');
    await h.sendText('DECLINE');
    expect(h.getState().gate?.currentStepKey).toBe('legal.review');
    expect(h.getState().gate?.status).toBe('declined');
    expect(h.getLegalConsents()).toHaveLength(0);
  });

  it('REVIEW TERMS reactivates the same declined legal run without restarting OTP', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110083' });
    await h.driveToStep('legal.review', { lang: 'en' });
    const before = h.getState();

    await h.sendText('DECLINE');
    expect(h.getState().gate?.status).toBe('declined');

    await h.sendText('REVIEW TERMS');
    const recovered = h.getState();
    expect(recovered.gate?.status).toBe('active');
    expect(recovered.gate?.runId).toBe(before.gate?.runId);
    expect(recovered.gate?.currentStepKey).toBe('legal.review');
    expect(recovered.gate?.preferredLanguage).toBe('en');
    expect(recovered.preAuth?.challengeId).toBe(before.preAuth?.challengeId);
    expect(h.getLegalConsents()).toHaveLength(0);
    expect(h.getLegalPromptPresentations().length).toBeGreaterThanOrEqual(2);
  });

  it('Review Terms re-presents the prompt, stays on the step, and records no consent', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110082' });
    await h.driveToStep('legal.review');
    await h.sendText('REVIEW TERMS');
    expect(h.getState().gate?.currentStepKey).toBe('legal.review');
    expect(h.getLegalConsents()).toHaveLength(0);
    expect(h.getLegalPromptPresentations().length).toBeGreaterThanOrEqual(2); // initial bind + review resend
  });
});

describe('profile.name validation', () => {
  it('accepts a valid name and advances', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110090' });
    await h.driveToStep('legal.review');
    await h.sendText('ACCEPT');
    await h.sendText('Jo');
    expect(h.getState().gate?.currentStepKey).toBe('profile.location');
    expect(h.getWorkerProfile()?.name).toBe('Jo');
  });

  it('rejects a too-short name and reprompts without persisting', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110091' });
    await h.driveToStep('legal.review');
    await h.sendText('ACCEPT');
    await h.sendText('J');
    expect(h.getState().gate?.currentStepKey).toBe('profile.name');
    expect(h.getWorkerProfile()?.name).toBeUndefined();
  });
});

describe('profile.location: ZIP and City, State paths', () => {
  it('a ZIP resolves with source:zip', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110100' });
    await h.driveToStep('legal.review');
    await h.sendText('ACCEPT');
    await h.sendText('Jose Martinez');
    await h.sendText('78701');
    expect(h.getState().gate?.currentStepKey).toBe('profile.trade');
    expect(h.getWorkerProfile()?.location?.source).toBe('zip');
  });

  it('a "City, ST" body resolves with source:city_state', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110101' });
    await h.driveToStep('legal.review');
    await h.sendText('ACCEPT');
    await h.sendText('Jose Martinez');
    await h.sendText('Austin, TX');
    expect(h.getState().gate?.currentStepKey).toBe('profile.trade');
    expect(h.getWorkerProfile()?.location).toEqual({ city: 'Austin', state: 'TX', postalCode: null, source: 'city_state' });
  });
});

describe('profile.trade: all six choices, custom trade, and the AI-question fallback', () => {
  const standardTrades = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting'];

  it.each(standardTrades)('"%s" attaches the standard question set and reaches trust.question.1', async (trade) => {
    const h = createWhatsAppV2Harness({ phone: `+1555111${trade.length}${trade.charCodeAt(0)}` });
    await h.driveToStep('legal.review');
    await h.sendText('ACCEPT');
    await h.sendText('Jose Martinez');
    await h.sendText('78701');
    await h.sendText(trade);
    await h.sendText('1'); // years_experience -> profile.transportation
    await h.sendText('1'); // has_transportation -> profile.availability
    await h.sendText('1'); // availability -> trust.question.1
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');
    expect(h.getWorkerProfile()?.trade).toBe(trade);
  });

  it('"other" + a custom trade generates questions via the AI generator (success path)', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110110' });
    await h.driveToStep('legal.review');
    await h.sendText('ACCEPT');
    await h.sendText('Jose Martinez');
    await h.sendText('78701');
    await h.sendText('other');
    expect(h.getState().gate?.currentStepKey).toBe('profile.custom_trade');

    await h.sendText('dog groomer');
    await h.sendText('1'); // years_experience -> profile.transportation
    await h.sendText('1'); // has_transportation -> profile.availability
    await h.sendText('1'); // availability -> trust.question.1
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');
    const questions = h.getState().stateContext.v2TrustQuestions as Array<{ en: string; es: string }>;
    expect(questions).toHaveLength(3);
    expect(h.getState().stateContext.v2TrustSource).toBe('generated');
  });

  it('"other" + a custom trade falls back to the reviewed bilingual set when the AI generator fails', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110111' });
    await h.driveToStep('legal.review');
    await h.sendText('ACCEPT');
    await h.sendText('Jose Martinez');
    await h.sendText('78701');
    await h.sendText('other');

    h.failAdapter('trustQuestions');
    await h.sendText('dog groomer');
    await h.sendText('1'); // years_experience -> profile.transportation
    await h.sendText('1'); // has_transportation -> profile.availability
    await h.sendText('1'); // availability -> trust.question.1

    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');
    expect(h.getState().stateContext.v2TrustSource).toBe('fallback');
    const questions = h.getState().stateContext.v2TrustQuestions as Array<{ en: string; es: string }>;
    expect(questions).toHaveLength(3);
    for (const q of questions) expect(q.en).not.toBe(q.es);

    // The failure never fails the run — onboarding still completes.
    await h.sendText('5 years, mostly labradors');
    await h.sendText('good tools');
    await h.sendText('friendly dogs');
    expect(h.getCompletions()).toHaveLength(1);
  });
});

describe('business messages injected at every onboarding step defer, never a worker-directed send', () => {
  const steps = [
    'start.choose_language',
    'identity.verify_otp',
    'legal.review',
    'profile.name',
    'profile.location',
    'profile.trade',
    'profile.custom_trade',
    'trust.question.1',
    'trust.question.2',
    'trust.question.3',
  ] as const;

  it.each(steps)('at %s, an employer-chat message defers (worker_onboarding) with zero worker-directed sends', async (step) => {
    const h = createWhatsAppV2Harness({ phone: `+155511102${steps.indexOf(step)}` });
    // Drive to just before the target so a bound worker id exists for
    // every step except the two pre-auth ones.
    if (step === 'start.choose_language') {
      // No worker yet — inject against a manually-bound placeholder id to
      // exercise the SAME real evaluateDelivery path (gate === null ->
      // lifecycle 'onboarding' is the fallback the gateway itself applies).
      const decision = await h.injectEmployerMessage({ workerId: 'not-yet-a-worker' });
      expect(decision).toEqual({ action: 'defer', reason: 'worker_onboarding' });
      expect(h.getSentMessages().filter((m) => m.phase === 'bound')).toHaveLength(0);
      return;
    }

    if (step === 'identity.verify_otp') {
      await h.sendText('START');
      const decision = await h.injectEmployerMessage({ workerId: 'not-yet-a-worker' });
      expect(decision).toEqual({ action: 'defer', reason: 'worker_onboarding' });
      expect(h.getSentMessages().filter((m) => m.phase === 'bound')).toHaveLength(0);
      return;
    }

    if (step === 'profile.custom_trade') {
      await h.driveToStep('profile.custom_trade', { trade: 'other' });
    } else {
      await h.driveToStep(step, { trade: 'electrician' });
    }

    const sentBefore = h.getSentMessages().filter((m) => m.phase === 'bound').length;
    const decision = await h.injectEmployerMessage();
    expect(decision).toEqual({ action: 'defer', reason: 'worker_onboarding' });
    const sentAfter = h.getSentMessages().filter((m) => m.phase === 'bound').length;
    expect(sentAfter).toBe(sentBefore); // zero NEW worker-directed sends

    const jobAlertDecision = await h.injectJobAlert();
    expect(jobAlertDecision).toEqual({ action: 'defer', reason: 'worker_onboarding' });
  });
});

describe('atomic readiness', () => {
  it('completes with zero assessment results (scoring is a separate async lane, never computed inline)', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110200' });
    await h.driveToStep('trust.question.1', { trade: 'concrete' });
    await h.sendText('1');
    await h.sendText('1');
    await h.sendText('1');

    expect(h.getCompletions()).toHaveLength(1);
    expect(h.getCompletions()[0].assessmentProvenance).toMatchObject({ trade: 'concrete', source: 'standard' });
    // No score is ever computed here — trust-scorer is a separate lane.
    expect(h.getCompletions()[0].assessmentProvenance).not.toHaveProperty('score');
  });

  it('reaches readiness even when the question generator fails (custom trade, fallback questions)', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110201' });
    await h.driveToStep('profile.custom_trade');
    h.failAdapter('trustQuestions');
    await h.sendText('dog groomer');
    expect(h.getState().stateContext.v2TrustSource).toBe('fallback');
    await h.sendText('1'); // years_experience -> profile.transportation
    await h.sendText('1'); // has_transportation -> profile.availability
    await h.sendText('1'); // availability -> trust.question.1

    await h.sendText('answer one');
    await h.sendText('answer two');
    await h.sendText('answer three');

    expect(h.getCompletions()).toHaveLength(1);
    expect(h.getState().gate?.status).toBe('completed');
  });
});

describe('idempotency: duplicate MessageSid and double button taps', () => {
  it('a duplicate MessageSid for the legal Accept produces exactly one transition and one consent', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110210' });
    await h.driveToStep('legal.review');

    const transitionsBefore = h.getTransitions().length;
    await h.pressButton('legal:accept', { messageSid: 'sid-dup-1' });
    const transitionsAfterFirst = h.getTransitions().length;
    expect(transitionsAfterFirst).toBeGreaterThan(transitionsBefore);
    expect(h.getLegalConsents()).toHaveLength(1);

    // Exact same MessageSid replayed (Twilio/SQS at-least-once delivery) —
    // the harness's processed-SID cache mirrors whatsapp_processed_messages
    // and must not re-invoke the router at all.
    await h.pressButton('legal:accept', { messageSid: 'sid-dup-1' });
    expect(h.getTransitions()).toHaveLength(transitionsAfterFirst);
    expect(h.getLegalConsents()).toHaveLength(1);
  });

  it('a double button tap (two different MessageSids, same payload) produces exactly one transition and one consent', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110211' });
    await h.driveToStep('legal.review');

    await h.pressButton('legal:accept', { messageSid: 'sid-tap-1' });
    expect(h.getState().gate?.currentStepKey).toBe('profile.name');
    expect(h.getLegalConsents()).toHaveLength(1);
    const transitionsAfterFirst = h.getTransitions().length;

    // A second, DIFFERENT SID with the identical interactive payload — the
    // step already advanced to profile.name, so this reaches the name
    // handler with an empty body (real button taps carry no free text) and
    // is a no-op reprompt, not a second legal transition.
    await h.pressButton('legal:accept', { messageSid: 'sid-tap-2' });
    expect(h.getTransitions()).toHaveLength(transitionsAfterFirst);
    expect(h.getLegalConsents()).toHaveLength(1);
    expect(h.getState().gate?.currentStepKey).toBe('profile.name');
  });

  it('a double tap of the FINAL trust answer does not complete onboarding twice', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110212' });
    await h.driveToStep('trust.question.3', { trade: 'painting' });

    await h.pressButton('trust:1', { messageSid: 'sid-final-1' });
    expect(h.getCompletions()).toHaveLength(1);

    await h.pressButton('trust:1', { messageSid: 'sid-final-2' });
    expect(h.getCompletions()).toHaveLength(1); // gate.status === 'completed' short-circuits
  });
});

describe('createReleaseRenderer(): all five release kinds', () => {
  it('renders onboarding_complete', async () => {
    const renderer = createReleaseRenderer();
    const msg = await renderer.render({ kind: 'onboarding_complete', workerId: 'w1', language: 'en' });
    expect(msg.body).toBeTruthy();
    expect(msg.contentTemplate).toBeNull();
  });

  it('renders account_notice', async () => {
    const renderer = createReleaseRenderer();
    const msg = await renderer.render({
      kind: 'account_notice', workerId: 'w1', language: 'es', sourceType: 'password_reset', sourceId: 'src-1',
    });
    expect(msg.body).toContain('password_reset');
  });

  it('renders job_alert_digest', async () => {
    const renderer = createReleaseRenderer();
    const msg = await renderer.render({
      kind: 'job_alert_digest',
      workerId: 'w1',
      language: 'en',
      jobs: [{ jobId: 'j1', title: 'Electrician', companyName: 'Acme', score: 90 }],
    });
    expect(msg.body).toContain('Electrician');
    expect(msg.body).toContain('Acme');
  });

  it('renders employer_chat_single', async () => {
    const renderer = createReleaseRenderer();
    const msg = await renderer.render({
      kind: 'employer_chat_single', workerId: 'w1', language: 'en',
      conversationId: 'conv-1', companyName: 'Acme', jobTitle: 'Electrician',
    });
    expect(msg.body).toContain('Acme');
    expect(msg.body).toContain('Electrician');
  });

  it('renders employer_chat_summary — the multi-employer View Chats summary', async () => {
    const renderer = createReleaseRenderer();
    const msg = await renderer.render({
      kind: 'employer_chat_summary', workerId: 'w1', language: 'en', conversationCount: 3,
    });
    expect(msg.body).toContain('3');
    expect(msg.body?.toUpperCase()).toContain('CHATS');
  });
});

describe('harness plumbing sanity', () => {
  it('routes through the SAME client marker every call site sees', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110300' });
    await h.driveToStep('trust.question.1');
    await h.sendText('1');
    await h.sendText('1');
    await h.sendText('1');
    for (const c of h.getCompletionClients()) {
      expect(c).toBe(HARNESS_CLIENT);
    }
  });
});

// ── Stream B (Task 8e): full voice profile intake, end to end ───────────

describe('Stream B: full voice profile intake end to end', () => {
  it('control ON: legal accept -> voice_choice -> audio -> ack -> completion applies partial fields -> resolver asks ONLY location, then transportation, availability -> trust handoff', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110500' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('legal.review', { lang: 'en' });

    await h.sendText('ACCEPT');
    expect(h.getState().gate?.currentStepKey).toBe('profile.voice_choice');

    const ackResult = await h.sendVoiceNote();
    expect(ackResult.stepKey).toBe('profile.voice_processing');
    expect(h.getPendingProfileIngests()).toHaveLength(1);

    const completion = await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: { full_name: 'Jose Martinez', main_trade: 'plumber', years_experience: '5-9' },
      confidences: { full_name: 0.9, main_trade: 0.9, years_experience: 0.9 },
      summaryEn: 'Jose, a plumber with 5-9 years of experience.',
      summaryEs: 'Jose, un plomero con 5-9 anos de experiencia.',
    });

    // city/location was never extracted — the resolver asks for it next
    // (PROFILE_FIELDS order: name, city, trade, [custom_trade], experience,
    // transportation, availability — name/trade/experience already landed).
    expect(completion.stepKey).toBe('profile.location');
    expect(h.getWorkerProfile()).toMatchObject({ name: 'Jose Martinez', trade: 'plumber', yearsExperience: '5-9' });

    await h.sendText('Austin, TX');
    expect(h.getState().gate?.currentStepKey).toBe('profile.transportation');

    await h.sendText('1'); // has_transportation
    expect(h.getState().gate?.currentStepKey).toBe('profile.availability');

    await h.sendText('1'); // availability -> trust handoff
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');

    await h.sendText('1');
    await h.sendText('1');
    await h.sendText('1');
    expect(h.getCompletions()).toHaveLength(1);
    expect(h.getState().gate?.status).toBe('completed');
  });

  it('control OFF: legal accept -> profile.name -> ... is byte-identical to the pre-Stream-B flow', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110501' });
    // voiceIntake left disabled (harness default).
    await h.driveToStep('legal.review', { lang: 'en' });

    await h.sendText('ACCEPT');
    expect(h.getState().gate?.currentStepKey).toBe('profile.name');

    await h.sendText('Jose Martinez');
    await h.sendText('78701');
    await h.sendText('plumber');
    await h.sendText('1');
    await h.sendText('1');
    await h.sendText('1');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');

    await h.sendText('1');
    await h.sendText('1');
    await h.sendText('1');
    expect(h.getCompletions()).toHaveLength(1);
    expect(h.getState().gate?.status).toBe('completed');
  });

  it('opt-out to text: tapping "type instead" at voice_choice walks the ordinary field-by-field flow', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110502' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('legal.review', { lang: 'en' });
    await h.sendText('ACCEPT');
    expect(h.getState().gate?.currentStepKey).toBe('profile.voice_choice');

    await h.pressButton('media:voice:text');
    expect(h.getState().gate?.currentStepKey).toBe('profile.name');

    await h.sendText('Jose Martinez');
    await h.sendText('78701');
    await h.sendText('plumber');
    await h.sendText('1');
    await h.sendText('1');
    await h.sendText('1');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');
    expect(h.getPendingProfileIngests()).toHaveLength(0);
  });

  it('timeout escape: the pipeline never completes -> voice_processing times out -> the text flow takes over and still reaches ready', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110503' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('legal.review', { lang: 'en' });
    await h.sendText('ACCEPT');
    await h.sendVoiceNote();
    expect(h.getState().gate?.currentStepKey).toBe('profile.voice_processing');

    h.advanceTime(6 * 60 * 1000); // > VOICE_PROCESSING_TIMEOUT_MS
    await h.sendText('hello?');
    expect(h.getState().gate?.currentStepKey).toBe('profile.name'); // fell back, nothing landed

    await h.sendText('Jose Martinez');
    await h.sendText('78701');
    await h.sendText('plumber');
    await h.sendText('1');
    await h.sendText('1');
    await h.sendText('1');
    await h.sendText('1');
    await h.sendText('1');
    await h.sendText('1');
    expect(h.getCompletions()).toHaveLength(1);
    expect(h.getState().gate?.status).toBe('completed');

    // The pipeline's completion event, if it EVER arrives after this, must
    // be a silent no-op. The worker is already 'ready' by this point, so it
    // never even reaches the staleness check — routeOnboardingV2's ready
    // short-circuit fires first, which is equally harmless (no send, no
    // state change).
    const sentBefore = h.getSentMessages().length;
    const late = await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: { full_name: 'Someone Else' },
      confidences: { full_name: 0.9 },
    });
    expect(h.getSentMessages()).toHaveLength(sentBefore);
    expect(late.handled).toBe(false);
    expect(h.getWorkerProfile()).not.toMatchObject({ name: 'Someone Else' });
  });
});

describe('Stream B: command gate at voice steps', () => {
  it('a Spanish worker typing TRABAJOS at profile.voice_choice gets the blocked reply and does not start ingestion', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110510' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('legal.review', { lang: 'es' });
    await h.sendText('ACEPTAR');
    expect(h.getState().gate?.currentStepKey).toBe('profile.voice_choice');

    await h.sendText('TRABAJOS');

    expect(h.getState().gate?.currentStepKey).toBe('profile.voice_choice'); // gate blocked it, no advance
    expect(h.getPendingProfileIngests()).toHaveLength(0);
    const blockedReply = h.getSentMessages().at(-1);
    expect(blockedReply?.lang).toBe('es');
  });

  it('IDIOMA/LANGUAGE persists across profile.voice_choice and profile.voice_processing prompts', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15551110511' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('legal.review', { lang: 'en' });
    await h.sendText('ACCEPT');
    expect(h.getState().gate?.currentStepKey).toBe('profile.voice_choice');

    await h.sendText('IDIOMA');
    expect(h.getState().stateContext.v2PreferredLanguageOverride).toBe('es');
    expect(h.getSentMessages().at(-1)?.lang).toBe('es');

    // The override survives into profile.voice_processing's prompts too.
    await h.sendVoiceNote();
    const processingAck = h.getSentMessages().at(-1);
    expect(processingAck?.lang).toBe('es');

    await h.sendText('todavia?');
    expect(h.getSentMessages().at(-1)?.lang).toBe('es');
  });
});
