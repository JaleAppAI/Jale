'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { usePageData } from '@/hooks/usePageData';
import { useStaggerOnce } from '@/hooks/useStaggerOnce';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { CityMultiSelect } from '@/components/ui/CityMultiSelect';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Input } from '@/components/ui/input';
import { ListPageSkeleton } from '@/components/ui/page-skeletons';
import { Spinner } from '@/components/ui/spinner';
import { WorkerJobCard } from '@/components/worker/WorkerJobCard';
import { apiFetch } from '@/lib/api';
import { getApplications, type Application } from '@/lib/api/worker';
import {
  DetailsRequestedBanner,
  DetailsRequestedMultiBanner,
} from '@/components/worker/DetailsRequestedBanner';
import { getJobs, updateWorkerProfile } from '@/lib/api/worker';
import type { Job, PreferredCity } from '@/lib/api/worker';

export const dynamic = 'force-dynamic';

type TypeFilter = 'all' | 'full-time' | 'part-time' | 'contract';

/** What one `GET /worker/jobs` answer means to this page. */
type JobFeed = {
  jobs: Job[];
  /** Recent jobs outside the worker's preferred cities. Only sent when the
   *  in-city list came back short, so an absent key is normal, not an error. */
  otherJobs: Job[];
};

// Chip labels come from the worker_home.filter.* message keys.
const FILTER_CHIPS: { value: TypeFilter; labelKey: 'all' | 'full_time' | 'part_time' | 'contract' }[] = [
  { value: 'all',       labelKey: 'all' },
  { value: 'full-time', labelKey: 'full_time' },
  { value: 'part-time', labelKey: 'part_time' },
  { value: 'contract',  labelKey: 'contract' },
];

/** Small caps rule between list sections. Doubles as the divider above the
 *  first row, which is why the rows below it use `divide-y` and no top border. */
function SectionHeader({
  label,
  topRule = false,
  children,
}: {
  label: string;
  topRule?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={[
        'flex items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-4 py-3 md:px-5',
        topRule ? 'border-t' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <p className="min-w-0 text-[11px] font-bold uppercase tracking-wider tabular-nums text-[var(--jale-ink-2)]">
        {label}
      </p>
      {children}
    </div>
  );
}

/**
 * One divided-row list, cascading on its first arrival only.
 *
 * The gate lives HERE rather than on the page because this page renders two of
 * these lists side by side, and they arrive with independent cascades: a single
 * page-level flag closes both the moment either one is done, which pulls the
 * class off whichever list is still mid-cascade and snaps its remaining rows to
 * fully visible. Per-list state is also what makes a filtered refetch cheap to
 * reason about — new rows drop straight in, no matter which list they land in.
 */
function JobRows({ jobs }: { jobs: Job[] }) {
  const { staggerClass, onCascadeEnd } = useStaggerOnce();
  return (
    <ul
      className={['divide-y divide-[var(--jale-divider)]', staggerClass].filter(Boolean).join(' ')}
      onAnimationEnd={onCascadeEnd}
    >
      {jobs.map((job) => (
        <li key={job.id}>
          <WorkerJobCard job={job} href={`/worker/jobs/${job.id}`} />
        </li>
      ))}
    </ul>
  );
}

export default function WorkerHomePage() {
  const { idToken } = useAuth();
  const t = useTranslations('worker_home');
  const tCommon = useTranslations('common');
  const errorMessage = useErrorMessage();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [jobType, setJobType] = useState<TypeFilter>('all');
  const [preferredCities, setPreferredCities] = useState<PreferredCity[]>([]);
  const [editingCities, setEditingCities] = useState(false);
  const [savingCities, setSavingCities] = useState(false);
  const [cityVersion, setCityVersion] = useState(0);
  const [saveCitiesError, setSaveCitiesError] = useState<string | null>(null);
  const [refreshNoticeDismissed, setRefreshNoticeDismissed] = useState(false);
  // Last list we know the server has. `preferredCities` is the draft the panel
  // edits in place; closing the panel without saving restores from here.
  const savedCitiesRef = useRef<PreferredCity[]>([]);
  // Set once a PATCH has landed, so a slow mount-time profile GET can't
  // resolve afterwards and clobber the list the user just saved.
  const savedOnceRef = useRef(false);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 300);

    return () => window.clearTimeout(handle);
  }, [search]);

  /**
   * Applications waiting on the worker, fetched BEST-EFFORT alongside the
   * profile.
   *
   * Deliberately not part of `usePageData`: this page's data is the job feed,
   * and a failed applications call must never take the feed's phase with it.
   * A worker who cannot see the banner still gets it on WhatsApp and on the
   * applications list, so an empty array on failure is an honest degradation
   * rather than a lost message.
   */
  const [needingDetails, setNeedingDetails] = useState<Application[]>([]);
  useEffect(() => {
    if (!idToken) return;
    const controller = new AbortController();
    getApplications(idToken, controller.signal)
      // `details_status`, not `status`: the timestamp-derived field is the one
      // that survives an employer moving the applicant on to `talking`.
      .then(({ applications }) => setNeedingDetails(
        applications.filter((a) => a.details_status === 'requested'),
      ))
      .catch(() => {});
    return () => controller.abort();
  }, [idToken]);

  useEffect(() => {
    if (!idToken) return;
    let ignore = false;
    apiFetch('/worker/profile', {}, idToken)
      .then((res) => (res.ok ? res.json() : null))
      .then((profile) => {
        if (ignore || savedOnceRef.current) return;
        if (profile?.preferred_cities) {
          savedCitiesRef.current = profile.preferred_cities;
          setPreferredCities(profile.preferred_cities);
        }
      })
      .catch(() => {});
    return () => { ignore = true; };
  }, [idToken]);

  /**
   * Everything that changes WHICH jobs the server should return. Compared as a
   * string so an unrelated re-render (the cities GET resolving, a keystroke
   * inside the debounce window) cannot look like a filter change.
   */
  const filterKey = JSON.stringify([debouncedSearch, jobType, cityVersion]);
  /** The `filterKey` the data on screen was actually fetched with. */
  const loadedFilterKeyRef = useRef<string | null>(null);

  const {
    phase,
    data: feed,
    empty,
    errorKind,
    refreshing,
    refreshError,
    retry,
    refresh,
  } = usePageData<JobFeed>({
    legalReturnUrl: '/worker/home',
    // Both lists empty is the only honest definition of "nothing to show":
    // in-city can be empty while the out-of-city teaser still has rows.
    isEmpty: (data) => data.jobs.length === 0 && data.otherJobs.length === 0,
    fetcher: async ({ token, signal }) => {
      // Recorded at request start, from the closure the hook is calling RIGHT
      // NOW (it reads `fetcher` through a ref), so it always names the filters
      // this response belongs to.
      loadedFilterKeyRef.current = filterKey;
      const filters: { search?: string; job_type?: string } = {};
      if (debouncedSearch) filters.search = debouncedSearch;
      if (jobType !== 'all') filters.job_type = jobType;
      // Forwarding the signal cancels a superseded feed request outright --
      // typing in the search box no longer leaves a trail of requests running
      // to completion. `usePageData` still fences responses by request id, so
      // an answer that races the abort cannot land either.
      const res = await getJobs(token, filters, signal);
      return { jobs: res.jobs ?? [], otherJobs: res.other_jobs ?? [] };
    },
  });

  /**
   * Filter changes are a REFRESH, never a reload.
   *
   * Passing the filters as `usePageData` deps would work, but a deps change
   * resets to a skeleton and a failure from there lands on 'error' with `data`
   * nulled — i.e. one flaky request while the user narrows a search would wipe
   * the feed they were reading. The refresh path is structurally incapable of
   * that: it can only add newer data or a `refreshError` footnote.
   *
   * Firing only from 'ready' is not a limitation: `refresh()` no-ops anywhere
   * else, so this effect re-checks on every phase change and catches filters
   * that moved while the first load was still in flight.
   */
  useEffect(() => {
    if (phase !== 'ready') return;
    if (loadedFilterKeyRef.current === filterKey) return;
    void refresh();
  }, [phase, filterKey, refresh]);

  // A new attempt earns a new chance to complain: un-dismiss whenever one starts.
  useEffect(() => {
    if (refreshing) setRefreshNoticeDismissed(false);
  }, [refreshing]);

  async function saveCities() {
    if (!idToken) return;
    setSavingCities(true);
    setSaveCitiesError(null);
    try {
      const updated = await updateWorkerProfile(idToken, { preferred_cities: preferredCities });
      // Trust the server's echo of the saved list over our local draft.
      const saved = updated?.preferred_cities ?? preferredCities;
      savedOnceRef.current = true;
      savedCitiesRef.current = saved;
      setPreferredCities(saved);
      setEditingCities(false);
      setCityVersion((v) => v + 1); // refetch the feed with the new filter
    } catch (err) {
      // Keep the panel open with the draft intact so the user can retry.
      setSaveCitiesError(errorMessage(err));
    } finally {
      setSavingCities(false);
    }
  }

  // Opening starts a fresh draft from the saved list; closing without saving
  // throws the draft away so the chips never show unpersisted cities.
  function toggleEditCities() {
    // Never let a cancel race an in-flight PATCH: reverting mid-save would
    // show the old chips while the server filters by the new list.
    if (savingCities) return;
    setSaveCitiesError(null);
    if (editingCities) {
      setPreferredCities(savedCitiesRef.current);
      setEditingCities(false);
    } else {
      setEditingCities(true);
    }
  }

  /**
   * Resets BOTH filter inputs. `debouncedSearch` is cleared alongside the raw
   * box so the refetch starts immediately instead of 300ms later — the button
   * has to feel like it did something.
   */
  const clearFilters = useCallback(() => {
    setSearch('');
    setDebouncedSearch('');
    setJobType('all');
  }, []);

  const filtersActive = debouncedSearch !== '' || jobType !== 'all' || search.trim() !== '';

  // 'auth' means the token gate has not opened yet: nothing has been asked for,
  // so the list owes the reader a skeleton rather than an empty container.
  const showSkeleton = phase === 'auth' || phase === 'loading';
  const jobs = feed?.jobs ?? [];
  const otherJobs = feed?.otherJobs ?? [];
  const showRefreshNotice = refreshError !== null && !refreshNoticeDismissed;

  return (
    <AppShell role="worker" title={t('title')}>
      <main className="mx-auto max-w-2xl px-4 py-6 md:px-6">
        {/* Above the search box, per the prototype's W3b: an employer waiting
            on this worker outranks browsing for another job. */}
        {needingDetails.length === 1 ? (
          <div className="mb-4">
            <DetailsRequestedBanner
              applicationId={needingDetails[0].application_id}
              companyName={needingDetails[0].company_name}
              remainingCount={needingDetails[0].remaining_count}
            />
          </div>
        ) : needingDetails.length > 1 ? (
          <div className="mb-4">
            <DetailsRequestedMultiBanner count={needingDetails.length} />
          </div>
        ) : null}

        {/* Controls render immediately and stay live through every phase — a
            worker can retype a search while the first request is still out. */}
        <div className="relative mb-3">
          <span
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--jale-ink-2)]"
          >
            <Icon name="search" />
          </span>
          <Input
            type="search"
            className="pl-11"
            aria-label={t('search_placeholder')}
            placeholder={t('search_placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Preferred cities */}
        <div className="mb-3 flex items-center gap-2 overflow-x-auto pb-1">
          {preferredCities.length === 0 ? (
            <span className="whitespace-nowrap rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] px-3.5 py-1.5 text-xs font-semibold text-[var(--jale-ink-2)]">
              {t('cities_all')}
            </span>
          ) : (
            preferredCities.map((c) => (
              <span
                key={c.city_key}
                className="whitespace-nowrap rounded-full bg-[var(--jale-blue-500)] px-3.5 py-1.5 text-xs font-semibold text-white"
              >
                {c.city}, {c.state}
              </span>
            ))
          )}
          <button
            type="button"
            onClick={toggleEditCities}
            disabled={savingCities}
            aria-expanded={editingCities}
            className="cursor-pointer whitespace-nowrap rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] px-3.5 py-1.5 text-xs font-semibold text-[var(--jale-ink-2)] transition-colors hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('cities_edit')}
          </button>
        </div>
        {editingCities && (
          <div className="mb-4 space-y-3 rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-card)] p-3">
            {/* keyed so a save (or a cancel-then-reopen) remounts the field and
                drops any typed-but-unpicked text — see CityMultiSelect docs */}
            <CityMultiSelect key={cityVersion} value={preferredCities} onChange={setPreferredCities} />
            <div className="flex items-center justify-end gap-3">
              {saveCitiesError && (
                <p role="alert" className="text-xs font-medium text-[var(--jale-danger)]">
                  {saveCitiesError}
                </p>
              )}
              <Button onClick={saveCities} loading={savingCities} loadingLabel={tCommon('loading')}>
                {t('cities_done')}
              </Button>
            </div>
          </div>
        )}

        {/* Filter chips */}
        <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
          {FILTER_CHIPS.map((chip) => {
            const active = jobType === chip.value;
            return (
              <button
                key={chip.value}
                type="button"
                aria-pressed={active}
                onClick={() => setJobType(chip.value)}
                className={[
                  'cursor-pointer whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                  active
                    ? 'border-transparent bg-[var(--jale-blue-500)] text-white'
                    : 'border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink-2)] hover:bg-[var(--jale-paper-2)]',
                ].join(' ')}
              >
                {t(`filter.${chip.labelKey}`)}
              </button>
            );
          })}
        </div>

        {/* Results */}
        {showSkeleton ? (
          /* Same archetype as `loading.tsx`, minus its `withSearch` block: the
             real search field is already on screen above, so drawing its
             skeleton too would show the control twice. */
          <ListPageSkeleton />
        ) : (
          <div className="anim-fade-in">
            {/* S6 — a filter refetch failed. The list below is the last known
                good one and stays put; this is a footnote, not a page state. */}
            {showRefreshNotice ? (
              <InlineFeedback
                tone="warning"
                onDismiss={() => setRefreshNoticeDismissed(true)}
                className="mb-3"
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{tCommon('feedback.refresh_failed')}</span>
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    className="cursor-pointer font-bold underline underline-offset-2 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                  >
                    {tCommon('retry')}
                  </button>
                </span>
              </InlineFeedback>
            ) : null}

            {phase === 'error' && errorKind ? (
              <DashboardPanel>
                <ErrorState kind={errorKind} onRetry={retry} />
              </DashboardPanel>
            ) : empty ? (
              <DashboardPanel>
                {filtersActive ? (
                  <EmptyState
                    variant="filtered"
                    title={t('empty_filtered.title')}
                    body={t('empty_filtered.body')}
                    action={{ label: tCommon('empty_state.clear_filters'), onClick: clearFilters }}
                  />
                ) : (
                  /* No CTA on purpose: a worker cannot post a job, so any
                     button here would be a dead end dressed as an action. */
                  <EmptyState title={t('empty.title')} body={t('empty.body')} />
                )}
              </DashboardPanel>
            ) : (
              <DashboardPanel className="overflow-hidden">
                {jobs.length > 0 ? (
                  <>
                    <SectionHeader label={t('results_count', { count: jobs.length })}>
                      {refreshing ? <Spinner size="sm" className="text-[var(--jale-ink-2)]" /> : null}
                    </SectionHeader>
                    <JobRows jobs={jobs} />
                  </>
                ) : (
                  /* In-city list is empty but the out-of-city teaser is not:
                     say so, rather than letting the next header imply it. */
                  <SectionHeader label={t('no_city_jobs')} />
                )}

                {otherJobs.length > 0 && (
                  <>
                    <SectionHeader label={t('other_jobs_header')} topRule={jobs.length > 0} />
                    <JobRows jobs={otherJobs} />
                  </>
                )}
              </DashboardPanel>
            )}
          </div>
        )}
      </main>
    </AppShell>
  );
}
