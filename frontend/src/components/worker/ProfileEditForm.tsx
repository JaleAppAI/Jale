'use client';
import { useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineFeedback, type FeedbackTone } from '@/components/ui/inline-feedback';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { CityMultiSelect } from '@/components/ui/CityMultiSelect';
import type { LocationSource } from '@/lib/location-search';
import type { PreferredCity, WorkerProfileData, WorkerProfilePatch } from '@/lib/api/worker';
import { splitDedupe } from '@/lib/text';
import { validateWorkerProfileFields, type WorkerProfileField } from '@/lib/worker-profile-form';
import { AVAILABILITY_KEYS } from '@/lib/worker-vocab';
import { useErrorMessage } from '@/hooks/useErrorMessage';

const FIELD_LABEL_KEY: Record<WorkerProfileField, string> = {
  full_name: 'full_name',
  skills: 'skills_label',
  availability: 'availability_label',
  location: 'location',
};

/**
 * What the form has to say about the last save attempt.
 *
 * The two tones are different problems and must not read alike: `warning` is
 * "you still have fields to fill in" (the user's own next step, listed by
 * name), `danger` is "the save itself failed" (nothing the user typed is
 * wrong). Both sentences are translated -- `danger` goes through
 * `useErrorMessage`, never a thrown string.
 */
type FormFeedback = { tone: Extract<FeedbackTone, 'warning' | 'danger'>; text: string };

export function ProfileEditForm(props: {
  initial: WorkerProfileData;
  onCancel: () => void;
  onSave: (patch: WorkerProfilePatch) => Promise<void>;
}) {
  const t = useTranslations('worker_profile.edit');
  const tFields = useTranslations('worker_profile');
  const tCommon = useTranslations('common');
  const errorMessage = useErrorMessage();
  const fieldId = useId();
  const [fullName, setFullName] = useState(props.initial.full_name ?? '');
  const [skills, setSkills] = useState((props.initial.skills ?? []).join(', '));
  const [availability, setAvailability] = useState<string>(props.initial.availability ?? 'full_time');
  const [yearsExp, setYearsExp] = useState(String(props.initial.years_experience ?? 0));
  const [location, setLocation] = useState(props.initial.location ?? '');
  const [bio, setBio] = useState(props.initial.bio ?? '');
  const [certs, setCerts] = useState((props.initial.certifications ?? []).join(', '));
  const [coords, setCoords] = useState<{ latitude: number; longitude: number; location_source: LocationSource } | null>(null);
  const [preferredCities, setPreferredCities] = useState<PreferredCity[]>(props.initial.preferred_cities ?? []);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<FormFeedback | null>(null);
  const [missingFields, setMissingFields] = useState<WorkerProfileField[]>([]);

  async function save() {
    setFeedback(null);
    const skillsList = splitDedupe(skills, { caseInsensitive: true });
    const missing = validateWorkerProfileFields({
      full_name: fullName.trim(),
      skills: skillsList,
      availability,
      location: location.trim(),
    });
    setMissingFields(missing);
    if (missing.length > 0) {
      setFeedback({
        tone: 'warning',
        text: tFields('errors.missing_summary', {
          fields: missing.map((field) => t(FIELD_LABEL_KEY[field])).join(', '),
        }),
      });
      return;
    }
    setSaving(true);
    try {
      await props.onSave({
        full_name: fullName.trim() || null,
        skills: skillsList,
        availability: availability as WorkerProfileData['availability'],
        years_experience: Number(yearsExp) || 0,
        location: location.trim() || null,
        bio: bio.trim() || null,
        certifications: splitDedupe(certs),
        preferred_cities: preferredCities,
        ...(coords ?? {}),
      });
    } catch (e) {
      // Never `err.message`: that is a backend error code or an exception
      // string, neither of which is translated copy.
      setFeedback({ tone: 'danger', text: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  const requiredError = tFields('errors.required');

  return (
    <div className="space-y-4">
      <LabeledField
        label={t('full_name')}
        htmlFor={`${fieldId}-full-name`}
        error={missingFields.includes('full_name') ? requiredError : undefined}
      >
        <Input
          id={`${fieldId}-full-name`}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          autoComplete="name"
        />
      </LabeledField>

      <LabeledField
        label={t('skills_label')}
        htmlFor={`${fieldId}-skills`}
        error={missingFields.includes('skills') ? requiredError : undefined}
      >
        <Input
          id={`${fieldId}-skills`}
          placeholder={t('skills_placeholder')}
          value={skills}
          onChange={(e) => setSkills(e.target.value)}
        />
      </LabeledField>

      <LabeledField label={t('availability_label')} htmlFor={`${fieldId}-availability`}>
        <Select
          id={`${fieldId}-availability`}
          value={availability}
          onChange={(e) => setAvailability(e.target.value)}
        >
          {AVAILABILITY_KEYS.map((a) => <option key={a} value={a}>{t(`availability.${a}`)}</option>)}
        </Select>
      </LabeledField>

      <LabeledField label={t('years_experience')} htmlFor={`${fieldId}-years`}>
        <Input
          id={`${fieldId}-years`}
          type="number"
          min={0}
          max={80}
          inputMode="numeric"
          className="tabular-nums"
          value={yearsExp}
          onChange={(e) => setYearsExp(e.target.value)}
        />
      </LabeledField>

      {/* LocationPicker and CityMultiSelect own their internal inputs and take no
          id, so their labels are plain text rather than a mislinked <label>. */}
      <StackedField
        label={t('location')}
        error={missingFields.includes('location') ? requiredError : undefined}
      >
        <LocationPicker
          placeholder={t('location')}
          value={location}
          onChange={(v) => {
            setLocation(v.label);
            setCoords(
              v.latitude != null && v.longitude != null && v.source
                ? { latitude: v.latitude, longitude: v.longitude, location_source: v.source }
                : null,
            );
          }}
        />
      </StackedField>

      <StackedField label={t('preferred_cities_label')}>
        <CityMultiSelect value={preferredCities} onChange={setPreferredCities} />
      </StackedField>

      <LabeledField label={t('bio')} htmlFor={`${fieldId}-bio`}>
        <Textarea id={`${fieldId}-bio`} rows={3} value={bio} onChange={(e) => setBio(e.target.value)} />
      </LabeledField>

      <LabeledField label={t('certifications_label')} htmlFor={`${fieldId}-certs`}>
        <Input
          id={`${fieldId}-certs`}
          placeholder={t('certifications_placeholder')}
          value={certs}
          onChange={(e) => setCerts(e.target.value)}
        />
      </LabeledField>

      {feedback && (
        <InlineFeedback tone={feedback.tone} onDismiss={() => setFeedback(null)}>
          {feedback.text}
        </InlineFeedback>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={props.onCancel} disabled={saving}>{t('cancel')}</Button>
        <Button onClick={save} loading={saving} loadingLabel={tCommon('loading')}>{t('save')}</Button>
      </div>
    </div>
  );
}

const labelClasses = 'text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]';

/** Label + control + adjacent validation error, for controls that accept an id. */
function LabeledField({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className={labelClasses} htmlFor={htmlFor}>{label}</label>
      {children}
      {error && <p className="text-xs font-semibold text-[var(--jale-danger)]">{error}</p>}
    </div>
  );
}

/** Same shape for composite controls that own their own inner input. */
function StackedField({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className={labelClasses}>{label}</p>
      {children}
      {error && <p className="text-xs font-semibold text-[var(--jale-danger)]">{error}</p>}
    </div>
  );
}
