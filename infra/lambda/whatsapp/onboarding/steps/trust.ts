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
import type { OnboardingV2Deps, OnboardingV2InboundMessage, OnboardingV2Session, RouteResult } from '../types';
import {
  type BilingualQuestion,
  V2_TRUST_FALLBACK_VERSION,
  V2_TRUST_QUESTION_SET_VERSION,
  V2_TRUST_RUBRIC_VERSION,
} from '../constants';
import { repeatCurrentPrompt, sendTrustPrompt } from '../delivery';
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
  const trade = (session.state_context.v2ProfileTrade as string | undefined) ?? 'other';
  const source = (session.state_context.v2TrustSource as string | undefined) ?? 'fallback';
  const questionSetVersion = (session.state_context.v2QuestionSetVersion as string | undefined)
    ?? (source === 'fallback' ? V2_TRUST_FALLBACK_VERSION : V2_TRUST_QUESTION_SET_VERSION);
  const rubricVersion = (session.state_context.v2RubricVersion as string | undefined) ?? V2_TRUST_RUBRIC_VERSION;

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
    answerSource: 'text',
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
