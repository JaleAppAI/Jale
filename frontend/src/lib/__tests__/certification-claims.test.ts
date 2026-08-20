import { describe, expect, it } from 'vitest';
import type { CertRequirement } from '@/lib/certification-match';
import {
  emptyCertClaimDraft,
  isClaimAnswered,
  missingRequiredCertClaims,
  missingRequiredCertProofs,
  canSubmitCertClaims,
  buildCertClaimsPayload,
  type CertClaimDraft,
} from '@/lib/certification-claims';

const CERTS: CertRequirement[] = [
  { name: 'OSHA 10', tier: 'required', proof_required: true },
  { name: 'Forklift', tier: 'required', proof_required: false },
  { name: 'CPR', tier: 'optional', proof_required: true },
  { name: 'First Aid', tier: 'optional', proof_required: false },
];

describe('emptyCertClaimDraft / isClaimAnswered', () => {
  it('starts every cert name unanswered (has: null)', () => {
    const draft = emptyCertClaimDraft(['OSHA 10', 'CPR']);
    expect(draft).toEqual({ 'OSHA 10': { has: null }, CPR: { has: null } });
  });

  it('isClaimAnswered is false for undefined and for has:null, true for has:true/false', () => {
    expect(isClaimAnswered(undefined)).toBe(false);
    expect(isClaimAnswered({ has: null })).toBe(false);
    expect(isClaimAnswered({ has: true })).toBe(true);
    expect(isClaimAnswered({ has: false })).toBe(true);
  });
});

describe('missingRequiredCertClaims', () => {
  it('blocks every unanswered required cert', () => {
    const draft = emptyCertClaimDraft(CERTS.map((c) => c.name));
    expect(missingRequiredCertClaims(CERTS, draft)).toEqual(['OSHA 10', 'Forklift']);
  });

  it('blocks a required cert explicitly answered no', () => {
    const draft: CertClaimDraft = {
      ...emptyCertClaimDraft(CERTS.map((c) => c.name)),
      'OSHA 10': { has: false },
      Forklift: { has: true },
    };
    expect(missingRequiredCertClaims(CERTS, draft)).toEqual(['OSHA 10']);
  });

  it('passes once every required cert is answered yes', () => {
    const draft: CertClaimDraft = {
      ...emptyCertClaimDraft(CERTS.map((c) => c.name)),
      'OSHA 10': { has: true },
      Forklift: { has: true },
    };
    expect(missingRequiredCertClaims(CERTS, draft)).toEqual([]);
  });

  it('never lists an optional cert, answered or not', () => {
    const draft: CertClaimDraft = {
      'OSHA 10': { has: true },
      Forklift: { has: true },
      CPR: { has: false },
      'First Aid': { has: null },
    };
    expect(missingRequiredCertClaims(CERTS, draft)).toEqual([]);
  });
});

describe('missingRequiredCertProofs', () => {
  const fullYesDraft: CertClaimDraft = {
    'OSHA 10': { has: true },
    Forklift: { has: true },
    CPR: { has: true },
    'First Aid': { has: true },
  };

  it('blocks a required+proof_required cert claimed yes with no attached file', () => {
    expect(missingRequiredCertProofs(CERTS, fullYesDraft, {})).toEqual(['OSHA 10']);
  });

  it('passes once a proof file is attached', () => {
    expect(missingRequiredCertProofs(CERTS, fullYesDraft, { 'OSHA 10': ['doc-1'] })).toEqual([]);
  });

  it('treats an empty file array the same as a missing key', () => {
    expect(missingRequiredCertProofs(CERTS, fullYesDraft, { 'OSHA 10': [] })).toEqual(['OSHA 10']);
  });

  it('does not block a required non-proof cert claimed yes with no file (Forklift)', () => {
    expect(missingRequiredCertProofs(CERTS, fullYesDraft, {})).not.toContain('Forklift');
  });

  it('does not block an optional+proof_required cert claimed yes with no file -- "claimed, unverified" is valid', () => {
    expect(missingRequiredCertProofs(CERTS, fullYesDraft, {})).not.toContain('CPR');
  });

  it('never double-reports a required cert that is unanswered or claimed no -- that is missingRequiredCertClaims territory', () => {
    const draft = emptyCertClaimDraft(CERTS.map((c) => c.name));
    expect(missingRequiredCertProofs(CERTS, draft, {})).toEqual([]);
    const noDraft: CertClaimDraft = { ...draft, 'OSHA 10': { has: false } };
    expect(missingRequiredCertProofs(CERTS, noDraft, {})).toEqual([]);
  });
});

describe('canSubmitCertClaims', () => {
  it('is true for an empty cert list', () => {
    expect(canSubmitCertClaims([], {}, {})).toBe(true);
  });

  it('is false while a required claim is missing', () => {
    const draft = emptyCertClaimDraft(CERTS.map((c) => c.name));
    expect(canSubmitCertClaims(CERTS, draft, {})).toBe(false);
  });

  it('is false while a required claim is answered but its proof is missing', () => {
    const draft: CertClaimDraft = {
      ...emptyCertClaimDraft(CERTS.map((c) => c.name)),
      'OSHA 10': { has: true },
      Forklift: { has: true },
    };
    expect(canSubmitCertClaims(CERTS, draft, {})).toBe(false);
  });

  it('is true once every required claim and its required proof are satisfied', () => {
    const draft: CertClaimDraft = {
      ...emptyCertClaimDraft(CERTS.map((c) => c.name)),
      'OSHA 10': { has: true },
      Forklift: { has: true },
    };
    expect(canSubmitCertClaims(CERTS, draft, { 'OSHA 10': ['doc-1'] })).toBe(true);
  });
});

describe('buildCertClaimsPayload', () => {
  it('omits an unanswered optional cert entirely (never has:null on the wire)', () => {
    const draft: CertClaimDraft = {
      'OSHA 10': { has: true },
      Forklift: { has: true },
      CPR: { has: null },
      'First Aid': { has: null },
    };
    const payload = buildCertClaimsPayload(CERTS, draft, { 'OSHA 10': ['doc-1'] });
    expect(payload.find((c) => c.name === 'CPR')).toBeUndefined();
    expect(payload.find((c) => c.name === 'First Aid')).toBeUndefined();
  });

  it('includes a "no" answer', () => {
    const draft: CertClaimDraft = {
      'OSHA 10': { has: false },
      Forklift: { has: true },
      CPR: { has: null },
      'First Aid': { has: null },
    };
    const payload = buildCertClaimsPayload(CERTS, draft, {});
    expect(payload.find((c) => c.name === 'OSHA 10')).toEqual({ name: 'OSHA 10', has: false });
  });

  it('includes doc_ids only when non-empty', () => {
    const draft: CertClaimDraft = {
      'OSHA 10': { has: true },
      Forklift: { has: true },
      CPR: { has: true },
      'First Aid': { has: null },
    };
    const payload = buildCertClaimsPayload(CERTS, draft, { 'OSHA 10': ['doc-1'], Forklift: [] });
    expect(payload.find((c) => c.name === 'OSHA 10')).toEqual({ name: 'OSHA 10', has: true, doc_ids: ['doc-1'] });
    expect(payload.find((c) => c.name === 'Forklift')).toEqual({ name: 'Forklift', has: true });
    expect(payload.find((c) => c.name === 'CPR')).toEqual({ name: 'CPR', has: true });
  });

  it('keeps doc_ids on a "no" claim rather than silently dropping attached files', () => {
    const draft: CertClaimDraft = {
      'OSHA 10': { has: false },
      Forklift: { has: true },
      CPR: { has: null },
      'First Aid': { has: null },
    };
    const payload = buildCertClaimsPayload(CERTS, draft, { 'OSHA 10': ['doc-1'] });
    expect(payload.find((c) => c.name === 'OSHA 10')).toEqual({ name: 'OSHA 10', has: false, doc_ids: ['doc-1'] });
  });

  it('emits entries in the certs array order, not the draft object key order', () => {
    const draft: CertClaimDraft = {
      Forklift: { has: true },
      'OSHA 10': { has: true },
      CPR: { has: true },
      'First Aid': { has: false },
    };
    const payload = buildCertClaimsPayload(CERTS, draft, {});
    expect(payload.map((c) => c.name)).toEqual(['OSHA 10', 'Forklift', 'CPR', 'First Aid']);
  });

  it('a required cert can never appear unanswered in the payload (submit is gated before this runs)', () => {
    const draft = emptyCertClaimDraft(CERTS.map((c) => c.name));
    const payload = buildCertClaimsPayload(CERTS, draft, {});
    expect(payload).toEqual([]);
  });
});
