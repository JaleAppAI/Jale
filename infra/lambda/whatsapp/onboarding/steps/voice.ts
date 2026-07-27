/**
 * WhatsApp v2 onboarding router — Stream B: full voice profile intake.
 * `profile.voice_choice` (offer + kick off ingestion) and
 * `profile.voice_processing` (holding step while the pipeline runs) plus
 * `handleVoiceIntakeResult`, the synthetic-event re-entry point for the
 * pipeline's completion (mirrors `onboarding/steps/trust.ts`'s
 * `applyTrustVoiceTranscript` for the trust-question voice path).
 */

import type { PoolClient } from 'pg';
import type { WorkerGate } from '../../lib/onboarding-repository';
import type { Lang } from '../../lib/templates';
import { detectMediaCategory } from '../../lib/media';
import { parseMediaPayload, type ProfileField } from '../../lib/flows';
import { shouldRepeatPrompt } from '../../lib/onboarding-language';
import { loadProfileFromDb } from '../../lib/profile-flow';
import { normalizeTrade, standardTrustQuestions } from '../../lib/onboarding-adapters';
import { V2_FALLBACK_TRUST_QUESTIONS } from '../../lib/interactive-templates';
import { planExtractionWrites, type ExtractionWrite } from '../../lib/voice-extraction';
import type { ProfileIntakeVoiceEventV2 } from '../../lib/voice-events';
import type { OnboardingV2Deps, OnboardingV2InboundMessage, OnboardingV2Session, RouteResult } from '../types';
import {
  type BilingualQuestion,
  VOICE_PROCESSING_TIMEOUT_MS,
  VOICE_CONFIDENCE_THRESHOLD,
  V2_TRUST_FALLBACK_VERSION,
  V2_TRUST_QUESTION_SET_VERSION,
  V2_TRUST_RUBRIC_VERSION,
} from '../constants';
import { repeatCurrentPrompt, sendTemplateMessage } from '../delivery';
import { advanceProfileToNextStep, effectiveLang } from '../transitions';

/** Mirrors processor.ts's `wantsVoiceProfile` (v1's identical prompt) —
 * '1' is the voice-choice prompt's first button, so a typed '1' means "yes,
 * I'll record a voice note", not "answer number 1" (there is no numbered
 * question at this step). */
const VOICE_CHOICE_RE = /^(1|voice|voz|audio|nota de voz)$/i;

/**
 * Cooldown-guarded template send: mirrors `repeatCurrentPrompt`'s
 * anti-spam window, but for a fixed template body rather than re-rendering
 * the step's own prompt. Used for the "send your voice note" nudge and the
 * "still processing" wait reply, both of which a chatty or impatient worker
 * could otherwise trigger on every single message.
 */
async function sendCooldownGuardedTemplate(
  client: PoolClient,
  session: OnboardingV2Session,
  deps: OnboardingV2Deps,
  workerId: string,
  stepKey: string,
  lang: Lang,
  now: Date,
  workflowRunId: string,
  inboundMessageSid: string,
  key: Parameters<typeof sendTemplateMessage>[5],
  cooldownKey: string,
  tag: string,
): Promise<void> {
  const lastIso = (session.state_context?.[cooldownKey] as string | undefined) ?? null;
  if (!shouldRepeatPrompt(lastIso, now)) return;
  await sendTemplateMessage(client, deps, workerId, stepKey, lang, key, {}, now, workflowRunId, inboundMessageSid, tag);
  session.state_context[cooldownKey] = now.toISOString();
}

// ── Bound: profile.voice_choice ──────────────────────────────────────────

export async function handleVoiceChoiceStep(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
): Promise<RouteResult> {
  const stepKey = 'profile.voice_choice' as const;

  // A real voice-note (or any other media) arrived — process it before
  // looking at msg.body at all, exactly like v1's handleAwaitingMediaVoice.
  if ((msg.numMedia ?? 0) > 0) {
    const category = msg.mediaContentType ? detectMediaCategory(msg.mediaContentType) : null;
    if (category !== 'voice' || !msg.mediaUrl || !msg.mediaContentType) {
      // Reuses 'v2_voice_invalid_type' (trust-question lane) rather than a
      // near-duplicate 'v2_voice_invalid' key — both mean exactly "that
      // file isn't a usable voice note" (decision recorded in templates.ts).
      await sendTemplateMessage(client, deps, gate.userId, stepKey, lang, 'v2_voice_invalid_type', {}, now, gate.runId!, msg.messageSid, 'voice_invalid_type');
      await repeatCurrentPrompt(client, session, deps, gate.userId, stepKey, lang, now, gate.runId!, msg.messageSid);
      return { handled: true, workerId: gate.userId, stepKey };
    }

    const ingest = await deps.voiceIntake.ingestProfileVoiceNote({
      workerId: gate.userId,
      phone: session.whatsapp_number,
      runId: gate.runId!,
      stepKey,
      language: lang,
      mediaUrl: msg.mediaUrl,
      mediaContentType: msg.mediaContentType,
      inboundMessageSid: msg.messageSid,
    });

    if (!ingest.started) {
      console.warn(JSON.stringify({
        metric: 'OnboardingVoiceIngestUnavailable',
        reason: ingest.reason ?? 'unknown',
      }));
      await sendTemplateMessage(client, deps, gate.userId, stepKey, lang, 'v2_voice_fallback', {}, now, gate.runId!, msg.messageSid, 'voice_pipeline_unavailable');
      // Never strand the worker on a dead-end step — fall through to the
      // ordinary text flow exactly as if they had typed an answer.
      return advanceProfileToNextStep(
        client, session, msg, deps, gate,
        stepKey,
        { voiceIngestFallbackReason: ingest.reason ?? 'unknown' },
        'profile_voice_ingest_unavailable',
        now,
      );
    }

    const updated = await deps.repo.advanceWorkflow(client, {
      runId: gate.runId!,
      expectedLockVersion: gate.lockVersion!,
      fromStepKey: stepKey,
      toStepKey: 'profile.voice_processing',
      contextPatch: { v2VoiceExecutionArn: ingest.executionArn, v2VoiceStartedAt: now.toISOString() },
      inboundMessageSid: msg.messageSid,
      reason: 'profile_voice_ingest_started',
    });
    session.state_context.v2VoiceExecutionArn = ingest.executionArn;
    session.state_context.v2VoiceStartedAt = now.toISOString();
    await sendTemplateMessage(
      client, deps, updated.userId, 'profile.voice_processing', effectiveLang(session, updated),
      'v2_voice_processing_ack', {}, now, gate.runId!, msg.messageSid, 'voice_processing_ack',
    );
    return { handled: true, workerId: updated.userId, stepKey: 'profile.voice_processing' };
  }

  // No media: either the worker tapped the "type it instead" button, typed
  // something asking to send a voice note, or typed anything else (which,
  // per v1 parity, is an implicit opt-in to the text flow).
  const mediaPayload = parseMediaPayload(msg.interactivePayload);
  if (mediaPayload?.kind === 'voice' && mediaPayload.value === 'text') {
    return advanceProfileToNextStep(client, session, msg, deps, gate, stepKey, {}, 'profile_voice_choice_opted_text', now);
  }

  const body = (msg.body ?? '').trim();
  if (body.length === 0 || VOICE_CHOICE_RE.test(body)) {
    await sendCooldownGuardedTemplate(
      client, session, deps, gate.userId, stepKey, lang, now, gate.runId!, msg.messageSid,
      'v2_voice_send_note', 'v2LastVoiceSendNoteAt', 'voice_send_note',
    );
    return { handled: true, workerId: gate.userId, stepKey };
  }

  return advanceProfileToNextStep(client, session, msg, deps, gate, stepKey, {}, 'profile_voice_choice_opted_text', now);
}

// ── Bound: profile.voice_processing ──────────────────────────────────────

export async function handleVoiceProcessingStep(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
): Promise<RouteResult> {
  const stepKey = 'profile.voice_processing' as const;
  const startedAtIso = session.state_context?.v2VoiceStartedAt as string | undefined;
  const startedAtMs = startedAtIso ? Date.parse(startedAtIso) : NaN;
  const elapsedMs = Number.isFinite(startedAtMs) ? now.getTime() - startedAtMs : 0;

  if (elapsedMs < VOICE_PROCESSING_TIMEOUT_MS) {
    await sendCooldownGuardedTemplate(
      client, session, deps, gate.userId, stepKey, lang, now, gate.runId!, msg.messageSid,
      'v2_voice_processing_wait', 'v2LastVoiceProcessingWaitAt', 'voice_processing_wait',
    );
    return { handled: true, workerId: gate.userId, stepKey };
  }

  // Anti-strand guarantee: the pipeline's completion event may simply never
  // arrive (a dropped SQS message, a crashed Lambda with no retry left) —
  // after the timeout, give up on voice and fall back to the text flow
  // exactly as a FAILED/empty result would.
  console.warn(JSON.stringify({ metric: 'OnboardingVoiceProcessingTimedOut', stepKey }));
  await sendTemplateMessage(client, deps, gate.userId, stepKey, lang, 'v2_voice_fallback', {}, now, gate.runId!, msg.messageSid, 'voice_processing_timeout');
  return advanceProfileToNextStep(client, session, msg, deps, gate, stepKey, { voiceIntakeTimedOut: true }, 'profile_voice_processing_timeout', now);
}

// ── Voice-pipeline completion re-entry ───────────────────────────────────

/** Applies a landed `main_trade`/`custom_trade` extraction write's trust-
 * question seeding into `session.state_context`, mirroring
 * `handleProfileTrade`/`handleCustomTrade` (onboarding/steps/profile.ts)
 * EXACTLY — same field names, same version constants, same generator
 * call + fallback-on-failure behavior — so a trade landed via voice is
 * indistinguishable, from `trust.question.1` onward, from one landed via
 * typed text. */
async function seedTrustQuestionsForLandedTrade(
  client: PoolClient,
  session: OnboardingV2Session,
  write: Extract<ExtractionWrite, { field: 'trade' | 'custom_trade' }>,
  deps: OnboardingV2Deps,
): Promise<void> {
  if (write.field === 'trade') {
    const questions: BilingualQuestion[] = standardTrustQuestions(write.value).map((q) => ({ en: q.q_en, es: q.q_es }));
    session.state_context.v2ProfileTrade = write.value;
    session.state_context.v2TrustQuestions = questions;
    session.state_context.v2TrustSource = 'standard';
    session.state_context.v2QuestionSetVersion = V2_TRUST_QUESTION_SET_VERSION;
    session.state_context.v2RubricVersion = V2_TRUST_RUBRIC_VERSION;
    return;
  }

  const professionRaw = write.value;
  const professionKey = normalizeTrade(professionRaw);
  let generated: BilingualQuestion[] | null = null;
  try {
    const result = await deps.adapters.trustQuestions.generate(client, professionRaw);
    if (Array.isArray(result) && result.length === 3) {
      generated = result.map((q) => ({ en: q.q_en, es: q.q_es }));
    }
  } catch (err) {
    console.error(JSON.stringify({
      metric: 'OnboardingTrustQuestionGenerationFailed',
      reason: (err as { name?: string })?.name ?? 'unknown_error',
    }));
    generated = null;
  }

  const source: 'generated' | 'fallback' = generated ? 'generated' : 'fallback';
  const questions: BilingualQuestion[] = generated ?? V2_FALLBACK_TRUST_QUESTIONS.map((q) => ({ ...q }));

  session.state_context.v2ProfileTrade = professionKey;
  session.state_context.v2TrustQuestions = questions;
  session.state_context.v2TrustSource = source;
  session.state_context.v2QuestionSetVersion = source === 'fallback' ? V2_TRUST_FALLBACK_VERSION : V2_TRUST_QUESTION_SET_VERSION;
  session.state_context.v2RubricVersion = V2_TRUST_RUBRIC_VERSION;
  session.state_context.v2CustomTradeText = professionRaw;
}

async function applyExtractionWrite(client: PoolClient, deps: OnboardingV2Deps, workerId: string, write: ExtractionWrite): Promise<void> {
  switch (write.field) {
    case 'full_name':
      await deps.adapters.profile.saveName(client, workerId, write.value);
      return;
    case 'location':
      await deps.adapters.profile.saveLocation(client, workerId, write.value);
      return;
    case 'trade':
      await deps.adapters.profile.saveTrade(client, workerId, write.value);
      return;
    case 'custom_trade':
      await deps.adapters.profile.saveCustomTrade(client, workerId, write.value);
      return;
    case 'years_experience':
      await deps.adapters.profile.saveExperience(client, workerId, write.value);
      return;
    case 'has_transportation':
      await deps.adapters.profile.saveTransportation(client, workerId, write.value);
      return;
    case 'availability':
      await deps.adapters.profile.saveAvailability(client, workerId, write.value);
      return;
    /* istanbul ignore next -- exhaustiveness guard, not a reachable branch */
    default: {
      const _exhaustive: never = write;
      throw new Error(`unhandled extraction write field: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * The profile-intake pipeline's completion re-enters here as a synthetic
 * inbound event (see lib/voice-events.ts). Dispatched unconditionally
 * whenever `msg.voiceEvent?.kind === 'profile_intake'`, regardless of the
 * run's CURRENT step — the staleness guard below is what decides whether
 * this event still applies, not the dispatch site. Never DB work beyond the
 * profile-field writes (via the real adapters, never raw columns) and the
 * one `advanceProfileToNextStep` call; `ai-profile-writer`'s completion
 * branch that sent this event already did zero `users`/outbox work of its
 * own (Task 8d).
 */
export async function handleVoiceIntakeResult(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
  evt: ProfileIntakeVoiceEventV2,
): Promise<RouteResult> {
  const expectedArn = session.state_context?.v2VoiceExecutionArn as string | undefined;
  const stale = gate.currentStepKey !== 'profile.voice_processing' || expectedArn !== evt.executionArn;
  if (stale) {
    console.warn(JSON.stringify({
      metric: 'OnboardingVoiceResultStale',
      currentStepKey: gate.currentStepKey,
      eventStepKey: evt.stepKey,
    }));
    return { handled: true, workerId: gate.userId, stepKey: gate.currentStepKey ?? 'unknown' };
  }

  const stepKey = 'profile.voice_processing' as const;

  if (evt.status === 'FAILED' || !evt.fields) {
    await sendTemplateMessage(client, deps, gate.userId, stepKey, lang, 'v2_voice_fallback', {}, now, gate.runId!, msg.messageSid, 'voice_intake_failed');
    return advanceProfileToNextStep(client, session, msg, deps, gate, stepKey, { voiceIntakeFailed: true }, 'profile_voice_intake_failed', now);
  }

  const dbFilled = await loadProfileFromDb(client, gate.userId);
  const plan = planExtractionWrites(dbFilled, evt.fields, evt.confidences ?? {}, {
    threshold: VOICE_CONFIDENCE_THRESHOLD,
    resolveLocation: (raw) => deps.adapters.location.resolve(raw),
  });

  if (plan.writes.length === 0) {
    await sendTemplateMessage(client, deps, gate.userId, stepKey, lang, 'v2_voice_fallback', {}, now, gate.runId!, msg.messageSid, 'voice_intake_zero_writes');
    return advanceProfileToNextStep(client, session, msg, deps, gate, stepKey, { voiceIntakeZeroWrites: true }, 'profile_voice_intake_zero_writes', now);
  }

  for (const write of plan.writes) {
    await applyExtractionWrite(client, deps, gate.userId, write);
    if (write.field === 'trade' || write.field === 'custom_trade') {
      await seedTrustQuestionsForLandedTrade(client, session, write, deps);
    }
  }

  const summary = (lang === 'en' ? evt.summaryEn : evt.summaryEs)?.trim();
  if (summary) {
    await sendTemplateMessage(client, deps, gate.userId, stepKey, lang, 'v2_voice_summary', { summary }, now, gate.runId!, msg.messageSid, 'voice_summary');
  }

  const appliedFields: ProfileField[] = plan.appliedFields;
  return advanceProfileToNextStep(
    client, session, msg, deps, gate,
    stepKey,
    { voiceExtractionId: evt.extractionId, voiceAppliedFields: appliedFields },
    'profile_voice_intake_applied',
    now,
  );
}
