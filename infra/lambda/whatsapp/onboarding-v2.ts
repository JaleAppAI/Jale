/**
 * Task 4: Router — Entry, OTP, Legal, and the Authoritative Command Gate.
 *
 * This module owns the WhatsApp v2 onboarding lane's message routing:
 *   - start.choose_language / identity.verify_otp (pre-auth, phone-hash
 *     keyed, no account/lifecycle/workflow-run exists yet)
 *   - legal.review (first step of the bound workflow run, entered
 *     automatically by `bindVerifiedIdentityAndStartWorkflow`)
 *   - the command gate that runs ahead of every bound-step dispatch
 *
 * Canonical cross-lane types (`WorkflowStepKey`, `WorkflowRunStatus`,
 * `PreferredLanguage`, `MessageCategory`, `OwnerService`,
 * `WorkerMessageIntentInput`, `DELIVERY_POLICY_VERSION`, ...) live in
 * `./lib/onboarding-types` and are imported, never redeclared, here.
 * `PreAuthState` / `WorkerGate` are owned by `./lib/onboarding-repository`
 * (Task/lane C4) and imported the same way.
 *
 * Outbound delivery splits by phase (Design A, contract-repaired 2026-07-22).
 * `worker_message_intents.user_id` is a NOT NULL FK and a net-new worker has
 * NO `users` row before verified OTP, so pre-auth prompts cannot go through
 * `enqueueWorkerMessage`:
 *   - Pre-auth (start.choose_language, identity.verify_otp, and the OTP
 *     invalid/expired/locked/cooldown replies) deliver via the injected
 *     phone/`inbound_message_sid`-keyed reply gateway
 *     (`enqueuePreAuthPrompt` / `enqueuePreAuthText`) — no `user_id`, durable,
 *     drained post-commit, never a direct send, never deferrable.
 *   - Bound steps (legal.review onward, after
 *     `bindVerifiedIdentityAndStartWorkflow`) use `enqueueWorkerMessage`,
 *     where `user_id` is guaranteed.
 * This module never writes the outbox table directly nor calls a legacy send
 * helper — delivery is always through an injected dep. `candidateUserId` is
 * persisted on the pre-auth challenge for a phone that matches a pre-existing
 * account, but delivery NEVER depends on it (a net-new worker has none).
 *
 * This file is the router's entry point: `routeOnboardingV2`,
 * `routeBoundStep`, `handleProfileAndTrust`, plus a re-export of the public
 * types every caller/test imports from this exact path. Everything else
 * was split verbatim into `./onboarding/` (pure move, no behavior change).
 */

import type { PoolClient } from 'pg';
import type { WorkflowStepKey } from './lib/onboarding-types';
import type { WorkerGate } from './lib/onboarding-repository';
import type { Lang } from './lib/templates';
import { resolveResponseLanguage } from './lib/onboarding-language';
import type {
  OnboardingV2Session,
  OnboardingV2InboundMessage,
  OnboardingV2Deps,
  RouteResult,
} from './onboarding/types';
import { applyGate } from './onboarding/gate';
import { handleStartStep } from './onboarding/steps/start';
import { handleOtpStep } from './onboarding/steps/otp';
import { handleLegalStep } from './onboarding/steps/legal';
import {
  handleProfileName,
  handleProfileLocation,
  handleProfileTrade,
  handleCustomTrade,
  handleProfileExperience,
  handleProfileTransportation,
  handleProfileAvailability,
} from './onboarding/steps/profile';
import { handleTrustQuestion } from './onboarding/steps/trust';

export type {
  OnboardingV2Session,
  OnboardingV2InboundMessage,
  OnboardingV2Deps,
  OnboardingV2RepoDeps,
  RouteResult,
} from './onboarding/types';

// ── Bound: profile/trust dispatch ────────────────────────────────────────

async function handleProfileAndTrust(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  stepKey: WorkflowStepKey,
  lang: Lang,
  now: Date,
): Promise<RouteResult> {
  switch (stepKey) {
    case 'profile.name':
      return handleProfileName(client, session, msg, deps, gate, lang, now);
    case 'profile.location':
      return handleProfileLocation(client, session, msg, deps, gate, lang, now);
    case 'profile.trade':
      return handleProfileTrade(client, session, msg, deps, gate, lang, now);
    case 'profile.custom_trade':
      return handleCustomTrade(client, session, msg, deps, gate, lang, now);
    case 'profile.experience':
      return handleProfileExperience(client, session, msg, deps, gate, lang, now);
    case 'profile.transportation':
      return handleProfileTransportation(client, session, msg, deps, gate, lang, now);
    case 'profile.availability':
      return handleProfileAvailability(client, session, msg, deps, gate, lang, now);
    case 'trust.question.1':
    case 'trust.question.2':
    case 'trust.question.3':
      return handleTrustQuestion(client, session, msg, deps, gate, lang, now, stepKey);
    default:
      // Unreachable given routeBoundStep's dispatch, but keeps this
      // function total rather than silently falling through.
      throw new Error(`unhandled bound step: ${stepKey}`);
  }
}

// ── Bound-step dispatch ─────────────────────────────────────────────────

async function routeBoundStep(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  now: Date,
): Promise<RouteResult> {
  const stepKey = gate.currentStepKey as WorkflowStepKey;
  // A durable IDIOMA/LANGUAGE override (see applyGate) takes precedence over
  // the run's originally-bound preferred_language.
  const lang: Lang = (session.state_context?.v2PreferredLanguageOverride as Lang | undefined)
    ?? gate.preferredLanguage;
  const isInteractive = Boolean(msg.interactivePayload);
  const responseLang = resolveResponseLanguage(lang, msg.body, isInteractive);

  const gateResult = await applyGate(client, session, msg, deps, {
    stepKey,
    workerId: gate.userId,
    workflowRunId: gate.runId!,
    lang,
    expectedLockVersion: gate.lockVersion!,
    responseLang,
    now,
  });
  if (gateResult) return gateResult;

  if (stepKey === 'legal.review') {
    return handleLegalStep(client, session, msg, deps, gate, lang, responseLang, now);
  }

  return handleProfileAndTrust(client, session, msg, deps, gate, stepKey, lang, now);
}

// ── Entry point ──────────────────────────────────────────────────────────

export async function routeOnboardingV2(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
): Promise<RouteResult> {
  const now = deps.adapters.clock.now();
  const phoneHash = deps.hashNormalizedPhone(msg.from);

  if (session.user_id) {
    await deps.repo.setInternalUserRlsContext(client, session.user_id);
  }
  const gate = session.user_id ? await deps.repo.loadWorkerGate(client, session.user_id) : null;
  if (gate) {
    if (gate.lifecycle === 'ready' && gate.status === 'completed' && gate.runId) {
      session.language = gate.preferredLanguage;
      return { handled: false, handoff: 'ready', workerId: gate.userId, stepKey: 'ready' };
    }
    if (
      gate.lifecycle === 'onboarding'
      && gate.runId
      && gate.currentStepKey
      && (gate.status === 'active' || (gate.status === 'declined' && gate.currentStepKey === 'legal.review'))
    ) {
      return routeBoundStep(client, session, msg, deps, gate, now);
    }
    throw new Error('onboarding_gate_inconsistent');
  }

  const preAuth = await deps.repo.loadPreAuthStateForUpdate(client, phoneHash);
  if (preAuth && preAuth.currentStepKey === 'identity.verify_otp') {
    return handleOtpStep(client, session, msg, deps, preAuth, phoneHash, now);
  }

  return handleStartStep(client, session, msg, deps, preAuth, phoneHash, now);
}
