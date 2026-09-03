'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { usePageData } from '@/hooks/usePageData';
import { AppShell } from '@/components/layout/AppShell';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Skeleton } from '@/components/ui/skeleton';
import { getApplicantsOverview } from '@/lib/api/employer';
import type { ApplicantsOverviewResponse } from '@/lib/api/employer';
import { ApplicantOverviewRow } from './ApplicantOverviewRow';

export const dynamic = 'force-dynamic';

const RETURN_URL = '/employer/applicants';

export default function EmployerApplicantsPage() {
  const t = useTranslations('employer_applicants');
  const tCommon = useTranslations('common');
  const [jobFilter, setJobFilter] = useState<string | null>(null);

  const page = usePageData<ApplicantsOverviewResponse>({
    fetcher: ({ token, signal }) => getApplicantsOverview(token, signal),
    legalReturnUrl: RETURN_URL,
    isEmpty: (data) => data.applicants.length === 0,
  });

  const applicants = page.data?.applicants ?? [];
  const jobs = page.data?.jobs ?? [];
  const visible = jobFilter
    ? applicants.filter((a) => a.job_id === jobFilter)
    : applicants;

  return (
    <AppShell role="employer" title={t('title')}>
      <main className="mx-auto max-w-4xl px-4 py-6 md:px-6">
        <p className="mb-4 text-sm font-semibold text-[var(--jale-ink-2)]">{t('subtitle')}</p>

        {page.refreshError ? (
          <InlineFeedback tone="warning" className="mb-4">
            {tCommon('feedback.refresh_failed')}
          </InlineFeedback>
        ) : null}

        {page.phase !== 'ready' && page.phase !== 'error' ? (
          <div className="space-y-3" role="status" aria-label={tCommon('loading')}>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-[var(--radius-input)]" />
            ))}
          </div>
        ) : page.phase === 'error' && page.errorKind ? (
          <ErrorState kind={page.errorKind} onRetry={page.retry} />
        ) : page.empty ? (
          <EmptyState icon="user" title={t('empty_title')} body={t('empty_body')} />
        ) : (
          <>
            {jobs.length > 1 ? (
              <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
                <JobChip active={jobFilter === null} onClick={() => setJobFilter(null)}>
                  {t('all_jobs')}
                </JobChip>
                {jobs.map((job) => (
                  <JobChip
                    key={job.job_id}
                    active={jobFilter === job.job_id}
                    onClick={() => setJobFilter((cur) => (cur === job.job_id ? null : job.job_id))}
                  >
                    {job.city ? `${job.title} · ${job.city}` : job.title}
                  </JobChip>
                ))}
              </div>
            ) : null}

            <div className="divide-y divide-[var(--jale-divider)] rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-card)]">
              {visible.map((item) => (
                <ApplicantOverviewRow key={item.application_id} item={item} />
              ))}
            </div>
          </>
        )}
      </main>
    </AppShell>
  );
}

// Classes copied verbatim from the conversations page's `FilterChip`
// (`employer/conversations/page.tsx`) so job chips read as the same control
// on both pages instead of two subtly different pill styles.
function JobChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'max-w-[160px] shrink-0 cursor-pointer truncate rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
        'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
        active
          ? 'border-[var(--jale-blue-700)] bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
          : 'border-[var(--jale-divider)] text-[var(--jale-ink-2)] hover:bg-[var(--jale-paper-2)]',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
