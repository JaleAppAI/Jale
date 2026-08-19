'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { usePageData } from '@/hooks/usePageData';
import { useStaggerOnce } from '@/hooks/useStaggerOnce';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { Link, useRouter } from '@/i18n/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { ApplicationStatusBadge, Badge, JobStatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineFeedback, type FeedbackTone } from '@/components/ui/inline-feedback';
import { KVList, type KVItem } from '@/components/ui/kv-list';
import { MatchReasonChips, MatchScoreBadge } from '@/components/ui/match-signals';
import { MetricCard } from '@/components/ui/metric-card';
import { DetailPageSkeleton, ListPageSkeleton, MetricRowSkeleton } from '@/components/ui/page-skeletons';
import { PanelHeader } from '@/components/ui/panel-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
    ApplicantFilterPanel,
    EMPTY_APPLICANT_FILTERS,
    hasActiveApplicantFilters,
} from '@/components/employer/ApplicantFilterPanel';
import { CloseJobDialog } from '@/components/employer/CloseJobDialog';
import { DeleteJobDialog } from '@/components/employer/DeleteJobDialog';
import { EditJobModal } from '@/components/employer/EditJobModal';
import { PublicListingCard } from '@/components/employer/PublicListingCard';
import {
    ApiError,
    deleteJob,
    getJob,
    getJobApplicants,
    getJobCandidates,
    startConversation,
    updateJobStatus,
} from '@/lib/api/employer';
import type { Applicant, ApplicantFilters, EmployerJobDetail } from '@/lib/api/employer';
import { classifyError, type ErrorKind } from '@/lib/api/errors';
import { answerEntries } from '@/lib/format-application-answers';
import type { ScoreBand } from '@/lib/match';
import { normalizeMatchScore, normalizeScoreBand, truncateMatchReason } from '@/lib/match';
import type { WritableJobStatus } from '@/lib/status';
import { formatLongDate, formatStartDate } from '@/lib/date';

export const dynamic = 'force-dynamic';

/** `jobs.id` is a UUID column; anything else can only be a broken link. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DASHBOARD_HREF = '/employer/dashboard';

/** Quiet period after the last filter edit before the reload is sent. */
const FILTER_DEBOUNCE_MS = 350;

type ApplicantMatch = {
    match_score: number;
    score_band: ScoreBand;
    match_reasons: string[];
};

/**
 * One load of this page: the posting and the applicant list that belongs to it.
 *
 * `appliedFilters` travels WITH the data rather than living beside it, because
 * the two must never disagree. The filtered-empty state is decided by "what
 * produced the rows currently on screen", and a separate state variable would
 * drift from that the moment a filtered reload was in flight or failed.
 */
type JobPageData = {
    job: EmployerJobDetail;
    applicants: Applicant[];
    appliedFilters: ApplicantFilters;
};

/**
 * Candidate ranking is a SEPARATE, slower concern from the page's own load.
 *
 * The old page folded a ranking failure into an empty match map, so "nobody
 * scored well" and "the ranking service is down" looked identical -- the
 * employer had no way to tell that the column of missing scores was a fault.
 * Modelling it explicitly is what lets the panel say which one happened and
 * offer a retry for the one that is retryable.
 */
type RankingState =
    | { status: 'loading' }
    | { status: 'ready'; matches: Map<string, ApplicantMatch> }
    | { status: 'failed'; kind: ErrorKind };

const NO_MATCHES: Map<string, ApplicantMatch> = new Map();

export default function JobDetailPage() {
    const params = useParams<{ id: string; locale: string }>();
    const jobId = (params?.id ?? '').trim();
    const jobIdValid = UUID_RE.test(jobId);

    const router = useRouter();
    const locale = useLocale();
    const { idToken } = useAuth();
    const { handleLegalWall } = useRequireAuth();
    const errorMessage = useErrorMessage();

    const t = useTranslations('employer_job_listing');
    // Frozen shared vocabulary, read-only here: `applicants.status.*` must name a
    // status exactly as every other employer surface does, `worker_profile.*`
    // likewise for document and experience labels, and `modal.*` is the job-form
    // vocabulary the edit modal writes against. `jobs.status.*` is the job-status
    // wording shared with the dashboard's own cards.
    const tShared = useTranslations('employer_dashboard');
    const tMessages = useTranslations('employer_messages');
    const tMatch = useTranslations('match');
    const tCommon = useTranslations('common');

    const returnUrl = `/employer/jobs/${jobId}`;

    /*
     * Filters are NOT a `deps` entry.
     *
     * A deps change makes usePageData dispatch RESET + LOAD_START, which drops
     * `data` and drops the page back to a skeleton -- and if that one request
     * fails, the employer's whole posting disappears because they touched a
     * dropdown. Filters therefore drive a BACKGROUND `refresh()`, which the
     * reducer structurally forbids from clearing data or moving the phase: a
     * failed filter reload leaves the previous rows on screen with a footnote.
     *
     * The ref is what makes that safe. `refresh()` is stable and runs
     * synchronously inside the change handler, BEFORE React re-renders, so the
     * fetcher closure it invokes is still the previous render's. Reading the
     * filters from a ref means the request always carries the filters the
     * employer just chose, not the ones they had a moment ago.
     */
    const [filters, setFilters] = useState<ApplicantFilters>(EMPTY_APPLICANT_FILTERS);
    const filtersRef = useRef<ApplicantFilters>(EMPTY_APPLICANT_FILTERS);

    const { phase, data, errorKind, refreshing, refreshError, retry, refresh, setData } =
        usePageData<JobPageData>({
            // `signal` aborts on unmount and on a deps change, and both reads
            // forward it, so an abandoned navigation cancels the requests
            // instead of leaving them to finish unwatched. usePageData's
            // request fencing still backstops a response that races the abort.
            fetcher: async ({ token, signal }) => {
                // A malformed id can only ever 404, and interpolating an
                // arbitrary path segment into the request URL is worth avoiding.
                // Throwing the same shape the backend would means the S5 branch
                // below needs no special case for it.
                if (!jobIdValid) throw new ApiError(404, 'job_not_found');

                const appliedFilters = filtersRef.current;
                const [job, page] = await Promise.all([
                    getJob(token, jobId, signal),
                    getJobApplicants(token, jobId, appliedFilters, signal),
                ]);
                return { job, applicants: page.applicants, appliedFilters };
            },
            legalReturnUrl: returnUrl,
            // Identity only. The job this page is about is the one thing whose
            // change genuinely invalidates everything on screen.
            deps: [jobId, jobIdValid],
        });

    const job = data?.job ?? null;
    const applicants = data?.applicants ?? [];
    const appliedFilters = data?.appliedFilters ?? EMPTY_APPLICANT_FILTERS;

    /*
     * The control updates instantly; the REQUEST waits for a pause. Firing on
     * every keystroke in the skills box would put one request per character on
     * the wire, and `usePageData` aborts the previous refresh when a new one
     * starts, so all but the last would be wasted anyway.
     */
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        },
        [],
    );

    const applyFilters = useCallback(
        (next: ApplicantFilters) => {
            filtersRef.current = next;
            setFilters(next);
            if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
            refreshTimerRef.current = setTimeout(() => {
                void refresh();
            }, FILTER_DEBOUNCE_MS);
        },
        [refresh],
    );

    /*
     * The panel column cascades once, when the posting first arrives.
     *
     * Keyed by `jobId` because that is the one change this page treats as a
     * genuinely fresh load: it is `usePageData`'s only dep, so it drops the
     * page back to a skeleton, and the next posting to paint has earned its own
     * cascade. Everything else that redraws these panels -- a debounced filter
     * reload, its `refreshError` footnote, a status change, the edit modal
     * closing -- lands after the gate has closed and changes nothing.
     */
    const { staggerClass, onCascadeEnd } = useStaggerOnce(jobId);

    /* ===== Candidate ranking (secondary, slower) ========================== */

    const [ranking, setRanking] = useState<RankingState>({ status: 'loading' });
    const [rankingAttempt, setRankingAttempt] = useState(0);

    // Read through a ref so a silent mid-session token refresh does not restart
    // the ranking fetch and flash "scoring..." over scores already on screen.
    const idTokenRef = useRef(idToken);
    idTokenRef.current = idToken;
    const hasToken = Boolean(idToken);

    const pageReady = phase === 'ready';

    useEffect(() => {
        if (!pageReady || !hasToken || !jobIdValid) return;

        let active = true;
        // The ranking request is the slowest thing this page asks for, so an
        // employer who leaves mid-scoring is exactly who should not keep paying
        // for it. `active` still guards the state writes: it is already false
        // by the time the abort rejection arrives.
        const controller = new AbortController();
        setRanking({ status: 'loading' });

        (async () => {
            try {
                const ranked = await getJobCandidates(
                    idTokenRef.current!, jobId, 100, controller.signal,
                );
                if (!active) return;
                setRanking({ status: 'ready', matches: buildCandidateMatchMap(ranked.candidates) });
            } catch (err) {
                if (!active) return;
                const { kind } = classifyError(err);
                if (kind === 'legal_wall') {
                    try {
                        handleLegalWall(err, returnUrl);
                    } catch {
                        // classifyError already said this is a legal wall, so
                        // handleLegalWall cannot rethrow; swallowing beats an
                        // unhandled rejection if the two ever disagree.
                    }
                    return;
                }
                // The one behaviour this whole state machine exists for: a
                // ranking failure is VISIBLE, not silently an empty map.
                setRanking({ status: 'failed', kind });
            }
        })();

        return () => {
            active = false;
            controller.abort();
        };
        // `rankingAttempt` is the retry pedal. Filters are absent on purpose:
        // the ranking is per-job and keyed by applicant, so narrowing the list
        // cannot change a score -- refetching it on every keystroke in the
        // filter bar was pure waste.
    }, [pageReady, hasToken, jobId, jobIdValid, rankingAttempt, handleLegalWall, returnUrl]);

    const matches = ranking.status === 'ready' ? ranking.matches : NO_MATCHES;
    const retryRanking = useCallback(() => setRankingAttempt((n) => n + 1), []);

    /* ===== Mutations ====================================================== */

    const [actionFeedback, setActionFeedback] = useState<{
        tone: FeedbackTone;
        message: string;
    } | null>(null);
    const [pendingStatus, setPendingStatus] = useState<WritableJobStatus | null>(null);
    const [editOpen, setEditOpen] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [confirmClose, setConfirmClose] = useState(false);
    const [closeError, setCloseError] = useState<string | null>(null);

    const handleSetJobStatus = useCallback(
        async (status: WritableJobStatus) => {
            if (!idToken || !job || pendingStatus) return;
            setPendingStatus(status);
            setActionFeedback(null);
            try {
                const updated = await updateJobStatus(idToken, job.id, status);
                setData((prev) => ({ ...prev, job: { ...prev.job, ...updated } }));
                setActionFeedback({ tone: 'success', message: tCommon('feedback.saved') });
            } catch (err) {
                // The old page had NO catch here: a failed status change left the
                // button spinning back to idle and the employer believing it worked.
                try {
                    handleLegalWall(err, returnUrl);
                } catch {
                    setActionFeedback({ tone: 'danger', message: errorMessage(err) });
                }
            } finally {
                setPendingStatus(null);
            }
        },
        [errorMessage, handleLegalWall, idToken, job, pendingStatus, returnUrl, setData, tCommon],
    );

    const handleJobUpdated = useCallback(
        (updated: EmployerJobDetail) => {
            setData((prev) => ({ ...prev, job: updated }));
            setEditOpen(false);
            setActionFeedback({ tone: 'success', message: tCommon('feedback.saved') });
        },
        [setData, tCommon],
    );

    const handlePublicListingChange = useCallback(
        (enabled: boolean) => {
            setData((prev) => ({ ...prev, job: { ...prev.job, public_listing_enabled: enabled } }));
        },
        [setData],
    );

    const handleDelete = useCallback(async () => {
        if (!idToken || !job || deleting) return;
        setDeleting(true);
        setDeleteError(null);
        try {
            await deleteJob(idToken, job.id);
            router.push(DASHBOARD_HREF);
        } catch (err) {
            setDeleteError(
                err instanceof ApiError && err.code === 'job_has_hired_workers'
                    ? t('actions.delete_error_hired')
                    : errorMessage(err),
            );
            setDeleting(false);
        }
    }, [deleting, errorMessage, idToken, job, router, t]);

    const handleConfirmClose = useCallback(async () => {
        if (!idToken || !job || pendingStatus) return;
        setCloseError(null);
        setActionFeedback(null);
        setPendingStatus('closed');
        try {
            const updated = await updateJobStatus(idToken, job.id, 'closed');
            setData((prev) => ({ ...prev, job: { ...prev.job, ...updated } }));
            setActionFeedback({ tone: 'success', message: tCommon('feedback.saved') });
            setConfirmClose(false);
        } catch (err) {
            try {
                handleLegalWall(err, returnUrl);
            } catch {
                // Failed close keeps the dialog open with the reason inline
                // (DeleteJobDialog contract).
                setCloseError(errorMessage(err));
            }
        } finally {
            setPendingStatus(null);
        }
    }, [errorMessage, handleLegalWall, idToken, job, pendingStatus, returnUrl, setData, tCommon]);

    /* ===== S0/S1 loading =================================================== */

    // Same shell and the same three skeleton bands as this route's `loading.tsx`,
    // so the handover from the server-rendered skeleton to this one is invisible.
    if (phase === 'auth' || phase === 'loading') {
        return (
            <AppShellSkeleton role="employer">
                <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                    <JobPageSkeleton />
                </main>
            </AppShellSkeleton>
        );
    }

    const backLink = (
        <Link
            href={DASHBOARD_HREF}
            className="mb-4 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)] hover:underline"
        >
            <span aria-hidden>&larr;</span>
            {t('back')}
        </Link>
    );

    /* ===== S5 failed load, split by kind =================================== */

    if (phase === 'error' && errorKind) {
        // Three outcomes the old page collapsed into one grey "Something went
        // wrong" line. `not_found` (a dead or mistyped link) and `forbidden`
        // (someone else's posting) are dead ends with their own copy and a way
        // back; everything else keeps the app-wide sentence and offers a retry.
        // ErrorState decides which of the two controls a kind may actually show,
        // so the kind stays honest instead of being bent to force a button.
        const isNotFound = errorKind === 'not_found' || errorKind === 'gone';
        const title = isNotFound
            ? t('not_found_title')
            : errorKind === 'forbidden'
              ? t('forbidden_title')
              : undefined;
        const body = isNotFound
            ? t('not_found_body')
            : errorKind === 'forbidden'
              ? t('forbidden_body')
              : undefined;

        return (
            // Chrome is preserved deliberately: `notFound()` from this client page
            // would swap the whole document for the 404 route and take the
            // employer's navigation with it, for what is one bad link.
            <AppShell role="employer" title={t('page_title')}>
                <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                    <div className="anim-fade-in">
                        {backLink}
                        <DashboardPanel>
                            <ErrorState
                                kind={errorKind}
                                onRetry={retry}
                                backHref={DASHBOARD_HREF}
                                title={title}
                                body={body}
                            />
                        </DashboardPanel>
                    </div>
                </main>
            </AppShell>
        );
    }

    /* ===== S2 loaded ======================================================= */

    if (!job) return null;

    const openCount = job.open_count ?? Math.max(0, job.number_of_workers_needed - job.hired_count);
    const notSpecified = t('job.not_specified');

    const jobTypeLabels: Record<string, string> = {
        'full-time': tShared('modal.job_type_fulltime'),
        'part-time': tShared('modal.job_type_parttime'),
        contract: tShared('modal.job_type_contract'),
    };
    const docLabels: Record<string, string> = {
        resume: tShared('worker_profile.doc_resume'),
        driver_license: tShared('worker_profile.doc_driver_license'),
        // SSN is no longer offered for new jobs, but legacy jobs may still require it.
        ssn: tShared('worker_profile.doc_ssn'),
    };

    const num = (value: string) => <span className="tabular-nums">{value}</span>;

    const fields: KVItem[] = [
        { label: tShared('modal.location'), value: job.location },
        {
            label: tShared('modal.job_type'),
            value: jobTypeLabels[job.job_type] ?? job.job_type,
        },
        {
            label: tShared('modal.trade_category'),
            value: job.trade_category ? tShared(`modal.trade.${job.trade_category}`) : notSpecified,
        },
        { label: t('job.pay_range'), value: job.pay ? num(job.pay) : notSpecified },
        {
            label: tShared('modal.start_date'),
            value: (() => {
                const formatted = formatStartDate(job.start_date, locale);
                return formatted ? num(formatted) : notSpecified;
            })(),
        },
        { label: tShared('modal.expected_duration'), value: job.expected_duration ?? notSpecified },
        { label: tShared('modal.shift_schedule'), value: job.shift_schedule ?? notSpecified },
        {
            label: tShared('modal.transportation_required'),
            value: job.transportation_required ? t('job.yes') : t('job.no'),
        },
        {
            label: tShared('modal.work_authorization_required'),
            value: job.work_authorization_required ? t('job.yes') : t('job.no'),
        },
        {
            label: tShared('modal.language_preference'),
            value: job.language_preference.map((lang) => tShared(`modal.language.${lang}`)).join(', '),
        },
        {
            label: tShared('modal.number_of_workers_needed'),
            value: num(String(job.number_of_workers_needed)),
        },
        {
            label: t('job.hiring_progress'),
            value: num(
                t('job.hiring_progress_value', {
                    hired: job.hired_count,
                    total: job.number_of_workers_needed,
                    open: openCount,
                }),
            ),
        },
        {
            label: tShared('modal.required_experience_years'),
            value:
                job.required_experience_years === null
                    ? notSpecified
                    : num(String(job.required_experience_years)),
        },
    ];

    const filtersActive = hasActiveApplicantFilters(appliedFilters);
    const statusBusy = pendingStatus !== null;

    return (
        <>
            <AppShell role="employer" title={job.title} subtitle={job.location}>
                <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                    <div className="anim-fade-in">
                        {backLink}

                        {/* S6: a failed background reload is a footnote over data the
                            employer can still read, never a replacement for it. */}
                        {refreshError ? (
                            <InlineFeedback tone="warning" className="mb-4">
                                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <span>{tCommon('feedback.refresh_failed')}</span>
                                    <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                                        {tCommon('retry')}
                                    </Button>
                                </span>
                            </InlineFeedback>
                        ) : null}

                        {actionFeedback ? (
                            <InlineFeedback
                                tone={actionFeedback.tone}
                                className="mb-4"
                                onDismiss={() => setActionFeedback(null)}
                            >
                                {actionFeedback.message}
                            </InlineFeedback>
                        ) : null}

                        <div
                            className={['space-y-5', staggerClass].filter(Boolean).join(' ')}
                            onAnimationEnd={onCascadeEnd}
                        >
                            <section className="grid grid-cols-3 gap-3">
                                <MetricCard label={t('metrics.applicants')} value={job.applicant_count} />
                                <MetricCard label={t('metrics.hired')} value={job.hired_count} tone="green" />
                                <MetricCard label={t('metrics.open')} value={openCount} />
                            </section>

                            <DashboardPanel>
                                <PanelHeader
                                    title={t('job.panel_title')}
                                    action={
                                        <JobStatusBadge status={job.status}>
                                            {tShared(`jobs.status.${job.status}`)}
                                        </JobStatusBadge>
                                    }
                                />

                                <div className="px-5 py-2">
                                    <KVList items={fields} />
                                </div>

                                <div className="space-y-4 border-t border-[var(--jale-divider)] px-5 py-4">
                                    <FactBlock title={t('job.description_title')}>
                                        <p className="whitespace-pre-wrap text-sm text-[var(--jale-ink)]">
                                            {job.description?.trim() || t('job.no_description')}
                                        </p>
                                    </FactBlock>

                                    {job.certifications.length > 0 ? (
                                        <FactBlock title={t('job.certifications_title')}>
                                            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                                                {job.certifications.map((cert) => (
                                                    <Badge key={cert} tone="info">
                                                        {cert}
                                                    </Badge>
                                                ))}
                                            </div>
                                        </FactBlock>
                                    ) : null}

                                    <FactBlock title={t('job.required_documents_title')}>
                                        {job.required_docs.length > 0 ? (
                                            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                                                {job.required_docs.map((doc) => (
                                                    <Badge key={doc} tone="info">
                                                        {docLabels[doc] ?? doc}
                                                    </Badge>
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="text-sm text-[var(--jale-ink-2)]">
                                                {t('job.no_required_documents')}
                                            </p>
                                        )}
                                    </FactBlock>
                                </div>

                                <div className="flex flex-wrap gap-2 border-t border-[var(--jale-divider)] px-5 py-4">
                                    {/* The manual "Pause" action is intentionally absent
                                        (backend status support and the paused-state resume
                                        UI stay, for billing-auto-paused jobs). */}
                                    {job.status !== 'active' ? (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => void handleSetJobStatus('active')}
                                            disabled={statusBusy}
                                            loading={pendingStatus === 'active'}
                                            loadingLabel={tCommon('loading')}
                                        >
                                            {t('actions.activate')}
                                        </Button>
                                    ) : null}
                                    {job.status !== 'closed' ? (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => {
                                                setCloseError(null);
                                                setConfirmClose(true);
                                            }}
                                            disabled={statusBusy}
                                            loading={pendingStatus === 'closed'}
                                            loadingLabel={tCommon('loading')}
                                        >
                                            {t('actions.close')}
                                        </Button>
                                    ) : null}
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setEditOpen(true)}
                                        disabled={statusBusy}
                                    >
                                        {t('actions.edit')}
                                    </Button>
                                    <Button
                                        variant="error"
                                        size="sm"
                                        onClick={() => setConfirmDelete(true)}
                                        disabled={statusBusy}
                                    >
                                        {t('actions.delete')}
                                    </Button>
                                </div>
                            </DashboardPanel>

                            <PublicListingCard
                                key={job.id}
                                jobId={job.id}
                                initialEnabled={job.public_listing_enabled}
                                jobStatus={job.status}
                                jobTitle={job.title}
                                publicCode={job.public_code}
                                onEnabledChange={handlePublicListingChange}
                            />

                            <DashboardPanel>
                                <PanelHeader
                                    title={t('applicants.title')}
                                    action={
                                        refreshing ? (
                                            <Spinner size="sm" label={tCommon('loading')} />
                                        ) : undefined
                                    }
                                />

                                <ApplicantFilterPanel filters={filters} onChange={applyFilters} />

                                {applicants.length > 0 ? (
                                    <RankingNotice
                                        ranking={ranking}
                                        onRetry={retryRanking}
                                        labels={{
                                            loading: t('ranking.loading'),
                                            empty: t('ranking.empty'),
                                            failed: t('ranking.failed'),
                                            retry: t('ranking.retry'),
                                        }}
                                    />
                                ) : null}

                                {applicants.length === 0 ? (
                                    filtersActive ? (
                                        // Reads differently on purpose: rows exist, the
                                        // filters are hiding them, and the only useful
                                        // action is undoing the filters.
                                        <EmptyState
                                            variant="filtered"
                                            title={t('applicants.filtered_title')}
                                            body={t('applicants.filtered_body')}
                                            action={{
                                                label: t('applicants.clear_filters'),
                                                onClick: () => applyFilters(EMPTY_APPLICANT_FILTERS),
                                            }}
                                        />
                                    ) : (
                                        <EmptyState
                                            icon="user"
                                            title={t('applicants.empty_title')}
                                            body={t('applicants.empty_body')}
                                        />
                                    )
                                ) : (
                                    <ul className="divide-y divide-[var(--jale-divider)]">
                                        {applicants.map((applicant) => (
                                            <ApplicantRow
                                                key={applicant.application_id}
                                                applicant={applicant}
                                                match={
                                                    matches.get(applicant.application_id) ??
                                                    matches.get(applicant.worker_id)
                                                }
                                                jobId={job.id}
                                                jobTitle={job.title}
                                                locale={locale}
                                                t={t}
                                                tShared={tShared}
                                                tMessages={tMessages}
                                                tMatch={tMatch}
                                            />
                                        ))}
                                    </ul>
                                )}
                            </DashboardPanel>
                        </div>
                    </div>
                </main>
            </AppShell>

            <DeleteJobDialog
                open={confirmDelete}
                jobTitle={job.title}
                deleting={deleting}
                error={deleteError}
                onCancel={() => {
                    if (deleting) return;
                    setConfirmDelete(false);
                    setDeleteError(null);
                }}
                onConfirm={handleDelete}
            />

            <CloseJobDialog
                open={confirmClose}
                jobTitle={job.title}
                closing={pendingStatus === 'closed'}
                error={closeError}
                onCancel={() => {
                    if (pendingStatus === 'closed') return;
                    setConfirmClose(false);
                    setCloseError(null);
                }}
                onConfirm={handleConfirmClose}
            />

            {/* Mounted, not conditionally rendered: `Modal` drives focus-in and
                focus-restore off the `open` transition, and a Modal that mounts
                already-open never moves focus into itself. */}
            <EditJobModal
                open={editOpen}
                job={job}
                onClose={() => setEditOpen(false)}
                onJobUpdated={handleJobUpdated}
            />
        </>
    );
}

/* ===== Pieces ============================================================ */

/**
 * The page's one skeleton: back link, metric band, detail panel, applicant
 * list -- in that order, because that is the order the loaded page paints them.
 * `DetailPageSkeleton`'s own `withBackLink` line sits inside its region, which
 * would put the link BELOW the metrics and cost a jump at handover.
 */
function JobPageSkeleton() {
    return (
        <>
            <Skeleton className="mb-4 h-3.5 w-24" />
            <div className="mb-5">
                <MetricRowSkeleton count={3} />
            </div>
            <DetailPageSkeleton fields={8} />
            <div className="mt-5">
                <ListPageSkeleton rows={4} />
            </div>
        </>
    );
}

function FactBlock({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
                {title}
            </p>
            {children}
        </div>
    );
}

/**
 * The ranking section's own visible state, scoped to the applicants panel.
 *
 * `ready` with scores renders nothing here -- the scores themselves are the
 * feedback, on the rows. The other three all say something, because all three
 * mean the scores are missing for a reason the employer deserves to know.
 */
function RankingNotice({
    ranking,
    onRetry,
    labels,
}: {
    ranking: RankingState;
    onRetry: () => void;
    labels: { loading: string; empty: string; failed: string; retry: string };
}) {
    if (ranking.status === 'loading') {
        return (
            <div
                role="status"
                className="flex items-center gap-2 border-b border-[var(--jale-divider)] px-5 py-3 text-xs font-medium text-[var(--jale-ink-2)]"
            >
                <Spinner size="sm" />
                <span>{labels.loading}</span>
            </div>
        );
    }

    if (ranking.status === 'failed') {
        return (
            <div className="border-b border-[var(--jale-divider)] px-5 py-3">
                <InlineFeedback tone="warning">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span>{labels.failed}</span>
                        <Button variant="ghost" size="sm" onClick={onRetry}>
                            {labels.retry}
                        </Button>
                    </span>
                </InlineFeedback>
            </div>
        );
    }

    if (ranking.matches.size === 0) {
        return (
            <p
                role="status"
                className="border-b border-[var(--jale-divider)] px-5 py-3 text-xs font-medium text-[var(--jale-ink-2)]"
            >
                {labels.empty}
            </p>
        );
    }

    return null;
}

/** Availability values the API returns, mapped onto `filters.availability_*`. */
const AVAILABILITY_KEYS = new Set([
    'immediate',
    '2weeks',
    '1month',
    'full_time',
    'part_time',
    'weekends',
    'flexible',
]);

function normalizeAvailabilityKey(value: string): string | null {
    const key = value.trim().toLowerCase().replace(/-/g, '_');
    const collapsed = key === '2_weeks' ? '2weeks' : key === '1_month' ? '1month' : key;
    return AVAILABILITY_KEYS.has(collapsed) ? collapsed : null;
}

function ApplicantRow({
    applicant,
    match,
    jobId,
    jobTitle,
    locale,
    t,
    tShared,
    tMessages,
    tMatch,
}: {
    applicant: Applicant;
    match?: ApplicantMatch;
    jobId: string;
    jobTitle: string;
    locale: string;
    t: ReturnType<typeof useTranslations>;
    tShared: ReturnType<typeof useTranslations>;
    tMessages: ReturnType<typeof useTranslations>;
    tMatch: ReturnType<typeof useTranslations>;
}) {
    const { idToken } = useAuth();
    const router = useRouter();
    const errorMessage = useErrorMessage();
    const tReq = useTranslations('job_requirements');
    const [starting, setStarting] = useState(false);
    const [messageError, setMessageError] = useState<string | null>(null);

    const displayName = applicant.full_name?.trim() || t('applicants.unknown_name');
    const appliedLabel = formatLongDate(applicant.applied_at, locale) ?? applicant.applied_at;
    const availabilityKey = applicant.availability
        ? normalizeAvailabilityKey(applicant.availability)
        : null;
    // `?? []`/`?? undefined` throughout: the currently-deployed applicants
    // handler does not select `application_answers`/`not_provided` yet, so
    // an absent value must render nothing, never crash the row.
    const answers = answerEntries(applicant.application_answers, tReq);
    const notProvided = applicant.not_provided ?? [];

    async function handleMessageWorker() {
        if (!idToken || starting) return;
        setStarting(true);
        setMessageError(null);
        try {
            const response = await startConversation(idToken, {
                job_id: jobId,
                worker_id: applicant.worker_id,
                initial_message: tMessages('default_initial_message', { jobTitle }),
            });
            router.push(`/employer/conversations?conversation_id=${response.conversation.id}`);
        } catch (err) {
            // `worker_whatsapp_unavailable` is a domain answer with a better
            // sentence than any generic one; everything else is classified so a
            // raw backend code never reaches the screen.
            const code = err instanceof ApiError ? err.code : null;
            setMessageError(
                code === 'worker_whatsapp_unavailable'
                    ? tMessages('worker_whatsapp_unavailable')
                    : errorMessage(err, { unknown: tMessages('message_start_failed') }),
            );
        } finally {
            setStarting(false);
        }
    }

    return (
        <li className="flex flex-col gap-3 px-5 py-4">
            <div className="flex items-start gap-3">
                <InitialsAvatar name={displayName} size={36} />

                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <p className="min-w-0 truncate text-sm font-bold text-[var(--jale-ink)]">
                            {displayName}
                        </p>
                        <ApplicationStatusBadge status={applicant.status}>
                            {tShared(`applicants.status.${applicant.status}`)}
                        </ApplicationStatusBadge>
                    </div>

                    <p className="mt-1 text-xs text-[var(--jale-ink-2)]">
                        {t('applicants.applied')}{' '}
                        <span className="tabular-nums">{appliedLabel}</span>
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                        {match ? (
                            <MatchScoreBadge
                                score={match.match_score}
                                band={match.score_band}
                                label={tMatch(`score_bands.${match.score_band}`)}
                            />
                        ) : null}
                        {availabilityKey ? (
                            <Badge tone="neutral">{t(`filters.availability_${availabilityKey}`)}</Badge>
                        ) : null}
                        {applicant.years_experience !== null ? (
                            <Badge tone="neutral">
                                <span className="tabular-nums">
                                    {tShared('worker_profile.years_experience', {
                                        years: applicant.years_experience,
                                    })}
                                </span>
                            </Badge>
                        ) : null}
                        {applicant.skills.map((skill) => (
                            <Badge key={skill} tone="info">
                                {skill}
                            </Badge>
                        ))}
                    </div>

                    {match && match.match_reasons.length > 0 ? (
                        <div className="mt-2">
                            <MatchReasonChips reasons={match.match_reasons} />
                        </div>
                    ) : null}

                    {(answers.length > 0 || notProvided.length > 0) ? (
                        <div className="mt-3 rounded-[10px] border border-[var(--jale-divider)] p-3">
                            {answers.length > 0 ? (
                                <>
                                    <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
                                        {tReq('employer.answers_title')}
                                    </p>
                                    <KVList
                                        items={answers.map(({ key, value }) => ({
                                            label: tReq(`fields.${key}`),
                                            value,
                                        }))}
                                    />
                                </>
                            ) : null}
                            {notProvided.length > 0 ? (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {notProvided.map((key) => (
                                        <Badge key={key} tone="neutral">
                                            {tReq(`fields.${key}`)} · {tReq('employer.not_provided')}
                                        </Badge>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            </div>

            {messageError ? (
                <InlineFeedback tone="danger" onDismiss={() => setMessageError(null)}>
                    {messageError}
                </InlineFeedback>
            ) : null}

            <div className="flex flex-wrap gap-2 sm:pl-[3rem]">
                <Link
                    href={`/employer/workers/${applicant.worker_id}?job_id=${jobId}`}
                    className="inline-flex h-9 items-center justify-center rounded-full border border-[var(--jale-divider)] px-4 text-xs font-semibold leading-none text-[var(--jale-ink)] transition-colors duration-150 hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                >
                    {t('applicants.view_profile')}
                </Link>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void handleMessageWorker()}
                    loading={starting}
                    loadingLabel={tMessages('starting')}
                >
                    {tMessages('message_worker')}
                </Button>
            </div>
        </li>
    );
}

function buildCandidateMatchMap(
    candidates: Array<{
        application_id?: string | null;
        worker_id: string;
        match_score: number;
        score_band: ScoreBand;
        match_reasons?: string[];
    }>,
): Map<string, ApplicantMatch> {
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
