/**
 * signup-source.ts -- the first-party signup source codes (contract K3.6,
 * sprint 28). BE-3b owns this module; the frontend keeps a mirror of the list.
 *
 * A source code comes only from Jale's own links (`/app?src=`,
 * `/j/<code>?src=`, the employer signup page `?src=`). It matches
 * `^[a-z0-9-]{2,32}$` AND is one of the codes below. Nothing else about the
 * visit is read.
 *
 * The signup body carries `signup_source: { src, entry }`. `entry` says which
 * of Jale's web pages the visit started on. A body whose entry is not one of
 * SIGNUP_ENTRIES is dropped whole; an entry with an unknown or malformed code
 * is kept with no code. Signup never fails because of this field.
 *
 * Migration 124 stores the result once per account (the first write wins),
 * through jale_cap.record_signup_source, whose table checks the same pattern.
 */
export const SIGNUP_SOURCE_CODES = [
  'flyer',
  'qr',
  'sms',
  'facebook-page',
  'instagram',
  'partner',
  'event',
  'other',
] as const;

export type SignupSourceCode = (typeof SIGNUP_SOURCE_CODES)[number];

/** The pattern every stored code matches (migration 124's CHECK). */
export const SIGNUP_SOURCE_PATTERN = /^[a-z0-9-]{2,32}$/;

const CODES: ReadonlySet<string> = new Set(SIGNUP_SOURCE_CODES);

export function isSignupSourceCode(value: unknown): value is SignupSourceCode {
  return typeof value === 'string' && SIGNUP_SOURCE_PATTERN.test(value) && CODES.has(value);
}

/**
 * The web pages a signup can start on (K3.6): `/app` (app), a public job page
 * (job_link) or the signup page itself (signup_page). The WhatsApp door has
 * no web entry; migration 124 infers it on the read side.
 */
export const SIGNUP_ENTRIES = ['app', 'job_link', 'signup_page'] as const;
export type SignupEntry = (typeof SIGNUP_ENTRIES)[number];
export interface SignupSource { src: SignupSourceCode | null; entry: SignupEntry }

const ENTRIES: ReadonlySet<string> = new Set(SIGNUP_ENTRIES);

/**
 * The `signup_source` field of a signup or first profile request, validated.
 * Returns null when the field is absent or its entry is not a web entry;
 * otherwise the entry with the code, or with no code when the code is not an
 * allow-listed one.
 */
export function parseSignupSource(value: unknown): SignupSource | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { src, entry } = value as { src?: unknown; entry?: unknown };
  if (typeof entry !== 'string' || !ENTRIES.has(entry)) return null;
  return { src: isSignupSourceCode(src) ? src : null, entry: entry as SignupEntry };
}
