'use client';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import {
  REQUIREMENT_DOC_KEYS,
  FIELD_GROUPS,
  SENSITIVE_FIELD_KEYS,
  countRequirements,
  certificationHintNames,
  setRequirementState,
  type RequirementKey,
  type RequirementsMap,
  type RequirementState,
} from '@/lib/job-requirements';

const STATES: readonly RequirementState[] = ['off', 'optional', 'required'];

/**
 * "What applicants must provide" -- Design A, grouped checklist, three-state.
 *
 * Shared by PostJobModal's step 3 and JobFormFields (EditJobModal +
 * TemplateEditModal). Renders TWO fieldsets -- Documents (4 rows) and
 * Questions (11 rows, sub-grouped) -- each row a labelled radiogroup of
 * Off/Optional/Required segments, so the state is announced and keyboard
 * navigable per row (arrow keys within a row's three options, Tab between
 * rows) without inventing a bespoke widget.
 *
 * `locked` freezes every control (jobs with applicants -- the same freeze
 * `JobFormFields` already applies to job_type/required docs) and shows the
 * existing locked note above the picker instead of duplicating it per row.
 */
interface RequirementsPickerProps {
  requirements: RequirementsMap;
  onChange: (next: RequirementsMap) => void;
  /** Step 2's free-text certifications, for the certification_doc row's hint. */
  certifications?: string;
  locked?: boolean;
}

export function RequirementsPicker({
  requirements, onChange, certifications = '', locked = false,
}: RequirementsPickerProps) {
  const t = useTranslations('job_requirements');

  const setState = (key: RequirementKey, state: RequirementState) => {
    if (locked) return;
    onChange(setRequirementState(requirements, key, state));
  };

  const { required, optional } = countRequirements(requirements);
  const certNames = certificationHintNames(certifications);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--jale-ink-2)]">{t('picker.rule_line')}</p>
        <Badge tone="info">{t('picker.count_badge', { required, optional })}</Badge>
      </div>

      {locked && (
        <p className="text-xs font-semibold text-[var(--jale-ink-2)]">{t('picker.locked_note')}</p>
      )}

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
          {t('groups.documents')}
        </legend>
        <ul className="divide-y divide-[var(--jale-divider)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--jale-divider)]">
          {REQUIREMENT_DOC_KEYS.map((key) => (
            <li key={key}>
              <RequirementRow
                rowKey={key}
                label={t(`docs.${key}`)}
                state={requirements[key]}
                onChange={(state) => setState(key, state)}
                disabled={locked}
                hint={
                  key === 'certification_doc' && requirements[key] !== 'off' && certNames.length > 0
                    ? t('picker.cert_hint', { names: certNames.join(', ') })
                    : undefined
                }
              />
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-1 text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
          {t('groups.questions')}
        </legend>
        {(Object.keys(FIELD_GROUPS) as Array<keyof typeof FIELD_GROUPS>).map((group) => (
          <div key={group} className="grid gap-2">
            <p className="text-xs font-semibold text-[var(--jale-ink-2)]">{t(`groups.${group}`)}</p>
            <ul className="divide-y divide-[var(--jale-divider)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--jale-divider)]">
              {FIELD_GROUPS[group].map((key) => (
                <li key={key}>
                  <RequirementRow
                    rowKey={key}
                    label={t(`fields.${key}`)}
                    state={requirements[key]}
                    onChange={(state) => setState(key, state)}
                    disabled={locked}
                    sensitive={(SENSITIVE_FIELD_KEYS as readonly string[]).includes(key)}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </fieldset>
    </div>
  );
}

function RequirementRow({
  rowKey, label, state, onChange, disabled, sensitive, hint,
}: {
  rowKey: string;
  label: string;
  state: RequirementState;
  onChange: (state: RequirementState) => void;
  disabled?: boolean;
  sensitive?: boolean;
  hint?: string;
}) {
  const t = useTranslations('job_requirements');
  const groupName = `requirement-${rowKey}`;

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-sm font-semibold text-[var(--jale-ink)]">
          {label}
          {sensitive && (
            <span
              className="ml-2 inline-flex items-center gap-1 rounded-full bg-[var(--jale-paper-2)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--jale-ink-2)]"
              title={t('picker.sensitive')}
            >
              {t('picker.sensitive')}
            </span>
          )}
        </span>
        <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-full border border-[var(--jale-divider)] p-0.5">
          {STATES.map((option) => {
            const selected = state === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selected}
                name={groupName}
                disabled={disabled}
                onClick={() => onChange(option)}
                className={[
                  'rounded-full px-3 py-1.5 text-xs font-bold transition-colors',
                  'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                  selected
                    ? 'bg-[var(--jale-blue-500)] text-white'
                    : 'text-[var(--jale-ink-2)] hover:bg-[var(--jale-paper-2)]',
                ].join(' ')}
              >
                {t(`states.${option}`)}
              </button>
            );
          })}
        </div>
      </div>
      {hint && <p className="text-xs text-[var(--jale-ink-2)]">{hint}</p>}
    </div>
  );
}
