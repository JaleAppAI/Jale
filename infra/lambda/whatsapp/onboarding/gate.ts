/**
 * WhatsApp v2 onboarding router — the authoritative command gate that runs
 * ahead of every bound-step dispatch. Moved verbatim out of
 * `../onboarding-v2.ts` (pure move, no behavior change).
 */

import type { PoolClient } from 'pg';
import type { Lang } from '../lib/templates';
import type { WorkflowStepKey } from '../lib/onboarding-types';
import {
  detectCommandLang,
  isLanguageCommand,
  detectLanguageSelectionCommand,
  isResendCommand,
  isOnboardingHelpCommand,
  isRestartCommand,
  isBackCommand,
  classifyBlockedCommand,
  classifyBlockedCommandExact,
} from '../lib/onboarding-language';
import { isExactGreetingKeyword, isSupportCommand } from '../lib/flows';
import type { OnboardingV2Deps, OnboardingV2InboundMessage, OnboardingV2Session, RouteResult } from './types';
import { sendTemplateMessage, sendStepPrompt, repeatCurrentPrompt } from './delivery';

/** Free-text answer steps: a blocked-command fuzzy match here would swallow
 * legitimate answers (e.g. the name "Chata" matching "chats" at
 * edit-distance 1), so these steps are gated with the exact-only
 * `classifyBlockedCommandExact` instead of the fuzzy `classifyBlockedCommand`
 * used everywhere else — see `applyGate`. */
const FREE_TEXT_STEPS = new Set<string>([
  'profile.name',
  'profile.custom_trade',
  'trust.question.1',
  'trust.question.2',
  'trust.question.3',
]);

/** Steps with no real handler yet. Migration 050 widened the step-key
 * CHECK/union ahead of their handlers landing; without this gate,
 * `handleProfileAndTrust`'s switch would throw `unhandled bound step` for
 * any of these instead of replying with a graceful gate-blocked prompt.
 * profile.voice_choice / profile.voice_processing are intentionally NOT
 * listed here — Stream B (full voice profile intake) implements them. */
const UNIMPLEMENTED_STEPS = new Set<string>([
  'profile.photo',
  'profile.photo_type',
]);

/** RESTART/REINICIAR and BACK/ATRAS (see below) are recognized only within
 * the profile-collection and trust-question steps — not at legal.review (a
 * legal decision isn't an "answer" to redo) and not at the pre-auth/OTP
 * steps (there is no bound workflow run yet to restart or step back
 * within). Voice steps (profile.voice_choice/profile.voice_processing) ARE
 * included: they are `profile.*`. */
const PROFILE_OR_TRUST_STEP = /^(profile\.|trust\.question\.)/;

/** `session.state_context` keys the voice pipeline and the trust-question
 * generator stash mid-run. RESTART wipes all of them so a worker who
 * restarts gets a genuinely fresh run: leaving a stale `v2VoiceExecutionArn`
 * behind would make an OLD (pre-restart) voice-pipeline completion event
 * look "current" again if it arrived after the restart, and leaving a stale
 * `v2TrustQuestions`/`v2ProfileTrade` behind would replay the PREVIOUS
 * trade's trust questions instead of re-seeding for whatever trade the
 * worker picks this time. */
const RESTART_CLEARED_STATE_CONTEXT_KEYS = [
  'v2VoiceExecutionArn',
  'v2VoiceStartedAt',
  'v2TrustQuestions',
  'v2TrustSource',
  'v2QuestionSetVersion',
  'v2RubricVersion',
  'v2ProfileTrade',
  'v2CustomTradeText',
] as const;

interface GateStepParams {
  stepKey: string;
  workerId: string;
  workflowRunId: string;
  expectedLockVersion: number;
  lang: Lang;
  responseLang: Lang;
  now: Date;
}

/**
 * RESTART/REINICIAR: clears the seven profile-answer fields (via the new
 * `clearProfileAnswers` repo function), wipes the voice/trust-question
 * `state_context` scratch keys so a re-run re-seeds them fresh, and sends
 * the worker back to `profile.name`. Never touches legal/consent/OTP/
 * lifecycle/trust_signals state — this is a "redo my answers" command, not
 * an account reset.
 */
async function handleRestartCommand(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  params: GateStepParams,
): Promise<RouteResult> {
  const { stepKey, workerId, workflowRunId, expectedLockVersion, lang, responseLang, now } = params;

  console.log(JSON.stringify({ metric: 'OnboardingWorkerRestarted', fromStepKey: stepKey, runId: workflowRunId }));

  await deps.repo.clearProfileAnswers(client, workerId);

  for (const key of RESTART_CLEARED_STATE_CONTEXT_KEYS) {
    delete session.state_context[key];
  }

  const updated = await deps.repo.advanceWorkflow(client, {
    runId: workflowRunId,
    expectedLockVersion,
    fromStepKey: stepKey as WorkflowStepKey,
    toStepKey: 'profile.name',
    contextPatch: { restartedAt: now.toISOString() },
    inboundMessageSid: msg.messageSid,
    reason: 'worker_restart',
  });

  await sendTemplateMessage(client, deps, workerId, 'profile.name', responseLang, 'v2_restarted', {}, now, workflowRunId, msg.messageSid, 'restart');
  await sendStepPrompt(
    client, deps, updated.userId, 'profile.name', lang, now, workflowRunId, msg.messageSid,
    `restart:${now.getTime()}`, session.state_context,
  );
  return { handled: true, workerId: updated.userId, stepKey: 'profile.name' };
}

/**
 * BACK/ATRAS: moves the run to the step immediately before its current one,
 * per the transition history (`findPreviousStepKey`). Blocked (v2_gate_blocked
 * + reprompt) when there is nowhere to go back to: the current step is
 * `profile.name` (the first profile question), no qualifying prior
 * transition exists, or the prior step found isn't itself a profile/trust
 * step (defensive — should never happen given `PROFILE_OR_TRUST_STEP`
 * already scopes which steps dispatch here, but a transition history could
 * in principle predate that scoping).
 */
async function handleBackCommand(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  params: GateStepParams,
): Promise<RouteResult> {
  const { stepKey, workerId, workflowRunId, expectedLockVersion, lang, responseLang, now } = params;

  const blocked = async (): Promise<RouteResult> => {
    console.warn(JSON.stringify({ metric: 'OnboardingGateBlocked', command: 'back', stepKey }));
    await sendTemplateMessage(client, deps, workerId, stepKey, responseLang, 'v2_gate_blocked', {}, now, workflowRunId, msg.messageSid, 'back');
    await repeatCurrentPrompt(client, session, deps, workerId, stepKey, lang, now, workflowRunId, msg.messageSid);
    return { handled: true, workerId, stepKey };
  };

  // The very first profile step has nowhere to go back to.
  if (stepKey === 'profile.name') {
    return blocked();
  }

  const prevStepKey = await deps.repo.findPreviousStepKey(client, workflowRunId, stepKey as WorkflowStepKey);
  if (!prevStepKey || !PROFILE_OR_TRUST_STEP.test(prevStepKey)) {
    return blocked();
  }

  const updated = await deps.repo.advanceWorkflow(client, {
    runId: workflowRunId,
    expectedLockVersion,
    fromStepKey: stepKey as WorkflowStepKey,
    toStepKey: prevStepKey,
    contextPatch: {},
    inboundMessageSid: msg.messageSid,
    reason: 'worker_back',
  });
  await sendStepPrompt(
    client, deps, updated.userId, prevStepKey, lang, now, workflowRunId, msg.messageSid,
    `back:${now.getTime()}`, session.state_context,
  );
  return { handled: true, workerId: updated.userId, stepKey: prevStepKey };
}

// ── The command gate ─────────────────────────────────────────────────

export async function applyGate(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  params: GateStepParams,
): Promise<RouteResult | null> {
  const { stepKey, workerId, workflowRunId, expectedLockVersion, lang, responseLang, now } = params;
  const isInteractive = Boolean(msg.interactivePayload);
  const body = msg.body ?? '';

  if (!isInteractive && isOnboardingHelpCommand(body)) {
    await sendTemplateMessage(client, deps, workerId, stepKey, responseLang, 'v2_gate_blocked', {}, now, workflowRunId, msg.messageSid, 'help');
    await repeatCurrentPrompt(client, session, deps, workerId, stepKey, lang, now, workflowRunId, msg.messageSid);
    return { handled: true, workerId, stepKey };
  }

  if (!isInteractive && isLanguageCommand(body)) {
    // The word itself names the target language (like START/EMPEZAR),
    // unlike JOBS/TRABAJOS-style commands whose reply merely matches the
    // typed language.
    const cmdLang = detectLanguageSelectionCommand(body) ?? detectCommandLang(body) ?? responseLang;
    await deps.repo.setRunPreferredLanguage(client, {
      runId: workflowRunId,
      expectedLockVersion,
      preferredLanguage: cmdLang,
    });
    await sendTemplateMessage(client, deps, workerId, stepKey, cmdLang, 'v2_language_changed', {}, now, workflowRunId, msg.messageSid, 'lang');
    // IDIOMA/LANGUAGE is the one command that persists a preference change
    // (unlike JOBS/CHATS/PROFILE, whose reply is transient) — per the spec's
    // "LANGUAGE/IDIOMA persists the new preference." The override lives in
    // state_context — durable across turns via the processor's per-message
    // writeback (Task 6) — because the bound workflow run's
    // `preferred_language` column (`worker_workflow_runs.preferred_language`,
    // owned by the C4 repository lane) has no exposed mutator here.
    //
    // KNOWN CROSS-LANE GAP (flag for C6): the release renderer's
    // `loadVerifiedRecipient` (lib/onboarding-renderers.ts) reads language
    // from that SAME DB column, not from this override — so a worker who
    // switches languages mid-onboarding gets subsequent v2 prompts in the
    // new language but C6's eventual `worker.ready` release-lane
    // confirmation in the ORIGINAL bound language, unless C4/C6 add a real
    // column mutator this router can call instead of this in-lane override.
    session.state_context.v2PreferredLanguageOverride = cmdLang;
    return { handled: true, workerId, stepKey };
  }

  if (!isInteractive && isResendCommand(body) && stepKey !== 'identity.verify_otp') {
    console.warn(JSON.stringify({ metric: 'OnboardingGateBlocked', command: 'resend', stepKey }));
    await sendTemplateMessage(client, deps, workerId, stepKey, responseLang, 'v2_gate_blocked', {}, now, workflowRunId, msg.messageSid, 'resend');
    await repeatCurrentPrompt(client, session, deps, workerId, stepKey, lang, now, workflowRunId, msg.messageSid);
    return { handled: true, workerId, stepKey };
  }

  if (!isInteractive && PROFILE_OR_TRUST_STEP.test(stepKey) && isRestartCommand(body)) {
    return handleRestartCommand(client, session, msg, deps, params);
  }

  if (!isInteractive && PROFILE_OR_TRUST_STEP.test(stepKey) && isBackCommand(body)) {
    return handleBackCommand(client, session, msg, deps, params);
  }

  if (!isInteractive) {
    // Free-text answer steps (name, custom trade, trust questions) use the
    // exact-only classifier so a legitimate answer like "Chata" can never be
    // fuzzy-matched into the `chats` command; every other step keeps the
    // fuzzy classifier so typo'd commands ("trabjos") still get caught.
    const blocked = FREE_TEXT_STEPS.has(stepKey)
      ? classifyBlockedCommandExact(body)
      : classifyBlockedCommand(body);
    if (blocked) {
      console.warn(JSON.stringify({ metric: 'OnboardingGateBlocked', command: blocked, stepKey }));
      await sendTemplateMessage(client, deps, workerId, stepKey, responseLang, 'v2_gate_blocked', {}, now, workflowRunId, msg.messageSid, blocked);
      await repeatCurrentPrompt(client, session, deps, workerId, stepKey, lang, now, workflowRunId, msg.messageSid);
      return { handled: true, workerId, stepKey };
    }
  }

  if (!isInteractive && FREE_TEXT_STEPS.has(stepKey)) {
    // A greeting ("Hola") or the SUPPORT/SOPORTE escape hatch typed at a
    // free-text answer step (name, custom trade, trust answers) must never
    // be saved verbatim as the answer — this is the exact production defect
    // that named a worker "Hola". Both checks are exact-normalized (trim +
    // lowercase, the same normalization the underlying v1 helpers use)
    // rather than the fuzzy/prefix matching `isGreetingKeyword` itself uses
    // elsewhere: "Hola Maria" contains a greeting but IS a genuine name, and
    // must still be accepted and saved.
    const isGreeting = isExactGreetingKeyword(body);
    const command = isGreeting ? 'greeting' : (isSupportCommand(body) ? 'support' : null);
    if (command) {
      console.warn(JSON.stringify({ metric: 'OnboardingGateBlocked', command, stepKey }));
      await sendTemplateMessage(client, deps, workerId, stepKey, responseLang, 'v2_gate_blocked', {}, now, workflowRunId, msg.messageSid, command);
      await repeatCurrentPrompt(client, session, deps, workerId, stepKey, lang, now, workflowRunId, msg.messageSid);
      return { handled: true, workerId, stepKey };
    }
  }

  if (UNIMPLEMENTED_STEPS.has(stepKey)) {
    console.warn(JSON.stringify({ metric: 'OnboardingGateBlocked', command: 'unrelated', stepKey }));
    await sendTemplateMessage(client, deps, workerId, stepKey, responseLang, 'v2_gate_blocked', {}, now, workflowRunId, msg.messageSid, 'unrelated');
    await repeatCurrentPrompt(client, session, deps, workerId, stepKey, lang, now, workflowRunId, msg.messageSid);
    return { handled: true, workerId, stepKey };
  }

  return null;
}
