import { describe, expect, it } from 'vitest';
import {
  REQUIREMENT_DOC_KEYS,
  REQUIREMENT_FIELD_KEYS,
  REQUIREMENT_KEYS,
  initialRequirements,
  requirementsToArrays,
  arraysToRequirements,
  setRequirementState,
  countRequirements,
  certificationHintNames,
  FIELD_GROUPS,
  SENSITIVE_FIELD_KEYS,
} from '@/lib/job-requirements';

describe('initialRequirements', () => {
  it('defaults work_authorization, date_available, emergency_contact, worked_here_before to required', () => {
    const map = initialRequirements();
    expect(map.work_authorization).toBe('required');
    expect(map.date_available).toBe('required');
    expect(map.emergency_contact).toBe('required');
    expect(map.worked_here_before).toBe('required');
  });

  it('defaults every other key to off, including all four doc types', () => {
    const map = initialRequirements();
    const defaultRequired = new Set(['work_authorization', 'date_available', 'emergency_contact', 'worked_here_before']);
    for (const key of REQUIREMENT_KEYS) {
      if (defaultRequired.has(key)) continue;
      expect(map[key]).toBe('off');
    }
  });

  it('covers every doc and field key exactly once', () => {
    const map = initialRequirements();
    expect(Object.keys(map).sort()).toEqual([...REQUIREMENT_KEYS].sort());
  });
});

describe('requirementsToArrays', () => {
  it('splits required/optional docs and fields into the four wire arrays', () => {
    const map = initialRequirements();
    const next = setRequirementState(map, 'resume', 'required');
    const withOptional = setRequirementState(next, 'education', 'optional');
    const arrays = requirementsToArrays(withOptional);
    expect(arrays.required_docs).toEqual(['resume']);
    expect(arrays.optional_fields).toEqual(['education']);
    expect(arrays.required_fields).toEqual(
      expect.arrayContaining(['work_authorization', 'date_available', 'emergency_contact', 'worked_here_before']),
    );
    expect(arrays.optional_docs).toEqual([]);
  });

  it('never lets an "off" key leak into any array', () => {
    const arrays = requirementsToArrays(initialRequirements());
    expect(arrays.required_docs).toEqual([]);
    expect(arrays.optional_docs).toEqual([]);
    expect(arrays.optional_fields).toEqual([]);
  });
});

describe('arraysToRequirements', () => {
  it('round-trips through requirementsToArrays', () => {
    const map = setRequirementState(
      setRequirementState(initialRequirements(), 'certification_doc', 'optional'),
      'references',
      'required',
    );
    const arrays = requirementsToArrays(map);
    const rebuilt = arraysToRequirements(arrays);
    expect(rebuilt).toEqual(map);
  });

  it('defaults every key to off for a legacy payload missing all four arrays', () => {
    const map = arraysToRequirements({});
    for (const key of REQUIREMENT_KEYS) expect(map[key]).toBe('off');
  });

  it('defaults absent keys to off even when the arrays are present but partial', () => {
    const map = arraysToRequirements({ required_fields: ['date_available'] });
    expect(map.date_available).toBe('required');
    expect(map.work_authorization).toBe('off');
    expect(map.resume).toBe('off');
  });

  it('treats a key present in both required and optional as required (the stricter reading)', () => {
    const map = arraysToRequirements({
      required_fields: ['education'],
      optional_fields: ['education'],
    });
    expect(map.education).toBe('required');
  });

  it('migration rule: work_authorization_required=true with an absent required_fields wins work_authorization Required', () => {
    const map = arraysToRequirements({ work_authorization_required: true });
    expect(map.work_authorization).toBe('required');
  });

  it('migration rule does not downgrade an explicit optional/off reading when the flag is false', () => {
    const map = arraysToRequirements({
      required_fields: [],
      optional_fields: ['work_authorization'],
      work_authorization_required: false,
    });
    expect(map.work_authorization).toBe('optional');
  });

  it('migration rule never overrides an explicit optional tier even when the legacy flag is true (required_fields present, just not carrying it)', () => {
    // The array IS present (not undefined) but simply does not include
    // work_authorization at required tier -- optional_fields does. The
    // migration should not clobber that explicit choice.
    const map = arraysToRequirements({
      required_fields: ['date_available'],
      optional_fields: ['work_authorization'],
      work_authorization_required: true,
    });
    expect(map.work_authorization).toBe('optional');
  });

  it('does not throw on null arrays', () => {
    const map = arraysToRequirements({
      required_docs: null,
      optional_docs: null,
      required_fields: null,
      optional_fields: null,
    });
    for (const key of REQUIREMENT_KEYS) expect(map[key]).toBe('off');
  });
});

describe('setRequirementState', () => {
  it('returns a new map and does not mutate the input', () => {
    const map = initialRequirements();
    const next = setRequirementState(map, 'resume', 'required');
    expect(next).not.toBe(map);
    expect(map.resume).toBe('off');
    expect(next.resume).toBe('required');
  });
});

describe('countRequirements', () => {
  it('counts required and optional independently, ignoring off', () => {
    let map = initialRequirements(); // 4 required, 0 optional out of the box
    expect(countRequirements(map)).toEqual({ required: 4, optional: 0 });
    map = setRequirementState(map, 'resume', 'optional');
    map = setRequirementState(map, 'references', 'required');
    expect(countRequirements(map)).toEqual({ required: 5, optional: 1 });
  });

  it('counts zero/zero for an all-off map', () => {
    const map = {} as Record<string, 'off'>;
    for (const key of REQUIREMENT_KEYS) map[key] = 'off';
    expect(countRequirements(map as any)).toEqual({ required: 0, optional: 0 });
  });
});

describe('certificationHintNames', () => {
  it('splits, trims and drops empty entries', () => {
    expect(certificationHintNames('OSHA 10, First Aid ,  , Forklift')).toEqual([
      'OSHA 10', 'First Aid', 'Forklift',
    ]);
  });

  it('returns an empty array for blank input', () => {
    expect(certificationHintNames('')).toEqual([]);
    expect(certificationHintNames('   ')).toEqual([]);
  });
});

describe('vocabulary shape', () => {
  it('has exactly 4 doc keys and 11 field keys, matching the backend vocab', () => {
    expect(REQUIREMENT_DOC_KEYS).toHaveLength(4);
    expect(REQUIREMENT_FIELD_KEYS).toHaveLength(11);
  });

  it('FIELD_GROUPS partitions all 11 field keys with no overlap and no omission', () => {
    const grouped = Object.values(FIELD_GROUPS).flat();
    expect(grouped.sort()).toEqual([...REQUIREMENT_FIELD_KEYS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('marks exactly date_of_birth and home_address as sensitive', () => {
    expect([...SENSITIVE_FIELD_KEYS].sort()).toEqual(['date_of_birth', 'home_address']);
  });
});
