/**
 * WhatsApp v2 onboarding router — shared step-advancement helpers: language
 * resolution and the profile-field → next-step / profile-complete → trust
 * transitions. Moved verbatim out of `../onboarding-v2.ts` (pure move, no
 * behavior change). `effectiveLang` lives here (not in `steps/legal.ts`)
 * because it's used by transitions, legal, and trust alike.
 */

import type { PoolClient } from 'pg';
import type { WorkflowStepKey } from '../lib/onboarding-types';
import type { WorkerGate } from '../lib/onboarding-repository';
import type { Lang } from '../lib/templates';
import { loadProfileFromDb } from '../lib/profile-flow';
import { resolveNextProfileStep } from '../lib/onboarding-profile-resolver';
import type { ProfileField } from '../lib/flows';
import type { OnboardingV2Deps, OnboardingV2InboundMessage, OnboardingV2Session, RouteResult } from './types';
import { sendTrustPrompt, sendStepPrompt, repeatCurrentPrompt } from './delivery';

/** A durable IDIOMA/LANGUAGE override (see applyGate) takes precedence over
 * whatever preferred_language the run was bound with — used for every
 * subsequent step prompt, not just the confirmation reply itself. */
export function effectiveLang(session: OnboardingV2Session, gate: WorkerGate): Lang {
  return (session.state_context?.v2PreferredLanguageOverride as Lang | undefined)
    ?? gate.preferredLanguage;
}

// ── Shared: profile-complete → trust handoff ─────────────────────────────

/**
 * Sole call site for advancing a run from "the last profile field was just
 * captured" into the trust flow.
 *
 * The `worker_profiles`/`worker_skills` sync runs HERE, at the top, before
 * `advanceWorkflow`. It has to be at this point rather than at any individual
 * field's handler: `syncProfileForTrustHandoff` fails closed on a missing
 * availability, and availability is the LAST field the resolver asks for. Run
 * it any earlier — e.g. at profile.trade — and every worker deadlocks on a
 * field they have not been asked for yet.
 *
 * Failing closed matters because lifecycle `ready` is a promise to the rest of
 * the product: the web apply flow and the matching engine both reject a worker
 * with no name, no skill, no availability, or no location. Better to hold the
 * worker on the current prompt than to advance them into a state the product
 * cannot honor.
 */
async function advanceProfileCompleteToTrust(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  fromStepKey: WorkflowStepKey,
  contextPatch: Record<string, unknown>,
  reason: string,
  now: Date,
): Promise<RouteResult> {
  const sync = await deps.adapters.profile.syncProfileForTrustHandoff(client, gate.userId);
  if (!sync.ready) {
    console.warn(JSON.stringify({
      metric: 'OnboardingGateBlocked',
      command: 'profile_incomplete',
      stepKey: fromStepKey,
      missing: sync.missing,
    }));
    await repeatCurrentPrompt(
      client, session, deps, gate.userId, fromStepKey,
      effectiveLang(session, gate), now, gate.runId!, msg.messageSid,
    );
    return { handled: true, workerId: gate.userId, stepKey: fromStepKey };
  }

  const updated = await deps.repo.advanceWorkflow(client, {
    runId: gate.runId!,
    expectedLockVersion: gate.lockVersion!,
    fromStepKey,
    toStepKey: 'trust.question.1',
    contextPatch,
    inboundMessageSid: msg.messageSid,
    reason,
  });
  await sendTrustPrompt(
    client, deps, updated.userId, 'trust.question.1', effectiveLang(session, updated),
    now, gate.runId!, msg.messageSid, `${reason}:${now.getTime()}`, session.state_context,
  );
  return { handled: true, workerId: updated.userId, stepKey: 'trust.question.1' };
}

/**
 * Shared post-field-capture transition used by every profile-collecting
 * handler (legal acceptance included): reload the worker's DB-persisted
 * profile, ask the pure resolver (`resolveNextProfileStep`, V1/V2 parity
 * fix) which of the seven canonical fields is still missing, and advance
 * there — or, when the resolver reports the profile is complete, hand off
 * to `advanceProfileCompleteToTrust`.
 *
 * This is what replaces the old hardcoded
 * legal.review → profile.name → profile.location → profile.trade →
 * trust.question.1 chain: every field the worker already has on file (e.g.
 * a resuming or partially AI-extracted profile) is skipped rather than
 * re-asked.
 *
 * `collectedOverride` lets a caller tell the resolver about an answer that
 * isn't (yet) reflected in `dbFilled` — used by `handleCustomTrade`, whose
 * adapter does not yet persist `main_trade_other` (a concurrent change adds
 * that), so it passes the just-answered profession through here instead of
 * relying on a DB read that won't see it. That override is also merged with
 * `session.state_context.v2CustomTradeText` (set by `handleCustomTrade`,
 * durable across turns per this router's state_context contract) so EVERY
 * subsequent call — not just the one immediately after profile.custom_trade
 * — keeps treating main_trade_other as answered, until the sibling
 * saveCustomTrade change lands and dbFilled reflects it directly.
 */
export async function advanceProfileToNextStep(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  fromStepKey: WorkflowStepKey,
  contextPatch: Record<string, unknown>,
  reason: string,
  now: Date,
  collectedOverride: Partial<Record<ProfileField, string | boolean>> = {},
): Promise<RouteResult> {
  const dbFilled = await loadProfileFromDb(client, gate.userId);
  const customTradeText = session.state_context?.v2CustomTradeText as string | undefined;
  const mergedOverride: Partial<Record<ProfileField, string | boolean>> = customTradeText
    ? { main_trade_other: customTradeText, ...collectedOverride }
    : collectedOverride;
  const nextStep = resolveNextProfileStep(dbFilled, mergedOverride);

  if (nextStep === null) {
    return advanceProfileCompleteToTrust(client, session, msg, deps, gate, fromStepKey, contextPatch, reason, now);
  }

  const updated = await deps.repo.advanceWorkflow(client, {
    runId: gate.runId!,
    expectedLockVersion: gate.lockVersion!,
    fromStepKey,
    toStepKey: nextStep,
    contextPatch,
    inboundMessageSid: msg.messageSid,
    reason,
  });
  await sendStepPrompt(
    client, deps, updated.userId, nextStep, effectiveLang(session, updated),
    now, gate.runId!, msg.messageSid, `${reason}:${now.getTime()}`, session.state_context,
  );
  return { handled: true, workerId: updated.userId, stepKey: nextStep };
}
