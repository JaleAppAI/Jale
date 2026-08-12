// This suite pins the process timezone to a NEGATIVE offset before anything
// touches `Date` or `Intl`, because the off-by-one bug these helpers exist to
// prevent is invisible at UTC. America/Los_Angeles is UTC-8 (UTC-7 in summer),
// which is the same side of the line as the app's Mexican audience and far
// enough from zero that a day-shift is unambiguous.
//
// Node re-reads `process.env.TZ` when it changes, so setting it at module scope
// (before the import below) is enough; the assertions do not depend on the
// machine the suite runs on.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';

import { afterAll, describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatLongDate,
  formatShortDate,
  formatStartDate,
  formatStartDateShort,
  formatTimeOfDay,
  formatWeekdayDate,
} from '@/lib/date';

// Vitest can run several files in one worker process, and `process.env.TZ` is
// process-global. Restoring it keeps the override contained to this file rather
// than silently re-timezoning whatever suite runs next in the same worker.
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('the timezone the suite runs in', () => {
  it('is a negative offset, or the day-shift assertions below prove nothing', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles');
    expect(new Date('2026-06-15T00:00:00Z').getTimezoneOffset()).toBeGreaterThan(0);
  });
});

describe('date-only values are formatted in UTC (the off-by-one)', () => {
  // `new Date('2026-06-15')` is UTC midnight. Rendered in the reader's
  // timezone at UTC-7 that is 2026-06-14 17:00 -- "June 14", a day EARLY.
  it('formatStartDate keeps the stored calendar day at a negative offset', () => {
    expect(formatStartDate('2026-06-15', 'en')).toBe('June 15, 2026');
  });

  it('the naive formatting it replaces really does shift the day back', () => {
    // Not a test of our code -- a guard that the bug is still reachable, so
    // this suite fails loudly if someone "simplifies" the UTC pin away.
    const naive = new Date('2026-06-15').toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    expect(naive).toBe('June 14, 2026');
    expect(formatStartDate('2026-06-15', 'en')).not.toBe(naive);
  });

  it('holds for the short form too', () => {
    expect(formatStartDateShort('2026-06-15', 'en')).toBe('Jun 15');
  });

  it('holds on a year boundary, where the shift changes the year as well', () => {
    expect(formatStartDate('2026-01-01', 'en')).toBe('January 1, 2026');
    expect(formatStartDateShort('2026-01-01', 'en')).toBe('Jan 1');
  });

  it('accepts a full ISO timestamp at UTC midnight without shifting', () => {
    expect(formatStartDate('2026-06-15T00:00:00.000Z', 'en')).toBe('June 15, 2026');
  });
});

describe('instants are formatted in the reader timezone', () => {
  // 2026-06-15T02:00Z is still June 14 in California. An instant must follow
  // the reader, which is the exact opposite of the date-only rule above.
  it('formatLongDate reports the reader local day, not the UTC day', () => {
    expect(formatLongDate('2026-06-15T02:00:00Z', 'en')).toBe('Jun 14, 2026');
  });

  it('formatShortDate reports the reader local day', () => {
    expect(formatShortDate('2026-06-15T02:00:00Z', 'en')).toBe('Jun 14');
  });

  it('is deliberately NOT the same answer as the date-only formatter', () => {
    const instant = '2026-06-15T02:00:00Z';
    expect(formatLongDate(instant, 'en')).not.toBe(formatStartDate(instant, 'en'));
  });
});

describe('the app locale decides the formatting, not the runtime', () => {
  it('formatStartDate: es differs from en and names the month in Spanish', () => {
    const en = formatStartDate('2026-06-15', 'en');
    const es = formatStartDate('2026-06-15', 'es');
    expect(en).toBe('June 15, 2026');
    expect(es).toMatch(/junio/);
    expect(es).not.toBe(en);
  });

  it('formatShortDate: es puts the day first, en puts the month first', () => {
    expect(formatShortDate('2026-06-15T18:00:00Z', 'en')).toBe('Jun 15');
    expect(formatShortDate('2026-06-15T18:00:00Z', 'es')).toBe('15 jun');
  });

  it('formatLongDate differs between es and en', () => {
    const en = formatLongDate('2026-06-15T18:00:00Z', 'en');
    const es = formatLongDate('2026-06-15T18:00:00Z', 'es');
    expect(es).not.toBe(en);
    expect(es).toMatch(/jun/);
  });

  it('formatWeekdayDate names the weekday in the app locale', () => {
    expect(formatWeekdayDate('2026-06-15T18:00:00Z', 'en')).toMatch(/Monday/);
    expect(formatWeekdayDate('2026-06-15T18:00:00Z', 'es')).toMatch(/lunes/);
  });

  it('formatDateTime differs between es and en', () => {
    const en = formatDateTime('2026-06-15T18:00:00Z', 'en');
    const es = formatDateTime('2026-06-15T18:00:00Z', 'es');
    expect(en).toBeTruthy();
    expect(es).not.toBe(en);
  });

  it('formatTimeOfDay differs between es and en (12h vs 24h)', () => {
    const en = formatTimeOfDay('2026-06-15T18:00:00Z', 'en');
    const es = formatTimeOfDay('2026-06-15T18:00:00Z', 'es');
    expect(en).toBe('11:00 AM');
    expect(es).not.toBe(en);
  });

  it('falls back to en-US for a locale the app does not ship', () => {
    expect(formatStartDate('2026-06-15', 'fr')).toBe(formatStartDate('2026-06-15', 'en'));
  });
});

describe('fallbacks', () => {
  it.each([
    ['formatStartDate', formatStartDate],
    ['formatStartDateShort', formatStartDateShort],
    ['formatShortDate', formatShortDate],
    ['formatLongDate', formatLongDate],
    ['formatDateTime', formatDateTime],
    ['formatWeekdayDate', formatWeekdayDate],
    ['formatTimeOfDay', formatTimeOfDay],
  ])('%s returns null for null, undefined and empty string', (_name, fn) => {
    expect(fn(null, 'en')).toBeNull();
    expect(fn(undefined, 'en')).toBeNull();
    expect(fn('', 'en')).toBeNull();
  });

  it.each([
    ['formatStartDate', formatStartDate],
    ['formatStartDateShort', formatStartDateShort],
    ['formatShortDate', formatShortDate],
    ['formatLongDate', formatLongDate],
    ['formatDateTime', formatDateTime],
    ['formatWeekdayDate', formatWeekdayDate],
  ])('%s hands back the raw value rather than "Invalid Date"', (_name, fn) => {
    expect(fn('not-a-date', 'en')).toBe('not-a-date');
  });

  it('formatTimeOfDay returns null for an unparseable value, not the raw string', () => {
    // A clock-sized slot has nowhere to put an echoed ISO string.
    expect(formatTimeOfDay('not-a-date', 'en')).toBeNull();
  });

  it('accepts a Date instance as well as a string', () => {
    expect(formatLongDate(new Date('2026-06-15T18:00:00Z'), 'en')).toBe('Jun 15, 2026');
  });
});
