import { describe, expect, it } from 'vitest';
import type { ApplicationHire } from '@/lib/api/worker';
import {
  durationLabel,
  hireTradeLabel,
  scheduleSummary,
  shiftHoursLabel,
  tradeLabel,
  workDayChips,
  type HireTradeFields,
  type ScheduleFields,
  type Translator,
} from '../job-detail-display';

// Identity-ish fake translator: returns the key path (plus interpolated
// values inline) so assertions can check exactly which key/values were
// requested without wiring next-intl into a lib test. Matches the
// `fakeT` convention already used in format-application-answers.test.ts.
const fakeT: Translator = (key, values) =>
  (values ? `${key}(${JSON.stringify(values)})` : key);

describe('tradeLabel', () => {
  it('returns null when there is no trade at all', () => {
    expect(tradeLabel({ trade_category: null }, fakeT, fakeT)).toBeNull();
    expect(tradeLabel({ trade_category: undefined }, fakeT, fakeT)).toBeNull();
    expect(tradeLabel({ trade_category: '' }, fakeT, fakeT)).toBeNull();
  });

  it('resolves a known trade via the trade translator, by slug', () => {
    expect(tradeLabel({ trade_category: 'electrician' }, fakeT, fakeT)).toBe('electrician');
    expect(tradeLabel({ trade_category: 'drywall' }, fakeT, fakeT)).toBe('drywall');
  });

  it('"other" with custom text uses trade_with_other on the detail translator', () => {
    expect(
      tradeLabel({ trade_category: 'other', trade_category_other: 'Welder' }, fakeT, fakeT),
    ).toBe('trade_with_other({"other":"Welder"})');
  });

  it('"other" without text (absent, empty, or whitespace) falls back to the base "other" label', () => {
    expect(tradeLabel({ trade_category: 'other', trade_category_other: null }, fakeT, fakeT)).toBe('other');
    expect(tradeLabel({ trade_category: 'other', trade_category_other: '' }, fakeT, fakeT)).toBe('other');
    expect(tradeLabel({ trade_category: 'other', trade_category_other: '   ' }, fakeT, fakeT)).toBe('other');
    expect(tradeLabel({ trade_category: 'other' }, fakeT, fakeT)).toBe('other');
  });
});

describe('hireTradeLabel', () => {
  /**
   * The API contract, pinned by `tsc` rather than by a comment: the endpoint
   * hands the frontend an `ApplicationHire`, and this formatter's structural
   * param type must accept its `trade` field. `job-detail-display.ts`
   * deliberately imports nothing (see its header), so this is the assertion
   * that keeps the local type and the wire type from drifting apart.
   */
  it('accepts the API `ApplicationHire.trade` shape', () => {
    const fromApi: HireTradeFields = {} as Pick<ApplicationHire, 'trade'>;
    expect(hireTradeLabel(fromApi, 'es', fakeT)).toBeNull();
  });

  /** A `trade` object as the endpoint builds it. */
  function trade(over: Partial<NonNullable<HireTradeFields['trade']>> = {}): HireTradeFields {
    return {
      trade: {
        category: 'electrician', other: null, canonical_en: null, canonical_es: null, ...over,
      },
    };
  }

  it('resolves a standard 023 category through the translator, by slug, in both locales', () => {
    for (const locale of ['es', 'en']) {
      for (const category of [
        'electrician', 'plumber', 'carpenter', 'concrete',
        'painting', 'drywall', 'general_labor',
      ]) {
        expect(hireTradeLabel(trade({ category }), locale, fakeT)).toBe(category);
      }
    }
  });

  it('ignores the canonicals for a standard category -- the catalogue is the source', () => {
    // A stale canonical pair on an enum row must never beat the translated
    // label: the catalogue is the only thing that follows the reader's locale.
    expect(hireTradeLabel(
      trade({ category: 'drywall', canonical_en: 'Drywaller', canonical_es: 'Tablaroquero' }),
      'es', fakeT,
    )).toBe('drywall');
  });

  it("'other' prefers canonical_es in Spanish and canonical_en otherwise", () => {
    const other = trade({
      category: 'other', other: 'Welder', canonical_en: 'Welder', canonical_es: 'Soldador',
    });
    expect(hireTradeLabel(other, 'es', fakeT)).toBe('Soldador');
    expect(hireTradeLabel(other, 'en', fakeT)).toBe('Welder');
    // Anything the module's own LOCALE_TAGS does not know falls back to
    // English -- the same answer `shiftHoursLabel` gives for the same input,
    // which is the point of routing this through `tagFor` instead of a bare
    // `locale === 'es'`. Unreachable in the app either way: `i18n/locales.ts`
    // declares exactly ['en','es'] and `i18n/request.ts` coerces anything
    // else to 'en', so a bare tag is all a formatter ever sees.
    expect(hireTradeLabel(other, 'pt', fakeT)).toBe('Welder');
    expect(hireTradeLabel(other, 'es-MX', fakeT)).toBe('Welder');
    expect(hireTradeLabel(other, '', fakeT)).toBe('Welder');
  });

  it("'other' falls back to the employer's own words when the cache said nothing", () => {
    // The canonicalisation pass fails OPEN, so this is the shape a cache
    // miss, a lookup error, or a frontend running ahead of the backend all
    // produce.
    const raw = trade({ category: 'other', other: '  Rope access tech  ' });
    expect(hireTradeLabel(raw, 'es', fakeT)).toBe('Rope access tech');
    expect(hireTradeLabel(raw, 'en', fakeT)).toBe('Rope access tech');
  });

  it("'other' with nothing at all is null, NOT the translated 'other' label", () => {
    // Unlike `tradeLabel`, which prints tTrade('other') for a job row. Here
    // the label lands inside a sentence -- "...te contrato como Otro" says
    // nothing, so the caller is told to drop the clause instead.
    for (const blank of [null, '', '   ']) {
      expect(hireTradeLabel(trade({ category: 'other', other: blank }), 'es', fakeT)).toBeNull();
      expect(hireTradeLabel(trade({ category: 'other', other: blank }), 'en', fakeT)).toBeNull();
    }
  });

  it('is null when the trade object is absent, null, or states no category', () => {
    for (const locale of ['es', 'en']) {
      expect(hireTradeLabel({}, locale, fakeT)).toBeNull();
      expect(hireTradeLabel({ trade: null }, locale, fakeT)).toBeNull();
      expect(hireTradeLabel({ trade: undefined }, locale, fakeT)).toBeNull();
      for (const blank of [null, '', '   ']) {
        expect(hireTradeLabel(trade({ category: blank }), locale, fakeT)).toBeNull();
      }
    }
  });

  it('echoes an unrecognized category through the translator, without an enum check', () => {
    // Same doctrine as `tradeLabel`: enum membership is the calling page's
    // catalogue's concern, not this pure formatter's.
    expect(hireTradeLabel(trade({ category: 'roofing' }), 'es', fakeT)).toBe('roofing');
  });
});

describe('durationLabel', () => {
  it('legacy-only job: returns the raw expected_duration string, trimmed', () => {
    const job: ScheduleFields = { expected_duration: '  2 weeks  ' };
    expect(durationLabel(job, fakeT)).toBe('2 weeks');
  });

  it('returns null when neither bucket nor legacy duration is present', () => {
    expect(durationLabel({}, fakeT)).toBeNull();
    expect(durationLabel({ expected_duration: '   ' }, fakeT)).toBeNull();
  });

  it('bucket wins over a raw legacy string when both are present', () => {
    const job: ScheduleFields = { expected_duration: '2 weeks', expected_duration_bucket: 'short_term' };
    expect(durationLabel(job, fakeT)).toBe('duration_bucket.short_term');
  });
});

describe('workDayChips', () => {
  it('returns [] when work_days is absent or empty', () => {
    expect(workDayChips({}, fakeT)).toEqual([]);
    expect(workDayChips({ work_days: [] }, fakeT)).toEqual([]);
  });

  it('preserves canonical mon..sun order regardless of input order', () => {
    const job: ScheduleFields = { work_days: ['fri', 'mon', 'wed'] };
    expect(workDayChips(job, fakeT)).toEqual(['work_days.mon', 'work_days.wed', 'work_days.fri']);
  });

  it('covers the full week in order', () => {
    const job: ScheduleFields = { work_days: ['sun', 'sat', 'tue', 'thu'] };
    expect(workDayChips(job, fakeT)).toEqual([
      'work_days.tue', 'work_days.thu', 'work_days.sat', 'work_days.sun',
    ]);
  });
});

describe('shiftHoursLabel', () => {
  it('en: formats a same-day 12h range', () => {
    const job: ScheduleFields = { shift_start: '07:00', shift_end: '16:00' };
    expect(shiftHoursLabel(job, 'en')).toMatch(/7:00\s?AM – 4:00\s?PM/);
  });

  it('es: produces a different, locale-appropriate string', () => {
    const job: ScheduleFields = { shift_start: '07:00', shift_end: '16:00' };
    const en = shiftHoursLabel(job, 'en');
    const es = shiftHoursLabel(job, 'es');
    expect(es).not.toBeNull();
    expect(es).not.toBe(en);
  });

  it('returns null when only one side of the shift is present', () => {
    expect(shiftHoursLabel({ shift_start: '07:00' }, 'en')).toBeNull();
    expect(shiftHoursLabel({ shift_end: '16:00' }, 'en')).toBeNull();
  });

  it('returns null when neither side is present', () => {
    expect(shiftHoursLabel({}, 'en')).toBeNull();
  });

  it('tolerates HH:MM:SS -- the wire shape of a Postgres TIME column (no custom pg type parser is registered in this repo, per lib/pay-reference.ts)', () => {
    const job: ScheduleFields = { shift_start: '07:00:00', shift_end: '16:00:00' };
    expect(shiftHoursLabel(job, 'en')).toMatch(/7:00\s?AM – 4:00\s?PM/);
  });
});

describe('scheduleSummary', () => {
  it('legacy-only job: days [], hours null, legacy set from shift_schedule', () => {
    const job: ScheduleFields = { shift_schedule: '  Mon-Fri 8am-4pm  ' };
    expect(scheduleSummary(job, 'en', fakeT)).toEqual({
      days: [],
      hours: null,
      legacy: 'Mon-Fri 8am-4pm',
    });
  });

  it('structured days present: legacy is suppressed even though shift_schedule is also set', () => {
    const job: ScheduleFields = { work_days: ['mon', 'tue'], shift_schedule: 'legacy text' };
    const result = scheduleSummary(job, 'en', fakeT);
    expect(result.days).toEqual(['work_days.mon', 'work_days.tue']);
    expect(result.legacy).toBeNull();
  });

  it('structured one-sided shift present: legacy suppressed, hours null', () => {
    const job: ScheduleFields = { shift_start: '07:00', shift_schedule: 'legacy text' };
    const result = scheduleSummary(job, 'en', fakeT);
    expect(result.hours).toBeNull();
    expect(result.legacy).toBeNull();
  });

  it('full structured schedule: days and hours both populated, legacy null', () => {
    const job: ScheduleFields = {
      work_days: ['mon', 'wed', 'fri'],
      shift_start: '07:00',
      shift_end: '16:00',
      shift_schedule: 'legacy text',
    };
    const result = scheduleSummary(job, 'en', fakeT);
    expect(result.days).toEqual(['work_days.mon', 'work_days.wed', 'work_days.fri']);
    expect(result.hours).toMatch(/7:00\s?AM – 4:00\s?PM/);
    expect(result.legacy).toBeNull();
  });

  it('nothing at all: everything null/empty', () => {
    expect(scheduleSummary({}, 'en', fakeT)).toEqual({ days: [], hours: null, legacy: null });
  });

  it('a blank shift_start ("") does not count as structured data present', () => {
    const job: ScheduleFields = { shift_start: '', shift_schedule: 'Mon-Fri 8-4' };
    expect(scheduleSummary(job, 'en', fakeT)).toEqual({ days: [], hours: null, legacy: 'Mon-Fri 8-4' });
  });
});
