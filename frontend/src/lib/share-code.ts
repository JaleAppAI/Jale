// The frontend twin of the backend's share-code rules
// (infra/lambda/lib/referral-codes.ts: normalizeCode, then isValidShareCode).
// The two MUST stay in step: a code this accepts but the backend rejects is a
// referral that silently never attributes, and one this rejects is a referral
// that is dropped before it ever reaches the backend.
//
// A share code is the 8-character Crockford base32 key of one
// (job, referrer, channel) row. It is what public share URLs carry as `?r=`.

// Crockford base32: digits plus A-Z minus I, L, O and U. The same class as
// CROCKFORD_CHAR_CLASS in the backend and the CHECK constraint on
// job_share_links.code in migration 056.
const SHARE_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const SEPARATORS = /[\s\-_.]/g;
const BRAND_PREFIX = /^JALE/;
const LOOKS_LIKE_ONE = /[IL]/g;
const LOOKS_LIKE_ZERO = /O/g;

/**
 * Canonicalises a share code a person may have typed, read off a screen or
 * dictated, and returns it only if it is a valid share code.
 *
 * Case-insensitive; strips whitespace, hyphens, underscores and dots, then one
 * leading `JALE` prefix; maps I and L to 1 and O to 0, which is Crockford's
 * decoding rule for the letters the alphabet leaves out. U is NOT mapped: it
 * is excluded to avoid accidental words, not for looking like anything, so a U
 * is a genuine typo and the code is rejected rather than silently rewritten.
 *
 * Returns the normalised code, or null when there is none or it is invalid.
 */
export function normalizeShareCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw
    .toUpperCase()
    .replace(SEPARATORS, '')
    .replace(BRAND_PREFIX, '')
    .replace(LOOKS_LIKE_ONE, '1')
    .replace(LOOKS_LIKE_ZERO, '0');
  return SHARE_CODE_PATTERN.test(code) ? code : null;
}
