import { PAY_INTERVALS, PayInterval, isValidIsoDate } from './job-fields';

// The single authoritative validator for job_applications.application_answers
// (073_job_application_requirements.sql, widened by
// 074_job_optional_requirements.sql). Both the employer-web apply flow and
// the WhatsApp incremental-fill flow must call this -- it is the only place
// the per-key answer shapes are defined.
//
// Three-state model: every per-job data point is Off / Optional / Required.
// - Off:      the field's key is in neither requiredFields nor
//             optionalFields -- present in answers is 'unknown_answer_key'.
// - Optional: the key may be entirely absent from answers (fine); if
//             present, it validates with the same per-key shape rules as a
//             required field, and an invalid value still fails with
//             'invalid_<key>'.
// - Required: the key must be present in answers (absence is
//             'missing_answers'), and it validates with the same rules.
// A key listed in both requiredFields and optionalFields (should not
// happen -- see jobs_fields_tiers_disjoint / jobs_docs_tiers_disjoint in
// 074_job_optional_requirements.sql) is treated as required, the stricter
// of the two readings.

export type ApplicationAnswers = Record<string, unknown>;

export type ValidateAnswersResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: 'missing_answers'; missing: string[] }
  | { ok: false; error: string }; // 'invalid_<key>' | 'unknown_answer_key' | 'invalid_answers'

export const EDUCATION_LEVELS = [
  'none',
  'primary',
  'high_school',
  'ged',
  'some_college',
  'college',
  'trade_school',
] as const;

const MAX_ANSWERS_JSON_LENGTH = 16384;

// Digits, space, parentheses, plus, hyphen, and period only. Length bound
// (7..20) is enforced inline so a single regex covers the whole
// emergency_contact.phone / references[].phone shape.
const PHONE_PATTERN = /^[0-9 ()+.-]{7,20}$/;
const STATE_PATTERN = /^[A-Z]{2}$/;
const ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function hasOnlyAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((key) => allowed.includes(key));
}

/**
 * String bound check + trim. The `max` cap is enforced on the RAW,
 * pre-trim string so padding with whitespace cannot smuggle extra
 * characters past it; `min` is a content floor enforced on the TRIMMED
 * string, so a whitespace-only value cannot satisfy a required field. The
 * TRIMMED value is what gets stored.
 */
function boundedString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > max) return null;
  const trimmed = value.trim();
  if (trimmed.length < min) return null;
  return trimmed;
}

function isPhone(value: unknown): value is string {
  return typeof value === 'string' && PHONE_PATTERN.test(value);
}

function setOptionalBoundedString(
  result: Record<string, unknown>,
  key: string,
  value: unknown,
  max: number,
): boolean {
  if (value === undefined) return true;
  const parsed = boundedString(value, 0, max);
  if (parsed === null) return false;
  result[key] = parsed;
  return true;
}

function validateWorkAuthorization(value: unknown): boolean | null {
  return isBoolean(value) ? value : null;
}

function validateDateAvailable(value: unknown): string | null {
  return typeof value === 'string' && isValidIsoDate(value) ? value : null;
}

function validateDesiredPay(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (!hasOnlyAllowedKeys(value, ['amount', 'interval'])) return null;

  const { amount, interval } = value;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 9999) return null;
  if (typeof interval !== 'string' || !PAY_INTERVALS.includes(interval as PayInterval)) return null;

  return { amount, interval };
}

function validateDateOfBirth(value: unknown): string | null {
  if (typeof value !== 'string' || !isValidIsoDate(value)) return null;

  const [year, month, day] = value.split('-').map(Number);
  const dob = Date.UTC(year, month - 1, day);

  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (dob >= todayUtc) return null; // must be strictly before today

  const minDobUtc = Date.UTC(now.getUTCFullYear() - 120, now.getUTCMonth(), now.getUTCDate());
  if (dob < minDobUtc) return null; // not more than 120 years ago

  return value;
}

function validateHomeAddress(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (!hasOnlyAllowedKeys(value, ['street', 'apartment', 'city', 'state', 'zip'])) return null;

  const street = boundedString(value.street, 1, 200);
  if (street === null) return null;

  const city = boundedString(value.city, 1, 100);
  if (city === null) return null;

  if (typeof value.state !== 'string' || !STATE_PATTERN.test(value.state)) return null;
  if (typeof value.zip !== 'string' || !ZIP_PATTERN.test(value.zip)) return null;

  const result: Record<string, unknown> = { street, city, state: value.state, zip: value.zip };
  if (!setOptionalBoundedString(result, 'apartment', value.apartment, 50)) return null;

  return result;
}

function validateEmergencyContact(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (!hasOnlyAllowedKeys(value, ['name', 'phone'])) return null;

  const name = boundedString(value.name, 1, 100);
  if (name === null) return null;
  if (!isPhone(value.phone)) return null;

  return { name, phone: value.phone };
}

function validateWorkedHereBefore(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (!hasOnlyAllowedKeys(value, ['answer', 'when'])) return null;
  if (!isBoolean(value.answer)) return null;

  const result: Record<string, unknown> = { answer: value.answer };
  if (!setOptionalBoundedString(result, 'when', value.when, 100)) return null;

  return result;
}

function validateEducation(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (!hasOnlyAllowedKeys(value, ['level', 'graduated'])) return null;
  if (typeof value.level !== 'string' || !(EDUCATION_LEVELS as readonly string[]).includes(value.level)) return null;

  const result: Record<string, unknown> = { level: value.level };
  if (value.graduated !== undefined) {
    if (!isBoolean(value.graduated)) return null;
    result.graduated = value.graduated;
  }

  return result;
}

function validateReferenceEntry(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (!hasOnlyAllowedKeys(value, ['name', 'relationship', 'company', 'phone'])) return null;

  const name = boundedString(value.name, 1, 100);
  if (name === null) return null;
  const relationship = boundedString(value.relationship, 1, 50);
  if (relationship === null) return null;
  if (!isPhone(value.phone)) return null;

  const result: Record<string, unknown> = { name, relationship, phone: value.phone };
  if (!setOptionalBoundedString(result, 'company', value.company, 100)) return null;

  return result;
}

function validateReferences(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return null;

  const result: Record<string, unknown>[] = [];
  for (const item of value) {
    const parsed = validateReferenceEntry(item);
    if (parsed === null) return null;
    result.push(parsed);
  }
  return result;
}

function validateWorkHistoryEntry(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (
    !hasOnlyAllowedKeys(value, [
      'company',
      'title',
      'from',
      'to',
      'responsibilities',
      'reason_for_leaving',
      'may_contact',
    ])
  ) {
    return null;
  }

  const company = boundedString(value.company, 1, 100);
  if (company === null) return null;
  const title = boundedString(value.title, 1, 100);
  if (title === null) return null;

  const result: Record<string, unknown> = { company, title };
  if (!setOptionalBoundedString(result, 'from', value.from, 20)) return null;
  if (!setOptionalBoundedString(result, 'to', value.to, 20)) return null;
  if (!setOptionalBoundedString(result, 'responsibilities', value.responsibilities, 500)) return null;
  if (!setOptionalBoundedString(result, 'reason_for_leaving', value.reason_for_leaving, 300)) return null;

  if (value.may_contact !== undefined) {
    if (!isBoolean(value.may_contact)) return null;
    result.may_contact = value.may_contact;
  }

  return result;
}

function validateWorkHistory(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return null;

  const result: Record<string, unknown>[] = [];
  for (const item of value) {
    const parsed = validateWorkHistoryEntry(item);
    if (parsed === null) return null;
    result.push(parsed);
  }
  return result;
}

function validateMilitaryService(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (
    !hasOnlyAllowedKeys(value, ['served', 'branch', 'from', 'to', 'rank_at_discharge', 'discharge_type'])
  ) {
    return null;
  }
  if (!isBoolean(value.served)) return null;

  const result: Record<string, unknown> = { served: value.served };
  if (!setOptionalBoundedString(result, 'branch', value.branch, 50)) return null;
  if (!setOptionalBoundedString(result, 'from', value.from, 20)) return null;
  if (!setOptionalBoundedString(result, 'to', value.to, 20)) return null;
  if (!setOptionalBoundedString(result, 'rank_at_discharge', value.rank_at_discharge, 50)) return null;
  if (!setOptionalBoundedString(result, 'discharge_type', value.discharge_type, 50)) return null;

  return result;
}

// Every entry of REQUIRED_FIELD_TYPES (job-fields.ts) must have a validator
// here. requiredFields is caller-supplied (ultimately sourced from
// jobs.required_fields via parseRequiredFields), so an unrecognized field
// name falls through to the "no validator" branch in
// validateApplicationAnswers below rather than throwing.
const FIELD_VALIDATORS: Record<string, (value: unknown) => unknown> = {
  work_authorization: validateWorkAuthorization,
  date_available: validateDateAvailable,
  desired_pay: validateDesiredPay,
  date_of_birth: validateDateOfBirth,
  home_address: validateHomeAddress,
  emergency_contact: validateEmergencyContact,
  worked_here_before: validateWorkedHereBefore,
  education: validateEducation,
  references: validateReferences,
  work_history: validateWorkHistory,
  military_service: validateMilitaryService,
};

export function validateApplicationAnswers(
  requiredFields: readonly string[],
  optionalFields: readonly string[],
  answers: unknown,
): ValidateAnswersResult {
  if (!isPlainObject(answers)) return { ok: false, error: 'invalid_answers' };

  let serialized: string;
  try {
    serialized = JSON.stringify(answers);
  } catch {
    return { ok: false, error: 'invalid_answers' };
  }
  if (serialized.length > MAX_ANSWERS_JSON_LENGTH) return { ok: false, error: 'invalid_answers' };

  // Every own key must be in requiredFields or optionalFields. This also
  // rejects __proto__/constructor-style keys, since neither is ever a
  // member of REQUIRED_FIELD_TYPES.
  for (const key of Object.keys(answers)) {
    if (!requiredFields.includes(key) && !optionalFields.includes(key)) {
      return { ok: false, error: 'unknown_answer_key' };
    }
  }

  // missing is computed against requiredFields ONLY -- an absent optional
  // key is fine.
  const missing = requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(answers, field));
  if (missing.length > 0) {
    return { ok: false, error: 'missing_answers', missing };
  }

  // A key present in both lists (should never happen -- see the
  // three-state model note above) is validated once, as required.
  const presentOptionalFields = optionalFields.filter(
    (field) => !requiredFields.includes(field) && Object.prototype.hasOwnProperty.call(answers, field),
  );

  // Built fresh from validated keys only -- never spread the input.
  const value: Record<string, unknown> = {};
  for (const field of [...requiredFields, ...presentOptionalFields]) {
    const validator = FIELD_VALIDATORS[field];
    if (!validator) {
      return { ok: false, error: `invalid_${field}` };
    }
    const parsed = validator(answers[field]);
    if (parsed === null) {
      return { ok: false, error: `invalid_${field}` };
    }
    value[field] = parsed;
  }

  return { ok: true, value };
}
