'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { usePageData } from '@/hooks/usePageData';
import { useJobCreated } from '@/contexts/PostJobContext';
import { useUnreadMessages } from '@/contexts/UnreadMessagesContext';
import { applicantsTutorialDone } from '@/lib/employer-tutorial-done';
import { useTutorial } from '@/lib/tutorials/use-tutorial';
import { AppShell } from '@/components/layout/AppShell';
import { HireDetailsNeededBanner } from '@/components/employer/HireDetailsNeededBanner';
import { PostJobButton } from '@/components/employer/PostJobButton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Skeleton } from '@/components/ui/skeleton';
import { getApplicantsOverview } from '@/lib/api/employer';
import type { ApplicantsOverviewResponse } from '@/lib/api/employer';
import type { HireDetails } from '@/lib/api/worker';
import { hasHireDetails } from '@/lib/hire-details';
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

  // A job posted from anywhere in the app can be applied to immediately, and
  // this list is also where the new job's own filter chip comes from.
  useJobCreated(() => page.refresh());

  const applicants = page.data?.applicants ?? [];
  const jobs = page.data?.jobs ?? [];
  const { setData } = page;
  // K4.4: hired applicants whose start details are still empty.
  const hiresNeedingDetails = applicants.filter((a) => a.hire_details_needed === true).length;
  // A save in a row patches that row here too, so the banner count drops at once.
  const markHireDetailsSaved = useCallback((applicationId: string, details: HireDetails | null) => {
    setData((prev) => ({
      ...prev,
      applicants: prev.applicants.map((a) => (
        a.application_id === applicationId
          ? { ...a, hire_details: details, hire_details_needed: !hasHireDetails(details) }
          : a
      )),
    }));
  }, [setData]);
  const visible = jobFilter
    ? applicants.filter((a) => a.job_id === jobFilter)
    : applicants;

  /*
   * The applicants guide (E3's walkthrough) also starts here, on the page
   * view: asked once, when the list has applicants, for an employer who has
   * not yet moved anyone past applied (K1.5), as on the job page and the
   * applicant profile. This board is where Hired and start details happen.
   */
  const inbox = useUnreadMessages();
  const applicantsDone = applicantsTutorialDone(
    page.phase === 'ready' && page.data ? page.data.applicants.map((row) => row.application_status) : null,
    inbox,
  );
  const applicantsTutorial = useTutorial('employer_applicants', { done: applicantsDone, walkthrough: true });
  const applicantsAskedRef = useRef(false);
  const hasApplicants = applicants.length > 0;
  useEffect(() => {
    if (applicantsAskedRef.current || applicantsDone === undefined || !hasApplicants) return;
    applicantsAskedRef.current = true;
    applicantsTutorial.maybeAutoOpen();
  }, [applicantsDone, applicantsTutorial, hasApplicants]);

  return (
    <AppShell role="employer" title={t('title')} actions={<PostJobButton />}>
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
            {hiresNeedingDetails > 0 ? (
              <div data-guide="apps.hire_banner">
                <HireDetailsNeededBanner count={hiresNeedingDetails} />
              </div>
            ) : null}
            {jobs.length > 1 ? (
              <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1" data-guide="apps.board_jobs">
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

            <div data-guide="apps.board" className="divide-y divide-[var(--jale-divider)] rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-card)]">
              {visible.map((item) => (
                <ApplicantOverviewRow key={item.application_id} item={item} onHireDetailsSaved={markHireDetailsSaved} />
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
