/**
 * Error messages for problem reports, with anything that looks like a value
 * replaced: addresses and their queries, emails, record ids, tokens and other
 * credentials, phone numbers and long numbers. What is left says what went
 * wrong without saying about whom.
 */

export const MAX_MESSAGE_LENGTH = 200;

/**
 * Only this much of a message is scrubbed, which bounds the work on a huge
 * one. It leaves room for placeholders that are shorter than what they replace.
 */
const SCRUB_WINDOW = 1000;

const URLS = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+|\b(?:data|blob):[^\s<>"'`]+/gi;
/** The query or fragment of an address without a scheme; the path before it stays. */
const RELATIVE_QUERIES = /(\/[^\s?#<>"'`]*)([?#])[^\s<>"'`]+/g;
/** Every dot-separated part of a sign-in token: three, or five when it is encrypted (one may be empty). */
const SIGN_IN_TOKENS = /\beyJ[\w-]+(?:\.[\w-]*)*\.[\w-]+/g;
/**
 * `name=value` or `name: value` where the name says credential, a prefix such
 * as `access_` or `X-Api-` included. The value goes, with the scheme before
 * it if there is one; the name stays. A quoted value ends at its closing
 * quote, past any escaped one (`\"`, as in JSON); a quoted value that never
 * closes goes to the end of the line.
 */
const NAMED_CREDENTIALS =
  /\b((?:[A-Za-z0-9]+[_-])*(?:passw(?:or)?d|pwd|secret|token|(?:api)?key|auth\w*|session\w*|sig(?:nature)?|code|otp|pin|credentials?|cookie|jwt))["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|["'][^\n]*|[^\s&;,]+)/gi;
/** The credential after an authorization scheme. */
const SCHEME_CREDENTIALS = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// Anchored on the character before the address, so a long run of letters is
// scanned once rather than once per position.
const EMAILS = /(^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const RECORD_IDS = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_TOKENS = /\b[0-9a-f]{32,}\b/gi;
/** Hex of 16 characters or more, even glued to a word; a token when it holds a letter and a digit. */
const HEX_RUNS = /[0-9a-f]{16,}/gi;
/**
 * A run of 20 or more token characters (base64 and base64url) holding a
 * letter and a digit: an opaque token, whatever it starts with. A run that
 * starts with a slash is a path, and is left alone.
 */
const TOKEN_RUNS = /(?<![A-Za-z0-9_+/=-])(?!\/)[A-Za-z0-9_+/=-]{20,}/g;
/** Digits with optional +, spaces, dots, dashes or brackets; a phone if 7+ digits. */
const PHONE_SHAPES = /(^|[^A-Za-z0-9_+])(\+?\(?\d[\d\s().-]*\d)/g;
const LONG_NUMBERS = /\d{7,}/g;
/** Whatever a cut may have split: a trailing run of digits and separators, then a word. */
const CUT_FRAGMENT = /[\d\s().+-]*\S*$/;

function digitCount(value: string): number {
  let count = 0;
  for (const char of value) if (char >= '0' && char <= '9') count++;
  return count;
}

function lettersAndDigits(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

/**
 * Replaces value-shaped content with placeholders. Named credentials go
 * first, while every escaped quote still has its backslash: an address or a
 * query placeholder could swallow that backslash and end a quoted value early,
 * leaving the rest of it behind. Whole credentials also go before the phone
 * and number rules run, so those never split one.
 */
export function scrubText(text: string): string {
  return text
    .replace(NAMED_CREDENTIALS, (_match, name: string) => `${name}=[redacted]`)
    .replace(URLS, '[url]')
    .replace(RELATIVE_QUERIES, (_match, path: string, mark: string) => `${path}${mark}[query]`)
    .replace(SIGN_IN_TOKENS, '[token]')
    .replace(SCHEME_CREDENTIALS, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(EMAILS, (_match, lead: string) => `${lead}[email]`)
    .replace(RECORD_IDS, '[id]')
    .replace(HEX_TOKENS, '[token]')
    .replace(HEX_RUNS, (run) => (lettersAndDigits(run) ? '[token]' : run))
    .replace(TOKEN_RUNS, (run) => (lettersAndDigits(run) ? '[token]' : run))
    .replace(PHONE_SHAPES, (match, lead: string, run: string) => (digitCount(run) >= 7 ? `${lead}[phone]` : match))
    .replace(LONG_NUMBERS, '[number]');
}

/** Cuts to `max` UTF-16 units, marking the cut, without splitting a surrogate pair. */
export function shorten(text: string, max: number = MAX_MESSAGE_LENGTH): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * A message as a report may carry it: one line, scrubbed, then shortened.
 * Scrubbing comes first, so a cut can never leave half an address behind.
 * Anything that is not a string becomes an empty message.
 */
export function scrubMessage(message: unknown, max: number = MAX_MESSAGE_LENGTH): string {
  if (typeof message !== 'string') return '';
  let text = message.replace(/\s+/g, ' ').trim();
  if (text.length > SCRUB_WINDOW) {
    // The value the window cuts through goes too: a fragment of it could be
    // too short to recognise.
    text = text.slice(0, SCRUB_WINDOW).replace(CUT_FRAGMENT, '');
  }
  return shorten(scrubText(text), max);
}
