/**
 * Task 7: voice notes at trust-question steps, end to end through the real
 * `routeOnboardingV2` router via `createWhatsAppV2Harness()`
 * (`../../../helpers/whatsapp-v2-harness`). `completeTranscription` round-
 * trips a REAL `VoiceEventV2` through `buildSyntheticVoiceInboundBody` ->
 * `parseVoiceTranscriptEvent` — the exact functions the real receiver
 * Lambda and processor use — so these tests exercise the actual envelope,
 * not a hand-rolled shortcut.
 */

import { createWhatsAppV2Harness } from '../../../helpers/whatsapp-v2-harness';

function findSend(h: ReturnType<typeof createWhatsAppV2Harness>, sourceKey: string) {
  return h.getSentMessages().find((m) => m.sourceType === `onboarding_v2:${sourceKey}`);
}

describe('WhatsApp v2 voice — trust-question voice notes', () => {
  it('a voice note acks and starts transcription without advancing the step', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220001' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('trust.question.1');

    const result = await h.sendVoiceNote();

    expect(result.stepKey).toBe('trust.question.1');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');
    expect(h.getPendingTranscriptions()).toHaveLength(1);
    expect(h.getPendingTranscriptions()[0]).toMatchObject({
      stepKey: 'trust.question.1',
      questionIndex: 0,
    });
    expect(findSend(h, 'v2_voice_ack')).toBeDefined();
    expect(h.getWorkerProfile()?.trustAnswers ?? []).toHaveLength(0);
  });

  it('a completed transcript is saved as the trust answer (source "voice") and the run advances', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220002' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('trust.question.1');
    await h.sendVoiceNote();

    const result = await h.completeTranscription(0, {
      status: 'COMPLETED',
      transcript: 'I have five years of experience',
    });

    expect(result.stepKey).toBe('trust.question.2');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.2');
    expect(h.getWorkerProfile()?.trustAnswers[0]).toMatchObject({
      questionIndex: 0,
      answerText: 'I have five years of experience',
      answerSource: 'voice',
    });
  });

  it('the third voice answer completes onboarding exactly once', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220003' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('trust.question.1');

    await h.sendVoiceNote();
    await h.completeTranscription(0, { status: 'COMPLETED', transcript: 'answer one' });
    await h.sendVoiceNote();
    await h.completeTranscription(1, { status: 'COMPLETED', transcript: 'answer two' });
    await h.sendVoiceNote();
    await h.completeTranscription(2, { status: 'COMPLETED', transcript: 'answer three' });

    expect(h.getCompletions()).toHaveLength(1);
    expect(h.getState().gate?.status).toBe('completed');
    expect(h.getWorkerProfile()?.trustAnswers).toHaveLength(3);
  });

  it('a FAILED transcription falls back to a reprompt without recording an answer', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220004' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('trust.question.1');
    await h.sendVoiceNote();

    const result = await h.completeTranscription(0, { status: 'FAILED' });

    expect(result.stepKey).toBe('trust.question.1');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');
    expect(h.getWorkerProfile()?.trustAnswers ?? []).toHaveLength(0);

    // ONE combined message: the error notice FIRST, the re-asked question
    // underneath. Two separate intents carry no handset-order guarantee —
    // live testing (2026-07-27) showed the question landing before the
    // error, reading as a non-sequitur.
    const combined = findSend(h, 'v2_voice_failed_with_prompt');
    expect(combined).toBeDefined();
    const body = (combined?.body ?? combined?.fallbackBody ?? '') as string;
    const errorIdx = body.indexOf('could not process');
    const questionIdx = body.indexOf('?');
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(questionIdx).toBeGreaterThan(errorIdx);
    // And no separate bare error or bare reprompt rode along with it.
    expect(findSend(h, 'v2_voice_failed')).toBeUndefined();
  });

  it('an empty (whitespace-only) transcript is treated the same as a failure', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220005' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('trust.question.1');
    await h.sendVoiceNote();

    await h.completeTranscription(0, { status: 'COMPLETED', transcript: '   ' });

    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');
    expect(h.getWorkerProfile()?.trustAnswers ?? []).toHaveLength(0);
    expect(findSend(h, 'v2_voice_failed_with_prompt')).toBeDefined();
    expect(findSend(h, 'v2_voice_failed')).toBeUndefined();
  });

  it('a stale transcript (typed answer won the race first) is silently discarded', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220006' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('trust.question.1');
    await h.sendVoiceNote();

    // The typed answer arrives and wins the race before the transcript
    // comes back.
    await h.sendText('1');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.2');

    const sentBefore = h.getSentMessages().length;
    const result = await h.completeTranscription(0, {
      status: 'COMPLETED',
      transcript: 'this answer lost the race',
    });

    // Silent discard: no reply, no step change, no second answer recorded
    // for question 1.
    expect(h.getSentMessages()).toHaveLength(sentBefore);
    expect(result.stepKey).toBe('trust.question.2');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.2');
    expect(h.getWorkerProfile()?.trustAnswers).toHaveLength(1);
    expect(h.getWorkerProfile()?.trustAnswers[0].answerSource).toBe('text');
  });

  it('a duplicate completion delivery (same synthetic sid) is a no-op', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220007' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('trust.question.1');
    await h.sendVoiceNote();
    await h.completeTranscription(0, { status: 'COMPLETED', transcript: 'answer one' });
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.2');

    const sentBefore = h.getSentMessages().length;
    await h.completeTranscription(0, { status: 'COMPLETED', transcript: 'answer one' });

    expect(h.getSentMessages()).toHaveLength(sentBefore);
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.2');
    expect(h.getWorkerProfile()?.trustAnswers).toHaveLength(1);
  });

  it('control OFF: a voice note at a trust question gets the honest not-supported reply and starts no pipeline', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220008' });
    // voiceIntake left disabled (harness default, fail-closed).
    await h.driveToStep('trust.question.1');

    const result = await h.sendVoiceNote();

    expect(result.stepKey).toBe('trust.question.1');
    expect(h.getPendingTranscriptions()).toHaveLength(0);
    expect(findSend(h, 'v2_voice_not_supported')).toBeDefined();
  });

  it('a voice note at profile.name gets the honest not-supported reply', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220009' });
    h.setVoiceIntakeEnabled(true); // control ON, but profile.name has no voice handler
    await h.driveToStep('profile.name');

    await h.sendVoiceNote();

    expect(h.getState().gate?.currentStepKey).toBe('profile.name');
    expect(h.getPendingTranscriptions()).toHaveLength(0);
    expect(findSend(h, 'v2_voice_not_supported')).toBeDefined();
  });

  it('a voice note at pre-auth OTP gets the honest not-supported reply over the pre-auth gateway', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220010' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('identity.verify_otp');

    await h.sendVoiceNote();

    expect(h.getState().preAuth?.currentStepKey).toBe('identity.verify_otp');
    const preAuthTexts = h.getSentMessages().filter((m) => m.phase === 'pre_auth_text');
    expect(preAuthTexts).toHaveLength(1);
    expect(preAuthTexts[0].body).toMatch(/not available/i);
  });

  it('non-audio media at a trust question gets the invalid-type reply instead of starting transcription', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220011' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('trust.question.1');

    await h.sendVoiceNote({ mediaContentType: 'image/jpeg' });

    expect(h.getPendingTranscriptions()).toHaveLength(0);
    expect(findSend(h, 'v2_voice_invalid_type_with_prompt')).toBeDefined();
  });

  it.each(['AYUDA', 'JOBS'])(
    'a transcript reading "%s" is saved verbatim as the trust answer, never blocked by the command gate',
    async (transcript) => {
      const h = createWhatsAppV2Harness({ phone: `+1555222${transcript.length}099` });
      h.setVoiceIntakeEnabled(true);
      await h.driveToStep('trust.question.1');
      await h.sendVoiceNote();

      await h.completeTranscription(0, { status: 'COMPLETED', transcript });

      expect(h.getState().gate?.currentStepKey).toBe('trust.question.2');
      expect(h.getWorkerProfile()?.trustAnswers[0]).toMatchObject({
        answerText: transcript,
        answerSource: 'voice',
      });
    },
  );

  // Task 7/B5: an expired/unreachable Twilio media URL must produce the
  // graceful v2_voice_failed reprompt, never throw and never poison the
  // claim transaction.
  it('an expired media URL produces the v2_voice_failed reprompt, no throw', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220012' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('trust.question.1');
    h.failTrustTranscription('download_failed');

    const result = await h.sendVoiceNote();

    expect(result.stepKey).toBe('trust.question.1');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');
    expect(h.getPendingTranscriptions()).toHaveLength(0);
    expect(findSend(h, 'v2_voice_failed_with_prompt')).toBeDefined();
    expect(h.getWorkerProfile()?.trustAnswers ?? []).toHaveLength(0);

    // Recovers cleanly on the next attempt.
    h.recoverTrustTranscription();
    await h.sendVoiceNote();
    expect(h.getPendingTranscriptions()).toHaveLength(1);
  });

  // Task 5/B3: BACK revisits the same run/step, so runId/stepKey alone
  // cannot distinguish "this visit's transcript" from a late one belonging
  // to a visit the worker has already left. The execution-ARN anchor must.
  it('a late transcript from a visit the worker has already BACKed away from is discarded (stale ARN); the current visit still applies', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220013' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('trust.question.2');

    // First visit to trust.question.1 (via BACK): start a voice note but
    // never let its transcript arrive yet.
    await h.sendText('ATRAS');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');
    await h.sendVoiceNote();
    expect(h.getPendingTranscriptions()).toHaveLength(1);

    // The worker changes their mind and types an answer instead, advancing
    // past question 1 again.
    await h.sendText('1');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.2');

    // BACK again, to the SAME step/run, and record a NEW voice note there —
    // a distinct execution ARN from the first (stale) one.
    await h.sendText('ATRAS');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');
    await h.sendVoiceNote();
    expect(h.getPendingTranscriptions()).toHaveLength(2);

    // The FIRST (stale) visit's transcript now arrives late.
    const sentBefore = h.getSentMessages().length;
    const staleResult = await h.completeTranscription(0, {
      status: 'COMPLETED',
      transcript: 'stale answer from the first visit',
    });
    expect(h.getSentMessages()).toHaveLength(sentBefore); // silent discard
    expect(staleResult.stepKey).toBe('trust.question.1');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1'); // unmoved

    // The CURRENT (second) visit's transcript still applies normally.
    const currentResult = await h.completeTranscription(1, {
      status: 'COMPLETED',
      transcript: 'the current, correct answer',
    });
    expect(currentResult.stepKey).toBe('trust.question.2');
    // This harness's fake profile store append-only-logs every save (unlike
    // the real adapter's merge-by-question_index, covered separately in
    // onboarding-adapters.test.ts) — the MOST RECENT index-0 entry is what
    // matters here: it must be this voice answer, not the earlier BACKed-
    // away-from ones, and it must never be the stale transcript's text.
    const answers = h.getWorkerProfile()?.trustAnswers ?? [];
    const mostRecentQ0 = [...answers].reverse().find((a) => a.questionIndex === 0);
    expect(mostRecentQ0).toMatchObject({
      answerText: 'the current, correct answer',
      answerSource: 'voice',
    });
    expect(answers.some((a) => a.answerText === 'stale answer from the first visit')).toBe(false);
  });
});

/**
 * Stream B (Tasks 8a-8e): full voice profile intake at
 * profile.voice_choice/profile.voice_processing. Drives through
 * legal.review's Accept -> profile.voice_choice (voice control ON, at least
 * one profile field missing) via the real `advanceLegalAcceptToProfileEntry`
 * / `handleVoiceChoiceStep` / `handleVoiceProcessingStep` /
 * `handleVoiceIntakeResult` path.
 */
describe('WhatsApp v2 voice — full voice profile intake (profile.voice_choice/voice_processing)', () => {
  async function toVoiceChoice(phone: string, lang: 'en' | 'es' = 'en') {
    const h = createWhatsAppV2Harness({ phone });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('legal.review', { lang });
    await h.sendText(lang === 'en' ? 'ACCEPT' : 'ACEPTAR');
    return h;
  }

  it('legal accept with voice ON and a missing profile lands on profile.voice_choice, not profile.name', async () => {
    const h = await toVoiceChoice('+15552230001');
    expect(h.getState().gate?.currentStepKey).toBe('profile.voice_choice');
    expect(findSend(h, 'profile.voice_choice')).toBeDefined();
  });

  it('control OFF: legal accept behaves exactly like today (straight to profile.name)', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552230002' });
    // voiceIntake left disabled (harness default, fail-closed).
    await h.driveToStep('legal.review', { lang: 'en' });
    await h.sendText('ACCEPT');
    expect(h.getState().gate?.currentStepKey).toBe('profile.name');
  });

  it('a voice note at profile.voice_choice starts ingestion and advances to profile.voice_processing (no field written yet)', async () => {
    const h = await toVoiceChoice('+15552230003');

    const result = await h.sendVoiceNote();

    expect(result.stepKey).toBe('profile.voice_processing');
    expect(h.getState().gate?.currentStepKey).toBe('profile.voice_processing');
    expect(h.getPendingProfileIngests()).toHaveLength(1);
    expect(h.getState().stateContext.v2VoiceExecutionArn).toBe(h.getPendingProfileIngests()[0].executionArn);
    expect(findSend(h, 'v2_voice_processing_ack')).toBeDefined();
    expect(h.getWorkerProfile()).toBeNull();
  });

  it('the media:voice:text tap opts into the text flow (v1 parity)', async () => {
    const h = await toVoiceChoice('+15552230004');

    const result = await h.pressButton('media:voice:text');

    expect(result.stepKey).toBe('profile.name');
    expect(h.getPendingProfileIngests()).toHaveLength(0);
  });

  it('typing "voice" (or "1"/"voz"/"audio") stays on voice_choice with a cooldown-guarded nudge', async () => {
    const h = await toVoiceChoice('+15552230005');

    const result = await h.sendText('voice');
    expect(result.stepKey).toBe('profile.voice_choice');
    expect(findSend(h, 'v2_voice_send_note')).toBeDefined();

    // Cooldown: an immediate second nudge-worthy message does not re-send.
    const sentBefore = h.getSentMessages().length;
    await h.sendText('1');
    expect(h.getSentMessages()).toHaveLength(sentBefore);
  });

  it('any other typed text opts into the text flow (v1 parity)', async () => {
    const h = await toVoiceChoice('+15552230006');

    const result = await h.sendText('I would rather type');

    expect(result.stepKey).toBe('profile.name');
  });

  it('non-voice media at voice_choice reuses v2_voice_invalid_type (no near-duplicate key) and does not start ingestion', async () => {
    const h = await toVoiceChoice('+15552230007');

    await h.sendVoiceNote({ mediaContentType: 'image/jpeg' });

    expect(h.getPendingProfileIngests()).toHaveLength(0);
    // The voice_choice lane keeps the bare template — its prompt is an
    // interactive template, not plain text, so the combined-message helper
    // (trust lane only) does not apply here.
    expect(findSend(h, 'v2_voice_invalid_type')).toBeDefined();
    expect(h.getState().gate?.currentStepKey).toBe('profile.voice_choice');
  });

  it('ingest pipeline_unavailable falls back to the text flow rather than stranding the worker', async () => {
    const h = await toVoiceChoice('+15552230008');
    h.failVoiceIngest('pipeline_unavailable');

    const result = await h.sendVoiceNote();

    expect(findSend(h, 'v2_voice_fallback')).toBeDefined();
    expect(result.stepKey).toBe('profile.name');
    expect(h.getPendingProfileIngests()).toHaveLength(0);
  });

  it('a completed extraction applies the writes, sends the summary, and advances to only the missing fields', async () => {
    const h = await toVoiceChoice('+15552230009');
    await h.sendVoiceNote();

    const result = await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: {
        full_name: 'Jose Martinez',
        city: '78701',
        main_trade: 'plumber',
        years_experience: '5-9',
        has_transportation: true,
        availability: 'full_time',
      },
      confidences: {
        full_name: 0.9, city: 0.9, main_trade: 0.9,
        years_experience: 0.9, has_transportation: 0.9, availability: 0.9,
      },
      summaryEn: 'Jose, a plumber in Austin with 5-9 years of experience.',
      summaryEs: 'Jose, un plomero en Austin con 5-9 anos de experiencia.',
    });

    // All seven fields landed -> resolver reports nothing missing -> trust handoff.
    expect(result.stepKey).toBe('trust.question.1');
    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');
    expect(h.getWorkerProfile()).toMatchObject({
      name: 'Jose Martinez',
      trade: 'plumber',
      yearsExperience: '5-9',
      hasTransportation: true,
      availability: 'full_time',
    });
    expect(findSend(h, 'v2_voice_summary')).toBeDefined();
    expect(h.getSentMessages().find((m) => m.sourceType === 'onboarding_v2:v2_voice_summary')?.body)
      .toContain('Jose, a plumber in Austin');
  });

  it('a completed extraction that only fills SOME fields advances to the resolver-picked next missing field, not straight to trust', async () => {
    const h = await toVoiceChoice('+15552230010');
    await h.sendVoiceNote();

    const result = await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: { full_name: 'Jose Martinez', main_trade: 'plumber' },
      confidences: { full_name: 0.9, main_trade: 0.9 },
      summaryEn: 'Jose, a plumber.',
      summaryEs: 'Jose, un plomero.',
    });

    // city was never extracted -> resolver asks for it next (location comes
    // before experience/transportation/availability in PROFILE_FIELDS order).
    expect(result.stepKey).toBe('profile.location');
    expect(h.getWorkerProfile()).toMatchObject({ name: 'Jose Martinez', trade: 'plumber' });
  });

  it('a landed standard trade seeds its question set from the per-trade cache exactly like the text flow', async () => {
    const h = await toVoiceChoice('+15552230011');
    await h.sendVoiceNote();

    await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: {
        full_name: 'Jose Martinez', city: '78701', main_trade: 'carpenter',
        years_experience: '5-9', has_transportation: true, availability: 'full_time',
      },
      confidences: {
        full_name: 0.9, city: 0.9, main_trade: 0.9,
        years_experience: 0.9, has_transportation: 0.9, availability: 0.9,
      },
      summaryEn: 'summary', summaryEs: 'resumen',
    });

    expect(h.getState().stateContext.v2ProfileTrade).toBe('carpenter');
    // R1-A: standard trades take the SAME generator lane as custom ones.
    expect(h.getState().stateContext.v2TrustSource).toBe('generated');
    expect(h.getState().stateContext.v2QuestionSetVersion).toBe('v2-trust-questions-2');
    expect(h.getState().stateContext.v2TrustQuestions).toHaveLength(3);
    expect(h.getTrustQuestionGenerateCalls()).toContain('carpenter');
  });

  it('a landed standard trade falls back to the reviewed open-text set when the generator fails', async () => {
    const h = await toVoiceChoice('+15552230014');
    h.failAdapter('trustQuestions');
    await h.sendVoiceNote();

    await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: {
        full_name: 'Jose Martinez', city: '78701', main_trade: 'carpenter',
        years_experience: '5-9', has_transportation: true, availability: 'full_time',
      },
      confidences: {
        full_name: 0.9, city: 0.9, main_trade: 0.9,
        years_experience: 0.9, has_transportation: 0.9, availability: 0.9,
      },
      summaryEn: 'summary', summaryEs: 'resumen',
    });

    expect(h.getState().stateContext.v2TrustSource).toBe('fallback');
    expect(h.getState().stateContext.v2TrustQuestions).toHaveLength(3);
  });

  it('a landed custom (\'other\') trade seeds a generated trust-question set atomically, matching handleCustomTrade', async () => {
    const h = await toVoiceChoice('+15552230012');
    await h.sendVoiceNote();

    await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: {
        full_name: 'Jose Martinez', city: '78701', main_trade: 'other', main_trade_other: 'dog groomer',
        years_experience: '5-9', has_transportation: true, availability: 'full_time',
      },
      confidences: {
        full_name: 0.9, city: 0.9, main_trade: 0.9,
        years_experience: 0.9, has_transportation: 0.9, availability: 0.9,
      },
      summaryEn: 'summary', summaryEs: 'resumen',
    });

    expect(h.getWorkerProfile()).toMatchObject({ trade: 'other', tradeOther: 'dog groomer' });
    expect(h.getState().stateContext.v2TrustSource).toBe('generated');
    expect(h.getState().stateContext.v2TrustQuestions).toHaveLength(3);
  });

  it('a custom trade falls back to the reviewed fallback question set when the generator fails, exactly like the text flow', async () => {
    const h = await toVoiceChoice('+15552230013');
    // Force the SAME trust-question generator failure path handleCustomTrade uses.
    h.failAdapter('trustQuestions');
    await h.sendVoiceNote();

    await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: {
        full_name: 'Jose Martinez', city: '78701', main_trade: 'other', main_trade_other: 'dog groomer',
        years_experience: '5-9', has_transportation: true, availability: 'full_time',
      },
      confidences: {
        full_name: 0.9, city: 0.9, main_trade: 0.9,
        years_experience: 0.9, has_transportation: 0.9, availability: 0.9,
      },
      summaryEn: 'summary', summaryEs: 'resumen',
    });

    expect(h.getState().stateContext.v2TrustSource).toBe('fallback');
    expect(h.getState().stateContext.v2TrustQuestions).toHaveLength(3);
  });

  it('a FAILED extraction offers one retry and returns to voice_choice', async () => {
    const h = await toVoiceChoice('+15552230071');
    await h.sendVoiceNote();
    const result = await h.injectVoiceIntakeResult(0, { status: 'FAILED' });
    expect(findSend(h, 'v2_voice_retry_offer')).toBeDefined();
    expect(findSend(h, 'v2_voice_fallback')).toBeUndefined();
    expect(result.stepKey).toBe('profile.voice_choice');
  });

  it('a second FAILED extraction after the retry falls back to the text flow', async () => {
    const h = await toVoiceChoice('+15552230072');
    await h.sendVoiceNote();
    await h.injectVoiceIntakeResult(0, { status: 'FAILED' });
    await h.sendVoiceNote({ messageSid: 'MMretry0000000000000000000000002' });
    const result = await h.injectVoiceIntakeResult(1, { status: 'FAILED' });
    expect(findSend(h, 'v2_voice_fallback')).toBeDefined();
    expect(result.stepKey).toBe('profile.name');
  });

  it('zero-writes extraction also offers the retry once', async () => {
    const h = await toVoiceChoice('+15552230073');
    await h.sendVoiceNote();
    const result = await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: { years_experience: '3 years' }, // invalid enum -> zero writes
      confidences: { years_experience: 0.9 },
      summaryEn: 'summary', summaryEs: 'resumen',
    });
    expect(findSend(h, 'v2_voice_retry_offer')).toBeDefined();
    expect(result.stepKey).toBe('profile.voice_choice');
  });

  it('processing timeout offers the retry once, then falls back on a second timeout', async () => {
    const h = await toVoiceChoice('+15552230074');
    await h.sendVoiceNote();
    h.advanceTime(6 * 60 * 1000);
    const first = await h.sendText('hola?');
    expect(findSend(h, 'v2_voice_retry_offer')).toBeDefined();
    expect(first.stepKey).toBe('profile.voice_choice');
    await h.sendVoiceNote({ messageSid: 'MMretry0000000000000000000000003' });
    h.advanceTime(6 * 60 * 1000);
    const second = await h.sendText('hola??');
    expect(findSend(h, 'v2_voice_fallback')).toBeDefined();
    expect(second.stepKey).toBe('profile.name');
  });

  it('typing anything after the retry offer continues to the text flow', async () => {
    const h = await toVoiceChoice('+15552230075');
    await h.sendVoiceNote();
    await h.injectVoiceIntakeResult(0, { status: 'FAILED' });
    const result = await h.sendText('2');
    expect(result.stepKey).toBe('profile.name');
  });

  it('a COMPLETED result with null fields (extraction threw) offers the retry exactly like FAILED', async () => {
    const h = await toVoiceChoice('+15552230015');
    await h.sendVoiceNote();

    const result = await h.injectVoiceIntakeResult(0, { status: 'COMPLETED', fields: null });

    expect(findSend(h, 'v2_voice_retry_offer')).toBeDefined();
    expect(result.stepKey).toBe('profile.voice_choice');
  });

  it('a stale completion (execution arn mismatch) is silently discarded', async () => {
    const h = await toVoiceChoice('+15552230017');
    await h.sendVoiceNote();
    const sentBefore = h.getSentMessages().length;

    const result = await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: { full_name: 'Someone Else' },
      confidences: { full_name: 0.9 },
      executionArnOverride: 'arn:aws:states:us-east-2:000000000000:execution:fake:vp-does-not-match',
    });

    expect(h.getSentMessages()).toHaveLength(sentBefore);
    expect(result.stepKey).toBe('profile.voice_processing'); // unchanged
    expect(h.getState().gate?.currentStepKey).toBe('profile.voice_processing');
    expect(h.getWorkerProfile()).toBeNull();
  });

  it('a stale completion (the run moved on to a different step) is silently discarded', async () => {
    const h = await toVoiceChoice('+15552230018');
    await h.sendVoiceNote();

    // The timeout escape (first failure -> retry offer) moves the run off
    // profile.voice_processing before the (now stale) completion event
    // arrives.
    h.advanceTime(6 * 60 * 1000);
    await h.sendText('anything');
    expect(h.getState().gate?.currentStepKey).toBe('profile.voice_choice');

    const sentBefore = h.getSentMessages().length;
    const result = await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: { full_name: 'Someone Else' },
      confidences: { full_name: 0.9 },
    });

    expect(h.getSentMessages()).toHaveLength(sentBefore);
    expect(result.stepKey).toBe('profile.voice_choice');
    expect(h.getWorkerProfile()).toBeNull();
  });

  it('a duplicate completion delivery (same synthetic sid) is a no-op', async () => {
    const h = await toVoiceChoice('+15552230019');
    await h.sendVoiceNote();
    await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: { full_name: 'Jose Martinez' },
      confidences: { full_name: 0.9 },
      summaryEn: 's', summaryEs: 's',
    });
    expect(h.getState().gate?.currentStepKey).toBe('profile.location');

    const sentBefore = h.getSentMessages().length;
    await h.injectVoiceIntakeResult(0, {
      status: 'COMPLETED',
      fields: { full_name: 'Jose Martinez' },
      confidences: { full_name: 0.9 },
      summaryEn: 's', summaryEs: 's',
    });

    expect(h.getSentMessages()).toHaveLength(sentBefore);
    expect(h.getState().gate?.currentStepKey).toBe('profile.location');
  });

  describe('profile.voice_processing holding step', () => {
    it('an inbound message before the timeout gets a cooldown-guarded "still processing" reply and does not advance', async () => {
      const h = await toVoiceChoice('+15552230020');
      await h.sendVoiceNote();

      const result = await h.sendText('are you done yet');
      expect(result.stepKey).toBe('profile.voice_processing');
      expect(findSend(h, 'v2_voice_processing_wait')).toBeDefined();

      const sentBefore = h.getSentMessages().length;
      await h.sendText('still there?');
      expect(h.getSentMessages()).toHaveLength(sentBefore); // cooldown-guarded
    });

    it('after the timeout, the run offers one retry (anti-strand guarantee)', async () => {
      const h = await toVoiceChoice('+15552230021');
      await h.sendVoiceNote();

      h.advanceTime(6 * 60 * 1000); // > VOICE_PROCESSING_TIMEOUT_MS (5 min)
      const result = await h.sendText('hello?');

      expect(findSend(h, 'v2_voice_retry_offer')).toBeDefined();
      expect(result.stepKey).toBe('profile.voice_choice');
      expect(h.getState().gate?.currentStepKey).toBe('profile.voice_choice');
    });

    // Task 6/B4 fix: a MISSING/unparseable `v2VoiceStartedAt` used to coerce
    // `elapsedMs` to 0 (never >= the timeout), stranding the worker on this
    // holding step forever — reachable in practice via a repair-CLI
    // `--set-step` landing here (now excluded, but a belt-and-suspenders
    // fix regardless: the run itself could reach this state via any anchor
    // loss). The fallback must now be immediate, no clock advance needed.
    it('a missing v2VoiceStartedAt anchor escapes to a retry offer on the very next inbound message, no timeout wait needed', async () => {
      const h = await toVoiceChoice('+15552230022');
      await h.sendVoiceNote();
      expect(h.getState().gate?.currentStepKey).toBe('profile.voice_processing');

      delete (h.getState().stateContext as Record<string, unknown>).v2VoiceStartedAt;

      const result = await h.sendText('hello?');

      expect(findSend(h, 'v2_voice_retry_offer')).toBeDefined();
      expect(result.stepKey).toBe('profile.voice_choice');
      expect(h.getState().gate?.currentStepKey).toBe('profile.voice_choice');
    });
  });

  // Task C: the plan's applied/skipped shape must be visible in telemetry
  // (transcript-quality failures were previously invisible), but the log
  // line itself must never carry an extracted value, transcript text, phone
  // number, or user name — field NAMES and skip REASONS only.
  describe('OnboardingVoiceExtractionPlan telemetry', () => {
    function findPlanLog(logSpy: jest.SpyInstance) {
      const call = logSpy.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('OnboardingVoiceExtractionPlan'),
      );
      return call ? JSON.parse(call[0] as string) : undefined;
    }

    it('a fully successful extraction logs the applied field names and an empty skipped list', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = await toVoiceChoice('+15552230023');
      await h.sendVoiceNote();

      await h.injectVoiceIntakeResult(0, {
        status: 'COMPLETED',
        fields: {
          full_name: 'Jose Martinez',
          city: '78701',
          main_trade: 'plumber',
          years_experience: '5-9',
          has_transportation: true,
          availability: 'full_time',
        },
        confidences: {
          full_name: 0.9, city: 0.9, main_trade: 0.9,
          years_experience: 0.9, has_transportation: 0.9, availability: 0.9,
        },
        summaryEn: 'summary', summaryEs: 'resumen',
      });

      const logged = findPlanLog(logSpy);
      expect(logged).toBeDefined();
      expect(logged).toMatchObject({
        metric: 'OnboardingVoiceExtractionPlan',
        threshold: 0.75,
        stepKey: 'profile.voice_processing',
      });
      expect([...logged.applied].sort()).toEqual(
        ['availability', 'city', 'full_name', 'has_transportation', 'main_trade', 'years_experience'].sort(),
      );
      expect(logged.skipped).toEqual([]);

      logSpy.mockRestore();
    });

    it('below-threshold and invalid-enum fields log their {field, reason} entries and the 0.75 threshold', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = await toVoiceChoice('+15552230024');
      await h.sendVoiceNote();

      await h.injectVoiceIntakeResult(0, {
        status: 'COMPLETED',
        fields: {
          full_name: 'Jose Martinez', // below threshold -> skipped
          main_trade: 'plumber', // above threshold -> applied
          years_experience: '3 years', // not in the DB enum -> skipped
        },
        confidences: {
          full_name: 0.4,
          main_trade: 0.9,
          years_experience: 0.9,
        },
        summaryEn: 'summary', summaryEs: 'resumen',
      });

      const logged = findPlanLog(logSpy);
      expect(logged).toBeDefined();
      expect(logged.threshold).toBe(0.75);
      expect(logged.applied).toEqual(['main_trade']);
      expect(logged.skipped).toEqual(
        expect.arrayContaining([
          { field: 'full_name', reason: 'low_confidence' },
          { field: 'years_experience', reason: 'invalid_enum' },
        ]),
      );
      expect(logged.skipped).toHaveLength(2);

      logSpy.mockRestore();
    });

    it('never logs an extracted value: a sentinel placed in the fixture never appears in the logged JSON', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = await toVoiceChoice('+15552230025');
      await h.sendVoiceNote();

      const SENTINEL = 'ZZ_DO_NOT_LOG_THIS_VALUE_9F3';
      await h.injectVoiceIntakeResult(0, {
        status: 'COMPLETED',
        fields: {
          full_name: SENTINEL,
          main_trade: 'other',
          main_trade_other: SENTINEL,
        },
        confidences: { full_name: 0.9, main_trade: 0.9 },
        summaryEn: 'summary', summaryEs: 'resumen',
      });

      const call = logSpy.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('OnboardingVoiceExtractionPlan'),
      );
      expect(call).toBeDefined();
      expect(call![0] as string).not.toContain(SENTINEL);

      const logged = findPlanLog(logSpy);
      expect(logged.applied).toEqual(expect.arrayContaining(['full_name', 'main_trade', 'main_trade_other']));

      logSpy.mockRestore();
    });

    it('never logs an unresolvable city value: a sentinel city string never appears in the logged JSON, only the skip reason', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const h = await toVoiceChoice('+15552230026');
      h.failAdapter('location'); // forces resolveLocation(raw) -> null regardless of input
      await h.sendVoiceNote();

      const SENTINEL_CITY = 'ZZ_DO_NOT_LOG_THIS_CITY_7Q2';
      await h.injectVoiceIntakeResult(0, {
        status: 'COMPLETED',
        fields: {
          city: SENTINEL_CITY,
          main_trade: 'plumber',
        },
        confidences: { city: 0.9, main_trade: 0.9 },
        summaryEn: 'summary', summaryEs: 'resumen',
      });

      const call = logSpy.mock.calls.find(
        (args) => typeof args[0] === 'string' && args[0].includes('OnboardingVoiceExtractionPlan'),
      );
      expect(call).toBeDefined();
      expect(call![0] as string).not.toContain(SENTINEL_CITY);

      const logged = findPlanLog(logSpy);
      expect(logged.skipped).toEqual(
        expect.arrayContaining([{ field: 'city', reason: 'unresolvable_location' }]),
      );

      logSpy.mockRestore();
    });
  });
});
