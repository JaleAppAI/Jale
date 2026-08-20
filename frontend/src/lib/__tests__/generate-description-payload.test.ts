import { describe, expect, it } from 'vitest';
import {
  buildGenerateDescriptionPayload,
  capEmployerNotes,
  EMPLOYER_NOTES_MAX_LENGTH,
  shouldSendAsNotes,
  type DescriptionHelperFields,
} from '@/lib/generate-description-payload';
import { DURATION_BUCKET_LABELS, deriveLegacyShiftSchedule } from '@/lib/job-form';

const base: DescriptionHelperFields = {
  title: '',
  trade_category: 'electrician',
  trade_category_other: '',
  city: null,
  state: null,
  pay_min: '',
  pay_max: '',
  pay_interval: 'hourly',
  expected_duration: '',
  expected_duration_bucket: '',
  shift_schedule: '',
  work_days: [],
  shift_start: '',
  shift_end: '',
  description: '',
};

describe('buildGenerateDescriptionPayload', () => {
  it('sends only trade_category (+ the default pay_interval) when every other field is blank/unset', () => {
    // `pay_interval` is a `Select` with a default (`initialForm.pay_interval`
    // is `'hourly'`), unlike the free-text fields below -- it is never
    // actually blank in real form state, so it stays in the payload here.
    expect(buildGenerateDescriptionPayload(base)).toEqual({
      trade_category: 'electrician',
      pay_interval: 'hourly',
    });
  });

  it('includes every optional field, converting pay strings to numbers', () => {
    const form: DescriptionHelperFields = {
      ...base,
      title: '  Helper needed  ',
      city: 'Austin',
      state: 'TX',
      pay_min: '20',
      pay_max: '30.5',
      expected_duration: ' 3 months ',
      shift_schedule: ' Mon-Fri, 7am-3pm ',
      description: 'existing text',
    };
    expect(buildGenerateDescriptionPayload(form)).toEqual({
      trade_category: 'electrician',
      title: 'Helper needed',
      city: 'Austin',
      state: 'TX',
      pay_min: 20,
      pay_max: 30.5,
      pay_interval: 'hourly',
      expected_duration: '3 months',
      shift_schedule: 'Mon-Fri, 7am-3pm',
    });
  });

  it('omits pay_min/pay_max entirely rather than sending null/NaN for unparseable text', () => {
    const form: DescriptionHelperFields = { ...base, pay_min: 'abc', pay_max: 'xyz' };
    const payload = buildGenerateDescriptionPayload(form);
    expect(payload).not.toHaveProperty('pay_min');
    expect(payload).not.toHaveProperty('pay_max');
  });

  it('omits city/state when null, and omits pay_interval when blank', () => {
    const form: DescriptionHelperFields = { ...base, city: null, state: null, pay_interval: '' as never };
    const payload = buildGenerateDescriptionPayload(form);
    expect(payload).not.toHaveProperty('city');
    expect(payload).not.toHaveProperty('state');
    expect(payload).not.toHaveProperty('pay_interval');
  });

  it('truncates every string field to 200 chars, matching the backend cap', () => {
    const long = 'x'.repeat(250);
    const form: DescriptionHelperFields = {
      ...base,
      title: long,
      city: long,
      state: long,
      expected_duration: long,
      shift_schedule: long,
    };
    const payload = buildGenerateDescriptionPayload(form);
    expect(payload.title).toHaveLength(200);
    expect(payload.city).toHaveLength(200);
    expect(payload.state).toHaveLength(200);
    expect(payload.expected_duration).toHaveLength(200);
    expect(payload.shift_schedule).toHaveLength(200);
  });

  it('never reads the description field into the payload', () => {
    const form: DescriptionHelperFields = { ...base, description: 'should never be sent' };
    expect(buildGenerateDescriptionPayload(form)).not.toHaveProperty('description');
  });

  describe('trade_category_other', () => {
    it('includes trade_category_other when trade is other and text is non-blank', () => {
      const form: DescriptionHelperFields = { ...base, trade_category: 'other', trade_category_other: '  Pool cleaner  ' };
      const payload = buildGenerateDescriptionPayload(form);
      expect(payload).toMatchObject({ trade_category: 'other', trade_category_other: 'Pool cleaner' });
    });

    it('omits trade_category_other when trade is other but text is blank -- matches canGenerate staying disabled for this shape', () => {
      const form: DescriptionHelperFields = { ...base, trade_category: 'other', trade_category_other: '   ' };
      const payload = buildGenerateDescriptionPayload(form);
      expect(payload).not.toHaveProperty('trade_category_other');
    });

    it('omits trade_category_other for a non-other trade even if stale text is present', () => {
      const form: DescriptionHelperFields = { ...base, trade_category: 'electrician', trade_category_other: 'Pool cleaner' };
      const payload = buildGenerateDescriptionPayload(form);
      expect(payload).not.toHaveProperty('trade_category_other');
    });

    it('caps trade_category_other at 200 chars', () => {
      const form: DescriptionHelperFields = { ...base, trade_category: 'other', trade_category_other: 'x'.repeat(250) };
      const payload = buildGenerateDescriptionPayload(form);
      expect(payload.trade_category_other).toHaveLength(200);
    });
  });

  describe('expected_duration derivation', () => {
    it('derives expected_duration from the bucket when set', () => {
      const form: DescriptionHelperFields = { ...base, expected_duration_bucket: '1_2w', expected_duration: '' };
      const payload = buildGenerateDescriptionPayload(form);
      expect(payload.expected_duration).toBe(DURATION_BUCKET_LABELS['1_2w']);
    });

    it('the bucket wins over legacy free text when both are set (mirrors jobFormToBasePayload)', () => {
      const form: DescriptionHelperFields = { ...base, expected_duration_bucket: '3_6m', expected_duration: 'some stale legacy text' };
      const payload = buildGenerateDescriptionPayload(form);
      expect(payload.expected_duration).toBe(DURATION_BUCKET_LABELS['3_6m']);
    });

    it('falls back to legacy free text when the bucket is unset', () => {
      const form: DescriptionHelperFields = { ...base, expected_duration_bucket: '', expected_duration: 'about a month' };
      const payload = buildGenerateDescriptionPayload(form);
      expect(payload.expected_duration).toBe('about a month');
    });
  });

  describe('shift_schedule derivation', () => {
    it('derives shift_schedule from structured work_days/shift_start/shift_end when any are set', () => {
      const form: DescriptionHelperFields = { ...base, work_days: ['mon', 'tue'], shift_start: '', shift_end: '', shift_schedule: '' };
      const payload = buildGenerateDescriptionPayload(form);
      expect(payload.shift_schedule).toBe(deriveLegacyShiftSchedule(['mon', 'tue'], '', ''));
    });

    it('the structured schedule wins over legacy free text when both are set (mirrors jobFormToBasePayload)', () => {
      const form: DescriptionHelperFields = {
        ...base,
        work_days: ['mon', 'tue'],
        shift_start: '07:00',
        shift_end: '16:00',
        shift_schedule: 'legacy text that should be ignored',
      };
      const payload = buildGenerateDescriptionPayload(form);
      expect(payload.shift_schedule).toBe(deriveLegacyShiftSchedule(['mon', 'tue'], '07:00', '16:00'));
      expect(payload.shift_schedule).not.toBe('legacy text that should be ignored');
    });

    it('a lone shift_start (no work_days/shift_end) still counts as "structured set"', () => {
      const form: DescriptionHelperFields = { ...base, shift_start: '07:00', shift_schedule: 'legacy' };
      const payload = buildGenerateDescriptionPayload(form);
      expect(payload.shift_schedule).toBe(deriveLegacyShiftSchedule([], '07:00', ''));
    });

    it('falls back to legacy free text when no structured schedule field is set', () => {
      const form: DescriptionHelperFields = { ...base, shift_schedule: 'Mon-Fri, mornings' };
      const payload = buildGenerateDescriptionPayload(form);
      expect(payload.shift_schedule).toBe('Mon-Fri, mornings');
    });
  });
});

describe('shouldSendAsNotes', () => {
  it('is false when current is blank', () => {
    expect(shouldSendAsNotes('', null)).toBe(false);
    expect(shouldSendAsNotes('   ', 'prior generation')).toBe(false);
  });

  it('is false when current equals the last generation (nothing new typed)', () => {
    expect(shouldSendAsNotes('We need an electrician.', 'We need an electrician.')).toBe(false);
  });

  it('is false even with surrounding whitespace differences from the last generation', () => {
    expect(shouldSendAsNotes('  We need an electrician.  ', 'We need an electrician.')).toBe(false);
  });

  it('is true for new text never seen as a generation', () => {
    expect(shouldSendAsNotes('need someone who can start Monday', null)).toBe(true);
  });

  it('is true when current differs from the last generation', () => {
    expect(shouldSendAsNotes('need someone who can start Monday', 'We need an electrician.')).toBe(true);
  });

  it('is false for an untouched inserted sample -- DescriptionHelper records samples through the same ref', () => {
    const sample = 'Sample O*NET-derived description text.';
    expect(shouldSendAsNotes(sample, sample)).toBe(false);
  });
});

describe('capEmployerNotes', () => {
  it('trims surrounding whitespace', () => {
    expect(capEmployerNotes('  need someone by Monday  ')).toBe('need someone by Monday');
  });

  it(`caps at EMPLOYER_NOTES_MAX_LENGTH (${EMPLOYER_NOTES_MAX_LENGTH}) chars`, () => {
    const long = 'x'.repeat(300);
    const capped = capEmployerNotes(long);
    expect(capped).toHaveLength(EMPLOYER_NOTES_MAX_LENGTH);
    expect(EMPLOYER_NOTES_MAX_LENGTH).toBe(200);
  });
});
