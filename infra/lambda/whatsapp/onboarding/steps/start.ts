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
import { parseApplyToken } from '../../../lib/referral-codes';
import { parkPendingClaim } from '../../lib/referral-claims';
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

  // Job referrals (migration 055): a referral code is a side effect on
  // arrival, not a workflow step — it creates no `users` row, sends no OTP,
  // and never changes what gets sent back below. Whether the token is
  // valid, unknown, expired, or already consumed, `parkPendingClaim`
  // resolves to a plain boolean this handler never inspects: the reply
  // must be byte-identical either way, so nothing here ever branches on the
  // result. Checked ahead of `parseLanguageChoice` per spec, but a
  // `JALE-XXXXXXXX` code never matches START/EMPEZAR anyway, so normal
  // language-choice handling always falls through unaffected.
  //
  // Isolated behind SAVEPOINT/RELEASE: this call runs inside the caller's
  // already-open transaction, and a referral side effect must never be able
  // to break onboarding. A plain try/catch is not enough — once a statement
  // errors inside an open Postgres transaction, the transaction enters an
  // aborted state and EVERY later statement (savePreAuthState, the prompt
  // send itself) fails with 25P02 even if the error is swallowed here. A
  // SAVEPOINT gives the failure a boundary: on error, rolling back to it
  // discards only the referral statements, leaving the rest of this turn —
  // and the sender's Start invitation — unaffected. Never logs the token or
  // phone hash, only a static error code.
  const applyToken = parseApplyToken(msg.body);
  if (applyToken) {
    try {
      await client.query('SAVEPOINT referral_park');
      await parkPendingClaim(client, phoneHash, applyToken, now);
      await client.query('RELEASE SAVEPOINT referral_park');
    } catch {
      try {
        await client.query('ROLLBACK TO SAVEPOINT referral_park');
      } catch {
        // The transaction/connection itself is unusable at this point —
        // nothing further to do here; the caller's own transaction
        // handling (retry/DLQ) takes over from here as it would for any
        // other failed statement.
      }
      console.error(JSON.stringify({ metric: 'ReferralParkFailed' }));
    }
  }

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
