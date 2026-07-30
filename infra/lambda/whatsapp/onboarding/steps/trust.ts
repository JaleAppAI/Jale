/**
 * WhatsApp v2 onboarding router — bound `trust.question.{1,2,3}` steps and
 * atomic onboarding-completion readiness. Moved verbatim out of
 * `../../onboarding-v2.ts` (pure move, no behavior change).
 */

import type { PoolClient } from 'pg';
import type { WorkflowStepKey } from '../../lib/onboarding-types';
import type { WorkerGate } from '../../lib/onboarding-repository';
import type { Lang } from '../../lib/templates';
import { normalizeTrade, getTrustOptions } from '../../lib/onboarding-adapters';
import { V2_FALLBACK_TRUST_QUESTIONS } from '../../lib/interactive-templates';
import { detectMediaCategory } from '../../lib/media';
import type { TrustVoiceEventV2 } from '../../lib/voice-events';
import type { OnboardingV2Deps, OnboardingV2InboundMessage, OnboardingV2Session, RouteResult } from '../types';
import {
  type BilingualQuestion,
  V2_TRUST_FALLBACK_VERSION,
  V2_TRUST_QUESTION_SET_VERSION,
  V2_TRUST_RUBRIC_VERSION,
} from '../constants';
import { repeatCurrentPrompt, sendTrustPrompt, sendTemplateMessage, sendErrorWithCurrentPrompt } from '../delivery';
import { effectiveLang } from '../transitions';

// ── Bound: trust.question.{1,2,3} + atomic readiness ─────────────────────

const TRUST_STEP_NEXT: Record<string, WorkflowStepKey | null> = {
  'trust.question.1': 'trust.question.2',
  'trust.question.2': 'trust.question.3',
  'trust.question.3': null,
};

/** Parses a 1-based option index from either a `trust:<n>` interactive
 * payload or plain numeric text. Returns null when neither form is present. */
function parseTrustOptionIndex(msg: OnboardingV2InboundMessage): number | null {
  if (msg.interactivePayload) {
    const match = /^trust:(\d+)$/.exec(msg.interactivePayload);
    if (!match) return null;
    return Number(match[1]);
  }
  const trimmed = (msg.body ?? '').trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * Sole call site that ever writes a trust answer (typed or transcribed
 * voice) and, on the third question, completes onboarding. `answerSource`
 * is recorded on the assessment row (ai/trust-scorer.ts reads it) but
 * otherwise never changes the control flow below — a voice-transcribed
 * answer advances/completes exactly like a typed one.
 */
async function recordTrustAnswer(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
  stepKey: 'trust.question.1' | 'trust.question.2' | 'trust.question.3',
  answerText: string,
  answerSource: 'text' | 'voice',
): Promise<RouteResult> {
  const idx = Number(stepKey.split('.').pop()) - 1; // 0-based
  const trade = (session.state_context.v2ProfileTrade as string | undefined) ?? 'other';
  const source = (session.state_context.v2TrustSource as string | undefined) ?? 'fallback';
  const questionSetVersion = (session.state_context.v2QuestionSetVersion as string | undefined)
    ?? (source === 'fallback' ? V2_TRUST_FALLBACK_VERSION : V2_TRUST_QUESTION_SET_VERSION);
  const rubricVersion = (session.state_context.v2RubricVersion as string | undefined) ?? V2_TRUST_RUBRIC_VERSION;

  // Defect 3 fix: the trust-scorer (ai/trust-scorer.ts:~154) reads each
  // stored answer as `{ q_en, answer_text }`. Both `profile.trade` and
  // `profile.custom_trade` already stashed the bilingual question text this
  // step is answering in `state_context.v2TrustQuestions` (BilingualQuestion
  // pairs, same array `buildTrustQuestionBody` reads to render the prompt),
  // falling back to the reviewed bilingual fallback set exactly as the
  // prompt renderer does, so the two never disagree about what question was
  // actually asked.
  const trustQuestions = (session.state_context.v2TrustQuestions as BilingualQuestion[] | undefined)
    ?? V2_FALLBACK_TRUST_QUESTIONS;
  const currentQuestion = trustQuestions[idx] ?? trustQuestions[0];

  await deps.adapters.profile.saveTrustAnswer(client, {
    workerId: gate.userId,
    professionKey: normalizeTrade(trade),
    questionIndex: idx,
    qEn: currentQuestion.en,
    qEs: currentQuestion.es,
    answerText,
    answerSource,
    provenance: { rubricVersion },
  });

  const nextStepKey = TRUST_STEP_NEXT[stepKey];
  if (nextStepKey) {
    const updated = await deps.repo.advanceWorkflow(client, {
      runId: gate.runId!,
      expectedLockVersion: gate.lockVersion!,
      fromStepKey: stepKey,
      toStepKey: nextStepKey,
      contextPatch: { [`trustAnswer${idx + 1}At`]: now.toISOString() },
      inboundMessageSid: msg.messageSid,
      reason: 'trust_answer_recorded',
    });
    await sendTrustPrompt(client, deps, updated.userId, nextStepKey, effectiveLang(session, updated), now, gate.runId!, msg.messageSid, `trust:${now.getTime()}`, session.state_context);
    return { handled: true, workerId: updated.userId, stepKey: nextStepKey };
  }

  // Answer three: persist (done above), then complete — same client/
  // transaction, exactly once, no external request or send. C6's release
  // owns the sole ready confirmation; this router enqueues nothing further.
  await deps.repo.completeOnboarding(client, {
    workerId: gate.userId,
    runId: gate.runId!,
    expectedLockVersion: gate.lockVersion!,
    // Job referrals (migration 055): the worker's phone hash, derived from
    // the phone already in scope on this session — reuses the same
    // `hashNormalizedPhone` every other lane uses, never a second hasher.
    // Load-bearing invariant: `parkPendingClaim` (start.ts) keys on
    // `hashNormalizedPhone(msg.from)`, computed once in `routeOnboardingV2`
    // from `conv.whatsapp_number`; this call must hash that SAME string
    // (`session.whatsapp_number`, sourced from the same column in
    // processor.ts) or the two hashes diverge and a parked claim can never
    // be found here — a silent no-op, not an error. `hashNormalizedPhone`
    // only `.trim()`s its input despite its "E.164-normalized" name, so this
    // is byte-sensitive, not just semantically-sensitive.
    workerPhoneHash: deps.hashNormalizedPhone(session.whatsapp_number),
    now,
    assessmentProvenance: {
      trade,
      professionKey: normalizeTrade(trade),
      source,
      questionSetVersion,
      rubricVersion,
    },
  });
  return { handled: true, workerId: gate.userId, stepKey };
}

/**
 * Worker sent a voice note (numMedia > 0, no voice-event envelope yet) at a
 * trust question. Only kicks off transcription — never advances the step or
 * takes the run lock, so a typed answer that arrives before the transcript
 * comes back still wins (see applyTrustVoiceTranscript's staleness guard).
 */
async function handleTrustVoiceNote(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
  stepKey: 'trust.question.1' | 'trust.question.2' | 'trust.question.3',
  questionIndex: number,
): Promise<RouteResult> {
  if (!deps.voiceIntake.enabled) {
    await sendErrorWithCurrentPrompt(client, session, deps, gate.userId, stepKey, lang, 'v2_voice_not_supported', now, gate.runId!, msg.messageSid, 'voice_control_off');
    return { handled: true, workerId: gate.userId, stepKey };
  }

  const category = msg.mediaContentType ? detectMediaCategory(msg.mediaContentType) : null;
  if (!msg.mediaUrl || !msg.mediaContentType || category !== 'voice') {
    await sendErrorWithCurrentPrompt(client, session, deps, gate.userId, stepKey, lang, 'v2_voice_invalid_type', now, gate.runId!, msg.messageSid, 'voice_invalid_type');
    return { handled: true, workerId: gate.userId, stepKey };
  }

  const { started, executionArn } = await deps.voiceIntake.startTrustTranscription({
    workerId: gate.userId,
    phone: session.whatsapp_number,
    runId: gate.runId!,
    stepKey,
    questionIndex,
    language: lang,
    mediaUrl: msg.mediaUrl,
    mediaContentType: msg.mediaContentType,
    inboundMessageSid: msg.messageSid,
  });

  if (!started) {
    // One combined message (error first, question underneath): two separate
    // intents carry no handset-order guarantee, and live testing showed the
    // re-asked question arriving BEFORE the error notice.
    await sendErrorWithCurrentPrompt(client, session, deps, gate.userId, stepKey, lang, 'v2_voice_failed', now, gate.runId!, msg.messageSid, 'voice_pipeline_unavailable');
    return { handled: true, workerId: gate.userId, stepKey };
  }

  // Task 5/B3: stashed as the staleness anchor `applyTrustVoiceTranscript`
  // compares its incoming event's `executionArn` against — mirrors
  // `handleVoiceChoiceStep`'s `v2VoiceExecutionArn` (onboarding/steps/
  // voice.ts) exactly. Never advances the step or takes the run lock, so
  // this is a plain state_context mutation persisted by the caller's
  // ordinary per-turn write-back.
  session.state_context.v2TrustVoiceExecutionArn = executionArn;

  await sendTemplateMessage(client, deps, gate.userId, stepKey, lang, 'v2_voice_ack', {}, now, gate.runId!, msg.messageSid, 'voice_ack');
  return { handled: true, workerId: gate.userId, stepKey };
}

/**
 * The transcription pipeline's completion re-enters here as a synthetic
 * inbound event (see lib/voice-events.ts). `runId`/`stepKey` are the
 * staleness anchor: if the run moved on (a typed answer won the race, or a
 * restart issued a new run) before the transcript came back, this is a
 * silent no-op — never a reply, never a write. Never DB work beyond the one
 * `recordTrustAnswer` call on success; the receiver Lambda that sent this
 * event already did zero DB work of its own (Task 5).
 */
async function applyTrustVoiceTranscript(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
  stepKey: 'trust.question.1' | 'trust.question.2' | 'trust.question.3',
  evt: TrustVoiceEventV2,
): Promise<RouteResult> {
  // Task 5/B3: the execution-ARN check is what catches a late transcript
  // from an EARLIER visit to this exact run/step — BACK and RESTART both
  // revisit the same run, so runId/stepKey alone can't tell "this visit's
  // transcript" from "a stale one from before the worker went back and
  // re-answered". Mirrors the profile lane's `handleVoiceIntakeResult`
  // (onboarding/steps/voice.ts) exactly.
  const expectedArn = session.state_context?.v2TrustVoiceExecutionArn as string | undefined;
  if (evt.runId !== gate.runId || evt.stepKey !== stepKey || expectedArn !== evt.executionArn) {
    console.warn(JSON.stringify({
      metric: 'OnboardingVoiceTranscriptStale',
      stepKey,
      eventStepKey: evt.stepKey,
    }));
    return { handled: true, workerId: gate.userId, stepKey };
  }

  const transcript = evt.transcript?.trim() ?? '';
  if (evt.status === 'FAILED' || transcript.length === 0) {
    // One combined message (error first, question underneath) — see the
    // sibling site above for why two intents cannot hold their order.
    await sendErrorWithCurrentPrompt(client, session, deps, gate.userId, stepKey, lang, 'v2_voice_failed', now, gate.runId!, msg.messageSid, 'voice_transcript_failed');
    return { handled: true, workerId: gate.userId, stepKey };
  }

  return recordTrustAnswer(client, session, msg, deps, gate, lang, now, stepKey, transcript, 'voice');
}

export async function handleTrustQuestion(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
  stepKey: 'trust.question.1' | 'trust.question.2' | 'trust.question.3',
): Promise<RouteResult> {
  // Idempotency: a message arriving after this run already completed (e.g. a
  // duplicate webhook delivery of the final answer) must not re-complete it.
  if (gate.status === 'completed') {
    return { handled: true, workerId: gate.userId, stepKey };
  }

  const idx = Number(stepKey.split('.').pop()) - 1; // 0-based

  if (msg.voiceEvent?.kind === 'trust_answer') {
    return applyTrustVoiceTranscript(client, session, msg, deps, gate, lang, now, stepKey, msg.voiceEvent);
  }

  if ((msg.numMedia ?? 0) > 0) {
    return handleTrustVoiceNote(client, session, msg, deps, gate, lang, now, stepKey, idx);
  }

  const trade = (session.state_context.v2ProfileTrade as string | undefined) ?? 'other';
  const source = (session.state_context.v2TrustSource as string | undefined) ?? 'fallback';

  let answerText: string | null = null;
  if (source === 'standard') {
    const options = getTrustOptions(idx, trade);
    const optionIdx = parseTrustOptionIndex(msg);
    if (optionIdx !== null && optionIdx >= 1 && optionIdx <= options.length) {
      answerText = options[optionIdx - 1];
    }
  } else {
    const trimmed = (msg.body ?? '').trim();
    answerText = trimmed.length > 0 ? trimmed : null;
  }

  if (answerText === null) {
    await repeatCurrentPrompt(client, session, deps, gate.userId, stepKey, lang, now, gate.runId!, msg.messageSid);
    return { handled: true, workerId: gate.userId, stepKey };
  }

  return recordTrustAnswer(client, session, msg, deps, gate, lang, now, stepKey, answerText, 'text');
}
