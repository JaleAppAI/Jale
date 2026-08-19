import { describe, expect, it } from 'vitest';
import {
  visibleFieldKeys,
  isFieldComplete,
  missingRequiredFields,
  canSubmitAnswers,
  buildAnswersPayload,
  addRepeatingEntry,
  removeRepeatingEntry,
  emptyAnswerDraft,
  emptyReferenceEntry,
  emptyWorkHistoryEntry,
  MAX_REPEATING_ENTRIES,
  type AnswerDraft,
} from '@/lib/application-answers-form';

describe('visibleFieldKeys', () => {
  it('renders exactly the union of required+optional fields, in stable vocabulary order', () => {
    const keys = visibleFieldKeys(['emergency_contact'], ['date_available', 'work_authorization']);
    expect(keys).toEqual(['work_authorization', 'date_available', 'emergency_contact']);
  });

  it('returns nothing for a job with no configured fields', () => {
    expect(visibleFieldKeys([], [])).toEqual([]);
  });

  it('de-duplicates a key present in both arrays', () => {
    expect(visibleFieldKeys(['education'], ['education'])).toEqual(['education']);
  });

  it('ignores unknown keys rather than crashing', () => {
    expect(visibleFieldKeys(['not_a_real_field'], [])).toEqual([]);
  });
});

describe('isFieldComplete', () => {
  const draft = emptyAnswerDraft();

  it('work_authorization requires an explicit true/false, not just any value', () => {
    expect(isFieldComplete('work_authorization', draft)).toBe(false);
    expect(isFieldComplete('work_authorization', { ...draft, work_authorization: false })).toBe(true);
    expect(isFieldComplete('work_authorization', { ...draft, work_authorization: true })).toBe(true);
  });

  it('date_available requires a non-blank string', () => {
    expect(isFieldComplete('date_available', draft)).toBe(false);
    expect(isFieldComplete('date_available', { ...draft, date_available: '2026-09-01' })).toBe(true);
  });

  it('desired_pay requires an integer 0..9999 and a valid interval', () => {
    expect(isFieldComplete('desired_pay', draft)).toBe(false);
    expect(isFieldComplete('desired_pay', { ...draft, desired_pay: { amount: '25', interval: 'hourly' } })).toBe(true);
    expect(isFieldComplete('desired_pay', { ...draft, desired_pay: { amount: '-5', interval: 'hourly' } })).toBe(false);
    expect(isFieldComplete('desired_pay', { ...draft, desired_pay: { amount: '10000', interval: 'hourly' } })).toBe(false);
    expect(isFieldComplete('desired_pay', { ...draft, desired_pay: { amount: '25.5', interval: 'hourly' } })).toBe(false);
  });

  it('home_address requires street/city plus a valid 2-letter state and zip', () => {
    const base = { street: '1 Main St', apartment: '', city: 'Reno', state: 'NV', zip: '89501' };
    expect(isFieldComplete('home_address', { ...draft, home_address: base })).toBe(true);
    expect(isFieldComplete('home_address', { ...draft, home_address: { ...base, state: 'Nevada' } })).toBe(false);
    expect(isFieldComplete('home_address', { ...draft, home_address: { ...base, zip: 'abc' } })).toBe(false);
    expect(isFieldComplete('home_address', { ...draft, home_address: { ...base, street: '' } })).toBe(false);
  });

  it('emergency_contact requires a name and a phone matching the shared phone pattern', () => {
    expect(isFieldComplete('emergency_contact', { ...draft, emergency_contact: { name: 'Mom', phone: '555-1234' } })).toBe(true);
    expect(isFieldComplete('emergency_contact', { ...draft, emergency_contact: { name: '', phone: '555-1234' } })).toBe(false);
    expect(isFieldComplete('emergency_contact', { ...draft, emergency_contact: { name: 'Mom', phone: 'abc' } })).toBe(false);
  });

  it('worked_here_before requires answer to be chosen; "when" stays optional even when true', () => {
    expect(isFieldComplete('worked_here_before', draft)).toBe(false);
    expect(isFieldComplete('worked_here_before', { ...draft, worked_here_before: { answer: false, when: '' } })).toBe(true);
    expect(isFieldComplete('worked_here_before', { ...draft, worked_here_before: { answer: true, when: '' } })).toBe(true);
  });

  it('education requires a chosen level; graduated stays optional', () => {
    expect(isFieldComplete('education', draft)).toBe(false);
    expect(isFieldComplete('education', { ...draft, education: { level: 'high_school', graduated: null } })).toBe(true);
  });

  it('references requires 1-3 fully filled entries', () => {
    expect(isFieldComplete('references', draft)).toBe(false); // 0 entries
    const full = { ...emptyReferenceEntry(), name: 'Jo', relationship: 'Boss', phone: '555-0000' };
    expect(isFieldComplete('references', { ...draft, references: [full] })).toBe(true);
    expect(isFieldComplete('references', { ...draft, references: [full, emptyReferenceEntry()] })).toBe(false);
    expect(isFieldComplete('references', { ...draft, references: [full, full, full, full] })).toBe(false);
  });

  it('work_history requires 1-3 entries with at least company+title', () => {
    expect(isFieldComplete('work_history', draft)).toBe(false);
    const full = { ...emptyWorkHistoryEntry(), company: 'Acme', title: 'Roofer' };
    expect(isFieldComplete('work_history', { ...draft, work_history: [full] })).toBe(true);
    expect(isFieldComplete('work_history', { ...draft, work_history: [{ ...full, company: '' }] })).toBe(false);
  });

  it('military_service requires served to be chosen; extras stay optional even when served=true', () => {
    expect(isFieldComplete('military_service', draft)).toBe(false);
    expect(isFieldComplete('military_service', {
      ...draft, military_service: { ...draft.military_service, served: false },
    })).toBe(true);
    expect(isFieldComplete('military_service', {
      ...draft, military_service: { ...draft.military_service, served: true },
    })).toBe(true);
  });
});

describe('missingRequiredFields / canSubmitAnswers', () => {
  it('blocks submit while any required field is incomplete', () => {
    const draft = emptyAnswerDraft();
    expect(canSubmitAnswers(['work_authorization', 'date_available'], draft)).toBe(false);
    expect(missingRequiredFields(['work_authorization', 'date_available'], draft)).toEqual(['work_authorization', 'date_available']);
  });

  it('allows submit once every required field is complete, ignoring optional-only gaps', () => {
    const draft: AnswerDraft = { ...emptyAnswerDraft(), work_authorization: true };
    expect(canSubmitAnswers(['work_authorization'], draft)).toBe(true);
    expect(missingRequiredFields(['work_authorization'], draft)).toEqual([]);
  });

  it('an empty required list is trivially satisfied', () => {
    expect(canSubmitAnswers([], emptyAnswerDraft())).toBe(true);
  });
});

describe('buildAnswersPayload', () => {
  it('includes every required field, serialized per its shape', () => {
    const draft: AnswerDraft = {
      ...emptyAnswerDraft(),
      work_authorization: true,
      date_available: '2026-09-01',
    };
    const answers = buildAnswersPayload(['work_authorization', 'date_available'], [], draft, new Set());
    expect(answers).toEqual({ work_authorization: true, date_available: '2026-09-01' });
  });

  it('omits an optional field the worker explicitly skipped', () => {
    const draft: AnswerDraft = { ...emptyAnswerDraft(), education: { level: 'college', graduated: true } };
    const answers = buildAnswersPayload([], ['education'], draft, new Set(['education']));
    expect(answers).toEqual({});
  });

  it('includes an optional field the worker filled in without skipping', () => {
    const draft: AnswerDraft = { ...emptyAnswerDraft(), education: { level: 'college', graduated: true } };
    const answers = buildAnswersPayload([], ['education'], draft, new Set());
    expect(answers).toEqual({ education: { level: 'college', graduated: true } });
  });

  it('omits an optional field left incomplete even if not explicitly skipped', () => {
    const answers = buildAnswersPayload([], ['education'], emptyAnswerDraft(), new Set());
    expect(answers).toEqual({});
  });

  it('never includes a key outside the union of required+optional', () => {
    const draft: AnswerDraft = { ...emptyAnswerDraft(), work_authorization: true, date_of_birth: '1990-01-01' };
    const answers = buildAnswersPayload(['work_authorization'], [], draft, new Set());
    expect(answers).toEqual({ work_authorization: true });
    expect('date_of_birth' in answers).toBe(false);
  });

  it('serializes home_address, dropping a blank apartment and normalizing state casing', () => {
    const draft: AnswerDraft = {
      ...emptyAnswerDraft(),
      home_address: { street: ' 1 Main St ', apartment: '  ', city: 'Reno', state: 'nv', zip: '89501' },
    };
    const answers = buildAnswersPayload(['home_address'], [], draft, new Set());
    expect(answers.home_address).toEqual({ street: '1 Main St', city: 'Reno', state: 'NV', zip: '89501' });
  });

  it('serializes worked_here_before, dropping "when" when the answer is false', () => {
    const draft: AnswerDraft = {
      ...emptyAnswerDraft(),
      worked_here_before: { answer: false, when: '2020' },
    };
    const answers = buildAnswersPayload(['worked_here_before'], [], draft, new Set());
    expect(answers.worked_here_before).toEqual({ answer: false });
  });

  it('serializes references, trimming and dropping a blank company', () => {
    const draft: AnswerDraft = {
      ...emptyAnswerDraft(),
      references: [{ name: ' Jo ', relationship: ' Boss ', company: '  ', phone: ' 555-0000 ' }],
    };
    const answers = buildAnswersPayload(['references'], [], draft, new Set());
    expect(answers.references).toEqual([{ name: 'Jo', relationship: 'Boss', phone: '555-0000' }]);
  });

  it('serializes military_service, omitting the extras entirely when served=false', () => {
    const draft: AnswerDraft = {
      ...emptyAnswerDraft(),
      military_service: { served: false, branch: 'Army', from: '', to: '', rank_at_discharge: '', discharge_type: '' },
    };
    const answers = buildAnswersPayload(['military_service'], [], draft, new Set());
    expect(answers.military_service).toEqual({ served: false });
  });
});

describe('repeating group bounds (references/work_history)', () => {
  it('adds up to MAX_REPEATING_ENTRIES and then stops', () => {
    let list: ReturnType<typeof emptyReferenceEntry>[] = [];
    for (let i = 0; i < 5; i += 1) list = addRepeatingEntry(list, emptyReferenceEntry);
    expect(list).toHaveLength(MAX_REPEATING_ENTRIES);
  });

  it('removes by index without disturbing the others', () => {
    const list = [
      { ...emptyReferenceEntry(), name: 'A' },
      { ...emptyReferenceEntry(), name: 'B' },
      { ...emptyReferenceEntry(), name: 'C' },
    ];
    const next = removeRepeatingEntry(list, 1);
    expect(next.map((r) => r.name)).toEqual(['A', 'C']);
  });

  it('MAX_REPEATING_ENTRIES is 3, matching the backend 1-3 bound', () => {
    expect(MAX_REPEATING_ENTRIES).toBe(3);
  });
});
