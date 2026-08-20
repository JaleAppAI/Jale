// Pure logic for matching an employer-declared certification requirement
// against a worker's vault documents, and for estimating how long the
// in-page apply flow will take a worker to complete.
//
// `VaultDocLike` is intentionally NOT `WorkerVaultDoc` (frontend/src/lib/api/worker.ts):
// that type has no `id`/`cert_name` yet because migration 075
// (075_worker_documents_multi_certification.sql, see
// infra/lambda/lib/applications.ts) -- which lets a worker hold multiple
// `certification_doc` rows, one per named cert -- is not wired into the
// worker API client yet. This module only needs the shape it needs.

export type CertRequirement = { name: string; tier: 'required' | 'optional'; proof_required: boolean };

export type VaultDocLike = { id: string; doc_type: string; cert_name?: string | null };

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Finds the vault document proving a named certification, if any.
 * Only `doc_type === 'certification_doc'` rows are eligible, and the name
 * match is trim + case-fold insensitive (an employer/worker may type the
 * same cert with different capitalization or stray whitespace). A doc with
 * a null/missing `cert_name` never matches, even against a blank/whitespace
 * `certName` -- there is no such thing as an "unnamed" cert match.
 * Multiple docs can satisfy the same name (a worker may have re-uploaded);
 * the first match in array order wins, deterministically.
 */
export function matchCertProof(certName: string, vaultDocs: readonly VaultDocLike[]): VaultDocLike | undefined {
  const target = normalize(certName);
  return vaultDocs.find((doc) => {
    if (doc.doc_type !== 'certification_doc') return false;
    if (doc.cert_name == null) return false;
    return normalize(doc.cert_name) === target;
  });
}

/**
 * Rough estimate (in minutes) of how long the in-page apply flow will take:
 * a 1-minute base, plus 0.4 min per question field, 0.5 min per required
 * document, and 0.5 min per certification claim -- rounded to the nearest
 * whole minute (half rounds up, i.e. `Math.round`'s normal behavior) and
 * floored at 2 minutes so the estimate never reads as instantaneous.
 */
export function estimateApplyMinutes(questionCount: number, docCount: number, certCount: number): number {
  const raw = 1 + questionCount * 0.4 + docCount * 0.5 + certCount * 0.5;
  return Math.max(2, Math.round(raw));
}
