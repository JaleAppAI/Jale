// Pure state machine backing the in-page worker apply flow: which step is
// showing, the answers draft, which optional fields were skipped/touched/
// prefilled, and the certification claims draft. No validation lives here
// -- the component validates (via `canSubmitAnswers`/`canSubmitCertClaims`)
// before dispatching a forward `next`/`goto`; this reducer only moves state.
import {
  emptyAnswerDraft,
  APPLY_PAY_INTERVALS,
  EDUCATION_LEVELS,
  MAX_REPEATING_ENTRIES,
  type AnswerDraft,
  type ReferenceEntry,
  type WorkHistoryEntry,
} from './application-answers-form';
import { emptyCertClaimDraft, type CertClaimDraft } from './certification-claims';

export const APPLY_STEP_IDS = ['questions', 'documents', 'review'] as const;
export type ApplyStepId = typeof APPLY_STEP_IDS[number];

const LAST_STEP_INDEX = APPLY_STEP_IDS.length - 1;

export type ApplyFlowState = {
  stepIndex: number;
  maxVisitedIndex: number;
  draft: AnswerDraft;
  skipped: Set<string>;
  touched: Set<string>;
  prefilledKeys: Set<string>;
  certClaims: CertClaimDraft;
};

export type ApplyFlowAction =
  | { type: 'goto'; index: number }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'update_field'; key: keyof AnswerDraft; value: unknown }
  | { type: 'toggle_skip'; key: string }
  | { type: 'set_cert_claim'; name: string; has: boolean }
  | { type: 'apply_defaults'; defaults: Record<string, unknown> }
  | { type: 'reset'; certNames: readonly string[] };

export function initialApplyFlowState(certNames: readonly string[]): ApplyFlowState {
  return {
    stepIndex: 0,
    maxVisitedIndex: 0,
    draft: emptyAnswerDraft(),
    skipped: new Set(),
    touched: new Set(),
    prefilledKeys: new Set(),
    certClaims: emptyCertClaimDraft(certNames),
  };
}

function clampStepIndex(index: number): number {
  if (Number.isNaN(index)) return 0;
  return Math.min(LAST_STEP_INDEX, Math.max(0, index));
}

/** A step can be jumped to iff it has already been visited (<= maxVisited), and is a real step. */
export function canJumpToStep(targetIndex: number, maxVisitedIndex: number): boolean {
  return targetIndex >= 0 && targetIndex <= LAST_STEP_INDEX && targetIndex <= maxVisitedIndex;
}

/** Has the worker done anything worth not silently discarding? */
export function flowHasProgress(state: ApplyFlowState): boolean {
  if (state.touched.size > 0) return true;
  if (state.maxVisitedIndex > 0) return true;
  for (const claim of Object.values(state.certClaims)) {
    if (claim.has !== null) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// mergeDefaultsIntoDraft: structural (not completeness) validation of a
// stored-default value per AnswerDraft field, so a malformed stored default
// (e.g. from a stale profile snapshot) is skipped rather than crashing or
// silently corrupting the draft with the wrong shape. A structurally valid
// but *incomplete* value (e.g. a home_address missing city/state/zip) is
// still applied -- completeness is `isFieldComplete`'s job at submit time,
// not this one's.
// ---------------------------------------------------------------------------

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isBooleanOrNull(v: unknown): v is boolean | null {
  return v === null || typeof v === 'boolean';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateWorkAuthorization(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function validatePlainString(v: unknown): string | undefined {
  return isString(v) ? v : undefined;
}

function validateDesiredPay(v: unknown): AnswerDraft['desired_pay'] | undefined {
  if (!isPlainObject(v)) return undefined;
  const { amount, interval } = v;
  if (!isString(amount)) return undefined;
  if (!isString(interval) || !(APPLY_PAY_INTERVALS as readonly string[]).includes(interval)) return undefined;
  return { amount, interval: interval as AnswerDraft['desired_pay']['interval'] };
}

function validateHomeAddress(v: unknown): AnswerDraft['home_address'] | undefined {
  if (!isPlainObject(v)) return undefined;
  const { street, apartment, city, state, zip } = v;
  if (!isString(street) || !isString(apartment) || !isString(city) || !isString(state) || !isString(zip)) {
    return undefined;
  }
  return { street, apartment, city, state, zip };
}

function validateEmergencyContact(v: unknown): AnswerDraft['emergency_contact'] | undefined {
  if (!isPlainObject(v)) return undefined;
  const { name, phone } = v;
  if (!isString(name) || !isString(phone)) return undefined;
  return { name, phone };
}

function validateWorkedHereBefore(v: unknown): AnswerDraft['worked_here_before'] | undefined {
  if (!isPlainObject(v)) return undefined;
  const { answer, when } = v;
  if (!isBooleanOrNull(answer)) return undefined;
  if (!isString(when)) return undefined;
  return { answer, when };
}

function validateEducation(v: unknown): AnswerDraft['education'] | undefined {
  if (!isPlainObject(v)) return undefined;
  const { level, graduated } = v;
  if (!isString(level)) return undefined;
  if (level !== '' && !(EDUCATION_LEVELS as readonly string[]).includes(level)) return undefined;
  if (!isBooleanOrNull(graduated)) return undefined;
  return { level: level as AnswerDraft['education']['level'], graduated };
}

function validateReferenceEntry(v: unknown): ReferenceEntry | undefined {
  if (!isPlainObject(v)) return undefined;
  const { name, relationship, company, phone } = v;
  if (!isString(name) || !isString(relationship) || !isString(company) || !isString(phone)) return undefined;
  return { name, relationship, company, phone };
}

function validateReferences(v: unknown): ReferenceEntry[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_REPEATING_ENTRIES) return undefined;
  const out: ReferenceEntry[] = [];
  for (const item of v) {
    const entry = validateReferenceEntry(item);
    if (!entry) return undefined;
    out.push(entry);
  }
  return out;
}

function validateWorkHistoryEntry(v: unknown): WorkHistoryEntry | undefined {
  if (!isPlainObject(v)) return undefined;
  const { company, title, from, to, responsibilities, reason_for_leaving: reasonForLeaving, may_contact: mayContact } = v;
  if (
    !isString(company) || !isString(title) || !isString(from) || !isString(to) ||
    !isString(responsibilities) || !isString(reasonForLeaving)
  ) {
    return undefined;
  }
  if (!isBooleanOrNull(mayContact)) return undefined;
  return {
    company, title, from, to, responsibilities,
    reason_for_leaving: reasonForLeaving, may_contact: mayContact,
  };
}

function validateWorkHistory(v: unknown): WorkHistoryEntry[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_REPEATING_ENTRIES) return undefined;
  const out: WorkHistoryEntry[] = [];
  for (const item of v) {
    const entry = validateWorkHistoryEntry(item);
    if (!entry) return undefined;
    out.push(entry);
  }
  return out;
}

function validateMilitaryService(v: unknown): AnswerDraft['military_service'] | undefined {
  if (!isPlainObject(v)) return undefined;
  const { served, branch, from, to, rank_at_discharge: rankAtDischarge, discharge_type: dischargeType } = v;
  if (!isBooleanOrNull(served)) return undefined;
  if (!isString(branch) || !isString(from) || !isString(to) || !isString(rankAtDischarge) || !isString(dischargeType)) {
    return undefined;
  }
  return {
    served, branch, from, to,
    rank_at_discharge: rankAtDischarge, discharge_type: dischargeType,
  };
}

const ANSWER_DRAFT_KEYS: readonly (keyof AnswerDraft)[] = [
  'work_authorization', 'date_available', 'desired_pay', 'date_of_birth', 'home_address',
  'emergency_contact', 'worked_here_before', 'education', 'references', 'work_history', 'military_service',
];

/** Structurally validates one stored default value against its AnswerDraft field shape; undefined = reject. */
function validateDefaultValue(key: keyof AnswerDraft, value: unknown): unknown {
  switch (key) {
    case 'work_authorization':
      return validateWorkAuthorization(value);
    case 'date_available':
    case 'date_of_birth':
      return validatePlainString(value);
    case 'desired_pay':
      return validateDesiredPay(value);
    case 'home_address':
      return validateHomeAddress(value);
    case 'emergency_contact':
      return validateEmergencyContact(value);
    case 'worked_here_before':
      return validateWorkedHereBefore(value);
    case 'education':
      return validateEducation(value);
    case 'references':
      return validateReferences(value);
    case 'work_history':
      return validateWorkHistory(value);
    case 'military_service':
      return validateMilitaryService(value);
    default:
      return undefined;
  }
}

/**
 * Fills only the keys of `defaults` that are NOT already in `touched`,
 * validating each value structurally against its AnswerDraft field shape
 * first -- a malformed stored default is skipped, never applied, never
 * throws. Never mutates the input `draft`. `prefilledKeys` reports exactly
 * the keys actually filled (so callers can union it into cumulative state
 * across repeated calls).
 */
export function mergeDefaultsIntoDraft(
  draft: AnswerDraft,
  defaults: Record<string, unknown>,
  touched: ReadonlySet<string>,
): { draft: AnswerDraft; prefilledKeys: Set<string> } {
  let nextDraft = draft;
  const prefilledKeys = new Set<string>();
  for (const [key, rawValue] of Object.entries(defaults)) {
    if (touched.has(key)) continue;
    if (!(ANSWER_DRAFT_KEYS as readonly string[]).includes(key)) continue;
    const draftKey = key as keyof AnswerDraft;
    const validated = validateDefaultValue(draftKey, rawValue);
    if (validated === undefined) continue;
    nextDraft = { ...nextDraft, [draftKey]: validated };
    prefilledKeys.add(key);
  }
  return { draft: nextDraft, prefilledKeys };
}

export function applyFlowReducer(state: ApplyFlowState, action: ApplyFlowAction): ApplyFlowState {
  switch (action.type) {
    case 'goto': {
      const nextIndex = clampStepIndex(action.index);
      return {
        ...state,
        stepIndex: nextIndex,
        maxVisitedIndex: Math.max(state.maxVisitedIndex, nextIndex),
      };
    }
    case 'next': {
      const nextIndex = clampStepIndex(state.stepIndex + 1);
      return {
        ...state,
        stepIndex: nextIndex,
        maxVisitedIndex: Math.max(state.maxVisitedIndex, nextIndex),
      };
    }
    case 'back': {
      return { ...state, stepIndex: clampStepIndex(state.stepIndex - 1) };
    }
    case 'update_field': {
      const touched = new Set(state.touched);
      touched.add(action.key);
      return {
        ...state,
        draft: { ...state.draft, [action.key]: action.value } as AnswerDraft,
        touched,
      };
    }
    case 'toggle_skip': {
      const skipped = new Set(state.skipped);
      if (skipped.has(action.key)) skipped.delete(action.key);
      else skipped.add(action.key);
      // A deliberate skip is itself progress, and it must also stop
      // `apply_defaults` from repopulating the field the worker just
      // declined -- so it counts as touched too.
      const touched = new Set(state.touched);
      touched.add(action.key);
      return { ...state, skipped, touched };
    }
    case 'set_cert_claim': {
      return {
        ...state,
        certClaims: { ...state.certClaims, [action.name]: { has: action.has } },
      };
    }
    case 'apply_defaults': {
      const { draft, prefilledKeys } = mergeDefaultsIntoDraft(state.draft, action.defaults, state.touched);
      const mergedPrefilledKeys = new Set(state.prefilledKeys);
      prefilledKeys.forEach((key) => mergedPrefilledKeys.add(key));
      return { ...state, draft, prefilledKeys: mergedPrefilledKeys };
    }
    case 'reset':
      return initialApplyFlowState(action.certNames);
    default:
      return state;
  }
}
