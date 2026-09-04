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
  certificationHintKey,
  docHintKey,
  workerCertNoteKey,
  whatYouNeedHintKey,
  partitionRequiredDocs,
  deriveCertificationDocTier,
  FIELD_GROUPS,
  type RequirementsMap,
  type CertificationRequirement,
} from '@/lib/job-requirements';

describe('initialRequirements', () => {
  // Owner decision 2026-09-04: a new job asks for NOTHING until the employer
  // opts in. `work_authorization`, `date_available`, `emergency_contact` and
  // `worked_here_before` used to default to Required.
  it('defaults every key to off, docs and fields alike', () => {
    const map = initialRequirements();
    for (const key of REQUIREMENT_KEYS) expect(map[key]).toBe('off');
  });

  it('leaves work_authorization off, so a new job does not demand it by default', () => {
    expect(initialRequirements().work_authorization).toBe('off');
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
    expect(arrays.required_fields).toEqual([]);
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
    let map = initialRequirements(); // 0 required, 0 optional out of the box
    expect(countRequirements(map)).toEqual({ required: 0, optional: 0 });
    map = setRequirementState(map, 'resume', 'optional');
    map = setRequirementState(map, 'references', 'required');
    expect(countRequirements(map)).toEqual({ required: 1, optional: 1 });
  });

  it('counts zero/zero for an all-off map', () => {
    const map = {} as RequirementsMap;
    for (const key of REQUIREMENT_KEYS) map[key] = 'off';
    expect(countRequirements(map)).toEqual({ required: 0, optional: 0 });
  });

  it('1-arg mode is unchanged when certification_doc carries a state (byte-identical to today)', () => {
    let map = initialRequirements(); // 0 required, 0 optional out of the box
    map = setRequirementState(map, 'certification_doc', 'required');
    expect(countRequirements(map)).toEqual({ required: 1, optional: 0 });
  });

  it('2-arg mode: excludes certification_doc from the map tally and adds each cert by its own tier', () => {
    let map = initialRequirements(); // 0 required, 0 optional
    map = setRequirementState(map, 'certification_doc', 'required'); // must NOT be tallied in 2-arg mode
    const certs: CertificationRequirement[] = [
      { name: 'OSHA 10', tier: 'required', proof_required: true },
      { name: 'CPR', tier: 'optional', proof_required: false },
      { name: 'Forklift', tier: 'optional', proof_required: true },
    ];
    // 0 required fields + 1 required cert = 1; 2 optional certs = 2. The
    // certification_doc map key's own 'required' state is excluded, not added.
    expect(countRequirements(map, certs)).toEqual({ required: 1, optional: 2 });
  });

  it('2-arg mode with an empty certs array still excludes certification_doc from the tally', () => {
    let map = initialRequirements();
    map = setRequirementState(map, 'certification_doc', 'optional');
    expect(countRequirements(map, [])).toEqual({ required: 0, optional: 0 });
  });
});

describe('deriveCertificationDocTier', () => {
  it('returns off for an empty certs list', () => {
    expect(deriveCertificationDocTier([])).toBe('off');
  });

  it('returns required when any entry is tier=required with proof_required=true', () => {
    const certs: CertificationRequirement[] = [
      { name: 'CPR', tier: 'optional', proof_required: false },
      { name: 'OSHA 10', tier: 'required', proof_required: true },
    ];
    expect(deriveCertificationDocTier(certs)).toBe('required');
  });

  it('returns optional when a required-tier entry has no proof required but another entry does', () => {
    const certs: CertificationRequirement[] = [
      { name: 'OSHA 10', tier: 'required', proof_required: false },
      { name: 'Forklift', tier: 'optional', proof_required: true },
    ];
    expect(deriveCertificationDocTier(certs)).toBe('optional');
  });

  it('returns off when no entry anywhere has proof_required set, regardless of tier', () => {
    const certs: CertificationRequirement[] = [
      { name: 'OSHA 10', tier: 'required', proof_required: false },
      { name: 'CPR', tier: 'optional', proof_required: false },
    ];
    expect(deriveCertificationDocTier(certs)).toBe('off');
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

describe('certificationHintKey', () => {
  it('required + proof_required asks for an upload with the initial application', () => {
    expect(certificationHintKey('required', true)).toBe('picker.cert_hint_required_proof');
  });

  it('required WITHOUT proof_required is attestation-only (no upload path exists)', () => {
    expect(certificationHintKey('required', false)).toBe('picker.cert_hint_required_attest');
  });

  it('optional never blocks, so the proof flag cannot change its hint', () => {
    // Mirrors certification-claims.ts: an optional cert never blocks submit
    // regardless of proof_required, so the hint must not promise otherwise.
    expect(certificationHintKey('optional', false)).toBe('picker.cert_hint_optional');
    expect(certificationHintKey('optional', true)).toBe('picker.cert_hint_optional');
  });
});

describe('docHintKey', () => {
  it('required means the file upload is mandatory at apply', () => {
    expect(docHintKey('required')).toBe('picker.doc_hint_required');
  });

  it('optional means it never blocks', () => {
    expect(docHintKey('optional')).toBe('picker.doc_hint_optional');
  });

  it('off returns undefined so the row renders no hint sentence at all', () => {
    expect(docHintKey('off')).toBeUndefined();
  });
});

describe('workerCertNoteKey', () => {
  const base = {
    claimed: true as boolean | null,
    tier: 'required' as CertificationRequirement['tier'],
    proofRequired: false,
    hasProof: false,
    blockingError: false,
  };

  it('renders nothing until the worker has answered yes', () => {
    expect(workerCertNoteKey({ ...base, claimed: null })).toBeUndefined();
    expect(workerCertNoteKey({ ...base, claimed: false })).toBeUndefined();
  });

  it('claimed yes with no proof required reassures that no upload is coming, either tier', () => {
    expect(workerCertNoteKey({ ...base })).toBe('cert_attest_note');
    expect(workerCertNoteKey({ ...base, tier: 'optional' })).toBe('cert_attest_note');
  });

  it('claimed yes on a required + proof cert with nothing attached asks for the upload', () => {
    expect(workerCertNoteKey({ ...base, proofRequired: true })).toBe('cert_proof_note');
  });

  it('says nothing once proof is attached', () => {
    expect(workerCertNoteKey({ ...base, proofRequired: true, hasProof: true })).toBeUndefined();
  });

  it('stays silent on an optional + proof cert -- cert_unverified_note owns that case', () => {
    // An optional cert never blocks, so "upload ... to continue" would be a
    // lie stacked directly on top of cert_unverified_note's "you can apply
    // without proof".
    expect(workerCertNoteKey({ ...base, tier: 'optional', proofRequired: true })).toBeUndefined();
  });

  it('yields to the blocking error rather than stacking two "to continue" sentences', () => {
    expect(
      workerCertNoteKey({ ...base, proofRequired: true, blockingError: true }),
    ).toBeUndefined();
  });
});

describe('whatYouNeedHintKey', () => {
  const base = {
    kind: 'doc' as const,
    tier: 'required' as CertificationRequirement['tier'],
    proofRequired: false,
    satisfied: false,
    blockingError: false,
  };

  it('describes the upload obligation for a required document', () => {
    expect(whatYouNeedHintKey({ ...base })).toBe('hint_doc_required');
  });

  it('describes an optional document as skippable', () => {
    expect(whatYouNeedHintKey({ ...base, tier: 'optional' })).toBe('hint_doc_optional');
  });

  it('splits a required cert by its proof flag', () => {
    expect(whatYouNeedHintKey({ ...base, kind: 'cert', proofRequired: true })).toBe(
      'hint_cert_required_proof',
    );
    expect(whatYouNeedHintKey({ ...base, kind: 'cert', proofRequired: false })).toBe(
      'hint_cert_required_attest',
    );
  });

  it('gives an optional cert one never-blocks hint regardless of its proof flag', () => {
    expect(whatYouNeedHintKey({ ...base, kind: 'cert', tier: 'optional', proofRequired: true })).toBe(
      'hint_cert_optional',
    );
    expect(whatYouNeedHintKey({ ...base, kind: 'cert', tier: 'optional', proofRequired: false })).toBe(
      'hint_cert_optional',
    );
  });

  it('suppresses the hint when the vault already satisfies the row', () => {
    expect(whatYouNeedHintKey({ ...base, satisfied: true })).toBeUndefined();
    expect(
      whatYouNeedHintKey({ ...base, kind: 'cert', proofRequired: true, satisfied: true }),
    ).toBeUndefined();
  });

  it('still explains an attest-only cert whose vault match does NOT satisfy it', () => {
    // A vault file satisfies an upload requirement, but an attest-only cert
    // is satisfied by the worker's yes/no answer in the flow -- the file is
    // beside the point. The panel still badges that row "already in your
    // vault", so suppressing the hint here would leave the ONE row where the
    // badge actively misleads with no explanation at all.
    expect(
      whatYouNeedHintKey({ ...base, kind: 'cert', proofRequired: false, satisfied: true }),
    ).toBe('hint_cert_required_attest');
    expect(
      whatYouNeedHintKey({ ...base, kind: 'cert', tier: 'optional', proofRequired: false, satisfied: true }),
    ).toBe('hint_cert_optional');
  });

  it('suppresses the hint when a blocking error is already showing on the row', () => {
    expect(whatYouNeedHintKey({ ...base, blockingError: true })).toBeUndefined();
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
});

describe('partitionRequiredDocs', () => {
    // A job's `required_docs` comes straight off the DB row, whose CHECK
    // constraint still accepts legacy 'ssn' for old rows even though the
    // app-layer vocabulary (REQUIREMENT_DOC_KEYS / the backend's DOC_TYPES)
    // dropped it. The apply flow renders only keys it knows, so an unknown
    // key used to be an invisible, unsatisfiable gate: nothing on screen to
    // upload, and Continue blocked forever. Splitting the list is what lets
    // the gate ignore those keys while the UI still names them out loud.
    it('returns two empty lists for an empty input', () => {
        expect(partitionRequiredDocs([])).toEqual({ supported: [], unsupported: [] });
    });

    it('treats every REQUIREMENT_DOC_KEYS member as supported', () => {
        const { supported, unsupported } = partitionRequiredDocs([...REQUIREMENT_DOC_KEYS]);
        expect(supported).toEqual([...REQUIREMENT_DOC_KEYS]);
        expect(unsupported).toEqual([]);
    });

    it("splits a legacy 'ssn' entry out of a mixed list", () => {
        expect(partitionRequiredDocs(['resume', 'ssn', 'work_auth_doc'])).toEqual({
            supported: ['resume', 'work_auth_doc'],
            unsupported: ['ssn'],
        });
    });

    it('routes an unrecognized garbage key to unsupported rather than throwing', () => {
        expect(partitionRequiredDocs(['not_a_doc_type', 'driver_license'])).toEqual({
            supported: ['driver_license'],
            unsupported: ['not_a_doc_type'],
        });
    });

    it('preserves the order each side was given in', () => {
        const { supported, unsupported } = partitionRequiredDocs([
            'certification_doc', 'ssn', 'driver_license', 'mystery', 'resume',
        ]);
        expect(supported).toEqual(['certification_doc', 'driver_license', 'resume']);
        expect(unsupported).toEqual(['ssn', 'mystery']);
    });

    it('keeps certification_doc supported -- the hasCerts exclusion is a separate rule', () => {
        // The apply-flow gates exclude certification_doc themselves when a job
        // carries named certification_requirements. That exclusion must stay
        // layered on top of this partition, not be folded into it: this helper
        // answers "does the app know this key", nothing about job shape.
        expect(partitionRequiredDocs(['certification_doc']).supported).toEqual(['certification_doc']);
    });
});
