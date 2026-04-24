/**
 * Minimal JWT claim reader for Cognito-issued tokens.
 *
 * Context: after a successful Cognito custom-auth RespondToAuthChallenge, the
 * processor receives an `AuthenticationResult` containing an `IdToken`. The
 * token's `sub` claim is Cognito's canonical UUID identifier for the user and
 * is the value downstream web APIs + RLS policies match against. The WhatsApp
 * processor previously wrote `cognito_sub = whatsappNumber` as a placeholder
 * and never replaced it — Codex 2026-04-17 review outcome.
 *
 * This module only READS a claim from a token Cognito has already signed and
 * returned to us. It does NOT validate the signature — that would be
 * appropriate for accepting tokens from untrusted callers, but here the token
 * just left the `cognito-idp` SDK response. Re-verifying it buys nothing and
 * adds a JWKS dependency.
 */

/**
 * Decode the `sub` claim from a Cognito ID token.
 *
 * @param idToken  Raw JWT string (three dot-separated base64url segments)
 * @returns        The `sub` claim value
 * @throws         If the token is malformed, not a JWT shape, the payload is
 *                 not valid JSON, or the `sub` claim is missing/not a string.
 */
export function decodeIdTokenSub(idToken: string): string {
  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new Error('decodeIdTokenSub: idToken must be a non-empty string');
  }
  const segments = idToken.split('.');
  if (segments.length !== 3) {
    throw new Error(
      `decodeIdTokenSub: expected 3 JWT segments, got ${segments.length}`,
    );
  }
  const payloadSegment = segments[1];
  let payloadJson: string;
  try {
    // Node 16+ supports 'base64url' directly — handles the `-`/`_` alphabet
    // and missing padding that Cognito's tokens use.
    payloadJson = Buffer.from(payloadSegment, 'base64url').toString('utf8');
  } catch (err) {
    throw new Error(
      `decodeIdTokenSub: failed to base64url-decode payload: ${(err as Error).message}`,
    );
  }
  let claims: unknown;
  try {
    claims = JSON.parse(payloadJson);
  } catch (err) {
    throw new Error(
      `decodeIdTokenSub: payload is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof claims !== 'object' || claims === null) {
    throw new Error('decodeIdTokenSub: payload is not an object');
  }
  const sub = (claims as Record<string, unknown>).sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('decodeIdTokenSub: sub claim is missing or not a string');
  }
  return sub;
}
