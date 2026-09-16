import { describe, expect, it } from 'vitest';
import type { ApplicationHire } from '@/lib/api/worker';
import type { Job as EmployerJob } from '@/lib/api/employer';
import type { JobDetail as WorkerJobDetail } from '@/lib/api/worker';
import type { PublicJobActive } from '@/lib/api/publicJob';
import {
  durationLabel,
  experienceLabel,
  hireTradeLabel,
  hireTradePhrase,
  scheduleSummary,
  shiftHoursLabel,
  tradeLabel,
  workDayChips,
  type ExperienceFields,
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

describe('hireTradePhrase', () => {
  /**
   * A stand-in for `employer_dashboard.modal.trade.*`, which carries
   * CAPITALISED labels ("Electrician", "Ayudante general") because a
   * standalone tile is where they are normally read. That capital is the
   * entire reason this function exists, so `fakeT` (which echoes an
   * already-lowercase slug) cannot see the behaviour under test.
   */
  const CATALOGUE: Record<string, Record<string, string>> = {
    en: { electrician: 'Electrician', general_labor: 'General labor', drywall: 'Drywall' },
    es: { electrician: 'Electricista', general_labor: 'Ayudante general', drywall: 'Drywall' },
  };
  const catalogueT = (locale: string): Translator => (key) => CATALOGUE[locale]?.[key] ?? key;

  /** A `trade` object as the endpoint builds it. */
  function trade(over: Partial<NonNullable<HireTradeFields['trade']>> = {}): HireTradeFields {
    return {
      trade: {
        category: 'electrician', other: null, canonical_en: null, canonical_es: null, ...over,
      },
    };
  }

  /** Same `tsc` pin as `hireTradeLabel`'s: the wire type must satisfy the param. */
  it('accepts the API `ApplicationHire.trade` shape', () => {
    const fromApi: HireTradeFields = {} as Pick<ApplicationHire, 'trade'>;
    expect(hireTradePhrase(fromApi, 'es', fakeT)).toBeNull();
  });

  it('lower-cases the FIRST character of a catalogue label, in both locales', () => {
    expect(hireTradePhrase(trade({ category: 'electrician' }), 'en', catalogueT('en')))
      .toBe('electrician');
    expect(hireTradePhrase(trade({ category: 'electrician' }), 'es', catalogueT('es')))
      .toBe('electricista');
  });

  it('lower-cases ONLY the first character -- the rest of the label is left alone', () => {
    // "Ayudante general" must not become "ayudante General", and a label whose
    // remainder is already lowercase must survive intact.
    expect(hireTradePhrase(trade({ category: 'general_labor' }), 'en', catalogueT('en')))
      .toBe('general labor');
    expect(hireTradePhrase(trade({ category: 'general_labor' }), 'es', catalogueT('es')))
      .toBe('ayudante general');
    expect(hireTradePhrase(trade({ category: 'drywall' }), 'es', catalogueT('es')))
      .toBe('drywall');
  });

  it("'other' lower-cases the canonical for the reader's locale", () => {
    const other = trade({
      category: 'other', other: 'welder', canonical_en: 'Welder', canonical_es: 'Soldador',
    });
    expect(hireTradePhrase(other, 'es', fakeT)).toBe('soldador');
    expect(hireTradePhrase(other, 'en', fakeT)).toBe('welder');
  });

  it('lower-cases a non-ASCII leading capital too', () => {
    // `toLocaleLowerCase` rather than `toLowerCase`, so the fold follows the
    // tag's language and an accented Spanish canonical is still readable
    // mid-sentence.
    expect(hireTradePhrase(
      trade({ category: 'other', canonical_es: 'Óxido especialista' }), 'es', fakeT,
    )).toBe('óxido especialista');
  });

  it('sends a regional tag down the same English path every other formatter here does', () => {
    // `tagFor('es-MX')` is 'en-US' (LOCALE_TAGS knows only 'es'/'en'), which is
    // exactly what `hireTradeLabel` already answers for the same input -- see
    // its "'other' prefers canonical_es in Spanish" test. Making this one
    // Spanish-aware would contradict that pin, in a module whose whole point
    // is that the two agree.
    const other = trade({
      category: 'other', other: 'welder', canonical_en: 'Welder', canonical_es: 'Soldador',
    });
    expect(hireTradePhrase(other, 'es-MX', fakeT)).toBe('welder');
    expect(hireTradePhrase(other, 'pt', fakeT)).toBe('welder');
    expect(hireTradePhrase(other, '', fakeT)).toBe('welder');
  });

  it("returns the employer's OWN words verbatim, capitals intact", () => {
    // The catalogue and the alias cache are OUR words, written the way a
    // standalone label is written; free text is the employer's. "HVAC tech"
    // lower-cased reads as a typo, and "Tile setter helper" is a proper name
    // as far as this module is concerned.
    for (const locale of ['en', 'es', 'es-MX']) {
      expect(hireTradePhrase(
        trade({ category: 'other', other: '  Tile setter helper  ' }), locale, fakeT,
      )).toBe('Tile setter helper');
      expect(hireTradePhrase(
        trade({ category: 'other', other: 'HVAC tech' }), locale, fakeT,
      )).toBe('HVAC tech');
    }
  });

  it('a canonical BEATS the free text, and is lower-cased like any label of ours', () => {
    expect(hireTradePhrase(
      trade({ category: 'other', other: 'tile guy', canonical_en: 'Tile setter' }), 'en', fakeT,
    )).toBe('tile setter');
  });

  it('leaves an acronym-led canonical alone rather than producing "hVAC"', () => {
    // The fold undoes a sentence-style capital, and a label whose second
    // character is ALSO upper-case has none to undo. The seeded
    // `trade_aliases` canonicals are Title Case, but the cache also grows at
    // runtime and the live rows are not verified from here, so the guard is
    // cheap insurance rather than a fix for a known row.
    expect(hireTradePhrase(
      trade({ category: 'other', other: 'HVAC tech', canonical_en: 'HVAC technician' }),
      'en', fakeT,
    )).toBe('HVAC technician');
    expect(hireTradePhrase(
      trade({ category: 'other', other: 'aire', canonical_es: 'HVAC' }), 'es', fakeT,
    )).toBe('HVAC');
    // A one-character label has no second character to consult and still folds.
    expect(hireTradePhrase(
      trade({ category: 'other', other: 'x', canonical_en: 'X' }), 'en', fakeT,
    )).toBe('x');
  });

  it('is null in every case `hireTradeLabel` is null', () => {
    const nulls: HireTradeFields[] = [
      {},
      { trade: null },
      { trade: undefined },
      trade({ category: null }),
      trade({ category: '' }),
      trade({ category: '   ' }),
      trade({ category: 'other', other: null }),
      trade({ category: 'other', other: '' }),
      trade({ category: 'other', other: '   ' }),
    ];
    for (const locale of ['en', 'es']) {
      for (const hire of nulls) {
        expect(hireTradeLabel(hire, locale, fakeT)).toBeNull();
        expect(hireTradePhrase(hire, locale, fakeT)).toBeNull();
      }
    }
  });

  it('echoes an unrecognized category through the translator, same as `hireTradeLabel`', () => {
    expect(hireTradePhrase(trade({ category: 'roofing' }), 'es', fakeT)).toBe('roofing');
  });

  it('differs from `hireTradeLabel` in the leading capital and NOTHING else', () => {
    // The shared resolution step is what guarantees this: if the two ever pick
    // different SOURCES for the same hire, this comparison is where it shows.
    const cases: HireTradeFields[] = [
      trade({ category: 'electrician' }),
      trade({ category: 'general_labor' }),
      trade({ category: 'other', canonical_en: 'Welder', canonical_es: 'Soldador', other: 'welder' }),
      trade({ category: 'other', other: 'Tile setter helper' }),
    ];
    for (const locale of ['en', 'es']) {
      const t = catalogueT(locale);
      for (const hire of cases) {
        const label = hireTradeLabel(hire, locale, t) as string;
        const phrase = hireTradePhrase(hire, locale, t) as string;
        expect(label).toBeTruthy();
        expect(phrase).toBeTruthy();
        expect(phrase.slice(1)).toBe(label.slice(1));
        expect(phrase.toLocaleLowerCase()).toBe(label.toLocaleLowerCase());
      }
    }
  });
});

describe('experienceLabel', () => {
  /**
   * The three payloads that render this row. `tsc` pins the structural param
   * type against the real wire types, the same way `hireTradeLabel` pins
   * `ApplicationHire.trade` above -- the module imports nothing itself.
   */
  it('accepts the employer, worker and public job shapes', () => {
    const employer: ExperienceFields = {} as Pick<
      EmployerJob, 'required_experience_years' | 'required_experience_months'
    >;
    const worker: ExperienceFields = {} as Pick<
      WorkerJobDetail, 'required_experience_years' | 'required_experience_months'
    >;
    const publicJob: ExperienceFields = {} as Pick<
      PublicJobActive, 'required_experience_years' | 'required_experience_months'
    >;
    expect(experienceLabel(employer, fakeT)).toBeNull();
    expect(experienceLabel(worker, fakeT)).toBeNull();
    expect(experienceLabel(publicJob, fakeT)).toBeNull();
  });

  it('returns null when the job states no requirement at all', () => {
    expect(experienceLabel({}, fakeT)).toBeNull();
    expect(experienceLabel({ required_experience_years: null }, fakeT)).toBeNull();
    expect(
      experienceLabel({ required_experience_years: null, required_experience_months: null }, fakeT),
    ).toBeNull();
    expect(experienceLabel({ required_experience_years: undefined }, fakeT)).toBeNull();
  });

  /**
   * THE DEFECT THIS EXISTS FOR. Zero is a STATED requirement ("none"), not an
   * absent one -- every call site guards on `!== null`, so a zero reached the
   * tile and rendered a bare "0" with no unit and no meaning.
   */
  it('says "no experience required" for an explicit zero', () => {
    expect(experienceLabel({ required_experience_years: 0 }, fakeT)).toBe('experience_none');
    expect(
      experienceLabel({ required_experience_years: 0, required_experience_months: 0 }, fakeT),
    ).toBe('experience_none');
    expect(experienceLabel({ required_experience_months: 0 }, fakeT)).toBe('experience_none');
  });

  /** The unit is the point: "3" is a number, "3 years" is a requirement. */
  it('carries the unit for years, months, or both', () => {
    expect(experienceLabel({ required_experience_years: 3 }, fakeT))
      .toBe('experience_years_unit({"n":3})');
    expect(experienceLabel({ required_experience_months: 6 }, fakeT))
      .toBe('experience_months_unit({"n":6})');
    expect(
      experienceLabel({ required_experience_years: 2, required_experience_months: 6 }, fakeT),
    ).toBe('experience_years_unit({"n":2}) experience_months_unit({"n":6})');
  });

  it('drops a zero side of a mixed pair rather than printing "0 years"', () => {
    expect(
      experienceLabel({ required_experience_years: 0, required_experience_months: 6 }, fakeT),
    ).toBe('experience_months_unit({"n":6})');
    expect(
      experienceLabel({ required_experience_years: 3, required_experience_months: 0 }, fakeT),
    ).toBe('experience_years_unit({"n":3})');
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
