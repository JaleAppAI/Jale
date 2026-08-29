/**
 * WhatsApp v2 onboarding router — pre-auth `identity.verify_otp` step.
 * Moved verbatim out of `../../onboarding-v2.ts` (pure move, no behavior
 * change).
 */

import type { PoolClient } from 'pg';
import type { PreAuthState } from '../../lib/onboarding-repository';
import type { Lang, TemplateKey } from '../../lib/templates';
import {
  isResendCommand,
  resolveResponseLanguage,
  evaluateOtpResendCooldown,
  appendSendTimestamp,
} from '../../lib/onboarding-language';
import type { OnboardingV2Deps, OnboardingV2InboundMessage, OnboardingV2Session, RouteResult } from '../types';
import { claimPendingReferral } from '../../lib/referral-claims';
import { sendPreAuthPrompt, sendPreAuthText, sendStepPrompt, readHistory } from '../delivery';

export async function handleOtpStep(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  preAuth: PreAuthState,
  phoneHash: string,
  now: Date,
): Promise<RouteResult> {
  const lang: Lang = preAuth.preferredLanguage;
  const isInteractive = Boolean(msg.interactivePayload);
  const responseLang = resolveResponseLanguage(lang, msg.body, isInteractive);
  const candidateUserId = preAuth.candidateUserId ?? session.user_id ?? null;

  const isResend = msg.interactivePayload === 'otp:resend' || (!isInteractive && isResendCommand(msg.body));
  if (isResend) {
    const history = readHistory(preAuth.context, 'otpSendHistory');
    // OTP resend has its own (tighter) cadence — 60s cooldown, 3/hour cap —
    // distinct from the 10min/5-per-day start-invitation policy.
    const cooldown = evaluateOtpResendCooldown(history, now);
    if (!cooldown.allowed) {
      const key: TemplateKey = cooldown.reason === 'cooldown' ? 'v2_otp_resend_cooldown' : 'v2_otp_send_cap';
      const vars: Record<string, string> = cooldown.reason === 'cooldown' ? { seconds: '60' } : {};
      await sendPreAuthText(client, deps, msg, responseLang, key, vars);
      return { handled: true, workerId: null, stepKey: 'identity.verify_otp' };
    }

    const issued = await deps.adapters.identity.issueChallenge({ whatsappNumber: msg.from, lang });
    if (issued.status === 'throttled') {
      return { handled: true, workerId: null, stepKey: 'identity.verify_otp' };
    }
    const newHistory = appendSendTimestamp(history, now);
    await deps.repo.savePreAuthState(client, phoneHash, {
      providerChallengeId: issued.challengeId,
      expiresAt: issued.expiresAt,
      status: 'pending',
      attempts: 0,
      lockedUntil: null,
      candidateUserId,
      context: { ...preAuth.context, otpSendHistory: newHistory },
    });
    await sendPreAuthPrompt(client, deps, msg, 'identity.verify_otp', lang);
    return { handled: true, workerId: null, stepKey: 'identity.verify_otp' };
  }

  const result = await deps.adapters.identity.verifyChallenge(client, {
    challengeId: preAuth.providerChallengeId ?? preAuth.challengeId,
    whatsappNumber: msg.from,
    code: msg.body.trim(),
    attempts: preAuth.attempts,
    lockedUntil: preAuth.lockedUntil,
  });

  if (result.status === 'verified') {
    await deps.repo.setInternalUserRlsContext(client, result.workerId);
    // The ONLY call site in this file for bindVerifiedIdentityAndStartWorkflow.
    const gate = await deps.repo.bindVerifiedIdentityAndStartWorkflow(client, {
      conversationId: session.id,
      phoneHash,
      challengeId: preAuth.challengeId,
      verifiedWorkerId: result.workerId,
      preferredLanguage: preAuth.preferredLanguage,
      workflowVersion: deps.workflowVersion,
      inboundMessageSid: msg.messageSid,
    });
    // A worker who ALREADY FINISHED onboarding — on the web, or on WhatsApp
    // from another number — must not be re-prompted an onboarding step by the
    // act of verifying their OTP.
    //
    // Migration 087 makes `bind_verified_identity_and_start_workflow` ADOPT a
    // ready worker's completed run instead of opening a second one, so this
    // branch now returns a gate whose `current_step_key` is wherever that run
    // finished (`trust.question.3`). Prompting it would ask a ready worker to
    // answer their last trust question again, on this turn only: their next
    // message routes through `routeOnboardingV2`, which hands ready workers
    // off before ever reaching a step handler. That is a one-message defect,
    // and one message is the whole first impression of the channel.
    //
    // The handoff is BYTE-FOR-BYTE the one `routeOnboardingV2` performs for a
    // ready worker's message (onboarding-v2.ts: `gate.lifecycle === 'ready'
    // && gate.status === 'completed' && gate.runId`), including the
    // `session.language` write, so the OTP turn and every turn after it are
    // handled identically. `handled: false` hands this inbound message to the
    // processor's normal post-onboarding path rather than swallowing it.
    if (gate.lifecycle === 'ready' && gate.status === 'completed' && gate.runId) {
      session.language = gate.preferredLanguage;
      // A referral code in this worker's FIRST WhatsApp message was parked by
      // `handleStartStep` under this same `phoneHash` — literally the same
      // string: `routeOnboardingV2` computes it once
      // (`hashNormalizedPhone(msg.from)`) and hands it to both steps, so the
      // park key and this claim key cannot drift.
      //
      // Normally the claim happens at ONBOARDING COMPLETION
      // (`steps/trust.ts` -> `completeOnboarding`). This worker already
      // completed, on the web, so that moment is behind them and will never
      // come again on WhatsApp: without this the parked claim sits unclaimed
      // forever and the referrer is never credited. These are exactly the
      // people a referral link sends to the website in the first place.
      //
      // SAVEPOINT-isolated for the same reason the start-step hook is: this
      // runs inside the processor's open transaction, and an unguarded
      // failure here would abort the whole turn and cost the worker their
      // welcome message over a referral bookkeeping error. Static metric
      // only — never the token, the number, or the hash.
      try {
        await client.query('SAVEPOINT referral_ready_bind');
        await claimPendingReferral(client, phoneHash, gate.userId, now);
        await client.query('RELEASE SAVEPOINT referral_ready_bind');
      } catch {
        try {
          await client.query('ROLLBACK TO SAVEPOINT referral_ready_bind');
        } catch {
          // The transaction is already unusable; the caller's retry/DLQ
          // handling takes over as it would for any other failed statement.
        }
        console.error(JSON.stringify({ metric: 'ReferralReadyBindClaimFailed' }));
      }
      console.log(JSON.stringify({
        metric: 'OnboardingOtpBoundReadyWorker',
        runId: gate.runId,
        currentStepKey: gate.currentStepKey,
      }));
      return { handled: false, handoff: 'ready', workerId: gate.userId, stepKey: 'ready' };
    }

    const stepKey = gate.currentStepKey ?? 'legal.review';
    await sendStepPrompt(client, deps, gate.userId, stepKey, gate.preferredLanguage, now, gate.runId!, msg.messageSid, `bind:${now.getTime()}`);
    return { handled: true, workerId: gate.userId, stepKey };
  }

  if (result.status === 'invalid') {
    // The three-strike lockout only works if the returned attempts count is
    // persisted back through savePreAuthState — this is that persistence.
    //
    // Cognito rotates the CUSTOM_CHALLENGE session on every wrong answer;
    // the NEXT submission is only valid against the rotated session, so it
    // must be persisted alongside the count. Built conditionally rather
    // than passing `providerChallengeId: undefined`: savePreAuthState uses
    // a `key in patch` check, so a present-but-undefined key would be
    // serialized into the JSONB patch. null = the provider gave us nothing
    // new (thrown non-session error) — keep the stored session so the next
    // attempt resolves to 'expired' → RESEND.
    const patch: Partial<PreAuthState> = { attempts: result.attempts };
    if (result.rotatedChallengeId) {
      patch.providerChallengeId = result.rotatedChallengeId;
    }
    await deps.repo.savePreAuthState(client, phoneHash, patch);
    await sendPreAuthText(
      client, deps, msg, responseLang,
      'v2_otp_invalid', { attempts: String(result.attemptsRemaining) },
    );
    return { handled: true, workerId: null, stepKey: 'identity.verify_otp' };
  }

  if (result.status === 'expired') {
    await deps.repo.savePreAuthState(client, phoneHash, { status: 'expired' });
    await sendPreAuthText(client, deps, msg, responseLang, 'v2_otp_expired');
    return { handled: true, workerId: null, stepKey: 'identity.verify_otp' };
  }

  // result.status === 'locked'
  const wasAlreadyLocked = Boolean(preAuth.lockedUntil && preAuth.lockedUntil.getTime() > now.getTime());
  if (!wasAlreadyLocked) {
    console.warn(JSON.stringify({
      metric: 'WhatsAppOtpLock',
      workflowVersion: deps.workflowVersion,
      stepKey: 'identity.verify_otp',
      lockMinutes: 15,
    }));
  }
  await deps.repo.savePreAuthState(client, phoneHash, { status: 'locked', lockedUntil: result.lockedUntil });
  await sendPreAuthText(client, deps, msg, responseLang, 'v2_otp_locked', { minutes: '15' });
  return { handled: true, workerId: null, stepKey: 'identity.verify_otp' };
}
