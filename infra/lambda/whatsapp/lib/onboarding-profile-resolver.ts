/**
 * Pure conditional-step resolver bridging V1's seven-field profile builder
 * (`./flows.ts`'s `PROFILE_FIELDS` / `computeNextField`) to V2's
 * `WorkflowStepKey` step machine.
 *
 * PURE: no SQL, no clock, no I/O. This makes it trivially unit-testable and
 * reusable by both the synchronous WhatsApp router (onboarding-v2.ts) and a
 * future async AI-extraction callback that only has DB state (no in-flight
 * session `collected` bag).
 */

import { computeNextField, type ProfileField } from './flows';
import type { WorkflowStepKey } from './onboarding-types';

/** Maps each of V1's seven canonical profile fields onto the V2 step that
 * collects it. */
export const PROFILE_FIELD_TO_STEP: Record<ProfileField, WorkflowStepKey> = {
  full_name: 'profile.name',
  city: 'profile.location',
  main_trade: 'profile.trade',
  main_trade_other: 'profile.custom_trade',
  years_experience: 'profile.experience',
  has_transportation: 'profile.transportation',
  availability: 'profile.availability',
};

/**
 * Resolves the next V2 step for an in-progress or resuming profile.
 *
 * Delegates entirely to `computeNextField` (flows.ts) — same field order,
 * same "skip if already filled in DB or in `collected`" semantics, same
 * `main_trade_other` conditional (only surfaces when `main_trade === 'other'`).
 * Returns `null` when every applicable field is already filled, meaning the
 * profile is complete.
 *
 * `collected` defaults to `{}` since most callers (the V2 router included)
 * only have DB state — V2 persists each answer straight to `users` rather
 * than staging it in a session-local `collected` bag the way V1 does.
 */
export function resolveNextProfileStep(
  dbFilled: Partial<Record<ProfileField, string | boolean | null>>,
  collected: Partial<Record<ProfileField, string | boolean>> = {},
): WorkflowStepKey | null {
  const nextField = computeNextField(collected, dbFilled);
  return nextField === null ? null : PROFILE_FIELD_TO_STEP[nextField];
}
