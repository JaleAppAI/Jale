const mockGetUnsubscribeSecret = jest.fn();
jest.mock('../../../../lambda/lib/unsubscribe-secret', () => ({
  getUnsubscribeSecret: mockGetUnsubscribeSecret,
}));

import { createHmac } from 'node:crypto';
import { mintUnsubscribeToken, verifyUnsubscribeToken } from '../../../../lambda/lib/unsubscribe-token';

const SECRET = 'test-signing-secret';
const EMPLOYER_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_EMPLOYER_ID = '99999999-8888-4777-a666-555555555555';

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function signWith(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

describe('unsubscribe token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUnsubscribeSecret.mockResolvedValue(SECRET);
  });

  // ── Round trip ────────────────────────────────────────────────────────────

  it('round-trips (employerId, version)', async () => {
    const token = await mintUnsubscribeToken(EMPLOYER_ID, 1);
    await expect(verifyUnsubscribeToken(token)).resolves.toEqual({
      employerId: EMPLOYER_ID,
      version: 1,
    });
  });

  it('mints the documented shape: base64url(payload).base64url(hmac-sha256)', async () => {
    const token = await mintUnsubscribeToken(EMPLOYER_ID, 7);
    const [payloadSegment, signatureSegment] = token.split('.');
    expect(token.split('.')).toHaveLength(2);
    expect(Buffer.from(payloadSegment, 'base64url').toString('utf8')).toBe(`${EMPLOYER_ID}.7`);
    expect(signatureSegment).toBe(signWith(SECRET, `${EMPLOYER_ID}.7`));
    // sha256, not the sha1 the Twilio validator uses.
    expect(Buffer.from(signatureSegment, 'base64url')).toHaveLength(32);
  });

  it('round-trips the smallint boundary version', async () => {
    const token = await mintUnsubscribeToken(EMPLOYER_ID, 32767);
    await expect(verifyUnsubscribeToken(token)).resolves.toEqual({
      employerId: EMPLOYER_ID,
      version: 32767,
    });
  });

  it('refuses to mint an out-of-range or non-integer version', async () => {
    for (const bad of [0, -1, 32768, 1.5, Number.NaN]) {
      await expect(mintUnsubscribeToken(EMPLOYER_ID, bad)).rejects.toThrow();
    }
  });

  it('refuses to mint for a non-UUID employer id', async () => {
    await expect(mintUnsubscribeToken('not-a-uuid', 1)).rejects.toThrow();
  });

  // ── Tamper: each segment ──────────────────────────────────────────────────

  it('rejects a tampered payload segment (different employer, original signature)', async () => {
    const token = await mintUnsubscribeToken(EMPLOYER_ID, 1);
    const [, signatureSegment] = token.split('.');
    const forged = `${b64url(`${OTHER_EMPLOYER_ID}.1`)}.${signatureSegment}`;
    await expect(verifyUnsubscribeToken(forged)).resolves.toBeNull();
  });

  it('rejects a tampered signature segment', async () => {
    const token = await mintUnsubscribeToken(EMPLOYER_ID, 1);
    const [payloadSegment, signatureSegment] = token.split('.');
    const flipped = signatureSegment.startsWith('A')
      ? `B${signatureSegment.slice(1)}`
      : `A${signatureSegment.slice(1)}`;
    await expect(verifyUnsubscribeToken(`${payloadSegment}.${flipped}`)).resolves.toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const payload = `${EMPLOYER_ID}.1`;
    const forged = `${b64url(payload)}.${signWith('some-other-secret', payload)}`;
    await expect(verifyUnsubscribeToken(forged)).resolves.toBeNull();
  });

  // ── Truncation / wrong length / malformed ─────────────────────────────────

  it('rejects a truncated token (short signature) without throwing on timingSafeEqual', async () => {
    const token = await mintUnsubscribeToken(EMPLOYER_ID, 1);
    // A bare timingSafeEqual on mismatched lengths THROWS; the length guard
    // must turn that into a plain null.
    await expect(verifyUnsubscribeToken(token.slice(0, token.length - 5))).resolves.toBeNull();
  });

  it('rejects malformed shapes', async () => {
    for (const bad of [
      '',
      'no-dot-at-all',
      'a.b.c',
      '.',
      `${b64url(`${EMPLOYER_ID}.1`)}.`,
      `.${signWith(SECRET, `${EMPLOYER_ID}.1`)}`,
      'not-base64url!!.also-not',
    ]) {
      await expect(verifyUnsubscribeToken(bad)).resolves.toBeNull();
    }
  });

  it('rejects an absurdly long token before doing any work', async () => {
    await expect(verifyUnsubscribeToken('a'.repeat(5000))).resolves.toBeNull();
    expect(mockGetUnsubscribeSecret).not.toHaveBeenCalled();
  });

  it('rejects non-string input', async () => {
    await expect(verifyUnsubscribeToken(undefined as unknown as string)).resolves.toBeNull();
    await expect(verifyUnsubscribeToken(null as unknown as string)).resolves.toBeNull();
    await expect(verifyUnsubscribeToken(42 as unknown as string)).resolves.toBeNull();
  });

  // ── Version-bump mismatch and bounds ─────────────────────────────────────

  it('a version bump changes the token — the old signature does not validate for the new version', async () => {
    const v1 = await mintUnsubscribeToken(EMPLOYER_ID, 1);
    const v2 = await mintUnsubscribeToken(EMPLOYER_ID, 2);
    expect(v1).not.toBe(v2);
    // Splicing v1's signature onto a v2 payload must not validate.
    const [, v1Signature] = v1.split('.');
    const forged = `${b64url(`${EMPLOYER_ID}.2`)}.${v1Signature}`;
    await expect(verifyUnsubscribeToken(forged)).resolves.toBeNull();
    // And the genuine v1 token still parses as version 1, so the DB call
    // (which compares versions) is what no-ops, not this function.
    await expect(verifyUnsubscribeToken(v1)).resolves.toEqual({ employerId: EMPLOYER_ID, version: 1 });
  });

  it('rejects a non-UUID employer id even when correctly signed', async () => {
    const payload = 'not-a-uuid.1';
    const forged = `${b64url(payload)}.${signWith(SECRET, payload)}`;
    await expect(verifyUnsubscribeToken(forged)).resolves.toBeNull();
  });

  it('rejects a non-integer version even when correctly signed', async () => {
    for (const versionText of ['1.5', 'abc', '', ' 1', '+1', '0x1']) {
      const payload = `${EMPLOYER_ID}.${versionText}`;
      const forged = `${b64url(payload)}.${signWith(SECRET, payload)}`;
      await expect(verifyUnsubscribeToken(forged)).resolves.toBeNull();
    }
  });

  it('rejects an out-of-range version even when correctly signed — it must never reach the smallint column', async () => {
    for (const versionText of ['0', '32768', '99999', '-1']) {
      const payload = `${EMPLOYER_ID}.${versionText}`;
      const forged = `${b64url(payload)}.${signWith(SECRET, payload)}`;
      await expect(verifyUnsubscribeToken(forged)).resolves.toBeNull();
    }
  });

  it('rejects a non-canonical base64url payload encoding', async () => {
    // Padded base64 decodes to the same bytes but is not the encoding mint
    // produces; accepting it would give one logical link two valid tokens.
    const payload = `${EMPLOYER_ID}.1`;
    const padded = `${Buffer.from(payload, 'utf8').toString('base64url')}=`;
    await expect(verifyUnsubscribeToken(`${padded}.${signWith(SECRET, payload)}`)).resolves.toBeNull();
  });
});
