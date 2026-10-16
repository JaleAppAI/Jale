import {
  SIGNUP_ENTRIES,
  SIGNUP_SOURCE_CODES,
  isSignupSourceCode,
  parseSignupSource,
} from '../../../../lambda/lib/signup-source';

describe('signup-source', () => {
  describe('isSignupSourceCode', () => {
    it.each([...SIGNUP_SOURCE_CODES])('accepts the listed code %s', (code) => {
      expect(isSignupSourceCode(code)).toBe(true);
    });

    it('lists only codes that match the stored pattern', () => {
      for (const code of SIGNUP_SOURCE_CODES) {
        expect(code).toMatch(/^[a-z0-9-]{2,32}$/);
      }
    });

    it.each([
      ['an unlisted code', 'newsletter'],
      ['upper case', 'Flyer'],
      ['surrounding space', ' flyer'],
      ['one character', 'q'],
      ['too long', 'a'.repeat(33)],
      ['a campaign-style tag', 'utm_source=flyer'],
      ['an empty string', ''],
      ['null', null],
      ['a number', 42],
      ['an object', { src: 'flyer' }],
      ['an inherited name', 'constructor'],
    ])('rejects %s', (_label, value) => {
      expect(isSignupSourceCode(value)).toBe(false);
    });
  });

  describe('parseSignupSource', () => {
    it('keeps an allow-listed code and a web entry', () => {
      expect(parseSignupSource({ src: 'qr', entry: 'app' })).toEqual({ src: 'qr', entry: 'app' });
    });

    it.each([...SIGNUP_ENTRIES])('accepts the web entry %s with no code', (entry) => {
      expect(parseSignupSource({ src: null, entry })).toEqual({ src: null, entry });
    });

    it('stores an unknown or malformed code as no code, keeping the entry', () => {
      expect(parseSignupSource({ src: 'billboard', entry: 'job_link' })).toEqual({ src: null, entry: 'job_link' });
      expect(parseSignupSource({ src: 'FLYER', entry: 'signup_page' })).toEqual({ src: null, entry: 'signup_page' });
      expect(parseSignupSource({ entry: 'app' })).toEqual({ src: null, entry: 'app' });
    });

    it.each([
      ['nothing', undefined],
      ['null', null],
      ['a string', 'flyer'],
      ['an array', ['flyer', 'app']],
      ['no entry', { src: 'flyer' }],
      ['an unknown entry', { src: 'flyer', entry: 'email' }],
      ['the WhatsApp entry (no web caller sends it)', { src: null, entry: 'whatsapp' }],
      ['a non-string entry', { src: 'flyer', entry: 1 }],
    ])('drops %s', (_label, value) => {
      expect(parseSignupSource(value)).toBeNull();
    });
  });
});
