/**
 * WhatsApp v2 onboarding router — the authoritative command gate that runs
 * ahead of every bound-step dispatch. Moved verbatim out of
 * `../onboarding-v2.ts` (pure move, no behavior change).
 */

import type { PoolClient } from 'pg';
import type { Lang } from '../lib/templates';
import {
  detectCommandLang,
  isLanguageCommand,
  detectLanguageSelectionCommand,
  isResendCommand,
  isOnboardingHelpCommand,
  classifyBlockedCommand,
  classifyBlockedCommandExact,
} from '../lib/onboarding-language';
import type { OnboardingV2Deps, OnboardingV2InboundMessage, OnboardingV2Session, RouteResult } from './types';
import { sendTemplateMessage, repeatCurrentPrompt } from './delivery';

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

// ── The command gate ─────────────────────────────────────────────────

export async function applyGate(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  params: {
    stepKey: string;
    workerId: string;
    workflowRunId: string;
    expectedLockVersion: number;
    lang: Lang;
    responseLang: Lang;
    now: Date;
  },
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

  if (UNIMPLEMENTED_STEPS.has(stepKey)) {
    console.warn(JSON.stringify({ metric: 'OnboardingGateBlocked', command: 'unrelated', stepKey }));
    await sendTemplateMessage(client, deps, workerId, stepKey, responseLang, 'v2_gate_blocked', {}, now, workflowRunId, msg.messageSid, 'unrelated');
    await repeatCurrentPrompt(client, session, deps, workerId, stepKey, lang, now, workflowRunId, msg.messageSid);
    return { handled: true, workerId, stepKey };
  }

  return null;
}
