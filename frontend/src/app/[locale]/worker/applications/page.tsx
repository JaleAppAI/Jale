'use client';
import { useCallback, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { usePageData } from '@/hooks/usePageData';
import { useStaggerOnce } from '@/hooks/useStaggerOnce';
import { Link } from '@/i18n/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { MetricCard } from '@/components/ui/metric-card';
import { ListPageSkeleton } from '@/components/ui/page-skeletons';
import { PanelHeader } from '@/components/ui/panel-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ApplicationStatusChip } from '@/components/worker/ApplicationStatusChip';
import {
  DetailsRequestedBanner,
  DetailsRequestedMultiBanner,
} from '@/components/worker/DetailsRequestedBanner';
import { HiredBanner } from '@/components/worker/HiredBanner';
import { JobStatusBadge } from '@/components/ui/badge';
import { acknowledgeHire, getApplications } from '@/lib/api/worker';
import { orderApplicationsForList } from '@/lib/application-list-order';
import { formatLongDate, formatStartDateWeekdayShort } from '@/lib/date';
import { formatPay } from '@/lib/pay';
import type { Application } from '@/lib/api/worker';
import { normalizeApplicationStatus, TERMINAL_APPLICATION_STATUSES } from '@/lib/status';
import { visibleJobStatusBadge } from '@/lib/jobStatusDisplay';

export const dynamic = 'force-dynamic';

/**
 * Rows per request.
 *
 * The server used to answer this list with a hard `LIMIT 200`: a worker past
 * that number could not reach their older applications at all, and everyone
 * else paid for two hundred rows -- and their engine columns -- on every load.
 * 50 is the server's own default; the rest arrives on demand, appended.
 */
const PAGE_SIZE = 50;

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
  const tCommon = useTranslations('common');
  const tPay = useTranslations('pay');
  const locale = useLocale();
  const { idToken } = useAuth();
  const errorMessage = useErrorMessage();

  /**
   * Where the NEXT page starts, as the last response gave it; null once the
   * list is complete. Page state rather than part of `usePageData`'s data,
   * because it describes the request rather than anything on screen -- and
   * because `retry()` re-runs the fetcher below, which seeds it afresh.
   */
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** A failed NEXT page. Never the page's phase: the rows already read are
   *  real, and this is a footnote under them. */
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const {
    phase,
    data: apps,
    empty,
    errorKind,
    retry,
    setData,
  } = usePageData<Application[]>({
    legalReturnUrl: '/worker/applications',
    isEmpty: (data) => data.length === 0,
    fetcher: async ({ token, signal }) => {
      const page = await getApplications(token, signal, { limit: PAGE_SIZE });
      setCursor(page.next_cursor);
      setLoadMoreError(null);
      return page.applications;
    },
  });

  /**
   * The next page, APPENDED.
   *
   * Never a reload: the rows the worker has already scrolled through must not
   * be replaced or reordered under them, and a failure here must leave the
   * list exactly as it was. Ids already on screen are filtered out as a
   * belt-and-braces guard -- the keyset cursor cannot repeat a row, but a
   * duplicate would break React's keys, which is a worse failure than the
   * one-line check that prevents it.
   */
  const loadMore = useCallback(async () => {
    if (!idToken || !cursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await getApplications(idToken, undefined, { limit: PAGE_SIZE, cursor });
      setData((prev) => {
        const seen = new Set(prev.map((a) => a.application_id));
        return [...prev, ...page.applications.filter((a) => !seen.has(a.application_id))];
      });
      setCursor(page.next_cursor);
    } catch (err) {
      setLoadMoreError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }, [idToken, cursor, loadingMore, setData, errorMessage]);

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

  // Rows waiting on the WORKER. Read off `details_status` -- the TIMESTAMP-
  // derived field -- never off `status`, so an employer who moved a
  // details_requested applicant along to `talking` does not make the row stop
  // asking for the details it is still waiting on (B4.0 #7).
  const needingDetails = list.filter((a) => a.details_status === 'requested');

  /** A count over a list that is not all in yet: "50+", not "50". */
  const partial = (count: number) => (cursor ? `${count}+` : count);

  // ...and the same rows are lifted to the top of the list itself, so the one
  // application that needs the worker's hands is never buried under newer ones
  // they have nothing to do about. Counts above read `list`: the arithmetic is
  // order-independent, and re-deriving them from a sorted copy would only add
  // a way for the two to disagree.
  const ordered = orderApplicationsForList(list);

  /**
   * Dismisses the hire banner on ONE row.
   *
   * The optimistic edit goes through `usePageData`'s `setData` rather than a
   * second piece of page state, so the list stays single-sourced: a later
   * `retry()` refetch replaces the row wholesale and the server's
   * `acknowledged_at` is what keeps the banner gone. A parallel "dismissed
   * ids" set would disagree with that response the moment the two diverged.
   *
   * Fire-and-forget with an explicit `.catch`, the same contract the home page
   * uses -- a worker who pressed × has decided, and the worst case of a lost
   * receipt is one repeated line of congratulations. No `await`: nothing on
   * screen may wait on the network here.
   */
  const dismissHire = useCallback((applicationId: string) => {
    setData((prev) => prev.map((a) => (
      a.application_id === applicationId && a.hire
        ? { ...a, hire: { ...a.hire, acknowledged_at: new Date().toISOString() } }
        : a
    )));
    if (!idToken) return;
    void acknowledgeHire(idToken, applicationId, 'dismissed').catch(() => {});
  }, [idToken, setData]);

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
                {/* Counted off the rows that are LOADED, so while there is
                    another page they are a floor, not a total -- "50" for a
                    worker with eighty-seven applications is a false claim
                    about their account, the same reason the error path hides
                    these cards rather than zeroing them. The '+' is the whole
                    fix: it reads identically in both locales and needs no key. */}
                <div className="mb-5 grid gap-4 sm:grid-cols-3">
                  <MetricCard label={t('stats.total')} value={partial(totalCount)} />
                  <MetricCard label={t('stats.active')} value={partial(activeCount)} tone="teal" />
                  <MetricCard label={t('stats.hired')} value={partial(hiredCount)} tone="green" />
                </div>

                {/* ONE waiting application gets a top notice too, exactly as
                    the home page gives it -- the row's own compact banner is
                    below the metrics and, for an older application, below the
                    fold. The page used to speak up only from two upwards,
                    which made the single case (much the commoner one) the
                    quietest thing on the screen. */}
                {needingDetails.length === 1 ? (
                  <div className="mb-5">
                    <DetailsRequestedBanner
                      applicationId={needingDetails[0].application_id}
                      companyName={needingDetails[0].company_name}
                      remainingCount={needingDetails[0].remaining_count}
                    />
                  </div>
                ) : needingDetails.length > 1 ? (
                  <div className="mb-5">
                    <DetailsRequestedMultiBanner count={needingDetails.length} onList />
                  </div>
                ) : null}

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
                      {ordered.map((a) => {
                        const jobStatusBadge = visibleJobStatusBadge(a.job_status);
                        const needsDetails = a.details_status === 'requested';
                        // `status` is the authority for a hire: a `hire` block
                        // left on a row an employer moved back out of `hired`
                        // must not congratulate anyone.
                        const hire = a.status === 'hired' ? a.hire : undefined;
                        // Date-only value, so the UTC-pinned formatter -- the
                        // instant helper two lines below is for `applied_at`.
                        const hireStartDate = formatStartDateWeekdayShort(hire?.start_date, locale);
                        // The facts survive the banner's dismissal: they are
                        // still true, and the start date is the single thing a
                        // worker comes back to this row to re-read.
                        const hireFacts = hire
                          ? [
                              hireStartDate ? `${t('hired_celebration.modal.start_date')}: ${hireStartDate}` : null,
                              hire.location,
                              // Localized from the structured columns, never
                              // `hire.pay` verbatim -- that column is English
                              // free text and may be the sentinel.
                              formatPay(hire, tPay),
                            ].filter((fact): fact is string => Boolean(fact))
                          : [];
                        return (
                          <li key={a.application_id}>
                            {/* The row keeps pointing at the JOB. The banner
                                below it is the only thing that leads to the
                                details form -- a row whose whole surface
                                silently changed destination would strand a
                                worker who just wanted to re-read the posting. */}
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
                                    <ApplicationStatusChip status={a.status} short />
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
                                {/* What the hire actually is. Inside the link
                                    because it carries no link of its own; the
                                    banner below has one and must stay a
                                    sibling. */}
                                {hireFacts.length > 0 ? (
                                  <p className="mt-1 flex flex-wrap gap-x-3.5 gap-y-1 text-xs font-medium text-[var(--jale-ink-2)]">
                                    {hireFacts.map((fact) => (
                                      <span key={fact}>{fact}</span>
                                    ))}
                                  </p>
                                ) : null}
                              </div>
                            </Link>
                            {/* A SIBLING of the row link, never nested inside
                                it: the banner carries its own link, and an
                                anchor inside an anchor is invalid HTML that
                                browsers resolve by silently dropping one. */}
                            {hire && !hire.acknowledged_at ? (
                              <div className="px-4 pb-4 md:px-5">
                                <HiredBanner
                                  applicationId={a.application_id}
                                  jobTitle={a.job_title}
                                  companyName={a.company_name}
                                  hire={hire}
                                  compact
                                  onDismiss={() => dismissHire(a.application_id)}
                                />
                              </div>
                            ) : null}
                            {needsDetails ? (
                              <div className="px-4 pb-4 md:px-5">
                                <DetailsRequestedBanner
                                  applicationId={a.application_id}
                                  companyName={a.company_name}
                                  remainingCount={a.remaining_count}
                                  compact
                                />
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {cursor ? (
                    <div className="flex flex-col items-center gap-2 border-t border-[var(--jale-divider)] px-4 py-4 md:px-5">
                      {loadMoreError ? (
                        <p role="alert" className="text-xs font-medium text-[var(--jale-danger)]">
                          {loadMoreError}
                        </p>
                      ) : null}
                      <Button
                        variant="ghost"
                        onClick={() => void loadMore()}
                        loading={loadingMore}
                        loadingLabel={tCommon('loading')}
                      >
                        {t('load_more')}
                      </Button>
                    </div>
                  ) : null}
                </DashboardPanel>
              </>
            )}
          </div>
        )}
      </main>
    </AppShell>
  );
}
