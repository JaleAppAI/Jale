/**
 * WhatsApp v2 onboarding router — outbound delivery helpers (pre-auth and
 * bound-step phases). Moved verbatim out of `../onboarding-v2.ts` (pure
 * move, no behavior change). See the section comments below for the
 * Design A pre-auth/bound-step delivery split rationale.
 */

import type { PoolClient } from 'pg';
import type { WorkerMessageIntentInput } from '../lib/onboarding-types';
import { t, type Lang, type TemplateKey } from '../lib/templates';
import { shouldRepeatPrompt } from '../lib/onboarding-language';
import type { OnboardingV2Deps, OnboardingV2InboundMessage, OnboardingV2Session } from './types';
import { STEP_ROUTING, DEFAULT_ROUTING } from './constants';
import { buildPromptForStep } from './prompts';

// ── Pre-auth delivery (Design A) ────────────────────────────────────────
//
// start.choose_language / identity.verify_otp have no bound user_id (a
// net-new worker has no `users` row, and `worker_message_intents.user_id`
// is NOT NULL), so their prompts travel the phone/inbound-keyed outbox
// reply origin — never the user-bound intent gateway, never a direct send.
// Interactive prompts (start invitation, OTP) carry a real Twilio content
// template; transient status replies (invalid/expired/locked/cooldown) are
// plain bilingual text.

export async function sendPreAuthPrompt(
  client: PoolClient,
  deps: OnboardingV2Deps,
  msg: OnboardingV2InboundMessage,
  stepKey: string,
  lang: Lang,
): Promise<void> {
  const prompt = buildPromptForStep(stepKey, lang, deps);
  await deps.enqueuePreAuthPrompt(client, msg.messageSid, msg.from, prompt);
}

export async function sendPreAuthText(
  client: PoolClient,
  deps: OnboardingV2Deps,
  msg: OnboardingV2InboundMessage,
  lang: Lang,
  key: TemplateKey,
  vars: Record<string, string> = {},
): Promise<void> {
  await deps.enqueuePreAuthText(client, msg.messageSid, msg.from, t(key, lang, vars));
}

// ── Bound-step delivery (post-binding, user_id guaranteed) ──────────────

export async function sendStepPrompt(
  client: PoolClient,
  deps: OnboardingV2Deps,
  workerId: string,
  stepKey: string,
  lang: Lang,
  now: Date,
  workflowRunId: string,
  inboundMessageSid: string,
  _dedupeSuffix: string,
  stateContext?: Record<string, unknown>,
): Promise<void> {
  const routing = STEP_ROUTING[stepKey] ?? DEFAULT_ROUTING;
  const prompt = buildPromptForStep(stepKey, lang, deps, stateContext);
  const input: WorkerMessageIntentInput = {
    workerId,
    category: routing.category,
    ownerService: routing.ownerService,
    sourceType: `onboarding_v2:${stepKey}`,
    sourceId: workflowRunId,
    dedupeKey: `v2:prompt:${stepKey}:${workerId}:${inboundMessageSid}`,
    priority: routing.priority,
    expiresAt: null,
    payload: {
      templateName: prompt.templateName,
      variables: prompt.variables,
      fallbackBody: prompt.fallbackBody,
      lang,
    },
  };
  await deps.enqueueWorkerMessage(client, input, now);
}

export async function sendTemplateMessage(
  client: PoolClient,
  deps: OnboardingV2Deps,
  workerId: string,
  stepKey: string,
  lang: Lang,
  key: TemplateKey,
  vars: Record<string, string>,
  now: Date,
  workflowRunId: string,
  inboundMessageSid: string,
  tag: string,
): Promise<void> {
  const routing = STEP_ROUTING[stepKey] ?? DEFAULT_ROUTING;
  const body = t(key, lang, vars);
  const input: WorkerMessageIntentInput = {
    workerId,
    category: routing.category,
    ownerService: routing.ownerService,
    sourceType: `onboarding_v2:${key}`,
    sourceId: workflowRunId,
    dedupeKey: `v2:${key}:${workerId}:${inboundMessageSid}:${tag}`,
    priority: routing.priority,
    expiresAt: null,
    payload: { body, lang },
  };
  await deps.enqueueWorkerMessage(client, input, now);
}

/**
 * Sends an error notice AND the current step's question as ONE message —
 * error line first, question underneath. Exists because sending them as two
 * intents cannot guarantee handset order: both carry the same routing
 * priority and are written in the same transaction, and even sequential
 * Twilio sends milliseconds apart can arrive reordered — live testing of
 * the voice trust answers (2026-07-27) showed the re-asked question landing
 * BEFORE the "we could not process that voice note" notice, which reads as
 * a non-sequitur. A single message can never invert.
 *
 * Only for steps whose prompt is plain text (`templateName: ''` from
 * `buildPromptForStep`) — the trust questions today. A templated step's
 * interactive prompt cannot be concatenated into a body; those steps keep
 * the two-message path.
 */
export async function sendErrorWithCurrentPrompt(
  client: PoolClient,
  session: OnboardingV2Session,
  deps: OnboardingV2Deps,
  workerId: string,
  stepKey: string,
  lang: Lang,
  errorKey: TemplateKey,
  now: Date,
  workflowRunId: string,
  inboundMessageSid: string,
  tag: string,
): Promise<void> {
  const routing = STEP_ROUTING[stepKey] ?? DEFAULT_ROUTING;
  const prompt = buildPromptForStep(stepKey, lang, deps, session.state_context);
  const body = `${t(errorKey, lang)}\n\n${prompt.fallbackBody}`;
  const input: WorkerMessageIntentInput = {
    workerId,
    category: routing.category,
    ownerService: routing.ownerService,
    sourceType: `onboarding_v2:${errorKey}_with_prompt`,
    sourceId: workflowRunId,
    dedupeKey: `v2:${errorKey}+prompt:${workerId}:${inboundMessageSid}:${tag}`,
    priority: routing.priority,
    expiresAt: null,
    payload: { body, lang },
  };
  await deps.enqueueWorkerMessage(client, input, now);
  // The question just went out (inside this message) — record it so the
  // repeat-prompt cooldown doesn't immediately send it again.
  session.state_context[`v2LastPromptAt:${stepKey}`] = now.toISOString();
}

/** Thin, named alias over `sendStepPrompt` for the trust-question steps —
 * kept distinct (rather than inlined) so the trade/trust-set-dependent
 * prompt path has one obvious call site to change later (e.g. a real Twilio
 * content template for trust questions). */
export async function sendTrustPrompt(
  client: PoolClient,
  deps: OnboardingV2Deps,
  workerId: string,
  stepKey: string,
  lang: Lang,
  now: Date,
  workflowRunId: string,
  inboundMessageSid: string,
  dedupeSuffix: string,
  stateContext: Record<string, unknown>,
): Promise<void> {
  await sendStepPrompt(client, deps, workerId, stepKey, lang, now, workflowRunId, inboundMessageSid, dedupeSuffix, stateContext);
}

export async function repeatCurrentPrompt(
  client: PoolClient,
  session: OnboardingV2Session,
  deps: OnboardingV2Deps,
  workerId: string,
  stepKey: string,
  lang: Lang,
  now: Date,
  workflowRunId: string,
  inboundMessageSid: string,
): Promise<void> {
  const key = `v2LastPromptAt:${stepKey}`;
  const lastIso = (session.state_context?.[key] as string | undefined) ?? null;
  if (!shouldRepeatPrompt(lastIso, now)) return;
  await sendStepPrompt(client, deps, workerId, stepKey, lang, now, workflowRunId, inboundMessageSid, `repeat:${now.getTime()}`, session.state_context);
  session.state_context[key] = now.toISOString();
}

export function readHistory(context: Record<string, unknown> | undefined, key: string): string[] {
  const raw = context?.[key];
  return Array.isArray(raw) ? (raw as string[]) : [];
}
