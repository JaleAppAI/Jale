// Pure logic backing `ApplicationAnswersForm`: which fields to render, local
// completeness checks (mirroring, but not replacing, the backend's
// `validateApplicationAnswers` in infra/lambda/lib/application-answers.ts --
// this is a client-side pre-check so the worker never submits an answer set
// the server is certain to reject as `missing_answers`/`invalid_answers`),
// and the answers payload builder.
import { REQUIREMENT_FIELD_KEYS, type RequirementFieldKey } from '@/lib/job-requirements';

export const EDUCATION_LEVELS = [
  'none', 'primary', 'high_school', 'ged', 'some_college', 'college', 'trade_school',
] as const;
export type EducationLevel = typeof EDUCATION_LEVELS[number];

export const APPLY_PAY_INTERVALS = ['hourly', 'daily', 'weekly', 'monthly', 'fixed'] as const;
export type ApplyPayInterval = typeof APPLY_PAY_INTERVALS[number];

export type ReferenceEntry = { name: string; relationship: string; company: string; phone: string };
export type WorkHistoryEntry = {
  company: string; title: string; from: string; to: string;
  responsibilities: string; reason_for_leaving: string; may_contact: boolean | null;
};

export const MAX_REPEATING_ENTRIES = 3;

export function emptyReferenceEntry(): ReferenceEntry {
  return { name: '', relationship: '', company: '', phone: '' };
}

export function emptyWorkHistoryEntry(): WorkHistoryEntry {
  return { company: '', title: '', from: '', to: '', responsibilities: '', reason_for_leaving: '', may_contact: null };
}

export type AnswerDraft = {
  work_authorization?: boolean;
  date_available: string;
  desired_pay: { amount: string; interval: ApplyPayInterval };
  date_of_birth: string;
  home_address: { street: string; apartment: string; city: string; state: string; zip: string };
  emergency_contact: { name: string; phone: string };
  worked_here_before: { answer: boolean | null; when: string };
  education: { level: EducationLevel | ''; graduated: boolean | null };
  references: ReferenceEntry[];
  work_history: WorkHistoryEntry[];
  military_service: {
    served: boolean | null; branch: string; from: string; to: string;
    rank_at_discharge: string; discharge_type: string;
  };
};

export function emptyAnswerDraft(): AnswerDraft {
  return {
    work_authorization: undefined,
    date_available: '',
    desired_pay: { amount: '', interval: 'hourly' },
    date_of_birth: '',
    home_address: { street: '', apartment: '', city: '', state: '', zip: '' },
    emergency_contact: { name: '', phone: '' },
    worked_here_before: { answer: null, when: '' },
    education: { level: '', graduated: null },
    references: [],
    work_history: [],
    military_service: { served: null, branch: '', from: '', to: '', rank_at_discharge: '', discharge_type: '' },
  };
}

/** Which of the job's checked fields to render, in the picker's stable order. */
export function visibleFieldKeys(
  requiredFields: readonly string[],
  optionalFields: readonly string[],
): RequirementFieldKey[] {
  const visible = new Set<string>([...requiredFields, ...optionalFields]);
  return REQUIREMENT_FIELD_KEYS.filter((key) => visible.has(key));
}

const STATE_PATTERN = /^[A-Za-z]{2}$/;
const ZIP_PATTERN = /^\d{5}(-\d{4})?$/;
const PHONE_PATTERN = /^[0-9 ()+.-]{7,20}$/;

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

/** Local completeness check -- did the worker fill in enough to submit this field. */
export function isFieldComplete(key: RequirementFieldKey, draft: AnswerDraft): boolean {
  switch (key) {
    case 'work_authorization':
      return draft.work_authorization !== undefined;
    case 'date_available':
      return nonEmpty(draft.date_available);
    case 'desired_pay': {
      const amount = Number(draft.desired_pay.amount);
      return (
        nonEmpty(draft.desired_pay.amount) &&
        Number.isInteger(amount) && amount >= 0 && amount <= 9999 &&
        (APPLY_PAY_INTERVALS as readonly string[]).includes(draft.desired_pay.interval)
      );
    }
    case 'date_of_birth':
      return nonEmpty(draft.date_of_birth);
    case 'home_address': {
      const a = draft.home_address;
      return nonEmpty(a.street) && nonEmpty(a.city) && STATE_PATTERN.test(a.state) && ZIP_PATTERN.test(a.zip);
    }
    case 'emergency_contact':
      return nonEmpty(draft.emergency_contact.name) && PHONE_PATTERN.test(draft.emergency_contact.phone);
    case 'worked_here_before':
      // `when` is optional even when answer=true.
      return draft.worked_here_before.answer !== null;
    case 'education':
      return draft.education.level !== '';
    case 'references':
      return (
        draft.references.length >= 1 && draft.references.length <= MAX_REPEATING_ENTRIES &&
        draft.references.every((r) => nonEmpty(r.name) && nonEmpty(r.relationship) && PHONE_PATTERN.test(r.phone))
      );
    case 'work_history':
      return (
        draft.work_history.length >= 1 && draft.work_history.length <= MAX_REPEATING_ENTRIES &&
        draft.work_history.every((w) => nonEmpty(w.company) && nonEmpty(w.title))
      );
    case 'military_service':
      return draft.military_service.served !== null;
    default:
      return false;
  }
}

/** Required fields the worker still has to fill in before submit is allowed. */
export function missingRequiredFields(
  requiredFields: readonly string[],
  draft: AnswerDraft,
): RequirementFieldKey[] {
  return (requiredFields as RequirementFieldKey[]).filter((key) => !isFieldComplete(key, draft));
}

export function canSubmitAnswers(requiredFields: readonly string[], draft: AnswerDraft): boolean {
  return missingRequiredFields(requiredFields, draft).length === 0;
}

function serializeField(key: RequirementFieldKey, draft: AnswerDraft): unknown {
  switch (key) {
    case 'work_authorization':
      return draft.work_authorization;
    case 'date_available':
      return draft.date_available;
    case 'desired_pay':
      return { amount: Number(draft.desired_pay.amount), interval: draft.desired_pay.interval };
    case 'date_of_birth':
      return draft.date_of_birth;
    case 'home_address': {
      const a = draft.home_address;
      const out: Record<string, string> = {
        street: a.street.trim(), city: a.city.trim(), state: a.state.trim().toUpperCase(), zip: a.zip.trim(),
      };
      if (nonEmpty(a.apartment)) out.apartment = a.apartment.trim();
      return out;
    }
    case 'emergency_contact':
      return { name: draft.emergency_contact.name.trim(), phone: draft.emergency_contact.phone.trim() };
    case 'worked_here_before': {
      const w = draft.worked_here_before;
      const out: Record<string, unknown> = { answer: w.answer === true };
      if (w.answer === true && nonEmpty(w.when)) out.when = w.when.trim();
      return out;
    }
    case 'education': {
      const out: Record<string, unknown> = { level: draft.education.level };
      if (draft.education.graduated !== null) out.graduated = draft.education.graduated;
      return out;
    }
    case 'references':
      return draft.references.map((r) => {
        const out: Record<string, string> = {
          name: r.name.trim(), relationship: r.relationship.trim(), phone: r.phone.trim(),
        };
        if (nonEmpty(r.company)) out.company = r.company.trim();
        return out;
      });
    case 'work_history':
      return draft.work_history.map((w) => {
        const out: Record<string, unknown> = { company: w.company.trim(), title: w.title.trim() };
        if (nonEmpty(w.from)) out.from = w.from.trim();
        if (nonEmpty(w.to)) out.to = w.to.trim();
        if (nonEmpty(w.responsibilities)) out.responsibilities = w.responsibilities.trim();
        if (nonEmpty(w.reason_for_leaving)) out.reason_for_leaving = w.reason_for_leaving.trim();
        if (w.may_contact !== null) out.may_contact = w.may_contact;
        return out;
      });
    case 'military_service': {
      const m = draft.military_service;
      const out: Record<string, unknown> = { served: m.served === true };
      if (m.served === true) {
        if (nonEmpty(m.branch)) out.branch = m.branch.trim();
        if (nonEmpty(m.from)) out.from = m.from.trim();
        if (nonEmpty(m.to)) out.to = m.to.trim();
        if (nonEmpty(m.rank_at_discharge)) out.rank_at_discharge = m.rank_at_discharge.trim();
        if (nonEmpty(m.discharge_type)) out.discharge_type = m.discharge_type.trim();
      }
      return out;
    }
    default:
      return undefined;
  }
}

/**
 * Builds the `answers` payload for `applyToJob`. Renders every required
 * field (assumed complete -- callers gate submit on `canSubmitAnswers`
 * first) and every optional field the worker did NOT skip and did complete.
 * An incomplete or skipped optional field is simply omitted, never sent as
 * a partial/empty value the backend would reject.
 */
export function buildAnswersPayload(
  requiredFields: readonly string[],
  optionalFields: readonly string[],
  draft: AnswerDraft,
  skipped: ReadonlySet<string>,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const key of visibleFieldKeys(requiredFields, optionalFields)) {
    const isRequired = requiredFields.includes(key);
    if (!isRequired) {
      if (skipped.has(key)) continue;
      if (!isFieldComplete(key, draft)) continue;
    }
    answers[key] = serializeField(key, draft);
  }
  return answers;
}

export function addRepeatingEntry<T>(list: T[], empty: () => T): T[] {
  if (list.length >= MAX_REPEATING_ENTRIES) return list;
  return [...list, empty()];
}

export function removeRepeatingEntry<T>(list: T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}
