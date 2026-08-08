'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LocationPicker } from '@/components/ui/LocationPicker';
import { CityMultiSelect } from '@/components/ui/CityMultiSelect';
import type { LocationSource } from '@/lib/location-search';
import type { PreferredCity, WorkerProfileData, WorkerProfilePatch } from '@/lib/api/worker';
import { splitDedupe } from '@/lib/text';
import { validateWorkerProfileFields, type WorkerProfileField } from '@/lib/worker-profile-form';
import { useErrorMessage } from '@/hooks/useErrorMessage';

const AVAILABILITY = ['full_time', 'part_time', 'weekends', 'flexible'] as const;

const FIELD_LABEL_KEY: Record<WorkerProfileField, string> = {
  full_name: 'full_name',
  skills: 'skills_placeholder',
  availability: 'availability_label',
  location: 'location',
};

export function ProfileEditForm(props: {
  initial: WorkerProfileData;
  onCancel: () => void;
  onSave: (patch: WorkerProfilePatch) => Promise<void>;
}) {
  const t = useTranslations('worker_profile.edit');
  const tFields = useTranslations('worker_profile');
  const tCommon = useTranslations('common');
  const errorMessage = useErrorMessage();
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
  const [error, setError] = useState<string | null>(null);
  const [missingFields, setMissingFields] = useState<WorkerProfileField[]>([]);

  async function save() {
    setError(null);
    const skillsList = splitDedupe(skills, { caseInsensitive: true });
    const missing = validateWorkerProfileFields({
      full_name: fullName.trim(),
      skills: skillsList,
      availability,
      location: location.trim(),
    });
    setMissingFields(missing);
    if (missing.length > 0) {
      setError(tFields('errors.missing_summary', {
        fields: missing.map((field) => t(FIELD_LABEL_KEY[field])).join(', '),
      }));
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
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <Input placeholder={t('full_name')} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        {missingFields.includes('full_name') && <p className="text-xs text-error mt-1">{tFields('errors.required')}</p>}
      </div>
      <div>
        <Input placeholder={t('skills_placeholder')} value={skills} onChange={(e) => setSkills(e.target.value)} />
        {missingFields.includes('skills') && <p className="text-xs text-error mt-1">{tFields('errors.required')}</p>}
      </div>
      <select className="w-full rounded border px-3 py-2 text-sm" value={availability} onChange={(e) => setAvailability(e.target.value)}>
        {AVAILABILITY.map(a => <option key={a} value={a}>{t(`availability.${a}`)}</option>)}
      </select>
      <Input type="number" min={0} max={80} placeholder={t('years_experience')} value={yearsExp} onChange={(e) => setYearsExp(e.target.value)} />
      <div>
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
        {missingFields.includes('location') && <p className="text-xs text-error mt-1">{tFields('errors.required')}</p>}
      </div>
      <div>
        <p className="text-xs font-semibold mb-1.5" style={{ color: 'var(--jale-ink-2)' }}>{t('preferred_cities_label')}</p>
        <CityMultiSelect value={preferredCities} onChange={setPreferredCities} />
      </div>
      <textarea className="w-full rounded border px-3 py-2 text-sm" rows={3} placeholder={t('bio')} value={bio} onChange={(e) => setBio(e.target.value)} />
      <Input placeholder={t('certifications_placeholder')} value={certs} onChange={(e) => setCerts(e.target.value)} />
      {error && <p className="text-sm text-error">{error}</p>}
      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={props.onCancel} disabled={saving}>{t('cancel')}</Button>
        <Button onClick={save} loading={saving} loadingLabel={tCommon('loading')}>{t('save')}</Button>
      </div>
    </div>
  );
}
