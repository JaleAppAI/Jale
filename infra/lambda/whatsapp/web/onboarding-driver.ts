/**
 * The WEB DOOR onto the WhatsApp v2 onboarding engine (Sprint 22 R2-C23).
 *
 * A web worker drives the SAME `worker_workflow_runs` state machine WhatsApp
 * does: the same step order, the same handlers, the same validation, the same
 * `worker_trust_assessments` row, the same `assessment.requested` /
 * `worker.ready` domain events. Nothing about the flow is re-implemented here
 * — this module is a TRANSLATOR and nothing more:
 *
 *   web JSON value  ->  the engine message the step handler already accepts
 *   engine outcome  ->  a structured HTTP result the browser can render
 *
 * THREE THINGS IT DELIBERATELY DOES NOT DO
 *
 * 1. It never returns WhatsApp copy. The engine still builds a prompt for
 *    every step and hands it to `enqueueWorkerMessage`; on this door that dep
 *    is a CAPTURE-ONLY sink (`createWebOnboardingDeps`) so nothing is written
 *    to `worker_message_intents` and nobody gets a WhatsApp message for
 *    filling in a web form. `templateName`/`fallbackBody` are dropped on the
 *    floor: the web owns its own copy, the engine owns order and state.
 *
 * 2. It never routes a value through the command gate. On WhatsApp, plain
 *    text equal to `back`, `hola`, `trabajos`, `perfil`, `ayuda`, `idioma`,
 *    ... is a COMMAND. On the web those arrive as form field values the
 *    worker typed on purpose — a custom trade of "back", a name of "Ayuda" —
 *    and swallowing them would be a silent data-loss bug. `dispatchWebBoundStep`
 *    goes straight to the step handler. BACK is its own endpoint.
 *
 * 3. It never invents a rejection reason the engine did not have. The engine's
 *    handlers signal refusal by NOT advancing (they reprompt instead of
 *    throwing), so refusal is detected structurally: `lock_version` is
 *    unchanged after the dispatch. That is exact — every accepting path in
 *    the engine goes through `advanceWorkflow`, including the two that stay on
 *    the same step on purpose (a bare city parking a confirmation, and
 *    declining that confirmation), which are outcomes, not rejections.
 */

import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';

import {
  dispatchWebBoundStep,
  type OnboardingV2Deps,
  type OnboardingV2InboundMessage,
  type OnboardingV2Session,
} from '../onboarding-v2';
import { isAvailabilityKey, isExperienceKey, isTradeKey } from '../../lib/worker-vocab';
import { isUnimplementedBoundStep } from '../onboarding/gate';
import { hydrateSessionFromRun, persistDurableStateContext } from '../onboarding/durable-context';
import {
  advanceWorkflow,
  appendTransition,
  clearProfileAnswers,
  completeOnboarding,
  findPreviousStepKey,
  loadWorkerGate,
  reactivateDeclinedLegalRun,
  resetPendingTrustAssessmentAndSkills,
  setRunPreferredLanguage,
  type WorkerGate,
} from '../lib/onboarding-repository';
import { createOnboardingV2Adapters, type IdentityAdapter } from '../lib/onboarding-adapters';
import { recordCanonicalWhatsAppConsent } from '../lib/legal-consent';
import { hashNormalizedPhone } from '../lib/runtime-controls';
import { setInternalUserRlsContext } from '../../lib/db';
import type { PreferredLanguage, WorkflowStepKey } from '../lib/onboarding-types';

// ── Contract constants ───────────────────────────────────────────────────

/**
 * One screen's worth of answers. The widest batch the web flow posts is the
 * three-field "work" screen; six leaves room for a future screen without
 * letting a client walk the whole state machine in one unbounded request.
 */
export const MAX_ANSWERS_PER_BATCH = 6;

/**
 * Trust answers are the product. A three-word answer scores as nothing and
 * extracts as nothing, so the web door holds a floor the WhatsApp door does
 * not (a WhatsApp worker typing on a phone gets the engine's own "anything
 * non-empty" rule, unchanged — this is deliberately NOT symmetric).
 *
 * The ceiling is a denial-of-service bound, not an editorial one:
 * `worker_trust_assessments.answers` is unbounded JSONB and the extractor
 * prompt is not.
 */
/**
 * `profile.custom_trade` is free text that becomes `users.main_trade_other`
 * and the `profession_key` the question generator and trade-alias lanes are
 * prompted with. The column has no length CHECK (004:58 is a bare TEXT), so
 * the cap has to live here: without one a paste of a whole CV becomes a
 * profession, is sent to the generator as a prompt, and is stored as the
 * label an employer sees. 60 characters is longer than every seeded trade
 * name and short enough to stay a NAME.
 */
export const CUSTOM_TRADE_MIN_CHARS = 2;
export const CUSTOM_TRADE_MAX_CHARS = 60;
/** C0 + DEL + C1. A trade name is one line of text; newlines and control
 *  bytes in it are either a paste accident or an injection attempt at the
 *  generator prompt. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
/** Text PostgreSQL cannot store: a NUL byte (22021 on `text`, 22P05 inside
 *  `jsonb`) or an unpaired UTF-16 surrogate (Node encodes it as U+FFFD on a
 *  `text` column but `JSON.stringify` leaves the lone escape, and `::jsonb`
 *  raises 22P02). Either one used to surface as a 500 from deep inside the
 *  engine; it is a malformed answer, so it is refused at the door with the
 *  same 422 as any other invalid value. Deliberately NOT `CONTROL_CHARS`:
 *  a newline in a free-text answer is legitimate. */
const UNSTORABLE_TEXT = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** `deps.adapters.location.resolve` bounds the CHARSET of a typed city and
 *  state (`CITY_PART_RE`) but not their length, and the resolved text lands
 *  verbatim in `users.city`, `worker_preferred_cities` and
 *  `worker_profiles.location`. Real place names fit comfortably. */
export const LOCATION_CITY_MAX_CHARS = 80;
export const LOCATION_STATE_MAX_CHARS = 40;
/** A ZIP answer is exactly five digits. `deps.adapters.location.resolve`
 *  treats anything with a comma as "City, ST", so an unbounded `zip` value is
 *  a second, uncapped city_state channel (and a prototype-key smuggler into
 *  `inferCityState`). The frontend gates the same field on this exact regex
 *  (`onboarding-flow.ts` ZIP), so nothing legitimate is refused. */
const WEB_ZIP_RE = /^\d{5}$/;

export const TRUST_ANSWER_MIN_CHARS = 15;
export const TRUST_ANSWER_MAX_CHARS = 2000;

/** Steps the web flow can answer. `profile.photo`/`profile.photo_type` are
 * absent on purpose: `PROFILE_FIELD_TO_STEP` has no photo entry, no engine
 * handler exists, and a run parked on one cannot advance. The web flow's
 * photo screen is client-side only. */
const WEB_ANSWERABLE_STEPS = new Set<string>([
  'legal.review',
  'profile.name',
  'profile.location',
  'profile.trade',
  'profile.custom_trade',
  'profile.experience',
  'profile.transportation',
  'profile.availability',
  'trust.question.1',
  'trust.question.2',
  'trust.question.3',
]);


// ── Result shapes ────────────────────────────────────────────────────────

export interface WebAnswerItem {
  stepKey: string;
  value: unknown;
}

/** Why one item could not be applied. `code` becomes the HTTP body's `error`. */
export interface WebStepRejection {
  code: 'step_rejected' | 'step_mismatch' | 'unknown_step';
  stepKey: string;
  reason: string;
}

export interface ApplyAnswersOutcome {
  /** Null when every item in the batch was applied. */
  rejection: WebStepRejection | null;
  /** True when this request's last accepted answer completed onboarding, so
   * the caller knows to poke the domain-outbox drain after COMMIT. */
  completed: boolean;
}

/** Thrown for a stale `lockVersion`. The engine's own `advanceWorkflow`
 * raises the same message; both are caught in one place and become a 409. */
export const LOCK_CONFLICT = 'workflow_lock_conflict';

export function isLockConflict(err: unknown): boolean {
  return err instanceof Error && err.message === LOCK_CONFLICT;
}

// ── Deps: the engine, with only the CHANNEL replaced ─────────────────────

const unreachable = (what: string) => () => {
  throw new Error(`web onboarding door must never reach ${what}`);
};

/**
 * Production deps for the web door. Everything that reads or writes the
 * onboarding state is the REAL implementation — the same repository
 * functions, the same location/trust-question/profile adapters, the same
 * consent writer. Only the channel is swapped, and every phone-only lane is
 * a throwing stub rather than a no-op so a run that falls through to a
 * WhatsApp-only path fails loudly in tests instead of passing quietly.
 */
export function createWebOnboardingDeps(options: {
  clock?: { now(): Date };
  requiredLegalVersion: string;
  tosUrl: string;
  privacyUrl: string;
  workflowVersion: number;
  /** Called with each prompt the engine tried to send. Request-scoped by the
   * caller — never module state, which a warm Lambda container would leak
   * across invocations. */
  onPrompt?: (sourceType: string) => void;
}): OnboardingV2Deps {
  const clock = options.clock ?? { now: () => new Date() };
  const production = createOnboardingV2Adapters({
    clock,
    // The OTP lane is unreachable here: a web worker arrives already
    // authenticated by Cognito, with a `users` row minted at signup.
    reconcileUserRow: unreachable('reconcileUserRow (OTP lane)') as never,
    cognitoClient: { send: unreachable('Cognito (OTP lane)') },
    userPoolId: '',
    clientId: '',
  });

  const identity: IdentityAdapter = {
    issueChallenge: unreachable('adapters.identity.issueChallenge') as never,
    verifyChallenge: unreachable('adapters.identity.verifyChallenge') as never,
  };

  return {
    adapters: {
      clock,
      identity,
      location: production.location,
      trustQuestions: production.trustQuestions,
      profile: production.profile,
    },
    repo: {
      setInternalUserRlsContext,
      loadPreAuthStateForUpdate: unreachable('repo.loadPreAuthStateForUpdate') as never,
      savePreAuthState: unreachable('repo.savePreAuthState') as never,
      bindVerifiedIdentityAndStartWorkflow: unreachable('repo.bindVerifiedIdentityAndStartWorkflow') as never,
      loadWorkerGate,
      advanceWorkflow: advanceWorkflow as OnboardingV2Deps['repo']['advanceWorkflow'],
      setRunPreferredLanguage,
      reactivateDeclinedLegalRun,
      appendTransition,
      clearProfileAnswers,
      resetPendingTrustAssessmentAndSkills,
      findPreviousStepKey,
      completeOnboarding,
    },
    // CAPTURE-ONLY. Writing a real intent here would text the worker on
    // WhatsApp for every web form field they filled in. The prompt is built
    // and discarded; the web owns its copy.
    enqueueWorkerMessage: async (_client, input) => {
      options.onPrompt?.(input.sourceType);
      return { intentId: randomUUID(), decision: { decision: 'suppressed:web_door' }, outboxMaterialized: false };
    },
    // No Twilio inbound message sid exists, and a bound web worker never
    // travels the phone-keyed pre-auth gateway.
    enqueuePreAuthPrompt: unreachable('enqueuePreAuthPrompt') as never,
    enqueuePreAuthText: unreachable('enqueuePreAuthText') as never,
    hashNormalizedPhone,
    tosUrl: options.tosUrl,
    privacyUrl: options.privacyUrl,
    workflowVersion: options.workflowVersion,
    requiredLegalVersion: options.requiredLegalVersion,
    recordLegalAcceptance: recordCanonicalWhatsAppConsent,
    // A web form has no voice notes, and `voiceIntake.enabled` is
    // load-bearing rather than hygiene: with it true, accepting the legal
    // terms routes to `profile.voice_choice`, a step the web flow has no
    // value shape for.
    voiceIntake: {
      enabled: false,
      startTrustTranscription: unreachable('voiceIntake.startTrustTranscription') as never,
      ingestProfileVoiceNote: unreachable('voiceIntake.ingestProfileVoiceNote') as never,
    },
  };
}

// ── Session: a request-scoped stand-in for `whatsapp_conversations` ──────

/**
 * The engine takes a `session`. A web worker has no conversation row, so one
 * is invented per request:
 *   - `id` is never read by a bound step (only the pre-auth handlers use it).
 *   - `whatsapp_number` is the worker's `users.phone`, which is what
 *     `completeOnboarding` hashes when it looks for a parked referral claim.
 *     `users.phone` is NULLABLE (001), and `hashNormalizedPhone` only
 *     `.trim()`s its argument — a null would throw on the THIRD trust answer,
 *     the very last step of onboarding. `?? ''` hashes deterministically and
 *     matches no parked claim, which is the correct outcome for a worker who
 *     never gave a phone number.
 *   - `state_context` starts empty and is hydrated from
 *     `worker_workflow_runs.context` by the engine (see
 *     `onboarding/durable-context.ts`). That is the whole cross-door resume.
 */
export function createWebSession(input: {
  workerId: string;
  phone: string | null;
  language: PreferredLanguage;
}): OnboardingV2Session {
  return {
    id: `web-request:${randomUUID()}`,
    user_id: input.workerId,
    whatsapp_number: input.phone ?? '',
    language: input.language,
    conversation_state: 'onboarding',
    state_context: {},
  };
}

function webMessage(phone: string, fields: { body?: string; interactivePayload?: string }): OnboardingV2InboundMessage {
  return {
    from: phone,
    body: fields.body ?? '',
    // `worker_workflow_transitions.inbound_message_sid` is plain TEXT. The
    // `web:` prefix is what makes a run's history legible: which steps were
    // answered in a browser and which over WhatsApp.
    messageSid: `web:${randomUUID()}`,
    interactivePayload: fields.interactivePayload,
  };
}

// ── Value -> engine message ──────────────────────────────────────────────

type Mapped =
  | { ok: true; fields: { body?: string; interactivePayload?: string } }
  | { ok: false; reason: string };

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The whole translation table. Each row is "what the browser posts" ->
 * "the exact message shape the step handler already parses", so no handler
 * needed a web-specific branch.
 */
export function mapAnswerToEngineMessage(
  stepKey: string,
  value: unknown,
  context: { pendingLocationConfirm: boolean },
): Mapped {
  switch (stepKey) {
    case 'legal.review': {
      // Only acceptance. `decline` is a real engine branch but a dead end on
      // this door: it parks the run at status='declined', where the ONLY way
      // forward is the WhatsApp "REVIEW TERMS" command, and the web flow has
      // no screen for that. Refusing it here is what keeps the web door from
      // being able to strand its own worker.
      if (asString(value) === 'accept') return { ok: true, fields: { body: 'accept' } };
      return { ok: false, reason: 'invalid_value' };
    }

    case 'profile.name': {
      const name = asString(value);
      if (name === null) return { ok: false, reason: 'invalid_value' };
      if (UNSTORABLE_TEXT.test(name)) return { ok: false, reason: 'invalid_value' };
      return { ok: true, fields: { body: name } };
    }

    case 'profile.location': {
      const loc = record(value);
      if (!loc) return { ok: false, reason: 'invalid_value' };
      if (loc.kind === 'zip') {
        const zip = asString(loc.zip);
        if (zip === null) return { ok: false, reason: 'invalid_value' };
        // Five digits, nothing else: no comma (which would make the resolver
        // parse it as "City, ST"), no length, no unstorable text.
        if (!WEB_ZIP_RE.test(zip)) return { ok: false, reason: 'invalid_value' };
        return { ok: true, fields: { body: zip } };
      }
      if (loc.kind === 'city_state') {
        const city = asString(loc.city);
        const state = asString(loc.state);
        if (city === null || state === null) return { ok: false, reason: 'invalid_value' };
        if (UNSTORABLE_TEXT.test(city) || UNSTORABLE_TEXT.test(state)) {
          return { ok: false, reason: 'invalid_value' };
        }
        if (city.length > LOCATION_CITY_MAX_CHARS || state.length > LOCATION_STATE_MAX_CHARS) {
          return { ok: false, reason: 'too_long' };
        }
        // The exact dialect `deps.adapters.location.resolve` parses.
        return { ok: true, fields: { body: `${city}, ${state}` } };
      }
      if (loc.kind === 'confirm') {
        // Not dead code despite the web never seeding a pending confirm since
        // the zip branch became five-digit-only: `pendingLocationConfirm` is
        // set by the WhatsApp door's fuzzy `inferCityState`, and a worker who
        // started on WhatsApp can answer the confirm here (one engine, two
        // doors). It only ever emits '1'/'2', so it carries no free text.
        if (typeof loc.accept !== 'boolean') return { ok: false, reason: 'invalid_value' };
        // '1'/'2' are the confirmation dialect `handleProfileLocation` reads,
        // and it reads them ONLY while a confirmation is parked. Sent
        // otherwise, '1' would be handed to the location resolver as if it
        // were a place name — so this is refused rather than mistranslated.
        if (!context.pendingLocationConfirm) return { ok: false, reason: 'no_pending_confirm' };
        return { ok: true, fields: { body: loc.accept ? '1' : '2' } };
      }
      return { ok: false, reason: 'invalid_value' };
    }

    case 'profile.trade': {
      const trade = asString(value);
      // Guards from the SHARED vocabulary (R2-C1), not a local copy: the
      // same module the frontend's picker mirrors, with a parity test over it.
      if (!isTradeKey(trade)) {
        return { ok: false, reason: 'invalid_choice' };
      }
      // V1's approved template dialect — `parseTradeChoice` accepts it.
      return { ok: true, fields: { interactivePayload: `profile:main_trade:${trade}` } };
    }

    case 'profile.custom_trade': {
      const text = asString(value);
      if (text === null) return { ok: false, reason: 'invalid_value' };
      const trimmed = text.trim();
      if (CONTROL_CHARS.test(trimmed) || UNSTORABLE_TEXT.test(trimmed)) {
        return { ok: false, reason: 'invalid' };
      }
      if (trimmed.length < CUSTOM_TRADE_MIN_CHARS) return { ok: false, reason: 'too_short' };
      if (trimmed.length > CUSTOM_TRADE_MAX_CHARS) return { ok: false, reason: 'too_long' };
      // The TRIMMED text, not the raw: `normalizeTrade` lowercases and slugs
      // it into `profession_key`, and a trailing space there would mint a
      // second cache row for the same trade.
      return { ok: true, fields: { body: trimmed } };
    }

    case 'profile.experience': {
      const band = asString(value);
      if (!isExperienceKey(band)) {
        return { ok: false, reason: 'invalid_choice' };
      }
      return { ok: true, fields: { interactivePayload: `profile:years_experience:${band}` } };
    }

    case 'profile.transportation': {
      if (typeof value !== 'boolean') return { ok: false, reason: 'invalid_choice' };
      return { ok: true, fields: { interactivePayload: `profile:has_transportation:${value}` } };
    }

    case 'profile.availability': {
      const availability = asString(value);
      if (!isAvailabilityKey(availability)) {
        return { ok: false, reason: 'invalid_choice' };
      }
      return { ok: true, fields: { interactivePayload: `profile:availability:${availability}` } };
    }

    case 'trust.question.1':
    case 'trust.question.2':
    case 'trust.question.3': {
      const wrapper = record(value);
      const text = wrapper ? asString(wrapper.text) : asString(value);
      if (text === null) return { ok: false, reason: 'invalid_value' };
      if (UNSTORABLE_TEXT.test(text)) return { ok: false, reason: 'invalid_value' };
      const trimmed = text.trim();
      if (trimmed.length < TRUST_ANSWER_MIN_CHARS) return { ok: false, reason: 'too_short' };
      if (trimmed.length > TRUST_ANSWER_MAX_CHARS) return { ok: false, reason: 'too_long' };
      // Sent as a plain body, and NOT through the command gate: an answer
      // that happens to read "back" or "hola" is an answer.
      return { ok: true, fields: { body: trimmed } };
    }

    default:
      return { ok: false, reason: 'unknown_step' };
  }
}

// ── Applying a batch ─────────────────────────────────────────────────────

function pendingConfirm(session: OnboardingV2Session): boolean {
  return Boolean(session.state_context?.v2LocationPendingConfirm);
}

/**
 * Applies each item IN ORDER through the real step handlers, in the caller's
 * single transaction, stopping at the first rejection.
 *
 * PARTIAL PROGRESS IS KEPT. The caller COMMITs even on a rejection, and that
 * is a deliberate reading of the engine's own semantics rather than a
 * shortcut: by the time item N is refused, items 1..N-1 have already been
 * persisted by `advanceWorkflow` — the run really is one step further along,
 * the worker really did answer those questions, and rolling back would throw
 * away correct work to make the HTTP response tidier. The 422 body carries
 * the fresh state, so the browser re-renders exactly where the engine is.
 */
export async function applyAnswerBatch(
  client: PoolClient,
  deps: OnboardingV2Deps,
  input: {
    workerId: string;
    session: OnboardingV2Session;
    gate: WorkerGate;
    answers: WebAnswerItem[];
    now: Date;
  },
): Promise<ApplyAnswersOutcome> {
  let gate = input.gate;
  let completed = false;

  // One hydrate for the whole batch: the value mapper needs to know whether a
  // location confirmation is parked BEFORE it translates the first item, and
  // `dispatchWebBoundStep`'s own hydrate is then a no-op.
  await hydrateSessionFromRun(client, input.session, gate.runId as string);

  for (const item of input.answers) {
    if (!WEB_ANSWERABLE_STEPS.has(item.stepKey)) {
      return { rejection: { code: 'unknown_step', stepKey: item.stepKey, reason: 'unknown_step' }, completed };
    }

    // A run parked on a handler-less step (050 widened the CHECK ahead of the
    // photo handlers). Reaching `handleProfileAndTrust` with one throws.
    if (isUnimplementedBoundStep(gate.currentStepKey ?? '')) {
      return {
        rejection: { code: 'step_mismatch', stepKey: item.stepKey, reason: 'run_parked_on_unimplemented_step' },
        completed,
      };
    }

    // A declined legal run reached from the other door. Accepting the terms
    // is exactly what WhatsApp's "REVIEW TERMS" does: reactivate first, then
    // let the real handler run.
    if (gate.status === 'declined' && gate.currentStepKey === 'legal.review' && item.stepKey === 'legal.review') {
      gate = await deps.repo.reactivateDeclinedLegalRun(client, {
        runId: gate.runId as string,
        expectedLockVersion: gate.lockVersion as number,
      });
    }

    if (gate.status !== 'active') {
      // The run finished (or was cancelled) since the client last read it.
      return { rejection: { code: 'step_mismatch', stepKey: item.stepKey, reason: 'run_not_active' }, completed };
    }

    if (gate.currentStepKey !== item.stepKey) {
      return {
        rejection: { code: 'step_mismatch', stepKey: item.stepKey, reason: `expected:${gate.currentStepKey}` },
        completed,
      };
    }

    const mapped = mapAnswerToEngineMessage(item.stepKey, item.value, {
      pendingLocationConfirm: pendingConfirm(input.session),
    });
    if (!mapped.ok) {
      return { rejection: { code: 'step_rejected', stepKey: item.stepKey, reason: mapped.reason }, completed };
    }

    const before = gate.lockVersion as number;
    await dispatchWebBoundStep(
      client,
      input.session,
      webMessage(input.session.whatsapp_number, mapped.fields),
      deps,
      gate,
      input.now,
    );

    const after = await deps.repo.loadWorkerGate(client, input.workerId);
    if (!after) throw new Error('worker_gate_missing_after_web_step');

    // The engine refuses by reprompting, not by throwing: an unchanged
    // lock_version is the one exact signal that nothing was accepted.
    if (after.lockVersion === before) {
      return { rejection: { code: 'step_rejected', stepKey: item.stepKey, reason: 'rejected' }, completed };
    }

    completed = completed || after.status === 'completed';
    gate = after;
  }

  return { rejection: null, completed };
}

// ── BACK ─────────────────────────────────────────────────────────────────

/**
 * `worker_back_web`, not `web_back`.
 *
 * `findPreviousStepKey` (onboarding-repository.ts) excludes transitions whose
 * `reason NOT LIKE 'worker\_%'` — that exclusion is exactly what stops a BACK
 * transition from being read as "the step before" on the NEXT back press.
 * A reason of `web_back` does not match the pattern, so pressing back twice
 * would find the first back's own row (`to_step_key` matches, and it is the
 * most recent) and walk the run FORWARD again. The `_web` suffix keeps the
 * two doors distinguishable in the transition history while staying inside
 * the pattern that makes back idempotent.
 */
export const WEB_BACK_REASON = 'worker_back_web';

/** Profile/trust steps only — matches the gate's own BACK scoping. */
const PROFILE_OR_TRUST_STEP = /^(profile\.|trust\.question\.)/;

export type BackOutcome = { moved: true; gate: WorkerGate } | { moved: false; reason: string };

/**
 * The two PRE-AUTH step keys. They belong to the `worker_identity_challenges`
 * lane (`PreAuthState.currentStepKey` is typed as exactly this pair), NOT to
 * `worker_workflow_runs` — see `healPreAuthStep`.
 */
const PRE_AUTH_STEP_KEYS: ReadonlySet<string> = new Set([
  'start.choose_language',
  'identity.verify_otp',
]);

/**
 * Repair a bound run parked on a pre-auth step, and return the gate to serve
 * the request from.
 *
 * CAN THIS HAPPEN? Not by any live code path. `worker_workflow_runs` rows are
 * born at `legal.review` and only there: `bind_verified_identity_and_start_
 * workflow` (WhatsApp, after OTP) and `start_web_onboarding_workflow` (086,
 * this door) both insert with `current_step_key = 'legal.review'`, and no
 * handler ever advances a bound run BACKWARD onto a pre-auth key
 * (`findPreviousStepKey` excludes both from `from_step_key` explicitly). The
 * pre-auth steps live in a different table entirely. The residual sources are
 * operator tooling (the reset CLI once seeded exactly this row) and legacy
 * rows — which is why `routeBoundStepHydrated` carries the identical repair
 * for the WhatsApp door.
 *
 * The web door needs its own copy because it deliberately enters BELOW that
 * function (`dispatchWebBoundStep` skips the command gate). Without it such a
 * run would render as a Terms screen the browser can never get past: the FE
 * maps both keys to Terms, whose only post is `legal.review`, which this
 * door would answer with `step_mismatch` forever.
 *
 * Reason string is `self_heal_preauth_step`, the SAME one the WhatsApp door
 * writes — deliberately not a web-specific reason. `findPreviousStepKey`'s
 * contract names that reason as the legitimate producer of pre-auth
 * `from_step_key` rows; a second string for an identical repair would split
 * the audit trail for no gain. The DOOR is recorded in the metric line
 * instead.
 */
export async function healPreAuthStep(
  client: PoolClient,
  deps: OnboardingV2Deps,
  input: { workerId: string; gate: WorkerGate },
): Promise<WorkerGate> {
  const gate = input.gate;
  const stepKey = gate.currentStepKey;
  if (!stepKey || !PRE_AUTH_STEP_KEYS.has(stepKey)) return gate;
  if (gate.status !== 'active') return gate;

  console.warn(JSON.stringify({
    metric: 'OnboardingBoundStepSelfHealed',
    door: 'web',
    fromStepKey: stepKey,
    runId: gate.runId,
  }));

  await deps.repo.advanceWorkflow(client, {
    runId: gate.runId as string,
    expectedLockVersion: gate.lockVersion as number,
    fromStepKey: stepKey as WorkflowStepKey,
    toStepKey: 'legal.review',
    contextPatch: {},
    inboundMessageSid: `web:${randomUUID()}`,
    reason: 'self_heal_preauth_step',
  });

  const healed = await deps.repo.loadWorkerGate(client, input.workerId);
  if (!healed?.runId) throw new Error('worker_gate_missing_after_preauth_heal');
  return healed;
}

export async function applyBack(
  client: PoolClient,
  deps: OnboardingV2Deps,
  input: { gate: WorkerGate; now: Date },
): Promise<BackOutcome> {
  const gate = input.gate;
  const stepKey = gate.currentStepKey as WorkflowStepKey;

  if (gate.status !== 'active') return { moved: false, reason: 'run_not_active' };
  if (!PROFILE_OR_TRUST_STEP.test(stepKey) || stepKey === 'profile.name') {
    return { moved: false, reason: 'nothing_to_go_back_to' };
  }

  const previous = await deps.repo.findPreviousStepKey(client, gate.runId as string, stepKey);
  if (!previous || !PROFILE_OR_TRUST_STEP.test(previous)) {
    return { moved: false, reason: 'nothing_to_go_back_to' };
  }

  const moved = await deps.repo.advanceWorkflow(client, {
    runId: gate.runId as string,
    expectedLockVersion: gate.lockVersion as number,
    fromStepKey: stepKey,
    toStepKey: previous,
    contextPatch: {},
    inboundMessageSid: `web:${randomUUID()}`,
    reason: WEB_BACK_REASON,
  });

  // No durable-bag write here on purpose. BACK changes the run's CURSOR, not
  // the bag: the questions, trade and provenance the worker is stepping back
  // over are still the ones that apply, and re-seeding happens when (and only
  // when) `profile.trade` is answered again. A blind write from a session
  // this endpoint never hydrated would null the whole bag out.
  return { moved: true, gate: moved };
}

// ── Language ─────────────────────────────────────────────────────────────

/**
 * Mirrors the IDIOMA command's write path exactly (`onboarding/gate.ts`):
 * `setRunPreferredLanguage` persists `worker_workflow_runs.preferred_language`
 * — the column the release renderer reads — and `v2PreferredLanguageOverride`
 * is the in-flight override every subsequent prompt honours. R2-C23 made that
 * second half durable (it now lands in `worker_workflow_runs.context`), which
 * is what lets a web language change survive to the next HTTP request AND be
 * seen by WhatsApp.
 *
 * A run that is not active is a no-op, NOT a conflict: `setRunPreferredLanguage`
 * has `AND status = 'active'` in its WHERE clause, so on a completed run it
 * matches zero rows and throws `workflow_lock_conflict` — which would 409 a
 * `ready` worker forever every time they touched the language toggle still on
 * their screen.
 */
export async function setPreferredLanguage(
  client: PoolClient,
  deps: OnboardingV2Deps,
  input: {
    gate: WorkerGate;
    session: OnboardingV2Session;
    preferredLanguage: PreferredLanguage;
  },
): Promise<WorkerGate> {
  if (input.gate.status !== 'active') return input.gate;

  // MUST hydrate before persisting: `durableContextPatch` writes an explicit
  // null for every durable key the session lacks (that is how RESTART's
  // deletions propagate), so writing back an un-hydrated session would erase
  // the worker's seeded trust questions.
  await hydrateSessionFromRun(client, input.session, input.gate.runId as string);

  const updated = await deps.repo.setRunPreferredLanguage(client, {
    runId: input.gate.runId as string,
    expectedLockVersion: input.gate.lockVersion as number,
    preferredLanguage: input.preferredLanguage,
  });

  input.session.state_context.v2PreferredLanguageOverride = input.preferredLanguage;
  await persistDurableStateContext(client, input.gate.runId as string, input.session.state_context);
  return updated;
}
