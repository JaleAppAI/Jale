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
import {
  TRADE_KEYS,
  EXPERIENCE_KEYS,
  AVAILABILITY_KEYS,
  TRANSPORT_KEYS,
  transportKeyToBoolean,
  type TradeKey,
  type ExperienceKey,
  type AvailabilityKey,
} from '../../lib/worker-vocab';

// ── Conversation state types ────────────────────────────────────

export type ConversationState =
  | 'new'
  | 'awaiting_otp'
  | 'awaiting_legal'
  | 'awaiting_media_photo'
  | 'awaiting_media_voice'
  | 'processing_ai'
  | 'building_profile'
  | 'legal_declined'
  | 'otp_timeout'
  | 'idle';

// The three profile vocabularies below are owned by `lambda/lib/worker-vocab`
// (which also carries their bilingual labels and the frontend parity guard).
// These aliases keep flows.ts's historical export names for its consumers.

/** Canonical slugs matching users.main_trade CHECK constraint */
export type TradeSlug = TradeKey;

/** Canonical slugs matching users.years_experience CHECK constraint */
export type ExperienceSlug = ExperienceKey;

/** Canonical slugs matching users.availability CHECK constraint */
export type AvailabilitySlug = AvailabilityKey;

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
    options: TRADE_KEYS,
  },
  // Conditional: only activated when main_trade === 'other'
  { field: 'main_trade_other', type: 'text', conditional: true },
  {
    field: 'years_experience',
    type: 'buttons',
    options: EXPERIENCE_KEYS,
  },
  {
    // `has_transportation` is a boolean column, so the option list is the
    // vocabulary's yes/no keys mapped through the storage conversion —
    // [true, false], in that order.
    field: 'has_transportation',
    type: 'buttons',
    options: TRANSPORT_KEYS.map(transportKeyToBoolean),
  },
  {
    field: 'availability',
    type: 'buttons',
    options: AVAILABILITY_KEYS,
  },
] as const;

/**
 * Shape of the `whatsapp_conversations.state_context` JSONB column.
 *
 * Key fields:
 *   - `cognito_session` persists the Cognito custom-auth Session between webhook
 *     deliveries so `RespondToAuthChallenge` reuses the same session — a fresh
 *     `InitiateAuth` would rotate the OTP and invalidate the code sent to the worker.
 *   - `otp_issued_at` is informational — used for log correlation.
 *   - `field_sids` binds each accepted profile answer to the Twilio MessageSid that
 *     produced it, enabling fine-grained SQS replay detection per field.
 */
export interface ProfileStateContext {
  pending_field?: ProfileField;
  collected?: Partial<Record<ProfileField, string | boolean>>;
  /** Cognito custom-auth Session string. Cleared on OTP success. */
  cognito_session?: string;
  /** ISO timestamp of the most recent `InitiateAuth` that sent an SMS. */
  otp_issued_at?: string;
  /** Map of accepted profile field → MessageSid that wrote it. */
  field_sids?: Partial<Record<ProfileField, string>>;
  custom_trust_step?: number;
  custom_trust_answers?: unknown[];
  custom_trust_profession?: string;
  custom_trust_questions?: unknown[];
  custom_trust_assessment_id?: string;
  processing_ai_type?: 'profile' | 'trust';
  recent_jobs?: string[];
  /** Job conversation the worker most recently opened from an employer WhatsApp invite. */
  active_job_conversation_id?: string;
  /** ARN of the running Step Functions execution for the AI pipeline. */
  ai_pipeline_execution_arn?: string;
  /** DB id of the worker_profile_media row for the pending photo (UUID). */
  pending_media_photo_id?: string;
  /** True when optional photo upload is happening after profile completion. */
  profile_completed?: boolean;
  pending_picker?:
    | { kind: 'disambiguation' | 'chats'; threads: { conversationId: string; jobTitle: string; companyName: string; threadNumber: number | null }[] }
    | { kind: 'close_reason'; conversationId: string };
}

// -- Trust Signal Layer ----------------------------------------------------
//
// Sprint 22 R1-A: the numbered trust menu (TRUST_QUESTIONS / SENIORITY_OPTIONS
// / TRUST_STEPS / getTrustOptions / buildTrustQuestion / TRUST_OPTION_LABELS_ES)
// lived here and served the five standard trades. It is gone: a menu label
// gives the AI trust scorer nothing to grade, so every trade now gets three
// OPEN questions from the per-trade `trade_questions` cache, seeded by
// `onboarding/trust-seed.ts`. The reviewed open-text fallback set lives in
// `lib/interactive-templates.ts` (V2_FALLBACK_TRUST_QUESTIONS).
//
// The `custom_trust_*` keys still on ProfileStateContext above are inert
// leftovers on historical rows; nothing reads or writes them any more.

export interface TypedJobAction {
  index: number;
  action: 'accept' | 'decline' | 'info';
}

export function parseTypedJobAction(text: string): TypedJobAction | null {
  const m = normalizeCommandText(text).match(
    /^(\d+)\s+(aceptar|accept|si|sí|yes|no|decline|rechazar|info)$/,
  );
  if (!m) return null;
  const index = parseInt(m[1], 10) - 1;
  if (index < 0) return null;
  const verb = m[2];
  if (['aceptar', 'accept', 'si', 'sí', 'yes'].includes(verb)) {
    return { index, action: 'accept' };
  }
  if (['no', 'decline', 'rechazar'].includes(verb)) {
    return { index, action: 'decline' };
  }
  return { index, action: 'info' };
}

// ── Keyword detection ───────────────────────────────────────────

export function normalizeCommandText(text: string): string {
  return text
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const COMMAND_KEYWORDS = [
  'help', 'ayuda', 'commands', 'comandos', 'jobs', 'trabajos', 'empleos',
  'profile', 'perfil', 'skip', 'saltar', 'chats', 'mensajes', 'cerrar', 'close',
];

function damerauLevenshteinDistance(a: string, b: string): number {
  const d: number[][] = Array.from(
    { length: a.length + 1 },
    () => new Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

export function matchCommandFuzzy(normalized: string): string | null {
  if (!normalized || /\s/.test(normalized) || normalized.length < 4) return null;
  for (const keyword of COMMAND_KEYWORDS) {
    if (keyword[0] !== normalized[0]) continue;
    if (damerauLevenshteinDistance(normalized, keyword) <= 1) return keyword;
  }
  return null;
}

const GREETING_WORDS = ['hola', 'hello', 'hi', 'hey', 'buenas'];
const GREETING_PHRASES = ['buenos dias', 'buenas tardes', 'buenas noches'];

export function isGreetingKeyword(text: string): boolean {
  const n = text.trim().toLowerCase();
  const words = n.match(/[a-záéíóúñ]+/gi);
  if (!words || words.length === 0) return false;
  if (words.length >= 2) {
    const phrase = `${words[0]} ${words[1]}`
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (GREETING_PHRASES.includes(phrase)) return true;
  }
  return GREETING_WORDS.includes(words[0]);
}

/**
 * Exact-match sibling of `isGreetingKeyword`, for the WhatsApp v2 onboarding
 * gate's free-text answer steps (the worker's name, custom trade, trust
 * answers — see `onboarding/gate.ts`'s FREE_TEXT_STEPS). `isGreetingKeyword`
 * treats ANY message that STARTS WITH a greeting word as a greeting — by
 * design, for the v1 idle-router's classification use case ("hola quiero
 * trabajo" should route as a greeting) — which would eat a legitimate answer
 * like "Hola Maria" as a name. This variant requires the ENTIRE trimmed,
 * lowercased message to BE the greeting word/phrase and nothing else, so
 * "Hola" is blocked but "Hola Maria" is accepted as a genuine answer.
 */
export function isExactGreetingKeyword(text: string): boolean {
  const n = text.trim().toLowerCase();
  const words = n.match(/[a-záéíóúñ]+/gi);
  if (!words || words.length === 0 || words.length > 2) return false;
  if (words.length === 1) {
    return GREETING_WORDS.includes(words[0]);
  }
  const phrase = `${words[0]} ${words[1]}`
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  return GREETING_PHRASES.includes(phrase);
}

export function isJobsKeyword(text: string): boolean {
  const n = normalizeCommandText(text);
  if (/^(trabajos?|jobs?|empleos?)\b/.test(n)) return true;
  const fuzzy = matchCommandFuzzy(n);
  return fuzzy === 'jobs' || fuzzy === 'trabajos' || fuzzy === 'empleos';
}

export function isHelpCommand(text: string): boolean {
  const n = normalizeCommandText(text);
  if (/^(help|ayuda|commands?|comandos?)$/.test(n)) return true;
  const fuzzy = matchCommandFuzzy(n);
  return fuzzy === 'help' || fuzzy === 'ayuda' || fuzzy === 'commands' || fuzzy === 'comandos';
}

export function isSupportCommand(text: string): boolean {
  const n = text.trim().toLowerCase();
  return /^(support|soporte)$/.test(n);
}

export function isProfileCommand(text: string): boolean {
  const n = normalizeCommandText(text);
  if (/^(profile|perfil|my profile|mi perfil)$/.test(n)) return true;
  const fuzzy = matchCommandFuzzy(n);
  return fuzzy === 'profile' || fuzzy === 'perfil';
}

export function isSkipKeyword(text: string): boolean {
  const n = normalizeCommandText(text);
  if (/^(skip|saltar)$/.test(n)) return true;
  const fuzzy = matchCommandFuzzy(n);
  return fuzzy === 'skip' || fuzzy === 'saltar';
}

// JS `\b` is ASCII-only, so it fails on Spanish accented chars (sí, está).
// Use a lookahead asserting either whitespace or end-of-string after the match.
const ES_ACCEPT = /^(acepto|sí|si)(?=\s|$)/;
const EN_ACCEPT = /^(accept|yes|i accept)(?=\s|$)/;
const ES_DECLINE = /^(no acepto|no)(?=\s|$)/;
const EN_DECLINE = /^(decline|no)(?=\s|$)/;

export function isAccept(text: string, lang: Lang): boolean {
  const n = normalizeCommandText(text);
  return (lang === 'es' ? ES_ACCEPT : EN_ACCEPT).test(n);
}

// Language-specific vocabularies used to answer a typed command in the same
// language the worker wrote it in. Canonical command keywords mirror
// COMMAND_KEYWORDS, split by language, plus common singular/verb forms.
const EN_LANG_WORDS = new Set([
  // 'chats'/'info' are shared with the Spanish menu (templates.ts) — not a language signal.
  'help', 'commands', 'command', 'jobs', 'job', 'profile', 'skip',
  'close', 'accept', 'yes', 'decline',
]);
const ES_LANG_WORDS = new Set([
  'ayuda', 'comandos', 'comando', 'trabajos', 'trabajo', 'empleos', 'empleo',
  'perfil', 'saltar', 'mensajes', 'cerrar', 'aceptar', 'acepto', 'rechazar',
  'si', 'sí',
]);

/**
 * Detect the language a typed command/message is written in, so the reply can
 * match it. Returns null when there is no clear signal (e.g. bare "no", which
 * is valid in both languages, or free text) — callers keep the stored
 * conversation language in that case. Not for button/interactive payloads,
 * which are language-agnostic.
 */
export function detectCommandLanguage(text: string): Lang | null {
  const n = normalizeCommandText(text);
  if (!n) return null;

  const words = n.split(' ');
  // Typed job actions look like "1 aceptar" / "2 accept" — key off the verb.
  const token = /^\d+$/.test(words[0]) && words[1] ? words[1] : words[0];

  if (EN_LANG_WORDS.has(token)) return 'en';
  if (ES_LANG_WORDS.has(token)) return 'es';

  if (/^(hello|hi|hey)$/.test(token)) return 'en';
  if (/^(hola|buenas|buenos)$/.test(token)) return 'es';

  const fuzzy = matchCommandFuzzy(n);
  if (fuzzy && EN_LANG_WORDS.has(fuzzy)) return 'en';
  if (fuzzy && ES_LANG_WORDS.has(fuzzy)) return 'es';

  return null;
}

export function isDecline(text: string, lang: Lang): boolean {
  const n = normalizeCommandText(text);
  return (lang === 'es' ? ES_DECLINE : EN_DECLINE).test(n);
}

// ── Button payload parsing (for future template replies) ────────

export interface ButtonPayload {
  action: 'accept' | 'decline' | 'info';
  jobId: string;
}

export interface EmployerConversationButtonPayload {
  action: 'open' | 'decline' | 'focus';
  conversationId: string;
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

export function parseEmployerConversationButtonPayload(
  payload: string,
): EmployerConversationButtonPayload | null {
  const m = payload.match(/^conversation:(open|decline|focus):([0-9a-fA-F-]{36})$/);
  if (!m) return null;
  return {
    action: m[1] as EmployerConversationButtonPayload['action'],
    conversationId: m[2],
  };
}

export type CommandPayload = 'jobs' | 'profile' | 'chats' | 'help';

export function parseCommandPayload(payload: string | undefined): CommandPayload | null {
  const m = payload?.match(/^command:(jobs|profile|chats|help)$/);
  return m ? (m[1] as CommandPayload) : null;
}

export function parseLegalReplyPayload(
  payload: string | undefined,
): 'accept' | 'decline' | null {
  if (payload === 'legal:accept') return 'accept';
  if (payload === 'legal:decline') return 'decline';
  return null;
}

export function parseProfilePayloadAnswer(
  field: ProfileField,
  payload: string | undefined,
): string | boolean | null {
  if (!payload) return null;
  const m = payload.match(/^profile:([a-z_]+):(.+)$/);
  if (!m || m[1] !== field) return null;

  const def = PROFILE_FIELDS.find((f) => f.field === field);
  if (!def || def.type !== 'buttons' || !def.options) return null;

  const rawValue = m[2];
  const value = rawValue === 'true'
    ? true
    : rawValue === 'false'
      ? false
      : rawValue;

  return def.options.includes(value) ? value : null;
}

// ── Profile answer parsing ──────────────────────────────────────

/**
 * Parse a user's response to a profile question into the canonical slug.
 *
 * For text fields (name, city, main_trade_other), returns the raw trimmed text.
 * For button fields, matches numeric choice ("1", "2", ...) to the corresponding
 * option slug. Returns null on invalid choice.
 */
export type MediaPayload =
  | { kind: 'photo'; value: 'skip' }
  | { kind: 'photo_type'; value: 'profile_photo' | 'work_sample' }
  | { kind: 'voice'; value: 'text' };

export function parseMediaPayload(payload: string | undefined): MediaPayload | null {
  if (payload === 'media:photo:skip') {
    return { kind: 'photo', value: 'skip' };
  }
  if (payload === 'media:photo_type:profile_photo') {
    return { kind: 'photo_type', value: 'profile_photo' };
  }
  if (payload === 'media:photo_type:work_sample') {
    return { kind: 'photo_type', value: 'work_sample' };
  }
  if (payload === 'media:voice:text') {
    return { kind: 'voice', value: 'text' };
  }
  return null;
}

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
