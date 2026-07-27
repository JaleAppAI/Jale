/**
 * Stream B (task 8c): pure extraction planner for full voice profile intake.
 *
 * `planExtractionWrites` turns a Bedrock extraction result
 * (`VoiceExtractionFields` + per-field confidence scores) into a list of
 * concrete `ProfilePersistenceAdapter` calls to make — never SQL, never a
 * raw column write. PURE: no I/O, no clock, no randomness, so it is
 * trivially unit-testable and safe to call from both the router
 * (`onboarding/steps/voice.ts`) and any future offline backfill tooling.
 *
 * Three safety invariants this module exists to enforce:
 *
 *   1. NULL-only fill — a worker's own typed/voice answer always wins. A
 *      field already present in `dbFilled` is never overwritten by an
 *      extraction, no matter how confident.
 *   2. `chk_trade_other` safety (004_whatsapp.sql) — `main_trade = 'other'`
 *      with `main_trade_other` still NULL violates that CHECK. This module
 *      NEVER emits a bare `{ field: 'trade', value: 'other' }` write; the
 *      'other' case is only ever emitted as the atomic
 *      `{ field: 'custom_trade', value: <text> }` write (which maps 1:1 to
 *      `ProfilePersistenceAdapter.saveCustomTrade`, itself an atomic
 *      `main_trade='other' AND main_trade_other=$2` UPDATE) — and only when
 *      Bedrock actually extracted non-empty free text for it. If the model
 *      says "other" with no usable free text, BOTH columns are skipped
 *      rather than partially applied.
 *   3. Strict enums, no fuzzy coercion — `years_experience`, `availability`,
 *      and the standard trade slugs are matched against the exact DB CHECK
 *      vocabulary. "3 years" is not coerced to "2-4"; it is skipped.
 *
 * Every field is independent: a low-confidence or invalid trade does not
 * block a high-confidence name from writing.
 */

import type { ProfileField } from './flows';
import type { VoiceExtractionFields } from './voice-events';
import type { ResolvedLocation } from './onboarding-adapters';

/** One `StandardTrade` slug (mirrors onboarding/constants.ts's TRADE_ORDER
 * minus 'other', duplicated here rather than imported so this module stays
 * dependency-free of the router's constants module). */
const STANDARD_TRADES = new Set([
  'electrician',
  'plumber',
  'carpenter',
  'concrete',
  'painting',
]);

const VALID_EXPERIENCE = new Set(['0-1', '2-4', '5-9', '10+']);
const VALID_AVAILABILITY = new Set(['full_time', 'part_time', 'weekends', 'flexible']);

/**
 * One concrete write to make, shaped 1:1 onto a `ProfilePersistenceAdapter`
 * method name — the caller never has to decide which adapter method a write
 * maps to, which is exactly what keeps a raw column write from ever
 * happening by construction.
 */
export type ExtractionWrite =
  | { field: 'full_name'; value: string }
  | { field: 'location'; value: ResolvedLocation }
  | { field: 'trade'; value: string }
  | { field: 'custom_trade'; value: string }
  | { field: 'years_experience'; value: string }
  | { field: 'has_transportation'; value: boolean }
  | { field: 'availability'; value: string };

export interface SkippedField {
  field: string;
  reason:
    | 'already_filled'
    | 'low_confidence'
    | 'invalid_enum'
    | 'invalid_type'
    | 'empty'
    | 'unresolvable_location'
    | 'other_missing_text';
}

export interface PlanExtractionResult {
  writes: ExtractionWrite[];
  /** Canonical `ProfileField` keys that landed a write — both `main_trade`
   * and `main_trade_other` when the atomic custom-trade write fired. */
  appliedFields: ProfileField[];
  skipped: SkippedField[];
}

export interface PlanExtractionOptions {
  /** Minimum per-field confidence (0..1) required to accept a value. */
  threshold: number;
  /** Same contract as `LocationResolver.resolve` (onboarding-adapters.ts):
   * ZIP or "City, ST" only; anything else (a bare city, a landmark, ...)
   * returns null and the field is skipped rather than guessed at. */
  resolveLocation: (raw: string) => ResolvedLocation | null;
}

function confidenceOk(confidences: Record<string, number>, key: string, threshold: number): boolean {
  const score = confidences[key];
  return typeof score === 'number' && Number.isFinite(score) && score >= threshold;
}

function isAlreadyFilled(
  dbFilled: Partial<Record<ProfileField, string | boolean | null>>,
  field: ProfileField,
): boolean {
  const value = dbFilled[field];
  return value !== undefined && value !== null && value !== '';
}

export function planExtractionWrites(
  dbFilled: Partial<Record<ProfileField, string | boolean | null>>,
  fields: VoiceExtractionFields,
  confidences: Record<string, number>,
  options: PlanExtractionOptions,
): PlanExtractionResult {
  const writes: ExtractionWrite[] = [];
  const appliedFields: ProfileField[] = [];
  const skipped: SkippedField[] = [];
  const { threshold, resolveLocation } = options;

  // ── full_name ──────────────────────────────────────────────────────
  if (isAlreadyFilled(dbFilled, 'full_name')) {
    skipped.push({ field: 'full_name', reason: 'already_filled' });
  } else if (fields.full_name != null) {
    const trimmed = fields.full_name.trim();
    if (trimmed.length === 0) {
      skipped.push({ field: 'full_name', reason: 'empty' });
    } else if (!confidenceOk(confidences, 'full_name', threshold)) {
      skipped.push({ field: 'full_name', reason: 'low_confidence' });
    } else {
      writes.push({ field: 'full_name', value: trimmed });
      appliedFields.push('full_name');
    }
  }

  // ── city / location ────────────────────────────────────────────────
  if (isAlreadyFilled(dbFilled, 'city')) {
    skipped.push({ field: 'city', reason: 'already_filled' });
  } else if (fields.city != null) {
    const trimmed = fields.city.trim();
    if (trimmed.length === 0) {
      skipped.push({ field: 'city', reason: 'empty' });
    } else if (!confidenceOk(confidences, 'city', threshold)) {
      skipped.push({ field: 'city', reason: 'low_confidence' });
    } else {
      const resolved = resolveLocation(trimmed);
      if (!resolved) {
        skipped.push({ field: 'city', reason: 'unresolvable_location' });
      } else {
        writes.push({ field: 'location', value: resolved });
        appliedFields.push('city');
      }
    }
  }

  // ── main_trade / main_trade_other (atomic) ────────────────────────
  if (isAlreadyFilled(dbFilled, 'main_trade')) {
    skipped.push({ field: 'main_trade', reason: 'already_filled' });
  } else if (fields.main_trade != null) {
    if (!confidenceOk(confidences, 'main_trade', threshold)) {
      skipped.push({ field: 'main_trade', reason: 'low_confidence' });
    } else if (STANDARD_TRADES.has(fields.main_trade)) {
      writes.push({ field: 'trade', value: fields.main_trade });
      appliedFields.push('main_trade');
    } else if (fields.main_trade === 'other') {
      const otherText = typeof fields.main_trade_other === 'string' ? fields.main_trade_other.trim() : '';
      if (otherText.length > 0) {
        // Atomic: main_trade='other' + main_trade_other=<text> via
        // saveCustomTrade — chk_trade_other can never fire because this is
        // the ONLY branch that ever touches main_trade='other', and it
        // never fires without non-empty free text.
        writes.push({ field: 'custom_trade', value: otherText });
        appliedFields.push('main_trade', 'main_trade_other');
      } else {
        skipped.push({ field: 'main_trade', reason: 'other_missing_text' });
      }
    } else {
      skipped.push({ field: 'main_trade', reason: 'invalid_enum' });
    }
  }

  // ── years_experience ───────────────────────────────────────────────
  if (isAlreadyFilled(dbFilled, 'years_experience')) {
    skipped.push({ field: 'years_experience', reason: 'already_filled' });
  } else if (fields.years_experience != null) {
    if (!VALID_EXPERIENCE.has(fields.years_experience)) {
      skipped.push({ field: 'years_experience', reason: 'invalid_enum' });
    } else if (!confidenceOk(confidences, 'years_experience', threshold)) {
      skipped.push({ field: 'years_experience', reason: 'low_confidence' });
    } else {
      writes.push({ field: 'years_experience', value: fields.years_experience });
      appliedFields.push('years_experience');
    }
  }

  // ── has_transportation ─────────────────────────────────────────────
  if (isAlreadyFilled(dbFilled, 'has_transportation')) {
    skipped.push({ field: 'has_transportation', reason: 'already_filled' });
  } else if (fields.has_transportation != null) {
    if (typeof fields.has_transportation !== 'boolean') {
      skipped.push({ field: 'has_transportation', reason: 'invalid_type' });
    } else if (!confidenceOk(confidences, 'has_transportation', threshold)) {
      skipped.push({ field: 'has_transportation', reason: 'low_confidence' });
    } else {
      writes.push({ field: 'has_transportation', value: fields.has_transportation });
      appliedFields.push('has_transportation');
    }
  }

  // ── availability ───────────────────────────────────────────────────
  if (isAlreadyFilled(dbFilled, 'availability')) {
    skipped.push({ field: 'availability', reason: 'already_filled' });
  } else if (fields.availability != null) {
    if (!VALID_AVAILABILITY.has(fields.availability)) {
      skipped.push({ field: 'availability', reason: 'invalid_enum' });
    } else if (!confidenceOk(confidences, 'availability', threshold)) {
      skipped.push({ field: 'availability', reason: 'low_confidence' });
    } else {
      writes.push({ field: 'availability', value: fields.availability });
      appliedFields.push('availability');
    }
  }

  return { writes, appliedFields, skipped };
}
