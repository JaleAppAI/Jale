import {
  findCertificationProofGaps,
  parseCertificationRequirements,
  validateCertificationClaims,
  type CertificationRequirement,
} from '../../../../lambda/lib/certification-claims';

const DOC_ID_1 = '11111111-1111-1111-1111-111111111111';
const DOC_ID_2 = '22222222-2222-2222-2222-222222222222';

const requiredNoProof: CertificationRequirement = { name: 'osha10', tier: 'required', proof_required: false };
const requiredWithProof: CertificationRequirement = { name: 'osha30', tier: 'required', proof_required: true };
const optionalNoProof: CertificationRequirement = { name: 'forklift', tier: 'optional', proof_required: false };
const optionalWithProof: CertificationRequirement = { name: 'crane', tier: 'optional', proof_required: true };

describe('parseCertificationRequirements', () => {
  it('parses a well-formed array', () => {
    const raw = [
      { name: 'osha10', tier: 'required', proof_required: false },
      { name: 'crane', tier: 'optional', proof_required: true },
    ];
    expect(parseCertificationRequirements(raw)).toEqual([
      { name: 'osha10', tier: 'required', proof_required: false },
      { name: 'crane', tier: 'optional', proof_required: true },
    ]);
  });

  it('fails open to [] for a non-array value (null, object, string)', () => {
    expect(parseCertificationRequirements(null)).toEqual([]);
    expect(parseCertificationRequirements(undefined)).toEqual([]);
    expect(parseCertificationRequirements({})).toEqual([]);
    expect(parseCertificationRequirements('osha10')).toEqual([]);
  });

  it('drops individual malformed entries rather than throwing', () => {
    const raw = [
      { name: 'osha10', tier: 'required', proof_required: false },
      { name: '', tier: 'required', proof_required: false }, // empty name
      { name: 'x', tier: 'bogus', proof_required: false }, // bad tier
      { name: 'y', tier: 'required', proof_required: 'yes' }, // bad proof_required type
      'not an object',
      null,
      { tier: 'required', proof_required: false }, // missing name
    ];
    expect(parseCertificationRequirements(raw)).toEqual([
      { name: 'osha10', tier: 'required', proof_required: false },
    ]);
  });
});

describe('validateCertificationClaims', () => {
  it('accepts an empty claims payload when there are no requirements', () => {
    const result = validateCertificationClaims(undefined, []);
    expect(result).toEqual({ ok: true, certifications: [] });
  });

  it('rejects a non-array claims payload', () => {
    expect(validateCertificationClaims('nope', [requiredNoProof])).toEqual({
      ok: false,
      error: 'invalid_certification_claims',
    });
    expect(validateCertificationClaims({ name: 'osha10' }, [requiredNoProof])).toEqual({
      ok: false,
      error: 'invalid_certification_claims',
    });
  });

  it('rejects a claim entry missing required fields or with wrong types', () => {
    expect(validateCertificationClaims([{ name: 'osha10' }], [requiredNoProof])).toEqual({
      ok: false,
      error: 'invalid_certification_claims',
    });
    expect(validateCertificationClaims([{ name: 'osha10', has: 'yes' }], [requiredNoProof])).toEqual({
      ok: false,
      error: 'invalid_certification_claims',
    });
    expect(validateCertificationClaims([{ has: true }], [requiredNoProof])).toEqual({
      ok: false,
      error: 'invalid_certification_claims',
    });
  });

  it('rejects doc_ids that are not UUID-shaped strings (hostile input, never reaches a DB cast)', () => {
    const result = validateCertificationClaims(
      [{ name: 'osha30', has: true, doc_ids: ['../../etc/passwd'] }],
      [requiredWithProof],
    );
    expect(result).toEqual({ ok: false, error: 'invalid_certification_claims' });
  });

  it('rejects a doc_ids value that is not an array', () => {
    const result = validateCertificationClaims(
      [{ name: 'osha30', has: true, doc_ids: DOC_ID_1 }],
      [requiredWithProof],
    );
    expect(result).toEqual({ ok: false, error: 'invalid_certification_claims' });
  });

  it('drops a claim whose name is not a current requirement (tier drift) instead of erroring', () => {
    const result = validateCertificationClaims(
      [{ name: 'stale-cert-removed-by-employer', has: true }],
      [], // job no longer has any certification requirements
    );
    expect(result).toEqual({ ok: true, certifications: [] });
  });

  it('drops an unrecognized claim but still enforces a real requirement alongside it', () => {
    const result = validateCertificationClaims(
      [
        { name: 'stale-cert', has: true },
        { name: 'osha10', has: true },
      ],
      [requiredNoProof],
    );
    expect(result).toEqual({ ok: true, certifications: [{ name: 'osha10', has: true }] });
  });

  it('required, no proof needed, claimed yes: passes', () => {
    const result = validateCertificationClaims([{ name: 'osha10', has: true }], [requiredNoProof]);
    expect(result).toEqual({ ok: true, certifications: [{ name: 'osha10', has: true }] });
  });

  it('required cert never claimed at all: missing_certification_claims', () => {
    const result = validateCertificationClaims([], [requiredNoProof]);
    expect(result).toEqual({ ok: false, error: 'missing_certification_claims' });
  });

  it('required cert explicitly claimed has=false: missing_certification_claims', () => {
    const result = validateCertificationClaims([{ name: 'osha10', has: false }], [requiredNoProof]);
    expect(result).toEqual({ ok: false, error: 'missing_certification_claims' });
  });

  it('required + proof_required, claimed yes with a doc id: passes', () => {
    const result = validateCertificationClaims(
      [{ name: 'osha30', has: true, doc_ids: [DOC_ID_1] }],
      [requiredWithProof],
    );
    expect(result).toEqual({
      ok: true,
      certifications: [{ name: 'osha30', has: true, doc_ids: [DOC_ID_1] }],
    });
  });

  it('required + proof_required, claimed yes with zero doc ids: missing_certification_proof with certs list', () => {
    const result = validateCertificationClaims([{ name: 'osha30', has: true }], [requiredWithProof]);
    expect(result).toEqual({ ok: false, error: 'missing_certification_proof', certs: ['osha30'] });
  });

  it('required + proof_required, claimed yes with an empty doc_ids array: missing_certification_proof', () => {
    const result = validateCertificationClaims(
      [{ name: 'osha30', has: true, doc_ids: [] }],
      [requiredWithProof],
    );
    expect(result).toEqual({ ok: false, error: 'missing_certification_proof', certs: ['osha30'] });
  });

  it('optional cert never claimed: passes (never blocks)', () => {
    const result = validateCertificationClaims([], [optionalNoProof]);
    expect(result).toEqual({ ok: true, certifications: [] });
  });

  it('optional + proof_required cert claimed yes with no proof: passes, stands as claimed-unverified', () => {
    const result = validateCertificationClaims([{ name: 'crane', has: true }], [optionalWithProof]);
    expect(result).toEqual({ ok: true, certifications: [{ name: 'crane', has: true }] });
  });

  it('missing_certification_claims takes precedence over a proof gap elsewhere in the same job', () => {
    const result = validateCertificationClaims(
      [{ name: 'osha30', has: true }], // proof-required cert claimed but no doc id
      [requiredNoProof, requiredWithProof], // osha10 (requiredNoProof) never claimed at all
    );
    expect(result).toEqual({ ok: false, error: 'missing_certification_claims' });
  });

  it('multiple required+proof_required gaps all land in the certs list together', () => {
    const secondProofCert: CertificationRequirement = { name: 'welding', tier: 'required', proof_required: true };
    const result = validateCertificationClaims(
      [
        { name: 'osha30', has: true },
        { name: 'welding', has: true },
      ],
      [requiredWithProof, secondProofCert],
    );
    expect(result).toEqual({ ok: false, error: 'missing_certification_proof', certs: ['osha30', 'welding'] });
  });
});

describe('findCertificationProofGaps', () => {
  it('is reusable directly against a DB-filtered claims list', () => {
    // Simulates applications.ts re-checking after doc_ids were trimmed down
    // to only DB-validated ids (all invalid ids removed -> empty array).
    const gaps = findCertificationProofGaps(
      [{ name: 'osha30', has: true, doc_ids: [] }],
      [requiredWithProof],
    );
    expect(gaps).toEqual(['osha30']);
  });

  it('returns [] once a claim carries at least one surviving valid doc id', () => {
    const gaps = findCertificationProofGaps(
      [{ name: 'osha30', has: true, doc_ids: [DOC_ID_2] }],
      [requiredWithProof],
    );
    expect(gaps).toEqual([]);
  });
});
