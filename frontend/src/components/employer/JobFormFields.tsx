'use client';
import type React from 'react';
import { useTranslations } from 'next-intl';
import {
  DOC_TYPES, LANGUAGE_OPTIONS, TRADE_CATEGORIES, PAY_INTERVALS,
  type DocType, type PayInterval, type JobForm, type JobFormLocation,
} from '@/lib/job-form';
import { Input } from '@/components/ui/input';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

interface JobFormFieldsProps {
  form: JobForm;
  onUpdate: <K extends keyof JobForm>(key: K, value: JobForm[K]) => void;
  onLocationChange: (v: JobFormLocation) => void;
  /** Templates never carry a date; the template editor hides the field. */
  showStartDate?: boolean;
  /** Jobs with applicants freeze job_type + required docs (edit modal). */
  locked?: boolean;
  /** Floor for the headcount input (edit modal passes hired_count). */
  minWorkers?: number;
}

export function JobFormFields({
  form, onUpdate, onLocationChange,
  showStartDate = true, locked = false, minWorkers = 1,
}: JobFormFieldsProps) {
  const t = useTranslations('employer_dashboard');

  const toggleDoc = (doc: DocType) => {
    if (locked) return;
    onUpdate('required_docs', { ...form.required_docs, [doc]: !form.required_docs[doc] });
  };
  const toggleLanguage = (value: 'any' | 'en' | 'es') => {
    if (value === 'any') {
      onUpdate('language_preference', ['any']);
      return;
    }
    const withoutAny = form.language_preference.filter((i) => i !== 'any');
    const next = withoutAny.includes(value) ? withoutAny.filter((i) => i !== value) : [...withoutAny, value];
    onUpdate('language_preference', next.length > 0 ? next : ['any']);
  };

  const docLabel: Record<DocType, string> = {
    resume: t('worker_profile.doc_resume'),
    driver_license: t('worker_profile.doc_driver_license'),
  };

  return (
    <>
      <Field label={t('modal.job_title')} required>
        <Input value={form.title} onChange={(e) => onUpdate('title', e.target.value)} />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('modal.location')} required>
          <LocationPicker
            value={form.location}
            onChange={onLocationChange}
          />
        </Field>
        <Field label={t('modal.job_type')}>
          <Select value={form.job_type} onChange={(e) => onUpdate('job_type', e.target.value as JobForm['job_type'])} disabled={locked}>
            <option value="full-time">{t('modal.job_type_fulltime')}</option>
            <option value="part-time">{t('modal.job_type_parttime')}</option>
            <option value="contract">{t('modal.job_type_contract')}</option>
          </Select>
        </Field>
      </div>
      <Field label={t('modal.trade_category')} required>
        <Select value={form.trade_category} onChange={(e) => onUpdate('trade_category', e.target.value as JobForm['trade_category'])}>
          <option value="">{t('modal.select_placeholder')}</option>
          {TRADE_CATEGORIES.map((trade) => (<option key={trade} value={trade}>{t(`modal.trade.${trade}`)}</option>))}
        </Select>
      </Field>
      <Field label={t('modal.job_description')}>
        <Textarea rows={4} value={form.description} onChange={(e) => onUpdate('description', e.target.value)} />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('modal.pay_min')}><Input type="number" min={0} value={form.pay_min} onChange={(e) => onUpdate('pay_min', e.target.value)} /></Field>
        <Field label={t('modal.pay_max')}><Input type="number" min={0} value={form.pay_max} onChange={(e) => onUpdate('pay_max', e.target.value)} /></Field>
      </div>
      <Field label={t('modal.pay_interval')}>
        <Select value={form.pay_interval} onChange={(e) => onUpdate('pay_interval', e.target.value as PayInterval)}>
          {PAY_INTERVALS.map((interval) => (<option key={interval} value={interval}>{t(`modal.pay_interval_option.${interval}`)}</option>))}
        </Select>
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        {showStartDate && (
          <Field label={t('modal.start_date')}><Input type="date" value={form.start_date} onChange={(e) => onUpdate('start_date', e.target.value)} /></Field>
        )}
        <Field label={t('modal.expected_duration')}><Input value={form.expected_duration} onChange={(e) => onUpdate('expected_duration', e.target.value)} /></Field>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('modal.shift_schedule')}><Input value={form.shift_schedule} onChange={(e) => onUpdate('shift_schedule', e.target.value)} /></Field>
        <Field label={t('modal.number_of_workers_needed')} required>
          <Input type="number" min={minWorkers} value={form.number_of_workers_needed} onChange={(e) => onUpdate('number_of_workers_needed', e.target.value)} />
        </Field>
      </div>
      <Field label={t('modal.required_experience_years')}>
        <Input type="number" min={0} value={form.required_experience_years} onChange={(e) => onUpdate('required_experience_years', e.target.value)} />
      </Field>
      <Field label={t('modal.language_preference')}>
        <div className="flex flex-wrap gap-2">
          {LANGUAGE_OPTIONS.map((lang) => (
            <button key={lang} type="button" onClick={() => toggleLanguage(lang)} className="rounded-full border px-3 py-2 text-xs font-semibold" style={{
              borderColor: form.language_preference.includes(lang) ? 'var(--jale-blue-500)' : 'var(--jale-divider)',
              background: form.language_preference.includes(lang) ? 'var(--jale-blue-50)' : 'white',
              color: form.language_preference.includes(lang) ? 'var(--jale-blue-700)' : 'var(--jale-ink)',
            }}>{t(`modal.language.${lang}`)}</button>
          ))}
        </div>
      </Field>
      <label className="flex items-center gap-2 text-sm font-medium text-[var(--jale-ink)]">
        <input type="checkbox" checked={form.transportation_required} onChange={(e) => onUpdate('transportation_required', e.target.checked)} />
        {t('modal.transportation_required')}
      </label>
      <label className="flex items-center gap-2 text-sm font-medium text-[var(--jale-ink)]">
        <input type="checkbox" checked={form.work_authorization_required} onChange={(e) => onUpdate('work_authorization_required', e.target.checked)} />
        {t('modal.work_authorization_required')}
      </label>
      <Field label={t('modal.certifications')}>
        <Input value={form.certifications} onChange={(e) => onUpdate('certifications', e.target.value)} />
      </Field>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">{t('post_job_docs.subtitle')}</p>
        {locked && <p className="mb-2 text-xs font-semibold text-[var(--jale-ink-2)]">{t('modal.locked_note')}</p>}
        <div className="flex flex-col gap-2.5">
          {DOC_TYPES.map((doc) => (
            <button key={doc} type="button" onClick={() => toggleDoc(doc)} disabled={locked}
              className="flex items-center justify-between rounded-[10px] border px-4 py-3 text-left transition-all disabled:opacity-60"
              style={{ background: form.required_docs[doc] ? 'var(--jale-blue-50)' : 'var(--jale-paper-2)', borderColor: form.required_docs[doc] ? 'var(--jale-blue-500)' : 'var(--jale-divider)' }}>
              <span className="text-sm font-medium text-[var(--jale-ink)]">{docLabel[doc]}</span>
              <span className="text-xs font-semibold text-[var(--jale-blue-700)]">{form.required_docs[doc] ? t('post_job_docs.required_label') : t('post_job_docs.optional_label')}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">{label}{required ? ' *' : ''}</label>
      {children}
    </div>
  );
}
