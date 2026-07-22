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
 * Every outbound message — pre-auth or bound, workflow or security — goes
 * through `enqueueWorkerMessage`. This module never calls any of the
 * legacy per-message send helpers and never writes to the outbox table
 * directly.
 *
 * Enqueue key for pre-auth sends: `worker_message_intents.user_id` is a
 * NOT NULL FK, and identity isn't verified/bound yet at
 * start.choose_language / identity.verify_otp, so `RouteResult.workerId`
 * (the verified/bound worker) stays null through that phase. Pre-auth
 * sends instead key off `PreAuthState.candidateUserId` — the pre-existing
 * account a phone number is being matched against (workers sign up before
 * they ever text; WhatsApp v2 verifies and binds an account that already
 * exists, it does not create one). The session's `user_id` is the best
 * available signal for that candidate and seeds `candidateUserId` the
 * first time a phone hash is touched.
 */

import type { PoolClient } from 'pg';
import type {
  MessageCategory,
  OwnerService,
  PreferredLanguage,
  WorkerMessageIntentInput,
  WorkflowStepKey,
} from './lib/onboarding-types';
import type { PreAuthState, WorkerGate } from './lib/onboarding-repository';
import type { OnboardingV2Adapters } from './lib/onboarding-adapters';
import { t, type Lang, type TemplateKey } from './lib/templates';
import {
  parseLanguageChoice,
  detectCommandLang,
  resolveResponseLanguage,
  isLanguageCommand,
  isResendCommand,
  isReviewTermsCommand,
  isOnboardingHelpCommand,
  classifyBlockedCommand,
  evaluateStartCooldown,
  shouldRepeatPrompt,
  appendSendTimestamp,
} from './lib/onboarding-language';
import {
  buildV2StartInvitationPrompt,
  buildV2OtpPrompt,
  buildV2LegalPrompt,
  type InteractivePrompt,
} from './lib/interactive-templates';
import { normalizeCommandText } from './lib/flows';

// ── Session / message shapes the router is handed ──────────────────────

export interface OnboardingV2Session {
  id: string;
  user_id: string | null;
  whatsapp_number: string;
  language: PreferredLanguage;
  conversation_state: string;
  /** Mutable scratch bag this router reads/writes reprompt-cooldown
   * bookkeeping into. Callers persist whatever mutations land here. */
  state_context: Record<string, unknown>;
}

export interface OnboardingV2InboundMessage {
  from: string;
  body: string;
  messageSid: string;
  interactivePayload?: string;
}

export interface RouteResult {
  handled: true;
  workerId: string | null;
  stepKey: string;
}

// ── Locally-composed deps (no canonical types redeclared here) ─────────

export interface OnboardingV2RepoDeps {
  loadPreAuthStateForUpdate: (
    client: PoolClient,
    phoneHash: string,
  ) => Promise<PreAuthState | null>;
  savePreAuthState: (
    client: PoolClient,
    phoneHash: string,
    patch: Partial<PreAuthState>,
  ) => Promise<PreAuthState>;
  bindVerifiedIdentityAndStartWorkflow: (
    client: PoolClient,
    input: {
      conversationId: string;
      phoneHash: string;
      challengeId: string;
      verifiedWorkerId: string;
      preferredLanguage: PreferredLanguage;
      workflowVersion: number;
      inboundMessageSid: string;
    },
  ) => Promise<WorkerGate>;
  loadWorkerGate: (client: PoolClient, workerId: string) => Promise<WorkerGate | null>;
  advanceWorkflow: (
    client: PoolClient,
    input: {
      runId: string;
      expectedLockVersion: number;
      fromStepKey: WorkflowStepKey;
      toStepKey: WorkflowStepKey;
      status?: string;
      contextPatch: Record<string, unknown>;
      inboundMessageSid: string;
      reason: string;
    },
  ) => Promise<WorkerGate>;
  appendTransition: (
    client: PoolClient,
    input: {
      runId: string;
      fromStepKey: WorkflowStepKey | null;
      toStepKey: WorkflowStepKey;
      inboundMessageSid: string | null;
      reason: string;
      metadata?: Record<string, unknown>;
    },
  ) => Promise<{ transitionId: string }>;
}

export interface OnboardingV2Deps {
  adapters: OnboardingV2Adapters;
  repo: OnboardingV2RepoDeps;
  enqueueWorkerMessage: (
    client: PoolClient,
    input: WorkerMessageIntentInput,
    now?: Date,
  ) => Promise<{ intentId: string; decision: unknown }>;
  /**
   * Pre-auth delivery gateway (Design A). Pre-OTP steps
   * (start.choose_language, identity.verify_otp) have no bound `user_id`
   * — a net-new worker has no `users` row at all, and `worker_message_intents.user_id`
   * is a NOT NULL FK — so their prompts CANNOT go through `enqueueWorkerMessage`.
   * They travel the phone/inbound-message-keyed `whatsapp_outbox` reply origin
   * instead (`inbound_message_sid IS NOT NULL AND source_type IS NULL`), which
   * needs no identity, is durable, and is drained post-commit by the existing
   * sweeper — never a direct Twilio send. In production these are the legacy
   * `queueInteractivePrompt` / `queueOutboxText` writers; tests inject fakes.
   */
  enqueuePreAuthPrompt: (
    client: PoolClient,
    inboundMessageSid: string,
    to: string,
    prompt: InteractivePrompt,
  ) => Promise<void>;
  enqueuePreAuthText: (
    client: PoolClient,
    inboundMessageSid: string,
    to: string,
    body: string,
  ) => Promise<void>;
  hashNormalizedPhone: (phone: string) => string;
  tosUrl: string;
  privacyUrl: string;
  workflowVersion: number;
}

// ── Step routing table: which lane (owner/category/priority) a step's
//    prompts and replies travel through ──────────────────────────────

const STEP_ROUTING: Record<string, { ownerService: OwnerService; category: MessageCategory; priority: number }> = {
  'start.choose_language': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'identity.verify_otp': { ownerService: 'identity', category: 'security', priority: 1 },
  'legal.review': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'profile.name': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'profile.location': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'profile.trade': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'profile.custom_trade': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'trust.question.1': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'trust.question.2': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'trust.question.3': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
};
const DEFAULT_ROUTING = STEP_ROUTING['legal.review'];

/** Free-text answer steps: a blocked-command fuzzy match here would swallow
 * legitimate answers (e.g. the name "Chata" matching "chats" at
 * edit-distance 1), so blocked-command classification is skipped entirely. */
const FREE_TEXT_STEPS = new Set<string>([
  'profile.name',
  'profile.custom_trade',
  'trust.question.1',
  'trust.question.2',
  'trust.question.3',
]);

/** Steps with no real handler yet (Task 5's job) — every message at these
 * steps is consumed by the gate so `handleProfileAndTrust` is unreachable. */
const UNIMPLEMENTED_STEPS = new Set<string>([
  'profile.name',
  'profile.location',
  'profile.trade',
  'profile.custom_trade',
  'trust.question.1',
  'trust.question.2',
  'trust.question.3',
]);

// ── Prompt construction: single source of truth for "what does the
//    current step ask?" ────────────────────────────────────────────────

function buildPromptForStep(stepKey: string, lang: Lang, deps: OnboardingV2Deps): InteractivePrompt {
  switch (stepKey) {
    case 'start.choose_language':
      return buildV2StartInvitationPrompt(lang);
    case 'identity.verify_otp':
      return buildV2OtpPrompt(lang, '5');
    case 'legal.review':
      return buildV2LegalPrompt(lang, deps.tosUrl, deps.privacyUrl);
    case 'profile.name':
      return { templateName: '', variables: {}, fallbackBody: t('v2_ask_name', lang) };
    case 'profile.location':
      return { templateName: '', variables: {}, fallbackBody: t('v2_ask_location', lang) };
    case 'profile.custom_trade':
      return { templateName: '', variables: {}, fallbackBody: t('v2_ask_custom_trade', lang) };
    default:
      return { templateName: '', variables: {}, fallbackBody: t('v2_gate_blocked', lang) };
  }
}

// ── Pre-auth delivery (Design A) ────────────────────────────────────────
//
// start.choose_language / identity.verify_otp have no bound user_id (a
// net-new worker has no `users` row, and `worker_message_intents.user_id`
// is NOT NULL), so their prompts travel the phone/inbound-keyed outbox
// reply origin — never the user-bound intent gateway, never a direct send.
// Interactive prompts (start invitation, OTP) carry a real Twilio content
// template; transient status replies (invalid/expired/locked/cooldown) are
// plain bilingual text.

async function sendPreAuthPrompt(
  client: PoolClient,
  deps: OnboardingV2Deps,
  msg: OnboardingV2InboundMessage,
  stepKey: string,
  lang: Lang,
): Promise<void> {
  const prompt = buildPromptForStep(stepKey, lang, deps);
  await deps.enqueuePreAuthPrompt(client, msg.messageSid, msg.from, prompt);
}

async function sendPreAuthText(
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

async function sendStepPrompt(
  client: PoolClient,
  deps: OnboardingV2Deps,
  workerId: string,
  stepKey: string,
  lang: Lang,
  now: Date,
  sourceId: string,
  dedupeSuffix: string,
): Promise<void> {
  const routing = STEP_ROUTING[stepKey] ?? DEFAULT_ROUTING;
  const prompt = buildPromptForStep(stepKey, lang, deps);
  const input: WorkerMessageIntentInput = {
    workerId,
    category: routing.category,
    ownerService: routing.ownerService,
    sourceType: `onboarding_v2:${stepKey}`,
    sourceId,
    dedupeKey: `v2:prompt:${stepKey}:${workerId}:${dedupeSuffix}`,
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

async function sendTemplateMessage(
  client: PoolClient,
  deps: OnboardingV2Deps,
  workerId: string,
  stepKey: string,
  lang: Lang,
  key: TemplateKey,
  vars: Record<string, string>,
  now: Date,
  sourceId: string,
  tag: string,
): Promise<void> {
  const routing = STEP_ROUTING[stepKey] ?? DEFAULT_ROUTING;
  const body = t(key, lang, vars);
  const input: WorkerMessageIntentInput = {
    workerId,
    category: routing.category,
    ownerService: routing.ownerService,
    sourceType: `onboarding_v2:${key}`,
    sourceId,
    dedupeKey: `v2:${key}:${workerId}:${tag}:${now.getTime()}`,
    priority: routing.priority,
    expiresAt: null,
    payload: { body, lang },
  };
  await deps.enqueueWorkerMessage(client, input, now);
}

async function repeatCurrentPrompt(
  client: PoolClient,
  session: OnboardingV2Session,
  deps: OnboardingV2Deps,
  workerId: string,
  stepKey: string,
  lang: Lang,
  now: Date,
  sourceId: string,
): Promise<void> {
  const key = `v2LastPromptAt:${stepKey}`;
  const lastIso = (session.state_context?.[key] as string | undefined) ?? null;
  if (!shouldRepeatPrompt(lastIso, now)) return;
  await sendStepPrompt(client, deps, workerId, stepKey, lang, now, sourceId, `repeat:${now.getTime()}`);
  session.state_context[key] = now.toISOString();
}

function readHistory(context: Record<string, unknown> | undefined, key: string): string[] {
  const raw = context?.[key];
  return Array.isArray(raw) ? (raw as string[]) : [];
}

// ── The command gate ─────────────────────────────────────────────────

async function applyGate(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  params: {
    stepKey: string;
    workerId: string;
    lang: Lang;
    responseLang: Lang;
    now: Date;
  },
): Promise<RouteResult | null> {
  const { stepKey, workerId, lang, responseLang, now } = params;
  const isInteractive = Boolean(msg.interactivePayload);
  const body = msg.body ?? '';

  if (!isInteractive && isOnboardingHelpCommand(body)) {
    await sendTemplateMessage(client, deps, workerId, stepKey, responseLang, 'v2_gate_blocked', {}, now, msg.messageSid, 'help');
    await repeatCurrentPrompt(client, session, deps, workerId, stepKey, lang, now, msg.messageSid);
    return { handled: true, workerId, stepKey };
  }

  if (!isInteractive && isLanguageCommand(body)) {
    const cmdLang = detectCommandLang(body) ?? responseLang;
    await sendTemplateMessage(client, deps, workerId, stepKey, cmdLang, 'v2_language_changed', {}, now, msg.messageSid, 'lang');
    return { handled: true, workerId, stepKey };
  }

  if (!isInteractive && isResendCommand(body) && stepKey !== 'identity.verify_otp') {
    console.warn(JSON.stringify({ metric: 'OnboardingGateBlocked', command: 'resend', stepKey }));
    await sendTemplateMessage(client, deps, workerId, stepKey, responseLang, 'v2_gate_blocked', {}, now, msg.messageSid, 'resend');
    await repeatCurrentPrompt(client, session, deps, workerId, stepKey, lang, now, msg.messageSid);
    return { handled: true, workerId, stepKey };
  }

  if (!isInteractive && !FREE_TEXT_STEPS.has(stepKey)) {
    const blocked = classifyBlockedCommand(body);
    if (blocked) {
      console.warn(JSON.stringify({ metric: 'OnboardingGateBlocked', command: blocked, stepKey }));
      await sendTemplateMessage(client, deps, workerId, stepKey, responseLang, 'v2_gate_blocked', {}, now, msg.messageSid, blocked);
      await repeatCurrentPrompt(client, session, deps, workerId, stepKey, lang, now, msg.messageSid);
      return { handled: true, workerId, stepKey };
    }
  }

  if (UNIMPLEMENTED_STEPS.has(stepKey)) {
    console.warn(JSON.stringify({ metric: 'OnboardingGateBlocked', command: 'unrelated', stepKey }));
    await sendTemplateMessage(client, deps, workerId, stepKey, responseLang, 'v2_gate_blocked', {}, now, msg.messageSid, 'unrelated');
    await repeatCurrentPrompt(client, session, deps, workerId, stepKey, lang, now, msg.messageSid);
    return { handled: true, workerId, stepKey };
  }

  return null;
}

// ── Pre-auth: start.choose_language ─────────────────────────────────────

async function handleStartStep(
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
      context: preAuth?.context ?? {},
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

// ── Pre-auth: identity.verify_otp ───────────────────────────────────────

async function handleOtpStep(
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

  if (!isInteractive && isResendCommand(msg.body)) {
    const history = readHistory(preAuth.context, 'otpSendHistory');
    const cooldown = evaluateStartCooldown(history, now);
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
    const stepKey = gate.currentStepKey ?? 'legal.review';
    await sendStepPrompt(client, deps, gate.userId, stepKey, gate.preferredLanguage, now, msg.messageSid, `bind:${now.getTime()}`);
    return { handled: true, workerId: gate.userId, stepKey };
  }

  if (result.status === 'invalid') {
    // The three-strike lockout only works if the returned attempts count is
    // persisted back through savePreAuthState — this is that persistence.
    await deps.repo.savePreAuthState(client, phoneHash, { attempts: result.attempts });
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

// ── Bound: legal.review ─────────────────────────────────────────────────

function normalizedEquals(body: string, words: readonly string[]): boolean {
  return words.includes(normalizeCommandText(body));
}

async function handleLegalStep(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  responseLang: Lang,
  now: Date,
): Promise<RouteResult> {
  const isInteractive = Boolean(msg.interactivePayload);
  const accept = isInteractive
    ? msg.interactivePayload === 'legal:accept'
    : normalizedEquals(msg.body, ['accept', 'aceptar']);
  const decline = isInteractive
    ? msg.interactivePayload === 'legal:decline'
    : normalizedEquals(msg.body, ['decline', 'rechazar']);
  const review = isInteractive
    ? msg.interactivePayload === 'legal:review'
    : isReviewTermsCommand(msg.body);

  if (accept) {
    const updated = await deps.repo.advanceWorkflow(client, {
      runId: gate.runId!,
      expectedLockVersion: gate.lockVersion!,
      fromStepKey: 'legal.review',
      toStepKey: 'profile.name',
      contextPatch: { legalAcceptedAt: now.toISOString() },
      inboundMessageSid: msg.messageSid,
      reason: 'legal_accept',
    });
    await sendStepPrompt(client, deps, updated.userId, 'profile.name', updated.preferredLanguage, now, msg.messageSid, `accept:${now.getTime()}`);
    return { handled: true, workerId: updated.userId, stepKey: 'profile.name' };
  }

  if (decline) {
    const updated = await deps.repo.advanceWorkflow(client, {
      runId: gate.runId!,
      expectedLockVersion: gate.lockVersion!,
      fromStepKey: 'legal.review',
      toStepKey: 'legal.review',
      status: 'declined',
      contextPatch: { legalDeclinedAt: now.toISOString() },
      inboundMessageSid: msg.messageSid,
      reason: 'legal_decline',
    });
    await sendTemplateMessage(client, deps, updated.userId, 'legal.review', updated.preferredLanguage, 'v2_legal_declined', {}, now, msg.messageSid, 'declined');
    return { handled: true, workerId: updated.userId, stepKey: 'legal.review' };
  }

  // REVIEW TERMS, or anything unrecognized: stay on the step and resend
  // the legal prompt (subject to the reprompt cooldown for unrecognized
  // input so a chatty worker doesn't get spammed).
  if (review) {
    await sendStepPrompt(client, deps, gate.userId, 'legal.review', lang, now, msg.messageSid, `review:${now.getTime()}`);
  } else {
    await repeatCurrentPrompt(client, session, deps, gate.userId, 'legal.review', lang, now, msg.messageSid);
  }
  return { handled: true, workerId: gate.userId, stepKey: 'legal.review' };
}

// ── Bound: profile/trust stub (Task 5 replaces this) ────────────────────

async function handleProfileAndTrust(
  _client: PoolClient,
  _session: OnboardingV2Session,
  _msg: OnboardingV2InboundMessage,
  _deps: OnboardingV2Deps,
  _gate: WorkerGate,
  _stepKey: WorkflowStepKey,
): Promise<RouteResult> {
  throw new Error('profile/trust steps land in Task 5');
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
  const lang: Lang = gate.preferredLanguage;
  const isInteractive = Boolean(msg.interactivePayload);
  const responseLang = resolveResponseLanguage(lang, msg.body, isInteractive);

  const gateResult = await applyGate(client, session, msg, deps, {
    stepKey,
    workerId: gate.userId,
    lang,
    responseLang,
    now,
  });
  if (gateResult) return gateResult;

  if (stepKey === 'legal.review') {
    return handleLegalStep(client, session, msg, deps, gate, lang, responseLang, now);
  }

  return handleProfileAndTrust(client, session, msg, deps, gate, stepKey);
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

  const gate = session.user_id ? await deps.repo.loadWorkerGate(client, session.user_id) : null;
  if (gate && gate.runId && gate.currentStepKey) {
    return routeBoundStep(client, session, msg, deps, gate, now);
  }

  const preAuth = await deps.repo.loadPreAuthStateForUpdate(client, phoneHash);
  if (preAuth && preAuth.currentStepKey === 'identity.verify_otp') {
    return handleOtpStep(client, session, msg, deps, preAuth, phoneHash, now);
  }

  return handleStartStep(client, session, msg, deps, preAuth, phoneHash, now);
}
