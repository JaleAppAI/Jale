'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useRouter } from '@/i18n/navigation';
import { LegalWallError } from '@/lib/api';
import { Link } from '@/i18n/navigation';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { MatchReasonChips, MatchScoreBadge } from '@/components/ui/match-signals';
import { ApplicantFilterPanel } from '@/components/employer/ApplicantFilterPanel';
import { getJob, getJobApplicants, getJobCandidates, startConversation, updateJobStatus } from '@/lib/api/employer';
import type { EmployerJobDetail, Applicant, ApplicantFilters } from '@/lib/api/employer';
import type { ScoreBand } from '@/lib/match';
import { normalizeMatchScore, normalizeScoreBand, truncateMatchReason } from '@/lib/match';
import { applicationStatusTone, jobStatusTone } from '@/lib/status';
import type { WritableJobStatus } from '@/lib/status';

export const dynamic = 'force-dynamic';

type ApplicantMatch = {
  match_score: number;
  score_band: ScoreBand;
  match_reasons: string[];
};

export default function JobDetailPage() {
  const { id } = useParams<{ id: string; locale: string }>();
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');
  const tMatch = useTranslations('match');

  const [job, setJob] = useState<EmployerJobDetail | null>(null);
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [candidateMatches, setCandidateMatches] = useState<Map<string, ApplicantMatch>>(new Map());
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<ApplicantFilters>({});
  const [loadingJob, setLoadingJob] = useState(true);
  const [loadingApplicants, setLoadingApplicants] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);
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
      <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center">
        <p className="text-sm text-error">{error}</p>
      </main>
    );
  }

  const pendingCount = applicants.filter((a) => a.status === 'pending').length;
  const hiredCount = applicants.filter((a) => a.status === 'hired').length;
  const openCount = job ? job.open_count ?? Math.max(0, job.number_of_workers_needed - job.hired_count) : 0;
  const docLabels: Record<string, string> = {
    resume: t('worker_profile.doc_resume'),
    driver_license: t('worker_profile.doc_driver_license'),
    ssn: t('worker_profile.doc_ssn'),
  };
  const jobTypeLabels: Record<string, string> = {
    'full-time': t('modal.job_type_fulltime'),
    'part-time': t('modal.job_type_parttime'),
    contract: t('modal.job_type_contract'),
  };
  const jobStatus = job ? jobStatusTone(job.status) : null;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <Link href="/employer/dashboard" className="text-sm text-muted-foreground hover:text-foreground mb-6 inline-block">
        {t('jobs.back_to_dashboard')}
      </Link>

      {loadingJob ? (
        <p className="text-sm text-muted">{tCommon('loading')}</p>
      ) : job ? (
        <>
          <Card className="p-6 mb-6">
            <div className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted mb-2">{t('jobs.posting_details')}</p>
                  <h1 className="text-2xl font-bold">{job.title}</h1>
                  <p className="text-sm text-muted-foreground mt-1">{job.location}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{ background: jobStatus?.bg, color: jobStatus?.color }}
                  >
                    {t(`jobs.status.${job.status}`)}
                  </span>
                  {job.status === 'active' && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => handleSetJobStatus('paused')} loading={togglingStatus} loadingLabel={tCommon('loading')}>
                        {t('jobs.toggle.pause')}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => handleSetJobStatus('closed')} disabled={togglingStatus}>
                        {t('jobs.toggle.close')}
                      </Button>
                    </>
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
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <DetailField label={t('modal.job_title')} value={job.title} />
                <DetailField label={t('modal.location')} value={job.location} />
                <DetailField label={t('modal.job_type')} value={jobTypeLabels[job.job_type] ?? job.job_type} />
                <DetailField label={t('modal.trade_category')} value={job.trade_category ? t(`modal.trade.${job.trade_category}`) : t('jobs.not_specified')} />
                <DetailField label={t('jobs.pay_range')} value={job.pay ?? t('jobs.not_specified')} />
                <DetailField label={t('modal.start_date')} value={job.start_date ?? t('jobs.not_specified')} />
                <DetailField label={t('modal.expected_duration')} value={job.expected_duration ?? t('jobs.not_specified')} />
                <DetailField label={t('modal.shift_schedule')} value={job.shift_schedule ?? t('jobs.not_specified')} />
                <DetailField label={t('modal.transportation_required')} value={job.transportation_required ? t('jobs.yes') : t('jobs.no')} />
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

          <div className="grid grid-cols-3 gap-4 mb-6">
            <Card className="p-3 text-center">
              <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('stats.total_applicants')}</p>
              <p className="text-xl font-bold">{total}</p>
            </Card>
            <Card className="p-3 text-center">
              <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('applicants.status.pending')}</p>
              <p className="text-xl font-bold">{pendingCount}</p>
            </Card>
            <Card className="p-3 text-center">
              <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('applicants.status.hired')}</p>
              <p className="text-xl font-bold">{hiredCount}</p>
            </Card>
          </div>

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
                  t={t}
                  tMatch={tMatch}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted">{tCommon('error')}</p>
      )}
    </main>
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
  t,
  tMatch,
}: {
  applicant: Applicant;
  match?: ApplicantMatch;
  jobId: string;
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
        initial_message: tMessages('default_initial_message'),
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
          <span>{applicant.years_experience}y exp</span>
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
