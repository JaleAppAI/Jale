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
import { parseApplyToken } from '../../lib/referral-codes';

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

/**
 * Sprint 24 C1: the job-alert buttons are labelled "interested / not
 * interested" now, so those are the words a worker types back. The button
 * PAYLOAD grammar (`parseButtonPayload`, `accept|decline|info:job-...`) is
 * deliberately untouched -- the labels changed, the payload ids did not.
 *
 * NEGATIVES ARE LISTED FIRST and tested first, because "no me interesa"
 * CONTAINS "me interesa" (and "not interested" contains "interested"): with
 * the positives first, a worker declining a job would be applied to it. The
 * `$` anchor already forces the regex to prefer the longer alternative, so
 * this ordering is belt AND braces -- the classification below re-checks the
 * decline list before the accept list.
 *
 * The historical verbs stay: the help menu advertised "aceptar/accept" for
 * months, and a relabelled button must not break a worker who learned the
 * old word.
 */
const TYPED_DECLINE_VERBS = [
  'no me interesa',
  'not interested',
  'no',
  'decline',
  'rechazar',
] as const;

const TYPED_ACCEPT_VERBS = [
  // `normalizeCommandText` lowercases but does NOT strip diacritics -- which
  // is why the pre-existing list already carried both 'si' and 'sí' -- so
  // both spellings of the accented phrase are listed too.
  'sí me interesa',
  'si me interesa',
  'me interesa',
  'interesa',
  "i'm interested",
  'im interested',
  'interested',
  'aceptar',
  'accept',
  'si',
  'sí',
  'yes',
] as const;

const TYPED_JOB_ACTION_PATTERN = new RegExp(
  `^(\\d+)\\s+(${[...TYPED_DECLINE_VERBS, ...TYPED_ACCEPT_VERBS, 'info'].join('|')})$`,
);

/**
 * Phone keyboards autocorrect a typed `'` to U+2019 (and iOS sometimes to
 * U+02BC), and `normalizeCommandText` only trims punctuation at the EDGES --
 * an apostrophe inside "i'm interested" survives it. Folding the curly forms
 * to the plain one keeps the verb list a single spelling.
 */
function normalizeTypedVerb(text: string): string {
  return normalizeCommandText(text).replace(/[\u2018\u2019\u02bc]/g, "'");
}

export function parseTypedJobAction(text: string): TypedJobAction | null {
  const m = normalizeTypedVerb(text).match(TYPED_JOB_ACTION_PATTERN);
  if (!m) return null;
  const index = parseInt(m[1], 10) - 1;
  if (index < 0) return null;
  const verb = m[2];
  if ((TYPED_DECLINE_VERBS as readonly string[]).includes(verb)) {
    return { index, action: 'decline' };
  }
  if ((TYPED_ACCEPT_VERBS as readonly string[]).includes(verb)) {
    return { index, action: 'accept' };
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
  // Sprint 23. All three sit well over 1 Damerau-Levenshtein edit from
  // 'cancelar' (the fill/prompt lanes' exact cancel word), so widening the
  // fuzzy vocabulary here cannot make `matchCommandFuzzy` swallow a cancel.
  'applications', 'aplicaciones', 'solicitudes',
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

/**
 * Sprint 23: the `aplicaciones` command. EXACT-match grammar (plus the
 * shared 1-edit fuzzy tolerance), deliberately NOT `isJobsKeyword`'s
 * prefix grammar -- these words are long enough that a worker typing a
 * sentence that merely starts with one is far likelier to be answering a
 * question than issuing a command, and the fill/prompt lanes route through
 * this predicate before any answer parsing.
 */
export function isApplicationsCommand(text: string): boolean {
  const n = normalizeCommandText(text);
  if (/^(applications?|aplicacion(es)?|solicitud(es)?)$/.test(n)) return true;
  const fuzzy = matchCommandFuzzy(n);
  return fuzzy === 'applications' || fuzzy === 'aplicaciones' || fuzzy === 'solicitudes';
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
  'close', 'accept', 'yes', 'decline', 'applications', 'application',
]);
const ES_LANG_WORDS = new Set([
  'ayuda', 'comandos', 'comando', 'trabajos', 'trabajo', 'empleos', 'empleo',
  'perfil', 'saltar', 'mensajes', 'cerrar', 'aceptar', 'acepto', 'rechazar',
  'aplicaciones', 'aplicacion', 'solicitudes', 'solicitud',
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

export interface ApplicationButtonPayload {
  action: 'start' | 'later';
  /** The `app-<uuid>` form the template's {{3}} variable carries. */
  applicationId: string;
}

/**
 * Sprint 23: the two quick-reply buttons on the `application_update_*`
 * template -- `application:start:app-<uuid>` / `application:later:app-<uuid>`.
 * The `app-` prefix mirrors the job alert's `job-<uuid>` convention and is
 * minted by `buildApplicationStageMessage` (lib/application-stage-notify.ts);
 * the bare UUID is returned here so callers never re-strip it.
 */
export function parseApplicationButtonPayload(
  payload: string | undefined,
): ApplicationButtonPayload | null {
  const m = payload?.match(
    /^application:(start|later):app-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  );
  if (!m) return null;
  return { action: m[1] as ApplicationButtonPayload['action'], applicationId: m[2] };
}

/**
 * Sprint 24 C4: the SAME `app-<uuid>` reference, TYPED rather than tapped.
 *
 * `application-stage-notify.ts` prints "Referencia: app-<uuid>" in the hired
 * notification, and workers reply with it -- which matched nothing before
 * this (only the button-payload grammar above knew the shape), so they got
 * the unknown-message reply while an employer waited.
 *
 * Grammar notes, all load-bearing:
 *   - The reference may sit anywhere in ordinary prose, so the id is
 *     bounded rather than anchored: no alphanumeric immediately before
 *     `app-` (so "myapp-<uuid>" is not a reference) and no hex/hyphen
 *     immediately after (so a truncated or extended id is not one either).
 *   - `:`, `_` and `-` are excluded from the leading boundary as well, which
 *     is what keeps `application:start:app-<uuid>` OUT of this parser. That
 *     payload is owned by `parseApplicationButtonPayload` and routed before
 *     this one -- and its `later` variant must NOT dispatch like `start`, so
 *     the two grammars must not overlap even by accident.
 *   - Case-insensitive (WhatsApp capitalizes the first letter of a message),
 *     normalized to the lowercase form ids are stored in.
 *
 * Pure and total: never throws, never logs. Inbound bodies are untrusted.
 */
const APPLICATION_REFERENCE_PATTERN =
  /(?:^|[^0-9a-z:_-])app-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-z-])/i;

export function parseApplicationReference(body: string | null | undefined): string | null {
  if (!body) return null;
  const m = body.match(APPLICATION_REFERENCE_PATTERN);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Sprint 24 C4 (review 1): the apply-token parser for the AUTHENTICATED
 * router. Strict where `parseApplyToken` (lambda/lib/referral-codes.ts) is
 * deliberately loose.
 *
 * That looseness is correct pre-auth: `JALE` + any separator (or none) + any
 * eight Crockford-mappable characters, no trailing boundary, so a person
 * retyping a code from memory is still matched, and a false positive on a
 * first message merely parks nothing.
 *
 * Post-auth the same looseness is a bug: an onboarded worker may be mid
 * conversation with an employer, and "Jale trabajos" parses as the token
 * TRABAJ0S (Crockford maps O to 0). Answering that with "job code not found"
 * would swallow a message the employer was waiting for. So here a
 * PUNCTUATION separator is required -- `-`, `_` or `:`, optionally spaced --
 * which is exactly what every real arrival carries:
 *   - the prefilled wa.me text (`public-job-apply-intent.ts`) is
 *     "Quiero postularme a este trabajo: JALE-XXXXXXXX" / "I want to apply
 *     for this job: JALE-XXXXXXXX", so LEADING PROSE MUST STILL PARSE -- a
 *     whole-message-only grammar would miss every real referral;
 *   - anything a worker copies is `formatApplyToken`'s own `JALE-` form.
 * The cost is that a hand-typed "JALE ABCD1234" (space, no punctuation) is
 * not recognised once onboarded; pre-auth still catches it.
 *
 * Boundaries on both ends: no alphanumeric immediately before `JALE` (so
 * "MIJALE-..." is not a code) and none immediately after the eight
 * characters (so "JALE-ABCD1234EXTRA" is not one either).
 *
 * DECODING IS NOT REIMPLEMENTED HERE. The captured characters are handed
 * back to the lib with a canonical prefix, so Crockford's rules (I/L to 1,
 * O to 0, U rejected as a genuine typo) and the length/alphabet validation
 * stay in one place and cannot drift from the pre-auth path. The lib's own
 * `normalizeCode` is NOT used for this: it strips a leading `JALE` again,
 * which would silently disagree with `parseApplyToken` on the (nonsense but
 * reachable) body "JALE-JALEXXXX".
 *
 * Pure and total: never throws, never logs. Inbound bodies are untrusted.
 */
const TYPED_APPLY_TOKEN_PATTERN = /(?:^|[^0-9a-z])jale[ \t]*[-_:][ \t]*([0-9a-z]{8})(?![0-9a-z])/i;

export function parseTypedApplyToken(body: string | null | undefined): string | null {
  if (!body) return null;
  const m = body.match(TYPED_APPLY_TOKEN_PATTERN);
  if (!m) return null;
  return parseApplyToken(`JALE-${m[1]}`);
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

export type CommandPayload = 'jobs' | 'profile' | 'chats' | 'help' | 'applications';

export function parseCommandPayload(payload: string | undefined): CommandPayload | null {
  const m = payload?.match(/^command:(jobs|profile|chats|help|applications)$/);
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
