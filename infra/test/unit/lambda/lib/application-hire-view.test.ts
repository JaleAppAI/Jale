/**
 * application-hire-view.test.ts
 *
 * The pure half of the sprint-24 hire celebration: everything the worker's
 * "You've been hired" modal and banner render, derived from ONE already
 * selected `job_applications` + `jobs` row.
 *
 * It is unit-tested rather than integration-tested because none of it touches
 * the database: the endpoint's own DB facts (which columns are projected, the
 * COALESCE that guarantees a non-null `hired_at`) are pinned in
 * `worker-applications-list.test.ts` and in the 095 DB suite.
 */
import {
  buildHireSummary,
  EMPLOYER_DISPLAY_NAME_FALLBACK,
} from '../../../../lambda/lib/application-hire-view';

/** A hired row with every job fact present, as `pg` hands it back. */
const HIRED = {
  status: 'hired',
  hired_at: new Date('2026-09-04T15:30:00.000Z'),
  hired_seen_at: null,
  hired_ack_at: null,
  job_start_date: '2026-09-15',
  job_location: 'El Paso, TX 79901',
  job_city: 'El Paso',
  job_state: 'TX',
  job_pay: '$22-$26/hour',
  job_pay_min: 22,
  job_pay_max: 26,
  job_pay_interval: 'hourly',
  job_shift_schedule: 'Lunes a viernes, 7am-3pm',
  job_trade_category: 'electrician',
  job_trade_category_other: null,
  // NOT job_-prefixed: this is the list's own top-level field, read here only
  // to screen the 031 sentinel.
  company_name: 'Acme Concrete',
};

describe('buildHireSummary', () => {
  it('carries the three timestamps and the four job facts', () => {
    expect(buildHireSummary(HIRED)).toEqual({
      hired_at: '2026-09-04T15:30:00.000Z',
      seen_at: null,
      acknowledged_at: null,
      start_date: '2026-09-15',
      // Both parts present, so the structured pair wins over the free text.
      location: 'El Paso, TX',
      // The stored jobs.pay string, verbatim -- and the structured triple
      // RAW alongside it. Nothing here is formatted: the browser renders the
      // pay line with its own i18n-aware formatPay(job, t).
      pay: '$22-$26/hour',
      pay_min: 22,
      pay_max: 26,
      pay_interval: 'hourly',
      shift_schedule: 'Lunes a viernes, 7am-3pm',
      // The 023 enum value, raw. canonical_* are the handler's job, not this
      // pure view's -- it has no client to query trade_aliases with.
      trade: { category: 'electrician', other: null, canonical_en: null, canonical_es: null },
      company: 'Acme Concrete',
    });
  });

  it('renders Date and string timestamps identically, as ISO strings', () => {
    const asDates = buildHireSummary({
      ...HIRED,
      hired_seen_at: new Date('2026-09-04T16:00:00.000Z'),
      hired_ack_at: new Date('2026-09-04T17:00:00.000Z'),
    });
    const asStrings = buildHireSummary({
      ...HIRED,
      hired_at: '2026-09-04T15:30:00.000Z',
      hired_seen_at: '2026-09-04T16:00:00.000Z',
      hired_ack_at: '2026-09-04T17:00:00.000Z',
    });
    expect(asDates!.seen_at).toBe('2026-09-04T16:00:00.000Z');
    expect(asDates!.acknowledged_at).toBe('2026-09-04T17:00:00.000Z');
    // `pg` returns timestamptz as a JS Date and the migration/DB suite proves
    // the columns are timestamptz -- but a caller that has already stringified
    // (or a future JSON round trip) must not change the payload.
    expect(asStrings).toEqual(asDates);
  });

  describe('location', () => {
    it('joins city and state when BOTH are present', () => {
      expect(buildHireSummary({ ...HIRED, job_city: 'Odessa', job_state: 'TX' })!.location)
        .toBe('Odessa, TX');
    });

    it('falls back to the free-text location when either part is missing or blank', () => {
      for (const over of [
        { job_city: null, job_state: 'TX' },
        { job_city: 'El Paso', job_state: null },
        { job_city: '   ', job_state: 'TX' },
        { job_city: 'El Paso', job_state: '' },
        { job_city: null, job_state: null },
      ]) {
        expect(buildHireSummary({ ...HIRED, ...over })!.location).toBe('El Paso, TX 79901');
      }
    });

    it('is null when neither the pair nor the free text says anything', () => {
      expect(buildHireSummary({
        ...HIRED, job_city: null, job_state: null, job_location: null,
      })!.location).toBeNull();
      // jobs.location is NOT NULL (003), so blank -- not absent -- is the
      // shape this actually takes in production.
      expect(buildHireSummary({
        ...HIRED, job_city: null, job_state: null, job_location: '   ',
      })!.location).toBeNull();
    });
  });

  // -- pay travels RAW, in four fields --------------------------------
  // The celebration's pay line is rendered by the frontend's own
  // `formatPay(job, t)` (frontend/src/lib/pay.ts), which already formats
  // exactly these four fields, in the worker's language, for the job card.
  // Synthesising a string here would put untranslated English in a
  // Spanish-facing modal AND give one job two different pay lines on two
  // screens. So `pay` is the stored text or null -- never built -- and the
  // 023/033 triple is passed through for the client to format.
  describe('pay', () => {
    it('passes the stored jobs.pay string through, trimmed', () => {
      expect(buildHireSummary({ ...HIRED, job_pay: '  $30/hour  ' })!.pay).toBe('$30/hour');
    });

    it('nulls a blank jobs.pay WITHOUT synthesising one from the bounds', () => {
      for (const blank of [null, undefined, '', '   ']) {
        const summary = buildHireSummary({ ...HIRED, job_pay: blank })!;
        expect(summary.pay).toBeNull();
        // The bounds still publish: this is precisely the row the client
        // formats for itself.
        expect(summary.pay_min).toBe(22);
        expect(summary.pay_max).toBe(26);
        expect(summary.pay_interval).toBe('hourly');
      }
    });

    // The regression guard for this whole decision. If anyone re-introduces a
    // server-side fallback, `pay` stops being null here.
    it('never emits a synthesised pay string, whatever the bounds say', () => {
      for (const over of [
        { job_pay_min: 22, job_pay_max: 26 },
        { job_pay_min: 25, job_pay_max: 25 },
        { job_pay_min: 22, job_pay_max: null },
        { job_pay_min: null, job_pay_max: 26 },
      ]) {
        expect(buildHireSummary({ ...HIRED, job_pay: null, ...over })!.pay).toBeNull();
      }
    });

    it('coerces the bounds to numbers, including the numeric-string shape a pg type-parser change would produce', () => {
      const summary = buildHireSummary({ ...HIRED, job_pay_min: '22', job_pay_max: '26.5' })!;
      expect(summary.pay_min).toBe(22);
      expect(summary.pay_max).toBe(26.5);
      // Numbers, not strings: the frontend's PayFields type says number, and
      // a string would render correctly only by accident.
      expect(typeof summary.pay_min).toBe('number');
    });

    it('nulls a bound that is not a finite number', () => {
      for (const junk of [null, undefined, '', '   ', 'twenty', NaN, Infinity, {}, []]) {
        const summary = buildHireSummary({ ...HIRED, job_pay_min: junk, job_pay_max: junk })!;
        expect(summary.pay_min).toBeNull();
        expect(summary.pay_max).toBeNull();
      }
    });

    it('passes the interval token through raw, whatever it is', () => {
      // The 033 CHECK allows exactly these five.
      for (const token of ['hourly', 'daily', 'weekly', 'monthly', 'fixed']) {
        expect(buildHireSummary({ ...HIRED, job_pay_interval: token })!.pay_interval).toBe(token);
      }
      // A token this backend does not recognize is still the job's own value.
      // The client decides what to render for it (its formatPay drops an
      // unmapped interval); reinterpreting it here would be a second opinion.
      expect(buildHireSummary({ ...HIRED, job_pay_interval: 'per_yard' })!.pay_interval)
        .toBe('per_yard');
    });

    it('nulls a blank or missing interval', () => {
      for (const blank of [null, undefined, '', '  ']) {
        expect(buildHireSummary({ ...HIRED, job_pay_interval: blank })!.pay_interval).toBeNull();
      }
    });

    it('publishes all four pay fields as null for a job that states no rate', () => {
      const summary = buildHireSummary({
        ...HIRED, job_pay: null, job_pay_min: null, job_pay_max: null, job_pay_interval: null,
      })!;
      expect(summary.pay).toBeNull();
      expect(summary.pay_min).toBeNull();
      expect(summary.pay_max).toBeNull();
      expect(summary.pay_interval).toBeNull();
    });
  });

  describe('the remaining job facts', () => {
    it('passes start_date through as the YYYY-MM-DD string the SELECT produces', () => {
      expect(buildHireSummary({ ...HIRED, job_start_date: '2027-01-04' })!.start_date)
        .toBe('2027-01-04');
    });

    it('nulls a missing or blank start_date and shift_schedule', () => {
      const summary = buildHireSummary({
        ...HIRED, job_start_date: null, job_shift_schedule: '   ',
      })!;
      expect(summary.start_date).toBeNull();
      expect(summary.shift_schedule).toBeNull();
    });
  });

  // -- the trade, RAW and unresolved -------------------------------------
  // The new copy reads "{company} te contrató como {trade}", so the hire
  // object has to carry a trade at all -- before this it carried only the job
  // title. `canonical_en`/`canonical_es` are declared here but ALWAYS null:
  // filling them needs a `trade_aliases` lookup, and this module is pure by
  // construction (see the header). `worker-applications-list.ts` runs that
  // pass after its COMMIT.
  describe('trade', () => {
    it('passes a 023 enum category through raw, with a null `other` and null canonicals', () => {
      for (const category of [
        'electrician', 'plumber', 'carpenter', 'concrete',
        'painting', 'drywall', 'general_labor',
      ]) {
        expect(buildHireSummary({ ...HIRED, job_trade_category: category })!.trade).toEqual({
          category, other: null, canonical_en: null, canonical_es: null,
        });
      }
    });

    it("keeps the enum's own token even when the job also carries stale free text", () => {
      // 023 only CHECKs the enum; nothing stops trade_category_other from
      // outliving an edit that moved the job onto a real category. The client
      // reads `other` only when `category === 'other'`, so this travels as-is
      // rather than being second-guessed here.
      expect(buildHireSummary({
        ...HIRED, job_trade_category: 'plumber', job_trade_category_other: 'Welder',
      })!.trade).toEqual({
        category: 'plumber', other: 'Welder', canonical_en: null, canonical_es: null,
      });
    });

    it("carries `other` trimmed when the category is the 'other' escape hatch", () => {
      expect(buildHireSummary({
        ...HIRED, job_trade_category: 'other', job_trade_category_other: '  Welder  ',
      })!.trade).toEqual({
        category: 'other', other: 'Welder', canonical_en: null, canonical_es: null,
      });
    });

    it("nulls a blank `other`, leaving 'other' with nothing to canonicalise", () => {
      for (const blank of [null, undefined, '', '   ']) {
        expect(buildHireSummary({
          ...HIRED, job_trade_category: 'other', job_trade_category_other: blank,
        })!.trade).toEqual({
          category: 'other', other: null, canonical_en: null, canonical_es: null,
        });
      }
    });

    it('is an object with a null category when the job states no trade -- never a null trade', () => {
      // jobs.trade_category is NULLable (023), so this is the shape a job
      // created before 023, or through a path that skips the field, takes.
      // The object still exists: a client reading `hire.trade.category` must
      // not have to null-check the container too.
      for (const missing of [null, undefined, '   ']) {
        expect(buildHireSummary({
          ...HIRED, job_trade_category: missing, job_trade_category_other: null,
        })!.trade).toEqual({
          category: null, other: null, canonical_en: null, canonical_es: null,
        });
      }
    });

    // The regression guard for the purity doctrine: if anyone teaches this
    // module to resolve an alias, these stop being null.
    it('never fills a canonical label, whatever the free text says', () => {
      for (const other of ['Welder', 'Soldador', 'welders', 'electrician']) {
        const trade = buildHireSummary({
          ...HIRED, job_trade_category: 'other', job_trade_category_other: other,
        })!.trade;
        expect(trade.canonical_en).toBeNull();
        expect(trade.canonical_es).toBeNull();
      }
    });
  });

  // -- company: the 031 sentinel is NOT a name ---------------------------
  describe('company', () => {
    it('exports the 031 sentinel as one constant', () => {
      // employer_display_name() ends in COALESCE(v_name, 'Empleador')
      // (031_employer_display_name.sql). One constant, one place to change.
      expect(EMPLOYER_DISPLAY_NAME_FALLBACK).toBe('Empleador');
    });

    it('passes a real company name through, trimmed', () => {
      expect(buildHireSummary({ ...HIRED, company_name: '  Acme Concrete  ' })!.company)
        .toBe('Acme Concrete');
    });

    it('reports the 031 sentinel as null, because it is a placeholder and not a name', () => {
      // "Empleador te contrató" reads as a company literally called
      // "Empleador". The client needs to know there is no name so it can pick
      // a company-less sentence.
      expect(buildHireSummary({ ...HIRED, company_name: EMPLOYER_DISPLAY_NAME_FALLBACK })!.company)
        .toBeNull();
      // 031 returns the sentinel for an employer with a NULL company_name, a
      // blank one (NULLIF), and a missing employer_profiles row alike.
      expect(buildHireSummary({ ...HIRED, company_name: '  Empleador  ' })!.company).toBeNull();
    });

    it('does NOT screen a company whose name merely contains the sentinel', () => {
      // Equality, not a substring test: "Empleadora del Norte" is a real name.
      expect(buildHireSummary({ ...HIRED, company_name: 'Empleadora del Norte' })!.company)
        .toBe('Empleadora del Norte');
      expect(buildHireSummary({ ...HIRED, company_name: 'Grupo Empleador' })!.company)
        .toBe('Grupo Empleador');
    });

    it('is null when the column is absent or blank', () => {
      for (const blank of [null, undefined, '', '   ']) {
        expect(buildHireSummary({ ...HIRED, company_name: blank })!.company).toBeNull();
      }
    });
  });

  // The list endpoint SELECTs COALESCE(a.hired_at, a.updated_at), and
  // job_applications.updated_at is NOT NULL (003), so a row reaching this
  // function with no timestamp at all cannot come from the database. It is
  // still refused rather than published as `hired_at: null`, which the
  // frontend contract does not allow.
  it('returns null when the row carries no hire timestamp at all', () => {
    expect(buildHireSummary({ ...HIRED, hired_at: null })).toBeNull();
    expect(buildHireSummary({ ...HIRED, hired_at: undefined })).toBeNull();
    expect(buildHireSummary({ ...HIRED, hired_at: 'not-a-timestamp' })).toBeNull();
  });
});
