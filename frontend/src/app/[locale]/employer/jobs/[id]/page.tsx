'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { Link } from '@/i18n/navigation';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ApplicantFilterPanel } from '@/components/employer/ApplicantFilterPanel';
import { getJob, getJobApplicants, updateJobStatus } from '@/lib/api/employer';
import type { EmployerJobDetail, Applicant, ApplicantFilters } from '@/lib/api/employer';
import { applicationStatusTone, jobStatusTone } from '@/lib/status';
import type { WritableJobStatus } from '@/lib/status';

export const dynamic = 'force-dynamic';

export default function JobDetailPage() {
  const { id } = useParams<{ id: string; locale: string }>();
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('employer_dashboard');
  const tCommon = useTranslations('common');

  const [job, setJob] = useState<EmployerJobDetail | null>(null);
  const [applicants, setApplicants] = useState<Applicant[]>([]);
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
    setLoadingApplicants(true);
    getJobApplicants(idToken, id, filters)
      .then((res) => {
        setApplicants(res.applicants);
        setTotal(res.total);
      })
      .catch((err) => {
        try {
          handleLegalWall(err, `/employer/jobs/${id}`);
        } catch {
          setError(tCommon('error'));
        }
      })
      .finally(() => setLoadingApplicants(false));
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
                <Card key={applicant.application_id} className="p-4 flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-base font-semibold">{applicant.full_name}</p>
                    <span
                      className="rounded-full px-2 py-0.5 text-xs font-medium shrink-0"
                      style={{
                        background: applicationStatusTone(applicant.status).bg,
                        color: applicationStatusTone(applicant.status).color,
                      }}
                    >
                      {t(`applicants.status.${applicant.status}`)}
                    </span>
                  </div>

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

                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    {applicant.availability && (
                      <span>{t(`filter.availability_${applicant.availability.replace('-', '')}`)}</span>
                    )}
                    {applicant.years_experience !== null && (
                      <span>{applicant.years_experience}y exp</span>
                    )}
                    <span>{t('applicants.applied')}: {new Date(applicant.applied_at).toLocaleDateString()}</span>
                  </div>

                  <Link
                    href={`/employer/workers/${applicant.worker_id}?job_id=${job.id}`}
                    className="self-start mt-1 text-xs bg-blue-900 text-white px-3 py-1.5 rounded-lg"
                  >
                    {t('applicants.view_profile')}
                  </Link>
                </Card>
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
