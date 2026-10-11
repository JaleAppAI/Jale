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
import { t, type Lang } from './lib/templates';
import { resolveResponseLanguage } from './lib/onboarding-language';
import type {
  OnboardingV2Session,
  OnboardingV2InboundMessage,
  OnboardingV2Deps,
  RouteResult,
} from './onboarding/types';
import { applyGate } from './onboarding/gate';
import {
  hydrateSessionFromRun,
  persistDurableStateContext,
} from './onboarding/durable-context';
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
import { handleVoiceChoiceStep, handleVoiceProcessingStep, handleVoiceIntakeResult } from './onboarding/steps/voice';
import { sendStepPrompt } from './onboarding/delivery';
import { isVoiceAcceptingStep } from './onboarding/constants';
import { sendTemplateMessage, repeatCurrentPrompt } from './onboarding/delivery';

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
    case 'profile.voice_choice':
      return handleVoiceChoiceStep(client, session, msg, deps, gate, lang, now);
    case 'profile.voice_processing':
      return handleVoiceProcessingStep(client, session, msg, deps, gate, lang, now);
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

/** A durable IDIOMA/LANGUAGE override (see applyGate) takes precedence over
 * the run's originally-bound preferred_language. */
function boundStepLang(session: OnboardingV2Session, gate: WorkerGate): Lang {
  return (session.state_context?.v2PreferredLanguageOverride as Lang | undefined)
    ?? gate.preferredLanguage;
}

/**
 * Everything `routeBoundStep` does AFTER the command gate has declined to
 * intercept: the legal branch, then the profile/trust switch.
 *
 * Split out (R2-C23) so the WEB door can reach the real step handlers WITHOUT
 * the command gate. On WhatsApp the gate must run — plain text equal to
 * `back`/`hola`/`trabajos`/... is a command, not an answer. On the web those
 * same strings arrive as form field values that the worker typed on purpose:
 * a custom trade of "back", a name of "Ayuda". Round-tripping them through
 * the gate would swallow them and reply with WhatsApp copy nobody will read.
 * BACK on the web is its own endpoint (`POST /worker/onboarding/back`), so
 * nothing is lost by skipping the gate here.
 */
async function dispatchBoundStepPostGate(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  now: Date,
  lang: Lang,
  responseLang: Lang,
): Promise<RouteResult> {
  const stepKey = gate.currentStepKey as WorkflowStepKey;
  if (stepKey === 'legal.review') {
    return handleLegalStep(client, session, msg, deps, gate, lang, responseLang, now);
  }
  return handleProfileAndTrust(client, session, msg, deps, gate, stepKey, lang, now);
}

/**
 * The WEB door's entry point into the engine: hydrate the durable
 * `state_context` bag from `worker_workflow_runs.context`, dispatch the
 * worker's value straight at the real step handler (no command gate — see
 * `dispatchBoundStepPostGate`), then write the bag back.
 *
 * The caller owns the transaction, the RLS context and the run lock, exactly
 * as `routeOnboardingV2` does for the processor. The caller must also have
 * rejected steps with no handler (`isUnimplementedBoundStep`) — reaching
 * `handleProfileAndTrust` with one throws `unhandled bound step`, which is a
 * 500 rather than the 422 the web contract owes the browser.
 */
export async function dispatchWebBoundStep(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  now: Date,
): Promise<RouteResult> {
  const lang = boundStepLang(session, gate);
  const responseLang = resolveResponseLanguage(lang, msg.body, Boolean(msg.interactivePayload));
  await hydrateSessionFromRun(client, session, gate.runId!);
  const result = await dispatchBoundStepPostGate(
    client, session, msg, deps, gate, now, lang, responseLang,
  );
  await persistDurableStateContext(client, gate.runId!, session.state_context);
  return result;
}

/**
 * WhatsApp's bound-step path. Wraps the real routing in the same
 * hydrate/persist pair the web door uses, so the durable bag stays in sync
 * whichever door moved the run last — that is what lets a worker pick their
 * trade on the web and answer the SAME three generated questions over
 * WhatsApp, and vice versa. On WhatsApp the hydrate is a no-op (the
 * conversation's own `state_context` already holds every key) and the persist
 * is one extra column-scoped UPDATE per message.
 */
async function routeBoundStep(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  now: Date,
): Promise<RouteResult> {
  await hydrateSessionFromRun(client, session, gate.runId!);
  const result = await routeBoundStepHydrated(client, session, msg, deps, gate, now);
  await persistDurableStateContext(client, gate.runId!, session.state_context);
  return result;
}

async function routeBoundStepHydrated(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  now: Date,
): Promise<RouteResult> {
  const stepKey = gate.currentStepKey as WorkflowStepKey;
  const lang: Lang = boundStepLang(session, gate);
  const isInteractive = Boolean(msg.interactivePayload);
  const responseLang = resolveResponseLanguage(lang, msg.body, isInteractive);

  // Self-heal: a bound run parked on a PRE-AUTH step key. 'start.choose_
  // language' and 'identity.verify_otp' belong to the worker_identity_
  // challenges lane; runs are only legitimately born at 'legal.review' by
  // bind_verified_identity_and_start_workflow, so a bound run can only sit
  // here via operator tooling (the reset CLI once seeded exactly this) or a
  // legacy bad row. Every handler below would fall through to
  // handleProfileAndTrust's terminal throw — which aborts the claim,
  // reprompts an error, and softlocks the worker on every subsequent
  // message. The worker is already OTP-verified (the run is bound), so the
  // correct place to resume is where the bind function would have started
  // them: legal.review.
  if (stepKey === 'start.choose_language' || stepKey === 'identity.verify_otp') {
    console.warn(JSON.stringify({
      metric: 'OnboardingBoundStepSelfHealed',
      fromStepKey: stepKey,
      runId: gate.runId,
    }));
    const healed = await deps.repo.advanceWorkflow(client, {
      runId: gate.runId!,
      expectedLockVersion: gate.lockVersion!,
      fromStepKey: stepKey,
      toStepKey: 'legal.review',
      contextPatch: {},
      inboundMessageSid: msg.messageSid,
      reason: 'self_heal_preauth_step',
    });
    await sendStepPrompt(client, deps, healed.userId, 'legal.review', lang, now, gate.runId!, msg.messageSid, `selfheal:${now.getTime()}`, session.state_context);
    return { handled: true, workerId: healed.userId, stepKey: 'legal.review' };
  }

  // NOTE: synthetic voice-pipeline completion events (`msg.voiceEvent`) are
  // dispatched in `routeOnboardingV2`, BEFORE this function is ever called
  // (Task 7/B5) — a late `#vt`/`#vp` for a ready or completed run must never
  // reach here at all, let alone fall through to the command gate/idle
  // handoff below. See the entry point's own comment for why that dispatch
  // had to move earlier than the ready-lifecycle check.

  // A real voice note (numMedia > 0, no event yet) at a step that doesn't
  // accept one — either the control is off or this isn't a trust question —
  // gets the honest "not supported here" reply instead of silently landing
  // on whatever text-oriented handler the step has, or worse, tripping the
  // command gate's fuzzy classifier on a caption. But a CAPTIONED photo (or
  // any media with usable text/interactive payload attached) must fall
  // through to the ordinary handler exactly as if the caption had arrived
  // with no attachment at all — only a genuinely empty-bodied, non-
  // interactive media message (a real voice note, or a photo sent with no
  // caption) is voice-note copy. Without this, a worker who answers the OTP
  // or a jobs command with a photo captioned "123456"/"TRABAJOS" would have
  // that answer silently discarded in favor of unrelated voice-note copy.
  if (
    (msg.numMedia ?? 0) > 0
    && !msg.voiceEvent
    && !isVoiceAcceptingStep(stepKey, deps.voiceIntake.enabled)
    && (msg.body ?? '').trim().length === 0
    && !isInteractive
  ) {
    await sendTemplateMessage(client, deps, gate.userId, stepKey, responseLang, 'v2_voice_not_supported', {}, now, gate.runId!, msg.messageSid, 'voice_unsupported_step');
    await repeatCurrentPrompt(client, session, deps, gate.userId, stepKey, lang, now, gate.runId!, msg.messageSid);
    return { handled: true, workerId: gate.userId, stepKey };
  }

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

  return dispatchBoundStepPostGate(client, session, msg, deps, gate, now, lang, responseLang);
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

  // Task 7/B5 fix: a synthetic voice-pipeline completion event (`#vt`/`#vp`
  // — see lib/voice-events.ts) must be dispatched HERE, unconditionally and
  // BEFORE the ready-lifecycle handoff just below, regardless of the run's
  // current step. The previous dispatch site (inside routeBoundStep, reached
  // only through the 'onboarding' lifecycle branch) had two failure modes
  // for a LATE event: a ready/completed worker's gate never even reaches
  // routeBoundStep, so its own staleness guard (and metric) never ran at
  // all; and any event that reached routeBoundStep at a step other than
  // trust.question.* fell through to the command gate/idle handoff and told
  // a worker who just finished onboarding "I didn't understand that". Each
  // handler owns a real staleness guard (runId/stepKey/executionArn) that is
  // the sole authority on whether a late event still applies — dispatching
  // unconditionally here just lets that guard actually run. A synthetic
  // event with no gate/run at all (an absent run) is itself stale by
  // definition and is discarded the same way, with the same metric, and
  // never a reply.
  if (msg.voiceEvent) {
    const voiceLang: Lang = gate
      ? ((session.state_context?.v2PreferredLanguageOverride as Lang | undefined) ?? gate.preferredLanguage)
      : (session.language ?? 'es');

    if (msg.voiceEvent.kind === 'trust_answer') {
      if (gate?.runId && gate.currentStepKey && /^trust\.question\.[123]$/.test(gate.currentStepKey)) {
        return handleTrustQuestion(
          client, session, msg, deps, gate, voiceLang, now,
          gate.currentStepKey as 'trust.question.1' | 'trust.question.2' | 'trust.question.3',
        );
      }
      console.warn(JSON.stringify({
        metric: 'OnboardingVoiceTranscriptStale',
        stepKey: gate?.currentStepKey ?? 'absent',
        eventStepKey: msg.voiceEvent.stepKey,
      }));
      return { handled: true, workerId: gate?.userId ?? null, stepKey: gate?.currentStepKey ?? 'unknown' };
    }

    // profile_intake: handleVoiceIntakeResult's own staleness guard already
    // checks `gate.currentStepKey !== 'profile.voice_processing'` generically
    // (no step-key literal-type narrowing needed here), so any gate/run is
    // enough to dispatch into it — including a ready worker's, whose
    // currentStepKey will never be 'profile.voice_processing' again.
    if (gate?.runId) {
      return handleVoiceIntakeResult(client, session, msg, deps, gate, voiceLang, now, msg.voiceEvent);
    }
    console.warn(JSON.stringify({
      metric: 'OnboardingVoiceResultStale',
      currentStepKey: gate?.currentStepKey ?? 'absent',
      eventStepKey: msg.voiceEvent.stepKey,
    }));
    return { handled: true, workerId: gate?.userId ?? null, stepKey: gate?.currentStepKey ?? 'unknown' };
  }

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

  // Pre-auth steps (language choice, OTP) have no voice handler at all — a
  // net-new worker sending a voice note here gets the honest reply over the
  // phone/inbound-keyed pre-auth gateway (no user_id exists yet to route
  // through enqueueWorkerMessage). A CAPTIONED photo must still fall through
  // to the ordinary OTP/start handler below — only a genuinely empty-bodied,
  // non-interactive media message gets the voice-note copy.
  if ((msg.numMedia ?? 0) > 0 && (msg.body ?? '').trim().length === 0 && !msg.interactivePayload) {
    const lang: Lang = preAuth?.preferredLanguage ?? session.language ?? 'es';
    await deps.enqueuePreAuthText(client, msg.messageSid, msg.from, t('v2_voice_not_supported', lang));
    return { handled: true, workerId: null, stepKey: preAuth?.currentStepKey ?? 'start.choose_language' };
  }

  if (preAuth && preAuth.currentStepKey === 'identity.verify_otp') {
    return handleOtpStep(client, session, msg, deps, preAuth, phoneHash, now);
  }

  return handleStartStep(client, session, msg, deps, preAuth, phoneHash, now);
}
