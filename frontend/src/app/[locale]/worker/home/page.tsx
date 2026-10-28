'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkerAttention } from '@/contexts/WorkerAttentionContext';
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
import {
  acknowledgeHire,
  type AttentionDetailsRequest,
  type AttentionHire,
  type HireAckStep,
} from '@/lib/api/worker';
import {
  DetailsRequestedBanner,
  DetailsRequestedMultiBanner,
} from '@/components/worker/DetailsRequestedBanner';
import { HiredBanner } from '@/components/worker/HiredBanner';
import { HiredCelebrationModal } from '@/components/worker/HiredCelebrationModal';
import { getJobs, updateWorkerProfile } from '@/lib/api/worker';
import { markFeedOrigin, opensInThisTab, rememberFeedUrl } from '@/lib/worker-feed-return';
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

/*
 * The feed's filters live in the QUERY STRING, not in component state alone.
 *
 * A worker who narrowed the list, opened a job and came back used to get the
 * unfiltered feed: the page had remounted and every filter was back to its
 * default. The URL is what the page is restored from, and every settled filter
 * change is written back to it -- with `replace`, so narrowing a search does
 * not leave a history entry per keystroke, and with `scroll: false`, so the
 * list does not jump while it is being read.
 */
const SEARCH_PARAM = 'q';
const TYPE_PARAM = 'type';

/** Anything but the four known chips is "no filter" -- the query string is
 *  user-editable and must never forward a value the API has not agreed to. */
function parseTypeFilter(raw: string | null | undefined): TypeFilter {
  return FILTER_CHIPS.some((chip) => chip.value === raw) ? (raw as TypeFilter) : 'all';
}

/** `useSearchParams` returns null outside an App Router (unit tests, and any
 *  non-app render), so every read goes through this. */
function paramValue(params: { get(key: string): string | null } | null | undefined, key: string): string {
  return params?.get(key) ?? '';
}

/**
 * The feed's own URL for a set of filters. An empty query string is omitted
 * ENTIRELY rather than left as a bare '?': that trailing character is not a
 * filter, and it would make every "is this already the URL" comparison — and
 * every shared feed link — wrong.
 */
function feedHrefFor(pathname: string, search: string, jobType: TypeFilter): string {
  const params = new URLSearchParams();
  if (search) params.set(SEARCH_PARAM, search);
  if (jobType !== 'all') params.set(TYPE_PARAM, jobType);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * One unacknowledged hire, exactly as the server's attention summary reports
 * it -- `hire` non-optional, because that summary only ever contains hires.
 *
 * It is a SUMMARY rather than a row for a reason: this page shows no
 * applications, and the hire it has to celebrate may be the worker's 137th,
 * far past any page of the list the old scan could have loaded.
 */
type HireNotice = AttentionHire;

/** True while the focused element takes text: an input, a textarea, or anything contenteditable. */
function isTypingSomewhere(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable;
}

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
        /* The click is recorded on the ROW, so it covers the card's link
           whether it was tapped or opened with Enter: it is what lets the job
           page's back link use history -- and so restore the scroll position
           -- instead of a plain link. Only a click that actually LEAVES this
           tab counts; a ctrl-click opens the job beside it and this page stays
           put, so recording one would describe a navigation that never
           happened -- in this tab AND in the copy of sessionStorage the new
           tab inherits. */
        <li key={job.id} onClick={(event) => { if (opensInThisTab(event)) markFeedOrigin(); }}>
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

  /*
   * Seeded from the URL, ONCE. The filters flow state -> URL from here on:
   * the box must react to a keystroke immediately, which a value routed
   * through a navigation cannot, and nothing else writes this page's query
   * (it is `replace`d, so there is no back/forward within the feed to follow).
   */
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [search, setSearch] = useState(() => paramValue(searchParams, SEARCH_PARAM));
  const [debouncedSearch, setDebouncedSearch] = useState(
    () => paramValue(searchParams, SEARCH_PARAM).trim(),
  );
  const [jobType, setJobType] = useState<TypeFilter>(
    () => parseTypeFilter(paramValue(searchParams, TYPE_PARAM)),
  );
  const [preferredCities, setPreferredCities] = useState<PreferredCity[]>([]);
  const [editingCities, setEditingCities] = useState(false);
  const [savingCities, setSavingCities] = useState(false);
  const [cityVersion, setCityVersion] = useState(0);
  const [saveCitiesError, setSaveCitiesError] = useState<string | null>(null);
  // Typed text in the city box that was never picked, and whether Done was refused for it.
  const [citiesPending, setCitiesPending] = useState(false);
  const [citiesRefused, setCitiesRefused] = useState(false);
  const [refreshNoticeDismissed, setRefreshNoticeDismissed] = useState(false);
  // Last list we know the server has. `preferredCities` is the draft the panel
  // edits in place; closing the panel without saving restores from here.
  const savedCitiesRef = useRef<PreferredCity[]>([]);
  // Set once a PATCH has landed, so a slow mount-time profile GET can't
  // resolve afterwards and clobber the list the user just saved.
  const savedOnceRef = useRef(false);
  // The picker panel, so the empty feed's action can take the worker to it.
  const citiesPanelRef = useRef<HTMLDivElement>(null);
  const focusCitiesRef = useRef(false);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 300);

    return () => window.clearTimeout(handle);
  }, [search]);

  /*
   * The filters, as a URL. Built from the DEBOUNCED search, so the address bar
   * is rewritten when the typing settles rather than on every keystroke; a
   * chip is not debounced and lands immediately.
   */
  const feedHref = feedHrefFor(pathname, debouncedSearch, jobType);
  const currentQuery = searchParams?.toString() ?? '';

  useEffect(() => {
    // Also where the job page reads its way back from -- recorded even when
    // the URL already says this, because a page restored FROM the URL never
    // calls `replace` at all.
    rememberFeedUrl(feedHref);
    if (feedHref === (currentQuery ? `${pathname}?${currentQuery}` : pathname)) return;
    router.replace(feedHref, { scroll: false });
  }, [feedHref, currentQuery, pathname, router]);

  /**
   * What needs the worker -- an employer waiting on their details, a hire --
   * read from the session-wide attention context (F27). The nav badge reads
   * the same answer, so this page no longer asks for it on its own.
   *
   * Best-effort, and never part of the job feed's phase. A FAILED first read
   * gets a footnote: a home page that silently omits the one notice a worker
   * may have opened the app for looks entirely normal, so it must say so.
   */
  const { attention, errorKind: attentionErrorKind, forgetHire } = useWorkerAttention();
  const [needingDetails, setNeedingDetails] = useState<AttentionDetailsRequest[]>([]);
  const [applicationsNoticeDismissed, setApplicationsNoticeDismissed] = useState(false);
  const applicationsFailed = attentionErrorKind !== null;
  /*
   * A dismissal is about one CONFIRMED failure, so only the next confirmed
   * failure re-arms it (null -> a kind). A re-render with the same failure is
   * not a new one. The render-phase adjustment, not an effect: an effect would
   * paint the stale notice once before correcting it.
   */
  const [seenAttentionError, setSeenAttentionError] = useState<typeof attentionErrorKind>(attentionErrorKind);
  if (seenAttentionError !== attentionErrorKind) {
    setSeenAttentionError(attentionErrorKind);
    if (attentionErrorKind !== null) setApplicationsNoticeDismissed(false);
  }
  /**
   * Hires this worker has not finished acknowledging -- the celebration state.
   * Two nullable stamps decide which of three things the worker sees:
   *   `seen_at` null            -> the modal is owed (and the banner sits behind it)
   *   `seen_at` set, ack null   -> the banner alone
   *   `acknowledged_at` set     -> nothing, and the row never reaches here
   * Both stamps live on the SERVER, so a celebration never repeats on the
   * worker's next device.
   */
  const [hires, setHires] = useState<HireNotice[]>([]);
  /**
   * Hires whose modal is skipped THIS visit because they arrived while the
   * worker was typing: a dialog must never yank keystrokes out of the search
   * box. Decided once per hire, the first time it arrives; the banner still
   * shows and `seen_at` stays null, so the modal waits for the next visit.
   */
  const [modalSkipped, setModalSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const modalDecidedRef = useRef<Set<string>>(new Set());
  /**
   * Receipts written this visit. A later summary (the context refreshes) must
   * not resurrect a modal or banner the worker already closed while the
   * fire-and-forget POST was still in flight or was lost.
   */
  const receiptsRef = useRef<Record<string, HireAckStep>>({});
  useEffect(() => {
    if (!attention) return;
    setNeedingDetails(attention.details_requested);
    const receipts = receiptsRef.current;
    const next = attention.unacknowledged_hires.flatMap((notice) => {
      const receipt = receipts[notice.application_id];
      if (receipt === 'dismissed') return [];
      const hire = receipt === 'seen' && notice.hire.seen_at === null
        ? { ...notice.hire, seen_at: new Date().toISOString() }
        : notice.hire;
      return [{ ...notice, hire }];
    });
    setHires(next);
    const typing = isTypingSomewhere();
    const skipped: string[] = [];
    for (const notice of next) {
      if (notice.hire.seen_at !== null || modalDecidedRef.current.has(notice.application_id)) continue;
      modalDecidedRef.current.add(notice.application_id);
      if (typing) skipped.push(notice.application_id);
    }
    if (skipped.length > 0) setModalSkipped((prev) => new Set([...prev, ...skipped]));
  }, [attention]);

  /**
   * Records a step of the hire receipt and forgets about it.
   *
   * Deliberately no `await`, no loading state and no error surface. The caller
   * has already updated the screen optimistically, and the two failure modes
   * are not symmetric: a lost receipt costs one repeated congratulations
   * message, whereas making a worker wait on the network -- or rolling their ×
   * back on a 500 -- argues with them about their own screen. Errors are
   * swallowed exactly like the `getApplications` fetch above.
   *
   * The `.catch` is not decoration: without it a rejected promise is an
   * unhandled rejection that can fail the whole test run.
   */
  const recordHireStep = useCallback((applicationId: string, step: HireAckStep) => {
    receiptsRef.current[applicationId] = step;
    if (!idToken) return;
    void acknowledgeHire(idToken, applicationId, step).catch(() => {});
  }, [idToken]);

  const closeCelebration = useCallback((applicationId: string) => {
    setHires((prev) => prev.map((notice) => (
      notice.application_id === applicationId
        ? { ...notice, hire: { ...notice.hire, seen_at: new Date().toISOString() } }
        : notice
    )));
    recordHireStep(applicationId, 'seen');
  }, [recordHireStep]);

  const dismissHire = useCallback((applicationId: string) => {
    setHires((prev) => prev.filter(
      (notice) => notice.application_id !== applicationId,
    ));
    recordHireStep(applicationId, 'dismissed');
    forgetHire(applicationId);
  }, [forgetHire, recordHireStep]);

  /**
   * The hire currently owed a celebration. Several unacknowledged hires at
   * once is possible and rare; they get a banner each, and the modals CHAIN:
   * closing one reveals the next, each keyed by application so it mounts
   * fresh (its own confetti burst, its own focus entry) instead of swapping
   * content inside the open dialog.
   */
  const celebrating = hires.find(
    (notice) => notice.hire.seen_at === null && !modalSkipped.has(notice.application_id),
  );

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
    // A city typed and never picked is not in the list: refuse Done rather
    // than filter without it, and say why on the box. Focus stays where it
    // is: back in the box, the suggestion list would reopen over Done, and a
    // second tap there would pick a city nobody chose.
    if (citiesPending) {
      setCitiesRefused(true);
      return;
    }
    setCitiesRefused(false);
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
    setCitiesRefused(false);
    if (editingCities) {
      setPreferredCities(savedCitiesRef.current);
      setEditingCities(false);
    } else {
      setEditingCities(true);
    }
  }

  /**
   * The empty feed's action. Only ever OPENS the picker -- `toggleEditCities`
   * would close it on a second press and throw away a half-built list -- and
   * then takes the worker to it, because the picker sits above the list and
   * may be off screen on a phone.
   */
  function openCityPicker() {
    if (savingCities) return;
    focusCitiesRef.current = true;
    if (editingCities) {
      focusCitiesPanel();
      return;
    }
    setSaveCitiesError(null);
    setEditingCities(true);
  }

  function focusCitiesPanel() {
    const panel = citiesPanelRef.current;
    if (!panel) return;
    focusCitiesRef.current = false;
    panel.scrollIntoView?.({ block: 'center' });
    panel.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }

  // After the panel mounts: the field exists only once `editingCities` has
  // rendered, so the move happens here rather than in the click handler.
  useEffect(() => {
    if (editingCities && focusCitiesRef.current) focusCitiesPanel();
  }, [editingCities]);

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
  const showApplicationsNotice = applicationsFailed && !applicationsNoticeDismissed;

  return (
    <AppShell role="worker" title={t('title')}>
      <main className="mx-auto max-w-2xl px-4 py-6 md:px-6">
        {celebrating ? (
          <HiredCelebrationModal
            key={celebrating.application_id}
            open
            applicationId={celebrating.application_id}
            jobTitle={celebrating.job_title}
            companyName={celebrating.company_name}
            hire={celebrating.hire}
            onClose={() => closeCelebration(celebrating.application_id)}
          />
        ) : null}

        {/* ABOVE the details request: a job already won outranks a form still
            to fill in. Both are above the search box for the same reason -- an
            answer about work the worker has already done beats browsing for
            more of it. */}
        {hires.map((notice) => (
          <div key={notice.application_id} className="mb-4">
            <HiredBanner
              applicationId={notice.application_id}
              jobTitle={notice.job_title}
              companyName={notice.company_name}
              hire={notice.hire}
              onDismiss={() => dismissHire(notice.application_id)}
            />
          </div>
        ))}

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

        {/* Stands in for the banners directly above, so it sits in the same
            place and OUTSIDE the skeleton gate below: a notice about the
            applications call has no business waiting on the job feed, which
            is a different request with a different failure. No retry link --
            the attention context retries a failed read on its own
            (`ATTENTION_RETRY_MS`). */}
        {showApplicationsNotice ? (
          <div className="mb-4">
            <InlineFeedback
              tone="warning"
              onDismiss={() => setApplicationsNoticeDismissed(true)}
            >
              {t('applications_error')}
            </InlineFeedback>
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
          <div
            ref={citiesPanelRef}
            className="mb-4 scroll-mt-4 space-y-3 rounded-[var(--radius-input)] border border-[var(--jale-divider)] bg-[var(--jale-card)] p-3"
          >
            {/* keyed so a save (or a cancel-then-reopen) remounts the field and
                drops any typed-but-unpicked text — see CityMultiSelect docs */}
            <CityMultiSelect
              key={cityVersion}
              value={preferredCities}
              onChange={setPreferredCities}
              onPendingChange={setCitiesPending}
              unpickedError={citiesRefused}
            />
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
                  /* The one thing a worker can do about an empty feed is look
                     in more places, so the action opens the city picker. It
                     says "pick" to a worker with no cities and "edit" to one
                     who already has some. */
                  <EmptyState
                    title={t('empty.title')}
                    body={t('empty.body')}
                    action={{
                      label: preferredCities.length === 0 ? t('empty.cta') : t('cities_edit'),
                      onClick: openCityPicker,
                    }}
                  />
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
