import { createHash, randomBytes } from 'crypto';

/**
 * Referral code primitives, shared by the public web lane and the WhatsApp lane.
 *
 * Design: docs/2026-07-29-job-referrals-design-brief.pdf
 *
 * Codes carry NO data. A code is an opaque key to a row that already holds the
 * referrer, the job and the channel. Self-describing codes would be long,
 * enumerable, and would leak worker identity.
 *
 * Three distinct kinds of code exist and must not be conflated:
 *   - job code    (6 chars) one per job, stable, in the public URL path
 *   - share code  (8 chars) one per (job, referrer, channel)
 *   - apply token (8 chars) per visitor click, expiring, single-use, the only
 *                          thing that survives the jump from browser to WhatsApp
 */

/**
 * Crockford base32: digits plus A-Z minus I, L, O and U. Chosen so a code stays
 * unambiguous when read aloud over the phone or typed by hand. Must stay
 * byte-identical to the alphabet in migration 056's gen_referral_code().
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Matches the CHECK constraints in migration 056. */
export const CROCKFORD_CHAR_CLASS = '[0-9A-HJKMNP-TV-Z]';

export const JOB_CODE_LENGTH = 6;
export const SHARE_CODE_LENGTH = 8;
export const APPLY_TOKEN_LENGTH = 8;

/**
 * Prefix on the code we ask a person to send us on WhatsApp. It exists to make
 * collision with the onboarding gate's own vocabulary structurally impossible:
 * START, EMPEZAR, HELP, AYUDA, JOBS, TRABAJOS and numeric OTP codes can never
 * match a prefixed token.
 */
export const APPLY_TOKEN_PREFIX = 'JALE-';

const JOB_CODE_PATTERN = new RegExp(`^${CROCKFORD_CHAR_CLASS}{${JOB_CODE_LENGTH}}$`);
const SHARE_CODE_PATTERN = new RegExp(`^${CROCKFORD_CHAR_CLASS}{${SHARE_CODE_LENGTH}}$`);
const APPLY_TOKEN_PATTERN = new RegExp(`^${CROCKFORD_CHAR_CLASS}{${APPLY_TOKEN_LENGTH}}$`);

/**
 * Generates a uniformly random Crockford base32 code.
 *
 * 256 is an exact multiple of 32, so a plain modulo over a random byte is
 * uniform and needs no rejection sampling. Uses crypto.randomBytes rather than
 * Math.random so apply tokens are not guessable.
 *
 * Pure generator: no uniqueness check. Uniqueness is owned by the unique
 * indexes in migration 056 and every caller must retry on unique violation.
 */
export function generateCode(length: number): string {
  if (!Number.isInteger(length) || length < 4 || length > 24) {
    throw new Error(`generateCode: length must be an integer 4..24, got ${length}`);
  }
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i] % 32];
  }
  return out;
}

export const generateJobCode = (): string => generateCode(JOB_CODE_LENGTH);
export const generateShareCode = (): string => generateCode(SHARE_CODE_LENGTH);
export const generateApplyToken = (): string => generateCode(APPLY_TOKEN_LENGTH);

/**
 * Canonicalizes a code a human may have typed, read off a screen, or dictated.
 *
 * Crockford's decoding rules: case-insensitive, and the letters excluded from
 * the alphabet map to the digits they resemble (I and L to 1, O to 0). Also
 * strips whitespace, hyphens and the JALE- prefix, so "jale-l0o1 23" and
 * "JALE1001 23" both resolve to the same stored code. U is NOT mapped: it is
 * excluded to avoid accidental profanity, not for visual ambiguity, so a U is a
 * genuine typo and must not be silently rewritten.
 */
export function normalizeCode(input: string): string {
  return mapAmbiguousChars(
    input
      .toUpperCase()
      .replace(/[\s\-_.]/g, '')
      .replace(/^JALE/, ''),
  );
}

/**
 * Applies only Crockford's ambiguous-character rules, with no prefix handling.
 * Kept separate from normalizeCode so a value that has already had its prefix
 * removed cannot have a second one stripped off its leading characters.
 */
function mapAmbiguousChars(value: string): string {
  return value.replace(/[IL]/g, '1').replace(/O/g, '0');
}

export const isValidJobCode = (code: string): boolean => JOB_CODE_PATTERN.test(code);
export const isValidShareCode = (code: string): boolean => SHARE_CODE_PATTERN.test(code);
export const isValidApplyToken = (code: string): boolean => APPLY_TOKEN_PATTERN.test(code);

/** Renders an apply token the way it appears in a prefilled WhatsApp message. */
export const formatApplyToken = (token: string): string => `${APPLY_TOKEN_PREFIX}${token}`;

/**
 * Extracts an apply token from arbitrary inbound message text.
 *
 * Requires the JALE- prefix, so no bare word or OTP digit string can match.
 * Returns the normalized token, or null when the text carries none. Never
 * throws and never logs: inbound message bodies are untrusted user content.
 */
export function parseApplyToken(body: string | null | undefined): string | null {
  if (!body) return null;
  // Scan EVERY occurrence, not just the leftmost. "Jale" is the brand name, so a
  // person may well write "Hola Jale, quiero trabajar - JALE-ABCD1234": stopping
  // at the first match would capture the following word, fail validation, and
  // silently drop a token that was right there in the message.
  //
  // Tolerate the separator being a hyphen, space, colon or nothing at all, since
  // the person may retype the code rather than send our prefilled text.
  for (const match of body.toUpperCase().matchAll(/JALE[\s\-_:]*([0-9A-Z]{8})/g)) {
    // The prefix is already consumed by the regex, so only the ambiguous-char
    // rules apply here -- normalizeCode would try to strip a prefix again.
    const candidate = mapAmbiguousChars(match[1]);
    if (isValidApplyToken(candidate)) return candidate;
  }
  return null;
}

/**
 * SHA-256 hex of a raw token. Only the hash is ever stored, mirroring
 * infra/lambda/api/employer-upload-token.ts. Never log the input.
 */
export const hashToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex');

/**
 * Salted hash of IP + user agent, used only to collapse duplicate opens of the
 * same share link. The raw IP address and user-agent string must never be
 * stored or logged. The salt must come from configuration, never a literal.
 */
export function hashVisitor(salt: string, ip: string, userAgent: string): string {
  if (!salt) throw new Error('hashVisitor: salt is required');
  return createHash('sha256').update(`${salt}\u0000${ip}\u0000${userAgent}`).digest('hex');
}
