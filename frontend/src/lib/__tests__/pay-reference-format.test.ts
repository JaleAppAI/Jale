import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { formatPayReference, type PayReferencePayload } from '../pay-reference-format';
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
  it('builds an English headline with the rounded range, median, trade label and area (employer variant)', () => {
    const { headline } = formatPayReference(metroPayload, tEn, 'Electricians');
    expect(headline).toBe(
      'Starting point: Electricians in Austin typically earn $24–$36/hr (median $28)',
    );
  });

  it('builds the equivalent Spanish headline with localized copy', () => {
    const { headline } = formatPayReference(metroPayload, tEs, 'Electricistas');
    expect(headline).toBe(
      'Punto de partida: Electricistas en Austin generalmente ganan $24–$36/hora (mediana $28)',
    );
  });

  it('rounds every fractional-dollar figure to a whole dollar', () => {
    const { headline } = formatPayReference(metroPayload, tEn, 'Electricians');
    expect(headline).toContain('$24–$36');
    expect(headline).toContain('(median $28)');
  });

  it('uses the state area_label verbatim -- no special-cased "state of X" wording', () => {
    const statePayload: PayReferencePayload = {
      ...metroPayload,
      area_kind: 'state',
      area_label: 'Texas',
    };
    const { headline } = formatPayReference(statePayload, tEn, 'Electricians');
    expect(headline).toContain('in Texas');
    expect(headline).not.toContain('state of');
  });

  it('nonmetro area_kind renders through the same "in {area}" phrasing as metro', () => {
    const nonmetroPayload: PayReferencePayload = {
      ...metroPayload,
      area_kind: 'nonmetro',
      area_label: 'Rural Texas',
    };
    const { headline } = formatPayReference(nonmetroPayload, tEn, 'Electricians');
    expect(headline).toContain('in Rural Texas');
  });

  it('formats the BLS attribution line with the data vintage, in both locales', () => {
    expect(formatPayReference(metroPayload, tEn, 'Electricians').source).toBe(
      'Source: U.S. Bureau of Labor Statistics, OEWS, 2024',
    );
    expect(formatPayReference(metroPayload, tEs, 'Electricistas').source).toBe(
      'Fuente: Oficina de Estadísticas Laborales de EE. UU. (BLS), OEWS, 2024',
    );
  });

  it('switches the lead-in per variant while the range/median/source stay identical', () => {
    const employer = formatPayReference(metroPayload, tEn, 'Electricians', 'employer');
    const workerProfile = formatPayReference(metroPayload, tEn, 'Electricians', 'worker-profile');
    const workerJob = formatPayReference(metroPayload, tEn, 'Electricians', 'worker-job');

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
    const { headline } = formatPayReference(metroPayload, tEn, 'Electricians');
    expect(headline.startsWith('Starting point:')).toBe(true);
  });
});
