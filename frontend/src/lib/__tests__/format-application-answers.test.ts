import { describe, expect, it } from 'vitest';
import { answerEntries, formatAnswerValue, type RequirementsTranslator } from '@/lib/format-application-answers';

// Identity-ish fake translator: returns the key path (plus interpolated
// values inline) so assertions can check exactly which key/values were
// requested without wiring next-intl into a lib test.
const fakeT: RequirementsTranslator = (key, values) =>
  values ? `${key}(${JSON.stringify(values)})` : key;

describe('formatAnswerValue', () => {
  it('formats work_authorization and worked_here_before/military_service as yes/no', () => {
    expect(formatAnswerValue('work_authorization', true, fakeT)).toBe('apply.yes');
    expect(formatAnswerValue('work_authorization', false, fakeT)).toBe('apply.no');
  });

  it('formats desired_pay with the localized interval', () => {
    expect(formatAnswerValue('desired_pay', { amount: 25, interval: 'hourly' }, fakeT))
      .toBe('$25 apply.pay_interval.hourly');
  });

  it('formats home_address, dropping missing apartment cleanly', () => {
    expect(formatAnswerValue('home_address', {
      street: '1 Main St', city: 'Reno', state: 'NV', zip: '89501',
    }, fakeT)).toBe('1 Main St, Reno, NV 89501');

    expect(formatAnswerValue('home_address', {
      street: '1 Main St', apartment: '2B', city: 'Reno', state: 'NV', zip: '89501',
    }, fakeT)).toBe('1 Main St 2B, Reno, NV 89501');
  });

  it('formats emergency_contact as "name (phone)"', () => {
    expect(formatAnswerValue('emergency_contact', { name: 'Mom', phone: '555-1234' }, fakeT))
      .toBe('Mom (555-1234)');
  });

  it('formats worked_here_before with an optional "when" suffix', () => {
    expect(formatAnswerValue('worked_here_before', { answer: false }, fakeT)).toBe('apply.no');
    expect(formatAnswerValue('worked_here_before', { answer: true, when: '2021' }, fakeT))
      .toBe('apply.yes — 2021');
  });

  it('formats education with an optional graduated suffix', () => {
    expect(formatAnswerValue('education', { level: 'college' }, fakeT)).toBe('apply.education_level.college');
    expect(formatAnswerValue('education', { level: 'college', graduated: true }, fakeT))
      .toBe('apply.education_level.college (apply.yes)');
  });

  it('formats references/work_history as a translated count', () => {
    expect(formatAnswerValue('references', [{ name: 'A' }, { name: 'B' }], fakeT))
      .toBe('employer.references_count({"count":2})');
    expect(formatAnswerValue('work_history', [{ company: 'Acme' }], fakeT))
      .toBe('employer.work_history_count({"count":1})');
  });

  it('formats military_service with an optional branch suffix', () => {
    expect(formatAnswerValue('military_service', { served: false }, fakeT)).toBe('apply.no');
    expect(formatAnswerValue('military_service', { served: true, branch: 'Army' }, fakeT))
      .toBe('apply.yes — Army');
  });

  it('never throws on a malformed value, degrading to an empty or JSON string', () => {
    expect(formatAnswerValue('home_address', 'not-an-object', fakeT)).toBe('');
    expect(formatAnswerValue('desired_pay', null, fakeT)).toBe('');
    expect(() => formatAnswerValue('desired_pay', undefined, fakeT)).not.toThrow();
  });
});

describe('answerEntries', () => {
  it('returns an empty list for undefined/null answers', () => {
    expect(answerEntries(undefined, fakeT)).toEqual([]);
    expect(answerEntries(null, fakeT)).toEqual([]);
  });

  it('orders entries by the picker vocabulary, not insertion order', () => {
    const entries = answerEntries({ education: { level: 'ged' }, work_authorization: true }, fakeT);
    expect(entries.map((e) => e.key)).toEqual(['work_authorization', 'education']);
  });

  it('only includes keys actually present on the answers object', () => {
    const entries = answerEntries({ work_authorization: true }, fakeT);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ key: 'work_authorization', value: 'apply.yes' });
  });
});
