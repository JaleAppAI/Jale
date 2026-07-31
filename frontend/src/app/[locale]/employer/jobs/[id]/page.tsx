'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useRouter } from '@/i18n/navigation';
import { LegalWallError } from '@/lib/api';
import { Link } from '@/i18n/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { PanelHeader } from '@/components/ui/panel-header';
import { MetricCard } from '@/components/ui/metric-card';
import { MatchReasonChips, MatchScoreBadge } from '@/components/ui/match-signals';
import { ApplicantFilterPanel } from '@/components/employer/ApplicantFilterPanel';
import { DeleteJobDialog } from '@/components/employer/DeleteJobDialog';
import { EditJobModal } from '@/components/employer/EditJobModal';
import { ApiError, deleteJob, getJob, getJobApplicants, getJobCandidates, startConversation, updateJobStatus } from '@/lib/api/employer';
import type { EmployerJobDetail, Applicant, ApplicantFilters } from '@/lib/api/employer';
import type { ScoreBand } from '@/lib/match';
import { normalizeMatchScore, normalizeScoreBand, truncateMatchReason } from '@/lib/match';
import { applicationStatusTone, jobStatusTone } from '@/lib/status';
import type { WritableJobStatus } from '@/lib/status';
import { formatStartDate } from '@/lib/date';
import { PublicListingToggle } from '@/components/employer/PublicListingToggle';

export const dynamic = 'force-dynamic';

type ApplicantMatch = {
  match_score: number;
  score_band: ScoreBand;
  match_reasons: string[];
};

export default function JobDetailPage() {
  const { id } = useParams<{ id: string; locale: string }>();
  const router = useRouter();
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');
  const tMatch = useTranslations('match');
  const locale = useLocale();

  const [job, setJob] = useState<EmployerJobDetail | null>(null);
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [candidateMatches, setCandidateMatches] = useState<Map<string, ApplicantMatch>>(new Map());
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<ApplicantFilters>({});
  const [loadingJob, setLoadingJob] = useState(true);
  const [loadingApplicants, setLoadingApplicants] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!idToken || !id) return;
    setLoadingJob(true);
    getJob(idToken, id)
      .then(setJob)
      .catch((err) => {
        try {
          handleLegalWall(err, `/employer/jobs/${id}`);
        } catch {
          setError(tCommon('error'));
        }
      })
      .finally(() => setLoadingJob(false));
  }, [idToken, id]);

  useEffect(() => {
    if (!idToken || !id) return;
    let active = true;

    async function loadApplicantsAndMatches() {
      setLoadingApplicants(true);
      setCandidateMatches(new Map());

      try {
        const res = await getJobApplicants(idToken!, id, filters);
        if (!active) return;
        setApplicants(res.applicants);
        setTotal(res.total);
        setLoadingApplicants(false);

        try {
          const ranked = await getJobCandidates(idToken!, id, 100);
          if (!active) return;
          setCandidateMatches(buildCandidateMatchMap(ranked.candidates));
        } catch (err) {
          if (!active) return;
          const status = (err as { status?: number }).status;
          if (err instanceof LegalWallError || status === 401 || status === 403) {
            try {
              handleLegalWall(err, `/employer/jobs/${id}`);
            } catch {
              setError(tCommon('error'));
            }
          } else {
            setCandidateMatches(new Map());
          }
        }
      } catch (err) {
        if (!active) return;
        try {
          handleLegalWall(err, `/employer/jobs/${id}`);
        } catch {
          setError(tCommon('error'));
        }
        setLoadingApplicants(false);
      }
    }

    loadApplicantsAndMatches();
    return () => { active = false; };
  }, [idToken, id, filters]);

  async function handleSetJobStatus(status: WritableJobStatus) {
    if (!idToken || !job) return;
    setTogglingStatus(true);
    try {
      const updated = await updateJobStatus(idToken, job.id, status);
      setJob((current) => current ? { ...current, ...updated } : null);
    } finally {
      setTogglingStatus(false);
    }
  }

  if (error) {
    return (
      <AppShell role="employer" title={t('jobs.posting_details')}>
        <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4">
          <p className="text-sm text-error">{error}</p>
        </main>
      </AppShell>
    );
  }

  const pendingCount = applicants.filter((a) => a.status === 'pending').length;
  const hiredCount = applicants.filter((a) => a.status === 'hired').length;
  const openCount = job ? job.open_count ?? Math.max(0, job.number_of_workers_needed - job.hired_count) : 0;
  const docLabels: Record<string, string> = {
    resume: t('worker_profile.doc_resume'),
    driver_license: t('worker_profile.doc_driver_license'),
    // SSN is no longer offered for new jobs, but legacy jobs may still require it — keep the label.
    ssn: t('worker_profile.doc_ssn'),
  };
  const jobTypeLabels: Record<string, string> = {
    'full-time': t('modal.job_type_fulltime'),
    'part-time': t('modal.job_type_parttime'),
    contract: t('modal.job_type_contract'),
  };
  const jobStatus = job ? jobStatusTone(job.status) : null;

  const jobActions = job ? (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className="rounded-full px-2 py-0.5 text-xs font-medium"
        style={{ background: jobStatus?.bg, color: jobStatus?.color }}
      >
        {t(`jobs.status.${job.status}`)}
      </span>
      {job.status === 'active' && (
        // Manual "Pause" action intentionally removed (kept backend/status support
        // and the paused-state resume UI for billing-auto-paused jobs).
        <Button variant="outline" size="sm" onClick={() => handleSetJobStatus('closed')} disabled={togglingStatus}>
          {t('jobs.toggle.close')}
        </Button>
      )}
      {job.status === 'paused' && (
        <>
          <Button variant="outline" size="sm" onClick={() => handleSetJobStatus('active')} loading={togglingStatus} loadingLabel={tCommon('loading')}>
            {t('jobs.toggle.activate')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleSetJobStatus('closed')} disabled={togglingStatus}>
            {t('jobs.toggle.close')}
          </Button>
        </>
      )}
      {job.status === 'closed' && (
        <Button variant="outline" size="sm" onClick={() => handleSetJobStatus('active')} loading={togglingStatus} loadingLabel={tCommon('loading')}>
          {t('jobs.toggle.activate')}
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => setEditOpen(true)} disabled={togglingStatus}>
        {t('modal.edit_title')}
      </Button>
      <Button variant="error" size="sm" onClick={() => setConfirmDelete(true)} disabled={togglingStatus}>
        {t('jobs.delete.button')}
      </Button>
    </div>
  ) : undefined;

  return (
    <>
    <AppShell
      role="employer"
      title={job ? job.title : t('jobs.posting_details')}
      subtitle={job ? job.location : undefined}
    >
    <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link href="/employer/dashboard" className="text-sm text-muted-foreground hover:text-foreground inline-block">
          {t('jobs.back_to_dashboard')}
        </Link>
        {jobActions}
      </div>

      {loadingJob ? (
        <p className="text-sm text-muted">{tCommon('loading')}</p>
      ) : job ? (
        <>
          <Card className="p-6 mb-6">
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 md:grid-cols-3">
                <DetailField label={t('modal.job_title')} value={job.title} />
                <DetailField label={t('modal.location')} value={job.location} />
                <DetailField label={t('modal.job_type')} value={jobTypeLabels[job.job_type] ?? job.job_type} />
                <DetailField label={t('modal.trade_category')} value={job.trade_category ? t(`modal.trade.${job.trade_category}`) : t('jobs.not_specified')} />
                <DetailField label={t('jobs.pay_range')} value={job.pay ?? t('jobs.not_specified')} />
                <DetailField label={t('modal.start_date')} value={formatStartDate(job.start_date, locale) ?? t('jobs.not_specified')} />
                <DetailField label={t('modal.expected_duration')} value={job.expected_duration ?? t('jobs.not_specified')} />
                <DetailField label={t('modal.shift_schedule')} value={job.shift_schedule ?? t('jobs.not_specified')} />
                <DetailField label={t('modal.transportation_required')} value={job.transportation_required ? t('jobs.yes') : t('jobs.no')} />
                <DetailField label={t('modal.work_authorization_required')} value={job.work_authorization_required ? t('jobs.yes') : t('jobs.no')} />
                <DetailField label={t('modal.language_preference')} value={job.language_preference.map((lang) => t(`modal.language.${lang}`)).join(', ')} />
                <DetailField label={t('modal.number_of_workers_needed')} value={String(job.number_of_workers_needed)} />
                <DetailField label={t('jobs.hired_progress')} value={t('jobs.hired_progress_value', { hired: job.hired_count, total: job.number_of_workers_needed, open: openCount })} />
                <DetailField label={t('modal.required_experience_years')} value={job.required_experience_years === null ? t('jobs.not_specified') : String(job.required_experience_years)} />
              </div>

              {job.certifications.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted mb-2">{t('modal.certifications')}</p>
                  <div className="flex flex-wrap gap-2">
                    {job.certifications.map((cert) => (
                      <span key={cert} className="rounded-full bg-muted px-3 py-1 text-xs font-medium">{cert}</span>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <p className="text-xs uppercase tracking-wide text-muted mb-2">{t('modal.job_description')}</p>
                <p className="text-sm whitespace-pre-wrap text-foreground">
                  {job.description?.trim() || t('jobs.no_description')}
                </p>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-muted mb-2">{t('jobs.required_documents')}</p>
                {job.required_docs.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {job.required_docs.map((doc) => (
                      <span key={doc} className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
                        {docLabels[doc] ?? doc}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('jobs.no_required_documents')}</p>
                )}
              </div>
            </div>
          </Card>

          <div className="mb-6">
            <PublicListingToggle jobId={job.id} initialEnabled={job.public_listing_enabled} publicCode={job.public_code} />
          </div>

          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <MetricCard tone="blue" label={t('stats.total_applicants')} value={total} />
            <MetricCard tone="amber" label={t('applicants.status.pending')} value={pendingCount} />
            <MetricCard tone="green" label={t('applicants.status.hired')} value={hiredCount} />
          </div>

          <DashboardPanel>
            <PanelHeader title={t('applicants.title')} />
            <div className="space-y-4 p-5">
              <ApplicantFilterPanel filters={filters} onChange={setFilters} />

              {loadingApplicants ? (
                <p className="text-sm text-muted">{tCommon('loading')}</p>
              ) : applicants.length === 0 ? (
                <p className="text-sm text-muted">{t('applicants.empty')}</p>
              ) : (
                <div className="space-y-3">
                  {applicants.map((applicant) => (
                    <ApplicantCard
                      key={applicant.application_id}
                      applicant={applicant}
                      match={candidateMatches.get(applicant.application_id) ?? candidateMatches.get(applicant.worker_id)}
                      jobId={job.id}
                      jobTitle={job.title}
                      t={t}
                      tMatch={tMatch}
                    />
                  ))}
                </div>
              )}
            </div>
          </DashboardPanel>
        </>
      ) : (
        <p className="text-sm text-muted">{tCommon('error')}</p>
      )}
    </main>
    </AppShell>
    <DeleteJobDialog
      open={confirmDelete}
      jobTitle={job?.title ?? ''}
      deleting={deleting}
      error={deleteError}
      onCancel={() => {
        if (deleting) return;
        setConfirmDelete(false);
        setDeleteError(null);
      }}
      onConfirm={async () => {
        if (!idToken || !job || deleting) return;
        setDeleting(true);
        setDeleteError(null);
        try {
          await deleteJob(idToken, job.id);
          router.push('/employer/dashboard');
        } catch (err) {
          if (err instanceof ApiError && err.code === 'job_has_hired_workers') {
            setDeleteError(t('jobs.delete.error_hired'));
          } else {
            setDeleteError(t('jobs.delete.error_generic'));
          }
          setDeleting(false);
        }
      }}
    />
    {job && (
      <EditJobModal
        key={`${job.id}:${editOpen}`}
        open={editOpen}
        job={job}
        onClose={() => setEditOpen(false)}
        onJobUpdated={(updated) => { setJob(updated); setEditOpen(false); }}
      />
    )}
    </>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted mb-1">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

function ApplicantCard({
  applicant,
  match,
  jobId,
  jobTitle,
  t,
  tMatch,
}: {
  applicant: Applicant;
  match?: ApplicantMatch;
  jobId: string;
  jobTitle: string;
  t: ReturnType<typeof useTranslations>;
  tMatch: ReturnType<typeof useTranslations>;
}) {
  const { idToken } = useAuth();
  const router = useRouter();
  const tMessages = useTranslations('employer_messages');
  const [startingConversation, setStartingConversation] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);

  async function handleMessageWorker() {
    if (!idToken) return;
    setStartingConversation(true);
    setMessageError(null);
    try {
      const response = await startConversation(idToken, {
        job_id: jobId,
        worker_id: applicant.worker_id,
        initial_message: tMessages('default_initial_message', { jobTitle }),
      });
      router.push(`/employer/conversations?conversation_id=${response.conversation.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'message_start_failed';
      setMessageError(
        message === 'worker_whatsapp_unavailable'
          ? tMessages('worker_whatsapp_unavailable')
          : tMessages('message_start_failed'),
      );
    } finally {
      setStartingConversation(false);
    }
  }

  return (
    <Card className="p-4 flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-base font-semibold">{applicant.full_name}</p>
          {match && (
            <div className="mt-1">
              <MatchScoreBadge
                score={match.match_score}
                band={match.score_band}
                label={tMatch(`score_bands.${match.score_band}`)}
              />
            </div>
          )}
        </div>
        <span
          className="rounded-full px-2 py-0.5 text-xs font-medium shrink-0 self-start"
          style={{
            background: applicationStatusTone(applicant.status).bg,
            color: applicationStatusTone(applicant.status).color,
          }}
        >
          {t(`applicants.status.${applicant.status}`)}
        </span>
      </div>

      {match && match.match_reasons.length > 0 && (
        <MatchReasonChips reasons={match.match_reasons} />
      )}

      <p className="text-xs text-muted-foreground">{t('applicants.phone')}: {applicant.phone}</p>

      {applicant.skills.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {applicant.skills.map((skill) => (
            <span key={skill} className="rounded-full bg-muted px-2 py-0.5 text-xs">
              {skill}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {applicant.availability && (
          <span>{t(`filter.availability_${applicant.availability.replace('-', '')}`)}</span>
        )}
        {applicant.years_experience !== null && (
          <span>{t('worker_profile.years_experience', { years: applicant.years_experience })}</span>
        )}
        <span>{t('applicants.applied')}: {new Date(applicant.applied_at).toLocaleDateString()}</span>
      </div>

      {messageError && <p className="text-xs text-error">{messageError}</p>}

      <div className="mt-1 flex flex-wrap gap-2">
        <Link
          href={`/employer/workers/${applicant.worker_id}?job_id=${jobId}`}
          className="self-start rounded-lg bg-blue-900 px-3 py-1.5 text-xs text-white"
        >
          {t('applicants.view_profile')}
        </Link>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleMessageWorker}
          loading={startingConversation}
          loadingLabel={tMessages('starting')}
        >
          {tMessages('message_worker')}
        </Button>
      </div>
    </Card>
  );
}

function buildCandidateMatchMap(candidates: Array<{
  application_id?: string | null;
  worker_id: string;
  match_score: number;
  score_band: ScoreBand;
  match_reasons?: string[];
}>): Map<string, ApplicantMatch> {
  const matches = new Map<string, ApplicantMatch>();

  for (const candidate of candidates) {
    const score = normalizeMatchScore(candidate.match_score);
    if (score === null) continue;

    const match: ApplicantMatch = {
      match_score: score,
      score_band: normalizeScoreBand(candidate.score_band, score),
      match_reasons: (candidate.match_reasons ?? [])
        .filter((reason): reason is string => typeof reason === 'string' && reason.trim().length > 0)
        .slice(0, 3)
        .map((reason) => truncateMatchReason(reason)),
    };

    if (candidate.application_id) matches.set(candidate.application_id, match);
    matches.set(candidate.worker_id, match);
  }

  return matches;
}
