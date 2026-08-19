import { EDUCATION_LEVELS, validateApplicationAnswers } from '../../../../lambda/lib/application-answers';
import { REQUIRED_FIELD_TYPES } from '../../../../lambda/lib/job-fields';

function daysAgoIso(years: number, dayOffset = 0): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() + dayOffset));
  return date.toISOString().slice(0, 10);
}

const validAnswers = {
  work_authorization: true,
  date_available: '2026-09-01',
  desired_pay: { amount: 25, interval: 'hourly' },
  home_address: { street: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
  date_of_birth: daysAgoIso(30),
  emergency_contact: { name: 'Jane Doe', phone: '512-555-0100' },
  worked_here_before: { answer: false },
  education: { level: 'high_school' },
  references: [{ name: 'Bob Ref', relationship: 'Former manager', phone: '512-555-0101' }],
  work_history: [{ company: 'Acme Co', title: 'Laborer' }],
  military_service: { served: false },
};

const ALL_FIELDS = [...REQUIRED_FIELD_TYPES];

describe('validateApplicationAnswers', () => {
  it('accepts a complete happy-path answer set for all eleven required fields', () => {
    const result = validateApplicationAnswers(ALL_FIELDS, validAnswers);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual([...ALL_FIELDS].sort());
      expect(result.value.date_available).toBe('2026-09-01');
      expect(result.value.desired_pay).toEqual({ amount: 25, interval: 'hourly' });
    }
  });

  it('returns a value built fresh containing only the validated keys (never spreads the input)', () => {
    const polluted = { ...validAnswers, extraneous_junk: 'should not appear' } as Record<string, unknown>;
    // extraneous_junk is not in requiredFields, so this must be rejected...
    expect(validateApplicationAnswers(ALL_FIELDS, polluted)).toEqual({ ok: false, error: 'unknown_answer_key' });

    // ...but even on the happy path, the returned value must contain
    // exactly the required keys, never anything extra smuggled through.
    const result = validateApplicationAnswers(ALL_FIELDS, validAnswers);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.value)).toHaveLength(ALL_FIELDS.length);
    }
  });

  describe('answers container validation', () => {
    it('rejects an array', () => {
      expect(validateApplicationAnswers(ALL_FIELDS, [])).toEqual({ ok: false, error: 'invalid_answers' });
    });

    it('rejects null', () => {
      expect(validateApplicationAnswers(ALL_FIELDS, null)).toEqual({ ok: false, error: 'invalid_answers' });
    });

    it('rejects non-objects', () => {
      expect(validateApplicationAnswers(ALL_FIELDS, 'nope')).toEqual({ ok: false, error: 'invalid_answers' });
      expect(validateApplicationAnswers(ALL_FIELDS, 42)).toEqual({ ok: false, error: 'invalid_answers' });
      expect(validateApplicationAnswers(ALL_FIELDS, undefined)).toEqual({ ok: false, error: 'invalid_answers' });
    });

    it('rejects an oversized answers payload', () => {
      const oversized = { work_authorization: 'A'.repeat(20000) };
      expect(validateApplicationAnswers(['work_authorization'], oversized)).toEqual({ ok: false, error: 'invalid_answers' });
    });
  });

  describe('unknown / hostile keys', () => {
    it('rejects a key not present in requiredFields', () => {
      const result = validateApplicationAnswers(['work_authorization'], {
        work_authorization: true,
        date_available: '2026-09-01',
      });
      expect(result).toEqual({ ok: false, error: 'unknown_answer_key' });
    });

    it('rejects a __proto__ key', () => {
      const hostile = JSON.parse('{"__proto__": {"polluted": true}, "work_authorization": true}');
      const result = validateApplicationAnswers(['work_authorization'], hostile);
      expect(result).toEqual({ ok: false, error: 'unknown_answer_key' });
    });

    it('rejects a constructor key', () => {
      const hostile = JSON.parse('{"constructor": {"polluted": true}, "work_authorization": true}');
      const result = validateApplicationAnswers(['work_authorization'], hostile);
      expect(result).toEqual({ ok: false, error: 'unknown_answer_key' });
    });
  });

  describe('missing_answers', () => {
    it('lists every missing required field', () => {
      const result = validateApplicationAnswers(['work_authorization', 'date_available'], {
        work_authorization: true,
      });
      expect(result).toEqual({ ok: false, error: 'missing_answers', missing: ['date_available'] });
    });

    it('lists multiple missing fields', () => {
      const result = validateApplicationAnswers(['work_authorization', 'date_available', 'desired_pay'], {});
      expect(result).toEqual({
        ok: false,
        error: 'missing_answers',
        missing: ['work_authorization', 'date_available', 'desired_pay'],
      });
    });
  });

  describe('work_authorization', () => {
    it('accepts boolean true/false', () => {
      expect(validateApplicationAnswers(['work_authorization'], { work_authorization: true }).ok).toBe(true);
      expect(validateApplicationAnswers(['work_authorization'], { work_authorization: false }).ok).toBe(true);
    });

    it('rejects non-boolean', () => {
      expect(validateApplicationAnswers(['work_authorization'], { work_authorization: 'yes' })).toEqual({
        ok: false,
        error: 'invalid_work_authorization',
      });
    });
  });

  describe('date_available', () => {
    it('accepts a valid ISO date', () => {
      expect(validateApplicationAnswers(['date_available'], { date_available: '2026-12-25' }).ok).toBe(true);
    });

    it.each([
      ['not a date', 'soon'],
      ['invalid calendar date', '2026-02-30'],
      ['wrong format', '12/25/2026'],
      ['non-string', 123],
    ])('rejects %s', (_case, value) => {
      expect(validateApplicationAnswers(['date_available'], { date_available: value })).toEqual({
        ok: false,
        error: 'invalid_date_available',
      });
    });
  });

  describe('desired_pay', () => {
    it('accepts boundary amounts 0 and 9999', () => {
      expect(validateApplicationAnswers(['desired_pay'], { desired_pay: { amount: 0, interval: 'hourly' } }).ok).toBe(true);
      expect(validateApplicationAnswers(['desired_pay'], { desired_pay: { amount: 9999, interval: 'fixed' } }).ok).toBe(true);
    });

    it('rejects amount out of range', () => {
      expect(validateApplicationAnswers(['desired_pay'], { desired_pay: { amount: -1, interval: 'hourly' } })).toEqual({
        ok: false,
        error: 'invalid_desired_pay',
      });
      expect(validateApplicationAnswers(['desired_pay'], { desired_pay: { amount: 10000, interval: 'hourly' } })).toEqual({
        ok: false,
        error: 'invalid_desired_pay',
      });
    });

    it('rejects a non-integer amount', () => {
      expect(validateApplicationAnswers(['desired_pay'], { desired_pay: { amount: 25.5, interval: 'hourly' } })).toEqual({
        ok: false,
        error: 'invalid_desired_pay',
      });
    });

    it('rejects an invalid interval', () => {
      expect(validateApplicationAnswers(['desired_pay'], { desired_pay: { amount: 25, interval: 'biweekly' } })).toEqual({
        ok: false,
        error: 'invalid_desired_pay',
      });
    });

    it('rejects unknown sub-keys', () => {
      expect(
        validateApplicationAnswers(['desired_pay'], { desired_pay: { amount: 25, interval: 'hourly', bonus: 5 } }),
      ).toEqual({ ok: false, error: 'invalid_desired_pay' });
    });
  });

  describe('date_of_birth', () => {
    it('accepts a reasonable adult date of birth', () => {
      expect(validateApplicationAnswers(['date_of_birth'], { date_of_birth: daysAgoIso(30) }).ok).toBe(true);
    });

    it('accepts exactly 120 years ago as the boundary', () => {
      expect(validateApplicationAnswers(['date_of_birth'], { date_of_birth: daysAgoIso(120) }).ok).toBe(true);
    });

    it('rejects more than 120 years ago', () => {
      expect(validateApplicationAnswers(['date_of_birth'], { date_of_birth: daysAgoIso(121) })).toEqual({
        ok: false,
        error: 'invalid_date_of_birth',
      });
    });

    it('rejects today', () => {
      expect(validateApplicationAnswers(['date_of_birth'], { date_of_birth: daysAgoIso(0) })).toEqual({
        ok: false,
        error: 'invalid_date_of_birth',
      });
    });

    it('rejects a future date', () => {
      expect(validateApplicationAnswers(['date_of_birth'], { date_of_birth: daysAgoIso(0, 1) })).toEqual({
        ok: false,
        error: 'invalid_date_of_birth',
      });
    });

    it('rejects a malformed date', () => {
      expect(validateApplicationAnswers(['date_of_birth'], { date_of_birth: '2026-13-40' })).toEqual({
        ok: false,
        error: 'invalid_date_of_birth',
      });
    });
  });

  describe('home_address', () => {
    const base = { street: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' };

    it('accepts a valid address without apartment', () => {
      expect(validateApplicationAnswers(['home_address'], { home_address: base }).ok).toBe(true);
    });

    it('accepts a valid address with apartment', () => {
      expect(
        validateApplicationAnswers(['home_address'], { home_address: { ...base, apartment: 'Apt 4B' } }).ok,
      ).toBe(true);
    });

    it('accepts a 5+4 extended zip', () => {
      expect(
        validateApplicationAnswers(['home_address'], { home_address: { ...base, zip: '78701-1234' } }).ok,
      ).toBe(true);
    });

    it.each([
      ['blank street', { ...base, street: '' }],
      ['whitespace-only street', { ...base, street: '   ' }],
      ['oversized street', { ...base, street: 'A'.repeat(201) }],
      ['blank city', { ...base, city: '' }],
      ['oversized city', { ...base, city: 'A'.repeat(101) }],
      ['lowercase state', { ...base, state: 'tx' }],
      ['three-letter state', { ...base, state: 'TEX' }],
      ['malformed zip', { ...base, zip: '1234' }],
      ['malformed extended zip', { ...base, zip: '78701-123' }],
      ['unknown sub-key', { ...base, country: 'US' }],
    ])('rejects %s', (_case, address) => {
      expect(validateApplicationAnswers(['home_address'], { home_address: address })).toEqual({
        ok: false,
        error: 'invalid_home_address',
      });
    });
  });

  describe('emergency_contact', () => {
    it('accepts a valid contact', () => {
      expect(
        validateApplicationAnswers(['emergency_contact'], {
          emergency_contact: { name: 'Jane Doe', phone: '(512) 555-0100' },
        }).ok,
      ).toBe(true);
    });

    it.each([
      ['blank name', { name: '', phone: '5125550100' }],
      ['whitespace-only name', { name: '   ', phone: '5125550100' }],
      ['oversized name', { name: 'A'.repeat(101), phone: '5125550100' }],
      ['too-short phone', { name: 'Jane', phone: '12345' }],
      ['too-long phone', { name: 'Jane', phone: '1'.repeat(21) }],
      ['phone with letters', { name: 'Jane', phone: 'call-me-maybe' }],
      ['missing phone', { name: 'Jane' }],
    ])('rejects %s', (_case, contact) => {
      expect(validateApplicationAnswers(['emergency_contact'], { emergency_contact: contact })).toEqual({
        ok: false,
        error: 'invalid_emergency_contact',
      });
    });
  });

  describe('worked_here_before', () => {
    it('accepts answer alone', () => {
      expect(validateApplicationAnswers(['worked_here_before'], { worked_here_before: { answer: true } }).ok).toBe(true);
    });

    it('accepts answer with when', () => {
      expect(
        validateApplicationAnswers(['worked_here_before'], { worked_here_before: { answer: true, when: '2022' } }).ok,
      ).toBe(true);
    });

    it('rejects non-boolean answer', () => {
      expect(validateApplicationAnswers(['worked_here_before'], { worked_here_before: { answer: 'yes' } })).toEqual({
        ok: false,
        error: 'invalid_worked_here_before',
      });
    });

    it('rejects oversized when', () => {
      expect(
        validateApplicationAnswers(['worked_here_before'], { worked_here_before: { answer: true, when: 'A'.repeat(101) } }),
      ).toEqual({ ok: false, error: 'invalid_worked_here_before' });
    });
  });

  describe('education', () => {
    it.each([...EDUCATION_LEVELS])('accepts level %s', (level) => {
      expect(validateApplicationAnswers(['education'], { education: { level } }).ok).toBe(true);
    });

    it('accepts an optional graduated flag', () => {
      expect(
        validateApplicationAnswers(['education'], { education: { level: 'college', graduated: true } }).ok,
      ).toBe(true);
    });

    it('rejects an invalid level', () => {
      expect(validateApplicationAnswers(['education'], { education: { level: 'phd' } })).toEqual({
        ok: false,
        error: 'invalid_education',
      });
    });

    it('rejects a non-boolean graduated flag', () => {
      expect(
        validateApplicationAnswers(['education'], { education: { level: 'college', graduated: 'yes' } }),
      ).toEqual({ ok: false, error: 'invalid_education' });
    });
  });

  describe('references', () => {
    const ref = { name: 'Bob Ref', relationship: 'Manager', phone: '5125550100' };

    it('accepts exactly 1 reference', () => {
      expect(validateApplicationAnswers(['references'], { references: [ref] }).ok).toBe(true);
    });

    it('accepts exactly 3 references (boundary)', () => {
      expect(validateApplicationAnswers(['references'], { references: [ref, ref, ref] }).ok).toBe(true);
    });

    it('rejects 4 references (past the boundary)', () => {
      expect(validateApplicationAnswers(['references'], { references: [ref, ref, ref, ref] })).toEqual({
        ok: false,
        error: 'invalid_references',
      });
    });

    it('rejects 0 references (empty array)', () => {
      expect(validateApplicationAnswers(['references'], { references: [] })).toEqual({
        ok: false,
        error: 'invalid_references',
      });
    });

    it('rejects a non-array', () => {
      expect(validateApplicationAnswers(['references'], { references: ref })).toEqual({
        ok: false,
        error: 'invalid_references',
      });
    });

    it('accepts an optional company', () => {
      expect(
        validateApplicationAnswers(['references'], { references: [{ ...ref, company: 'Acme' }] }).ok,
      ).toBe(true);
    });

    it('rejects a reference missing a required key', () => {
      expect(validateApplicationAnswers(['references'], { references: [{ name: 'Bob Ref' }] })).toEqual({
        ok: false,
        error: 'invalid_references',
      });
    });

    it('rejects a reference with an unknown sub-key', () => {
      expect(validateApplicationAnswers(['references'], { references: [{ ...ref, notes: 'x' }] })).toEqual({
        ok: false,
        error: 'invalid_references',
      });
    });
  });

  describe('work_history', () => {
    const job = { company: 'Acme Co', title: 'Laborer' };

    it('accepts exactly 1 entry with only required keys', () => {
      expect(validateApplicationAnswers(['work_history'], { work_history: [job] }).ok).toBe(true);
    });

    it('accepts exactly 3 entries (boundary)', () => {
      expect(validateApplicationAnswers(['work_history'], { work_history: [job, job, job] }).ok).toBe(true);
    });

    it('rejects 4 entries (past the boundary)', () => {
      expect(validateApplicationAnswers(['work_history'], { work_history: [job, job, job, job] })).toEqual({
        ok: false,
        error: 'invalid_work_history',
      });
    });

    it('accepts all optional fields', () => {
      const full = {
        ...job,
        from: '2020',
        to: '2022',
        responsibilities: 'Framing and demo',
        reason_for_leaving: 'Relocated',
        may_contact: true,
      };
      expect(validateApplicationAnswers(['work_history'], { work_history: [full] }).ok).toBe(true);
    });

    it('rejects an oversized responsibilities field', () => {
      expect(
        validateApplicationAnswers(['work_history'], {
          work_history: [{ ...job, responsibilities: 'A'.repeat(501) }],
        }),
      ).toEqual({ ok: false, error: 'invalid_work_history' });
    });

    it('rejects a non-boolean may_contact', () => {
      expect(
        validateApplicationAnswers(['work_history'], { work_history: [{ ...job, may_contact: 'sure' }] }),
      ).toEqual({ ok: false, error: 'invalid_work_history' });
    });

    it('rejects an entry missing a required key', () => {
      expect(validateApplicationAnswers(['work_history'], { work_history: [{ company: 'Acme Co' }] })).toEqual({
        ok: false,
        error: 'invalid_work_history',
      });
    });
  });

  describe('military_service', () => {
    it('accepts served: false alone', () => {
      expect(validateApplicationAnswers(['military_service'], { military_service: { served: false } }).ok).toBe(true);
    });

    it('accepts served: true with all optional details', () => {
      expect(
        validateApplicationAnswers(['military_service'], {
          military_service: {
            served: true,
            branch: 'Army',
            from: '2015',
            to: '2019',
            rank_at_discharge: 'Sergeant',
            discharge_type: 'Honorable',
          },
        }).ok,
      ).toBe(true);
    });

    it('rejects a non-boolean served', () => {
      expect(validateApplicationAnswers(['military_service'], { military_service: { served: 'yes' } })).toEqual({
        ok: false,
        error: 'invalid_military_service',
      });
    });

    it('rejects an oversized branch', () => {
      expect(
        validateApplicationAnswers(['military_service'], { military_service: { served: true, branch: 'A'.repeat(51) } }),
      ).toEqual({ ok: false, error: 'invalid_military_service' });
    });

    it('rejects an unknown sub-key', () => {
      expect(
        validateApplicationAnswers(['military_service'], { military_service: { served: false, medals: 'many' } }),
      ).toEqual({ ok: false, error: 'invalid_military_service' });
    });
  });
});
