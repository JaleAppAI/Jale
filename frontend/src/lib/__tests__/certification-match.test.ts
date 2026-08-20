import { describe, expect, it } from 'vitest';
import { matchCertProof, estimateApplyMinutes, type VaultDocLike } from '@/lib/certification-match';

describe('matchCertProof', () => {
  const docs: VaultDocLike[] = [
    { id: '1', doc_type: 'certification_doc', cert_name: 'OSHA 10' },
    { id: '2', doc_type: 'certification_doc', cert_name: 'Forklift' },
    { id: '3', doc_type: 'resume', cert_name: 'OSHA 10' },
    { id: '4', doc_type: 'certification_doc', cert_name: null },
    { id: '5', doc_type: 'certification_doc' },
  ];

  it('matches an exact cert name', () => {
    expect(matchCertProof('OSHA 10', docs)?.id).toBe('1');
  });

  it('matches case-insensitively', () => {
    expect(matchCertProof('osha 10', docs)?.id).toBe('1');
    expect(matchCertProof('FORKLIFT', docs)?.id).toBe('2');
  });

  it('matches after trimming whitespace on either side', () => {
    expect(matchCertProof('  OSHA 10  ', docs)?.id).toBe('1');
    const paddedDocs: VaultDocLike[] = [{ id: '9', doc_type: 'certification_doc', cert_name: '  OSHA 10  ' }];
    expect(matchCertProof('OSHA 10', paddedDocs)?.id).toBe('9');
  });

  it('does not match a doc of a different doc_type even with the same name', () => {
    expect(matchCertProof('OSHA 10', [docs[2]])).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(matchCertProof('CPR', docs)).toBeUndefined();
  });

  it('never matches a certification_doc with a null or missing cert_name, even against an empty/blank name', () => {
    expect(matchCertProof('', docs)).toBeUndefined();
    expect(matchCertProof('   ', docs)).toBeUndefined();
  });

  it('returns the first matching doc in array order when multiple docs match (multi-cert upload)', () => {
    const dup: VaultDocLike[] = [
      { id: 'a', doc_type: 'certification_doc', cert_name: 'CPR' },
      { id: 'b', doc_type: 'certification_doc', cert_name: 'CPR' },
    ];
    expect(matchCertProof('CPR', dup)?.id).toBe('a');
  });

  it('returns undefined for an empty vault doc list', () => {
    expect(matchCertProof('CPR', [])).toBeUndefined();
  });
});

describe('estimateApplyMinutes', () => {
  it('floors at 2 minutes for a job with no questions, docs, or certs', () => {
    expect(estimateApplyMinutes(0, 0, 0)).toBe(2);
  });

  it('rounds half-up on an exact .5 tie', () => {
    // 1 + 0*0.4 + 3*0.5 + 0*0.5 = 2.5 -> rounds up to 3
    expect(estimateApplyMinutes(0, 3, 0)).toBe(3);
  });

  it('grows with question, doc, and cert counts', () => {
    // 1 + 5*0.4 + 2*0.5 + 2*0.5 = 5
    expect(estimateApplyMinutes(5, 2, 2)).toBe(5);
  });

  it('never returns less than 2, even for a negative-leaning mix', () => {
    expect(estimateApplyMinutes(0, 0, 0)).toBeGreaterThanOrEqual(2);
  });
});
