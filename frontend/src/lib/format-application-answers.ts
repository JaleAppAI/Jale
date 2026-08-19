// Compact, localized rendering of `job_applications.application_answers` for
// the employer applicants view. Pure formatting only -- this never validates
// (that is the backend's `validateApplicationAnswers`'s job); a shape it does
// not recognize renders as best-effort JSON rather than crashing the row.
import { REQUIREMENT_FIELD_KEYS, type RequirementFieldKey } from '@/lib/job-requirements';

/**
 * A translator into the `job_requirements` namespace (`useTranslations('job_requirements')`).
 * Matches next-intl's own `TranslationValues` shape (string/number/Date) so a
 * real `useTranslations()` result satisfies this structurally, with no cast.
 */
export type RequirementsTranslator = (key: string, values?: Record<string, string | number | Date>) => string;

/** Ordered [key, formatted value] pairs, in the picker's stable field order. */
export function answerEntries(
  answers: Record<string, unknown> | undefined | null,
  t: RequirementsTranslator,
): Array<{ key: RequirementFieldKey; value: string }> {
  if (!answers) return [];
  return REQUIREMENT_FIELD_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(answers, key))
    .map((key) => ({ key, value: formatAnswerValue(key, answers[key], t) }));
}

function yesNo(value: unknown, t: RequirementsTranslator): string {
  return t(value === true ? 'apply.yes' : 'apply.no');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatAnswerValue(key: RequirementFieldKey, value: unknown, t: RequirementsTranslator): string {
  switch (key) {
    case 'work_authorization':
      return yesNo(value, t);

    case 'date_available':
      return typeof value === 'string' ? value : '';

    case 'date_of_birth':
      return typeof value === 'string' ? value : '';

    case 'desired_pay': {
      if (!isRecord(value)) return '';
      const amount = value.amount;
      const interval = typeof value.interval === 'string' ? t(`apply.pay_interval.${value.interval}`) : '';
      return typeof amount === 'number' ? `$${amount} ${interval}`.trim() : '';
    }

    case 'home_address': {
      if (!isRecord(value)) return '';
      const parts = [
        [value.street, value.apartment].filter((p) => typeof p === 'string' && p).join(' '),
        value.city,
        [value.state, value.zip].filter((p) => typeof p === 'string' && p).join(' '),
      ].filter((p) => typeof p === 'string' && p.trim().length > 0);
      return parts.join(', ');
    }

    case 'emergency_contact': {
      if (!isRecord(value)) return '';
      const name = typeof value.name === 'string' ? value.name : '';
      const phone = typeof value.phone === 'string' ? value.phone : '';
      return phone ? `${name} (${phone})` : name;
    }

    case 'worked_here_before': {
      if (!isRecord(value)) return '';
      const base = yesNo(value.answer, t);
      const when = typeof value.when === 'string' && value.when ? ` — ${value.when}` : '';
      return `${base}${when}`;
    }

    case 'education': {
      if (!isRecord(value)) return '';
      const level = typeof value.level === 'string' ? t(`apply.education_level.${value.level}`) : '';
      if (value.graduated === undefined) return level;
      return `${level} (${yesNo(value.graduated, t)})`;
    }

    case 'references':
      return Array.isArray(value)
        ? t('employer.references_count', { count: value.length })
        : '';

    case 'work_history':
      return Array.isArray(value)
        ? t('employer.work_history_count', { count: value.length })
        : '';

    case 'military_service': {
      if (!isRecord(value)) return '';
      const base = yesNo(value.served, t);
      const branch = typeof value.branch === 'string' && value.branch ? ` — ${value.branch}` : '';
      return `${base}${branch}`;
    }

    default:
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}
