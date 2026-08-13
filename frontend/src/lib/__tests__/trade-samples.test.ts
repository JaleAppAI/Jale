import { describe, expect, it } from 'vitest';
import samples from '@/data/trade-samples.json';
import { getTradeSample, hasTradeSample } from '@/lib/trade-samples';

/**
 * The 7 trades that ship an O*NET-grounded sample description -- every
 * `TRADE_CATEGORIES` entry (`lib/job-form.ts`) except `other`, which has no
 * single SOC code to ground a sample against and which the backend rejects
 * outright for AI generation (`unsupported_trade_category`).
 */
const EXPECTED_TRADES = [
  'electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'drywall', 'general_labor',
] as const;

type SampleTrade = typeof EXPECTED_TRADES[number];
type TradeSampleEntry = { sample_en: string; sample_es: string };
type SamplesFile = Record<SampleTrade, TradeSampleEntry> & {
  _meta: { source: string; soc_codes: Record<string, string>; retrieved: string };
};

const data = samples as unknown as SamplesFile;

describe('trade-samples.json structure', () => {
  it('has exactly the 7 trade keys (plus _meta) and no `other` entry', () => {
    const keys = Object.keys(data).filter((key) => key !== '_meta');
    expect(keys.sort()).toEqual([...EXPECTED_TRADES].sort());
    expect(keys).not.toContain('other');
  });

  it('has a non-empty sample_en and sample_es for every trade', () => {
    for (const trade of EXPECTED_TRADES) {
      const entry = data[trade];
      expect(entry).toBeTruthy();
      expect(typeof entry.sample_en).toBe('string');
      expect(entry.sample_en.trim().length).toBeGreaterThan(0);
      expect(typeof entry.sample_es).toBe('string');
      expect(entry.sample_es.trim().length).toBeGreaterThan(0);
    }
  });

  it('records an O*NET _meta block with a SOC code for every trade', () => {
    expect(data._meta.source).toBe('O*NET');
    expect(Object.keys(data._meta.soc_codes).sort()).toEqual([...EXPECTED_TRADES].sort());
    for (const trade of EXPECTED_TRADES) {
      expect(typeof data._meta.soc_codes[trade]).toBe('string');
      expect(data._meta.soc_codes[trade].length).toBeGreaterThan(0);
    }
    expect(typeof data._meta.retrieved).toBe('string');
  });
});

describe('hasTradeSample', () => {
  it('returns true for each of the 7 sampled trades', () => {
    for (const trade of EXPECTED_TRADES) expect(hasTradeSample(trade)).toBe(true);
  });

  it('returns false for `other`, an unset trade, and an unknown string', () => {
    expect(hasTradeSample('other')).toBe(false);
    expect(hasTradeSample('')).toBe(false);
    expect(hasTradeSample('roofer')).toBe(false);
    // The JSON's own bookkeeping key must never read as a trade.
    expect(hasTradeSample('_meta')).toBe(false);
  });
});

describe('getTradeSample', () => {
  it('returns the English sample text for locale "en"', () => {
    expect(getTradeSample('electrician', 'en')).toBe(data.electrician.sample_en);
    expect(getTradeSample('drywall', 'en')).toBe(data.drywall.sample_en);
  });

  it('returns the Spanish sample text for locale "es"', () => {
    expect(getTradeSample('electrician', 'es')).toBe(data.electrician.sample_es);
    expect(getTradeSample('general_labor', 'es')).toBe(data.general_labor.sample_es);
  });

  it('returns null for `other`, an unset trade, and any locale other than "es"', () => {
    expect(getTradeSample('other', 'en')).toBeNull();
    expect(getTradeSample('', 'es')).toBeNull();
    // Only "es" gets the Spanish text; anything else (including an unknown
    // locale code) falls back to English rather than throwing.
    expect(getTradeSample('electrician', 'fr')).toBe(data.electrician.sample_en);
  });
});
