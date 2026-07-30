import {
  CROCKFORD_ALPHABET,
  formatApplyToken,
  generateCode,
  hashToken,
  hashVisitor,
  normalizeCode,
  parseApplyToken,
} from '../../../../lambda/lib/referral-codes';

describe('generateCode', () => {
  it.each([3.5, NaN, Infinity, -Infinity])('rejects non-integer length %s', (length) => {
    expect(() => generateCode(length)).toThrow(/length must be an integer/);
  });

  it.each([0, 1, 3, 25, 100, -4])('rejects out-of-range length %s', (length) => {
    expect(() => generateCode(length)).toThrow(/length must be an integer/);
  });

  it.each([4, 8, 16, 24])('produces a code of the requested length %s', (length) => {
    expect(generateCode(length)).toHaveLength(length);
  });

  it('never emits I, L, O or U across many samples', () => {
    for (let i = 0; i < 5000; i += 1) {
      const code = generateCode(12);
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  it('covers all 32 alphabet characters over many samples', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      for (const ch of generateCode(16)) {
        seen.add(ch);
      }
    }
    for (const ch of CROCKFORD_ALPHABET) {
      expect(seen.has(ch)).toBe(true);
    }
    expect(seen.size).toBe(32);
  });
});

describe('normalizeCode', () => {
  it('normalizes "jale-l0o1 23" and "JALE1001 23" to the same value', () => {
    expect(normalizeCode('jale-l0o1 23')).toBe(normalizeCode('JALE1001 23'));
  });

  it('handles lowercase input', () => {
    expect(normalizeCode('abcd1234')).toBe('ABCD1234');
  });

  it('strips spaces, hyphens, underscores and dots', () => {
    expect(normalizeCode('AB-CD_12.34')).toBe('ABCD1234');
    expect(normalizeCode('AB CD 12 34')).toBe('ABCD1234');
  });

  it('strips a leading JALE prefix', () => {
    expect(normalizeCode('JALE8F4K2QRS')).toBe('8F4K2QRS');
  });

  it('maps I and L to 1, and O to 0', () => {
    expect(normalizeCode('ILO')).toBe('110');
  });

  it('does NOT rewrite U — it is a genuine typo, not visual ambiguity', () => {
    expect(normalizeCode('U')).toBe('U');
    expect(normalizeCode('AU1B')).toBe('AU1B');
  });
});

describe('parseApplyToken', () => {
  it.each(['START', 'EMPEZAR', 'HELP', 'AYUDA', 'JOBS', 'TRABAJOS'])(
    'returns null for onboarding-gate keyword "%s"',
    (keyword) => {
      expect(parseApplyToken(keyword)).toBeNull();
    },
  );

  it('returns null for a bare 6-digit OTP', () => {
    expect(parseApplyToken('483920')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseApplyToken('')).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(parseApplyToken(null)).toBeNull();
    expect(parseApplyToken(undefined)).toBeNull();
  });

  it('extracts the token from the real prefilled message', () => {
    expect(parseApplyToken('I want to apply for this job: JALE-8F4K2QRS')).toBe('8F4K2QRS');
  });

  it.each([
    ['jale 8f4k2qrs', '8F4K2QRS'],
    ['JALE:8F4K2QRS', '8F4K2QRS'],
    ['JALE_8F4K2QRS', '8F4K2QRS'],
    ['JALE8F4K2QRS', '8F4K2QRS'],
  ])('extracts the token from sloppy variant "%s"', (input, expected) => {
    expect(parseApplyToken(input)).toBe(expected);
  });
});

describe('hashToken', () => {
  it('is stable for the same input', () => {
    expect(hashToken('abc123')).toBe(hashToken('abc123'));
  });

  it('is 64 lowercase hex characters', () => {
    expect(hashToken('abc123')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for differing input', () => {
    expect(hashToken('abc123')).not.toBe(hashToken('abc124'));
  });
});

describe('hashVisitor', () => {
  it('throws without a salt', () => {
    expect(() => hashVisitor('', '1.2.3.4', 'ua')).toThrow(/salt is required/);
  });

  it('changes when the salt changes', () => {
    const a = hashVisitor('salt-a', '1.2.3.4', 'ua');
    const b = hashVisitor('salt-b', '1.2.3.4', 'ua');
    expect(a).not.toBe(b);
  });

  it('is stable for the same salt/ip/ua', () => {
    expect(hashVisitor('salt', '1.2.3.4', 'ua')).toBe(hashVisitor('salt', '1.2.3.4', 'ua'));
  });
});

describe('formatApplyToken round-trips through parseApplyToken', () => {
  it('round-trips a generated apply token', () => {
    const token = 'ABCDEFGH';
    const formatted = formatApplyToken(token);
    expect(parseApplyToken(formatted)).toBe(token);
  });

  it('round-trips within a longer message body', () => {
    const token = '8F4K2QRS';
    const formatted = formatApplyToken(token);
    expect(parseApplyToken(`I want to apply for this job: ${formatted}`)).toBe(token);
  });
});
