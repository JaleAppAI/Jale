import { createHash, randomBytes } from 'node:crypto';

/**
 * The attach token: what lets the person who sent a report add its image,
 * with no sign-in needed. 32 random bytes, base64url-encoded, returned once
 * in the create response. Only its SHA-256 hex reaches the database, the same
 * construction as the other one-time tokens (lib/referral-codes.ts hashToken).
 * Never log the token or its hash.
 */
export function hashAttachToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newAttachToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashAttachToken(token) };
}
