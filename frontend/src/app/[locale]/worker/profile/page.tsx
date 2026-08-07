'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { apiFetch } from '@/lib/api';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/PageSkeleton';
import { ProfileEditForm } from '@/components/worker/ProfileEditForm';
import { DocumentSlot } from '@/components/worker/DocumentSlot';
import { getVaultDocuments, updateWorkerProfile } from '@/lib/api/worker';
import type { WorkerProfileData, WorkerProfilePatch, WorkerVaultDoc, DocType } from '@/lib/api/worker';
import { readPendingReferral, clearPendingReferral, validateJobId } from '@/lib/referral-return';

export const dynamic = 'force-dynamic';

const DOC_TYPES: DocType[] = ['resume', 'driver_license'];

export default function WorkerProfilePage() {
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const router = useRouter();
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
        certifications: p.certifications ?? [],
        preferred_cities: p.preferred_cities ?? [],
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
            certifications: next.certifications ?? [],
            preferred_cities: next.preferred_cities ?? [],
          });
        }

        // This is the second stop of the web-apply signup journey: the form
        // sent a fresh signup here (so the typed profile above gets saved)
        // instead of straight to the job. If a referral is still waiting,
        // finish the journey now.
        const referral = readPendingReferral();
        const jobId = validateJobId(referral?.jobId);
        if (jobId) {
          clearPendingReferral();
          router.push(`/worker/jobs/${jobId}`);
          return;
        }
      }
    } catch (err) {
      try { handleLegalWall(err, '/worker/profile'); }
      catch { setError(tCommon('error')); }
    }
  }

  useEffect(() => { loadAll(); }, [idToken]);

  async function handleSave(patch: WorkerProfilePatch) {
    if (!idToken) return;
    await updateWorkerProfile(idToken, patch);
    setEditing(false);
    await loadAll();
  }

  if (error) {
    return (
      <AppShell role="worker" title={t('title')}>
        <main className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-3 px-4">
          <p className="text-sm text-error">{error}</p>
          <Button variant="outline" onClick={() => { setError(null); loadAll(); }}>{tCommon('retry')}</Button>
        </main>
      </AppShell>
    );
  }
  if (!profile) {
    return (
      <AppShell role="worker" title={t('title')}>
        <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
          <PageSkeleton label={tCommon('loading')} />
        </main>
      </AppShell>
    );
  }

  return (
    <AppShell role="worker" title={t('title')}>
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-6">
        <DashboardPanel>
          <PanelHeader
            title={t('info_title')}
            action={!editing ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{t('edit_button')}</Button>
            ) : undefined}
          />
          <div className="p-6">
            {editing ? (
              <ProfileEditForm initial={profile} onCancel={() => setEditing(false)} onSave={handleSave} />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label={t('field_phone')} value={profile.phone} />
                <Field label={t('field_name')} value={profile.full_name} />
                <PillListField label={t('field_skills')} items={profile.skills} />
                <PillListField label={t('field_certifications')} items={profile.certifications ?? []} />
                <Field
                  label={t('field_availability')}
                  value={
                    profile.availability &&
                    ['full_time', 'part_time', 'weekends', 'flexible'].includes(profile.availability)
                      ? t(`availability.${profile.availability}`)
                      : '-'
                  }
                />
                <Field label={t('field_years_experience')} value={profile.years_experience?.toString() ?? '-'} />
                <Field label={t('field_location')} value={profile.location ?? '-'} />
                <PillListField
                  label={t('edit.preferred_cities_label')}
                  items={(profile.preferred_cities ?? []).map((c) => `${c.city}, ${c.state}`)}
                />
                <div className="md:col-span-2"><Field label={t('field_bio')} value={profile.bio ?? '-'} /></div>
              </div>
            )}
          </div>
        </DashboardPanel>

        {/* id="documents" kept from the original markup for future deep-linking. */}
        <div id="documents">
          <DashboardPanel>
            <PanelHeader title={t('documents_title')} />
            <div className="space-y-4 p-6">
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
            </div>
          </DashboardPanel>
        </div>
      </main>
    </AppShell>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted mb-1">{label}</p>
      <p className="text-sm">{value ?? '-'}</p>
    </div>
  );
}

function PillListField({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted mb-1">{label}</p>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span key={item} className="pill pill-info" style={{ fontSize: 10, textTransform: 'none' }}>
              {item}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-sm">-</p>
      )}
    </div>
  );
}
