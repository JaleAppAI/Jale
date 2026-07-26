/**
 * WhatsApp v2 onboarding router — pre-auth `start.choose_language` step.
 * Moved verbatim out of `../../onboarding-v2.ts` (pure move, no behavior
 * change).
 */

import type { PoolClient } from 'pg';
import type { PreAuthState } from '../../lib/onboarding-repository';
import type { Lang } from '../../lib/templates';
import {
  parseLanguageChoice,
  evaluateStartCooldown,
  appendSendTimestamp,
} from '../../lib/onboarding-language';
import type { OnboardingV2Deps, OnboardingV2InboundMessage, OnboardingV2Session, RouteResult } from '../types';
import { sendPreAuthPrompt, readHistory } from '../delivery';

export async function handleStartStep(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  preAuth: PreAuthState | null,
  phoneHash: string,
  now: Date,
): Promise<RouteResult> {
  const lang: Lang = preAuth?.preferredLanguage ?? session.language ?? 'es';
  const candidateUserId = preAuth?.candidateUserId ?? session.user_id ?? null;

  const choice = parseLanguageChoice(msg.body, msg.interactivePayload);
  if (choice) {
    const issued = await deps.adapters.identity.issueChallenge({ whatsappNumber: msg.from, lang: choice });
    if (issued.status === 'throttled') {
      return { handled: true, workerId: null, stepKey: 'start.choose_language' };
    }

    // The initial challenge is the first of the three hourly OTP sends, so its
    // timestamp is recorded in `otpSendHistory` here — the same key the RESEND
    // branch appends to. This caps the flow at three total sends per hour
    // (initial + two resends), not four.
    const otpHistory = readHistory(preAuth?.context, 'otpSendHistory');
    const newOtpHistory = appendSendTimestamp(otpHistory, now);

    // Challenge id + expiry persisted in the SAME patch that advances the
    // step — exactly one savePreAuthState call for this whole branch.
    const saved = await deps.repo.savePreAuthState(client, phoneHash, {
      preferredLanguage: choice,
      providerChallengeId: issued.challengeId,
      expiresAt: issued.expiresAt,
      currentStepKey: 'identity.verify_otp',
      status: 'pending',
      attempts: 0,
      candidateUserId,
      context: { ...(preAuth?.context ?? {}), otpSendHistory: newOtpHistory },
    });

    await sendPreAuthPrompt(client, deps, msg, 'identity.verify_otp', choice);
    return { handled: true, workerId: null, stepKey: 'identity.verify_otp' };
  }

  // Not a language choice: (re)send the invitation, subject to the start
  // cooldown / daily cap. A blocked send is recorded only — never re-sent.
  const history = readHistory(preAuth?.context, 'startSendHistory');
  const cooldown = evaluateStartCooldown(history, now);
  if (!cooldown.allowed) {
    return { handled: true, workerId: null, stepKey: 'start.choose_language' };
  }

  const newHistory = appendSendTimestamp(history, now);
  await sendPreAuthPrompt(client, deps, msg, 'start.choose_language', lang);
  await deps.repo.savePreAuthState(client, phoneHash, {
    candidateUserId,
    context: { ...(preAuth?.context ?? {}), startSendHistory: newHistory },
  });
  return { handled: true, workerId: null, stepKey: 'start.choose_language' };
}
