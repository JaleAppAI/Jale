'use client';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { validateWorkerProfileFields, type WorkerProfileField } from '@/lib/worker-profile-form';
import { useErrorMessage } from '@/hooks/useErrorMessage';

const AVAILABILITY = ['full_time', 'part_time', 'weekends', 'flexible'] as const;
type Availability = (typeof AVAILABILITY)[number];

const FIELD_LABEL_KEY: Record<WorkerProfileField, string> = {
  full_name: 'full_name',
  skills: 'skills_placeholder',
  availability: 'availability_label',
  location: 'location',
};

export interface ProfileCompleteValues {
  full_name: string;
  skills: string[];  // comma-separated in UI, split here
  availability: Availability;
  location: string;
  /** Absent when the box was left empty: the stored value (if any) stays. */
  years_experience?: number;
}

function isAvailability(value: unknown): value is Availability {
  return typeof value === 'string' && (AVAILABILITY as readonly string[]).includes(value);
}

/**
 * Labelled form row.
 *
 * The fields used to be placeholder-only, which vanishes the moment the worker
 * types and leaves a screen reader with nothing to announce. The label strings
 * already existed in the namespace, so this costs no new copy.
 */
function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs font-medium text-[var(--jale-danger-text)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The pre-apply completion gate.
 *
 * Shown when a worker taps Apply with an incomplete profile: they fill in the
 * missing pieces here and the application continues automatically once the save
 * lands (the page's `onSubmit` closes this and resumes the apply).
 *
 * Two failure modes, deliberately owned by different surfaces:
 *  - the profile SAVE failing is this dialog's problem, so `onSubmit` rejecting
 *    renders inline below — the page's own feedback would sit behind the
 *    backdrop where nobody can read it;
 *  - the APPLY failing afterwards belongs to the page, which anchors the apply
 *    taxonomy's message to the apply button.
 */
export function ProfileCompleteModal(props: {
  open: boolean;
  initial?: Partial<ProfileCompleteValues>;
  onClose: () => void;
  onSubmit: (values: ProfileCompleteValues) => Promise<void>;
}) {
  const t = useTranslations('worker_profile.complete_modal');
  const tFields = useTranslations('worker_profile');
  const tCommon = useTranslations('common');
  const errorMessage = useErrorMessage();
  const fieldId = useId();
  const [fullName, setFullName] = useState('');
  const [skills, setSkills] = useState('');
  // Empty until the profile says otherwise: never a choice the worker did not
  // make (Full-time used to be preselected, and "Save and apply" saved it).
  const [availability, setAvailability] = useState<Availability | ''>('');
  const [location, setLocation] = useState('');
  const [yearsExp, setYearsExp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingFields, setMissingFields] = useState<WorkerProfileField[]>([]);

  // Prefill from the worker's existing profile each time the modal opens,
  // so they only fill in what's actually missing (e.g. WhatsApp-onboarded
  // workers already have name/availability/location).
  const { open, initial, onClose, onSubmit } = props;
  // A stored availability is shown as it is; only an unset one offers the
  // empty "choose" option, which must then be replaced before saving.
  const availabilityStored = isAvailability(initial?.availability);
  // A stored number of years cannot be cleared (the server keeps a value it is
  // not sent); an emptied box asks for a number instead (0 if none).
  const yearsStored = typeof initial?.years_experience === 'number';
  const [yearsMissing, setYearsMissing] = useState(false);
  useEffect(() => {
    if (!open || !initial) return;
    setFullName(initial.full_name ?? '');
    setSkills((initial.skills ?? []).join(', '));
    if (isAvailability(initial.availability)) {
      setAvailability(initial.availability);
    }
    setLocation(initial.location ?? '');
    if (typeof initial.years_experience === 'number') {
      setYearsExp(String(initial.years_experience));
    }
  }, [open, initial]);

  // Clear the last attempt's complaints when the gate closes, so reopening it
  // never greets the worker with an error about a submit they already left.
  useEffect(() => {
    if (open) return;
    setError(null);
    setMissingFields([]);
  }, [open]);

  // One guard for every dismissal route the foundation Modal offers (Escape,
  // backdrop, the header close button): a save is in flight and cancelling it
  // client-side would leave the worker unsure whether it landed.
  const handleClose = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  async function submit() {
    setError(null);
    const values = {
      full_name: fullName.trim(),
      skills: skills.split(',').map(s => s.trim()).filter(Boolean),
      availability,
      location: location.trim(),
    };
    const missing = validateWorkerProfileFields(values);
    setMissingFields(missing);
    const clearedYears = yearsStored && yearsExp.trim() === '';
    setYearsMissing(clearedYears);
    if (missing.length === 0 && clearedYears) {
      setError(tFields('edit.years_required'));
      return;
    }
    if (missing.length > 0) {
      setError(tFields('errors.missing_summary', {
        fields: missing.map((field) => t(FIELD_LABEL_KEY[field])).join(', '),
      }));
      return;
    }
    const years = yearsExp.trim();
    setSubmitting(true);
    try {
      await onSubmit({
        ...values,
        availability: availability as Availability,
        // Clamp to [0, 80] to mirror the backend cap (max= on the input is not a
        // complete guard when submit goes through a custom handler). An empty
        // box sends nothing, so a stored value is kept rather than zeroed.
        ...(years === ''
          ? {}
          : { years_experience: Math.min(Math.max(Number(years) || 0, 0), 80) }),
      });
    } catch (e) {
      // Never `err.message`: that is a backend error CODE, untranslated and
      // sometimes server detail. `useErrorMessage` turns anything thrown into a
      // reviewed sentence in both locales.
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  const nameId = `${fieldId}-full-name`;
  const skillsId = `${fieldId}-skills`;
  const availabilityId = `${fieldId}-availability`;
  const locationId = `${fieldId}-location`;
  const yearsId = `${fieldId}-years`;

  const requiredError = tFields('errors.required');

  return (
    // `data-guide="apply.gate*"`: the hooks the applying guide
    // (`components/tutorials/guides/worker-apply.ts`) points at, from the gate
    // through "Save and apply" to the apply screen it opens.
    <Modal
      open={open}
      onClose={handleClose}
      title={t('title')}
      size="sm"
      data-guide="apply.gate"
      footer={
        <>
          <Button variant="outline" onClick={handleClose} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} loading={submitting} loadingLabel={tCommon('loading')} data-guide="apply.gate.save">
            {t('submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-[var(--jale-ink-2)]">{t('subtitle')}</p>

        <Field
          id={nameId}
          label={t('full_name')}
          error={missingFields.includes('full_name') ? requiredError : null}
        >
          <Input
            id={nameId}
            data-guide="apply.gate.name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            aria-invalid={missingFields.includes('full_name') || undefined}
            aria-describedby={missingFields.includes('full_name') ? `${nameId}-error` : undefined}
          />
        </Field>

        <Field
          id={skillsId}
          label={t('skills_placeholder')}
          error={missingFields.includes('skills') ? requiredError : null}
        >
          <Input
            id={skillsId}
            data-guide="apply.gate.skills"
            value={skills}
            onChange={(e) => setSkills(e.target.value)}
            aria-invalid={missingFields.includes('skills') || undefined}
            aria-describedby={missingFields.includes('skills') ? `${skillsId}-error` : undefined}
          />
        </Field>

        <Field
          id={availabilityId}
          label={t('availability_label')}
          error={missingFields.includes('availability') ? requiredError : null}
        >
          <Select
            id={availabilityId}
            data-guide="apply.gate.availability"
            value={availability}
            onChange={(e) => setAvailability(isAvailability(e.target.value) ? e.target.value : '')}
            aria-invalid={missingFields.includes('availability') || undefined}
            aria-describedby={missingFields.includes('availability') ? `${availabilityId}-error` : undefined}
          >
            {availabilityStored ? null : (
              <option value="" disabled>{tFields('edit.availability_choose')}</option>
            )}
            {AVAILABILITY.map((a) => (
              <option key={a} value={a}>{t(`availability.${a}`)}</option>
            ))}
          </Select>
        </Field>

        <Field
          id={locationId}
          label={t('location')}
          error={missingFields.includes('location') ? requiredError : null}
        >
          <Input
            id={locationId}
            data-guide="apply.gate.location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            aria-invalid={missingFields.includes('location') || undefined}
            aria-describedby={missingFields.includes('location') ? `${locationId}-error` : undefined}
          />
        </Field>

        <Field
          id={yearsId}
          label={t('years_experience')}
          error={yearsMissing ? tFields('edit.years_required') : null}
        >
          <Input
            id={yearsId}
            data-guide="apply.gate.years"
            data-stored={yearsStored ? '' : undefined}
            aria-invalid={yearsMissing || undefined}
            aria-describedby={yearsMissing ? `${yearsId}-error` : undefined}
            type="number"
            inputMode="numeric"
            min={0}
            max={80}
            className="tabular-nums"
            value={yearsExp}
            onChange={(e) => setYearsExp(e.target.value)}
          />
        </Field>

        {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
      </div>
    </Modal>
  );
}
