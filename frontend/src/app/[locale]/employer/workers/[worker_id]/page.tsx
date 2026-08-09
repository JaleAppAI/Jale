'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { usePageData } from '@/hooks/usePageData';
import { useErrorMessage } from '@/hooks/useErrorMessage';
import { AppShell } from '@/components/layout/AppShell';
import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { ApplicationStatusBadge, Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { ErrorState } from '@/components/ui/error-state';
import { Icon } from '@/components/ui/icon';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineFeedback, type FeedbackTone } from '@/components/ui/inline-feedback';
import { KVList, type KVItem } from '@/components/ui/kv-list';
import { DetailPageSkeleton } from '@/components/ui/page-skeletons';
import { PanelHeader } from '@/components/ui/panel-header';
import { Select } from '@/components/ui/select';
import {
    createUploadToken,
    getWorkerDocuments,
    getWorkerProfile,
    updateApplicantStatus,
    type ApplicationStatus,
    type WorkerDocument,
    type WorkerProfile,
} from '@/lib/api/employer';
import { normalizeApplicationStatus } from '@/lib/status';

export const dynamic = 'force-dynamic';

type DocType = 'resume' | 'driver_license' | 'ssn';
const ALL_DOC_TYPES: DocType[] = ['resume', 'driver_license', 'ssn'];
const APPLICATION_STATUSES: ApplicationStatus[] = [
    'pending',
    'contacted',
    'talking',
    'hired',
    'not_interested',
];

/** Both ids are `UUID` columns (`jobs.id`, `users.id`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long "Link copied" stays on the share button before reverting. */
const COPIED_RESET_MS = 3000;

/** What one load of this page consists of: the applicant, and their documents. */
type ApplicantView = {
    profile: WorkerProfile;
    documents: WorkerDocument[];
};

/**
 * Anchors styled as buttons.
 *
 * `Button` renders a `<button>`, and the document actions are real navigations
 * to a presigned S3 URL (open in a tab / download), so they must be anchors.
 * These two recipes mirror `button.tsx`'s primary/ghost output at `size="sm"`.
 * Same escape hatch, and same TODO, as `StateAction` in `ui/empty-state`.
 */
const DOC_ACTION_BASE = [
    'inline-flex h-9 items-center justify-center gap-2 rounded-full px-4',
    'text-xs font-semibold leading-none whitespace-nowrap select-none',
    'transition-all duration-150 active:scale-[0.98]',
    'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
].join(' ');

const DOC_ACTION_PRIMARY =
    'bg-[var(--jale-blue-500)] text-white hover:bg-[var(--jale-blue-600)] shadow-[var(--shadow-btn)]';

const DOC_ACTION_GHOST =
    'border border-[var(--jale-divider)] bg-transparent text-[var(--jale-ink)] hover:bg-[var(--jale-paper-2)]';

export default function WorkerProfilePage() {
    const t = useTranslations('employer_worker_profile');
    // `employer_dashboard` is read-only here. It owns two pieces of shared
    // vocabulary this page must speak in the same words as the applicant list
    // and the job modals: `applicants.status.*` and the four
    // `worker_profile.*` keys those surfaces also read.
    const tShared = useTranslations('employer_dashboard');
    const tCommon = useTranslations('common');
    const errorMessage = useErrorMessage();

    const { idToken } = useAuth();
    const { handleLegalWall } = useRequireAuth();
    const params = useParams();
    const searchParams = useSearchParams();

    const workerId = (params.worker_id as string | undefined)?.trim() ?? '';
    const jobId = (searchParams.get('job_id') ?? '').trim();

    /*
     * S9: this page is only meaningful inside a job. Without a well-formed
     * `job_id` there is nothing to scope the applicant to, no back destination
     * that makes sense, and no request worth sending -- so the link itself is
     * the failure, and it gets its own state rather than a red line over a
     * blank page. Validating the shape (not just presence) also keeps an
     * arbitrary query value out of the request URL these ids are interpolated
     * into.
     */
    const linkValid = UUID_RE.test(workerId) && UUID_RE.test(jobId);

    const jobHref = `/employer/jobs/${jobId}`;
    const returnUrl = `/employer/workers/${workerId}?job_id=${jobId}`;

    const { phase, data, errorKind, retry, setData } = usePageData<ApplicantView>({
        // `signal` aborts on unmount and on a deps change, and both reads
        // forward it, so an abandoned navigation cancels the requests instead
        // of leaving them to finish unwatched. usePageData's request fencing
        // still backstops a response that races the abort.
        fetcher: async ({ token, signal }) => {
            // Unreachable while `linkValid` is false -- the render short-circuits
            // to the invalid-link state -- but the fetcher is the only place that
            // can guarantee no doomed request is ever sent.
            if (!linkValid) throw new Error('invalid_link');
            const [profile, docs] = await Promise.all([
                getWorkerProfile(token, workerId, jobId, signal),
                getWorkerDocuments(token, workerId, jobId, signal),
            ]);
            return { profile, documents: docs.documents };
        },
        legalReturnUrl: returnUrl,
        deps: [workerId, jobId, linkValid],
    });

    const profile = data?.profile ?? null;
    const documents = data?.documents ?? [];

    /*
     * The select is a draft over the loaded status rather than a second copy of
     * it: `null` means "showing what the server last told us". A save clears the
     * draft, so the control follows the data instead of drifting from it.
     */
    const [statusDraft, setStatusDraft] = useState<ApplicationStatus | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveFeedback, setSaveFeedback] = useState<{ tone: FeedbackTone; message: string } | null>(
        null,
    );

    const [sharingLink, setSharingLink] = useState(false);
    const [copied, setCopied] = useState(false);
    const [shareError, setShareError] = useState<string | null>(null);
    const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        },
        [],
    );

    const savedStatus = profile ? normalizeApplicationStatus(profile.application_status) : 'pending';
    const selectedStatus = statusDraft ?? savedStatus;

    const handleShareLink = useCallback(async () => {
        if (!idToken || !linkValid) return;
        setSharingLink(true);
        setShareError(null);
        try {
            const { upload_url } = await createUploadToken(idToken, jobId, workerId);
            await navigator.clipboard.writeText(upload_url);
            setCopied(true);
            if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
            copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
        } catch (err) {
            try {
                handleLegalWall(err, returnUrl);
            } catch {
                // Never `err.message`: that is a backend code, untranslated.
                setShareError(errorMessage(err));
            }
        } finally {
            setSharingLink(false);
        }
    }, [errorMessage, handleLegalWall, idToken, jobId, linkValid, returnUrl, workerId]);

    const handleSaveStatus = useCallback(async () => {
        if (!idToken || !linkValid || !profile) return;
        if (statusDraft === null || statusDraft === savedStatus) return;

        setSaving(true);
        setSaveFeedback(null);
        try {
            const updated = await updateApplicantStatus(idToken, jobId, workerId, statusDraft);
            const applied = updated.status ?? statusDraft;
            setData((prev) => ({ ...prev, profile: { ...prev.profile, application_status: applied } }));
            setStatusDraft(null);
            setSaveFeedback({ tone: 'success', message: tCommon('feedback.saved') });
        } catch (err) {
            try {
                handleLegalWall(err, returnUrl);
            } catch {
                setSaveFeedback({ tone: 'danger', message: errorMessage(err) });
            }
        } finally {
            setSaving(false);
        }
    }, [
        errorMessage,
        handleLegalWall,
        idToken,
        jobId,
        linkValid,
        profile,
        returnUrl,
        savedStatus,
        setData,
        statusDraft,
        tCommon,
        workerId,
    ]);

    const docLabel: Record<DocType, string> = {
        resume: tShared('worker_profile.doc_resume'),
        driver_license: tShared('worker_profile.doc_driver_license'),
        ssn: tShared('worker_profile.doc_ssn'),
    };

    const availabilityLabel = (value: WorkerProfile['availability']) => {
        if (!value) return t('fallback_availability');
        const key = value.replaceAll('-', '_');
        if (
            ['immediate', '2_weeks', '1_month', 'full_time', 'part_time', 'weekends', 'flexible'].includes(
                key,
            )
        ) {
            return t(`availability.${key}`);
        }
        return value;
    };

    const tradeLabel = (
        trade: WorkerProfile['main_trade'],
        tradeOther: WorkerProfile['main_trade_other'],
    ) => {
        if (!trade) return t('fallback_trade');
        if (trade === 'other') return tradeOther || t('trades.other');
        const knownTrades = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting'];
        if (knownTrades.includes(trade)) return t(`trades.${trade}`);
        return trade;
    };

    const displayName = profile?.full_name?.trim() || t('fallback_name');
    const skills = profile?.skills ?? [];
    const appliedAt = profile?.applied_at ? profile.applied_at.slice(0, 10) : t('fallback_applied');
    const yearsExperience = profile?.years_experience ?? null;
    const shellSubtitle = profile ? tradeLabel(profile.main_trade, profile.main_trade_other) : undefined;

    const fields: KVItem[] = profile
        ? [
              { label: t('phone'), value: profile.phone || t('fallback_phone') },
              {
                  label: t('location'),
                  value: profile.city || profile.location || t('fallback_location'),
              },
              {
                  label: t('experience'),
                  value:
                      yearsExperience === null ? (
                          t('fallback_experience')
                      ) : (
                          <span className="tabular-nums">
                              {tShared('worker_profile.years_experience', { years: yearsExperience })}
                          </span>
                      ),
              },
              { label: t('availability_label'), value: availabilityLabel(profile.availability) },
              {
                  label: t('trade'),
                  value: tradeLabel(profile.main_trade, profile.main_trade_other),
              },
              // The row is omitted rather than blanked when the worker never
              // answered: an empty value reads as "no transportation".
              ...(profile.has_transportation === null || profile.has_transportation === undefined
                  ? []
                  : [
                        {
                            label: t('transportation'),
                            value: profile.has_transportation
                                ? t('transportation_yes')
                                : t('transportation_no'),
                        },
                    ]),
          ]
        : [];

    const shareDisabled = !idToken || !linkValid;
    const saveDisabled = saving || !idToken || !linkValid || !profile || statusDraft === null
        || statusDraft === savedStatus;

    /* ===== S9 invalid link ================================================= */

    if (!linkValid) {
        return (
            // The header names the real problem. `fallback_name` ("Unknown
            // worker") would blame the applicant for a broken URL.
            <AppShell role="employer" title={t('invalid_link.title')}>
                <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
                    <DashboardPanel className="anim-fade-in">
                        <ErrorState
                            // `not_found` is the kind whose copy this overrides AND
                            // whose shape offers a back action with no retry --
                            // exactly right for a link no retry can repair.
                            kind="not_found"
                            title={t('invalid_link.title')}
                            body={t('invalid_link.body')}
                            backHref="/employer/dashboard"
                        />
                    </DashboardPanel>
                </div>
            </AppShell>
        );
    }

    /* ===== S0/S1 loading =================================================== */

    // Same shell and same archetype as this route's `loading.tsx`, so the
    // handover from the server-rendered skeleton to this one is invisible.
    if (phase === 'auth' || phase === 'loading') {
        return (
            <AppShellSkeleton role="employer">
                <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
                    <DetailPageSkeleton withBackLink />
                </div>
            </AppShellSkeleton>
        );
    }

    const backLink = (
        <Link
            href={jobHref}
            className="mb-4 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)] hover:underline"
        >
            <span aria-hidden>&larr;</span>
            {t('back')}
        </Link>
    );

    /* ===== S5 failed load ================================================== */

    if (phase === 'error' && errorKind) {
        // Three outcomes the old page collapsed into one sentence. `not_found`
        // and `forbidden` get their own copy and a back action; everything else
        // keeps the app-wide sentence and offers a retry. ErrorState decides
        // which of the two controls a kind is actually allowed to show.
        const title =
            errorKind === 'not_found'
                ? t('not_found.title')
                : errorKind === 'forbidden'
                  ? t('forbidden.title')
                  : undefined;
        const body =
            errorKind === 'not_found'
                ? t('not_found.body')
                : errorKind === 'forbidden'
                  ? t('forbidden.body')
                  : undefined;

        return (
            <AppShell role="employer" title={t('fallback_name')}>
                <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
                    <div className="anim-fade-in">
                        {backLink}
                        <DashboardPanel>
                            <ErrorState
                                kind={errorKind}
                                onRetry={retry}
                                backHref={jobHref}
                                title={title}
                                body={body}
                            />
                        </DashboardPanel>
                    </div>
                </div>
            </AppShell>
        );
    }

    /* ===== S2 loaded ======================================================= */

    return (
        <AppShell role="employer" title={displayName} subtitle={shellSubtitle}>
            <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
                <div className="anim-fade-in">
                    {backLink}

                    {profile && (
                        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                            <div className="space-y-5">
                                <DashboardPanel>
                                    <div className="flex items-center gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
                                        <InitialsAvatar name={displayName} size={44} />
                                        <div className="min-w-0">
                                            <h2 className="truncate text-base font-extrabold tracking-[-0.01em] text-[var(--jale-ink)]">
                                                {displayName}
                                            </h2>
                                            <div className="mt-1">
                                                <ApplicationStatusBadge status={savedStatus}>
                                                    {tShared(`applicants.status.${savedStatus}`)}
                                                </ApplicationStatusBadge>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="px-5 py-2">
                                        <KVList items={fields} />
                                    </div>
                                </DashboardPanel>

                                <DashboardPanel>
                                    <PanelHeader title={t('skills')} />
                                    <div className="px-5 py-4">
                                        {skills.length > 0 ? (
                                            <div className="flex flex-wrap gap-x-4 gap-y-2">
                                                {skills.map((skill) => (
                                                    <Badge key={skill} tone="info">
                                                        {skill}
                                                    </Badge>
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="text-sm text-[var(--jale-ink-2)]">
                                                {t('fallback_skills')}
                                            </p>
                                        )}
                                    </div>
                                </DashboardPanel>
                            </div>

                            <DashboardPanel className="self-start">
                                <PanelHeader
                                    title={t('documents')}
                                    action={
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={handleShareLink}
                                            disabled={shareDisabled}
                                            loading={sharingLink}
                                            loadingLabel={tCommon('loading')}
                                        >
                                            {copied ? t('link_copied') : t('share_upload_link')}
                                        </Button>
                                    }
                                />

                                {shareError && (
                                    <div className="px-5 pt-4">
                                        <InlineFeedback tone="danger" onDismiss={() => setShareError(null)}>
                                            {shareError}
                                        </InlineFeedback>
                                    </div>
                                )}

                                <ul className="divide-y divide-[var(--jale-divider)]">
                                    {ALL_DOC_TYPES.map((type) => {
                                        const doc = documents.find((entry) => entry.doc_type === type);
                                        return (
                                            <li
                                                key={type}
                                                className="flex items-start justify-between gap-3 px-5 py-4"
                                            >
                                                <div className="flex min-w-0 items-start gap-3">
                                                    {/* The slot's whole state in one tile: the
                                                        semantic -bg/-text pairs are the only two
                                                        tints that stay legible in both themes. */}
                                                    <span
                                                        aria-hidden
                                                        className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                                                            doc
                                                                ? 'bg-[var(--jale-success-bg)] text-[var(--jale-success-text)]'
                                                                : 'bg-[var(--jale-danger-bg)] text-[var(--jale-danger-text)]'
                                                        }`}
                                                    >
                                                        <Icon name={doc ? 'check' : 'alert'} />
                                                    </span>

                                                    <div className="min-w-0">
                                                        <p className="text-sm font-semibold text-[var(--jale-ink)]">
                                                            {docLabel[type]}
                                                        </p>
                                                        {doc ? (
                                                            // The size never gets truncated away: it is
                                                            // the one part of this line a reader scans
                                                            // for, and a long filename would otherwise
                                                            // eat it whole in the narrow column.
                                                            <p className="mt-0.5 flex items-baseline gap-1 text-xs text-[var(--jale-ink-2)]">
                                                                <span className="truncate">{doc.file_name}</span>
                                                                <span className="shrink-0 tabular-nums">
                                                                    {' - '}
                                                                    {Math.round(doc.file_size / 1024)} KB
                                                                </span>
                                                            </p>
                                                        ) : (
                                                            <p className="mt-0.5 text-xs font-semibold text-[var(--jale-danger-text)]">
                                                                {t('not_uploaded')}
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                {doc ? (
                                                    <div className="flex shrink-0 gap-2">
                                                        <a
                                                            href={doc.url}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className={`${DOC_ACTION_BASE} ${DOC_ACTION_PRIMARY}`}
                                                        >
                                                            {t('view')}
                                                        </a>
                                                        <a
                                                            href={doc.url}
                                                            download={doc.file_name}
                                                            className={`${DOC_ACTION_BASE} ${DOC_ACTION_GHOST}`}
                                                        >
                                                            {t('download')}
                                                        </a>
                                                    </div>
                                                ) : (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="shrink-0"
                                                        onClick={handleShareLink}
                                                        disabled={shareDisabled}
                                                        loading={sharingLink}
                                                        loadingLabel={tCommon('loading')}
                                                    >
                                                        {t('request')}
                                                    </Button>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </DashboardPanel>
                        </div>
                    )}

                    <DashboardPanel className="mt-5">
                        {/* `items-start` rather than `items-end`: the feedback below
                            the control grows downward, and an end-aligned row would
                            drag the applied date down with it on every save. */}
                        <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                                <p className="text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)]">
                                    {t('applied')}
                                </p>
                                <p className="mt-1 text-sm font-medium tabular-nums text-[var(--jale-ink)]">
                                    {appliedAt}
                                </p>
                            </div>

                            <div className="flex min-w-0 flex-col gap-2 sm:items-end">
                                <div className="flex flex-wrap items-end gap-2">
                                    <div className="w-full sm:w-56">
                                        <label
                                            htmlFor="applicant-status"
                                            className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)]"
                                        >
                                            {t('status_label')}
                                        </label>
                                        <Select
                                            id="applicant-status"
                                            value={selectedStatus}
                                            disabled={saving}
                                            onChange={(event) =>
                                                setStatusDraft(event.target.value as ApplicationStatus)
                                            }
                                        >
                                            {APPLICATION_STATUSES.map((status) => (
                                                <option key={status} value={status}>
                                                    {tShared(`applicants.status.${status}`)}
                                                </option>
                                            ))}
                                        </Select>
                                    </div>
                                    <Button
                                        onClick={handleSaveStatus}
                                        disabled={saveDisabled}
                                        loading={saving}
                                        loadingLabel={t('saving_status')}
                                    >
                                        {t('save_status')}
                                    </Button>
                                </div>

                                {/* Scoped to the control that produced it: the old
                                    page put every failure in one line at the top of
                                    the page, far from the thing that failed. */}
                                {saveFeedback && (
                                    <InlineFeedback
                                        tone={saveFeedback.tone}
                                        onDismiss={() => setSaveFeedback(null)}
                                    >
                                        {saveFeedback.message}
                                    </InlineFeedback>
                                )}
                            </div>
                        </div>
                    </DashboardPanel>
                </div>
            </div>
        </AppShell>
    );
}
