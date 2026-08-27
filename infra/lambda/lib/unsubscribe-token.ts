import { createHmac, timingSafeEqual } from 'node:crypto';
import { getUnsubscribeSecret } from './unsubscribe-secret';

/**
 * One-click unsubscribe tokens for the employer daily digest.
 *
 * Shape:  base64url("<employerId>.<version>") + "." + base64url(HMAC-SHA256(secret, "<employerId>.<version>"))
 *
 * There is no expiry embedded in the token on purpose: revocation is the
 * `employer_digest_settings.unsubscribe_token_version` counter (migration
 * 080). Bumping it makes every previously-mailed link a no-op, which
 * `jale_digest_internal.unsubscribe_employer(uuid, smallint)` enforces by
 * refusing to act when the presented version no longer matches the row.
 *
 * That function explicitly does NOT authenticate the caller — its header says
 * so. This module is the authenticator, and it runs BEFORE the DB call.
 *
 * HMAC-SHA256, not the SHA1 used by lambda/whatsapp/lib/twilio.ts (that
 * algorithm is dictated by Twilio's published scheme; nothing dictates ours).
 * The comparison follows the same contract as that validator: guard the
 * lengths first, because `timingSafeEqual` THROWS on mismatched buffer
 * lengths rather than returning false.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** smallint upper bound — an out-of-range value must be rejected here, not become a 22003 at the DB. */
const MIN_TOKEN_VERSION = 1;
const MAX_TOKEN_VERSION = 32767;
/**
 * A well-formed token is ~100 chars. The cap exists so a megabyte of garbage
 * in the request body is rejected before any base64 decode or HMAC work, and
 * before the secret is even fetched.
 */
const MAX_TOKEN_LENGTH = 512;

export interface UnsubscribeTokenClaims {
  employerId: string;
  version: number;
}

function payloadFor(employerId: string, version: number): string {
  return `${employerId}.${version}`;
}

function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Mints a token for (employerId, version). `version` comes straight from the
 * `unsubscribe_token_version` column returned by
 * `jale_digest_internal.due_digest_employers()` — never from a second query.
 */
export async function mintUnsubscribeToken(employerId: string, version: number): Promise<string> {
  if (typeof employerId !== 'string' || !UUID_REGEX.test(employerId)) {
    throw new Error('unsubscribe_token_employer_id_invalid');
  }
  if (!Number.isInteger(version) || version < MIN_TOKEN_VERSION || version > MAX_TOKEN_VERSION) {
    throw new Error('unsubscribe_token_version_invalid');
  }
  const secret = await getUnsubscribeSecret();
  const payload = payloadFor(employerId, version);
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signPayload(secret, payload)}`;
}

/**
 * Verifies a token. Returns the claims, or null for ANY failure — malformed,
 * tampered, wrong secret, non-UUID employer id, or a version outside the
 * smallint range. Callers must collapse every null to one uniform response so
 * the shape of the failure is not observable.
 *
 * Structural validation happens before the secret is fetched, so obviously
 * junk input costs nothing.
 */
export async function verifyUnsubscribeToken(token: string): Promise<UnsubscribeTokenClaims | null> {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;

  const segments = token.split('.');
  if (segments.length !== 2) return null;
  const [payloadSegment, signatureSegment] = segments;
  if (!payloadSegment || !signatureSegment) return null;

  const payload = Buffer.from(payloadSegment, 'base64url').toString('utf8');
  // Node's base64url decoder is lenient: it silently drops characters outside
  // the alphabet and tolerates padding. Re-encoding and requiring an exact
  // match pins ONE canonical encoding per logical token, so a padded or
  // dirtied variant of a genuine token is not also accepted.
  if (Buffer.from(payload, 'utf8').toString('base64url') !== payloadSegment) return null;

  const payloadParts = payload.split('.');
  if (payloadParts.length !== 2) return null;
  const [employerId, versionText] = payloadParts;

  if (!UUID_REGEX.test(employerId)) return null;
  // Digits only: excludes '1.5', '+1', ' 1', '0x1' and the empty string, all
  // of which Number() would otherwise coerce into something plausible.
  if (!/^[0-9]{1,5}$/.test(versionText)) return null;
  const version = Number(versionText);
  if (!Number.isInteger(version) || version < MIN_TOKEN_VERSION || version > MAX_TOKEN_VERSION) return null;

  const secret = await getUnsubscribeSecret();
  const expected = Buffer.from(signPayload(secret, payload), 'utf8');
  const presented = Buffer.from(signatureSegment, 'utf8');
  // Length guard FIRST — timingSafeEqual throws on a length mismatch.
  if (expected.length !== presented.length) return null;
  if (!timingSafeEqual(expected, presented)) return null;

  return { employerId, version };
}
