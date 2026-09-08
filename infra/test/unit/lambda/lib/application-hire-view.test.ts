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
import { buildHireSummary } from '../../../../lambda/lib/application-hire-view';

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
