// Pure state machine + derivations backing the STAGE-2 "complete your
// details" door (`/worker/applications/[id]`).
//
// Two things live here and nowhere else:
//
//  1. The eleven `AnswerDraft` structural validators and
//     `mergeDefaultsIntoDraft`, MOVED here from `apply-flow-view.ts` in
//     sprint 23. Field answers left stage 1 with them: apply now carries
//     `prompt_answers` alone, and the only surface that still merges stored
//     defaults into a draft is this door.
//  2. The stage-2 reducer itself, which mirrors `lib/onboarding-flow.ts`'s
//     shape because this is the same kind of thing -- a SECOND DOOR onto an
//     engine WhatsApp also drives
//     (`infra/lambda/lib/application-requirements.ts`).
//
// WHAT IS DELIBERATELY ABSENT: any notion of a lock version. B4.0 #4 settled
// that the stage-2 door has none -- the merges commute, prompt answers are
// write-once at SQL level, and `details_completed_at` is guarded by
// `IS NULL`. So there is no `conflict` action and no retry-once path; the
// only refusal a write comes back with is `blocked`, which already carries
// the fresh state document.
import {
  emptyAnswerDraft,
  buildAnswersPayload,
  type AnswerDraft,
  APPLY_PAY_INTERVALS,
  EDUCATION_LEVELS,
  MAX_REPEATING_ENTRIES,
  type ReferenceEntry,
  type WorkHistoryEntry,
} from './application-answers-form';
import { emptyCertClaimDraft, type CertClaimDraft } from './certification-claims';
import { normalizeApplicationStatus, TERMINAL_APPLICATION_STATUSES } from './status';
import type { ErrorKind } from './api/errors';
import type {
  ApplicationRequirementsRemaining,
  ApplicationRequirementsState,
} from './api/worker';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The worker's answer to one employer prompt. B4.0 #6 is the single bound set
 * for both doors: non-blank, at most 1000 characters, and NO MINIMUM -- the
 * 10-char floor an earlier draft carried was dropped, because "yes" is a
 * complete answer to "Do you have your own truck?".
 *
 * These live here rather than in `lib/pre-application-prompts.ts` (the
 * employer-side prompt editor's module, owned by a sibling lane and not
 * present on this branch) so every file in this lane compiles on its own.
 */
export const MAX_PROMPT_ANSWER_CHARS = 1000;

export function promptAnswerTooLong(text: string): boolean {
  return text.trim().length > MAX_PROMPT_ANSWER_CHARS;
}

/** Non-blank and within the cap. There is no lower bound beyond non-blank. */
export function promptAnswerAcceptable(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_PROMPT_ANSWER_CHARS;
}

/** Prompt ids whose answer is missing or unacceptable, in prompt order. */
export function missingPromptAnswers(
  prompts: readonly { id: string }[],
  answers: Readonly<Record<string, string>>,
): string[] {
  return prompts.filter((p) => !promptAnswerAcceptable(answers[p.id] ?? '')).map((p) => p.id);
}

/**
 * The door rejects a batch of more than 20 keys OUTRIGHT rather than
 * truncating it, so `answersBatch` CHUNKS at this size instead of clipping --
 * silently dropping the 21st answer would be data loss the worker never sees.
 */
export const MAX_ANSWERS_PER_BATCH = 20;

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

// ---------------------------------------------------------------------------
// Steps and terminal screens
// ---------------------------------------------------------------------------

/**
 * The three panels of the stage-2 page. Prompts are deliberately NOT a fourth
 * id: the prompt top-up belongs to stage ONE (it finishes an apply a worker
 * abandoned mid-conversation on WhatsApp), it is not stage-gated on the
 * backend, and it renders as a GATE ahead of this stepper rather than as a
 * step inside it.
 */
export const REQUIREMENT_STEP_IDS = ['details', 'documents', 'review'] as const;
export type RequirementStepId = typeof REQUIREMENT_STEP_IDS[number];

const LAST_STEP_INDEX = REQUIREMENT_STEP_IDS.length - 1;

/**
 * The three screens that are NOT a form. `null` means "render the flow".
 *
 * PRECEDENCE, decided once and pinned by tests, because more than one of these
 * is routinely true at the same moment (a hired worker's application is both
 * closed AND complete):
 *
 *   closed > already_complete > prompts-outstanding > not_requested
 *
 * `closed` wins because nothing a worker types can reach an employer who is no
 * longer listening. `already_complete` beats `not_requested` so a finished
 * application never reads as "we haven't asked you for anything".
 *
 * PROMPTS BEAT `not_requested`, which is the subtle one. A worker who applied
 * over WhatsApp and bailed halfway through the employer's questions sits at
 * `stage === 'apply'` with unanswered prompts. Under a literal reading of
 * "stage 'apply' means not_requested" that worker would be shown a dead end on
 * the only surface that could take their answers -- and prompt answers are
 * explicitly NOT stage-gated on the backend for exactly this reason. So an
 * outstanding prompt suppresses the `not_requested` panel and the flow renders
 * the top-up instead.
 *
 * DERIVED FROM TIMESTAMPS, NEVER FROM `status` (B4.0 #7): an employer who moves
 * a `details_requested` applicant along to `contacted`/`talking` must not kill
 * a fill that is already open.
 */
export type TerminalScreen = 'closed' | 'already_complete' | 'not_requested';

export function terminalScreen(state: ApplicationRequirementsState): TerminalScreen | null {
  const { application, job, remaining } = state;

  const jobOver = job.status === 'filled' || job.status === 'closed';
  const applicationOver = TERMINAL_APPLICATION_STATUSES.includes(
    normalizeApplicationStatus(application.status),
  );
  if (jobOver || applicationOver) return 'closed';

  if (application.details_completed_at !== null) return 'already_complete';

  if (remaining.prompts.length > 0) return null;

  // The stage, read off the TIMESTAMP rather than the `stage` field, so the
  // two cannot disagree here.
  if (application.details_requested_at === null) return 'not_requested';

  return null;
}

/**
 * Where to open the stepper: the first step that still owes something, so a
 * worker who only has a document left is not walked back through answers they
 * already gave on WhatsApp. Falls through to the review step when nothing is
 * outstanding (Finish is the only thing left to press).
 */
export function initialStepIndex(remaining: ApplicationRequirementsRemaining): number {
  if (remaining.fields.length > 0) return 0;
  if (
    remaining.docs.length > 0 ||
    remaining.certifications.unclaimed.length > 0 ||
    remaining.certifications.unproven.length > 0
  ) {
    return 1;
  }
  return LAST_STEP_INDEX;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export type RequirementBucket = { done: number; total: number };

export type RequirementsTotals = {
  prompts: RequirementBucket;
  fields: RequirementBucket;
  docs: RequirementBucket;
  certifications: RequirementBucket;
  /** The single badgeable number the banners and the chip share. */
  remainingCount: number;
  total: number;
  done: number;
};

/**
 * `outstanding` is clamped into `[0, total]` before subtracting: the two
 * numbers come from different halves of the payload (the job's own arrays and
 * the engine's `remaining` view), and a job edited between the two reads can
 * legitimately leave more outstanding than the current total asks for. A
 * negative `done` would render as a bar running backwards.
 */
function bucket(total: number, outstanding: number): RequirementBucket {
  const safeTotal = Math.max(0, total);
  const safeOutstanding = Math.min(Math.max(0, outstanding), safeTotal);
  return { done: safeTotal - safeOutstanding, total: safeTotal };
}

/**
 * Counted against what the JOB asks, minus the parts nothing can ever satisfy.
 *
 * `uncollectableDocs` (the legacy `ssn` slot) is subtracted from the doc total
 * rather than counted as permanently outstanding: no flow on any surface can
 * collect it, so leaving it in would pin the bar below 100% for a worker who
 * has genuinely finished -- which is also exactly why the backend's
 * `remaining.complete` ignores it.
 *
 * Optional fields and optional docs are likewise out: they never block, so
 * counting them would make an application look unfinished forever.
 */
export function requirementsTotals(state: ApplicationRequirementsState): RequirementsTotals {
  const { job, remaining } = state;

  const certsOutstanding = new Set([
    ...remaining.certifications.unclaimed,
    ...remaining.certifications.unproven,
  ]).size;

  const prompts = bucket(job.pre_application_prompts.length, remaining.prompts.length);
  const fields = bucket(job.required_fields.length, remaining.fields.length);
  const docs = bucket(job.required_docs.length - remaining.uncollectableDocs.length, remaining.docs.length);
  const certifications = bucket(
    job.certification_requirements.filter((c) => c.tier === 'required').length,
    certsOutstanding,
  );

  const total = prompts.total + fields.total + docs.total + certifications.total;
  const done = prompts.done + fields.done + docs.done + certifications.done;

  return { prompts, fields, docs, certifications, remainingCount: total - done, total, done };
}

/** 0-100, integer. A job that asks for nothing is already at 100. */
export function progressPercent(totals: RequirementsTotals): number {
  if (totals.total <= 0) return 100;
  return Math.round((totals.done / totals.total) * 100);
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * The subset of actions the two MOVED step components (`QuestionsStep`,
 * `DocumentsCertificationsStep`) may dispatch. Its own type so those
 * components cannot reach for `goto`/`saving`/`hydrate`: navigation and
 * network state belong to the flow, and a step that could dispatch `next`
 * itself would skip the save the flow performs on the way past.
 */
export type FieldEditAction =
  | { type: 'update_field'; key: keyof AnswerDraft; value: unknown }
  | { type: 'toggle_skip'; key: string }
  | { type: 'set_cert_claim'; name: string; has: boolean };

export type RequirementsFlowAction =
  | FieldEditAction
  /** Take the server document as truth and REBUILD the draft from it. */
  | { type: 'hydrate'; server: ApplicationRequirementsState }
  /** Take the server document, KEEP the draft (the worker is mid-edit). */
  | { type: 'sync_server'; server: ApplicationRequirementsState }
  | { type: 'apply_defaults'; defaults: Record<string, unknown> }
  | { type: 'goto'; index: number }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'saving' }
  | { type: 'save_failed'; errorKind: ErrorKind }
  | { type: 'blocked'; server: ApplicationRequirementsState }
  | { type: 'invalid'; errors: Record<string, string> }
  | { type: 'finished'; server: ApplicationRequirementsState };

/**
 * `notice` has exactly one member because there is exactly one thing worth
 * interrupting a worker to say: the OTHER door moved under them (W4f in the
 * prototype -- "You also answered this on WhatsApp, we loaded the latest").
 * Without a lock version there is no conflict event to hang it on, so it is
 * raised by `sync_server` DETECTING that the server's stored answers changed
 * while this tab was open.
 */
export type RequirementsNotice = 'other_door';

export type RequirementsFlowState = {
  server: ApplicationRequirementsState;
  draft: AnswerDraft;
  touched: Set<string>;
  skipped: Set<string>;
  prefilledKeys: Set<string>;
  certClaims: CertClaimDraft;
  /**
   * Did the server already have field answers when this door opened? Guards
   * the once-only defaults merge: the backend now seeds
   * `worker_application_defaults` into the application at ARM time (B4.0 #9),
   * so on nearly every real load this is true and the client-side merge is a
   * no-op it must not perform.
   */
  serverAnswered: boolean;
  stepIndex: number;
  saving: boolean;
  errorKind: ErrorKind | null;
  /** Consecutive failed saves. Two is where the flow stops insisting. */
  failures: number;
  notice: RequirementsNotice | null;
  /** Per-key reasons from a 400 `invalid_answers`, cleared on the next edit. */
  invalidFields: Record<string, string>;
  finished: 'complete' | 'incomplete' | null;
};

/** Rebuilds an `AnswerDraft` from the server's stored answers. */
export function draftFromServer(answers: Record<string, unknown>): AnswerDraft {
  return mergeDefaultsIntoDraft(emptyAnswerDraft(), answers, new Set()).draft;
}

/** Rebuilds the certification-claim draft from the server's stored claims. */
export function certClaimsFromServer(state: ApplicationRequirementsState): CertClaimDraft {
  const claims = emptyCertClaimDraft(state.job.certification_requirements.map((c) => c.name));
  for (const claim of state.certifications) {
    claims[claim.name] = { has: claim.has };
  }
  return claims;
}

export function initRequirementsFlowState(server: ApplicationRequirementsState): RequirementsFlowState {
  return {
    server,
    draft: draftFromServer(server.answers),
    touched: new Set(),
    skipped: new Set(),
    prefilledKeys: new Set(),
    certClaims: certClaimsFromServer(server),
    serverAnswered: Object.keys(server.answers).length > 0,
    stepIndex: initialStepIndex(server.remaining),
    saving: false,
    errorKind: null,
    failures: 0,
    notice: null,
    invalidFields: {},
    finished: null,
  };
}

function clampStepIndex(index: number): number {
  if (Number.isNaN(index)) return 0;
  return Math.min(LAST_STEP_INDEX, Math.max(0, index));
}

/**
 * Did the other door store something new? Compared on the SERVER's own two
 * answer maps only -- never against the draft, which is the worker's unsaved
 * typing and is expected to differ.
 */
function serverDiverged(
  before: ApplicationRequirementsState,
  after: ApplicationRequirementsState,
): boolean {
  return (
    JSON.stringify(before.answers) !== JSON.stringify(after.answers) ||
    JSON.stringify(before.prompt_answers) !== JSON.stringify(after.prompt_answers)
  );
}

export function requirementsFlowReducer(
  state: RequirementsFlowState,
  action: RequirementsFlowAction,
): RequirementsFlowState {
  switch (action.type) {
    case 'hydrate': {
      // The worker's edits just landed, so the server IS the draft now.
      return {
        ...state,
        server: action.server,
        draft: draftFromServer(action.server.answers),
        touched: new Set(),
        certClaims: certClaimsFromServer(action.server),
        serverAnswered: state.serverAnswered || Object.keys(action.server.answers).length > 0,
        saving: false,
        errorKind: null,
        failures: 0,
        invalidFields: {},
      };
    }
    case 'sync_server': {
      // The draft SURVIVES: this fires while the worker may be mid-sentence (a
      // vault upload landed, a background re-GET returned). Only the server
      // half is replaced, and a divergence raises the W4f notice.
      const diverged = serverDiverged(state.server, action.server);
      return {
        ...state,
        server: action.server,
        serverAnswered: state.serverAnswered || Object.keys(action.server.answers).length > 0,
        notice: diverged ? 'other_door' : state.notice,
        saving: false,
      };
    }
    case 'update_field': {
      const touched = new Set(state.touched);
      touched.add(action.key);
      // A key the worker has just retyped is no longer the key the server
      // complained about.
      const invalidFields = { ...state.invalidFields };
      delete invalidFields[action.key as string];
      return {
        ...state,
        draft: { ...state.draft, [action.key]: action.value } as AnswerDraft,
        touched,
        invalidFields,
      };
    }
    case 'toggle_skip': {
      const skipped = new Set(state.skipped);
      if (skipped.has(action.key)) skipped.delete(action.key);
      else skipped.add(action.key);
      // A deliberate skip is progress, and it must also stop `apply_defaults`
      // from repopulating the field the worker just declined -- so it counts
      // as touched too.
      const touched = new Set(state.touched);
      touched.add(action.key);
      return { ...state, skipped, touched };
    }
    case 'set_cert_claim':
      return {
        ...state,
        certClaims: { ...state.certClaims, [action.name]: { has: action.has } },
      };
    case 'apply_defaults': {
      const { draft, prefilledKeys } = mergeDefaultsIntoDraft(state.draft, action.defaults, state.touched);
      const mergedPrefilledKeys = new Set(state.prefilledKeys);
      prefilledKeys.forEach((key) => mergedPrefilledKeys.add(key));
      return { ...state, draft, prefilledKeys: mergedPrefilledKeys };
    }
    case 'goto':
      return { ...state, stepIndex: clampStepIndex(action.index) };
    case 'next':
      return { ...state, stepIndex: clampStepIndex(state.stepIndex + 1) };
    case 'back':
      return { ...state, stepIndex: clampStepIndex(state.stepIndex - 1) };
    case 'saving':
      return { ...state, saving: true, errorKind: null, invalidFields: {} };
    case 'save_failed':
      return { ...state, saving: false, errorKind: action.errorKind, failures: state.failures + 1 };
    case 'blocked':
      // No error copy: the fresh state's own terminal panel IS the message.
      return { ...state, server: action.server, saving: false, errorKind: null };
    case 'invalid':
      // A rejected batch stored NOTHING, so `touched` deliberately survives --
      // the next save must re-send the same keys. `failures` does not move:
      // this is the worker's input, not a broken connection.
      return { ...state, saving: false, invalidFields: action.errors };
    case 'finished':
      return {
        ...state,
        server: action.server,
        saving: false,
        errorKind: null,
        finished: action.server.application.details_completed_at !== null ? 'complete' : 'incomplete',
      };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Outgoing payloads
// ---------------------------------------------------------------------------

/**
 * The field answers to POST, as CHUNKS of at most `MAX_ANSWERS_PER_BATCH` keys.
 *
 * TOUCHED-ONLY. Re-sending an untouched key would be this door overwriting
 * what the other one stored with a value the worker never looked at -- the
 * merges only commute because each door sends what it actually changed.
 *
 * CHUNKED rather than truncated: the door rejects an oversized batch outright
 * (see `MAX_ANSWERS_PER_BATCH`), so a caller posts these in order and hydrates
 * from the LAST response.
 */
export function answersBatch(state: RequirementsFlowState): Record<string, unknown>[] {
  const { required_fields: requiredFields, optional_fields: optionalFields } = state.server.job;
  const full = buildAnswersPayload(requiredFields, optionalFields, state.draft, state.skipped);

  const touchedEntries = Object.entries(full).filter(([key]) => state.touched.has(key));
  if (touchedEntries.length === 0) return [];

  const chunks: Record<string, unknown>[] = [];
  for (let i = 0; i < touchedEntries.length; i += MAX_ANSWERS_PER_BATCH) {
    chunks.push(Object.fromEntries(touchedEntries.slice(i, i + MAX_ANSWERS_PER_BATCH)));
  }
  return chunks;
}
