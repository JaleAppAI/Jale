// infra/lambda/whatsapp/lib/onboarding-language.ts
//
// Pure language selection, onboarding command classification, and cooldown
// arithmetic for the WhatsApp v2 workflow. No DB, no network, no clock: every
// time-dependent function takes `now`. Histories are ISO-8601 string arrays.
//
// Owns NO shared type. `Lang` comes from ./templates; command normalization
// comes from ./flows. Nothing here is a canonical C2/C4 symbol.

import { type Lang } from './templates';
import { normalizeCommandText, detectCommandLanguage } from './flows';

/** Start template cooldown: 1 per normalized phone per 10 minutes. */
export const START_COOLDOWN_MS = 10 * 60 * 1000;
/** Start templates per phone per 24h. */
export const START_DAILY_CAP = 5;
export const START_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Invalid-answer reprompt cooldown: 30 seconds. */
export const REPROMPT_COOLDOWN_MS = 30 * 1000;
/** OTP resend cooldown: 60 seconds (canonical value table — distinct from
 * the 10-minute start-invitation cooldown; the two histories are tracked
 * under separate context keys, `startSendHistory` vs `otpSendHistory`). */
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
/** OTP sends per phone per hour. */
export const OTP_RESEND_HOURLY_CAP = 3;
export const OTP_RESEND_WINDOW_MS = 60 * 60 * 1000;

export interface StartCooldownResult {
  allowed: boolean;
  reason: 'ok' | 'cooldown' | 'daily_cap';
}

/**
 * Language choice from the start invitation: the two button payloads, or the
 * typed START / EMPEZAR fallbacks.
 */
export function parseLanguageChoice(body: string, payload?: string): Lang | null {
  if (payload === 'start:lang:en') return 'en';
  if (payload === 'start:lang:es') return 'es';
  const n = normalizeCommandText(body);
  if (n === 'start') return 'en';
  if (n === 'empezar') return 'es';
  return null;
}

/** Language of a recognized command, or null when the text is not a command. */
export function detectCommandLang(body: string): Lang | null {
  return detectCommandLanguage(body);
}

/**
 * A command typed in the non-preferred language is answered in the command
 * language; interactive taps and ordinary step answers stay preferred.
 */
export function resolveResponseLanguage(
  preferred: Lang,
  body: string,
  isInteractive: boolean,
): Lang {
  if (isInteractive) return preferred;
  return detectCommandLang(body) ?? preferred;
}

// Local Damerau-Levenshtein distance, scored against a caller-supplied word
// set rather than flows.ts's fixed COMMAND_KEYWORDS list — so families not in
// that list (LANGUAGE, RESEND) still get 1-edit typo tolerance. Deliberately
// duplicated from flows.ts's private implementation rather than importing it:
// flows.ts belongs to another lane and does not export a way to fuzzy-match
// against an arbitrary word set.
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

// Same guards as flows.ts's matchCommandFuzzy: no whitespace, minimum length
// 4, only compare candidates sharing the first character, threshold <= 1.
function matchFuzzyAgainst(normalized: string, words: ReadonlySet<string>): boolean {
  if (!normalized || /\s/.test(normalized) || normalized.length < 4) return false;
  for (const word of words) {
    if (word[0] !== normalized[0]) continue;
    if (damerauLevenshteinDistance(normalized, word) <= 1) return true;
  }
  return false;
}

function matches(body: string, words: ReadonlySet<string>): boolean {
  const n = normalizeCommandText(body);
  if (words.has(n)) return true;
  return matchFuzzyAgainst(n, words);
}

const LANGUAGE_WORD_EN = new Set(['language']);
const LANGUAGE_WORD_ES = new Set(['idioma']);
const LANGUAGE_WORDS = new Set([...LANGUAGE_WORD_EN, ...LANGUAGE_WORD_ES]);
const RESEND_WORDS = new Set(['resend', 'reenviar']);
// normalizeCommandText lowercases but does not strip accents.
const REVIEW_TERMS_WORDS = new Set([
  'review terms', 'revisar terminos', 'revisar términos',
]);
const HELP_WORDS = new Set(['help', 'ayuda']);

export function isLanguageCommand(body: string): boolean {
  return matches(body, LANGUAGE_WORDS);
}

/**
 * Unlike JOBS/TRABAJOS or HELP/AYUDA (whose reply merely matches the
 * command's language), IDIOMA/LANGUAGE is dual-purpose: the specific word
 * chosen names the target language, exactly like the START/EMPEZAR choice
 * at `start.choose_language`. Returns null when `isLanguageCommand` is
 * false — callers should always guard with that first.
 */
export function detectLanguageSelectionCommand(body: string): Lang | null {
  if (matches(body, LANGUAGE_WORD_EN)) return 'en';
  if (matches(body, LANGUAGE_WORD_ES)) return 'es';
  return null;
}

export function isResendCommand(body: string): boolean {
  return matches(body, RESEND_WORDS);
}

export function isReviewTermsCommand(body: string): boolean {
  // Multi-word: matchCommandFuzzy rejects anything containing whitespace, so
  // exact normalized comparison only.
  return REVIEW_TERMS_WORDS.has(normalizeCommandText(body));
}

export function isOnboardingHelpCommand(body: string): boolean {
  return matches(body, HELP_WORDS);
}

const BLOCKED_COMMANDS: ReadonlyArray<[ReadonlySet<string>, 'jobs' | 'chats' | 'profile']> = [
  [new Set(['jobs', 'trabajos', 'empleos']), 'jobs'],
  [new Set(['chats', 'mensajes']), 'chats'],
  [new Set(['profile', 'perfil']), 'profile'],
];

/**
 * Commands the onboarding gate refuses to execute. Returns the command family
 * so the caller can log `{ metric: 'OnboardingGateBlocked', command, stepKey }`.
 */
export function classifyBlockedCommand(body: string): 'jobs' | 'chats' | 'profile' | null {
  for (const [words, family] of BLOCKED_COMMANDS) {
    if (matches(body, words)) return family;
  }
  return null;
}

// `history` crosses a boundary owned by another lane's repository layer, so
// it is treated as untrusted: non-finite, future-dated (clock skew or bad
// data), and entries outside the caller's window are all dropped before use.
function parseHistory(history: readonly string[], now: Date, windowMs: number): number[] {
  const nowMs = now.getTime();
  return history
    .map((iso) => Date.parse(iso))
    .filter((ms) => Number.isFinite(ms) && ms <= nowMs && nowMs - ms < windowMs)
    .sort((a, b) => b - a);
}

/** Cooldown is checked before the cap: the nearer limit wins. Shared shape
 * for both the start-invitation policy (10 min / 5 per 24h) and the OTP
 * resend policy (60 sec / 3 per hour) — same arithmetic, different windows. */
function evaluateCooldown(
  history: readonly string[],
  now: Date,
  cooldownMs: number,
  cap: number,
  windowMs: number,
): StartCooldownResult {
  const recent = parseHistory(history, now, windowMs);
  if (recent.length === 0) return { allowed: true, reason: 'ok' };
  if (now.getTime() - recent[0] < cooldownMs) {
    return { allowed: false, reason: 'cooldown' };
  }
  if (recent.length >= cap) return { allowed: false, reason: 'daily_cap' };
  return { allowed: true, reason: 'ok' };
}

/** Start-invitation policy: 1 per 10 minutes, at most 5 per 24 hours. */
export function evaluateStartCooldown(
  history: readonly string[],
  now: Date,
): StartCooldownResult {
  return evaluateCooldown(history, now, START_COOLDOWN_MS, START_DAILY_CAP, START_DAILY_WINDOW_MS);
}

/** OTP resend policy: 1 per 60 seconds, at most 3 per hour. Distinct from
 * `evaluateStartCooldown` — the OTP resend cadence is tighter (canonical
 * values table) than the start-invitation cadence. */
export function evaluateOtpResendCooldown(
  history: readonly string[],
  now: Date,
): StartCooldownResult {
  return evaluateCooldown(history, now, OTP_RESEND_COOLDOWN_MS, OTP_RESEND_HOURLY_CAP, OTP_RESEND_WINDOW_MS);
}

/** True when the current prompt may be repeated (30-second reprompt cooldown). */
export function shouldRepeatPrompt(lastIso: string | null | undefined, now: Date): boolean {
  if (!lastIso) return true;
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= REPROMPT_COOLDOWN_MS;
}

/**
 * Append this send and drop anything outside the 24-hour window. Returned in
 * ascending chronological order (oldest -> newest -> now): this array is
 * persisted and read back by the repository layer, so callers should be able
 * to assume chronological order rather than re-deriving it.
 */
export function appendSendTimestamp(history: readonly string[], now: Date): string[] {
  // Pruned against the wider of the two windows this history might be
  // evaluated under (start-invitation 24h vs OTP-resend 1h); each
  // `evaluate*Cooldown` call re-filters to its own narrower window before
  // checking the cap, so over-retaining here is harmless.
  const kept = parseHistory(history, now, START_DAILY_WINDOW_MS)
    .sort((a, b) => a - b)
    .map((ms) => new Date(ms).toISOString());
  return [...kept, now.toISOString()];
}
