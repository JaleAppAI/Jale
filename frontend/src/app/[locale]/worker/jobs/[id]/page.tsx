'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Link } from '@/i18n/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { Button } from '@/components/ui/button';
import { ApplicationStatusChip } from '@/components/worker/ApplicationStatusChip';
import { ShareJobPanel } from '@/components/worker/ShareJobPanel';
import { ProfileCompleteModal, ProfileCompleteValues } from '@/components/worker/ProfileCompleteModal';
import { apiFetch, isLegalWallError } from '@/lib/api';
import { formatStartDate } from '@/lib/date';
import { getJob, applyToJob, updateWorkerProfile } from '@/lib/api/worker';
import type { JobDetail, WorkerApiError } from '@/lib/api/worker';

export const dynamic = 'force-dynamic';

const DOC_LABELS: Record<string, string> = {
  resume: 'Resume',
  driver_license: "Driver's License",
  // SSN is no longer offered for new jobs, but legacy jobs may still require it — keep the label.
  ssn: 'SSN Card / ITIN',
};

export default function WorkerJobDetailPage() {
  const { id } = useParams<{ id: string; locale: string }>();
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('worker_job_detail');
  const tCommon = useTranslations('common');
  const locale = useLocale();

  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [profilePrefill, setProfilePrefill] = useState<Partial<ProfileCompleteValues> | null>(null);

  const load = useCallback(async () => {
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
  }, [idToken, id, handleLegalWall, tCommon]);

  useEffect(() => { load(); }, [load]);

  async function fetchProfile(): Promise<Partial<ProfileCompleteValues>> {
    if (!idToken) throw new Error('not_signed_in');
    const res = await apiFetch('/worker/profile', {}, idToken);
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      const err = new Error(body.error ?? 'profile_check_failed') as WorkerApiError;
      err.status = res.status;
      err.code = body.error;
      throw err;
    }
    return await res.json();
  }

  function profileIsComplete(p: Partial<ProfileCompleteValues>): boolean {
    return !!(p.full_name && p.skills && p.skills.length > 0 && p.availability && p.location);
  }

  async function handleApplyClick() {
    if (!idToken || !id || !job) return;
    setError(null);
    setApplying(true);
    try {
      const profile = await fetchProfile();
      if (!profileIsComplete(profile)) {
        setProfilePrefill(profile);
        setModalOpen(true);
        return;
      }
      await doApply();
    } catch (err) {
      await handleApplyError(err);
    } finally {
      setApplying(false);
    }
  }

  async function doApply() {
    if (!idToken || !id) return;
    setApplying(true);
    try {
      await applyToJob(idToken, id);
      await load();
    } catch (err) {
      await handleApplyError(err);
    } finally {
      setApplying(false);
    }
  }

  async function handleModalSubmit(values: ProfileCompleteValues) {
    if (!idToken) return;
    setError(null);
    setApplying(true);
    try {
      await updateWorkerProfile(idToken, values);
      setModalOpen(false);
      await doApply();
    } catch (err) {
      handleApplyError(err);
    } finally {
      setApplying(false);
    }
  }

  async function handleApplyError(err: unknown) {
    if (isLegalWallError(err)) {
      try { handleLegalWall(err, `/worker/jobs/${id}`); } catch { setError(t('errors.legal_required')); }
      return;
    }

    const applyErr = err as WorkerApiError;
    if (applyErr.status === 400 && applyErr.missing_docs?.length) {
      setError(t('errors.missing_docs', { docs: applyErr.missing_docs.map((d) => DOC_LABELS[d] ?? d).join(', ') }));
      return;
    }
    if (applyErr.status === 400) {
      setError(t('errors.profile_invalid'));
      return;
    }
    if (applyErr.status === 401) {
      setError(t('errors.not_signed_in'));
      return;
    }
    if (applyErr.status === 403 || applyErr.code === 'legal_required') {
      setError(t('errors.legal_required'));
      return;
    }
    if (applyErr.status === 409) {
      if (applyErr.code === 'user_not_provisioned') setError(t('errors.account_not_ready'));
      else setError(t('errors.already_applied'));
      await load();
      return;
    }
    if (applyErr.status === 410 || applyErr.status === 404) {
      setError(t('errors.job_closed'));
      await load();
      return;
    }
    if (applyErr.status && applyErr.status >= 500) {
      setError(t('errors.server_error'));
      return;
    }
    setError(t('errors.apply_failed'));
  }

  if (loading) {
    return (
      <AppShell role="worker" title={job?.title ?? t('page_title')}>
        <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4">
          <p className="text-sm text-muted">{tCommon('loading')}</p>
        </main>
      </AppShell>
    );
  }
  if (!job) {
    return (
      <AppShell role="worker" title={t('page_title')}>
        <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4">
          <p className="text-sm text-error">{error ?? tCommon('error')}</p>
        </main>
      </AppShell>
    );
  }

  const canApply = !job.already_applied && job.missing_docs.length === 0;

  return (
    <AppShell role="worker" title={job.title} subtitle={`${job.company_name} · ${job.location}`}>
      <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
        <Link href="/worker/home" className="text-sm text-muted-foreground hover:text-foreground mb-6 inline-block">
          {t('back')}
        </Link>

        <DashboardPanel className="mb-6">
          <div className="space-y-4 p-6">
            <p className="text-xs text-muted-foreground capitalize">{job.job_type.replace('-', ' ')} - {new Date(job.created_at).toLocaleDateString()}</p>

            {job.description && <p className="text-sm whitespace-pre-wrap">{job.description}</p>}

            <div className="grid gap-3 text-sm md:grid-cols-3">
              {job.pay && job.pay !== 'Pay not specified' && <Detail label={t('pay_range')} value={job.pay} />}
              {job.start_date && <Detail label={t('start_date')} value={formatStartDate(job.start_date, locale) ?? job.start_date} />}
              {job.expected_duration && <Detail label={t('expected_duration')} value={job.expected_duration} />}
              {job.shift_schedule && <Detail label={t('shift_schedule')} value={job.shift_schedule} />}
              {job.number_of_workers_needed !== undefined && (
                <Detail label={t('openings')} value={`${job.open_count ?? 0}/${job.number_of_workers_needed}`} />
              )}
              {job.required_experience_years !== undefined && job.required_experience_years !== null && (
                <Detail label={t('required_experience')} value={`${job.required_experience_years}`} />
              )}
              {job.work_authorization_required && (
                <Detail label={t('work_authorization_required')} value={t('work_authorization_required_yes')} />
              )}
            </div>

            {job.required_docs.length > 0 && (
              <div>
                <p className="text-xs uppercase tracking-wide text-muted mb-2">{t('required_docs')}</p>
                <ul className="space-y-1">
                  {job.required_docs.map((d) => {
                    const missing = job.missing_docs.includes(d);
                    return (
                      <li key={d} className="text-sm flex items-center gap-2">
                        <span className={missing ? 'text-error' : 'text-green-700'}>{missing ? 'x' : 'OK'}</span>
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
          </div>
        </DashboardPanel>

        <DashboardPanel className="mb-6">
          <div className="p-6">
            <ShareJobPanel jobId={id} />
          </div>
        </DashboardPanel>

        <div className="flex items-center justify-end gap-3">
          {job.already_applied ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('already_applied')}</span>
              <ApplicationStatusChip status={job.application_status ?? 'pending'} />
            </div>
          ) : (
            <Button onClick={handleApplyClick} disabled={!canApply} loading={applying} loadingLabel={tCommon('loading')}>
              {t('apply')}
            </Button>
          )}
        </div>

        {error && <p className="text-sm text-error mt-4">{error}</p>}

        <ProfileCompleteModal
          open={modalOpen}
          initial={profilePrefill ?? undefined}
          onClose={() => setModalOpen(false)}
          onSubmit={handleModalSubmit}
        />
      </main>
    </AppShell>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted mb-1">{label}</p>
      <p>{value}</p>
    </div>
  );
}
