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
      // jobs.pay is non-empty, so it is used verbatim -- it is what the
      // employer's own job page shows.
      pay: '$22-$26/hour',
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

  describe('pay', () => {
    it('prefers the stored jobs.pay string, trimmed', () => {
      expect(buildHireSummary({ ...HIRED, job_pay: '  $30/hour  ' })!.pay).toBe('$30/hour');
    });

    it('formats both bounds from the structured columns when jobs.pay is empty', () => {
      for (const blank of [null, '', '   ']) {
        expect(buildHireSummary({ ...HIRED, job_pay: blank })!.pay).toBe('$22-$26/hourly');
      }
    });

    it('collapses an equal pair to a single amount, as formatPayRange does', () => {
      expect(buildHireSummary({
        ...HIRED, job_pay: null, job_pay_min: 25, job_pay_max: 25,
      })!.pay).toBe('$25/hourly');
    });

    it('renders a one-sided range from whichever bound exists', () => {
      expect(buildHireSummary({
        ...HIRED, job_pay: null, job_pay_max: null,
      })!.pay).toBe('$22+/hourly');
      expect(buildHireSummary({
        ...HIRED, job_pay: null, job_pay_min: null,
      })!.pay).toBe('up to $26/hourly');
    });

    it('omits the interval suffix when the interval is unknown', () => {
      for (const blank of [null, '', '  ']) {
        expect(buildHireSummary({ ...HIRED, job_pay: null, job_pay_interval: blank })!.pay)
          .toBe('$22-$26');
      }
    });

    it('accepts the numeric bounds as strings (a pg type-parser change must not break it)', () => {
      expect(buildHireSummary({
        ...HIRED, job_pay: null, job_pay_min: '22', job_pay_max: '26',
      })!.pay).toBe('$22-$26/hourly');
    });

    it('is null when neither the string nor either bound is usable', () => {
      expect(buildHireSummary({
        ...HIRED, job_pay: null, job_pay_min: null, job_pay_max: null,
      })!.pay).toBeNull();
      // A non-finite bound is not a pay range. NaN/Infinity would otherwise
      // render as "$NaN/hourly" in a celebration modal.
      expect(buildHireSummary({
        ...HIRED, job_pay: '', job_pay_min: 'twenty', job_pay_max: null,
      })!.pay).toBeNull();
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
