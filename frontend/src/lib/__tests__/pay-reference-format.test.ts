import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import {
  formatPayReference,
  isFetchableTradeCategory,
  type PayReferencePayload,
} from '../pay-reference-format';
import type { PayTranslator } from '../pay';

// Real message catalogues, real next-intl translator -- same convention as
// `pay.test.ts` -- so this exercises the actual `pay.reference_*` keys
// shipped to users in both locales, not a hand-rolled stand-in.
function payTranslator(locale: 'en' | 'es'): PayTranslator {
  const messages = locale === 'en' ? en : es;
  const t = createTranslator({ locale, messages, namespace: 'pay' });
  return (key, values) => t(key as Parameters<typeof t>[0], values);
}

const tEn = payTranslator('en');
const tEs = payTranslator('es');

// The REAL trade label a caller passes -- `employer_dashboard.modal.trade.*`
// (see `PayReferenceHint`), i.e. the same catalogue that feeds the trade
// dropdowns and is never pluralized. Sourcing labels from here (rather than
// hand-typing "Electricians"/"Electricistas", which do not exist anywhere in
// the real catalogue) is what makes this suite catch a subject-verb
// agreement regression -- a template built around a singular label like
// "Electrician" or "Concrete" breaks visibly if it assumes a plural noun.
function tradeLabel(locale: 'en' | 'es', trade: string): string {
  const messages = locale === 'en' ? en : es;
  const t = createTranslator({ locale, messages, namespace: 'employer_dashboard' });
  return t(`modal.trade.${trade}` as Parameters<typeof t>[0]);
}

const electricianEn = tradeLabel('en', 'electrician'); // "Electrician" (singular)
const electricianEs = tradeLabel('es', 'electrician'); // "Electricista" (singular)
const concreteEn = tradeLabel('en', 'concrete'); // "Concrete" -- not a person at all

// Seed-shaped payload: cents on every figure, so rounding is exercised by
// every test rather than only a dedicated one.
const metroPayload: PayReferencePayload = {
  trade_category: 'electrician',
  p25_hourly: 24.37,
  p50_hourly: 28.44,
  p75_hourly: 36.12,
  area_kind: 'metro',
  area_label: 'Austin',
  source_tier: 'metro',
  data_vintage: '2024',
};

describe('formatPayReference', () => {
  it('builds an English headline, grammatical with the real singular catalog label (employer variant)', () => {
    const { headline } = formatPayReference(metroPayload, tEn, electricianEn);
    expect(headline).toBe(
      'Starting point: Typical pay for Electrician in Austin: $24–$36/hr (median $28)',
    );
  });

  it('builds the equivalent Spanish headline, grammatical with the real singular catalog label', () => {
    const { headline } = formatPayReference(metroPayload, tEs, electricianEs);
    expect(headline).toBe(
      'Punto de partida: Pago típico para Electricista en Austin: $24–$36/hora (mediana $28)',
    );
  });

  it('reads correctly for a non-person (material) trade label too -- no verb agreement to break', () => {
    const concretePayload: PayReferencePayload = { ...metroPayload, trade_category: 'concrete' };
    const { headline } = formatPayReference(concretePayload, tEn, concreteEn);
    expect(headline).toBe(
      'Starting point: Typical pay for Concrete in Austin: $24–$36/hr (median $28)',
    );
  });

  it('rounds every fractional-dollar figure down to the nearest whole dollar', () => {
    const { headline } = formatPayReference(metroPayload, tEn, electricianEn);
    expect(headline).toContain('$24–$36');
    expect(headline).toContain('(median $28)');
  });

  it('rounds a figure UP when the cents push it over the next whole dollar', () => {
    const roundUpPayload: PayReferencePayload = {
      ...metroPayload,
      p25_hourly: 22.97,
      p50_hourly: 22.97,
      p75_hourly: 22.97,
    };
    const { headline } = formatPayReference(roundUpPayload, tEn, electricianEn);
    expect(headline).toContain('$23–$23');
    expect(headline).toContain('(median $23)');
  });

  it('uses the state area_label verbatim -- no special-cased "state of X" wording', () => {
    const statePayload: PayReferencePayload = {
      ...metroPayload,
      area_kind: 'state',
      area_label: 'Texas',
    };
    const { headline } = formatPayReference(statePayload, tEn, electricianEn);
    expect(headline).toContain('in Texas');
    expect(headline).not.toContain('state of');
  });

  it('nonmetro area_kind renders through the same "in {area}" phrasing as metro', () => {
    const nonmetroPayload: PayReferencePayload = {
      ...metroPayload,
      area_kind: 'nonmetro',
      area_label: 'Rural Texas',
    };
    const { headline } = formatPayReference(nonmetroPayload, tEn, electricianEn);
    expect(headline).toContain('in Rural Texas');
  });

  it('formats the BLS attribution line with the data vintage, in both locales', () => {
    expect(formatPayReference(metroPayload, tEn, electricianEn).source).toBe(
      'Source: U.S. Bureau of Labor Statistics, OEWS, 2024',
    );
    expect(formatPayReference(metroPayload, tEs, electricianEs).source).toBe(
      'Fuente: Oficina de Estadísticas Laborales de EE. UU. (BLS), OEWS, 2024',
    );
  });

  it('switches the lead-in per variant while the range/median/source stay identical', () => {
    const employer = formatPayReference(metroPayload, tEn, electricianEn, 'employer');
    const workerProfile = formatPayReference(metroPayload, tEn, electricianEn, 'worker-profile');
    const workerJob = formatPayReference(metroPayload, tEn, electricianEn, 'worker-job');

    expect(employer.headline.startsWith('Starting point:')).toBe(true);
    expect(workerProfile.headline.startsWith('Typical pay for your trade:')).toBe(true);
    expect(workerJob.headline.startsWith('For comparison:')).toBe(true);

    // Same underlying figures regardless of variant.
    for (const result of [employer, workerProfile, workerJob]) {
      expect(result.headline).toContain('$24–$36');
      expect(result.headline).toContain('(median $28)');
    }
  });

  it('defaults to the employer variant when none is given', () => {
    const { headline } = formatPayReference(metroPayload, tEn, electricianEn);
    expect(headline.startsWith('Starting point:')).toBe(true);
  });
});

describe('isFetchableTradeCategory', () => {
  it('accepts every real trade_category except "other"', () => {
    expect(isFetchableTradeCategory('electrician')).toBe(true);
    expect(isFetchableTradeCategory('plumber')).toBe(true);
    expect(isFetchableTradeCategory('carpenter')).toBe(true);
    expect(isFetchableTradeCategory('concrete')).toBe(true);
    expect(isFetchableTradeCategory('painting')).toBe(true);
    expect(isFetchableTradeCategory('drywall')).toBe(true);
    expect(isFetchableTradeCategory('general_labor')).toBe(true);
  });

  it('rejects "other" -- a valid trade_category with no reference row (guaranteed 404)', () => {
    expect(isFetchableTradeCategory('other')).toBe(false);
  });

  it('rejects an empty string (no trade picked yet)', () => {
    expect(isFetchableTradeCategory('')).toBe(false);
  });

  it('rejects a value outside the trade_category enum', () => {
    expect(isFetchableTradeCategory('welding')).toBe(false);
  });
});
