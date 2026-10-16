// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HIRE_DETAILS_LIMITS,
  REMIND_COOLDOWN_MS,
  WORKER_MESSAGE_MAX,
  checkWorkerMessage,
  hasHireDetails,
  hireDetailsFormFrom,
  isCalendarDate,
  readRemindedAt,
  remindBlockFrom,
  telHref,
  validateHireDetails,
  wholeHours,
  wholeMinutes,
  writeRemindedAt,
} from '../hire-details';

const blank = hireDetailsFormFrom(null);

describe('validateHireDetails (K4.2)', () => {
  it('trims every field and sends blanks as null, always all five keys', () => {
    const result = validateHireDetails({ ...blank, report_location: '  Gate 3  ', notes: '   ' });
    expect(result).toEqual({
      ok: true,
      payload: { start_date: null, report_location: 'Gate 3', contact_name: null, contact_phone: null, notes: null },
    });
  });

  it('accepts a real calendar date and refuses an impossible or malformed one', () => {
    expect(validateHireDetails({ ...blank, start_date: '2026-10-20' }).ok).toBe(true);
    for (const bad of ['2026-02-30', '2026-13-01', '20-10-2026', '2026-10-2']) {
      expect(validateHireDetails({ ...blank, start_date: bad })).toEqual({ ok: false, errors: { start_date: 'date' } });
    }
  });

  it('enforces each length limit at limit + 1', () => {
    for (const field of ['report_location', 'contact_name', 'notes'] as const) {
      const limit = HIRE_DETAILS_LIMITS[field];
      expect(validateHireDetails({ ...blank, [field]: 'x'.repeat(limit) }).ok).toBe(true);
      expect(validateHireDetails({ ...blank, [field]: 'x'.repeat(limit + 1) })).toEqual({ ok: false, errors: { [field]: 'too_long' } });
    }
  });

  it('accepts only digits, spaces and + ( ) - in the phone, up to 32', () => {
    expect(validateHireDetails({ ...blank, contact_phone: '+1 (000) 000-0000' }).ok).toBe(true);
    expect(validateHireDetails({ ...blank, contact_phone: '000 000 0000 ext 2' })).toEqual({ ok: false, errors: { contact_phone: 'phone' } });
    expect(validateHireDetails({ ...blank, contact_phone: '0'.repeat(33) })).toEqual({ ok: false, errors: { contact_phone: 'too_long' } });
  });

  it('reports every invalid field at once', () => {
    const result = validateHireDetails({ ...blank, start_date: 'soon', contact_phone: 'call me' });
    expect(result).toEqual({ ok: false, errors: { start_date: 'date', contact_phone: 'phone' } });
  });
});

describe('isCalendarDate', () => {
  it('knows leap years', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2027-02-29')).toBe(false);
  });
});

describe('hasHireDetails', () => {
  it('is false for null, undefined and an all-blank record', () => {
    expect(hasHireDetails(null)).toBe(false);
    expect(hasHireDetails(undefined)).toBe(false);
    expect(hasHireDetails({ start_date: null, report_location: '  ', contact_name: null, contact_phone: null, notes: null })).toBe(false);
  });
  it('is true once any field carries text', () => {
    expect(hasHireDetails({ start_date: null, report_location: null, contact_name: null, contact_phone: null, notes: 'Bring boots' })).toBe(true);
  });
});

describe('telHref', () => {
  it('dials the digits, keeping a leading plus', () => {
    expect(telHref('+1 (000) 000-0000')).toBe('tel:+10000000000');
    expect(telHref('000 000 0000')).toBe('tel:0000000000');
  });
  it('offers no link for nothing dialable', () => {
    expect(telHref(null)).toBeNull();
    expect(telHref('()')).toBeNull();
  });
});

describe('checkWorkerMessage (K4.3)', () => {
  it('trims, refuses empty, refuses more than 2000', () => {
    expect(checkWorkerMessage('  On my way  ')).toEqual({ ok: true, body: 'On my way' });
    expect(checkWorkerMessage('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(checkWorkerMessage('x'.repeat(WORKER_MESSAGE_MAX)).ok).toBe(true);
    expect(checkWorkerMessage('x'.repeat(WORKER_MESSAGE_MAX + 1))).toEqual({ ok: false, reason: 'too_long' });
  });
});

describe('the remind marker (K4.4)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('is kept per application and per account', () => {
    writeRemindedAt('app-1', 'acct-a', 1_000);
    expect(readRemindedAt('app-1', 'acct-a')).toBe(1_000);
    expect(readRemindedAt('app-1', 'acct-b')).toBeNull();
    expect(readRemindedAt('app-2', 'acct-a')).toBeNull();
  });

  it('remembers nothing without an account', () => {
    writeRemindedAt('app-1', null, 1_000);
    expect(localStorage.length).toBe(0);
    expect(readRemindedAt('app-1', null)).toBeNull();
  });

  it('blocks for 24 hours from the reminder, in whole hours rounded up', () => {
    expect(remindBlockFrom(null, 5_000)).toBeNull();
    expect(remindBlockFrom(0, 3_600_000)).toEqual({ reason: 'recent', hours: 23 });
    expect(remindBlockFrom(0, REMIND_COOLDOWN_MS)).toBeNull();
  });

  it('never throws when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => writeRemindedAt('app-1', 'acct-a', 1)).not.toThrow();
    expect(readRemindedAt('app-1', 'acct-a')).toBeNull();
  });
});

describe('whole units', () => {
  it('rounds up and never says zero', () => {
    expect(wholeHours(1)).toBe(1);
    expect(wholeHours(2 * 3_600_000 + 1)).toBe(3);
    expect(wholeMinutes(0)).toBe(1);
    expect(wholeMinutes(1800)).toBe(30);
    expect(wholeMinutes(1801)).toBe(31);
  });
});
