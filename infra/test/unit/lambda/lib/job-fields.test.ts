import {
  APPLICATION_STATUSES,
  DOC_TYPES,
  FIELD_REUSE_POLICY,
  EXPECTED_DURATION_BUCKETS,
  MAX_CERTIFICATION_FILES,
  MAX_CERTIFICATION_FILES_PER_NAME,
  REQUIRED_FIELD_TYPES,
  WORK_DAYS,
  formatPayRangeLocalized,
  isReusableField,
  normalizeApplicationStatus,
  parseJobFields,
  parseOptionalCoordinates,
  parseRequiredFields,
  payNotSpecifiedLabel,
} from '../../../../lambda/lib/job-fields';

const validBody = {
  pay_min: 25,
  pay_max: 30,
  start_date: '2026-06-15',
  transportation_required: false,
  language_preference: ['any'],
  number_of_workers_needed: 3,
  trade_category: 'concrete',
  required_experience_months: 24,
  required_experience_years: 2,
  certifications: ['OSHA 10'],
};

describe('job-fields parser', () => {
  it('accepts the strict MVP hiring-flow field bounds', () => {
    const result = parseJobFields({
      ...validBody,
      pay_min: 9999,
      pay_max: 9999,
      number_of_workers_needed: 500,
      required_experience_years: 80,
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        pay_min: 9999,
        pay_max: 9999,
        number_of_workers_needed: 500,
        required_experience_years: 80,
        required_experience_months: 24,
      }),
    });
  });

  it.each([
    ['June 2026'],
    ['1 Jan 2026'],
    ['2026'],
    ['2026-13-01'],
    ['2026-02-30'],
  ])('rejects ambiguous or invalid start dates: %s', (startDate) => {
    const result = parseJobFields({ ...validBody, start_date: startDate });

    expect(result).toEqual({ ok: false, error: 'invalid_start_date' });
  });

  it.each([
    ['pay_min', 10000, 'invalid_pay_min'],
    ['pay_max', 10000, 'invalid_pay_max'],
    ['number_of_workers_needed', 501, 'invalid_number_of_workers_needed'],
    ['required_experience_years', 81, 'invalid_required_experience_years'],
    ['required_experience_months', 961, 'invalid_required_experience_months'],
  ])('rejects out-of-range %s', (field, value, error) => {
    const result = parseJobFields({ ...validBody, [field]: value });

    expect(result).toEqual({ ok: false, error });
  });

  it('accepts pay intervals and converts legacy required years to canonical months', () => {
    const result = parseJobFields({
      ...validBody,
      pay_interval: 'weekly',
      required_experience_months: undefined,
      required_experience_years: 3,
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        pay_interval: 'weekly',
        required_experience_years: 3,
        required_experience_months: 36,
      }),
    });
  });

  it('rejects invalid pay intervals', () => {
    const result = parseJobFields({ ...validBody, pay_interval: 'biweekly' });

    expect(result).toEqual({
      ok: false,
      error: 'invalid_pay_interval',
      valid: ['hourly', 'daily', 'weekly', 'monthly', 'fixed'],
    });
  });

  it('rejects oversized language preference arrays before normalization', () => {
    const result = parseJobFields({ ...validBody, language_preference: ['en', 'es', 'en', 'es', 'en', 'es', 'en'] });

    expect(result).toEqual({
      ok: false,
      error: 'invalid_language_preference',
      valid: ['any', 'en', 'es'],
    });
  });

  it.each([
    ['too many certifications', Array.from({ length: 21 }, (_, index) => `cert-${index}`)],
    ['oversized certification', ['A'.repeat(201)]],
    ['blank certification', ['OSHA 10', '   ']],
    ['non-string certification', ['OSHA 10', 123]],
  ])('rejects %s', (_caseName, certifications) => {
    const result = parseJobFields({ ...validBody, certifications });

    expect(result).toEqual({ ok: false, error: 'invalid_certifications' });
  });

  it('normalizes legacy application statuses and rejects unknown statuses', () => {
    expect(normalizeApplicationStatus('reviewed')).toBe('contacted');
    expect(normalizeApplicationStatus('rejected')).toBe('not_interested');
    expect(normalizeApplicationStatus('hired')).toBe('hired');
    expect(normalizeApplicationStatus('bogus')).toBeNull();
  });

  // Sprint 23: the stage-2 status. Mirrors job_applications_status_check as
  // rewritten by 091_application_stages.sql BY HAND -- nothing enforces the
  // app-layer list and the DB CHECK stay in sync, and this array is echoed
  // verbatim in the `valid:` field of two 400 bodies
  // (employer-application-status-update.ts, employer-job-applicants.ts).
  it("includes 'details_requested' in APPLICATION_STATUSES, positioned after 'talking'", () => {
    expect(APPLICATION_STATUSES).toEqual([
      'pending', 'contacted', 'talking', 'details_requested', 'hired', 'not_interested',
    ]);
    expect(normalizeApplicationStatus('details_requested')).toBe('details_requested');
  });

  it('keeps the legacy status map pointing at the pre-existing statuses, never at details_requested', () => {
    expect(normalizeApplicationStatus('reviewed')).toBe('contacted');
    expect(normalizeApplicationStatus('rejected')).toBe('not_interested');
  });

  // A-7: 4000-char cap on `description`, shared by employer-jobs-create,
  // employer-jobs-update, and employer-templates-save (all three call
  // parseJobFields with the full request body, so this single check covers
  // all three ride-along paths without touching any of those handlers).
  describe('description length cap', () => {
    it('accepts a description at exactly the 4000-char boundary', () => {
      const result = parseJobFields({ ...validBody, description: 'A'.repeat(4000) });
      expect(result.ok).toBe(true);
    });

    it('rejects a description one character past the 4000-char boundary', () => {
      const result = parseJobFields({ ...validBody, description: 'A'.repeat(4001) });
      expect(result).toEqual({ ok: false, error: 'invalid_description' });
    });

    it('measures the TRIMMED length, so surrounding whitespace cannot smuggle extra characters past the cap', () => {
      const padded = `  ${'A'.repeat(4000)}  `; // trims to exactly 4000
      expect(parseJobFields({ ...validBody, description: padded }).ok).toBe(true);

      const overPadded = `  ${'A'.repeat(4001)}  `; // trims to 4001
      expect(parseJobFields({ ...validBody, description: overPadded })).toEqual({
        ok: false,
        error: 'invalid_description',
      });
    });

    it('ignores an absent description (still optional)', () => {
      expect(parseJobFields({ ...validBody })).toEqual({
        ok: true,
        value: expect.objectContaining({}),
      });
    });
  });

  // BE-T2: six new structured fields from 077_jobs_structured_fields.sql.
  // ADDITIVE wire shape -- a legacy payload (none of the six keys) must parse
  // byte-identically to today, plus the six new keys defaulting to null.
  describe('BE-T2 structured fields — legacy byte-identity', () => {
    it('parses a legacy payload (none of the six new keys) with the six new fields defaulting to null, everything else unchanged', () => {
      const result = parseJobFields({ ...validBody });
      expect(result).toEqual({
        ok: true,
        value: {
          pay_min: 25,
          pay_max: 30,
          pay_interval: null,
          start_date: '2026-06-15',
          expected_duration: null,
          shift_schedule: null,
          transportation_required: false,
          work_authorization_required: false,
          language_preference: ['any'],
          number_of_workers_needed: 3,
          trade_category: 'concrete',
          required_experience_years: 2,
          required_experience_months: 24,
          certifications: ['OSHA 10'],
          trade_category_other: null,
          expected_duration_bucket: null,
          work_days: null,
          shift_start: null,
          shift_end: null,
          certification_requirements: null,
        },
      });
    });
  });

  describe('trade_category_other', () => {
    it("accepts a trimmed value when trade_category is 'other'", () => {
      const result = parseJobFields({ ...validBody, trade_category: 'other', trade_category_other: '  Scaffolding  ' });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ trade_category_other: 'Scaffolding' }) });
    });

    it("does NOT require trade_category_other when trade_category is 'other' (legacy 'other' rows have none)", () => {
      const result = parseJobFields({ ...validBody, trade_category: 'other' });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ trade_category_other: null }) });
    });

    it("rejects a present trade_category_other when trade_category is NOT 'other' (mirrors the one-way DB CHECK)", () => {
      const result = parseJobFields({ ...validBody, trade_category: 'concrete', trade_category_other: 'Scaffolding' });
      expect(result).toEqual({ ok: false, error: 'invalid_trade_category_other' });
    });

    it('rejects a trade_category_other over 200 chars', () => {
      const result = parseJobFields({ ...validBody, trade_category: 'other', trade_category_other: 'A'.repeat(201) });
      expect(result).toEqual({ ok: false, error: 'invalid_trade_category_other' });
    });

    it('accepts a trade_category_other at exactly 200 chars', () => {
      const result = parseJobFields({ ...validBody, trade_category: 'other', trade_category_other: 'A'.repeat(200) });
      expect(result.ok).toBe(true);
    });

    it('treats a whitespace-only trade_category_other as absent (no error) even when trade_category is NOT other', () => {
      // optionalString-first semantics, matching every other optional string
      // field in this file (expected_duration, shift_schedule): blank-after-
      // trim is the same as omitted, not a validation failure.
      const result = parseJobFields({ ...validBody, trade_category: 'concrete', trade_category_other: '   ' });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ trade_category_other: null }) });
    });
  });

  describe('expected_duration_bucket', () => {
    it.each([...EXPECTED_DURATION_BUCKETS])('accepts %s', (bucket) => {
      const result = parseJobFields({ ...validBody, expected_duration_bucket: bucket });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ expected_duration_bucket: bucket }) });
    });

    it('rejects an unknown bucket and echoes the valid list', () => {
      const result = parseJobFields({ ...validBody, expected_duration_bucket: 'never' });
      expect(result).toEqual({ ok: false, error: 'invalid_expected_duration_bucket', valid: EXPECTED_DURATION_BUCKETS });
    });

    it('defaults to null when absent', () => {
      const result = parseJobFields({ ...validBody });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ expected_duration_bucket: null }) });
    });

    it('coexists with the legacy free-text expected_duration column (does not replace it)', () => {
      const result = parseJobFields({ ...validBody, expected_duration: '2 weeks', expected_duration_bucket: '1_2w' });
      expect(result).toEqual({
        ok: true,
        value: expect.objectContaining({ expected_duration: '2 weeks', expected_duration_bucket: '1_2w' }),
      });
    });
  });

  describe('work_days', () => {
    it('accepts a valid subset', () => {
      const result = parseJobFields({ ...validBody, work_days: ['mon', 'wed', 'fri'] });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ work_days: ['mon', 'wed', 'fri'] }) });
    });

    it('accepts all seven days', () => {
      const result = parseJobFields({ ...validBody, work_days: [...WORK_DAYS] });
      expect(result.ok).toBe(true);
    });

    it('accepts an explicit empty array', () => {
      const result = parseJobFields({ ...validBody, work_days: [] });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ work_days: [] }) });
    });

    it('defaults to null when absent', () => {
      const result = parseJobFields({ ...validBody });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ work_days: null }) });
    });

    it('rejects an invalid day and echoes the valid list', () => {
      const result = parseJobFields({ ...validBody, work_days: ['mon', 'someday'] });
      expect(result).toEqual({ ok: false, error: 'invalid_work_days', valid: WORK_DAYS });
    });

    it('rejects duplicate days (no silent de-dup, unlike language_preference)', () => {
      const result = parseJobFields({ ...validBody, work_days: ['mon', 'mon'] });
      expect(result).toEqual({ ok: false, error: 'invalid_work_days', valid: WORK_DAYS });
    });

    it('rejects a non-array value', () => {
      const result = parseJobFields({ ...validBody, work_days: 'mon' });
      expect(result).toEqual({ ok: false, error: 'invalid_work_days', valid: WORK_DAYS });
    });
  });

  describe('shift_start / shift_end', () => {
    it.each(['09:00', '23:59', '00:00'])('accepts %s for shift_start', (value) => {
      const result = parseJobFields({ ...validBody, shift_start: value });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ shift_start: value }) });
    });

    it.each([
      ['24:00'],
      ['9:00'],
      ['09:60'],
      ['abc'],
      [900],
      [''],
    ])('rejects %s for shift_start', (value) => {
      const result = parseJobFields({ ...validBody, shift_start: value });
      expect(result).toEqual({ ok: false, error: 'invalid_shift_start' });
    });

    it.each([
      ['24:00'],
      ['9:00'],
      ['09:60'],
      ['abc'],
      [900],
    ])('rejects %s for shift_end', (value) => {
      const result = parseJobFields({ ...validBody, shift_end: value });
      expect(result).toEqual({ ok: false, error: 'invalid_shift_end' });
    });

    it('both default to null when absent', () => {
      const result = parseJobFields({ ...validBody });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ shift_start: null, shift_end: null }) });
    });

    it('accepts shift_start alone (no cross-check requiring shift_end)', () => {
      const result = parseJobFields({ ...validBody, shift_start: '07:00' });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ shift_start: '07:00', shift_end: null }) });
    });

    it('accepts shift_end alone (no cross-check requiring shift_start)', () => {
      const result = parseJobFields({ ...validBody, shift_end: '15:30' });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ shift_start: null, shift_end: '15:30' }) });
    });

    it('accepts an overnight shift (shift_end before shift_start) — deliberately no same-day CHECK', () => {
      const result = parseJobFields({ ...validBody, shift_start: '22:00', shift_end: '06:00' });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ shift_start: '22:00', shift_end: '06:00' }) });
    });
  });

  describe('certification_requirements', () => {
    const validCert = { name: 'OSHA 30', tier: 'required' as const, proof_required: true };

    it('accepts a valid array', () => {
      const result = parseJobFields({ ...validBody, certification_requirements: [validCert] });
      expect(result).toEqual({
        ok: true,
        value: expect.objectContaining({ certification_requirements: [validCert] }),
      });
    });

    it('trims names and accepts both tiers and boolean proof_required values', () => {
      const result = parseJobFields({
        ...validBody,
        certification_requirements: [
          { name: '  Forklift  ', tier: 'optional', proof_required: false },
        ],
      });
      expect(result).toEqual({
        ok: true,
        value: expect.objectContaining({
          certification_requirements: [{ name: 'Forklift', tier: 'optional', proof_required: false }],
        }),
      });
    });

    it('defaults to null when absent', () => {
      const result = parseJobFields({ ...validBody });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ certification_requirements: null }) });
    });

    it('accepts an explicit empty array', () => {
      const result = parseJobFields({ ...validBody, certification_requirements: [] });
      expect(result).toEqual({ ok: true, value: expect.objectContaining({ certification_requirements: [] }) });
    });

    it('rejects more than 20 entries', () => {
      const many = Array.from({ length: 21 }, (_, i) => ({ name: `Cert ${i}`, tier: 'required' as const, proof_required: false }));
      const result = parseJobFields({ ...validBody, certification_requirements: many });
      expect(result).toEqual({ ok: false, error: 'invalid_certification_requirements' });
    });

    it('accepts exactly 20 entries', () => {
      const twenty = Array.from({ length: 20 }, (_, i) => ({ name: `Cert ${i}`, tier: 'required' as const, proof_required: false }));
      const result = parseJobFields({ ...validBody, certification_requirements: twenty });
      expect(result.ok).toBe(true);
    });

    it('rejects a name over 200 chars', () => {
      const result = parseJobFields({ ...validBody, certification_requirements: [{ name: 'A'.repeat(201), tier: 'required', proof_required: false }] });
      expect(result).toEqual({ ok: false, error: 'invalid_certification_requirements' });
    });

    it('rejects a blank (whitespace-only) name', () => {
      const result = parseJobFields({ ...validBody, certification_requirements: [{ name: '   ', tier: 'required', proof_required: false }] });
      expect(result).toEqual({ ok: false, error: 'invalid_certification_requirements' });
    });

    it('rejects a non-string name', () => {
      const result = parseJobFields({ ...validBody, certification_requirements: [{ name: 123, tier: 'required', proof_required: false }] });
      expect(result).toEqual({ ok: false, error: 'invalid_certification_requirements' });
    });

    it('rejects an invalid tier', () => {
      const result = parseJobFields({ ...validBody, certification_requirements: [{ name: 'OSHA 10', tier: 'mandatory', proof_required: false }] });
      expect(result).toEqual({ ok: false, error: 'invalid_certification_requirements' });
    });

    it('rejects a non-boolean proof_required', () => {
      const result = parseJobFields({ ...validBody, certification_requirements: [{ name: 'OSHA 10', tier: 'required', proof_required: 'yes' }] });
      expect(result).toEqual({ ok: false, error: 'invalid_certification_requirements' });
    });

    it('rejects duplicate names case-insensitively', () => {
      const result = parseJobFields({
        ...validBody,
        certification_requirements: [
          { name: 'OSHA 10', tier: 'required', proof_required: false },
          { name: 'osha 10', tier: 'optional', proof_required: true },
        ],
      });
      expect(result).toEqual({ ok: false, error: 'invalid_certification_requirements' });
    });

    it('rejects a non-array value', () => {
      const result = parseJobFields({ ...validBody, certification_requirements: 'OSHA 10' });
      expect(result).toEqual({ ok: false, error: 'invalid_certification_requirements' });
    });

    describe('derivation of certifications', () => {
      it('derives certifications from names when present and non-empty, ignoring any client-supplied certifications', () => {
        const result = parseJobFields({
          ...validBody,
          certifications: ['Stale Legacy Cert'],
          certification_requirements: [
            { name: 'OSHA 30', tier: 'required', proof_required: true },
            { name: 'Forklift', tier: 'optional', proof_required: false },
          ],
        });
        expect(result).toEqual({
          ok: true,
          value: expect.objectContaining({ certifications: ['OSHA 30', 'Forklift'] }),
        });
      });

      it('ignores (does not even validate) a hostile client-supplied certifications value when certification_requirements is present and non-empty', () => {
        const result = parseJobFields({
          ...validBody,
          certifications: ['A'.repeat(501), 123, '   '], // would fail legacy validation on its own
          certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
        });
        expect(result).toEqual({
          ok: true,
          value: expect.objectContaining({ certifications: ['OSHA 30'] }),
        });
      });

      it('preserves legacy certifications behavior (including client-supplied values) when certification_requirements is absent', () => {
        const result = parseJobFields({ ...validBody, certifications: ['OSHA 10'] });
        expect(result).toEqual({ ok: true, value: expect.objectContaining({ certifications: ['OSHA 10'] }) });
      });

      it('preserves legacy certifications behavior when certification_requirements is present but empty', () => {
        const result = parseJobFields({ ...validBody, certifications: ['OSHA 10'], certification_requirements: [] });
        expect(result).toEqual({
          ok: true,
          value: expect.objectContaining({ certifications: ['OSHA 10'], certification_requirements: [] }),
        });
      });
    });

    describe('doc-conflict rule (no double-gating certification_doc)', () => {
      it('rejects when certification_doc is in required_docs and certification_requirements is present and non-empty', () => {
        const result = parseJobFields({
          ...validBody,
          required_docs: ['certification_doc'],
          certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
        });
        expect(result).toEqual({ ok: false, error: 'invalid_certification_requirements_doc_conflict' });
      });

      it('rejects when certification_doc is in optional_docs and certification_requirements is present and non-empty', () => {
        const result = parseJobFields({
          ...validBody,
          optional_docs: ['certification_doc'],
          certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
        });
        expect(result).toEqual({ ok: false, error: 'invalid_certification_requirements_doc_conflict' });
      });

      it('does NOT conflict when certification_requirements is present but empty, even with certification_doc in required_docs', () => {
        const result = parseJobFields({
          ...validBody,
          required_docs: ['certification_doc'],
          certification_requirements: [],
        });
        expect(result.ok).toBe(true);
      });

      it('does NOT conflict when required_docs/optional_docs are absent', () => {
        const result = parseJobFields({
          ...validBody,
          certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
        });
        expect(result.ok).toBe(true);
      });

      it('does NOT conflict when required_docs/optional_docs contain other doc types only', () => {
        const result = parseJobFields({
          ...validBody,
          required_docs: ['resume'],
          optional_docs: ['driver_license'],
          certification_requirements: [{ name: 'OSHA 30', tier: 'required', proof_required: true }],
        });
        expect(result.ok).toBe(true);
      });
    });
  });

  describe('MAX_CERTIFICATION_FILES / MAX_CERTIFICATION_FILES_PER_NAME (078)', () => {
    it('MAX_CERTIFICATION_FILES is 20 -- the TOTAL-per-slot cap raised by 078_worker_documents_cert_name.sql', () => {
      expect(MAX_CERTIFICATION_FILES).toBe(20);
    });

    it('MAX_CERTIFICATION_FILES_PER_NAME is 5 -- the per-name cap introduced by 078_worker_documents_cert_name.sql', () => {
      expect(MAX_CERTIFICATION_FILES_PER_NAME).toBe(5);
    });
  });
});

describe('EXPECTED_DURATION_BUCKETS / WORK_DAYS (077 CHECK byte-match)', () => {
  it('EXPECTED_DURATION_BUCKETS byte-matches the jobs_expected_duration_bucket_valid CHECK', () => {
    expect(EXPECTED_DURATION_BUCKETS).toEqual(['lt_1w', '1_2w', '2_4w', '1_3m', '3_6m', '6m_plus', 'ongoing']);
  });

  it('WORK_DAYS byte-matches the jobs_work_days_valid CHECK', () => {
    expect(WORK_DAYS).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });
});

describe('parseOptionalCoordinates', () => {
  it('returns null when neither coordinate is present', () => {
    expect(parseOptionalCoordinates({ title: 'Framer' })).toEqual({ ok: true, value: null });
  });

  it('accepts a complete, in-range pair', () => {
    expect(parseOptionalCoordinates({ latitude: 30.27, longitude: -97.74 }))
      .toEqual({ ok: true, value: { latitude: 30.27, longitude: -97.74 } });
  });

  it('accepts the exact bounds', () => {
    expect(parseOptionalCoordinates({ latitude: -90, longitude: 180 }))
      .toEqual({ ok: true, value: { latitude: -90, longitude: 180 } });
  });

  it.each([
    ['only latitude', { latitude: 30.27 }],
    ['only longitude', { longitude: -97.74 }],
  ])('rejects %s with invalid_coordinates', (_caseName, body) => {
    expect(parseOptionalCoordinates(body)).toEqual({ ok: false, error: 'invalid_coordinates' });
  });

  it.each([
    ['out-of-range high latitude', { latitude: 91, longitude: -97.74 }],
    ['out-of-range low latitude', { latitude: -91, longitude: -97.74 }],
    ['non-numeric latitude', { latitude: '30.27', longitude: -97.74 }],
    ['non-finite latitude', { latitude: Number.POSITIVE_INFINITY, longitude: -97.74 }],
  ])('rejects %s with invalid_latitude', (_caseName, body) => {
    expect(parseOptionalCoordinates(body)).toEqual({ ok: false, error: 'invalid_latitude' });
  });

  it.each([
    ['out-of-range high longitude', { latitude: 30.27, longitude: 181 }],
    ['out-of-range low longitude', { latitude: 30.27, longitude: -181 }],
    ['non-numeric longitude', { latitude: 30.27, longitude: '-97.74' }],
    ['non-finite longitude', { latitude: 30.27, longitude: Number.NaN }],
  ])('rejects %s with invalid_longitude', (_caseName, body) => {
    expect(parseOptionalCoordinates(body)).toEqual({ ok: false, error: 'invalid_longitude' });
  });

  it('treats an explicitly null coordinate as present, not absent', () => {
    // hasOwnProperty semantics: { latitude: null, longitude: null } is a malformed
    // pair, not an omission — it must not silently parse as "no coordinates".
    expect(parseOptionalCoordinates({ latitude: null, longitude: null }))
      .toEqual({ ok: false, error: 'invalid_latitude' });
  });
});

describe('formatPayRangeLocalized', () => {
  it('returns null when both bounds are null, for either locale', () => {
    expect(formatPayRangeLocalized(null, null, null, 'en')).toBeNull();
    expect(formatPayRangeLocalized(null, null, null, 'es')).toBeNull();
    expect(formatPayRangeLocalized(null, null, 'hourly', 'es')).toBeNull();
  });

  it('renders a "From"/"Desde" one-sided range when only pay_min is set', () => {
    expect(formatPayRangeLocalized(15, null, null, 'en')).toBe('From $15');
    expect(formatPayRangeLocalized(15, null, null, 'es')).toBe('Desde $15');
  });

  it('renders an "Up to"/"Hasta" one-sided range when only pay_max is set', () => {
    expect(formatPayRangeLocalized(null, 20, null, 'en')).toBe('Up to $20');
    expect(formatPayRangeLocalized(null, 20, null, 'es')).toBe('Hasta $20');
  });

  it('collapses to a single figure when pay_min equals pay_max', () => {
    expect(formatPayRangeLocalized(15, 15, null, 'en')).toBe('$15');
    expect(formatPayRangeLocalized(15, 15, null, 'es')).toBe('$15');
  });

  it('renders a full range when pay_min and pay_max differ', () => {
    expect(formatPayRangeLocalized(15, 20, null, 'en')).toBe('$15-$20');
    expect(formatPayRangeLocalized(15, 20, null, 'es')).toBe('$15-$20');
  });

  it.each([
    ['hourly', '/hour', '/hora'],
    ['daily', '/day', '/dia'],
    ['weekly', '/week', '/semana'],
    ['monthly', '/month', '/mes'],
  ] as const)('appends the %s interval as a per-unit suffix in both locales', (interval, enSuffix, esSuffix) => {
    expect(formatPayRangeLocalized(15, 20, interval, 'en')).toBe(`$15-$20${enSuffix}`);
    expect(formatPayRangeLocalized(15, 20, interval, 'es')).toBe(`$15-$20${esSuffix}`);
  });

  it('renders the fixed interval as a parenthetical qualifier, not a per-unit suffix', () => {
    expect(formatPayRangeLocalized(500, 500, 'fixed', 'en')).toBe('$500 (fixed)');
    expect(formatPayRangeLocalized(500, 500, 'fixed', 'es')).toBe('$500 (fijo)');
  });

  it('ignores an unknown/unrecognized interval rather than appending a suffix', () => {
    expect(formatPayRangeLocalized(15, 20, 'biweekly', 'en')).toBe('$15-$20');
    expect(formatPayRangeLocalized(15, 20, 'biweekly', 'es')).toBe('$15-$20');
  });
});

describe('payNotSpecifiedLabel', () => {
  it('returns the localized "not specified" placeholder for each locale', () => {
    expect(payNotSpecifiedLabel('en')).toBe('Pay not specified');
    expect(payNotSpecifiedLabel('es')).toBe('Pago no especificado');
  });
});

describe('DOC_TYPES', () => {
  it('contains the two new document types', () => {
    expect(DOC_TYPES).toContain('work_auth_doc');
    expect(DOC_TYPES).toContain('certification_doc');
  });

  it('never contains ssn', () => {
    expect(DOC_TYPES).not.toContain('ssn');
  });
});

describe('parseRequiredFields', () => {
  it('accepts a valid subset of REQUIRED_FIELD_TYPES', () => {
    const result = parseRequiredFields(['work_authorization', 'date_available']);
    expect(result).toEqual({ ok: true, value: ['work_authorization', 'date_available'] });
  });

  it('accepts all eleven required field types', () => {
    const result = parseRequiredFields([...REQUIRED_FIELD_TYPES]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sort()).toEqual([...REQUIRED_FIELD_TYPES].sort());
    }
  });

  it('rejects an invalid key and echoes the valid list', () => {
    const result = parseRequiredFields(['work_authorization', 'not_a_real_field']);
    expect(result).toEqual({
      ok: false,
      error: 'invalid_required_fields',
      valid: REQUIRED_FIELD_TYPES,
    });
  });

  it('treats undefined as an empty array', () => {
    expect(parseRequiredFields(undefined)).toEqual({ ok: true, value: [] });
  });

  it('dedupes repeated entries', () => {
    const result = parseRequiredFields(['education', 'education', 'references']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sort()).toEqual(['education', 'references']);
    }
  });

  it('rejects non-array values', () => {
    expect(parseRequiredFields('work_authorization')).toEqual({
      ok: false,
      error: 'invalid_required_fields',
      valid: REQUIRED_FIELD_TYPES,
    });
    expect(parseRequiredFields({ work_authorization: true })).toEqual({
      ok: false,
      error: 'invalid_required_fields',
      valid: REQUIRED_FIELD_TYPES,
    });
    expect(parseRequiredFields(null)).toEqual({
      ok: false,
      error: 'invalid_required_fields',
      valid: REQUIRED_FIELD_TYPES,
    });
  });

  it('rejects non-string array entries', () => {
    expect(parseRequiredFields(['work_authorization', 123])).toEqual({
      ok: false,
      error: 'invalid_required_fields',
      valid: REQUIRED_FIELD_TYPES,
    });
  });
});

// ── L3: cross-job reuse policy (decision D2) ─────────────────────────────
//
// The 2026-09-04 incident: the single per-worker
// `worker_application_defaults.answers` blob was seeded into, and written
// back from, EVERY answered field of EVERY application -- so an employer saw
// answers ("worked here before", "date available") the worker had given for
// a DIFFERENT job. This policy is the one place that decides which keys may
// legitimately cross a job/employer boundary.
describe('FIELD_REUSE_POLICY / isReusableField', () => {
  it('classifies every one of the 11 catalog keys, and nothing else', () => {
    expect(Object.keys(FIELD_REUSE_POLICY).sort()).toEqual([...REQUIRED_FIELD_TYPES].sort());
  });

  it('marks exactly the seven job-independent keys stable (decision D2)', () => {
    const stable = REQUIRED_FIELD_TYPES.filter((key) => FIELD_REUSE_POLICY[key] === 'stable');
    expect([...stable].sort()).toEqual([
      'date_of_birth', 'education', 'home_address', 'military_service',
      'references', 'work_authorization', 'work_history',
    ]);
  });

  it('marks exactly the four job/employer-specific keys per_application (decision D2)', () => {
    const perApplication = REQUIRED_FIELD_TYPES.filter((key) => FIELD_REUSE_POLICY[key] === 'per_application');
    expect([...perApplication].sort()).toEqual([
      'date_available', 'desired_pay', 'emergency_contact', 'worked_here_before',
    ]);
  });

  it('isReusableField agrees with the policy for every catalog key', () => {
    for (const key of REQUIRED_FIELD_TYPES) {
      expect(isReusableField(key)).toBe(FIELD_REUSE_POLICY[key] === 'stable');
    }
  });

  it('isReusableField refuses anything outside the catalog -- including the reserved certifications key and prototype keys', () => {
    expect(isReusableField('certifications')).toBe(false);
    expect(isReusableField('ssn')).toBe(false);
    expect(isReusableField('__proto__')).toBe(false);
    expect(isReusableField('constructor')).toBe(false);
    expect(isReusableField('toString')).toBe(false);
    expect(isReusableField('')).toBe(false);
  });
});
