/**
 * WhatsApp conversation state machine + profile builder.
 *
 * Exports pure logic — no AWS SDK, no DB, no Twilio. The processor Lambda
 * wires this to real side effects. Keeping flows.ts pure makes it easy to
 * unit-test state transitions without mocking half the cloud.
 *
 * Source: 2026-04-09-whatsapp-v1-profile-builder-design.md (authoritative
 * on state machine and profile builder), 2026-04-07 (conversation flows).
 */

import type { Lang } from './templates';

// ── Conversation state types ────────────────────────────────────

export type ConversationState =
  | 'new'
  | 'awaiting_otp'
  | 'awaiting_legal'
  | 'building_profile'
  | 'legal_declined'
  | 'otp_timeout'
  | 'idle';

/** Canonical slugs matching users.main_trade CHECK constraint */
export type TradeSlug =
  | 'electrician'
  | 'plumber'
  | 'carpenter'
  | 'concrete'
  | 'painting'
  | 'other';

/** Canonical slugs matching users.years_experience CHECK constraint */
export type ExperienceSlug = '0-1' | '2-4' | '5-9' | '10+';

/** Canonical slugs matching users.availability CHECK constraint */
export type AvailabilitySlug =
  | 'full_time'
  | 'part_time'
  | 'weekends'
  | 'flexible';

// ── Profile builder: pending-field model ────────────────────────

export type ProfileField =
  | 'full_name'
  | 'city'
  | 'main_trade'
  | 'main_trade_other'
  | 'years_experience'
  | 'has_transportation'
  | 'availability';

export interface ProfileFieldDef {
  field: ProfileField;
  type: 'text' | 'buttons';
  conditional?: boolean; // main_trade_other is only asked when main_trade === 'other'
  options?: readonly (string | boolean)[];
}

/**
 * Ordered list of profile fields. Used by computeNextField() to walk the
 * pending-field state machine in order, honoring conditional branches and
 * already-filled fields.
 */
export const PROFILE_FIELDS: readonly ProfileFieldDef[] = [
  { field: 'full_name', type: 'text' },
  { field: 'city', type: 'text' },
  {
    field: 'main_trade',
    type: 'buttons',
    options: ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'],
  },
  // Conditional: only activated when main_trade === 'other'
  { field: 'main_trade_other', type: 'text', conditional: true },
  {
    field: 'years_experience',
    type: 'buttons',
    options: ['0-1', '2-4', '5-9', '10+'],
  },
  {
    field: 'has_transportation',
    type: 'buttons',
    options: [true, false],
  },
  {
    field: 'availability',
    type: 'buttons',
    options: ['full_time', 'part_time', 'weekends', 'flexible'],
  },
] as const;

/**
 * Shape of the `whatsapp_conversations.state_context` JSONB column.
 *
 * Extended 2026-04-17 (Codex fix pass):
 *   - `cognito_session` persists the Cognito custom-auth Session string between
 *     webhook deliveries so `RespondToAuthChallenge` doesn't need a fresh
 *     `InitiateAuth` per attempt (which would rotate the OTP and invalidate
 *     the code the worker actually received).
 *   - `otp_issued_at` is informational only — used for log correlation when
 *     diagnosing expired-code vs wrong-code failures.
 *   - `field_sids` binds each accepted profile answer to the Twilio
 *     `MessageSid` that produced it. On SQS retry we can detect "this SID
 *     already produced a field-write" and short-circuit, independently of
 *     the coarse-grained `last_processed_message_sid` column.
 */
export interface ProfileStateContext {
  pending_field?: ProfileField;
  collected?: Partial<Record<ProfileField, string | boolean>>;
  /** Cognito custom-auth Session string (Fix 1). Cleared on OTP success. */
  cognito_session?: string;
  /** ISO timestamp of the most recent `InitiateAuth` that sent an SMS. */
  otp_issued_at?: string;
  /** Map of accepted profile field → MessageSid that wrote it (Fix 3). */
  field_sids?: Partial<Record<ProfileField, string>>;
}

// ── Keyword detection ───────────────────────────────────────────

export function isGreetingKeyword(text: string): boolean {
  const n = text.trim().toLowerCase();
  return /^(hola|hello|hi|hey|buenas|buenos d[ií]as)\b/.test(n);
}

export function isJobsKeyword(text: string): boolean {
  const n = text.trim().toLowerCase();
  return /^(trabajos?|jobs?|empleos?)\b/.test(n);
}

// JS `\b` is ASCII-only, so it fails on Spanish accented chars (sí, está).
// Use a lookahead asserting either whitespace or end-of-string after the match.
const ES_ACCEPT = /^(acepto|sí|si)(?=\s|$)/;
const EN_ACCEPT = /^(accept|yes|i accept)(?=\s|$)/;
const ES_DECLINE = /^(no acepto|no)(?=\s|$)/;
const EN_DECLINE = /^(decline|no)(?=\s|$)/;

export function isAccept(text: string, lang: Lang): boolean {
  const n = text.trim().toLowerCase();
  return (lang === 'es' ? ES_ACCEPT : EN_ACCEPT).test(n);
}

export function isDecline(text: string, lang: Lang): boolean {
  const n = text.trim().toLowerCase();
  return (lang === 'es' ? ES_DECLINE : EN_DECLINE).test(n);
}

// ── Button payload parsing (for future template replies) ────────

export interface ButtonPayload {
  action: 'accept' | 'decline' | 'info';
  jobId: string;
}

/**
 * Parse a self-identifying job alert button payload like "accept:job-abc-123".
 * Used when a worker taps a button on a Twilio template job alert.
 *
 * Returns null for unrecognized payloads.
 */
export function parseButtonPayload(payload: string): ButtonPayload | null {
  const m = payload.match(/^(accept|decline|info):(job-[\w-]+)$/);
  if (!m) return null;
  return { action: m[1] as ButtonPayload['action'], jobId: m[2] };
}

// ── Profile answer parsing ──────────────────────────────────────

/**
 * Parse a user's response to a profile question into the canonical slug.
 *
 * For text fields (name, city, main_trade_other), returns the raw trimmed text.
 * For button fields, matches numeric choice ("1", "2", ...) to the corresponding
 * option slug. Returns null on invalid choice.
 */
export function parseProfileAnswer(
  field: ProfileField,
  answer: string,
): string | boolean | null {
  const trimmed = answer.trim();
  const def = PROFILE_FIELDS.find((f) => f.field === field);
  if (!def) return null;

  if (def.type === 'text') {
    return trimmed.length > 0 ? trimmed : null;
  }

  // Button field — accept the numeric choice (1-indexed).
  const n = parseInt(trimmed, 10);
  if (!def.options || isNaN(n) || n < 1 || n > def.options.length) return null;
  return def.options[n - 1] as string | boolean;
}

// ── Pending-field state machine ─────────────────────────────────

/**
 * Compute the next profile field to ask.
 *
 * Walks PROFILE_FIELDS in order, skipping:
 *   - conditional fields whose condition isn't met (main_trade_other unless main_trade === 'other')
 *   - fields already filled in state_context.collected OR in the DB (dbFilled)
 *
 * Returns null when all applicable fields are complete.
 */
export function computeNextField(
  collected: Partial<Record<ProfileField, string | boolean>>,
  dbFilled: Partial<Record<ProfileField, string | boolean | null>>,
): ProfileField | null {
  for (const def of PROFILE_FIELDS) {
    // Skip conditional fields whose condition isn't met
    if (def.conditional) {
      if (def.field === 'main_trade_other') {
        const trade = collected.main_trade ?? dbFilled.main_trade;
        if (trade !== 'other') continue;
      }
    }

    // Skip fields already collected this session
    if (collected[def.field] !== undefined) continue;

    // Skip fields already filled in DB (existing-user partial resume)
    const dbVal = dbFilled[def.field];
    if (dbVal !== undefined && dbVal !== null) continue;

    return def.field;
  }
  return null;
}

// ── Replay detection (MessageSid-based) ─────────────────────────
//
// The previous `isStaleReplay(answeredField, collected, pendingField)` export
// was removed 2026-04-17 (Codex fix pass). It relied on field-ordering to
// detect stale SQS replays, but the processor call site passed `pending` as
// BOTH the answeredField and pendingField arguments, so the guard's
// `answeredIdx < pendingIdx` comparison was always false — dead code.
//
// Replay protection now lives in the processor via two mechanisms:
//   1. `last_processed_message_sid` check at routeMessage entry (covers the
//      coarse "same message delivered twice in a row" case).
//   2. `state_context.field_sids` scan (covers the fine-grained "old field's
//      MessageSid re-arrives after state advanced" case that the old guard
//      tried and failed to catch).
//
// See processor.ts:routeMessage for the implementation and the processor
// test suite for the scenarios it covers.
