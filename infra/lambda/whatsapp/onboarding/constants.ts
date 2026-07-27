/**
 * WhatsApp v2 onboarding router — step routing table, trade vocabulary, and
 * assessment provenance version constants. Moved verbatim out of
 * `../onboarding-v2.ts` (pure move, no behavior change).
 */

import type { MessageCategory, OwnerService } from '../lib/onboarding-types';

// ── Step routing table: which lane (owner/category/priority) a step's
//    prompts and replies travel through ──────────────────────────────

export const STEP_ROUTING: Record<string, { ownerService: OwnerService; category: MessageCategory; priority: number }> = {
  'start.choose_language': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'identity.verify_otp': { ownerService: 'identity', category: 'security', priority: 1 },
  'legal.review': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'profile.name': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'profile.location': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'profile.trade': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'profile.custom_trade': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'profile.experience': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'profile.transportation': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'profile.availability': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'trust.question.1': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'trust.question.2': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
  'trust.question.3': { ownerService: 'onboarding-v2', category: 'onboarding', priority: 5 },
};
export const DEFAULT_ROUTING = STEP_ROUTING['legal.review'];

// ── Task 5: profile/trust vocabulary + assessment provenance versions ───

/** Canonical trade slugs in list-picker order; mirrors flows.ts's TRADE_KEYS
 * (never imported directly — that module is out of this task's scope). */
export const TRADE_ORDER = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'] as const;
export type StandardTrade = Exclude<(typeof TRADE_ORDER)[number], 'other'>;

export const TRADE_LABELS: Record<(typeof TRADE_ORDER)[number], { en: string; es: string }> = {
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
export const V2_TRUST_QUESTION_SET_VERSION = 'v2-trust-questions-1';
export const V2_TRUST_FALLBACK_VERSION = 'v2-trust-fallback-1';
export const V2_TRUST_RUBRIC_VERSION = 'v2-trust-rubric-1';

export type BilingualQuestion = { en: string; es: string };

// ── Voice: which bound steps accept a voice note in place of typed text ──
//
// Only trust.question.* for now (Stream A); Stream B extends this to
// profile.voice_choice once full voice profile intake lands. Gated on the
// runtime control so a disabled control means every step — including
// trust — gives the honest "voice isn't available yet" reply rather than
// silently starting a transcription pipeline nobody is listening for.
export function isVoiceAcceptingStep(stepKey: string, voiceIntakeEnabled: boolean): boolean {
  return voiceIntakeEnabled && /^trust\.question\./.test(stepKey);
}
