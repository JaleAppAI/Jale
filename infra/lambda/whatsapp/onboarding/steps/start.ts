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
import { loadActiveJobLabel, parkPendingClaim } from '../../lib/referral-claims';
import type { OnboardingV2Deps, OnboardingV2InboundMessage, OnboardingV2Session, RouteResult } from '../types';
import { sendPreAuthPrompt, sendPreAuthText, readHistory } from '../delivery';

export async function handleStartStep(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  preAuth: PreAuthState | null,
  phoneHash: string,
  now: Date,
): Promise<RouteResult> {
  const candidateUserId = preAuth?.candidateUserId ?? session.user_id ?? null;

  // Job referrals (migration 056): a referral code is a side effect on
  // arrival, not a workflow step — it creates no `users` row and sends no
  // OTP. Checked ahead of `parseLanguageChoice` deliberately, but a
  // `JALE-XXXXXXXX` code never matches START/EMPEZAR anyway, so normal
  // language-choice handling always falls through unaffected.
  //
  // Sprint 27 deliberately ENDS the old "byte-identical reply either way"
  // rule: a token that parks, for a job that is still active, is now
  // acknowledged by name ahead of the invitation, so the first reply is
  // about the job the person tapped Apply on. What the reply must still
  // never depend on is whether an ACCOUNT exists -- no-account, candidate
  // and bound-session senders get the same bytes -- and an unknown, expired
  // or consumed token still gets exactly the no-code reply: `jobId` and
  // `locale` come back only for a token that parked.
  //
  // Isolated behind SAVEPOINT/RELEASE: this call runs inside the caller's
  // already-open transaction, and a referral side effect must never be able
  // to break onboarding. A plain try/catch is not enough — once a statement
  // errors inside an open Postgres transaction, the transaction enters an
  // aborted state and EVERY later statement (savePreAuthState, the prompt
  // send itself) fails with 25P02 even if the error is swallowed here. A
  // SAVEPOINT gives the failure a boundary: on error, rolling back to it
  // discards only the referral statements, leaving the rest of this turn —
  // and the sender's Start invitation — unaffected; nothing is acknowledged
  // for a park that was rolled back. Never logs the token or phone hash,
  // only a static error code.
  let referral: { label: { title: string; company: string }; locale: string | null } | null = null;
  const applyToken = parseApplyToken(msg.body);
  if (applyToken) {
    try {
      await client.query('SAVEPOINT referral_park');
      const park = await parkPendingClaim(client, phoneHash, applyToken, now);
      const label = park.parked && park.jobId ? await loadActiveJobLabel(client, park.jobId) : null;
      await client.query('RELEASE SAVEPOINT referral_park');
      if (label) referral = { label, locale: park.locale };
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

  // The reply's language: the phone's pre-auth choice, else the language of
  // the page the link was opened on (the token row's locale, en/es only),
  // else the conversation's. The English prefill is not hello/hi/hey, so a
  // brand-new conversation reads it as Spanish -- the locale is the only
  // signal that this person was on the English page.
  const tokenLocale: Lang | null = referral?.locale === 'en' || referral?.locale === 'es' ? referral.locale : null;
  const lang: Lang = preAuth?.preferredLanguage ?? tokenLocale ?? session.language ?? 'es';

  const choice = parseLanguageChoice(msg.body, msg.interactivePayload);
  if (choice) {
    const issued = await deps.adapters.identity.issueChallenge({ whatsappNumber: msg.from, lang: choice });
    if (issued.status === 'throttled') {
      return { handled: true, workerId: null, stepKey: 'start.choose_language' };
    }

    // Sprint 24 A3: Cognito started the challenge but the OTP SMS could not
    // be sent (see IssueChallengeResult's 'send_failed'). Tell the worker --
    // in the language they just picked, which is the only language signal
    // this phone has given us -- and leave the run on this same step so
    // their next message retries the send. `handled: true` is the point of
    // the branch: the inbound SQS record gets acked instead of dying in
    // whatsapp-inbound-v2-dlq.fifo.
    //
    // Deliberately NOT appended to `otpSendHistory`: that history caps SENT
    // codes at three per hour, and charging a worker for a code that never
    // left our side would lock them out of retrying over a provider fault.
    // Nothing about the challenge is persisted either (no
    // providerChallengeId/expiresAt) -- there is no code to enter, and a
    // stale id would send the next turn to the OTP step with nothing behind
    // it.
    if (issued.status === 'send_failed') {
      await deps.repo.savePreAuthState(client, phoneHash, {
        preferredLanguage: choice,
        currentStepKey: 'start.choose_language',
        candidateUserId,
      });
      await sendPreAuthText(client, deps, msg, choice, 'v2_otp_send_failed');
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
  // The ack is part of this same reply, so the cooldown above blocks it too;
  // the claim stays parked either way.
  if (referral) {
    await sendPreAuthText(client, deps, msg, lang, 'v2_referral_ack', referral.label);
  }
  await sendPreAuthPrompt(client, deps, msg, 'start.choose_language', lang);
  await deps.repo.savePreAuthState(client, phoneHash, {
    candidateUserId,
    context: { ...(preAuth?.context ?? {}), startSendHistory: newHistory },
  });
  return { handled: true, workerId: null, stepKey: 'start.choose_language' };
}
