'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { usePageData } from '@/hooks/usePageData';
import { useStaggerOnce } from '@/hooks/useStaggerOnce';
import { formatShortDate, formatWeekdayDate } from '@/lib/date';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { Input } from '@/components/ui/input';
import { MetricCard } from '@/components/ui/metric-card';
import { DashboardSkeleton } from '@/components/ui/page-skeletons';
import { PanelHeader } from '@/components/ui/panel-header';
import { ProgressRow } from '@/components/ui/progress-row';
import { useToast } from '@/components/ui/toast';
import { JobPostingCard } from '@/components/employer/JobPostingCard';
import { PlanUsageMeter } from '@/components/employer/PlanUsageMeter';
import { PostJobModal } from '@/components/employer/PostJobModal';
import { SubscriptionBanner } from '@/components/employer/SubscriptionBanner';
import { DeleteJobDialog } from '@/components/employer/DeleteJobDialog';
import { PlanLimitDialog } from '@/components/employer/PlanLimitDialog';
import { ApiError, deleteJob, getBilling, getJobs, listJobTemplates, updateJobStatus } from '@/lib/api/employer';
import type { EmployerBilling, Job, JobCreatedOutcome } from '@/lib/api/employer';
import { errorMessageKey } from '@/lib/api/errors';
import { activeJobsPreflightModel, planLimitModel, subscriptionSignage } from '@/lib/plan-limit';
import type { PlanLimitModel } from '@/lib/plan-limit';
import type { JobStatus, WritableJobStatus } from '@/lib/status';

const statusFilters = ['all', 'active', 'paused', 'filled', 'closed'] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Everything the board renders, loaded in ONE pass.
 *
 * The jobs list is the page; billing and the template count are the signage
 * around it (the plan banner, the usage meter). Fetching those separately after
 * mount would paint the board first and then push it down when the banner
 * arrives -- so all three are awaited together and land in the same commit.
 *
 * Only jobs can fail the page, and only jobs can make it WAIT: the two
 * best-effort calls are raced against BEST_EFFORT_DEADLINE_MS, so a slow
 * /employer/billing cannot hold the board behind it (see `withDeadline`).
 * Whichever way they come up short -- rejected or too slow -- they degrade to
 * `null`, which the banner reads as "nothing to say" and the meter as "show
 * the plain count".
 *
 * On a REFRESH those nulls are then healed from the last good values instead
 * of being written through: `usePageData` guarantees a background refresh can
 * only ever add (usePageData.ts:28-31), and blanking the plan segments of a
 * page the employer is reading is the opposite of that.
 */
type DashboardData = {
    jobs: Job[];
    billing: EmployerBilling | null;
    templateCount: number | null;
};

/**
 * How long the jobs commit may wait on the signage around it.
 *
 * `apiFetch`'s own budget is 15s per attempt (lib/api.ts DEFAULT_TIMEOUT_MS) --
 * a fine ceiling for a request the page cannot render without, and far too
 * long for one it can. 2.5s is generous for a warm call and short enough that
 * a hung one is simply not part of this paint.
 */
const BEST_EFFORT_DEADLINE_MS = 2_500;

/**
 * `promise`, or `null` if it has not settled within `ms`.
 *
 * Losing the race does not cancel the request (nothing here can: the fetch
 * carries the page's abort signal, and cancelling it would abort a call that
 * may still be about to answer) -- it only stops the page waiting on it. A
 * rejection resolves `null` too, so the caller has one shape to handle. The
 * timer is cleared on settle so a resolved call leaves no pending timeout.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(null);
            },
        );
    });
}

/** Percentage of `total` that `part` represents, safe at total = 0. */
function share(part: number, total: number): number {
    return total > 0 ? (part / total) * 100 : 0;
}

function daysSince(value: string, now: Date): number | null {
    const postedAt = new Date(value);
    if (Number.isNaN(postedAt.getTime())) return null;
    return Math.max(0, Math.floor((now.getTime() - postedAt.getTime()) / MS_PER_DAY));
}

export default function EmployerDashboardPage() {
    const { idToken } = useAuth();
    // usePageData already arms the sign-in redirect; this call is here for the
    // legal-wall router, which the MUTATIONS below need (a delete that trips the
    // wall must go to /legal/accept, not show an error the user cannot act on).
    const { handleLegalWall } = useRequireAuth();
    const t = useTranslations('employer_dashboard');
    const tBilling = useTranslations('billing');
    const tCommon = useTranslations('common');
    const errorMessage = useErrorMessage();
    const toast = useToast();
    const locale = useLocale();

    const [jobToDelete, setJobToDelete] = useState<Job | null>(null);
    const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<JobStatus | 'all'>('all');
    /**
     * The backstop for a job that posted while its "save as template" box was
     * ticked and the template limit was already reached. The modal says so too,
     * but it closes on success -- so the fact would otherwise vanish with it.
     */
    const [templateNotice, setTemplateNotice] = useState<{ limit: number } | null>(null);
    /**
     * The one plan-limit dialog on this page, fed by two paths: the PRE-flight
     * gate on "Post a job" (`activeJobsPreflightModel`) and a resume that the
     * plan refuses with 403 `job_limit_reached` (`planLimitModel`). Both are
     * the same fact about the same cap, so they get the same dialog rather than
     * two that could drift apart.
     */
    const [planLimit, setPlanLimit] = useState<PlanLimitModel | null>(null);
    /** The job whose status change is in flight; freezes only that row. */
    const [pendingStatusJobId, setPendingStatusJobId] = useState<string | null>(null);
    /*
     * `Modal`'s own focus restore cannot work for the limit dialog, so the page
     * does it -- the same fix, for the same reason, as the job detail page
     * (`employer/jobs/[id]/page.tsx`): the row's Pause/Resume button disables
     * itself the instant the request starts, disabling the focused element
     * blurs it, and by the time the 403 mounts the dialog `document.activeElement`
     * is <body>. `ui/modal.tsx` captures that as the opener and its restore is
     * then a no-op, dropping a keyboard user at the top of the document.
     *
     * The gate path does not need this (its button stays enabled), but it costs
     * nothing there and one code path is better than two.
     */
    const planLimitOpenerRef = useRef<HTMLElement | null>(null);

    /**
     * The last billing/template numbers that actually arrived. A refresh whose
     * best-effort calls fail or time out reads from here rather than writing
     * `null` through -- the signage the employer is looking at stays put.
     */
    const lastGoodRef = useRef<{ billing: EmployerBilling | null; templateCount: number | null }>({
        billing: null,
        templateCount: null,
    });

    /**
     * One fetch for the whole page.
     *
     * `deps` is deliberately EMPTY. Search and the status filter are derived
     * from the already-loaded list below, never re-fetched: routing a filter
     * through `deps` would reset the hook and re-request on every keystroke,
     * and a single flaky response mid-typing would null `data` and wipe the
     * board the user is reading.
     */
    const {
        phase,
        data,
        empty,
        errorKind,
        refreshing,
        refreshError,
        retry,
        refresh,
        setData,
    } = usePageData<DashboardData>({
        fetcher: async ({ token, signal }) => {
            // Best-effort, both of them: `.catch` (not a rejected Promise.all)
            // keeps a billing outage off the board, and `withDeadline` keeps a
            // SLOW one off it too -- without the deadline the jobs commit waits
            // out apiFetch's 15s budget for signage it can render without.
            //
            // All three take the page's `signal`, so an abandoned load (an
            // unmount, or a retry that supersedes this one) cancels the
            // REQUESTS rather than merely discarding their answers. The
            // deadline still matters: it bounds a slow response, where the
            // signal bounds an abandoned page.
            const [jobList, freshBilling, freshTemplateCount] = await Promise.all([
                getJobs(token, signal),
                withDeadline(getBilling(token, signal).catch(() => null), BEST_EFFORT_DEADLINE_MS),
                withDeadline(
                    listJobTemplates(token, signal).then((list) => list.length).catch(() => null),
                    BEST_EFFORT_DEADLINE_MS,
                ),
            ]);

            // `??`, so a real 0 is kept and only a MISSING answer falls back.
            const billing = freshBilling ?? lastGoodRef.current.billing;
            const templateCount = freshTemplateCount ?? lastGoodRef.current.templateCount;
            lastGoodRef.current = { billing, templateCount };

            return { jobs: jobList, billing, templateCount };
        },
        legalReturnUrl: '/employer/dashboard',
        isEmpty: (d) => d.jobs.length === 0,
    });

    const jobs = useMemo(() => data?.jobs ?? [], [data]);
    const signage = useMemo(() => subscriptionSignage(data?.billing ?? null), [data]);

    const filteredJobs = useMemo(() => {
        let result = jobs;
        if (statusFilter !== 'all') result = result.filter((job) => job.status === statusFilter);
        if (!search.trim()) return result;
        const q = search.toLowerCase();
        return result.filter((job) =>
            job.title.toLowerCase().includes(q) ||
            job.location.toLowerCase().includes(q) ||
            (job.trade_category ?? '').toLowerCase().includes(q)
        );
    }, [jobs, search, statusFilter]);

    const activeCount = jobs.filter((job) => job.status === 'active').length;
    const pausedCount = jobs.filter((job) => job.status === 'paused').length;
    const filledCount = jobs.filter((job) => job.status === 'filled').length;
    const closedCount = jobs.filter((job) => job.status === 'closed').length;
    const totalApplicants = jobs.reduce((sum, job) => sum + job.applicant_count, 0);
    const totalHired = jobs.reduce((sum, job) => sum + (job.hired_count ?? 0), 0);
    const totalPositionsNeeded = jobs.reduce((sum, job) => sum + (job.number_of_workers_needed ?? 0), 0);
    const openRoles = jobs.reduce((sum, job) => sum + (job.open_count ?? 0), 0);
    const jobProgressPercent = share(totalHired, totalPositionsNeeded);
    const applicantDensity = activeCount > 0 ? Math.round(totalApplicants / activeCount) : 0;
    const recentJob = jobs[0];
    const timeToFillJob = jobs.find((job) =>
        (job.status === 'active' || job.status === 'paused') && (job.open_count ?? 0) > 0
    );

    // `new Date()` must NOT be formatted during render: the server (Lambda, UTC) and the
    // browser (user's local timezone) can land on different calendar days, producing
    // different strings and a hydration mismatch (React #418/#423/#425). Compute it after
    // mount so the server HTML and the client's first render agree (empty), then fill in.
    const [todayLabel, setTodayLabel] = useState('');
    const [currentDate, setCurrentDate] = useState<Date | null>(null);
    useEffect(() => {
        const now = new Date();
        setTodayLabel(formatWeekdayDate(now, locale) ?? '');
        setCurrentDate(now);
    }, [locale]);

    const timeToFillDays = currentDate && timeToFillJob
        ? daysSince(timeToFillJob.created_at, currentDate)
        : null;
    const timeToFillPostedLabel = timeToFillJob
        ? formatShortDate(timeToFillJob.created_at, locale)
        : null;

    function handleJobCreated(job: Job, outcome?: JobCreatedOutcome) {
        setModalOpen(false);
        toast.success(t('jobs.post_success'));
        // Set BEFORE the `data === null` guard below returns: the template was
        // not saved either way, and that fact must not depend on whether the
        // list happened to be loaded.
        // Set (or cleared) on EVERY post, not only the failing ones: a notice
        // left standing from an earlier post would sit next to a fresh success
        // toast claiming a template that this post did save was not saved.
        const notSaved = outcome?.templateNotSaved;
        setTemplateNotice(notSaved ? { limit: notSaved.templateLimit } : null);
        // `setData` is a no-op while nothing is rendered (a failed or in-flight
        // first load), so in that case ask for the list properly instead of
        // silently dropping the job the employer just posted.
        if (data === null) {
            retry();
            return;
        }
        setData((prev) => ({
            ...prev,
            jobs: [job, ...prev.jobs],
            // The meter counts templates from this snapshot; a post that saved a
            // new one must move it without a round-trip to /employer/templates.
            templateCount: outcome?.templateSaved && prev.templateCount !== null
                ? prev.templateCount + 1
                : prev.templateCount,
        }));
    }

    const handlePlanLimitClose = useCallback(() => {
        setPlanLimit(null);
        const opener = planLimitOpenerRef.current;
        planLimitOpenerRef.current = null;
        // Next frame: the button may still be `disabled` in the current commit
        // (and so unfocusable), and the Modal's own restore-to-body has to land
        // first. `requestAnimationFrame` is absent in some test DOMs.
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => opener?.focus());
        } else {
            opener?.focus();
        }
    }, []);

    /*
     * The gate the whole task is about.
     *
     * EVERY control that opened the wizard now goes through here, which is the
     * point: the old flow let a free-plan employer with their one slot taken
     * fill in all three steps and only learn about the cap from the publish
     * 403 -- whose one self-service way out ("Pause a job") navigates to this
     * board, and `PostJobModal.handleClose` resets the form on the way, so the
     * draft they just wrote is gone.
     *
     * The count comes from the LIVE jobs list (`activeCount`), not from
     * `billing.activeJobUsage`: that field is a load-time snapshot, and this
     * page now pauses and resumes jobs in place, so it goes stale the moment
     * the employer frees a slot. It is also the number `PlanUsageMeter` shows
     * them two lines below. `activeJobsPreflightModel` returns null -- meaning
     * "don't gate" -- whenever billing is missing or malformed, so a slow
     * best-effort billing read can never lock anyone out of posting; the 403
     * handling inside the wizard stays as the backstop.
     */
    function handlePostJobClick() {
        const gate = activeJobsPreflightModel(data?.billing ?? null, activeCount, jobs);
        if (gate) {
            planLimitOpenerRef.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setPlanLimit(gate);
            return;
        }
        setModalOpen(true);
    }

    /**
     * Pause an active job / resume a paused one, from the board.
     *
     * Optimistic in the same shape as `handleConfirmDelete`: the response row
     * is merged into the list so the badge, the counters and the plan meter all
     * move together, and a failure leaves the board exactly as it was.
     *
     * A refused RESUME is the interesting failure. The backend answers a full
     * plan with 403 `job_limit_reached`, which `classifyError` calls
     * `forbidden` -- so without the `planLimitModel` branch the employer would
     * be told "you don't have access to this" about their own posting.
     */
    async function handleSetJobStatus(job: Job, status: WritableJobStatus) {
        if (!idToken || pendingStatusJobId) return;
        // Captured BEFORE the button disables itself -- see `planLimitOpenerRef`.
        planLimitOpenerRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPendingStatusJobId(job.id);
        try {
            const updated = await updateJobStatus(idToken, job.id, status);
            setData((cur) => ({
                ...cur,
                jobs: cur.jobs.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)),
            }));
            toast.success(
                updated.status === 'paused'
                    ? t('jobs.status_change.pause_success')
                    : t('jobs.status_change.resume_success'),
            );
        } catch (err) {
            try {
                handleLegalWall(err, '/employer/dashboard');
                return;
            } catch {
                // Not a legal wall — fall through.
            }
            const model = planLimitModel(err, jobs);
            if (model) {
                setPlanLimit(model);
                return;
            }
            toast.error(errorMessage(err, { unknown: t('jobs.status_change.error_generic') }));
        } finally {
            setPendingStatusJobId(null);
        }
    }

    function openDeleteDialog(job: Job) {
        setDeletingJobId(null);
        setDeleteError(null);
        setJobToDelete(job);
    }

    function closeDeleteDialog() {
        setDeletingJobId(null);
        setDeleteError(null);
        setJobToDelete(null);
    }

    async function handleConfirmDelete() {
        if (!idToken || !jobToDelete || deletingJobId) return;

        const target = jobToDelete;
        setDeletingJobId(target.id);
        setDeleteError(null);
        try {
            await deleteJob(idToken, target.id);
            setData((cur) => ({ ...cur, jobs: cur.jobs.filter((job) => job.id !== target.id) }));
            closeDeleteDialog();
            toast.success(t('jobs.delete.success'));
        } catch (err) {
            try {
                handleLegalWall(err, '/employer/dashboard');
                return;
            } catch {
                // Not a legal wall — render the failure in the dialog.
            }
            // `job_has_hired_workers` is a typed CODE, not a message: it keeps
            // its own sentence because "close it instead" is advice no generic
            // failure copy can give. Everything else is classified — a rendered
            // `err.message` would be a backend code, not a sentence.
            setDeleteError(
                err instanceof ApiError && err.code === 'job_has_hired_workers'
                    ? t('jobs.delete.error_hired')
                    : errorMessage(err, { unknown: t('jobs.delete.error_generic') }),
            );
        } finally {
            setDeletingJobId(null);
        }
    }

    /*
     * The job list cascades once, when it first arrives, and never again.
     *
     * This page's search box and status chips filter `jobs` CLIENT-SIDE, so
     * they never reach the fetch layer -- but they do re-insert rows (clearing
     * a search remounts every row it had hidden), and `.anim-stagger` animates
     * whatever children exist when they are inserted. Gating on a refetch would
     * miss the two controls that replay the cascade most often. `useStaggerOnce`
     * gates on the cascade finishing instead, which covers every source: the
     * filters above, Refresh, and a `retry()` reload alike.
     */
    const { staggerClass, onCascadeEnd } = useStaggerOnce();

    // 'auth' means the token gate has not opened yet: nothing has been asked for,
    // so the page owes the reader a skeleton rather than a screen of dashes.
    const showSkeleton = phase === 'auth' || phase === 'loading';

    const postJobButton = (
        <Button onClick={handlePostJobClick} className="h-10">
            <Icon name="plus" />
            {t('jobs.post_job')}
        </Button>
    );

    return (
        <>
            <AppShell
                role="employer"
                title={t('shell.title')}
                subtitle={todayLabel}
                actions={postJobButton}
            >
                <div className="mx-auto max-w-[1380px] px-4 py-6 pb-24 md:px-6">
                    {showSkeleton ? (
                        /* Same component the route's `loading.tsx` renders, so the
                           handover from the server skeleton to this one is invisible.
                           Critically, the KPI band is SKELETON here — the page used to
                           print `'-'` in every card, and a dash is a value: four of
                           them read as "you have nothing" for as long as the request
                           is in flight. */
                        <DashboardSkeleton />
                    ) : phase === 'error' && errorKind ? (
                        /* Nothing but the failure. Metrics are hidden rather than
                           zeroed: "0 active jobs" is a claim about the account, and a
                           request that never answered supports no claim at all. */
                        <DashboardPanel>
                            <ErrorState kind={errorKind} onRetry={retry} />
                        </DashboardPanel>
                    ) : (
                        <div className="anim-fade-in">
                            {/* Above the hero, and above the board: billing state
                                changes what the buttons below it can do, so it is
                                read first. It arrives with the jobs (one fetch), so
                                it never pushes an already-read board down. */}
                            <SubscriptionBanner signage={signage} locale={locale} />

                            <section className="mb-5 overflow-hidden rounded-[var(--radius-card)] bg-[var(--jale-blue-900)] p-5 shadow-[var(--shadow-card)] md:p-7">
                                <p className="mb-3 inline-flex rounded-full bg-[color-mix(in_srgb,var(--primary-fg)_12%,transparent)] px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-[color-mix(in_srgb,var(--primary-fg)_80%,transparent)]">
                                    {t('hero.eyebrow')}
                                </p>
                                <h2 className="max-w-3xl text-3xl font-extrabold leading-tight text-[var(--primary-fg)] md:text-4xl">
                                    {t('hero.title')}
                                </h2>
                                <p className="mt-3 max-w-2xl text-sm leading-6 text-[color-mix(in_srgb,var(--primary-fg)_72%,transparent)]">
                                    {t('hero.body')}
                                </p>
                                <div className="mt-5 flex flex-wrap items-center gap-2">
                                    <Button onClick={handlePostJobClick}>
                                        <Icon name="plus" />
                                        {t('hero.primary_cta')}
                                    </Button>
                                    <Link
                                        href="/employer/conversations"
                                        className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--primary-fg)_25%,transparent)] px-5 text-sm font-semibold text-[var(--primary-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--primary-fg)_12%,transparent)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                                    >
                                        <Icon name="message" />
                                        {t('hero.secondary_cta')}
                                    </Link>
                                </div>
                            </section>

                            <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
                                <MetricCard
                                    label={t('stats.active_jobs')}
                                    value={activeCount}
                                    hint={t('stats.active_hint')}
                                />
                                <MetricCard
                                    label={t('stats.total_applicants')}
                                    value={totalApplicants}
                                    hint={t('stats.applicants_hint', { count: applicantDensity })}
                                />
                                <MetricCard
                                    label={t('stats.workers_hired')}
                                    value={totalHired}
                                    hint={t('stats.hired_hint', { count: openRoles })}
                                    tone="green"
                                />
                                <MetricCard
                                    label={t('stats.paused_closed')}
                                    value={pausedCount + closedCount + filledCount}
                                    hint={t('stats.paused_closed_hint', {
                                        paused: pausedCount,
                                        closed: closedCount,
                                        filled: filledCount,
                                    })}
                                />
                            </div>

                            {/* `min-w-0` on both columns is load-bearing. A grid item
                                defaults to `min-width: auto`, so without it the panels'
                                min-content width (nowrap pill buttons, a long Spanish
                                panel title) becomes the column's floor and the whole
                                board grows past a 390px screen. */}
                            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(340px,.8fr)]">
                                <div className="min-w-0 space-y-5">
                                    <DashboardPanel className="overflow-hidden">
                                        {/* One action only. `PanelHeader` is a
                                            non-wrapping flex row, so a second button here
                                            is what pushed the panel past the viewport in
                                            Spanish at 390px; Refresh lives with the
                                            filters, next to the count it refreshes. */}
                                        <PanelHeader
                                            title={t('jobs.title')}
                                            action={
                                                <Button size="sm" onClick={handlePostJobClick}>
                                                    <Icon name="plus" />
                                                    {t('jobs.post_job')}
                                                </Button>
                                            }
                                        />

                                        <div className="border-b border-[var(--jale-divider)] p-4 md:p-5">
                                            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                                                <Input
                                                    type="search"
                                                    value={search}
                                                    onChange={(e) => setSearch(e.target.value)}
                                                    placeholder={t('jobs.search_placeholder')}
                                                    aria-label={t('jobs.search_placeholder')}
                                                />
                                                <div
                                                    role="group"
                                                    aria-label={t('jobs.filter_aria_label')}
                                                    className="flex flex-wrap gap-2"
                                                >
                                                    {statusFilters.map((status) => {
                                                        const selected = statusFilter === status;
                                                        return (
                                                            <button
                                                                key={status}
                                                                type="button"
                                                                aria-pressed={selected}
                                                                onClick={() => setStatusFilter(status)}
                                                                className={[
                                                                    'rounded-full border px-3.5 py-1.5 text-xs font-bold transition-colors',
                                                                    'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                                                                    selected
                                                                        ? 'border-[var(--jale-blue-500)] bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]'
                                                                        : 'border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]',
                                                                ].join(' ')}
                                                            >
                                                                {t(`jobs.status.${status}`)}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </div>

                                            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                                                    <p className="text-xs font-semibold tabular-nums text-[var(--jale-ink-2)]">
                                                        {empty
                                                            ? t('jobs.empty_first_title')
                                                            : t('jobs.showing', {
                                                                  shown: filteredJobs.length,
                                                                  total: jobs.length,
                                                              })}
                                                    </p>
                                                    {/* The count says how much of the LIST is
                                                        shown; the meter says how much of the
                                                        PLAN is used. Same row, same glance. */}
                                                    <PlanUsageMeter
                                                        activeCount={activeCount}
                                                        billing={data?.billing ?? null}
                                                        templateCount={data?.templateCount ?? null}
                                                        loading={phase !== 'ready'}
                                                    />
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => void refresh()}
                                                    loading={refreshing}
                                                    loadingLabel={tCommon('loading')}
                                                    disabled={phase !== 'ready'}
                                                >
                                                    {t('jobs.refresh')}
                                                </Button>
                                            </div>

                                            {/* The job posted; the template attached to it did
                                                not. The modal that said so has already closed,
                                                so the notice is repeated here with the two
                                                actions that resolve it. */}
                                            {templateNotice ? (
                                                <InlineFeedback
                                                    tone="warning"
                                                    className="mt-3"
                                                    onDismiss={() => setTemplateNotice(null)}
                                                >
                                                    <span className="block">
                                                        {t('jobs.template_not_saved_after_post', {
                                                            limit: templateNotice.limit,
                                                        })}
                                                    </span>
                                                    <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                                                        <Link
                                                            href="/employer/templates"
                                                            className="inline-flex items-center gap-1.5 text-xs font-bold underline underline-offset-2"
                                                        >
                                                            {t('templates.manage_link')}
                                                        </Link>
                                                        <Link
                                                            href="/employer/billing"
                                                            className="inline-flex items-center gap-1.5 text-xs font-bold underline underline-offset-2"
                                                        >
                                                            <Icon name="spark" />
                                                            {tBilling('limit_reached.cta')}
                                                        </Link>
                                                    </span>
                                                </InlineFeedback>
                                            ) : null}

                                            {/* A failed background refresh is a FOOTNOTE.
                                                `usePageData` cannot let it clear `data`, so
                                                the board below stays exactly as it was. */}
                                            {refreshError ? (
                                                <InlineFeedback tone="warning" className="mt-3">
                                                    {tCommon(errorMessageKey(refreshError))}
                                                </InlineFeedback>
                                            ) : null}
                                        </div>

                                        {empty ? (
                                            /* The account has no jobs at all. The dashed
                                               card is the app's best first-run invitation;
                                               it keeps its shape and its one CTA. */
                                            <div className="p-4 md:p-5">
                                                <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--jale-divider)] bg-[var(--jale-paper-2)] px-6 py-10 text-center">
                                                    <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--jale-blue-50)] text-[var(--jale-blue-700)]">
                                                        <Icon name="briefcase" />
                                                    </span>
                                                    <p className="text-sm font-bold text-[var(--jale-ink)]">
                                                        {t('jobs.empty_first_title')}
                                                    </p>
                                                    <p className="mx-auto mt-1 max-w-sm text-sm text-[var(--jale-ink-2)]">
                                                        {t('jobs.empty_first_body')}
                                                    </p>
                                                    <Button onClick={handlePostJobClick} className="mt-5">
                                                        <Icon name="plus" />
                                                        {t('jobs.post_job')}
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : filteredJobs.length === 0 ? (
                                            /* Jobs EXIST — the filters are hiding them.
                                               Saying "post a job" here would be advice for
                                               a problem the employer does not have. */
                                            <EmptyState
                                                variant="filtered"
                                                title={t('jobs.empty_title')}
                                                body={t('jobs.empty_body')}
                                                action={{
                                                    label: tCommon('empty_state.clear_filters'),
                                                    onClick: () => {
                                                        setSearch('');
                                                        setStatusFilter('all');
                                                    },
                                                }}
                                            />
                                        ) : (
                                            <ul
                                                className={['divide-y divide-[var(--jale-divider)]', staggerClass]
                                                    .filter(Boolean)
                                                    .join(' ')}
                                                onAnimationEnd={onCascadeEnd}
                                            >
                                                {filteredJobs.map((job) => (
                                                    <JobPostingCard
                                                        key={job.id}
                                                        job={job}
                                                        href={`/employer/jobs/${job.id}`}
                                                        onDelete={openDeleteDialog}
                                                        onPause={(row) => void handleSetJobStatus(row, 'paused')}
                                                        onResume={(row) => void handleSetJobStatus(row, 'active')}
                                                        statusPending={pendingStatusJobId === job.id}
                                                    />
                                                ))}
                                            </ul>
                                        )}
                                    </DashboardPanel>

                                    <DashboardPanel>
                                        <PanelHeader title={t('quick_post.title')} />
                                        <div className="grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                                            <div>
                                                <p className="text-sm font-semibold text-[var(--jale-ink)]">{t('quick_post.body')}</p>
                                                <p className="mt-2 text-xs leading-5 text-[var(--jale-ink-2)]">{t('quick_post.hint')}</p>
                                            </div>
                                            <Button onClick={handlePostJobClick}>
                                                <Icon name="plus" />
                                                {t('quick_post.cta')}
                                            </Button>
                                        </div>
                                    </DashboardPanel>
                                </div>

                                <div className="min-w-0 space-y-5">
                                    <DashboardPanel>
                                        <PanelHeader
                                            title={t('panels.whatsapp_title')}
                                            action={
                                                <Link
                                                    href="/employer/conversations"
                                                    className="rounded text-xs font-bold text-[var(--jale-blue-700)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                                                >
                                                    {t('panels.open_messages')}
                                                </Link>
                                            }
                                        />
                                        <div className="p-5">
                                            <p className="text-sm font-bold text-[var(--jale-ink)]">
                                                {recentJob?.title ?? t('panels.no_recent_job')}
                                            </p>
                                            <p className="mt-2 text-xs leading-5 text-[var(--jale-ink-2)]">
                                                {t('panels.whatsapp_body')}
                                            </p>
                                        </div>
                                    </DashboardPanel>

                                    <DashboardPanel>
                                        <PanelHeader title={t('panels.job_progress_title')} />
                                        <div className="p-5">
                                            <div className="flex min-w-0 items-end justify-between gap-4">
                                                <div className="min-w-0">
                                                    <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
                                                        {t('panels.positions_filled')}
                                                    </p>
                                                    <p className="mt-2 text-3xl font-extrabold leading-none tabular-nums text-[var(--jale-ink)]">
                                                        {totalHired} / {totalPositionsNeeded}
                                                    </p>
                                                </div>
                                                <p className="shrink-0 rounded-full bg-[var(--jale-blue-50)] px-3 py-1 text-xs font-bold tabular-nums text-[var(--jale-blue-700)]">
                                                    {t('panels.positions_open_hint', { count: openRoles })}
                                                </p>
                                            </div>
                                            <div
                                                role="progressbar"
                                                aria-label={t('panels.positions_filled')}
                                                aria-valuemin={0}
                                                aria-valuemax={100}
                                                aria-valuenow={Math.round(jobProgressPercent)}
                                                aria-valuetext={`${totalHired} / ${totalPositionsNeeded}`}
                                                className="mt-4"
                                            >
                                                <div className="h-2 overflow-hidden rounded-full bg-[var(--jale-paper-2)]">
                                                    <div
                                                        className="h-full rounded-full bg-[var(--jale-blue-500)]"
                                                        style={{ width: `${Math.min(100, Math.max(0, jobProgressPercent))}%` }}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    </DashboardPanel>

                                    <DashboardPanel>
                                        <PanelHeader title={t('panels.time_to_fill_title')} />
                                        <div className="p-5">
                                            <MetricCard
                                                label={t('panels.days_posted')}
                                                value={timeToFillDays ?? '-'}
                                                hint={
                                                    timeToFillJob
                                                        ? t('panels.time_to_fill_hint', { title: timeToFillJob.title })
                                                        : t('panels.no_open_jobs')
                                                }
                                            />
                                            {timeToFillJob && timeToFillPostedLabel ? (
                                                <p className="mt-4 text-xs font-semibold text-[var(--jale-ink-2)]">
                                                    {t('panels.posted_on', { date: timeToFillPostedLabel })}
                                                </p>
                                            ) : null}
                                        </div>
                                    </DashboardPanel>

                                    <DashboardPanel>
                                        <PanelHeader title={t('panels.hiring_status_title')} />
                                        <div className="space-y-4 p-5">
                                            <ProgressRow
                                                label={t('jobs.status.active')}
                                                value={String(activeCount)}
                                                percent={share(activeCount, jobs.length)}
                                            />
                                            <ProgressRow
                                                label={t('jobs.status.paused')}
                                                value={String(pausedCount)}
                                                percent={share(pausedCount, jobs.length)}
                                            />
                                            <ProgressRow
                                                label={t('jobs.status.filled')}
                                                value={String(filledCount)}
                                                percent={share(filledCount, jobs.length)}
                                            />
                                            <ProgressRow
                                                label={t('jobs.status.closed')}
                                                value={String(closedCount)}
                                                percent={share(closedCount, jobs.length)}
                                            />
                                        </div>
                                    </DashboardPanel>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </AppShell>

            <PostJobModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onJobCreated={handleJobCreated}
            />

            {/* Mounted unconditionally and driven by `open`, never keyed --
                for the reason spelled out on DeleteJobDialog below: a Modal
                that mounts already open never receives focus. */}
            <PlanLimitDialog
                open={planLimit !== null}
                model={planLimit}
                onClose={handlePlanLimitClose}
            />

            {/* Deliberately NOT keyed by job id.
                A `key` that changed on open meant the dialog MOUNTED already
                open, and a modal that mounts open never gets focus: `Modal`
                renders null on its first commit (it waits for `mounted` before
                creating its portal), so the focus effect finds no panel and
                never re-runs. Focus stayed on the row's delete button behind
                the scrim — trap, Escape and restore all worked, and the reader
                was still outside the dialog.
                The key was only ever guarding against one delete's pending or
                failed state leaking into the next selected job, and
                `openDeleteDialog` already clears both before switching jobs
                (and `deleting` is matched by id), so nothing is lost. */}
            <DeleteJobDialog
                open={jobToDelete !== null}
                jobTitle={jobToDelete?.title ?? ''}
                deleting={deletingJobId === jobToDelete?.id}
                error={deleteError}
                onCancel={closeDeleteDialog}
                onConfirm={handleConfirmDelete}
            />
        </>
    );
}
