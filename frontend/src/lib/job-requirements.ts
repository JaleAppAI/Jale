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

export function countRequirements(map: RequirementsMap): { required: number; optional: number } {
  let required = 0;
  let optional = 0;
  for (const key of REQUIREMENT_KEYS) {
    if (map[key] === 'required') required += 1;
    else if (map[key] === 'optional') optional += 1;
  }
  return { required, optional };
}

/** The picker's field sub-groups (design: "Identity & contact / Availability & pay / Background / Experience"). */
export const FIELD_GROUPS: Record<'identity' | 'availability' | 'background' | 'experience', readonly RequirementFieldKey[]> = {
  identity: ['work_authorization', 'date_of_birth', 'home_address', 'emergency_contact'],
  availability: ['date_available', 'desired_pay'],
  background: ['worked_here_before', 'education', 'military_service'],
  experience: ['references', 'work_history'],
};

/** Fields whose row carries the "sensitive" marker (muted badge + tooltip). */
export const SENSITIVE_FIELD_KEYS: readonly RequirementFieldKey[] = ['date_of_birth', 'home_address'];

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
