// Shared vocabulary + mapping for the per-job applicant requirements picker.
//
// Three-state model, per data point: Off / Optional / Required (employer
// chosen). Mirrors the backend's `REQUIRED_FIELD_TYPES`/`DOC_TYPES`
// (infra/lambda/lib/job-fields.ts) and the disjointness rule enforced there
// and in `validateApplicationAnswers` (infra/lambda/lib/application-answers.ts):
// a key present in both a required and an optional array reads as Required,
// the stricter of the two.

export const REQUIREMENT_DOC_KEYS = [
  'resume',
  'driver_license',
  'work_auth_doc',
  'certification_doc',
] as const;
export type RequirementDocKey = typeof REQUIREMENT_DOC_KEYS[number];

export const REQUIREMENT_FIELD_KEYS = [
  'work_authorization',
  'date_available',
  'desired_pay',
  'home_address',
  'date_of_birth',
  'emergency_contact',
  'worked_here_before',
  'education',
  'references',
  'work_history',
  'military_service',
] as const;
export type RequirementFieldKey = typeof REQUIREMENT_FIELD_KEYS[number];

export type RequirementKey = RequirementDocKey | RequirementFieldKey;

export const REQUIREMENT_KEYS: readonly RequirementKey[] = [
  ...REQUIREMENT_DOC_KEYS,
  ...REQUIREMENT_FIELD_KEYS,
];

export type RequirementState = 'off' | 'optional' | 'required';

export type RequirementsMap = Record<RequirementKey, RequirementState>;

/** New-job defaults (locked design): these four Required, everything else Off. */
const DEFAULT_REQUIRED_KEYS: readonly RequirementFieldKey[] = [
  'work_authorization',
  'date_available',
  'emergency_contact',
  'worked_here_before',
];

export function initialRequirements(): RequirementsMap {
  const map = {} as RequirementsMap;
  for (const key of REQUIREMENT_KEYS) map[key] = 'off';
  for (const key of DEFAULT_REQUIRED_KEYS) map[key] = 'required';
  return map;
}

export type RequirementArrays = {
  required_docs: string[];
  optional_docs: string[];
  required_fields: string[];
  optional_fields: string[];
};

/** Split the three-state map into the four wire arrays the backend expects. */
export function requirementsToArrays(requirements: RequirementsMap): RequirementArrays {
  const required_docs: string[] = [];
  const optional_docs: string[] = [];
  for (const key of REQUIREMENT_DOC_KEYS) {
    const state = requirements[key];
    if (state === 'required') required_docs.push(key);
    else if (state === 'optional') optional_docs.push(key);
  }

  const required_fields: string[] = [];
  const optional_fields: string[] = [];
  for (const key of REQUIREMENT_FIELD_KEYS) {
    const state = requirements[key];
    if (state === 'required') required_fields.push(key);
    else if (state === 'optional') optional_fields.push(key);
  }

  return { required_docs, optional_docs, required_fields, optional_fields };
}

export type RequirementArraysSource = {
  required_docs?: readonly string[] | null;
  optional_docs?: readonly string[] | null;
  required_fields?: readonly string[] | null;
  optional_fields?: readonly string[] | null;
  /**
   * Legacy standalone flag (pre-three-state). When true and `required_fields`
   * doesn't already carry `work_authorization` -- an old job/template row
   * saved before this feature -- the migration rule below wins it Required,
   * so a job that used to gate on it does not silently stop gating.
   */
  work_authorization_required?: boolean | null;
};

/**
 * Reconstruct the three-state map from a job/template payload's arrays.
 * Absent keys (including a whole payload missing the arrays entirely --
 * legacy templates) default to 'off'. Never throws: every input is
 * `?? []`-guarded.
 */
export function arraysToRequirements(source: RequirementArraysSource): RequirementsMap {
  const requiredDocs = source.required_docs ?? [];
  const optionalDocs = source.optional_docs ?? [];
  const requiredFields = source.required_fields ?? [];
  const optionalFields = source.optional_fields ?? [];

  const map = {} as RequirementsMap;
  for (const key of REQUIREMENT_DOC_KEYS) {
    map[key] = requiredDocs.includes(key) ? 'required' : optionalDocs.includes(key) ? 'optional' : 'off';
  }
  for (const key of REQUIREMENT_FIELD_KEYS) {
    map[key] = requiredFields.includes(key) ? 'required' : optionalFields.includes(key) ? 'optional' : 'off';
  }

  // KNOWN AMBIGUITY (accepted, per spec): this reads `required_fields`
  // lacking the key exactly the same whether the job predates this feature
  // (legacy flag should win) or an employer explicitly turned the row to
  // Off post-migration while the legacy flag was never cleared (their choice
  // gets silently reverted on next load). The spec names only the former
  // case ("job.work_authorization_required=true + required_fields lacks
  // 'work_authorization' -> initialize Required"); there is no wire signal
  // to tell the two apart, so this is a one-time initialization rule, not a
  // live sync -- once `jobFormToBasePayload` round-trips a save, the arrays
  // become authoritative for that job going forward.
  if (source.work_authorization_required && map.work_authorization === 'off') {
    map.work_authorization = 'required';
  }

  return map;
}

/** Set one key's state, returning a new map (never mutates the input). */
export function setRequirementState(
  map: RequirementsMap,
  key: RequirementKey,
  state: RequirementState,
): RequirementsMap {
  return { ...map, [key]: state };
}

/**
 * Per-certification requirement (job-flow redesign, FE-T2): each named
 * certification the employer typed gets its own tier and its own
 * proof-required toggle, independent of the legacy `certification_doc`
 * three-state row.
 */
export type CertificationTier = 'required' | 'optional';
export type CertificationRequirement = {
  name: string;
  tier: CertificationTier;
  proof_required: boolean;
};

export function countRequirements(
  map: RequirementsMap,
  certs?: readonly CertificationRequirement[],
): { required: number; optional: number } {
  let required = 0;
  let optional = 0;
  for (const key of REQUIREMENT_KEYS) {
    // 2-arg mode: certs carry their own tier, so certification_doc's map
    // state is not part of this tally (see deriveCertificationDocTier).
    if (certs !== undefined && key === 'certification_doc') continue;
    if (map[key] === 'required') required += 1;
    else if (map[key] === 'optional') optional += 1;
  }
  if (certs !== undefined) {
    for (const cert of certs) {
      if (cert.tier === 'required') required += 1;
      else if (cert.tier === 'optional') optional += 1;
    }
  }
  return { required, optional };
}

/**
 * Display-only summary of what the per-cert proof settings imply for the
 * legacy certification_doc concept. NEVER used to build the write payload --
 * new-shape jobs must OMIT certification_doc from required/optional docs
 * entirely (the backend rejects the combination); this exists for the count
 * badge and locked-mode rendering only.
 */
export function deriveCertificationDocTier(
  certs: readonly CertificationRequirement[],
): RequirementState {
  if (certs.some((cert) => cert.tier === 'required' && cert.proof_required)) return 'required';
  if (certs.some((cert) => cert.proof_required)) return 'optional';
  return 'off';
}

/** The picker's field sub-groups (design: "Identity & contact / Availability & pay / Background / Experience"). */
export const FIELD_GROUPS: Record<'identity' | 'availability' | 'background' | 'experience', readonly RequirementFieldKey[]> = {
  identity: ['work_authorization', 'date_of_birth', 'home_address', 'emergency_contact'],
  availability: ['date_available', 'desired_pay'],
  background: ['worked_here_before', 'education', 'military_service'],
  experience: ['references', 'work_history'],
};

/**
 * The certification_doc row's hint: when the row is not Off and the
 * employer typed free-text certification names in step 2, quote them back
 * ("Will ask for proof of: …"). Returns null when there is nothing to quote,
 * so the caller renders no hint at all rather than an empty sentence.
 */
export function certificationHintNames(certifications: string): string[] {
  return certifications
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Requirements / proof-upload clarity hints
//
// Every hint sentence rendered next to a requirement row is CHOSEN here, not
// in the component: `vitest` runs in the node environment with no DOM, so a
// pure key-selecting function is the only seam these decisions can be tested
// through (same reason `certificationHintNames` above lives here rather than
// inline in `RequirementsPicker`).
//
// The return values are literal-union key paths, relative to the namespace
// the calling component already translates against, so a renamed message key
// fails typecheck instead of silently rendering the raw path at runtime.
//
// The semantics encoded below are the BACKEND's, not a UI preference:
//   * Legacy docs (`REQUIREMENT_DOC_KEYS`) -- Required means the file upload
//     itself is mandatory at apply (`missingRequiredDocuments`,
//     infra/lambda/lib/applications.ts). There is NO attestation path for
//     these: a worker cannot say "I have it" instead of attaching it.
//   * Named certifications (`certification_requirements`) -- tier 'required'
//     means the worker must attest YES; `proof_required` ADDS a file to that
//     attestation (`missingRequiredCertClaims` / `missingRequiredCertProofs`,
//     lib/certification-claims.ts). Tier 'optional' NEVER blocks an
//     application, whatever `proof_required` says -- which is why every
//     helper here collapses optional to a single "never blocks" sentence
//     rather than branching on the proof flag.
// ---------------------------------------------------------------------------

/** Employer-facing hint for one named certification row (namespace: `job_requirements`). */
export type CertificationHintKey =
  | 'picker.cert_hint_required_proof'
  | 'picker.cert_hint_required_attest'
  | 'picker.cert_hint_optional';

/**
 * What this tier x proof-toggle combination actually asks of an applicant.
 *
 * `optional` deliberately ignores `proofRequired`: an optional cert never
 * blocks, so promising a mandatory upload there would be a lie the backend
 * does not enforce.
 */
export function certificationHintKey(
  tier: CertificationTier,
  proofRequired: boolean,
): CertificationHintKey {
  if (tier !== 'required') return 'picker.cert_hint_optional';
  return proofRequired ? 'picker.cert_hint_required_proof' : 'picker.cert_hint_required_attest';
}

/** Employer-facing hint for one legacy document row (namespace: `job_requirements`). */
export type DocHintKey = 'picker.doc_hint_required' | 'picker.doc_hint_optional';

/**
 * The legacy-doc equivalent, keyed off the three-state row's state.
 *
 * `off` returns `undefined` (the row is not asked at all, so there is nothing
 * to explain) rather than an empty string, so the caller renders no hint
 * element instead of an empty sentence.
 *
 * DOC ROWS ONLY. The copy says "this document" -- do not reuse it for the
 * picker's question rows, which are not uploads.
 */
export function docHintKey(state: RequirementState): DocHintKey | undefined {
  if (state === 'required') return 'picker.doc_hint_required';
  if (state === 'optional') return 'picker.doc_hint_optional';
  return undefined;
}

/** Worker-facing note on a named-cert claim row (namespace: `worker_job_detail.apply_flow`). */
export type WorkerCertNoteKey = 'cert_attest_note' | 'cert_proof_note';

/**
 * What the worker should expect after answering "yes" to a named cert.
 *
 * Ordering matters, and every `undefined` branch is load-bearing:
 *   * Not yet claimed yes -> nothing to say.
 *   * No proof required -> `cert_attest_note` ("no upload needed"), the case
 *     that has no render site at all today: the whole proof area is gated on
 *     `proof_required`, so an attestation-only cert currently shows a yes/no
 *     control and no explanation of what happens next.
 *   * Proof already attached -> the vault-match line already says so.
 *   * Optional tier -> silent, because `cert_unverified_note` ("you can apply
 *     without proof") owns that row; adding "upload ... to continue" beside
 *     it would contradict it AND misstate the gate, since an optional cert
 *     never blocks.
 *   * `blockingError` (the red `errors.cert_proof`) -> silent, so the row
 *     never stacks two near-identical "to continue" sentences.
 */
export function workerCertNoteKey(args: {
  claimed: boolean | null;
  tier: CertificationTier;
  proofRequired: boolean;
  hasProof: boolean;
  blockingError: boolean;
}): WorkerCertNoteKey | undefined {
  if (args.claimed !== true) return undefined;
  if (!args.proofRequired) return 'cert_attest_note';
  if (args.hasProof) return undefined;
  if (args.tier !== 'required') return undefined;
  if (args.blockingError) return undefined;
  return 'cert_proof_note';
}

/** Worker-facing requirement-row hint (namespace: `worker_job_detail.what_you_need`). */
export type WhatYouNeedHintKey =
  | 'hint_doc_required'
  | 'hint_doc_optional'
  | 'hint_cert_required_proof'
  | 'hint_cert_required_attest'
  | 'hint_cert_optional';

/**
 * The worker-voiced counterpart of the two employer helpers above, shared by
 * the pre-apply "What you'll need" panel (second line of each row) and the
 * apply flow's document rows.
 *
 * Both call sites already render a Required/Optional badge, so this hint
 * carries the MECHANISM (upload / attest / never blocks), never a restatement
 * of the tier.
 *
 * One suppression rule for both surfaces: no hint when the row already
 * carries a satisfied-by-vault badge (`satisfied`) or a blocking error line
 * (`blockingError`). In both cases the row's own status line is more specific
 * than a generic explanation of the requirement, and stacking the two reads
 * as a contradiction ("already in your vault" above "you'll need to upload
 * this").
 */
export function whatYouNeedHintKey(args: {
  kind: 'doc' | 'cert';
  tier: CertificationTier;
  proofRequired: boolean;
  satisfied: boolean;
  blockingError: boolean;
}): WhatYouNeedHintKey | undefined {
  if (args.satisfied || args.blockingError) return undefined;
  if (args.kind === 'doc') {
    return args.tier === 'required' ? 'hint_doc_required' : 'hint_doc_optional';
  }
  if (args.tier !== 'required') return 'hint_cert_optional';
  return args.proofRequired ? 'hint_cert_required_proof' : 'hint_cert_required_attest';
}
