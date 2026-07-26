/**
 * WhatsApp v2 onboarding router — bound `profile.*` steps (name, location,
 * trade, custom trade, experience, transportation, availability). Moved
 * verbatim out of `../../onboarding-v2.ts` (pure move, no behavior change).
 */

import type { PoolClient } from 'pg';
import type { WorkerGate } from '../../lib/onboarding-repository';
import type { Lang } from '../../lib/templates';
import { V2_FALLBACK_TRUST_QUESTIONS } from '../../lib/interactive-templates';
import {
  normalizeTrade,
  standardTrustQuestions,
  type ResolvedLocation,
} from '../../lib/onboarding-adapters';
import {
  parseProfileAnswer,
  parseProfilePayloadAnswer,
  type ProfileField,
} from '../../lib/flows';
import type { OnboardingV2Deps, OnboardingV2InboundMessage, OnboardingV2Session, RouteResult } from '../types';
import {
  TRADE_ORDER,
  type StandardTrade,
  type BilingualQuestion,
  V2_TRUST_QUESTION_SET_VERSION,
  V2_TRUST_FALLBACK_VERSION,
  V2_TRUST_RUBRIC_VERSION,
} from '../constants';
import { repeatCurrentPrompt } from '../delivery';
import { advanceProfileToNextStep } from '../transitions';

// ── Bound: profile.name ──────────────────────────────────────────────────

export async function handleProfileName(
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
  return advanceProfileToNextStep(
    client, session, msg, deps, gate,
    'profile.name',
    { nameSetAt: now.toISOString() },
    'profile_name_set',
    now,
  );
}

// ── Bound: profile.location ──────────────────────────────────────────────

export async function handleProfileLocation(
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
  return advanceProfileToNextStep(
    client, session, msg, deps, gate,
    'profile.location',
    { locationSource: resolved.source },
    'profile_location_set',
    now,
  );
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

export async function handleProfileTrade(
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
    // computeNextField's main_trade_other conditional activates now that
    // main_trade === 'other' is on the DB row, so the resolver naturally
    // lands on profile.custom_trade next — no hardcoding needed here.
    return advanceProfileToNextStep(
      client, session, msg, deps, gate,
      'profile.trade',
      { selectedTrade: 'other' },
      'profile_trade_other',
      now,
    );
  }

  const trade: StandardTrade = choice;
  await deps.adapters.profile.saveTrade(client, gate.userId, trade);

  // Precompute and cache the standard trust-question set now (unconditionally,
  // even though the resolver may route through profile.experience/
  // transportation/availability before actually reaching trust.question.1) —
  // harmless to set early, and it's exactly what's needed whenever the run
  // does arrive at trust.question.1.
  const questions: BilingualQuestion[] = standardTrustQuestions(trade).map((q) => ({ en: q.q_en, es: q.q_es }));
  session.state_context.v2ProfileTrade = trade;
  session.state_context.v2TrustQuestions = questions;
  session.state_context.v2TrustSource = 'standard';
  session.state_context.v2QuestionSetVersion = V2_TRUST_QUESTION_SET_VERSION;
  session.state_context.v2RubricVersion = V2_TRUST_RUBRIC_VERSION;

  return advanceProfileToNextStep(
    client, session, msg, deps, gate,
    'profile.trade',
    { trade, trustQuestionSource: 'standard' },
    'profile_trade_standard',
    now,
  );
}

// ── Bound: profile.custom_trade ──────────────────────────────────────────

export async function handleCustomTrade(
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

  // Defect 1 fix: persist the RAW typed profession (e.g. "welder"), not just
  // the normalized lookup key — V1 already does this, and
  // upsertWorkerProfileFromUsers needs `main_trade_other` to seed a
  // meaningful worker_skills row (it refuses to seed the literal 'other').
  // The normalized key still goes into v2ProfileTrade exactly as before —
  // the trust-question lookup below depends on it.
  await deps.adapters.profile.saveCustomTrade(client, gate.userId, professionRaw);
  session.state_context.v2ProfileTrade = professionKey;
  session.state_context.v2TrustQuestions = questions;
  session.state_context.v2TrustSource = source;
  session.state_context.v2QuestionSetVersion = source === 'fallback' ? V2_TRUST_FALLBACK_VERSION : V2_TRUST_QUESTION_SET_VERSION;
  session.state_context.v2RubricVersion = V2_TRUST_RUBRIC_VERSION;

  // `saveCustomTrade` above persists main_trade_other, so loadProfileFromDb
  // resolves this field on its own. The state_context copy is kept as a
  // belt-and-braces override for the same turn: the resolver runs inside this
  // transaction, and a partially-applied write must never bounce the worker
  // back to profile.custom_trade in a loop.
  session.state_context.v2CustomTradeText = professionRaw;

  return advanceProfileToNextStep(
    client, session, msg, deps, gate,
    'profile.custom_trade',
    { customTrade: professionKey, trustQuestionSource: source },
    'profile_custom_trade_set',
    now,
  );
}

// ── Bound: profile.experience / profile.transportation / profile.availability
//    (V1/V2 parity: the four fields V1 always asked that V2 previously
//    never collected) ────────────────────────────────────────────────────

export async function handleProfileExperience(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
): Promise<RouteResult> {
  const value = parseProfileFieldChoice('years_experience', msg);
  if (typeof value !== 'string') {
    await repeatCurrentPrompt(client, session, deps, gate.userId, 'profile.experience', lang, now, gate.runId!, msg.messageSid);
    return { handled: true, workerId: gate.userId, stepKey: 'profile.experience' };
  }

  await deps.adapters.profile.saveExperience(client, gate.userId, value);
  return advanceProfileToNextStep(
    client, session, msg, deps, gate,
    'profile.experience',
    { yearsExperience: value },
    'profile_experience_set',
    now,
  );
}

export async function handleProfileTransportation(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
): Promise<RouteResult> {
  const value = parseProfileFieldChoice('has_transportation', msg);
  if (typeof value !== 'boolean') {
    await repeatCurrentPrompt(client, session, deps, gate.userId, 'profile.transportation', lang, now, gate.runId!, msg.messageSid);
    return { handled: true, workerId: gate.userId, stepKey: 'profile.transportation' };
  }

  await deps.adapters.profile.saveTransportation(client, gate.userId, value);
  return advanceProfileToNextStep(
    client, session, msg, deps, gate,
    'profile.transportation',
    { hasTransportation: value },
    'profile_transportation_set',
    now,
  );
}

export async function handleProfileAvailability(
  client: PoolClient,
  session: OnboardingV2Session,
  msg: OnboardingV2InboundMessage,
  deps: OnboardingV2Deps,
  gate: WorkerGate,
  lang: Lang,
  now: Date,
): Promise<RouteResult> {
  const value = parseProfileFieldChoice('availability', msg);
  if (typeof value !== 'string') {
    await repeatCurrentPrompt(client, session, deps, gate.userId, 'profile.availability', lang, now, gate.runId!, msg.messageSid);
    return { handled: true, workerId: gate.userId, stepKey: 'profile.availability' };
  }

  await deps.adapters.profile.saveAvailability(client, gate.userId, value);
  return advanceProfileToNextStep(
    client, session, msg, deps, gate,
    'profile.availability',
    { availability: value },
    'profile_availability_set',
    now,
  );
}

/** Dual-input parse for a buttons-type profile field: an interactive tap
 * (`profile:<field>:<value>`, parsed by `parseProfilePayloadAnswer`) or the
 * typed numeric fallback (`parseProfileAnswer`) — mirrors how
 * `parseTradeChoice` accepts both dialects for `profile.trade`. */
function parseProfileFieldChoice(
  field: ProfileField,
  msg: OnboardingV2InboundMessage,
): string | boolean | null {
  if (msg.interactivePayload) {
    return parseProfilePayloadAnswer(field, msg.interactivePayload);
  }
  return parseProfileAnswer(field, msg.body ?? '');
}
