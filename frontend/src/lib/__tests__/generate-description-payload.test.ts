import { describe, expect, it } from 'vitest';
import { buildGenerateDescriptionPayload, type DescriptionHelperFields } from '@/lib/generate-description-payload';

const base: DescriptionHelperFields = {
  title: '',
  trade_category: 'electrician',
  city: null,
  state: null,
  pay_min: '',
  pay_max: '',
  pay_interval: 'hourly',
  expected_duration: '',
  shift_schedule: '',
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
});
