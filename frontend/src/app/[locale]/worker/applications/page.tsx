'use client';
import { useLocale, useTranslations } from 'next-intl';
import { usePageData } from '@/hooks/usePageData';
import { useStaggerOnce } from '@/hooks/useStaggerOnce';
import { Link } from '@/i18n/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { MetricCard } from '@/components/ui/metric-card';
import { ListPageSkeleton } from '@/components/ui/page-skeletons';
import { PanelHeader } from '@/components/ui/panel-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ApplicationStatusChip } from '@/components/worker/ApplicationStatusChip';
import { JobStatusBadge } from '@/components/ui/badge';
import { getApplications } from '@/lib/api/worker';
import { formatLongDate } from '@/lib/date';
import type { Application } from '@/lib/api/worker';
import { normalizeApplicationStatus, TERMINAL_APPLICATION_STATUSES } from '@/lib/status';
import { visibleJobStatusBadge } from '@/lib/jobStatusDisplay';

export const dynamic = 'force-dynamic';

/**
 * KPI row placeholder.
 *
 * Traces the minimal `MetricCard` exactly — a 32px figure block over its label
 * — so the swap to real numbers costs no layout shift. It replaces the `'-'`
 * this page used to render in each card: a dash is a VALUE, and three of them
 * says "you have no applications" for as long as the request is in flight,
 * which is precisely the false statement a skeleton exists to avoid.
 *
 * Kept in sync by hand with the same block in `loading.tsx` (a route-level
 * loading file cannot import from a 'use client' page module).
 */
function MetricRowSkeleton() {
  return (
    <div className="mb-5 grid gap-4 sm:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="min-w-0 py-1">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="mt-2 h-2.5 w-24" />
        </div>
      ))}
    </div>
  );
}

export default function WorkerApplicationsPage() {
  const t = useTranslations('worker_applications');
  const locale = useLocale();

  const {
    phase,
    data: apps,
    empty,
    errorKind,
    retry,
  } = usePageData<Application[]>({
    legalReturnUrl: '/worker/applications',
    isEmpty: (data) => data.length === 0,
    fetcher: async ({ token, signal }) => (await getApplications(token, signal)).applications,
  });

  /*
   * The list cascades once, when it first arrives, and never again -- the same
   * gate the other list pages use. This page has no filters and no poll, so
   * today the only thing that could replay the cascade is `retry()` rebuilding
   * the rows after a failure; it is gated for the same reason as everywhere
   * else, and the page stays uniform with the rest if a filter is ever added.
   */
  const { staggerClass, onCascadeEnd } = useStaggerOnce();

  // 'auth' means the token gate has not opened yet: nothing has been asked for,
  // so the page owes the reader a skeleton rather than a screen of zeroes.
  const showSkeleton = phase === 'auth' || phase === 'loading';

  // Derived from the already-fetched list: TERMINAL_APPLICATION_STATUSES is
  // hired / not_interested (legacy values normalize onto them); everything
  // else -- including the new `details_requested` -- is active.
  const list = apps ?? [];
  const normalizedStatuses = list.map((a) => normalizeApplicationStatus(a.status));
  const totalCount = list.length;
  const hiredCount = normalizedStatuses.filter((s) => s === 'hired').length;
  const activeCount = normalizedStatuses.filter((s) => !TERMINAL_APPLICATION_STATUSES.includes(s)).length;

  return (
    <AppShell role="worker" title={t('title')}>
      <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
        {showSkeleton ? (
          <>
            <MetricRowSkeleton />
            <ListPageSkeleton />
          </>
        ) : (
          <div className="anim-fade-in">
            {/* Metrics are hidden rather than zeroed on the error path: "0
                applications" would be a claim about the account, and a failed
                request supports no claim at all. */}
            {phase === 'error' && errorKind ? (
              <DashboardPanel>
                <ErrorState kind={errorKind} onRetry={retry} />
              </DashboardPanel>
            ) : (
              <>
                <div className="mb-5 grid gap-4 sm:grid-cols-3">
                  <MetricCard label={t('stats.total')} value={totalCount} />
                  <MetricCard label={t('stats.active')} value={activeCount} tone="teal" />
                  <MetricCard label={t('stats.hired')} value={hiredCount} tone="green" />
                </div>

                <DashboardPanel className="overflow-hidden">
                  <PanelHeader title={t('title')} />
                  {empty ? (
                    <EmptyState
                      title={t('empty')}
                      body={t('empty_body')}
                      action={{ label: t('empty_cta'), href: '/worker/home' }}
                    />
                  ) : (
                    <ul
                      className={['divide-y divide-[var(--jale-divider)]', staggerClass]
                        .filter(Boolean)
                        .join(' ')}
                      onAnimationEnd={onCascadeEnd}
                    >
                      {list.map((a) => {
                        const jobStatusBadge = visibleJobStatusBadge(a.job_status);
                        return (
                          <li key={a.application_id}>
                            <Link
                              href={`/worker/jobs/${a.job_id}`}
                              className="flex items-start gap-3 px-4 py-4 transition-colors hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] md:px-5"
                            >
                              <InitialsAvatar
                                name={a.company_name ?? ''}
                                size={36}
                                square
                                fallback="JB"
                                className="mt-0.5"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-start justify-between gap-3">
                                  <p className="min-w-0 text-sm font-bold leading-snug text-[var(--jale-ink)]">
                                    {a.job_title}
                                  </p>
                                  <span className="mt-0.5 shrink-0">
                                    <ApplicationStatusChip status={a.status} />
                                  </span>
                                </div>
                                <p className="mt-0.5 text-xs font-medium text-[var(--jale-ink-2)]">
                                  {a.company_name}
                                </p>
                                {jobStatusBadge ? (
                                  <p className="mt-1">
                                    <JobStatusBadge status={jobStatusBadge}>
                                      {t(`job_status.${jobStatusBadge}`)}
                                    </JobStatusBadge>
                                  </p>
                                ) : null}
                                <p className="mt-1 text-xs font-medium tabular-nums text-[var(--jale-ink-2)]">
                                  {t('applied')}: {formatLongDate(a.applied_at, locale) ?? a.applied_at}
                                </p>
                              </div>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </DashboardPanel>
              </>
            )}
          </div>
        )}
      </main>
    </AppShell>
  );
}
