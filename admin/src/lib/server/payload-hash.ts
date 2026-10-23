/**
 * The admin origin is CloudFront in front of a signed Function URL: every
 * action body carries its SHA-256 in x-amz-content-sha256 (lib/admin-fetch.ts
 * hashes the exact string it sends). The action routes read the body once,
 * as text, and act on it only when the header is that text's digest.
 */
import { createHash } from 'node:crypto';

export const PAYLOAD_HASH_HEADER = 'x-amz-content-sha256';
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** The largest action body a route reads, unless the route passes its own limit. */
export const MAX_ACTION_BODY_LENGTH = 16_384;

/** The body as text, or null when it is over `maxLength` or cannot be read. */
export async function readActionBody(request: Request, maxLength: number = MAX_ACTION_BODY_LENGTH): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxLength) {
    return null;
  }
  try {
    const text = await request.text();
    return text.length > maxLength ? null : text;
  } catch {
    return null;
  }
}

/** Whether the request's x-amz-content-sha256 is the hex SHA-256 of `text` (either case). */
export function payloadHashMatches(request: Request, text: string): boolean {
  const header = request.headers.get(PAYLOAD_HASH_HEADER)?.trim().toLowerCase();
  if (!header || !SHA256_HEX.test(header)) {
    return false;
  }
  return header === createHash('sha256').update(text, 'utf8').digest('hex');
}
