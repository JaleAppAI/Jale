import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { formatPay, PAY_UNSPECIFIED, type PayFields, type PayTranslator } from '../pay';

// Real message catalogues, real next-intl translator -- this exercises the
// actual `pay.*` keys shipped to users in both locales, not a hand-rolled
// stand-in that could silently drift from them. Wrapped to the PayTranslator
// shape because next-intl's Translator narrows `key` to a literal union,
// which is not assignable to PayTranslator's `(key: string) => string`
// (contravariance); the wrapper keeps the real catalog lookup intact.
function payTranslator(locale: 'en' | 'es'): PayTranslator {
  const messages = locale === 'en' ? en : es;
  const t = createTranslator({ locale, messages, namespace: 'pay' });
  return (key, values) => t(key as Parameters<typeof t>[0], values);
}

const tEn = payTranslator('en');
const tEs = payTranslator('es');

describe('formatPay', () => {
  describe('min only', () => {
    const job: PayFields = { pay_min: 15, pay_max: null, pay_interval: null };

    it('en -> "From $15"', () => {
      expect(formatPay(job, tEn)).toBe('From $15');
    });

    it('es -> "Desde $15"', () => {
      expect(formatPay(job, tEs)).toBe('Desde $15');
    });
  });

  describe('max only', () => {
    const job: PayFields = { pay_min: null, pay_max: 20, pay_interval: null };

    it('en -> "Up to $20"', () => {
      expect(formatPay(job, tEn)).toBe('Up to $20');
    });

    it('es -> "Hasta $20"', () => {
      expect(formatPay(job, tEs)).toBe('Hasta $20');
    });
  });

  describe('both min and max', () => {
    const job: PayFields = { pay_min: 15, pay_max: 20, pay_interval: null };

    it('en -> "$15–$20"', () => {
      expect(formatPay(job, tEn)).toBe('$15–$20');
    });

    it('es -> "$15–$20" (the figures themselves are not translated)', () => {
      expect(formatPay(job, tEs)).toBe('$15–$20');
    });
  });

  describe('fractional amounts', () => {
    it('renders cents when the amount is not a whole dollar', () => {
      const job: PayFields = { pay_min: 15.5, pay_max: null, pay_interval: null };
      expect(formatPay(job, tEn)).toBe('From $15.50');
    });

    it('rounds to cents rather than showing floating-point noise', () => {
      const job: PayFields = { pay_min: 15.005, pay_max: null, pay_interval: null };
      expect(formatPay(job, tEn)).toBe('From $15.01');
    });
  });

  describe('recurring interval suffixes', () => {
    it.each([
      ['hourly', 'hr', 'hora'],
      ['daily', 'day', 'día'],
      ['weekly', 'wk', 'semana'],
      ['monthly', 'mo', 'mes'],
    ] as const)('%s -> "/%s" (en) / "/%s" (es)', (interval, enUnit, esUnit) => {
      const job: PayFields = { pay_min: 15, pay_max: 20, pay_interval: interval };
      expect(formatPay(job, tEn)).toBe(`$15–$20/${enUnit}`);
      expect(formatPay(job, tEs)).toBe(`$15–$20/${esUnit}`);
    });

    it('applies the suffix to a min-only figure too', () => {
      const job: PayFields = { pay_min: 15, pay_max: null, pay_interval: 'hourly' };
      expect(formatPay(job, tEn)).toBe('From $15/hr');
    });
  });

  describe('fixed interval', () => {
    it('en -> "(fixed)" appended, not slash-suffixed', () => {
      const job: PayFields = { pay_min: 500, pay_max: null, pay_interval: 'fixed' };
      expect(formatPay(job, tEn)).toBe('From $500 (fixed)');
    });

    it('es -> "(fijo)"', () => {
      const job: PayFields = { pay_min: 500, pay_max: null, pay_interval: 'fixed' };
      expect(formatPay(job, tEs)).toBe('Desde $500 (fijo)');
    });
  });

  describe('unmapped/unknown interval', () => {
    it('is treated as no interval at all (no suffix)', () => {
      const job: PayFields = { pay_min: 15, pay_max: null, pay_interval: 'biweekly' };
      expect(formatPay(job, tEn)).toBe('From $15');
    });
  });

  describe('no structured pay at all', () => {
    it('falls back to the legacy `pay` string when present', () => {
      const job: PayFields = { pay: 'From $15', pay_min: null, pay_max: null, pay_interval: null };
      expect(formatPay(job, tEn)).toBe('From $15');
      expect(formatPay(job, tEs)).toBe('From $15');
    });

    it('treats the API "not specified" sentinel the same as absent', () => {
      const job: PayFields = { pay: PAY_UNSPECIFIED, pay_min: null, pay_max: null, pay_interval: null };
      expect(formatPay(job, tEn)).toBeNull();
    });

    it('returns null when pay is entirely absent, so callers keep hiding the row', () => {
      const job: PayFields = { pay_min: null, pay_max: null, pay_interval: null };
      expect(formatPay(job, tEn)).toBeNull();
    });

    it('returns null when every field is undefined', () => {
      expect(formatPay({}, tEn)).toBeNull();
    });
  });
});
