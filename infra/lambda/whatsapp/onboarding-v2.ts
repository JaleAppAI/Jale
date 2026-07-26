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
  detectLanguageSelectionCommand,
  isResendCommand,
  isReviewTermsCommand,
  isOnboardingHelpCommand,
  classifyBlockedCommand,
  classifyBlockedCommandExact,
  evaluateStartCooldown,
  evaluateOtpResendCooldown,
  shouldRepeatPrompt,
  appendSendTimestamp,
} from './lib/onboarding-language';
import {
  buildV2StartInvitationPrompt,
  buildV2OtpPrompt,
  buildV2LegalPrompt,
  buildV2TradePrompt,
  V2_FALLBACK_TRUST_QUESTIONS,
  type InteractivePrompt,
} from './lib/interactive-templates';
import { normalizeCommandText } from './lib/flows';
import {
  normalizeTrade,
  standardTrustQuestions,
  getTrustOptions,
  type ResolvedLocation,
} from './lib/onboarding-adapters';

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

export type RouteResult =
  | { handled: true; workerId: string | null; stepKey: string }
  | {
      handled: false;
      handoff: 'ready';
      workerId: string;
      stepKey: 'ready';
    };

// ── Locally-composed deps (no canonical types redeclared here) ─────────

export interface OnboardingV2RepoDeps {
  setInternalUserRlsContext: (client: PoolClient, workerId: string) => Promise<void>;
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
  setRunPreferredLanguage: (client: PoolClient, input: { runId: string; expectedLockVersion: number; preferredLanguage: PreferredLanguage }) => Promise<WorkerGate>;
  reactivateDeclinedLegalRun: (
    client: PoolClient,
    input: { runId: string; expectedLockVersion: number },
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
  /**
   * Task 5's sole call site: fired exactly once, on the SAME client/
   * transaction as the answer-three persistence that precedes it, with the
   * locked gate's `expectedLockVersion`. Never awaited for external work —
   * the two domain events it enqueues are drained by other lanes.
   */
  completeOnboarding: (
    client: PoolClient,
    input: {
      workerId: string;
      runId: string;
      expectedLockVersion: number;
      assessmentProvenance: Record<string, unknown>;
    },
  ) => Promise<{ assessmentEventId: string; workerReadyEventId: string }>;
}

export interface OnboardingV2Deps {
  adapters: OnboardingV2Adapters;
  repo: OnboardingV2RepoDeps;
  enqueueWorkerMessage: (
    client: PoolClient,
    input: WorkerMessageIntentInput,
    now?: Date,
  ) => Promise<{ intentId: string; decision: unknown; outboxMaterialized: boolean }>;
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
  requiredLegalVersion: string;
  recordLegalAcceptance: (
    client: PoolClient,
    input: { workerId: string; documentVersion: string },
  ) => Promise<void>;
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

/** Steps with no real handler yet. Task 5 implemented profile/trust, so this
 * was empty — kept (rather than deleted) as the gate's documented extension
 * point for a future step that isn't ready yet. Migration 050 widened the
 * step-key CHECK/union ahead of their handlers landing; without this gate,
 * `handleProfileAndTrust`'s switch would throw `unhandled bound step` for
 * any of these instead of replying with a graceful gate-blocked prompt.
 * profile.experience / profile.transportation / profile.availability are
 * intentionally NOT listed here — their handlers are landing concurrently. */
const UNIMPLEMENTED_STEPS = new Set<string>([
  'profile.voice_choice',
  'profile.voice_processing',
  'profile.photo',
  'profile.photo_type',
]);

// ── Task 5: profile/trust vocabulary + assessment provenance versions ───

/** Canonical trade slugs in list-picker order; mirrors flows.ts's TRADE_KEYS
 * (never imported directly — that module is out of this task's scope). */
const TRADE_ORDER = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'] as const;
type StandardTrade = Exclude<(typeof TRADE_ORDER)[number], 'other'>;

const TRADE_LABELS: Record<(typeof TRADE_ORDER)[number], { en: string; es: string }> = {
  electrician: { en: 'Electrician', es: 'Electricista' },
  plumber: { en: 'Plumber', es: 'Plomero' },
  carpenter: { en: 'Carpenter', es: 'Carpintero' },
  concrete: { en: 'Concrete', es: 'Concreto' },
  painting: { en: 'Painting', es: 'Pintura' },
  other: { en: 'Other', es: 'Otro' },
};

/** Provenance identifiers recorded on the assessment (via `completeOnboarding`'s
 * `assessmentProvenance` payload) and on each `saveTrustAnswer` call. Bump the
 * relevant constant when the underlying question/rubric content changes. */
const V2_TRUST_QUESTION_SET_VERSION = 'v2-trust-questions-1';
const V2_TRUST_FALLBACK_VERSION = 'v2-trust-fallback-1';
const V2_TRUST_RUBRIC_VERSION = 'v2-trust-rubric-1';

type BilingualQuestion = { en: string; es: string };

// ── Prompt construction: single source of truth for "what does the
//    current step ask?" ────────────────────────────────────────────────

function buildPromptForStep(
  stepKey: string,
  lang: Lang,
  deps: OnboardingV2Deps,
  stateContext?: Record<string, unknown>,
): InteractivePrompt {
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
    case 'profile.trade': {
      const options = TRADE_ORDER.map((trade) => TRADE_LABELS[trade][lang]);
      return buildV2TradePrompt(lang, t('v2_ask_trade', lang), options);
    }
    case 'profile.custom_trade':
      return { templateName: '', variables: {}, fallbackBody: t('v2_ask_custom_trade', lang) };
    case 'trust.question.1':
    case 'trust.question.2':
    case 'trust.question.3':
      return { templateName: '', variables: {}, fallbackBody: buildTrustQuestionBody(stepKey, lang, stateContext) };
    default:
      return { templateName: '', variables: {}, fallbackBody: t('v2_gate_blocked', lang) };
  }
}

/** Reads the run's in-progress trust-question set from the session's scratch
 * context (`v2TrustQuestions`, seeded by `profile.trade`/`profile.custom_trade`);
 * falls back to the reviewed bilingual fallback set if the context is
 * missing (e.g. a stale reprompt after a redeploy). */
function buildTrustQuestionBody(stepKey: string, lang: Lang, stateContext?: Record<string, unknown>): string {
  const idx = Number(stepKey.split('.').pop()) - 1;
  const questions = (stateContext?.v2TrustQuestions as BilingualQuestion[] | undefined) ?? V2_FALLBACK_TRUST_QUESTIONS;
  const q = questions[idx] ?? questions[0];
  return lang === 'en' ? q.en : q.es;
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

async function sendTemplateMessage(
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

/** Thin, named alias over `sendStepPrompt` for the trust-question steps —
 * kept distinct (rather than inlined) so the trade/trust-set-dependent
 * prompt path has one obvious call site to change later (e.g. a real Twilio
 * content template for trust questions). */
async function sendTrustPrompt(
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

async function repeatCurrentPrompt(
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
    const stepKey = gate.currentStepKey ?? 'legal.review';
    await sendStepPrompt(client, deps, gate.userId, stepKey, gate.preferredLanguage, now, gate.runId!, msg.messageSid, `bind:${now.getTime()}`);
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

/** A durable IDIOMA/LANGUAGE override (see applyGate) takes precedence over
 * whatever preferred_language the run was bound with — used for every
 * subsequent step prompt, not just the confirmation reply itself. */
function effectiveLang(session: OnboardingV2Session, gate: WorkerGate): Lang {
  return (session.state_context?.v2PreferredLanguageOverride as Lang | undefined)
    ?? gate.preferredLanguage;
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

  if (gate.status === 'declined') {
    if (review) {
      const reactivated = await deps.repo.reactivateDeclinedLegalRun(client, {
        runId: gate.runId!,
        expectedLockVersion: gate.lockVersion!,
      });
      await sendStepPrompt(client, deps, reactivated.userId, 'legal.review', effectiveLang(session, reactivated), now, reactivated.runId!, msg.messageSid, `review:${now.getTime()}`);
      return { handled: true, workerId: reactivated.userId, stepKey: 'legal.review' };
    }

    await sendTemplateMessage(client, deps, gate.userId, 'legal.review', effectiveLang(session, gate), 'v2_legal_declined', {}, now, gate.runId!, msg.messageSid, 'declined');
    return { handled: true, workerId: gate.userId, stepKey: 'legal.review' };
  }

  if (accept) {
    await deps.recordLegalAcceptance(client, {
      workerId: gate.userId,
      documentVersion: deps.requiredLegalVersion,
    });
    const updated = await deps.repo.advanceWorkflow(client, {
      runId: gate.runId!,
      expectedLockVersion: gate.lockVersion!,
      fromStepKey: 'legal.review',
      toStepKey: 'profile.name',
      contextPatch: { legalAcceptedAt: now.toISOString() },
      inboundMessageSid: msg.messageSid,
      reason: 'legal_accept',
    });
    await sendStepPrompt(client, deps, updated.userId, 'profile.name', effectiveLang(session, updated), now, gate.runId!, msg.messageSid, `accept:${now.getTime()}`);
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
    await sendTemplateMessage(client, deps, updated.userId, 'legal.review', effectiveLang(session, updated), 'v2_legal_declined', {}, now, gate.runId!, msg.messageSid, 'declined');
    return { handled: true, workerId: updated.userId, stepKey: 'legal.review' };
  }

  // REVIEW TERMS, or anything unrecognized: stay on the step and resend
  // the legal prompt (subject to the reprompt cooldown for unrecognized
  // input so a chatty worker doesn't get spammed).
  if (review) {
    await sendStepPrompt(client, deps, gate.userId, 'legal.review', lang, now, gate.runId!, msg.messageSid, `review:${now.getTime()}`);
  } else {
    await repeatCurrentPrompt(client, session, deps, gate.userId, 'legal.review', lang, now, gate.runId!, msg.messageSid);
  }
  return { handled: true, workerId: gate.userId, stepKey: 'legal.review' };
}

// ── Bound: profile.name ──────────────────────────────────────────────────

async function handleProfileName(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
): Promise<RouteResult> {
  const trimmed = (msg.body ?? '').trim();
  const valid = trimmed.length >= 2 && trimmed.length <= 100;
  if (!valid) {
    await repeatCurrentPrompt(client, session, deps, gate.userId, 'profile.name', lang, now, gate.runId!, msg.messageSid);
    return { handled: true, workerId: gate.userId, stepKey: 'profile.name' };
  }

  await deps.adapters.profile.saveName(client, gate.userId, trimmed);
  const updated = await deps.repo.advanceWorkflow(client, {
    runId: gate.runId!,
    expectedLockVersion: gate.lockVersion!,
    fromStepKey: 'profile.name',
    toStepKey: 'profile.location',
    contextPatch: { nameSetAt: now.toISOString() },
    inboundMessageSid: msg.messageSid,
    reason: 'profile_name_set',
  });
  await sendStepPrompt(client, deps, updated.userId, 'profile.location', effectiveLang(session, updated), now, gate.runId!, msg.messageSid, `name:${now.getTime()}`);
  return { handled: true, workerId: updated.userId, stepKey: 'profile.location' };
}

// ── Bound: profile.location ──────────────────────────────────────────────

async function handleProfileLocation(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
): Promise<RouteResult> {
  const resolved: ResolvedLocation | null = deps.adapters.location.resolve(msg.body ?? '');
  if (!resolved) {
    await repeatCurrentPrompt(client, session, deps, gate.userId, 'profile.location', lang, now, gate.runId!, msg.messageSid);
    return { handled: true, workerId: gate.userId, stepKey: 'profile.location' };
  }

  await deps.adapters.profile.saveLocation(client, gate.userId, resolved);
  const updated = await deps.repo.advanceWorkflow(client, {
    runId: gate.runId!,
    expectedLockVersion: gate.lockVersion!,
    fromStepKey: 'profile.location',
    toStepKey: 'profile.trade',
    contextPatch: { locationSource: resolved.source },
    inboundMessageSid: msg.messageSid,
    reason: 'profile_location_set',
  });
  await sendStepPrompt(client, deps, updated.userId, 'profile.trade', effectiveLang(session, updated), now, gate.runId!, msg.messageSid, `location:${now.getTime()}`);
  return { handled: true, workerId: updated.userId, stepKey: 'profile.trade' };
}

// ── Bound: profile.trade (list picker) ───────────────────────────────────

/**
 * Accepts both payload dialects, because `profile.trade` now renders V1's
 * approved `onboarding_trade_*` template (see buildV2TradePrompt), whose taps
 * arrive as `profile:main_trade:<trade>` — V1's format, per
 * parseProfilePayloadAnswer in flows.ts. The original `trade:<trade>` form is
 * still accepted so any session already prompted with the old template keeps
 * working, and numeric/plain replies still cover the plain-text fallback.
 */
function parseTradeChoice(msg: OnboardingV2InboundMessage): (typeof TRADE_ORDER)[number] | null {
  if (msg.interactivePayload) {
    const match = /^(?:trade|profile:main_trade):(.+)$/.exec(msg.interactivePayload);
    const candidate = match?.[1];
    if (candidate && (TRADE_ORDER as readonly string[]).includes(candidate)) {
      return candidate as (typeof TRADE_ORDER)[number];
    }
    return null;
  }
  const trimmed = (msg.body ?? '').trim();
  const asIndex = Number(trimmed);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= TRADE_ORDER.length) {
    return TRADE_ORDER[asIndex - 1];
  }
  const lowered = trimmed.toLowerCase();
  if ((TRADE_ORDER as readonly string[]).includes(lowered)) {
    return lowered as (typeof TRADE_ORDER)[number];
  }
  return null;
}

async function handleProfileTrade(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
): Promise<RouteResult> {
  const choice = parseTradeChoice(msg);
  if (!choice) {
    await repeatCurrentPrompt(client, session, deps, gate.userId, 'profile.trade', lang, now, gate.runId!, msg.messageSid);
    return { handled: true, workerId: gate.userId, stepKey: 'profile.trade' };
  }

  if (choice === 'other') {
    await deps.adapters.profile.saveTrade(client, gate.userId, 'other');
    const updated = await deps.repo.advanceWorkflow(client, {
      runId: gate.runId!,
      expectedLockVersion: gate.lockVersion!,
      fromStepKey: 'profile.trade',
      toStepKey: 'profile.custom_trade',
      contextPatch: { selectedTrade: 'other' },
      inboundMessageSid: msg.messageSid,
      reason: 'profile_trade_other',
    });
    await sendStepPrompt(client, deps, updated.userId, 'profile.custom_trade', effectiveLang(session, updated), now, gate.runId!, msg.messageSid, `trade:${now.getTime()}`);
    return { handled: true, workerId: updated.userId, stepKey: 'profile.custom_trade' };
  }

  const trade: StandardTrade = choice;
  await deps.adapters.profile.saveTrade(client, gate.userId, trade);

  const questions: BilingualQuestion[] = standardTrustQuestions(trade).map((q) => ({ en: q.q_en, es: q.q_es }));
  session.state_context.v2ProfileTrade = trade;
  session.state_context.v2TrustQuestions = questions;
  session.state_context.v2TrustSource = 'standard';
  session.state_context.v2QuestionSetVersion = V2_TRUST_QUESTION_SET_VERSION;
  session.state_context.v2RubricVersion = V2_TRUST_RUBRIC_VERSION;

  const updated = await deps.repo.advanceWorkflow(client, {
    runId: gate.runId!,
    expectedLockVersion: gate.lockVersion!,
    fromStepKey: 'profile.trade',
    toStepKey: 'trust.question.1',
    contextPatch: { trade, trustQuestionSource: 'standard' },
    inboundMessageSid: msg.messageSid,
    reason: 'profile_trade_standard',
  });
  await sendTrustPrompt(client, deps, updated.userId, 'trust.question.1', effectiveLang(session, updated), now, gate.runId!, msg.messageSid, `trade:${now.getTime()}`, session.state_context);
  return { handled: true, workerId: updated.userId, stepKey: 'trust.question.1' };
}

// ── Bound: profile.custom_trade ──────────────────────────────────────────

async function handleCustomTrade(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
): Promise<RouteResult> {
  const professionRaw = (msg.body ?? '').trim();
  if (!professionRaw) {
    await repeatCurrentPrompt(client, session, deps, gate.userId, 'profile.custom_trade', lang, now, gate.runId!, msg.messageSid);
    return { handled: true, workerId: gate.userId, stepKey: 'profile.custom_trade' };
  }

  const professionKey = normalizeTrade(professionRaw);

  // The generator never throws by contract (createTrustQuestionGenerator
  // catches internally), but an injected/production adapter failing in an
  // unexpected way must still fall back rather than fail the run.
  let generated: BilingualQuestion[] | null = null;
  try {
    const result = await deps.adapters.trustQuestions.generate(client, professionRaw);
    if (Array.isArray(result) && result.length === 3) {
      generated = result.map((q) => ({ en: q.q_en, es: q.q_es }));
    }
  } catch (err) {
    console.error(JSON.stringify({
      metric: 'OnboardingTrustQuestionGenerationFailed',
      reason: (err as { name?: string })?.name ?? 'unknown_error',
    }));
    generated = null;
  }

  const source: 'generated' | 'fallback' = generated ? 'generated' : 'fallback';
  const questions: BilingualQuestion[] = generated ?? V2_FALLBACK_TRUST_QUESTIONS.map((q) => ({ ...q }));

  await deps.adapters.profile.saveTrade(client, gate.userId, 'other');
  session.state_context.v2ProfileTrade = professionKey;
  session.state_context.v2TrustQuestions = questions;
  session.state_context.v2TrustSource = source;
  session.state_context.v2QuestionSetVersion = source === 'fallback' ? V2_TRUST_FALLBACK_VERSION : V2_TRUST_QUESTION_SET_VERSION;
  session.state_context.v2RubricVersion = V2_TRUST_RUBRIC_VERSION;

  const updated = await deps.repo.advanceWorkflow(client, {
    runId: gate.runId!,
    expectedLockVersion: gate.lockVersion!,
    fromStepKey: 'profile.custom_trade',
    toStepKey: 'trust.question.1',
    contextPatch: { customTrade: professionKey, trustQuestionSource: source },
    inboundMessageSid: msg.messageSid,
    reason: 'profile_custom_trade_set',
  });
  await sendTrustPrompt(client, deps, updated.userId, 'trust.question.1', effectiveLang(session, updated), now, gate.runId!, msg.messageSid, `custom:${now.getTime()}`, session.state_context);
  return { handled: true, workerId: updated.userId, stepKey: 'trust.question.1' };
}

// ── Bound: trust.question.{1,2,3} + atomic readiness ─────────────────────

const TRUST_STEP_NEXT: Record<string, WorkflowStepKey | null> = {
  'trust.question.1': 'trust.question.2',
  'trust.question.2': 'trust.question.3',
  'trust.question.3': null,
};

/** Parses a 1-based option index from either a `trust:<n>` interactive
 * payload or plain numeric text. Returns null when neither form is present. */
function parseTrustOptionIndex(msg: OnboardingV2InboundMessage): number | null {
  if (msg.interactivePayload) {
    const match = /^trust:(\d+)$/.exec(msg.interactivePayload);
    if (!match) return null;
    return Number(match[1]);
  }
  const trimmed = (msg.body ?? '').trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

async function handleTrustQuestion(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
  stepKey: 'trust.question.1' | 'trust.question.2' | 'trust.question.3',
): Promise<RouteResult> {
  // Idempotency: a message arriving after this run already completed (e.g. a
  // duplicate webhook delivery of the final answer) must not re-complete it.
  if (gate.status === 'completed') {
    return { handled: true, workerId: gate.userId, stepKey };
  }

  const idx = Number(stepKey.split('.').pop()) - 1; // 0-based
  const trade = (session.state_context.v2ProfileTrade as string | undefined) ?? 'other';
  const source = (session.state_context.v2TrustSource as string | undefined) ?? 'fallback';
  const questionSetVersion = (session.state_context.v2QuestionSetVersion as string | undefined)
    ?? (source === 'fallback' ? V2_TRUST_FALLBACK_VERSION : V2_TRUST_QUESTION_SET_VERSION);
  const rubricVersion = (session.state_context.v2RubricVersion as string | undefined) ?? V2_TRUST_RUBRIC_VERSION;

  let answerText: string | null = null;
  if (source === 'standard') {
    const options = getTrustOptions(idx, trade);
    const optionIdx = parseTrustOptionIndex(msg);
    if (optionIdx !== null && optionIdx >= 1 && optionIdx <= options.length) {
      answerText = options[optionIdx - 1];
    }
  } else {
    const trimmed = (msg.body ?? '').trim();
    answerText = trimmed.length > 0 ? trimmed : null;
  }

  if (answerText === null) {
    await repeatCurrentPrompt(client, session, deps, gate.userId, stepKey, lang, now, gate.runId!, msg.messageSid);
    return { handled: true, workerId: gate.userId, stepKey };
  }

  await deps.adapters.profile.saveTrustAnswer(client, {
    workerId: gate.userId,
    professionKey: normalizeTrade(trade),
    questionIndex: idx,
    answerText,
    provenance: { rubricVersion },
  });

  const nextStepKey = TRUST_STEP_NEXT[stepKey];
  if (nextStepKey) {
    const updated = await deps.repo.advanceWorkflow(client, {
      runId: gate.runId!,
      expectedLockVersion: gate.lockVersion!,
      fromStepKey: stepKey,
      toStepKey: nextStepKey,
      contextPatch: { [`trustAnswer${idx + 1}At`]: now.toISOString() },
      inboundMessageSid: msg.messageSid,
      reason: 'trust_answer_recorded',
    });
    await sendTrustPrompt(client, deps, updated.userId, nextStepKey, effectiveLang(session, updated), now, gate.runId!, msg.messageSid, `trust:${now.getTime()}`, session.state_context);
    return { handled: true, workerId: updated.userId, stepKey: nextStepKey };
  }

  // Answer three: persist (done above), then complete — same client/
  // transaction, exactly once, no external request or send. C6's release
  // owns the sole ready confirmation; this router enqueues nothing further.
  await deps.repo.completeOnboarding(client, {
    workerId: gate.userId,
    runId: gate.runId!,
    expectedLockVersion: gate.lockVersion!,
    assessmentProvenance: {
      trade,
      professionKey: normalizeTrade(trade),
      source,
      questionSetVersion,
      rubricVersion,
    },
  });
  return { handled: true, workerId: gate.userId, stepKey };
}

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
