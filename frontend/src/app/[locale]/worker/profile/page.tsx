'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { apiFetch } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ProfileEditForm } from '@/components/worker/ProfileEditForm';
import { DocumentSlot } from '@/components/worker/DocumentSlot';
import { getVaultDocuments, updateWorkerProfile } from '@/lib/api/worker';
import type { WorkerProfileData, WorkerVaultDoc, DocType } from '@/lib/api/worker';

export const dynamic = 'force-dynamic';

const DOC_TYPES: DocType[] = ['resume', 'driver_license', 'ssn'];

export default function WorkerProfilePage() {
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('worker_profile');
  const tCommon = useTranslations('common');

  const [profile, setProfile] = useState<WorkerProfileData | null>(null);
  const [docs, setDocs] = useState<WorkerVaultDoc[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadAll() {
    if (!idToken) return;
    try {
      const res = await apiFetch('/worker/profile', {}, idToken);
      if (!res.ok) throw new Error('fetch_failed');
      const p = await res.json();
      setProfile({
        id: p.id, phone: p.phone, full_name: p.full_name,
        skills: p.skills ?? [], availability: p.availability,
        years_experience: p.years_experience, location: p.location, bio: p.bio,
      });
      const d = await getVaultDocuments(idToken);
      setDocs(d.documents);
      const pending = sessionStorage.getItem('pendingWorkerProfile');
      if (pending) {
        await updateWorkerProfile(idToken, JSON.parse(pending));
        sessionStorage.removeItem('pendingWorkerProfile');
        const updated = await apiFetch('/worker/profile', {}, idToken);
        if (updated.ok) {
          const next = await updated.json();
          setProfile({
            id: next.id, phone: next.phone, full_name: next.full_name,
            skills: next.skills ?? [], availability: next.availability,
            years_experience: next.years_experience, location: next.location, bio: next.bio,
          });
        }
      }
    } catch (err) {
      try { handleLegalWall(err, '/worker/profile'); }
      catch { setError(tCommon('error')); }
    }
  }

  useEffect(() => { loadAll(); }, [idToken]);

  async function handleSave(patch: Partial<WorkerProfileData>) {
    if (!idToken) return;
    await updateWorkerProfile(idToken, patch);
    setEditing(false);
    await loadAll();
  }

  if (error) return <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center"><p className="text-sm text-error">{error}</p></main>;
  if (!profile) return <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center"><p className="text-sm text-muted">{tCommon('loading')}</p></main>;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 space-y-8">
      <h1 className="text-[1.4rem] md:text-[1.7rem] font-bold tracking-[-0.03em] leading-[1.2]">{t('title')}</h1>

      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{t('info_title')}</h2>
          {!editing && <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{t('edit_button')}</Button>}
        </div>
        {editing ? (
          <ProfileEditForm initial={profile} onCancel={() => setEditing(false)} onSave={handleSave} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label={t('field_phone')} value={profile.phone} />
            <Field label={t('field_name')} value={profile.full_name} />
            <Field label={t('field_skills')} value={profile.skills.join(', ') || '—'} />
            <Field label={t('field_availability')} value={profile.availability ?? '—'} />
            <Field label={t('field_years_experience')} value={profile.years_experience?.toString() ?? '—'} />
            <Field label={t('field_location')} value={profile.location ?? '—'} />
            <div className="md:col-span-2"><Field label={t('field_bio')} value={profile.bio ?? '—'} /></div>
          </div>
        )}
      </Card>

      <Card className="p-6 space-y-4" id="documents">
        <h2 className="text-base font-semibold">{t('documents_title')}</h2>
        <p className="text-xs text-muted-foreground">{t('documents_subtitle')}</p>
        <div className="space-y-3">
          {DOC_TYPES.map((dt) => (
            <DocumentSlot
              key={dt}
              token={idToken!}
              doc_type={dt}
              existing={docs.find(d => d.doc_type === dt)}
              onChange={loadAll}
            />
          ))}
        </div>
      </Card>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted mb-1">{label}</p>
      <p className="text-sm">{value ?? '—'}</p>
    </div>
  );
}
