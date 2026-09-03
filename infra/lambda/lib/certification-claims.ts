// certification-claims.ts
//
// Surface-agnostic validator for per-certification claims submitted
// alongside a job application. This is one of Ivan's WhatsApp fill-flow
// entry points: it must be callable exactly as-is from a conversational
// bot turn, so nothing here imports web-only types (no APIGatewayProxyEvent,
// no PoolClient, no DB access of any kind -- see the doc_ids note below).
//
// ── WIRE SHAPE ───────────────────────────────────────────────────
// jobs.certification_requirements (077_jobs_structured_fields.sql) is a
// JSONB array of:
//   { name: string; tier: 'required' | 'optional'; proof_required: boolean }
// parseCertificationRequirements() below turns that raw column value into
// CertificationRequirement[].
//
// A worker's application-time claims are a TOP-LEVEL sibling of `answers`
// in the apply request body -- never nested inside it (see
// worker-jobs-apply.ts / applications.ts) -- one entry per certification
// the worker was asked about:
//   { name: string; has: boolean; doc_ids?: string[] }
//
// `doc_ids`, when present, are worker_documents.id values the caller is
// offering as proof. This module only checks that they are well-formed
// UUID-shaped strings -- it never checks that they exist, belong to this
// worker, or carry doc_type = 'certification_doc'. That is a
// database-backed check only a DB-connected caller can make; the web apply
// path does it in applications.ts immediately after this validator returns
// ok (see the comment there). A WhatsApp fill-flow MUST run the equivalent
// ownership/type check itself -- against the same worker_documents table,
// the same doc_type = 'certification_doc' filter, and the same "a legacy
// unlabeled cert file (cert_name NULL) is still valid proof" rule -- before
// treating a claim as proof-satisfied. Skipping that check would let a
// worker claim someone else's document, or a non-certification upload, as
// proof.
//
// ── RESERVED ANSWERS KEY ─────────────────────────────────────────
// Once validated, claims are merged into job_applications.application_answers
// under the RESERVED key 'certifications' -- never inside the free-form
// per-job answers object validateApplicationAnswers (application-answers.ts)
// builds. That object can never collide with this key: jobs.required_fields
// / optional_fields are constrained by the closed allowlists in
// jobs_required_fields_valid (073) and jobs_optional_fields_valid (074),
// neither of which lists 'certifications', so validateApplicationAnswers's
// own "every key must be in requiredFields or optionalFields" check already
// rejects a client-supplied answers key literally named 'certifications'
// with 'unknown_answer_key' -- no special-case code needed there. This is a
// structural guarantee (enforced by two DB CHECK constraints), not a
// convention that could silently drift.
//
// ── RULES ────────────────────────────────────────────────────────
// - A claim whose `name` does not match any entry in the job's current
//   certification_requirements is DROPPED SILENTLY. This handles tier
//   drift: the requirements list can change between when a worker loads
//   the apply page and when they submit (an employer edits the job's cert
//   list mid-fill). A stale claim must never turn into a 500 or an
//   unexplained rejection -- it is simply irrelevant now.
// - required tier: the worker must claim has=true. Not claiming it at all,
//   or claiming has=false, fails with 'missing_certification_claims'.
// - required + proof_required: additionally needs >=1 doc id ON THE CLAIM
//   ITSELF (a purely structural/syntactic check -- see the DB note above
//   for why this module cannot go further). Claiming has=true with zero
//   doc ids fails with 'missing_certification_proof'.
// - optional tier NEVER blocks submission: unclaimed is fine, and claiming
//   has=true without any proof is also fine -- it stands as a
//   claimed-but-unverified assertion. proof_required only has teeth on a
//   required-tier certification.
// - Precedence when a job has multiple unsatisfied certifications: any
//   required-but-unclaimed cert wins ('missing_certification_claims') over
//   any claimed-but-unproven one ('missing_certification_proof') -- you
//   cannot even get to "which certs lack proof" until every required cert
//   has actually been claimed.

export type CertificationTier = 'required' | 'optional';

export interface CertificationRequirement {
  name: string;
  tier: CertificationTier;
  proof_required: boolean;
}

export interface CertificationClaim {
  name: string;
  has: boolean;
  doc_ids?: string[];
}

export type ValidateCertificationClaimsResult =
  | { ok: true; certifications: CertificationClaim[] }
  | { ok: false; error: 'invalid_certification_claims' }
  | { ok: false; error: 'missing_certification_claims' }
  | { ok: false; error: 'missing_certification_proof'; certs: string[] };

// Generic UUID shape (any version/variant) -- worker_documents.id is UUID,
// generated by gen_random_uuid() (v4) at every call site today, but this
// does not pin the version bits, just the general 8-4-4-4-12 hex shape.
// Rejecting non-UUID-shaped strings here, in the pure validator, matters
// for more than tidiness: a caller that forwards doc_ids straight into a
// `= ANY($n::uuid[])` parameter (as applications.ts does) would otherwise
// let a malformed id (e.g. "../../x") raise a raw Postgres cast error
// (22P02) that never matches the 42501/23514 codes the apply path already
// handles, and would escape as an unhandled 500 on exactly this kind of
// hostile input.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turns jobs.certification_requirements (raw JSONB column value, already
 * deserialized to a JS value by node-pg) into a typed, defensively-filtered
 * array. FAILS OPEN on a malformed value: a non-array becomes `[]`
 * (enforcement simply does not run, same as a job with no cert requirements
 * at all -- see applications.ts, which only calls this validator when the
 * parsed array is non-empty), and a malformed individual entry is dropped
 * rather than thrown. jobs_certification_requirements_valid (077) only
 * enforces jsonb_typeof(...) = 'array' at the DB layer -- per-entry shape
 * is app-layer by design (same precedent as 073/074) -- so a corrupt or
 * hand-edited row must degrade gracefully, never 500 the apply path.
 */
export function parseCertificationRequirements(raw: unknown): CertificationRequirement[] {
  if (!Array.isArray(raw)) return [];

  const result: CertificationRequirement[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const { name, tier, proof_required: proofRequired } = entry;
    if (!isNonEmptyString(name)) continue;
    if (tier !== 'required' && tier !== 'optional') continue;
    if (typeof proofRequired !== 'boolean') continue;
    result.push({ name, tier, proof_required: proofRequired });
  }
  return result;
}

/**
 * Shape-validates the raw `certification_claims` request value into
 * CertificationClaim[], or returns null if the value is malformed at any
 * level (not an array; an entry that isn't a plain object; a missing/wrong-
 * typed `name`/`has`; a `doc_ids` that isn't an array of UUID-shaped
 * strings). `undefined` (the field omitted entirely) parses to `[]`, not
 * null -- omitting the optional field is never itself an error.
 */
function parseClaims(claims: unknown): CertificationClaim[] | null {
  if (claims === undefined) return [];
  if (!Array.isArray(claims)) return null;

  const result: CertificationClaim[] = [];
  for (const entry of claims) {
    if (!isPlainObject(entry)) return null;
    const { name, has, doc_ids: docIds } = entry;
    if (!isNonEmptyString(name)) return null;
    if (typeof has !== 'boolean') return null;

    if (docIds === undefined) {
      result.push({ name, has });
      continue;
    }
    if (!Array.isArray(docIds) || !docIds.every((id) => isNonEmptyString(id) && UUID_PATTERN.test(id))) {
      return null;
    }
    result.push({ name, has, doc_ids: docIds });
  }
  return result;
}

/**
 * Finds required + proof_required certifications that are claimed
 * (has=true) but carry zero doc ids. Exported and reused by applications.ts
 * AFTER it DB-validates doc_ids ownership/type: the caller re-runs this
 * same pure check against the DB-filtered claims (doc_ids trimmed down to
 * only ids that actually belong to this worker as a certification_doc) to
 * catch a claim whose ids were all invalid/hostile and now reads as
 * proof-empty. Centralizing the tier-walk here means applications.ts never
 * duplicates the required/proof_required scan logic.
 */
export function findCertificationProofGaps(
  certifications: readonly CertificationClaim[],
  certificationRequirements: readonly CertificationRequirement[],
): string[] {
  const byName = new Map(certifications.map((claim) => [claim.name, claim] as const));
  return certificationRequirements
    .filter((req) => req.tier === 'required' && req.proof_required)
    .filter((req) => {
      const claim = byName.get(req.name);
      return claim?.has === true && (!claim.doc_ids || claim.doc_ids.length === 0);
    })
    .map((req) => req.name);
}

export function validateCertificationClaims(
  claims: unknown,
  certificationRequirements: readonly CertificationRequirement[],
): ValidateCertificationClaimsResult {
  const parsed = parseClaims(claims);
  if (parsed === null) {
    return { ok: false, error: 'invalid_certification_claims' };
  }

  // Tier drift: drop claims for names that are not a live requirement.
  // Duplicate names in the payload: last one wins (deterministic, matches
  // ordinary JS object-literal merge semantics) -- no legitimate caller
  // sends the same cert name twice, so this only matters for hostile input,
  // where "some deterministic choice" is all that is required.
  const requirementNames = new Set(certificationRequirements.map((req) => req.name));
  const byName = new Map<string, CertificationClaim>();
  for (const claim of parsed) {
    if (requirementNames.has(claim.name)) byName.set(claim.name, claim);
  }
  const certifications = Array.from(byName.values());

  const missingClaims = certificationRequirements.some(
    (req) => req.tier === 'required' && byName.get(req.name)?.has !== true,
  );
  if (missingClaims) {
    return { ok: false, error: 'missing_certification_claims' };
  }

  const certs = findCertificationProofGaps(certifications, certificationRequirements);
  if (certs.length > 0) {
    return { ok: false, error: 'missing_certification_proof', certs };
  }

  return { ok: true, certifications };
}

/**
 * SHAPE-ONLY normalization for the stage-2 certification door
 * (`mergeCertificationClaims`, application-requirements.ts). Runs
 * `parseClaims` and then drops claims whose name is not a live requirement
 * (tier drift, same rule and same last-one-wins de-dup as
 * `validateCertificationClaims`), and STOPS THERE.
 *
 * The difference from `validateCertificationClaims` is the whole point:
 * that function is an all-at-once SUBMISSION gate -- it rejects a payload
 * that leaves a required cert unclaimed, or a proof-required cert without a
 * doc id. Stage 2 collects certifications incrementally, one at a time,
 * across turns and across surfaces, so a partial claim set is normal
 * progress, not an error. What is still missing is reported by
 * `findMissingCertifications` below (and surfaced as the next step /
 * remaining counts), never as a rejection here.
 *
 * Returns null -- not a partial list -- for a payload that is malformed at
 * any level, INCLUDING an entry whose name is not a live requirement: shape
 * is checked before tier drift, so hostile input cannot smuggle a bad
 * `doc_ids` value past validation by naming a cert the job no longer asks
 * for.
 */
export function normalizeCertificationClaims(
  raw: unknown,
  certificationRequirements: readonly CertificationRequirement[],
): CertificationClaim[] | null {
  const parsed = parseClaims(raw);
  if (parsed === null) return null;

  const requirementNames = new Set(certificationRequirements.map((req) => req.name));
  const byName = new Map<string, CertificationClaim>();
  for (const claim of parsed) {
    if (requirementNames.has(claim.name)) byName.set(claim.name, claim);
  }
  return Array.from(byName.values());
}

/**
 * The two required-tier certification gaps, split so a caller can ask for
 * the right thing next: a cert that has not been CLAIMED at all
 * (`unclaimed` -- never claimed, or claimed has=false) versus one claimed
 * has=true whose proof is missing (`unproven`, delegated verbatim to
 * `findCertificationProofGaps` so the proof-walk exists in exactly one
 * place).
 *
 * Optional-tier certifications are NEVER reported in either bucket:
 * unclaimed is fine, and claimed-without-proof stands as a
 * claimed-but-unverified assertion. Both buckets preserve
 * `certification_requirements` column order.
 *
 * This is the incremental counterpart to `validateCertificationClaims`'s
 * precedence rule ("unclaimed wins over unproven"): the caller gets BOTH
 * lists and decides -- `nextStep` asks for the unclaimed ones first, while
 * the employer-facing `remaining` counts want the total.
 */
export function findMissingCertifications(
  certifications: readonly CertificationClaim[],
  certificationRequirements: readonly CertificationRequirement[],
): { unclaimed: string[]; unproven: string[] } {
  const byName = new Map(certifications.map((claim) => [claim.name, claim] as const));
  const unclaimed = certificationRequirements
    .filter((req) => req.tier === 'required' && byName.get(req.name)?.has !== true)
    .map((req) => req.name);
  return { unclaimed, unproven: findCertificationProofGaps(certifications, certificationRequirements) };
}
