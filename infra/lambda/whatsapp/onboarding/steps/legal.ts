/**
 * WhatsApp v2 onboarding router — bound `legal.review` step. Moved verbatim
 * out of `../../onboarding-v2.ts` (pure move, no behavior change).
 */

import type { PoolClient } from 'pg';
import type { WorkerGate } from '../../lib/onboarding-repository';
import type { Lang } from '../../lib/templates';
import { normalizeCommandText } from '../../lib/flows';
import { isReviewTermsCommand } from '../../lib/onboarding-language';
import type { OnboardingV2Deps, OnboardingV2InboundMessage, OnboardingV2Session, RouteResult } from '../types';
import { sendStepPrompt, sendTemplateMessage, repeatCurrentPrompt } from '../delivery';
import { advanceProfileToNextStep, effectiveLang } from '../transitions';

// ── Bound: legal.review ─────────────────────────────────────────────────

function normalizedEquals(body: string, words: readonly string[]): boolean {
  return words.includes(normalizeCommandText(body));
}

export async function handleLegalStep(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  responseLang: Lang,
  now: Date,
): Promise<RouteResult> {
  const isInteractive = Boolean(msg.interactivePayload);
  const accept = isInteractive
    ? msg.interactivePayload === 'legal:accept'
    : normalizedEquals(msg.body, ['accept', 'aceptar']);
  const decline = isInteractive
    ? msg.interactivePayload === 'legal:decline'
    : normalizedEquals(msg.body, ['decline', 'rechazar']);
  const review = isInteractive
    ? msg.interactivePayload === 'legal:review'
    : isReviewTermsCommand(msg.body);

  if (gate.status === 'declined') {
    if (review) {
      const reactivated = await deps.repo.reactivateDeclinedLegalRun(client, {
        runId: gate.runId!,
        expectedLockVersion: gate.lockVersion!,
      });
      await sendStepPrompt(client, deps, reactivated.userId, 'legal.review', effectiveLang(session, reactivated), now, reactivated.runId!, msg.messageSid, `review:${now.getTime()}`);
      return { handled: true, workerId: reactivated.userId, stepKey: 'legal.review' };
    }

    await sendTemplateMessage(client, deps, gate.userId, 'legal.review', effectiveLang(session, gate), 'v2_legal_declined', {}, now, gate.runId!, msg.messageSid, 'declined');
    return { handled: true, workerId: gate.userId, stepKey: 'legal.review' };
  }

  if (accept) {
    await deps.recordLegalAcceptance(client, {
      workerId: gate.userId,
      documentVersion: deps.requiredLegalVersion,
    });
    return advanceProfileToNextStep(
      client, session, msg, deps, gate,
      'legal.review',
      { legalAcceptedAt: now.toISOString() },
      'legal_accept',
      now,
    );
  }

  if (decline) {
    const updated = await deps.repo.advanceWorkflow(client, {
      runId: gate.runId!,
      expectedLockVersion: gate.lockVersion!,
      fromStepKey: 'legal.review',
      toStepKey: 'legal.review',
      status: 'declined',
      contextPatch: { legalDeclinedAt: now.toISOString() },
      inboundMessageSid: msg.messageSid,
      reason: 'legal_decline',
    });
    await sendTemplateMessage(client, deps, updated.userId, 'legal.review', effectiveLang(session, updated), 'v2_legal_declined', {}, now, gate.runId!, msg.messageSid, 'declined');
    return { handled: true, workerId: updated.userId, stepKey: 'legal.review' };
  }

  // REVIEW TERMS, or anything unrecognized: stay on the step and resend
  // the legal prompt (subject to the reprompt cooldown for unrecognized
  // input so a chatty worker doesn't get spammed).
  if (review) {
    await sendStepPrompt(client, deps, gate.userId, 'legal.review', lang, now, gate.runId!, msg.messageSid, `review:${now.getTime()}`);
  } else {
    await repeatCurrentPrompt(client, session, deps, gate.userId, 'legal.review', lang, now, gate.runId!, msg.messageSid);
  }
  return { handled: true, workerId: gate.userId, stepKey: 'legal.review' };
}
