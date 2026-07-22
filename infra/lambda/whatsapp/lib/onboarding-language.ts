// infra/lambda/whatsapp/lib/onboarding-language.ts
//
// Pure language selection, onboarding command classification, and cooldown
// arithmetic for the WhatsApp v2 workflow. No DB, no network, no clock: every
// time-dependent function takes `now`. Histories are ISO-8601 string arrays.
//
// Owns NO shared type. `Lang` comes from ./templates; command normalization
// comes from ./flows. Nothing here is a canonical C2/C4 symbol.

import { type Lang } from './templates';
import { normalizeCommandText, matchCommandFuzzy, detectCommandLanguage } from './flows';

/** Start template cooldown: 1 per normalized phone per 10 minutes. */
export const START_COOLDOWN_MS = 10 * 60 * 1000;
/** Start templates per phone per 24h. */
export const START_DAILY_CAP = 5;
export const START_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Invalid-answer reprompt cooldown: 30 seconds. */
export const REPROMPT_COOLDOWN_MS = 30 * 1000;

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

function matches(body: string, words: ReadonlySet<string>): boolean {
  const n = normalizeCommandText(body);
  if (words.has(n)) return true;
  const fuzzy = matchCommandFuzzy(n);
  return fuzzy !== null && words.has(fuzzy);
}

const LANGUAGE_WORDS = new Set(['language', 'idioma']);
const RESEND_WORDS = new Set(['resend', 'reenviar']);
// normalizeCommandText lowercases but does not strip accents.
const REVIEW_TERMS_WORDS = new Set([
  'review terms', 'revisar terminos', 'revisar términos',
]);
const HELP_WORDS = new Set(['help', 'ayuda']);

export function isLanguageCommand(body: string): boolean {
  return matches(body, LANGUAGE_WORDS);
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

function parseHistory(history: readonly string[], now: Date): number[] {
  const nowMs = now.getTime();
  return history
    .map((iso) => Date.parse(iso))
    .filter((ms) => Number.isFinite(ms) && nowMs - ms < START_DAILY_WINDOW_MS)
    .sort((a, b) => b - a);
}

/** Cooldown is checked before the daily cap: the nearer limit wins. */
export function evaluateStartCooldown(
  history: readonly string[],
  now: Date,
): StartCooldownResult {
  const recent = parseHistory(history, now);
  if (recent.length === 0) return { allowed: true, reason: 'ok' };
  if (now.getTime() - recent[0] < START_COOLDOWN_MS) {
    return { allowed: false, reason: 'cooldown' };
  }
  if (recent.length >= START_DAILY_CAP) return { allowed: false, reason: 'daily_cap' };
  return { allowed: true, reason: 'ok' };
}

/** True when the current prompt may be repeated (30-second reprompt cooldown). */
export function shouldRepeatPrompt(lastIso: string | null | undefined, now: Date): boolean {
  if (!lastIso) return true;
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= REPROMPT_COOLDOWN_MS;
}

/** Append this send and drop anything outside the 24-hour window. */
export function appendSendTimestamp(history: readonly string[], now: Date): string[] {
  const kept = parseHistory(history, now).map((ms) => new Date(ms).toISOString());
  return [...kept, now.toISOString()];
}
