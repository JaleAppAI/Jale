// Strict-gate semantics for the per-job certification claims step of the
// in-page apply flow. These are locked product decisions (see task spec
// WK-T1b) -- do not soften them:
//
//   - A REQUIRED cert must be explicitly claimed YES. Unanswered or "no"
//     both block submit.
//   - A REQUIRED + proof_required cert claimed YES must have at least one
//     attached proof document before submit is allowed.
//   - OPTIONAL certs never block submit, however answered (or left
//     unanswered). An optional cert claimed YES with no proof is valid --
//     "claimed, unverified" -- because proof is never demanded on an
//     optional cert regardless of `proof_required`.
//
// Certs are keyed by their exact requirement `name` throughout (draft and
// proofFiles alike) -- no trim/case-fold normalization happens in this
// module, unlike `certification-match`'s document lookup. Any caller
// building a draft or proofFiles map must key by the same exact string the
// job's `CertRequirement.name` uses, or a claim/proof will silently miss.
import type { CertRequirement } from './certification-match';

export type CertClaim = { has: boolean | null };
export type CertClaimDraft = Record<string, CertClaim>;

export function emptyCertClaimDraft(certNames: readonly string[]): CertClaimDraft {
  const draft: CertClaimDraft = {};
  for (const name of certNames) draft[name] = { has: null };
  return draft;
}

export function isClaimAnswered(c: CertClaim | undefined): boolean {
  return c !== undefined && c.has !== null;
}

/**
 * Names of REQUIRED certs blocking submit: unanswered OR answered "no" --
 * a required cert must be claimed YES. Optional certs never appear here.
 */
export function missingRequiredCertClaims(certs: readonly CertRequirement[], draft: CertClaimDraft): string[] {
  const missing: string[] = [];
  for (const cert of certs) {
    if (cert.tier !== 'required') continue;
    const claim = draft[cert.name];
    if (claim === undefined || claim.has === null || claim.has === false) {
      missing.push(cert.name);
    }
  }
  return missing;
}

/**
 * Names of required+proof_required certs claimed yes but with no attached
 * proof file. Disjoint from `missingRequiredCertClaims`: a required cert
 * that is unanswered or claimed "no" is that function's problem, not this
 * one's -- this only ever fires on `has === true`. A missing `proofFiles`
 * entry and an entry present but empty both count as "no proof".
 */
export function missingRequiredCertProofs(
  certs: readonly CertRequirement[],
  draft: CertClaimDraft,
  proofFiles: Readonly<Record<string, readonly string[]>>,
): string[] {
  const missing: string[] = [];
  for (const cert of certs) {
    if (cert.tier !== 'required' || !cert.proof_required) continue;
    if (draft[cert.name]?.has !== true) continue;
    const files = proofFiles[cert.name];
    if (!files || files.length === 0) missing.push(cert.name);
  }
  return missing;
}

export function canSubmitCertClaims(
  certs: readonly CertRequirement[],
  draft: CertClaimDraft,
  proofFiles: Readonly<Record<string, readonly string[]>>,
): boolean {
  return (
    missingRequiredCertClaims(certs, draft).length === 0 &&
    missingRequiredCertProofs(certs, draft, proofFiles).length === 0
  );
}

/** Wire payload entry -- TOP-LEVEL apply field `certification_claims`. */
export type CertificationClaim = { name: string; has: boolean; doc_ids?: string[] };

/**
 * Builds the `certification_claims` wire payload, in `certs` array order
 * (not draft object-key order, which is not meaningful/stable here).
 *
 * An unanswered cert is omitted regardless of tier: `CertificationClaim.has`
 * is non-optional, so there is no way to represent "unanswered" on the
 * wire, and a required cert can never legitimately reach this function
 * unanswered anyway -- `canSubmitCertClaims` gates submit first. Optional
 * certs are commonly left unanswered and are always omitted in that case
 * ("never sent has:null").
 *
 * `doc_ids` is included only when the cert has at least one attached proof
 * file, independent of the claim's answer -- a stray attached file on a
 * "no" claim is odd but information-preserving, so it is still reported
 * rather than silently dropped.
 */
export function buildCertClaimsPayload(
  certs: readonly CertRequirement[],
  draft: CertClaimDraft,
  proofFiles: Readonly<Record<string, readonly string[]>>,
): CertificationClaim[] {
  const payload: CertificationClaim[] = [];
  for (const cert of certs) {
    const claim = draft[cert.name];
    if (claim === undefined || claim.has === null) continue;
    const entry: CertificationClaim = { name: cert.name, has: claim.has === true };
    const files = proofFiles[cert.name];
    if (files && files.length > 0) entry.doc_ids = [...files];
    payload.push(entry);
  }
  return payload;
}
