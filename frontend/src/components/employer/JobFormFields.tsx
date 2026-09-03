'use client';
import type React from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  LANGUAGE_OPTIONS,
  type JobForm, type JobFormLocation, type WorkDay,
} from '@/lib/job-form';
import { CertificationsPicker } from '@/components/employer/CertificationsPicker';
import { DescriptionHelper } from '@/components/employer/DescriptionHelper';
import { DurationField } from '@/components/employer/DurationField';
import { ExperienceStepper } from '@/components/employer/ExperienceStepper';
import { Input } from '@/components/ui/input';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { PayFields } from '@/components/employer/PayFields';
import { PayReferenceHint } from '@/components/PayReferenceHint';
import { PreApplicationPromptsEditor } from '@/components/employer/PreApplicationPromptsEditor';
import { RequirementsPicker } from '@/components/employer/RequirementsPicker';
import { ScheduleFields } from '@/components/employer/ScheduleFields';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { TradeCategoryField } from '@/components/employer/TradeCategoryField';

/**
 * The job form's field set, shared by EditJobModal and TemplateEditModal so
 * the two cannot drift apart on a field, a label key or a chip style. Renders
 * ONLY the fields -- the callers own the modal chrome, validation and submit.
 *
 * There is deliberately no state_region input: it derives from the picked
 * city's USPS state (see applyLocationToJobForm), and free-typed locations
 * leave it blank for the backend to parse from the location text.
 */
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
  /** Lets the caller's Modal land initial focus on the title input. */
  titleRef?: React.RefObject<HTMLInputElement>;
}

export function JobFormFields({
  form, onUpdate, onLocationChange,
  showStartDate = true, locked = false, minWorkers = 1, titleRef,
}: JobFormFieldsProps) {
  const t = useTranslations('employer_dashboard');

  // Freezes the description Textarea while `DescriptionHelper`'s Generate
  // call is in flight -- otherwise a manual edit made mid-flight would be
  // silently overwritten seconds later by the eventual success response.
  const [descriptionGenerating, setDescriptionGenerating] = useState(false);

  const toggleLanguage = (value: 'any' | 'en' | 'es') => {
    if (value === 'any') {
      onUpdate('language_preference', ['any']);
      return;
    }
    const withoutAny = form.language_preference.filter((i) => i !== 'any');
    const next = withoutAny.includes(value) ? withoutAny.filter((i) => i !== value) : [...withoutAny, value];
    onUpdate('language_preference', next.length > 0 ? next : ['any']);
  };

  const languageChipClass = (selected: boolean) =>
    [
      'cursor-pointer rounded-full border px-3 py-2 text-xs font-semibold transition-colors duration-150',
      'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
      selected
        ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
        : 'border-[var(--jale-divider)] bg-[var(--jale-input)] text-[var(--jale-ink)]',
    ].join(' ');

  const toggleWorkDay = (day: WorkDay) => {
    onUpdate(
      'work_days',
      form.work_days.includes(day)
        ? form.work_days.filter((d) => d !== day)
        : [...form.work_days, day],
    );
  };

  const setCertificationTier = (name: string, tier: 'required' | 'optional') => {
    onUpdate(
      'certification_requirements',
      form.certification_requirements.map((cert) => (cert.name === name ? { ...cert, tier } : cert)),
    );
  };

  const toggleCertificationProof = (name: string) => {
    onUpdate(
      'certification_requirements',
      form.certification_requirements.map((cert) =>
        cert.name === name ? { ...cert, proof_required: !cert.proof_required } : cert),
    );
  };

  return (
    <>
      <Field label={t('modal.job_title')} required>
        <Input
          ref={titleRef}
          value={form.title}
          onChange={(e) => onUpdate('title', e.target.value)}
        />
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
      <TradeCategoryField
        tradeCategory={form.trade_category}
        tradeCategoryOther={form.trade_category_other}
        onTradeCategoryChange={(value) => onUpdate('trade_category', value)}
        onTradeCategoryOtherChange={(value) => onUpdate('trade_category_other', value)}
      />
      <Field label={t('modal.job_description')}>
        <Textarea
          rows={4}
          value={form.description}
          onChange={(e) => onUpdate('description', e.target.value)}
          // Same Other-trade placeholder swap as PostJobModal's step 1, for
          // the same reason (locked decision: "Generate-with-AI enables for
          // Other once custom trade typed") -- see that component's comment.
          placeholder={
            form.trade_category === 'other' && form.trade_category_other.trim()
              ? t('modal.description_placeholder_notes')
              : t('modal.description_placeholder')
          }
          disabled={descriptionGenerating}
        />
        <DescriptionHelper
          form={form}
          onDescriptionChange={(value) => onUpdate('description', value)}
          onGeneratingChange={setDescriptionGenerating}
        />
      </Field>
      <PayFields
        payMin={form.pay_min}
        payMax={form.pay_max}
        payInterval={form.pay_interval}
        onPayMinChange={(value) => onUpdate('pay_min', value)}
        onPayMaxChange={(value) => onUpdate('pay_max', value)}
        onPayIntervalChange={(value) => onUpdate('pay_interval', value)}
      />
      <PayReferenceHint trade={form.trade_category} cityKey={form.city_key} variant="employer" />
      <div className="grid gap-3 md:grid-cols-2">
        {showStartDate && (
          <Field label={t('modal.start_date')}><Input type="date" className="tabular-nums" value={form.start_date} onChange={(e) => onUpdate('start_date', e.target.value)} /></Field>
        )}
        <Field label={t('modal.number_of_workers_needed')} required>
          <Input type="number" min={minWorkers} className="tabular-nums" value={form.number_of_workers_needed} onChange={(e) => onUpdate('number_of_workers_needed', e.target.value)} />
        </Field>
      </div>
      <DurationField
        value={form.expected_duration_bucket}
        legacyExpectedDuration={form.expected_duration}
        onChange={(value) => onUpdate('expected_duration_bucket', value)}
      />
      <ScheduleFields
        workDays={form.work_days}
        shiftStart={form.shift_start}
        shiftEnd={form.shift_end}
        legacyShiftSchedule={form.shift_schedule}
        onToggleDay={toggleWorkDay}
        onShiftStartChange={(value) => onUpdate('shift_start', value)}
        onShiftEndChange={(value) => onUpdate('shift_end', value)}
      />
      <ExperienceStepper
        value={form.required_experience_years}
        onChange={(value) => onUpdate('required_experience_years', value)}
      />
      <Field label={t('modal.language_preference')}>
        <div className="flex flex-wrap gap-2">
          {LANGUAGE_OPTIONS.map((lang) => (
            <button
              key={lang}
              type="button"
              aria-pressed={form.language_preference.includes(lang)}
              onClick={() => toggleLanguage(lang)}
              className={languageChipClass(form.language_preference.includes(lang))}
            >
              {t(`modal.language.${lang}`)}
            </button>
          ))}
        </div>
      </Field>
      <label className="flex items-center gap-2 text-sm font-medium text-[var(--jale-ink)]">
        <input type="checkbox" checked={form.transportation_required} onChange={(e) => onUpdate('transportation_required', e.target.checked)} />
        {t('modal.transportation_required')}
      </label>
      <CertificationsPicker
        certificationRequirements={form.certification_requirements}
        legacyCertifications={form.certifications}
        // The post-applicants freeze covers WHAT the job requires, not just
        // each requirement's tier: adding/removing a named certification is a
        // strictly larger change than the tier/proof tweaks RequirementsPicker
        // already locks below, and the pre-redesign certification_doc gate
        // lived inside the locked required/optional_docs arrays. The backend
        // enforces the same rule (employer-jobs-update.ts's applicant-count
        // lock).
        disabled={locked}
        // See PostJobModal's identical wiring for why `certifications` is
        // cleared on every picker edit, not just non-empty ones:
        // `jobFormToBasePayload` falls back to the legacy free-text field
        // whenever `certification_requirements` is empty, so deleting every
        // chip here must not let a legacy job's old cert names come back on
        // save.
        onChange={(next) => {
          onUpdate('certification_requirements', next);
          onUpdate('certifications', '');
        }}
      />

      {/* ABOVE the picker, mirroring PostJobModal's step 3: the prompts are
          the only thing an applicant meets while applying, and everything the
          picker configures below waits for "Request details". `locked` is the
          same post-applicants freeze -- the backend refuses a changed prompt
          list with 409 `field_locked`, so the control has to refuse first. */}
      <PreApplicationPromptsEditor
        prompts={form.pre_application_prompts}
        onChange={(next) => onUpdate('pre_application_prompts', next)}
        locked={locked}
      />

      {/* Work authorization is no longer a standalone checkbox here -- the
          requirements picker's `work_authorization` row is its one input
          (see `jobFormToBasePayload`, which derives the legacy boolean from
          it). Doc requirements live in the same picker instead of a separate
          two-item chip list, now that there are four doc types. */}
      <RequirementsPicker
        requirements={form.requirements}
        onChange={(next) => onUpdate('requirements', next)}
        certifications={form.certifications}
        certificationRequirements={form.certification_requirements}
        onCertificationTierChange={setCertificationTier}
        onCertificationProofToggle={toggleCertificationProof}
        locked={locked}
      />
    </>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">{label}{required ? ' *' : ''}</label>
      {children}
    </div>
  );
}
