import { decodeIdTokenSub } from '../../../../../lambda/whatsapp/lib/jwt';

/**
 * Helper: encode a claims object as a 3-segment JWT (header.payload.signature).
 * The header + signature are dummy — decodeIdTokenSub only reads the payload.
 */
function makeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = 'not-verified-by-this-module';
  return `${header}.${payload}.${signature}`;
}

describe('lib/jwt — decodeIdTokenSub', () => {
  it('returns the sub claim from a well-formed Cognito ID token', () => {
    const token = makeIdToken({
      sub: '7a8b9c00-1234-5678-90ab-cdef00112233',
      'cognito:username': '+15125551234',
      aud: 'client-id',
      iss: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_xxx',
      token_use: 'id',
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    });
    expect(decodeIdTokenSub(token)).toBe('7a8b9c00-1234-5678-90ab-cdef00112233');
  });

  it('handles base64url characters (- and _) in the payload correctly', () => {
    // Craft a claims object that will encode with `-` and/or `_` in its
    // base64url representation (any JSON with `>` / `?` / `~` pushes you there).
    const token = makeIdToken({
      sub: 'abc-def',
      note: '>>?~~??',
    });
    expect(decodeIdTokenSub(token)).toBe('abc-def');
  });

  it('throws when idToken is empty', () => {
    expect(() => decodeIdTokenSub('')).toThrow(/non-empty string/);
  });

  it('throws when idToken is not a string', () => {
    // @ts-expect-error — deliberately passing non-string to exercise the guard
    expect(() => decodeIdTokenSub(undefined)).toThrow(/non-empty string/);
  });

  it('throws when the token does not have 3 segments', () => {
    expect(() => decodeIdTokenSub('only.two')).toThrow(/3 JWT segments/);
    expect(() => decodeIdTokenSub('a.b.c.d')).toThrow(/3 JWT segments/);
  });

  it('throws when the payload is not valid JSON', () => {
    // Put non-JSON bytes in the payload segment.
    const payload = Buffer.from('not json at all').toString('base64url');
    const token = `header.${payload}.sig`;
    expect(() => decodeIdTokenSub(token)).toThrow(/not valid JSON/);
  });

  it('throws when the payload has no sub claim', () => {
    const token = makeIdToken({
      'cognito:username': '+15125551234',
      // sub deliberately missing
    });
    expect(() => decodeIdTokenSub(token)).toThrow(/sub claim is missing/);
  });

  it('throws when sub is present but not a string', () => {
    const token = makeIdToken({ sub: 42 });
    expect(() => decodeIdTokenSub(token)).toThrow(/sub claim is missing or not a string/);
  });

  it('throws when sub is an empty string', () => {
    const token = makeIdToken({ sub: '' });
    expect(() => decodeIdTokenSub(token)).toThrow(/sub claim is missing or not a string/);
  });
});
