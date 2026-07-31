'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { validateWorkerProfileFields, type WorkerProfileField } from '@/lib/worker-profile-form';

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
  years_experience: number;
}

export function ProfileCompleteModal(props: {
  open: boolean;
  initial?: Partial<ProfileCompleteValues>;
  onClose: () => void;
  onSubmit: (values: ProfileCompleteValues) => Promise<void>;
}) {
  const t = useTranslations('worker_profile.complete_modal');
  const tFields = useTranslations('worker_profile');
  const tCommon = useTranslations('common');
  const [fullName, setFullName] = useState('');
  const [skills, setSkills] = useState('');
  const [availability, setAvailability] = useState<Availability>('full_time');
  const [location, setLocation] = useState('');
  const [yearsExp, setYearsExp] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingFields, setMissingFields] = useState<WorkerProfileField[]>([]);

  // Prefill from the worker's existing profile each time the modal opens,
  // so they only fill in what's actually missing (e.g. WhatsApp-onboarded
  // workers already have name/availability/location).
  const { open, initial } = props;
  useEffect(() => {
    if (!open || !initial) return;
    setFullName(initial.full_name ?? '');
    setSkills((initial.skills ?? []).join(', '));
    if (initial.availability && (AVAILABILITY as readonly string[]).includes(initial.availability)) {
      setAvailability(initial.availability);
    }
    setLocation(initial.location ?? '');
    if (typeof initial.years_experience === 'number') {
      setYearsExp(String(initial.years_experience));
    }
  }, [open, initial]);

  if (!props.open) return null;

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
    if (missing.length > 0) {
      setError(tFields('errors.missing_summary', {
        fields: missing.map((field) => t(FIELD_LABEL_KEY[field])).join(', '),
      }));
      return;
    }
    setSubmitting(true);
    try {
      await props.onSubmit({
        ...values,
        // Clamp to [0, 80] to mirror the backend cap (max= on the input is not a
        // complete guard when submit goes through a custom handler).
        years_experience: Math.min(Math.max(Number(yearsExp) || 0, 0), 80),
      });
    } catch (e) {
      const err = e as Record<string, unknown>;
      setError(typeof err.message === 'string' ? err.message : 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg bg-card p-6 shadow-lg space-y-4">
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>

        <div>
          <Input placeholder={t('full_name')} value={fullName} onChange={(e) => setFullName(e.target.value)} />
          {missingFields.includes('full_name') && <p className="text-xs text-error mt-1">{tFields('errors.required')}</p>}
        </div>
        <div>
          <Input placeholder={t('skills_placeholder')} value={skills} onChange={(e) => setSkills(e.target.value)} />
          {missingFields.includes('skills') && <p className="text-xs text-error mt-1">{tFields('errors.required')}</p>}
        </div>
        <div>
          <select className="w-full rounded border px-3 py-2 text-sm" value={availability} onChange={(e) => setAvailability(e.target.value as Availability)}>
            {AVAILABILITY.map(a => <option key={a} value={a}>{t(`availability.${a}`)}</option>)}
          </select>
        </div>
        <div>
          <Input placeholder={t('location')} value={location} onChange={(e) => setLocation(e.target.value)} />
          {missingFields.includes('location') && <p className="text-xs text-error mt-1">{tFields('errors.required')}</p>}
        </div>
        <Input type="number" min={0} max={80} placeholder={t('years_experience')} value={yearsExp} onChange={(e) => setYearsExp(e.target.value)} />

        {error && <p className="text-sm text-error">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={props.onClose} disabled={submitting}>{t('cancel')}</Button>
          <Button onClick={submit} loading={submitting} loadingLabel={tCommon('loading')}>{t('submit')}</Button>
        </div>
      </div>
    </div>
  );
}
