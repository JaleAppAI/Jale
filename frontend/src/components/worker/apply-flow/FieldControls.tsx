'use client';
import { useId, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { RequirementFieldKey } from '@/lib/job-requirements';
import {
  APPLY_PAY_INTERVALS, EDUCATION_LEVELS, MAX_REPEATING_ENTRIES,
  addRepeatingEntry, emptyReferenceEntry, emptyWorkHistoryEntry,
  isFieldComplete, removeRepeatingEntry,
  type AnswerDraft, type ApplyPayInterval,
} from '@/lib/application-answers-form';

/**
 * Field-level controls for the in-page apply flow's QuestionsStep, COPIED and
 * adapted from `ApplicationAnswersForm.tsx` (the modal `ApplyFlow` replaces --
 * that file stays untouched per the task spec and is deleted in a later
 * Wave-3 task). Same visual language, same `job_requirements` translation
 * namespace, same pure `application-answers-form.ts` completeness/serialize
 * logic underneath -- only the plumbing above these controls changed (a
 * dispatch-driven reducer instead of local `useState`).
 *
 * `UploadButton` is also copied here (rather than left duplicated in
 * `DocumentsCertificationsStep.tsx`) because it is generic file-picker
 * chrome with no field-specific logic -- both the legacy doc rows and the
 * new per-certification rows need the identical control.
 */

// `ariaLabel` names the radiogroup without rendering visible text -- for call
// sites (CertClaimRow) whose question copy is already rendered as their own
// styled element and must not appear twice.
export function YesNo({ value, onChange, label, ariaLabel }: { value: boolean | null; onChange: (value: boolean) => void; label?: string; ariaLabel?: string }) {
  const t = useTranslations('job_requirements');
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-xs font-semibold text-[var(--jale-ink-2)]">{label}</span>}
      <div role="radiogroup" aria-label={ariaLabel ?? label} className="flex gap-1 rounded-full border border-[var(--jale-divider)] p-0.5">
        {[true, false].map((option) => {
          const selected = value === option;
          return (
            <button
              key={String(option)}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option)}
              className={[
                'rounded-full px-3 py-1.5 text-xs font-bold transition-colors',
                selected ? 'bg-[var(--jale-blue-500)] text-white' : 'text-[var(--jale-ink-2)] hover:bg-[var(--jale-paper-2)]',
              ].join(' ')}
            >
              {t(option ? 'apply.yes' : 'apply.no')}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function UploadButton({ disabled, label, onFile }: { disabled?: boolean; label: string; onFile: (file: File) => void }) {
  const inputId = useId();
  return (
    <label
      htmlFor={inputId}
      className={[
        'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-[var(--jale-divider)] px-3 text-xs font-semibold text-[var(--jale-ink)]',
        'hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
        disabled ? 'pointer-events-none opacity-50' : '',
      ].join(' ')}
    >
      <Icon name="upload" />
      {label}
      <input
        id={inputId}
        type="file"
        hidden
        disabled={disabled}
        accept="application/pdf,image/jpeg,image/png"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </label>
  );
}

export function RepeatingGroup<T>({
  entries, empty, onChange, renderEntry, addLabel, fieldId,
}: {
  entries: T[];
  empty: () => T;
  onChange: (next: T[]) => void;
  renderEntry: (entry: T, onEntryChange: (next: T) => void) => ReactNode;
  addLabel: string;
  fieldId: string;
}) {
  const t = useTranslations('job_requirements');
  return (
    <div className="grid gap-3">
      {entries.map((entry, index) => (
        <div key={`${fieldId}-${index}`} className="rounded-[10px] border border-[var(--jale-divider)] p-3">
          {renderEntry(entry, (next) => {
            const copy = [...entries];
            copy[index] = next;
            onChange(copy);
          })}
          <button
            type="button"
            onClick={() => onChange(removeRepeatingEntry(entries, index))}
            className="mt-2 text-xs font-semibold text-[var(--jale-danger)] underline"
          >
            {t('apply.remove')}
          </button>
        </div>
      ))}
      {entries.length < MAX_REPEATING_ENTRIES && (
        <Button variant="outline" size="sm" onClick={() => onChange(addRepeatingEntry(entries, empty))}>
          {addLabel}
        </Button>
      )}
    </div>
  );
}

/** Renders the correct control for one `RequirementFieldKey`, driven purely by `draft`/`update`. */
export function FieldInput({
  fieldKey, draft, update, fieldId,
}: {
  fieldKey: RequirementFieldKey;
  draft: AnswerDraft;
  update: <K extends keyof AnswerDraft>(key: K, value: AnswerDraft[K]) => void;
  fieldId: string;
}) {
  const t = useTranslations('job_requirements');

  switch (fieldKey) {
    case 'work_authorization':
      return (
        <YesNo
          value={draft.work_authorization ?? null}
          onChange={(v) => update('work_authorization', v)}
        />
      );

    case 'date_available':
      return (
        <Input
          type="date"
          value={draft.date_available}
          onChange={(e) => update('date_available', e.target.value)}
        />
      );

    case 'desired_pay':
      return (
        <div className="grid grid-cols-2 gap-2">
          <Input
            type="number" min={0} max={9999}
            value={draft.desired_pay.amount}
            onChange={(e) => update('desired_pay', { ...draft.desired_pay, amount: e.target.value })}
          />
          <Select
            value={draft.desired_pay.interval}
            onChange={(e) => update('desired_pay', { ...draft.desired_pay, interval: e.target.value as ApplyPayInterval })}
          >
            {APPLY_PAY_INTERVALS.map((interval) => (
              <option key={interval} value={interval}>{t(`apply.pay_interval.${interval}`)}</option>
            ))}
          </Select>
        </div>
      );

    case 'date_of_birth':
      return (
        <Input
          type="date"
          value={draft.date_of_birth}
          onChange={(e) => update('date_of_birth', e.target.value)}
        />
      );

    case 'home_address': {
      const a = draft.home_address;
      const set = (patch: Partial<AnswerDraft['home_address']>) => update('home_address', { ...a, ...patch });
      return (
        <div className="grid gap-2">
          <Input placeholder={t('apply.address.street')} value={a.street} onChange={(e) => set({ street: e.target.value })} />
          <Input placeholder={t('apply.address.apartment')} value={a.apartment} onChange={(e) => set({ apartment: e.target.value })} />
          <div className="grid grid-cols-3 gap-2">
            <Input placeholder={t('apply.address.city')} value={a.city} onChange={(e) => set({ city: e.target.value })} />
            <Input placeholder={t('apply.address.state')} maxLength={2} value={a.state} onChange={(e) => set({ state: e.target.value.toUpperCase() })} />
            <Input placeholder={t('apply.address.zip')} value={a.zip} onChange={(e) => set({ zip: e.target.value })} />
          </div>
        </div>
      );
    }

    case 'emergency_contact': {
      const c = draft.emergency_contact;
      return (
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder={t('apply.contact.name')} value={c.name} onChange={(e) => update('emergency_contact', { ...c, name: e.target.value })} />
          <Input placeholder={t('apply.contact.phone')} value={c.phone} onChange={(e) => update('emergency_contact', { ...c, phone: e.target.value })} />
        </div>
      );
    }

    case 'worked_here_before': {
      const w = draft.worked_here_before;
      return (
        <div className="grid gap-2">
          <YesNo value={w.answer} onChange={(v) => update('worked_here_before', { ...w, answer: v })} />
          {w.answer === true && (
            <Input
              placeholder={t('apply.worked_here_before_when')}
              value={w.when}
              onChange={(e) => update('worked_here_before', { ...w, when: e.target.value })}
            />
          )}
        </div>
      );
    }

    case 'education': {
      const ed = draft.education;
      return (
        <div className="grid gap-2">
          <Select value={ed.level} onChange={(e) => update('education', { ...ed, level: e.target.value as typeof ed.level })}>
            <option value="">{t('apply.select_placeholder')}</option>
            {EDUCATION_LEVELS.map((level) => (
              <option key={level} value={level}>{t(`apply.education_level.${level}`)}</option>
            ))}
          </Select>
          {ed.level && ed.level !== 'none' && (
            <YesNo
              label={t('apply.graduated')}
              value={ed.graduated}
              onChange={(v) => update('education', { ...ed, graduated: v })}
            />
          )}
        </div>
      );
    }

    case 'references':
      return (
        <RepeatingGroup
          entries={draft.references}
          empty={emptyReferenceEntry}
          onChange={(next) => update('references', next)}
          renderEntry={(entry, onEntryChange) => (
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder={t('apply.reference.name')} value={entry.name} onChange={(e) => onEntryChange({ ...entry, name: e.target.value })} />
              <Input placeholder={t('apply.reference.relationship')} value={entry.relationship} onChange={(e) => onEntryChange({ ...entry, relationship: e.target.value })} />
              <Input placeholder={t('apply.reference.company')} value={entry.company} onChange={(e) => onEntryChange({ ...entry, company: e.target.value })} />
              <Input placeholder={t('apply.reference.phone')} value={entry.phone} onChange={(e) => onEntryChange({ ...entry, phone: e.target.value })} />
            </div>
          )}
          addLabel={t('apply.add_reference')}
          fieldId={`${fieldId}-refs`}
        />
      );

    case 'work_history':
      return (
        <RepeatingGroup
          entries={draft.work_history}
          empty={emptyWorkHistoryEntry}
          onChange={(next) => update('work_history', next)}
          renderEntry={(entry, onEntryChange) => (
            <div className="grid gap-2">
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder={t('apply.work_history.company')} value={entry.company} onChange={(e) => onEntryChange({ ...entry, company: e.target.value })} />
                <Input placeholder={t('apply.work_history.title')} value={entry.title} onChange={(e) => onEntryChange({ ...entry, title: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder={t('apply.work_history.from')} value={entry.from} onChange={(e) => onEntryChange({ ...entry, from: e.target.value })} />
                <Input placeholder={t('apply.work_history.to')} value={entry.to} onChange={(e) => onEntryChange({ ...entry, to: e.target.value })} />
              </div>
              <Input placeholder={t('apply.work_history.responsibilities')} value={entry.responsibilities} onChange={(e) => onEntryChange({ ...entry, responsibilities: e.target.value })} />
              <Input placeholder={t('apply.work_history.reason_for_leaving')} value={entry.reason_for_leaving} onChange={(e) => onEntryChange({ ...entry, reason_for_leaving: e.target.value })} />
            </div>
          )}
          addLabel={t('apply.add_work_history')}
          fieldId={`${fieldId}-work-history`}
        />
      );

    case 'military_service': {
      const m = draft.military_service;
      const set = (patch: Partial<AnswerDraft['military_service']>) => update('military_service', { ...m, ...patch });
      return (
        <div className="grid gap-2">
          <YesNo value={m.served} onChange={(v) => set({ served: v })} />
          {m.served === true && (
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder={t('apply.military.branch')} value={m.branch} onChange={(e) => set({ branch: e.target.value })} />
              <Input placeholder={t('apply.military.rank_at_discharge')} value={m.rank_at_discharge} onChange={(e) => set({ rank_at_discharge: e.target.value })} />
              <Input placeholder={t('apply.military.from')} value={m.from} onChange={(e) => set({ from: e.target.value })} />
              <Input placeholder={t('apply.military.to')} value={m.to} onChange={(e) => set({ to: e.target.value })} />
              <Input placeholder={t('apply.military.discharge_type')} value={m.discharge_type} onChange={(e) => set({ discharge_type: e.target.value })} />
            </div>
          )}
        </div>
      );
    }

    default:
      return null;
  }
}

/** One question row: label + optional Skip toggle + its `FieldInput` + a missing-answer note. */
export function QuestionFieldRow({
  fieldKey, required, skipped, onSkip, draft, update, fieldId, missing, prefilled,
}: {
  fieldKey: RequirementFieldKey;
  required: boolean;
  skipped: boolean;
  onSkip: () => void;
  draft: AnswerDraft;
  update: <K extends keyof AnswerDraft>(key: K, value: AnswerDraft[K]) => void;
  fieldId: string;
  missing: boolean;
  /** True when this field's current value came from `apply_defaults` (WK-T3 addition, not in the original `FieldRow`) -- renders the `prefilled_hint` note next to the label. */
  prefilled: boolean;
}) {
  const t = useTranslations('job_requirements');
  const tFlow = useTranslations('worker_job_detail.apply_flow');
  const complete = isFieldComplete(fieldKey, draft);

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-sm font-bold text-[var(--jale-ink)]">
          {t(`fields.${fieldKey}`)}
          {required ? ' *' : null}
        </label>
        {!required && (
          <button
            type="button"
            aria-pressed={skipped}
            onClick={onSkip}
            className="text-xs font-semibold text-[var(--jale-ink-2)] underline underline-offset-2"
          >
            {skipped ? t('apply.skipped') : t('apply.skip')}
          </button>
        )}
      </div>

      {prefilled && !skipped && (
        <p className="text-xs text-[var(--jale-ink-2)]">{tFlow('prefilled_hint')}</p>
      )}

      {!skipped && <FieldInput fieldKey={fieldKey} draft={draft} update={update} fieldId={fieldId} />}

      {missing && !complete && (
        <p className="text-xs font-semibold text-[var(--jale-danger)]">{t('apply.not_answered')}</p>
      )}
    </div>
  );
}
