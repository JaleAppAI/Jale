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
    expect(findSend(h, 'v2_voice_failed')).toBeDefined();
  });

  it('an empty (whitespace-only) transcript is treated the same as a failure', async () => {
    const h = createWhatsAppV2Harness({ phone: '+15552220005' });
    h.setVoiceIntakeEnabled(true);
    await h.driveToStep('trust.question.1');
    await h.sendVoiceNote();

    await h.completeTranscription(0, { status: 'COMPLETED', transcript: '   ' });

    expect(h.getState().gate?.currentStepKey).toBe('trust.question.1');
    expect(h.getWorkerProfile()?.trustAnswers ?? []).toHaveLength(0);
    expect(findSend(h, 'v2_voice_failed')).toBeDefined();
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
    expect(findSend(h, 'v2_voice_invalid_type')).toBeDefined();
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
});
