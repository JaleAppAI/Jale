import {
  isGreetingKeyword,
  isJobsKeyword,
  isAccept,
  isDecline,
  parseButtonPayload,
  parseProfileAnswer,
  computeNextField,
  PROFILE_FIELDS,
} from '../../../../../lambda/whatsapp/lib/flows';

// `isStaleReplay` was removed 2026-04-17 (Codex fix pass). Its call site
// passed `pending` twice so the guard was always false — dead code. Replay
// protection now lives in processor.ts via `isDuplicateSid` (covers the
// coarse last-sid match and per-field `state_context.field_sids` scan).

describe('flows.ts — keyword detection', () => {
  describe('isGreetingKeyword', () => {
    test.each([
      ['Hola', true],
      ['hola', true],
      ['HOLA', true],
      ['Hello', true],
      ['hi', true],
      ['Hey there', true],
      ['Buenas', true],
      ['Buenos días', true],
      ['Trabajos', false],
      ['', false],
      ['hell', false], // not 'hello' prefix
    ])('isGreetingKeyword("%s") → %s', (input, expected) => {
      expect(isGreetingKeyword(input)).toBe(expected);
    });
  });

  describe('isJobsKeyword', () => {
    test.each([
      ['Trabajos', true],
      ['trabajos', true],
      ['trabajo', true],
      ['Jobs', true],
      ['job', true],
      ['Empleo', true],
      ['empleos', true],
      ['Hola', false],
      ['', false],
    ])('isJobsKeyword("%s") → %s', (input, expected) => {
      expect(isJobsKeyword(input)).toBe(expected);
    });
  });

  describe('isAccept / isDecline', () => {
    it('accepts "Acepto" in Spanish', () => {
      expect(isAccept('Acepto', 'es')).toBe(true);
      expect(isAccept('acepto', 'es')).toBe(true);
      expect(isAccept('Sí', 'es')).toBe(true);
    });
    it('accepts "Accept" in English', () => {
      expect(isAccept('Accept', 'en')).toBe(true);
      expect(isAccept('Yes', 'en')).toBe(true);
    });
    it('declines "No acepto" in Spanish', () => {
      expect(isDecline('No acepto', 'es')).toBe(true);
      expect(isDecline('No', 'es')).toBe(true);
    });
    it('declines "Decline" in English', () => {
      expect(isDecline('Decline', 'en')).toBe(true);
      expect(isDecline('No', 'en')).toBe(true);
    });
  });
});

describe('flows.ts — parseButtonPayload', () => {
  it('parses accept payload', () => {
    expect(parseButtonPayload('accept:job-abc-123')).toEqual({
      action: 'accept',
      jobId: 'job-abc-123',
    });
  });
  it('parses decline payload', () => {
    expect(parseButtonPayload('decline:job-xyz')).toEqual({
      action: 'decline',
      jobId: 'job-xyz',
    });
  });
  it('parses info payload', () => {
    expect(parseButtonPayload('info:job-42')).toEqual({
      action: 'info',
      jobId: 'job-42',
    });
  });
  it('rejects unknown action', () => {
    expect(parseButtonPayload('hack:job-1')).toBeNull();
  });
  it('rejects missing jobId', () => {
    expect(parseButtonPayload('accept:')).toBeNull();
  });
  it('rejects random text', () => {
    expect(parseButtonPayload('Hola')).toBeNull();
  });
});

describe('flows.ts — parseProfileAnswer', () => {
  it('accepts text for full_name', () => {
    expect(parseProfileAnswer('full_name', '  Juan Garcia  ')).toBe('Juan Garcia');
  });

  it('rejects empty text for full_name', () => {
    expect(parseProfileAnswer('full_name', '   ')).toBeNull();
  });

  it('maps numeric choice to canonical trade slug', () => {
    // 1)Electrician  2)Plumber  3)Carpenter  4)Concrete  5)Painting  6)Other
    expect(parseProfileAnswer('main_trade', '1')).toBe('electrician');
    expect(parseProfileAnswer('main_trade', '3')).toBe('carpenter');
    expect(parseProfileAnswer('main_trade', '6')).toBe('other');
  });

  it('rejects out-of-range trade choice', () => {
    expect(parseProfileAnswer('main_trade', '7')).toBeNull();
    expect(parseProfileAnswer('main_trade', '0')).toBeNull();
  });

  it('rejects non-numeric for button fields', () => {
    expect(parseProfileAnswer('main_trade', 'Electrician')).toBeNull();
  });

  it('maps numeric choice to years_experience slug', () => {
    expect(parseProfileAnswer('years_experience', '1')).toBe('0-1');
    expect(parseProfileAnswer('years_experience', '4')).toBe('10+');
  });

  it('maps numeric choice to boolean for has_transportation', () => {
    expect(parseProfileAnswer('has_transportation', '1')).toBe(true);
    expect(parseProfileAnswer('has_transportation', '2')).toBe(false);
  });

  it('maps numeric choice to availability slug', () => {
    expect(parseProfileAnswer('availability', '1')).toBe('full_time');
    expect(parseProfileAnswer('availability', '4')).toBe('flexible');
  });
});

describe('flows.ts — computeNextField', () => {
  it('starts at full_name when nothing is collected', () => {
    expect(computeNextField({}, {})).toBe('full_name');
  });

  it('advances to city after full_name is collected', () => {
    expect(computeNextField({ full_name: 'Juan' }, {})).toBe('city');
  });

  it('skips main_trade_other when main_trade !== "other"', () => {
    expect(
      computeNextField(
        { full_name: 'J', city: 'Houston', main_trade: 'electrician' },
        {},
      ),
    ).toBe('years_experience');
  });

  it('includes main_trade_other when main_trade === "other"', () => {
    expect(
      computeNextField(
        { full_name: 'J', city: 'Houston', main_trade: 'other' },
        {},
      ),
    ).toBe('main_trade_other');
  });

  it('skips fields already filled in DB (existing-user partial resume)', () => {
    expect(
      computeNextField({}, { full_name: 'Juan', city: 'Houston' }),
    ).toBe('main_trade');
  });

  it('returns null when all fields are complete', () => {
    expect(
      computeNextField(
        {
          full_name: 'Juan',
          city: 'Houston',
          main_trade: 'electrician',
          years_experience: '5-9',
          has_transportation: true,
          availability: 'full_time',
        },
        {},
      ),
    ).toBeNull();
  });

  it('returns null when all fields are pre-filled in DB', () => {
    expect(
      computeNextField(
        {},
        {
          full_name: 'Juan',
          city: 'Houston',
          main_trade: 'electrician',
          years_experience: '5-9',
          has_transportation: true,
          availability: 'full_time',
        },
      ),
    ).toBeNull();
  });

  it('honors "Otro" branch even when pre-filled in DB', () => {
    expect(
      computeNextField(
        {},
        {
          full_name: 'Juan',
          city: 'Houston',
          main_trade: 'other',
          // main_trade_other NOT filled
        },
      ),
    ).toBe('main_trade_other');
  });

  it('treats null DB values as "needs to be asked"', () => {
    expect(
      computeNextField({}, { full_name: null, city: null }),
    ).toBe('full_name');
  });
});

describe('flows.ts — PROFILE_FIELDS structural', () => {
  it('contains all 7 fields including conditional', () => {
    expect(PROFILE_FIELDS.map((f) => f.field)).toEqual([
      'full_name',
      'city',
      'main_trade',
      'main_trade_other',
      'years_experience',
      'has_transportation',
      'availability',
    ]);
  });

  it('only main_trade_other is conditional', () => {
    const conditionals = PROFILE_FIELDS.filter((f) => f.conditional);
    expect(conditionals.map((f) => f.field)).toEqual(['main_trade_other']);
  });

  it('main_trade options match the DB CHECK constraint slugs', () => {
    const trade = PROFILE_FIELDS.find((f) => f.field === 'main_trade');
    expect(trade?.options).toEqual([
      'electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other',
    ]);
  });

  it('years_experience options match the DB CHECK constraint slugs', () => {
    const exp = PROFILE_FIELDS.find((f) => f.field === 'years_experience');
    expect(exp?.options).toEqual(['0-1', '2-4', '5-9', '10+']);
  });

  it('availability options match the DB CHECK constraint slugs', () => {
    const av = PROFILE_FIELDS.find((f) => f.field === 'availability');
    expect(av?.options).toEqual(['full_time', 'part_time', 'weekends', 'flexible']);
  });
});
