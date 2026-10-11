import { describe, expect, it } from 'vitest';
import { normalizeShareCode } from '@/lib/share-code';

/*
 * The frontend twin of the backend's share-code rules
 * (infra/lambda/lib/referral-codes.ts: normalizeCode, then isValidShareCode).
 *
 * The backend's normalizeCode vectors are ported below. Most of them normalise
 * to fewer than eight characters, which would make every one of them simply
 * assert null here, so each is lengthened to a full share code while keeping
 * the rule it exercises.
 */

describe('normalizeShareCode: the backend normalizeCode vectors', () => {
  it('normalises "jale-l0o1 2345" and "JALE1001 2345" to the same code', () => {
    expect(normalizeShareCode('jale-l0o1 2345')).toBe('10012345');
    expect(normalizeShareCode('JALE1001 2345')).toBe('10012345');
  });

  it('handles lowercase input', () => {
    expect(normalizeShareCode('abcd1234')).toBe('ABCD1234');
  });

  it('strips spaces, hyphens, underscores and dots', () => {
    expect(normalizeShareCode('AB-CD_12.34')).toBe('ABCD1234');
    expect(normalizeShareCode('AB CD 12 34')).toBe('ABCD1234');
  });

  it('strips a leading JALE prefix', () => {
    expect(normalizeShareCode('JALE8F4K2QRS')).toBe('8F4K2QRS');
  });

  it('maps I and L to 1, and O to 0', () => {
    expect(normalizeShareCode('ILOILOIL')).toBe('11011011');
    expect(normalizeShareCode('iloiloil')).toBe('11011011');
  });

  it('does NOT rewrite U: it is a genuine typo, so the code is rejected', () => {
    expect(normalizeShareCode('AU1BCDEF')).toBeNull();
    expect(normalizeShareCode('UUUUUUUU')).toBeNull();
  });
});

describe('normalizeShareCode: prefix and separator order', () => {
  it('strips the JALE prefix only once', () => {
    // The second JALE is code, not prefix, so its L still maps to 1.
    expect(normalizeShareCode('JALEJALE1234')).toBe('JA1E1234');
  });

  it('strips separators before looking for the prefix', () => {
    expect(normalizeShareCode('J-A-L-E-ABCD-1234')).toBe('ABCD1234');
    expect(normalizeShareCode('jale-8f4k-2qrs')).toBe('8F4K2QRS');
  });

  it('only strips JALE at the start', () => {
    expect(normalizeShareCode('ABCDJALE')).toBe('ABCDJA1E');
  });

  it('strips surrounding whitespace, tabs and newlines', () => {
    expect(normalizeShareCode('  abcd\t1234\n')).toBe('ABCD1234');
  });
});

describe('normalizeShareCode: validation against the share-code pattern', () => {
  it('accepts every character of the Crockford alphabet', () => {
    // Same 32 characters as CROCKFORD_ALPHABET and migration 056's CHECK.
    for (const code of ['01234567', '89ABCDEF', 'GHJKMNPQ', 'RSTVWXYZ']) {
      expect(normalizeShareCode(code)).toBe(code);
    }
  });

  it('returns null for null, undefined and the empty string', () => {
    expect(normalizeShareCode(null)).toBeNull();
    expect(normalizeShareCode(undefined)).toBeNull();
    expect(normalizeShareCode('')).toBeNull();
  });

  it('returns null for codes one character short or long', () => {
    expect(normalizeShareCode('ABCDEFG')).toBeNull();
    expect(normalizeShareCode('ABCDEFGHJ')).toBeNull();
  });

  it('returns null for a six-character job code', () => {
    expect(normalizeShareCode('ABC123')).toBeNull();
  });

  it('returns null for characters that are neither code nor separator', () => {
    expect(normalizeShareCode('ABCD!234')).toBeNull();
    expect(normalizeShareCode('ABCD/234')).toBeNull();
    expect(normalizeShareCode('https://jaleapp.ai')).toBeNull();
  });

  it('returns null for a JALE prefix with nothing after it', () => {
    expect(normalizeShareCode('JALE-')).toBeNull();
  });
});
