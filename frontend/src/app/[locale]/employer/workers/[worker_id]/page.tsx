'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
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
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineFeedback, type FeedbackTone } from '@/components/ui/inline-feedback';
import { KVList, type KVItem } from '@/components/ui/kv-list';
import { DetailPageSkeleton } from '@/components/ui/page-skeletons';
import { PanelHeader } from '@/components/ui/panel-header';
import { ProgressRow } from '@/components/ui/progress-row';
import { Select } from '@/components/ui/select';
import { MediaBoardGrid } from '@/components/media-board/MediaBoardGrid';
import { PostLightbox } from '@/components/media-board/PostLightbox';
import {
    ApiError,
    createUploadToken,
    getEmployerWorkerPosts,
    getWorkerDocuments,
    getWorkerProfile,
    updateApplicantStatus,
    type ApplicationStatus,
    type WorkerDocument,
    type WorkerProfile,
} from '@/lib/api/employer';
import type { WorkerPost } from '@/lib/api/worker';
import { normalizeApplicationStatus } from '@/lib/status';
import {
    canRequestDetails,
    canResendDetails,
    detailsRequestFeedbackKey,
    detailsRequestFeedbackTone,
    hireBlockReason,
    remainingCount,
    statusSelectOptions,
} from '@/lib/hire-gate';
import { tradeLabel } from '@/lib/trades';
import { displayAnswer, displayQuestion, normalizeAnswers } from '@/lib/trust-assessment';
import { AnswerHighlights } from './AnswerHighlights';
import { DocumentSlots } from './DocumentSlots';

export const dynamic = 'force-dynamic';

/** Both ids are `UUID` columns (`jobs.id`, `users.id`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long "Link copied" stays on the share button before reverting. */
const COPIED_RESET_MS = 3000;

type ScoreComponentKey =
    | 'specific_knowledge'
    | 'practical_experience'
    | 'safety_awareness'
    | 'communication_clarity';

/**
 * The rubric version this page's hardcoded dimension maxes (30/30/20/20
 * below) were written against (infra/lambda/ai/trust-scorer.ts's
 * SSM-hot-editable rubric -- 5-minute cache, see its RUBRIC_CACHE_TTL_MS).
 * `validateScore` there only checks the four score_components sum to 100,
 * so a rebalance (e.g. to 25/25/25/25) is a legal rubric that would
 * silently mislabel these bars -- or push one past 100% -- with nothing to
 * detect it. When the API's `rubric_version` disagrees with this constant,
 * the render below falls back to plain numbers instead of painting a bar
 * against a max that's no longer accurate.
 */
const KNOWN_RUBRIC_VERSION = 7;

/**
 * One row per `score_components` dimension -- also resolves what used to be
 * four near-identical copy-pasted `ProgressRow`s.
 */
const TRUST_DIMENSIONS: ReadonlyArray<{ key: ScoreComponentKey; labelKey: string; max: number }> = [
    { key: 'specific_knowledge', labelKey: 'trust_dim_specific_knowledge', max: 30 },
    { key: 'practical_experience', labelKey: 'trust_dim_practical_experience', max: 30 },
    { key: 'safety_awareness', labelKey: 'trust_dim_safety_awareness', max: 20 },
    { key: 'communication_clarity', labelKey: 'trust_dim_communication_clarity', max: 20 },
];

/** What one load of this page consists of: the applicant, their documents, and their media posts. */
type ApplicantView = {
    profile: WorkerProfile;
    documents: WorkerDocument[];
    posts: WorkerPost[];
};

export default function WorkerProfilePage() {
    const t = useTranslations('employer_worker_profile');
    // `employer_dashboard` is read-only here. It owns two pieces of shared
    // vocabulary this page must speak in the same words as the applicant list
    // and the job modals: `applicants.status.*` and the four
    // `worker_profile.*` keys those surfaces also read.
    const tShared = useTranslations('employer_dashboard');
    const tCommon = useTranslations('common');
    const tMedia = useTranslations('media_board');
    // Read-only, for the hire gate's missing-bucket list: field and document
    // labels must read the same words the job form and the vault use.
    const tReq = useTranslations('job_requirements');
    const tDocTypes = useTranslations('doc_types');
    // Read-only: the Request details action says the SAME words here as on the
    // applicant card, so an employer who learns it in one place recognises it
    // in the other. The keys live with the card, which owns that vocabulary.
    const tListing = useTranslations('employer_job_listing');
    const errorMessage = useErrorMessage();

    const { idToken } = useAuth();
    const { handleLegalWall } = useRequireAuth();
    const params = useParams();
    const searchParams = useSearchParams();
    const locale = useLocale();

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

    const { phase, data, errorKind, retry, setData, refresh } = usePageData<ApplicantView>({
        // `signal` aborts on unmount and on a deps change, and both reads
        // forward it, so an abandoned navigation cancels the requests instead
        // of leaving them to finish unwatched. usePageData's request fencing
        // still backstops a response that races the abort.
        fetcher: async ({ token, signal }) => {
            // Unreachable while `linkValid` is false -- the render short-circuits
            // to the invalid-link state -- but the fetcher is the only place that
            // can guarantee no doomed request is ever sent.
            if (!linkValid) throw new Error('invalid_link');
            // Kicked off alongside the profile/documents Promise.all below
            // (it only needs token/workerId, not either of their results) so
            // the three requests overlap instead of the page paying for this
            // one serially. `.catch`-wrapped immediately -- both so it can
            // never reject anything it's raced against, and so a rejection
            // here doesn't become an unhandled rejection while the other two
            // are still in flight -- to preserve the same best-effort
            // semantics as before: the media board is auxiliary and must
            // never sink the applicant view if the posts fetch fails.
            const postsPromise = getEmployerWorkerPosts(token, workerId, signal).catch(() => null);
            const [profile, docs] = await Promise.all([
                getWorkerProfile(token, workerId, jobId, signal),
                getWorkerDocuments(token, workerId, jobId, signal),
            ]);
            const postsResult = await postsPromise;
            const posts: WorkerPost[] = postsResult?.posts ?? [];
            return { profile, documents: docs.documents, posts };
        },
        legalReturnUrl: returnUrl,
        deps: [workerId, jobId, linkValid],
    });

    const profile = data?.profile ?? null;
    const documents = data?.documents ?? [];
    const posts = data?.posts ?? [];
    const [selectedPost, setSelectedPost] = useState<WorkerPost | null>(null);

    const trustAssessment = profile?.trust_assessment ?? null;
    const trustAnswers = trustAssessment ? normalizeAnswers(trustAssessment.answers) : [];
    const trustExtraction = profile?.trust_extraction ?? null;

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

    /*
     * The hire gate (migration 091). `hireBlockReason` fails open on an API
     * that publishes no stage-2 vocabulary, so this only ever narrows the
     * control when the backend has actually told us the details are
     * outstanding -- the 409 handler below stays the authority either way.
     *
     * The disabled option is additionally suppressed once the applicant IS
     * hired: a select whose current value points at a disabled option renders
     * blank (or refuses the selection) in several browsers, and a pre-gate
     * hire is a real row.
     */
    const blockReason = hireBlockReason(profile);
    const hireOptionDisabled = blockReason !== null && savedStatus !== 'hired';
    const remainingLeft = remainingCount(profile?.remaining ?? undefined);
    const promptAnswers = profile?.prompt_answers ?? [];

    const hireHint = (() => {
        if (!hireOptionDisabled) return null;
        if (blockReason === 'not_requested') return t('hire_blocked_not_requested');
        return remainingLeft === null
            ? t('hire_blocked_requested_no_count')
            : t('hire_blocked_requested', { count: remainingLeft });
    })();

    /**
     * Turns a 409 `details_incomplete` into a sentence that names the three
     * buckets the trigger actually counted. Each bucket is labelled in the
     * vocabulary its own surface uses -- field keys through the job form's
     * catalogue, doc types through the vault's -- with the raw key as the
     * fallback, because the backend may name something this build has no label
     * for and a blank list item is worse than an unfamiliar word.
     *
     * `payload.missing` carries TWO shapes across the API (see `api/errors`);
     * the array variant belongs to a different code, so anything that is not
     * the three-bucket object degrades to the bare headline.
     */
    /*
     * The one control that sends the worker a details request, on the page an
     * employer lands on when they open a candidate.
     *
     * Sprint 24 (B7): `details_requested` is no longer reachable through the
     * select at all -- the button owns the move AND the notification, so the
     * two can never disagree about whether a message went out. It therefore
     * has to survive the request it makes: `canRequestDetails` now withdraws
     * it only on a terminal application, and `canResendDetails` turns it into
     * a resend. No optimistic latch any more; the label is derived from the
     * status the PATCH just committed.
     */
    const [requestingDetails, setRequestingDetails] = useState(false);
    const showRequestDetails = canRequestDetails({
        status: savedStatus, details_status: profile?.details_status,
    });
    const resendingDetails = canResendDetails(savedStatus, profile?.details_status);

    const handleRequestDetails = useCallback(async () => {
        if (!idToken || !linkValid || !profile || requestingDetails) return;
        const resend = canResendDetails(
            normalizeApplicationStatus(profile.application_status), profile.details_status,
        );
        setRequestingDetails(true);
        setSaveFeedback(null);
        try {
            const updated = await updateApplicantStatus(
                idToken, jobId, workerId, 'details_requested',
                // Only when the row already SITS at details_requested: the
                // backend refuses `resend` with a 400 for any other status.
                resend ? { resend: true } : undefined,
            );
            /*
             * Optimistic for the same reason the card is: the PATCH answers
             * with the row plus the notify outcome, and the stage-2 fields it
             * moved are republished by the next profile READ. Both are written
             * here so the hire hint and the button label agree with what just
             * happened. `remaining` is untouched -- requesting details answers
             * none of it.
             */
            setData((prev) => ({
                ...prev,
                profile: {
                    ...prev.profile,
                    application_status: updated.status ?? 'details_requested',
                    details_status: 'requested' as const,
                },
            }));
            setStatusDraft(null);
            /*
             * The employer must be able to tell whether the WORKER heard about
             * this -- a worker with no WhatsApp on file used to produce the
             * same cheerful line as a delivered message. `detailsRequestFeedbackKey`
             * picks the sentence and fails open to the old neutral copy on an
             * API that publishes no outcome.
             */
            const feedbackKey = detailsRequestFeedbackKey(updated);
            setSaveFeedback({
                // Tone follows the OUTCOME, never a blanket success: a green
                // banner reading "no message was sent" is the exact confusion
                // B7 exists to remove.
                tone: detailsRequestFeedbackTone(feedbackKey),
                message: tListing(
                    `applicants.${feedbackKey}`,
                    { name: profile.full_name?.trim() || t('fallback_name') },
                ),
            });
        } catch (err) {
            try {
                handleLegalWall(err, returnUrl);
            } catch {
                setSaveFeedback({ tone: 'danger', message: errorMessage(err) });
            }
        } finally {
            setRequestingDetails(false);
        }
    }, [
        errorMessage, handleLegalWall, idToken, jobId, linkValid, profile,
        requestingDetails, returnUrl, setData, t, tListing, workerId,
    ]);

    const hireGateMessage = useCallback((err: ApiError): string => {
        const headline = t('details_incomplete_title');
        const missing = err.payload.missing;
        if (!missing || Array.isArray(missing)) return headline;

        const parts: string[] = [headline];
        if (missing.fields.length > 0) {
            parts.push(t('details_incomplete_fields', {
                items: missing.fields
                    .map((key) => (tReq.has(`fields.${key}`) ? tReq(`fields.${key}`) : key))
                    .join(', '),
            }));
        }
        if (missing.docs.length > 0) {
            parts.push(t('details_incomplete_docs', {
                items: missing.docs
                    .map((key) => (tDocTypes.has(key) ? tDocTypes(key) : key))
                    .join(', '),
            }));
        }
        if (missing.certifications.length > 0) {
            // Certification names are employer-typed free text, not a closed
            // vocabulary -- there is nothing to translate them against.
            parts.push(t('details_incomplete_certifications', {
                items: missing.certifications.join(', '),
            }));
        }
        return parts.join(' ');
    }, [t, tDocTypes, tReq]);

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
                /*
                 * The database's own hire gate, surfaced. Reachable even with
                 * the disabled option above: this page may have been loaded
                 * before the worker's details went stale, and the option is
                 * deliberately NOT disabled on the fail-open path. Retrying
                 * `hired` unchanged will keep failing, so the message names
                 * what is actually missing and the profile is re-read -- the
                 * indicator and the hint then agree with the refusal.
                 */
                if (err instanceof ApiError && err.code === 'details_incomplete') {
                    setSaveFeedback({ tone: 'danger', message: hireGateMessage(err) });
                    setStatusDraft(null);
                    refresh();
                } else {
                    setSaveFeedback({ tone: 'danger', message: errorMessage(err) });
                }
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
        hireGateMessage,
        refresh,
    ]);

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

    const displayName = profile?.full_name?.trim() || t('fallback_name');
    const skills = profile?.skills ?? [];
    const appliedAt = profile?.applied_at ? profile.applied_at.slice(0, 10) : t('fallback_applied');
    const yearsExperience = profile?.years_experience ?? null;
    // Both figures come off `worker_profiles` and both have always been on the
    // wire; only the years were rendered, which reported a 20-month worker as
    // "1 year". The months are shown ALONGSIDE rather than instead: employers
    // scan in years, and the exact figure is what settles a close call.
    const experienceMonths = profile?.experience_months ?? null;
    const certifications = profile?.certifications ?? [];
    const shellSubtitle = profile
        ? tradeLabel(tCommon, profile.main_trade, profile.main_trade_other)
        : undefined;

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
                      yearsExperience === null && experienceMonths === null ? (
                          t('fallback_experience')
                      ) : (
                          <span className="tabular-nums">
                              {yearsExperience !== null
                                  ? tShared('worker_profile.years_experience', { years: yearsExperience })
                                  : null}
                              {yearsExperience !== null && experienceMonths !== null ? ' · ' : null}
                              {experienceMonths !== null
                                  ? t('experience_months', { months: experienceMonths })
                                  : null}
                          </span>
                      ),
              },
              { label: t('availability_label'), value: availabilityLabel(profile.availability) },
              {
                  label: t('trade'),
                  value: tradeLabel(tCommon, profile.main_trade, profile.main_trade_other),
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

                                        {/* Free-text names the worker typed. Kept
                                            visually apart from the skills above and
                                            given no success tone: nobody has checked
                                            that any of these certificates exist. The
                                            certification_doc slot on the right is
                                            where the proof, if any, lives. */}
                                        {certifications.length > 0 ? (
                                            <div className="mt-4 border-t border-[var(--jale-divider)] pt-4">
                                                <p className="text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)]">
                                                    {t('certifications')}
                                                </p>
                                                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                                                    {certifications.map((cert) => (
                                                        <Badge key={cert} tone="neutral">
                                                            {cert}
                                                        </Badge>
                                                    ))}
                                                </div>
                                            </div>
                                        ) : null}
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

                                <DocumentSlots
                                    documents={documents}
                                    onRequest={handleShareLink}
                                    requestDisabled={shareDisabled}
                                    requesting={sharingLink}
                                />
                            </DashboardPanel>
                        </div>
                    )}

                    {posts.length > 0 && (
                        <DashboardPanel className="mt-5">
                            <PanelHeader title={tMedia('employer_title')} />
                            <div className="px-5 py-5">
                                <MediaBoardGrid posts={posts} editable={false} onSelect={setSelectedPost} />
                            </div>
                        </DashboardPanel>
                    )}

                    {selectedPost && (
                        <PostLightbox
                            post={selectedPost}
                            editable={false}
                            onClose={() => setSelectedPost(null)}
                        />
                    )}

                    <DashboardPanel className="mt-5">
                        <PanelHeader title={t('trust_title')} />
                        <div className="px-5 py-4">
                            {/*
                                FIRST in this panel, above the score and above
                                the worker's three profile answers: those speak
                                about the trade in general, this is what the
                                worker said about THIS job, and it is the only
                                thing here written for this employer.
                            */}
                            {promptAnswers.length > 0 ? (
                                <div className="mb-4">
                                    <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
                                        {t('prompt_answers_title')}
                                    </p>
                                    <ul className="space-y-3">
                                        {promptAnswers.map((entry) => (
                                            <li
                                                key={entry.prompt_id}
                                                className="rounded-[10px] border border-[var(--jale-divider)] p-3"
                                            >
                                                <p className="whitespace-pre-wrap text-sm font-semibold text-[var(--jale-ink)]">
                                                    {/* The employer deleted this
                                                        question after it was
                                                        answered. The answer stands;
                                                        it is labelled, never filed
                                                        under a neighbour. */}
                                                    {entry.question ?? t('prompt_answers_question_removed')}
                                                </p>
                                                <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--jale-ink-2)]">
                                                    {entry.text}
                                                </p>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ) : null}

                            {!trustAssessment ? (
                                <p className="text-sm text-[var(--jale-ink-2)]">{t('trust_empty')}</p>
                            ) : (
                                <>
                                    {trustAssessment.status === 'scored' && trustAssessment.score_components ? (
                                        <div className="space-y-4">
                                            <div className="flex items-baseline justify-between gap-3">
                                                <span className="text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)]">
                                                    {t('trust_score_label')}
                                                </span>
                                                <span className="tabular-nums text-sm font-semibold text-[var(--jale-ink)]">
                                                    {trustAssessment.competency_score}/100
                                                </span>
                                            </div>
                                            {(() => {
                                                const components = trustAssessment.score_components;
                                                const rubricVersion = trustAssessment.rubric_version;
                                                // See KNOWN_RUBRIC_VERSION above: a rebalanced rubric is
                                                // undetectable from the components alone, so a version
                                                // mismatch degrades to honest numbers instead of a
                                                // mislabeled (or overflowing) bar.
                                                const rubricDrifted =
                                                    rubricVersion != null && rubricVersion !== KNOWN_RUBRIC_VERSION;
                                                return TRUST_DIMENSIONS.map((dim) => {
                                                    const value = components[dim.key];
                                                    if (rubricDrifted) {
                                                        return (
                                                            <div
                                                                key={dim.key}
                                                                className="flex items-baseline justify-between gap-3 text-xs font-semibold"
                                                            >
                                                                <span className="min-w-0 text-current">{t(dim.labelKey)}</span>
                                                                <span className="shrink-0 tabular-nums text-current opacity-70">
                                                                    {value} pts
                                                                </span>
                                                            </div>
                                                        );
                                                    }
                                                    const pct = Math.min(100, (value / dim.max) * 100);
                                                    return (
                                                        <ProgressRow
                                                            key={dim.key}
                                                            label={t(dim.labelKey)}
                                                            value={`${value}/${dim.max}`}
                                                            percent={pct}
                                                        />
                                                    );
                                                });
                                            })()}
                                        </div>
                                    ) : (
                                        <Badge tone={trustAssessment.status === 'failed' ? 'danger' : 'warning'}>
                                            {t(`trust_status_${trustAssessment.status}`)}
                                        </Badge>
                                    )}

                                    {/* ABOVE the raw answers, deliberately: the chips
                                        are the fast way in, and the sentences the
                                        worker actually said are the evidence one
                                        scroll below them. */}
                                    <AnswerHighlights extraction={trustExtraction} />

                                    {trustAnswers.length > 0 && (
                                        <ul className="mt-4 space-y-3">
                                            {trustAnswers.map((a) => {
                                                const ans = displayAnswer(a);
                                                return (
                                                    <li
                                                        key={a.q_en}
                                                        className="rounded-[10px] border border-[var(--jale-divider)] p-3"
                                                    >
                                                        <p className="whitespace-pre-wrap text-sm font-semibold text-[var(--jale-ink)]">
                                                            {displayQuestion(a, locale)}
                                                        </p>
                                                        <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--jale-ink-2)]">
                                                            {ans.text}
                                                        </p>
                                                        {ans.kind === 'voice' ? (
                                                            <span className="mt-1 inline-block text-[10px] font-bold uppercase tracking-wider text-[var(--jale-ink-2)]">
                                                                {t('trust_voice_badge')}
                                                            </span>
                                                        ) : null}
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </>
                            )}
                        </div>
                    </DashboardPanel>

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
                                            {statusSelectOptions(savedStatus).map((status) => {
                                                // `hired` is the one option the
                                                // database can refuse. When it
                                                // would, it is offered disabled
                                                // and RELABELLED -- a greyed
                                                // "Hired" says nothing about why.
                                                const blocked = status === 'hired' && hireOptionDisabled;
                                                return (
                                                    <option key={status} value={status} disabled={blocked}>
                                                        {blocked
                                                            ? t('hire_option_blocked')
                                                            : tShared(`applicants.status.${status}`)}
                                                    </option>
                                                );
                                            })}
                                        </Select>
                                        {hireHint ? (
                                            <p className="mt-1.5 text-xs text-[var(--jale-ink-2)]">{hireHint}</p>
                                        ) : null}
                                    </div>
                                    <Button
                                        onClick={handleSaveStatus}
                                        disabled={saveDisabled}
                                        loading={saving}
                                        loadingLabel={t('saving_status')}
                                    >
                                        {t('save_status')}
                                    </Button>
                                    {/* Beside Save, not instead of it: Save
                                        commits whatever the select holds, this
                                        is the one control that also NOTIFIES
                                        the worker. It STAYS once details are
                                        requested (sprint 24, B7) -- relabelled
                                        as a resend, because a worker who never
                                        answered is exactly the case an
                                        employer needs to act on and the select
                                        can no longer reach this status. */}
                                    {showRequestDetails ? (
                                        <Button
                                            variant="outline"
                                            onClick={() => void handleRequestDetails()}
                                            disabled={saving}
                                            loading={requestingDetails}
                                            loadingLabel={tCommon('loading')}
                                        >
                                            {resendingDetails
                                                ? tListing('applicants.request_details_resend')
                                                : tListing('applicants.request_details')}
                                        </Button>
                                    ) : null}
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
