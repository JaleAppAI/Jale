'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const AVAILABILITY = ['immediate', '2-weeks', '1-month'] as const;
type Availability = (typeof AVAILABILITY)[number];

export interface ProfileCompleteValues {
  full_name: string;
  skills: string[];  // comma-separated in UI, split here
  availability: Availability;
  location: string;
  years_experience: number;
}

export function ProfileCompleteModal(props: {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: ProfileCompleteValues) => Promise<void>;
}) {
  const t = useTranslations('worker_profile.complete_modal');
  const [fullName, setFullName] = useState('');
  const [skills, setSkills] = useState('');
  const [availability, setAvailability] = useState<Availability>('immediate');
  const [location, setLocation] = useState('');
  const [yearsExp, setYearsExp] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!props.open) return null;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await props.onSubmit({
        full_name: fullName.trim(),
        skills: skills.split(',').map(s => s.trim()).filter(Boolean),
        availability,
        location: location.trim(),
        years_experience: Number(yearsExp) || 0,
      });
    } catch (e: any) {
      setError(e.message ?? 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg space-y-4">
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>

        <Input placeholder={t('full_name')} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <Input placeholder={t('skills_placeholder')} value={skills} onChange={(e) => setSkills(e.target.value)} />
        <select className="w-full rounded border px-3 py-2 text-sm" value={availability} onChange={(e) => setAvailability(e.target.value as Availability)}>
          {AVAILABILITY.map(a => <option key={a} value={a}>{t(`availability.${a.replace('-', '_')}`)}</option>)}
        </select>
        <Input placeholder={t('location')} value={location} onChange={(e) => setLocation(e.target.value)} />
        <Input type="number" min={0} placeholder={t('years_experience')} value={yearsExp} onChange={(e) => setYearsExp(e.target.value)} />

        {error && <p className="text-sm text-error">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={props.onClose} disabled={submitting}>{t('cancel')}</Button>
          <Button onClick={submit} disabled={submitting || !fullName.trim() || !location.trim()}>{t('submit')}</Button>
        </div>
      </div>
    </div>
  );
}
