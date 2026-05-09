'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Link } from '@/i18n/navigation';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ApplicationStatusChip } from '@/components/worker/ApplicationStatusChip';
import { ProfileCompleteModal, ProfileCompleteValues } from '@/components/worker/ProfileCompleteModal';
import { apiFetch } from '@/lib/api';
import { getJob, applyToJob, updateWorkerProfile } from '@/lib/api/worker';
import type { JobDetail } from '@/lib/api/worker';

export const dynamic = 'force-dynamic';

const DOC_LABELS: Record<string, string> = {
  resume: 'Resume',
  driver_license: "Driver's License",
  ssn: 'SSN',
};

export default function WorkerJobDetailPage() {
  const { id } = useParams<{ id: string; locale: string }>();
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('worker_job_detail');
  const tCommon = useTranslations('common');

  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  async function load() {
    if (!idToken || !id) return;
    setLoading(true);
    try {
      const j = await getJob(idToken, id);
      setJob(j);
    } catch (err) {
      try { handleLegalWall(err, `/worker/jobs/${id}`); }
      catch { setError(tCommon('error')); }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [idToken, id, load]);

  async function profileIsComplete(): Promise<boolean> {
    if (!idToken) return false;
    const res = await apiFetch('/worker/profile', {}, idToken);
    if (!res.ok) return false;
    const p = await res.json();
    return !!(p.full_name && p.skills?.length > 0 && p.availability && p.location);
  }

  async function handleApplyClick() {
    if (!idToken || !id || !job) return;
    if (!(await profileIsComplete())) {
      setModalOpen(true);
      return;
    }
    await doApply();
  }

  async function doApply() {
    if (!idToken || !id) return;
    setApplying(true);
    try {
      await applyToJob(idToken, id);
      await load();
    } catch (e) {
      const err = e as Record<string, unknown>;
      if (err.status === 400 && err.missing_docs) {
        setError(t('errors.missing_docs', { docs: (err.missing_docs as string[]).map((d: string) => DOC_LABELS[d] ?? d).join(', ') }));
      } else if (err.status === 409) {
        await load();
      } else if (err.status === 410) {
        setError(t('errors.job_closed'));
        await load();
      } else {
        setError(tCommon('error'));
      }
    } finally {
      setApplying(false);
    }
  }

  async function handleModalSubmit(values: ProfileCompleteValues) {
    if (!idToken) return;
    await updateWorkerProfile(idToken, values);
    setModalOpen(false);
    await doApply();
  }

  if (loading) return <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center"><p className="text-sm text-muted">{tCommon('loading')}</p></main>;
  if (!job) return <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center"><p className="text-sm text-error">{error ?? tCommon('error')}</p></main>;

  const canApply = !job.already_applied && job.missing_docs.length === 0;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <Link href="/worker/home" className="text-sm text-muted-foreground hover:text-foreground mb-6 inline-block">
        {t('back')}
      </Link>

      <Card className="p-6 space-y-4 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">{job.title}</h1>
            <p className="text-sm text-muted-foreground mt-1">{job.company_name} · {job.location}</p>
            <p className="text-xs text-muted-foreground mt-1 capitalize">{job.job_type.replace('-', ' ')} · {new Date(job.created_at).toLocaleDateString()}</p>
          </div>
        </div>

        {job.description && <p className="text-sm whitespace-pre-wrap">{job.description}</p>}

        {job.required_docs.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-wide text-muted mb-2">{t('required_docs')}</p>
            <ul className="space-y-1">
              {job.required_docs.map((d) => {
                const missing = job.missing_docs.includes(d);
                return (
                  <li key={d} className="text-sm flex items-center gap-2">
                    <span className={missing ? 'text-error' : 'text-green-700'}>{missing ? '✗' : '✓'}</span>
                    <span>{DOC_LABELS[d] ?? d}</span>
                  </li>
                );
              })}
            </ul>
            {job.missing_docs.length > 0 && (
              <p className="text-xs text-muted mt-2">
                {t('upload_prompt')} <Link href="/worker/profile" className="text-blue-700 underline">{t('upload_link')}</Link>
              </p>
            )}
          </div>
        )}
      </Card>

      <div className="flex items-center justify-end gap-3">
        {job.already_applied ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('already_applied')}</span>
            <ApplicationStatusChip status={job.application_status ?? 'pending'} />
          </div>
        ) : (
          <Button onClick={handleApplyClick} disabled={!canApply || applying}>
            {applying ? tCommon('loading') : t('apply')}
          </Button>
        )}
      </div>

      {error && <p className="text-sm text-error mt-4">{error}</p>}

      <ProfileCompleteModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={handleModalSubmit}
      />
    </main>
  );
}
