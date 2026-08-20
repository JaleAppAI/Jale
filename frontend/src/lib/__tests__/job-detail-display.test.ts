import { describe, expect, it } from 'vitest';
import {
  durationLabel,
  scheduleSummary,
  shiftHoursLabel,
  tradeLabel,
  workDayChips,
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
