'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { usePageData } from '@/hooks/usePageData';
import { Link, useRouter } from '@/i18n/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { Badge, JobStatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { ErrorState } from '@/components/ui/error-state';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { JobDetailSkeleton } from '@/components/ui/page-skeletons';
import { PanelHeader } from '@/components/ui/panel-header';
import {
  JobFactsCard,
  type JobFactRequirement,
  type JobFactTile,
} from '@/components/jobs/JobFactsCard';
import { ApplicationStatusChip } from '@/components/worker/ApplicationStatusChip';
import { PayReferenceHint } from '@/components/PayReferenceHint';
import { ShareJobPanel } from '@/components/worker/ShareJobPanel';
import { WhatYouNeedPanel } from '@/components/worker/WhatYouNeedPanel';
import { ProfileCompleteModal, type ProfileCompleteValues } from '@/components/worker/ProfileCompleteModal';
import { ApplyFlow, type ApplyFlowSubmitError } from '@/components/worker/apply-flow/ApplyFlow';
import { DetailsRequestedBanner } from '@/components/worker/DetailsRequestedBanner';
import { apiFetch, isLegalWallError } from '@/lib/api';
import { consumeFeedOrigin, opensInThisTab, readFeedReturn } from '@/lib/worker-feed-return';
import { ApiError, classifyError, parseApiError, type ErrorKind } from '@/lib/api/errors';
import { applyFlowReducer, initialApplyFlowState, flowHasProgress, promptAnswersPayload } from '@/lib/apply-flow-view';
import { missingPromptAnswers } from '@/lib/application-requirements-flow';
import { formatLongDate, formatStartDate } from '@/lib/date';
import { docTypeLabel } from '@/lib/doc-types';
import {
  durationLabel,
  experienceLabel,
  scheduleSummary,
  tradeLabel,
  type Translator,
} from '@/lib/job-detail-display';
import { formatPay } from '@/lib/pay';
import {
  getJob, applyToJob, updateWorkerProfile, getVaultDocuments,
  type JobDetail, type WorkerApiError, type WorkerVaultDoc,
} from '@/lib/api/worker';
import { visibleJobStatusBadge } from '@/lib/jobStatusDisplay';

export const dynamic = 'force-dynamic';

const KNOWN_JOB_TYPES = ['full-time', 'part-time', 'contract'];

// 'info' is for the "your progress is saved" note shown when a worker backs
// out of the in-page apply flow with unsubmitted progress -- not an error and
// not a completed action, so neither 'danger' nor 'success' fits.
type ApplyFeedback = { tone: 'danger' | 'success' | 'info'; message: string };

/**
 * Widens a next-intl translator to `job-detail-display`'s structural
 * `Translator`.
 *
 * next-intl's client translator is generic over ITS OWN namespace's message
 * keys, which is narrower than `(key: string, values?) => string` for the
 * `values` parameter, so passing one straight in fails `tsc` (verified). Not a
 * behaviour change -- the call is identical -- just the same thin adapter the
 * public `/j/[code]` page applies at the same boundary, hoisted so the three
 * call sites below share one.
 */
function widen(t: unknown): Translator {
  return (key, values) => (t as (k: string, v?: Record<string, unknown>) => string)(key, values);
}

export default function WorkerJobDetailPage() {
  const { id } = useParams<{ id: string; locale: string }>();
  const router = useRouter();
  /*
   * Where "back to jobs" goes, and the destination the S5 states offer: the
   * FEED, with the filters the worker left it under. Those filters live in the
   * feed's query string, so a bare `/worker/home` would quietly undo them;
   * `lib/worker-feed-return.ts` remembers the URL and falls back to the plain
   * feed for a job page nobody reached from it (a shared link, a bookmark).
   *
   * Read ONCE, on mount, and never re-read: the answer describes how this
   * page was ARRIVED at, which cannot change while it is open. The marker is
   * spent right after, so it describes that one navigation and not every
   * later job page the worker opens from somewhere else.
   */
  const [feedReturn] = useState(readFeedReturn);
  useEffect(() => { consumeFeedOrigin(); }, []);

  /**
   * Back to the feed, by HISTORY when this page was opened from it.
   *
   * `router.back()` is not merely equivalent to following the link: it restores
   * the feed's scroll position, so a worker who was ten rows down does not land
   * back at the top of the list. Every other way of arriving here (a shared
   * link, a reload, the applications list) follows the href instead, which
   * carries the remembered filters and is correct from anywhere.
   *
   * The modifier keys are left alone on purpose: a middle-click or a
   * ctrl/cmd-click is "open the feed in a new tab", and hijacking it would
   * navigate this one instead.
   */
  const handleBackToFeed = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (!feedReturn.canGoBack) return;
    // A tab opened from a ctrl-click INHERITS this tab's sessionStorage, so it
    // can carry a marker while having a history of exactly one entry --
    // `back()` there does nothing at all and the link would be a dead end.
    if (window.history.length <= 1) return;
    // A middle- or modifier-click means "open the feed beside this page", and
    // hijacking it would navigate this one instead.
    if (!opensInThisTab(event)) return;
    event.preventDefault();
    router.back();
  }, [feedReturn, router]);
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('worker_job_detail');
  const tCommon = useTranslations('common');
  const tFlow = useTranslations('worker_job_detail.apply_flow');
  const tPay = useTranslations('pay');
  // Badge labels live in the worker_applications namespace (Task 6 keys) —
  // NEVER employer_dashboard.jobs.status.*, whose es "Lleno" is employer
  // vocabulary kept off worker surfaces.
  const tApps = useTranslations('worker_applications');
  // `public_job.language_*` reused for the same reason `tApps` above avoids
  // `employer_dashboard.jobs.status.*`: that flat Any/English/Spanish
  // vocabulary carries no page-specific framing, and `public_job` is the
  // exact sibling surface this task matches display parity against (which
  // itself borrows `worker_job_detail.what_you_need.proof_needed` the same
  // way) -- reuse over a duplicate `worker_job_detail`-scoped copy.
  const tPublicJob = useTranslations('public_job');
  const tDocTypes = useTranslations('doc_types');
  // The job trade-category catalogue, for the facts card's Oficio tile.
  //
  // `employer_dashboard.modal.trade.*` is the one catalogue covering all eight
  // of migration 023's tokens; `common.trades.*` (and `lib/trades.ts` with it)
  // carries only the worker-vocabulary five and would print a raw key path for
  // a `drywall` or `general_labor` job. Reading it from a worker surface is the
  // established precedent, not a new liberty -- `components/PayReferenceHint.tsx`
  // does exactly this, for exactly this reason, and `job-detail-display.ts`'s
  // own `hireTradeLabel` doc comment names this catalogue as the correct one.
  const tTradeCatalogue = useTranslations('employer_dashboard.modal.trade');
  /* The app's ONE required/optional vocabulary. `job_requirements.states.*`
     is where the employer's own requirement picker reads these two words
     from, so the chip a worker sees and the control the employer set say
     the same thing (owner ruling, fix round 1). */
  const tRequirement = useTranslations('job_requirements');
  const locale = useLocale();

  // `job-detail-display.ts`'s formatters take a deliberately structural
  // `Translator` type (`(key, values?) => string`) so they stay unit-testable
  // without a next-intl runtime -- see that module's doc comment. next-intl's
  // client translator is generic over ITS OWN namespace's message keys, which
  // is narrower than that structural type for the `values` parameter, so
  // passing `tCommon` directly fails `tsc` (verified). This is the identical
  // thin widening adapter the merged public `/j/[code]` page already uses at
  // the same boundary (its server-translator equivalent) -- not a behavior
  // change, just satisfying the wider structural type.
  //
  // Three boundaries need it now (`tCommon` for schedule/duration, and the
  // trade catalogue + this page's own namespace for `tradeLabel`), so the cast
  // lives in one place rather than being retyped per call site.
  const tCommonDisplay = widen(tCommon);
  const tTradeDisplay = widen(tTradeCatalogue);
  const tDetailDisplay = widen(t);

  const [applying, setApplying] = useState(false);
  const [applyFeedback, setApplyFeedback] = useState<ApplyFeedback | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [profilePrefill, setProfilePrefill] = useState<Partial<ProfileCompleteValues> | null>(null);

  // In-page apply flow (replaces the old ApplicationAnswersForm modal
  // entirely): a view-state boolean swaps the details content for
  // `<ApplyFlow key={job.id}>` rather than navigating to a new route. The
  // flow's OWN reducer state is lifted here (ApplyFlow is a controlled
  // component per its doc comment) and reset only on a job-id change --
  // never in place -- via the effect below.
  const [viewMode, setViewMode] = useState<'details' | 'apply'>('details');
  const [applyState, applyDispatch] = useReducer(applyFlowReducer, undefined, initialApplyFlowState);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApplyFlowSubmitError | null>(null);
  // The vault fetch now serves `WhatYouNeedPanel` alone: stage 1 asks for no
  // documents, so `ApplyFlow` no longer needs it. `null` means "failed or not
  // yet loaded", which the panel already degrades on.
  const [vaultDocs, setVaultDocs] = useState<readonly WorkerVaultDoc[] | null>(null);

  const {
    phase,
    data: job,
    errorKind,
    refreshError,
    retry,
    refresh,
    setData,
  } = usePageData<JobDetail>({
    fetcher: ({ token, signal }) => getJob(token, id, signal),
    legalReturnUrl: `/worker/jobs/${id}`,
    // The job id is the whole identity of this page: navigating between two
    // job details must drop the previous job rather than briefly render it
    // under the new title.
    deps: [id],
  });

  // Resets the lifted apply-flow state ONLY on a job-id change -- never in
  // place. `ApplyFlow` itself is remounted via `key={job.id}` (which resets
  // ITS internal transient state, e.g. the `apply_defaults` guard ref and
  // each step's local `attempted`/`uploadingKey` flags), but the reducer
  // state living on this page is a separate object reference that a
  // key-based remount does not touch by itself -- this effect is what
  // actually clears it. Guarded on `job.id` (a ref, not a dep-array
  // identity), so a `refresh()`/`setData` that produces a new `job` object
  // with the SAME id (e.g. after a successful apply) does not wipe answers
  // the worker is mid-typing.
  const appliedJobIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!job) return;
    if (appliedJobIdRef.current === job.id) return;
    appliedJobIdRef.current = job.id;
    applyDispatch({ type: 'reset' });
    setSubmitError(null);
    setViewMode('details');
  }, [job]);

  // One shared vault fetch, refetched on demand via `onVaultChanged` (after a
  // successful upload from inside `ApplyFlow`) and whenever the auth token
  // changes. `null` on failure -- both `WhatYouNeedPanel` and `ApplyFlow`
  // already degrade on that per their own doc comments.
  const fetchVaultDocs = useCallback(async () => {
    if (!idToken) {
      setVaultDocs(null);
      return;
    }
    try {
      const { documents } = await getVaultDocuments(idToken);
      setVaultDocs(documents);
    } catch {
      setVaultDocs(null);
    }
  }, [idToken]);

  useEffect(() => {
    void fetchVaultDocs();
  }, [fetchVaultDocs]);

  function showApplyError(message: string) {
    setApplyFeedback({ tone: 'danger', message });
  }

  // One catalogue, one lookup -- this was a three-branch cascade over
  // `worker_job_detail.doc_labels` and then `job_requirements.docs`, because
  // the first namespace only ever held three of the five doc types. An
  // unknown key still falls back to the raw string rather than vanishing from
  // a `missing_docs` sentence.
  function docLabel(doc: string): string {
    return docTypeLabel(doc, tDocTypes) ?? doc;
  }

  /**
   * There is no `getWorkerProfile` in `lib/api/worker` (frozen), so the
   * completeness pre-check stays a page-local fetch -- but it raises the same
   * `ApiError` everything else does, so the apply taxonomy below reads its
   * status/code without a second error shape to understand.
   */
  async function fetchProfile(): Promise<Partial<ProfileCompleteValues>> {
    if (!idToken) throw new ApiError(401, 'not_signed_in');
    const res = await apiFetch('/worker/profile', {}, idToken);
    if (!res.ok) throw await parseApiError(res, 'profile_check_failed');
    return await res.json();
  }

  function profileIsComplete(p: Partial<ProfileCompleteValues>): boolean {
    return !!(p.full_name && p.skills && p.skills.length > 0 && p.availability && p.location);
  }

  /**
   * Opens the one-screen apply flow.
   *
   * The `getApplicationDefaults` prefill fetch that used to fire here is GONE:
   * stage 1 collects the employer's prompts and nothing else, and there is no
   * such thing as a stored default answer to a question this employer wrote.
   * Defaults are merged at the stage-2 door instead -- and increasingly by the
   * backend itself, which seeds them when the employer arms the stage.
   */
  function openApplyFlow() {
    setViewMode('apply');
  }

  async function handleApplyClick() {
    if (!idToken || !id || !job) return;
    setApplyFeedback(null);
    setApplying(true);
    try {
      const profile = await fetchProfile();
      if (!profileIsComplete(profile)) {
        setProfilePrefill(profile);
        setModalOpen(true);
        return;
      }
      openApplyFlow();
    } catch (err) {
      await handleApplyError(err);
    } finally {
      setApplying(false);
    }
  }

  /** Returns to the details view WITHOUT resetting the flow's own state --
   * only a job-id change (the effect above) clears it. A worker who leaves
   * mid-answer and re-taps "Continue application" picks up where they left
   * off. */
  function handleBackToDetails() {
    setViewMode('details');
    // Clear whatever the banner slot last held (a stale danger message from
    // before the flow opened, or a leftover success/info note) before
    // possibly writing the progress-saved note -- otherwise backing out with
    // no progress can leave an unrelated old message sitting on the details
    // view.
    setApplyFeedback(
      flowHasProgress(applyState) ? { tone: 'info', message: tFlow('progress_saved') } : null,
    );
  }

  /**
   * `ApplyFlow`'s `onSubmit`. Stage 1, whole: `{ prompt_answers }` and nothing
   * else. `promptAnswersPayload` trims every answer and drops any id the job
   * no longer asks about, so a stale draft entry cannot become a 400
   * `invalid_prompt_answers`.
   */
  async function doApply() {
    if (!idToken || !id || !job) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const application = await applyToJob(
        idToken, id, promptAnswersPayload(job.pre_application_prompts ?? [], applyState),
      );
      setApplyFeedback({ tone: 'success', message: t('apply_success') });
      // Reflect the outcome locally before asking the server again: the POST
      // already succeeded, so the page must show "applied" even if the
      // confirming refresh below never lands (a worker who loses signal in the
      // same second should not see an Apply button they already used).
      setData((prev) => ({
        ...prev,
        already_applied: true,
        application_status: application?.status ?? prev.application_status ?? 'pending',
      }));
      setViewMode('details');
      await refresh();
    } catch (err) {
      await handleApplyError(err, { fromFlow: true });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleModalSubmit(values: ProfileCompleteValues) {
    if (!idToken) return;
    setApplyFeedback(null);
    try {
      await updateWorkerProfile(idToken, values);
    } catch (err) {
      if (isLegalWallError(err)) {
        // The wall is a redirect, not a sentence. Close first so the dialog is
        // not left hanging over the page we are navigating away from.
        setModalOpen(false);
        handleLegalWall(err, `/worker/jobs/${id}`);
        return;
      }
      // A failed SAVE is the dialog's error: it stays open, and page-level
      // feedback would be hidden behind the backdrop. Rethrow so the modal's
      // own catch renders a translated sentence next to the fields.
      throw err;
    }
    // Saved. The application resumes automatically -- that is the whole point
    // of the gate -- and from here every failure is an APPLY failure, which
    // belongs to the taxonomy anchored to the apply button.
    setModalOpen(false);
    openApplyFlow();
  }

  /**
   * The apply-error taxonomy.
   *
   * Every branch below is a distinct thing that can go wrong when a worker taps
   * Apply, and each one gets its own translated sentence -- "you already
   * applied" is not "this job closed" is not "we are broken".
   *
   * `opts.fromFlow` distinguishes the two call sites without duplicating this
   * taxonomy: `handleApplyClick`'s pre-flow profile check (default, `false`)
   * still anchors its message to the apply button as `InlineFeedback
   * tone="danger"` on the details view, exactly as before. `doApply`'s
   * post-submit failures (`true`) render INSIDE the still-open flow instead,
   * via `ApplyFlow`'s `submitError` prop -- so a fixable problem (a missing
   * doc, an invalid answer) never discards the worker's in-progress answers
   * the way the old modal's unconditional close-then-doApply did. Only the
   * two branches below that call `refresh()` -- already applied, and the job
   * closing out from under the applicant -- are TRULY terminal: nothing left
   * to fix inside the flow, so they exit it back to details even when
   * `fromFlow` is true, same as `refresh()`-then-render-status did before
   * this task. `err.message` (an untranslated backend code) is never rendered
   * either way.
   */
  async function handleApplyError(err: unknown, opts: { fromFlow: boolean } = { fromFlow: false }) {
    const { fromFlow } = opts;
    const reportProblem = (message: string) => {
      if (fromFlow) setSubmitError({ message });
      else showApplyError(message);
    };

    if (isLegalWallError(err)) {
      try { handleLegalWall(err, `/worker/jobs/${id}`); }
      catch { reportProblem(t('errors.legal_required')); }
      return;
    }

    // The certification-claim and field-answer 400s that used to be handled
    // here are unreachable now: apply sends `{ prompt_answers }` alone, so
    // `worker-jobs-apply` has nothing to validate against those rules. The
    // whole `missing_certification_*` / `missing_answers` / `invalid_answers`
    // family belongs to the stage-2 door and is handled there.
    const applyErr = err as WorkerApiError;
    if (applyErr.status === 400 && applyErr.missing_docs?.length) {
      // The one payload-carrying branch: it names the documents that are
      // missing, which is the only thing that makes the message actionable.
      reportProblem(t('errors.missing_docs', {
        docs: applyErr.missing_docs.map(docLabel).join(', '),
      }));
      return;
    }
    // Sprint 23's two apply-time codes, now with a real form behind them.
    // They MUST be named before the generic 400 arm below, whose
    // `profile_invalid` copy sends the worker to their profile -- a place
    // where nothing they do could ever fix an unanswered employer prompt.
    //
    // Both are BACKSTOPS: `ApplyFlow` gates Submit on the same predicate the
    // door enforces, so reaching either means the job's prompts changed
    // between load and submit. `missing` carries the still-unanswered ids.
    if (applyErr.status === 400 && applyErr.code === 'missing_prompt_answers') {
      // `payload.missing` is the allowlisted prompt-id array for THIS code
      // (`lib/api/errors.ts` documents the two shapes that share the key); the
      // local recount is the fallback for a body that lost it to a proxy.
      const reported = err instanceof ApiError && Array.isArray(err.payload.missing)
        ? err.payload.missing.length
        : 0;
      const stillMissing = reported > 0
        ? reported
        : missingPromptAnswers(job?.pre_application_prompts ?? [], applyState.answers).length;
      reportProblem(tFlow('errors.missing_prompt_answers', { count: stillMissing }));
      return;
    }
    if (applyErr.status === 400 && applyErr.code === 'invalid_prompt_answers') {
      reportProblem(tFlow('errors.invalid_prompt_answers'));
      return;
    }
    if (applyErr.status === 400) {
      reportProblem(t('errors.profile_invalid'));
      return;
    }
    if (applyErr.status === 401) {
      reportProblem(t('errors.not_signed_in'));
      return;
    }
    if (applyErr.status === 403 || applyErr.code === 'legal_required') {
      reportProblem(t('errors.legal_required'));
      return;
    }
    if (applyErr.status === 409) {
      if (applyErr.code === 'user_not_provisioned') showApplyError(t('errors.account_not_ready'));
      else showApplyError(t('errors.already_applied'));
      if (fromFlow) setViewMode('details');
      await refresh();
      return;
    }
    if (applyErr.status === 410 || applyErr.status === 404) {
      showApplyError(t('errors.job_closed'));
      if (fromFlow) setViewMode('details');
      await refresh();
      return;
    }
    if (applyErr.status && applyErr.status >= 500) {
      reportProblem(t('errors.server_error'));
      return;
    }
    // A dead connection is not a profile problem. Without this, both fall
    // through to `apply_failed` ("check your profile and documents"), which
    // sends the worker off to fix something that is not broken. The shared
    // connectivity copy already says the right thing in both locales.
    const { kind } = classifyError(err);
    if (kind === 'offline' || kind === 'timeout') {
      reportProblem(tCommon(`errors.${kind}`));
      return;
    }
    reportProblem(t('errors.apply_failed'));
  }

  /**
   * S5, split by kind.
   *
   * A mistyped/stale job id and a broken server used to render the same
   * sentence, which told the worker nothing about whether to retry or go back.
   * `not_found` and `gone` are terminal for THIS url and offer the way out;
   * everything else keeps the retry `ErrorState` decides is honest.
   *
   * `notFound()` is deliberately not called: this is a client page inside the
   * app shell, and throwing to the route-level 404 would drop the nav chrome
   * the worker needs to get anywhere else.
   */
  function errorPanel(kind: ErrorKind) {
    if (kind === 'not_found') {
      return (
        <ErrorState
          kind="not_found"
          backHref={feedReturn.href}
          title={t('not_found.title')}
          body={t('not_found.body')}
        />
      );
    }
    if (kind === 'gone') {
      return (
        <ErrorState
          kind="gone"
          backHref={feedReturn.href}
          title={t('closed.title')}
          body={t('closed.body')}
        />
      );
    }
    // Everything else keeps whatever retry `ErrorState` judges honest for the
    // kind. `backHref` is passed for all of them deliberately: a worker stuck
    // on one job's failure should always have the jobs list one tap away, and
    // no kind is relabelled to obtain that button.
    return <ErrorState kind={kind} onRetry={retry} backHref={feedReturn.href} />;
  }

  // 'auth' means the token gate has not opened yet: nothing has been asked for,
  // so the page owes the reader the same skeleton `loading.tsx` already painted.
  const showSkeleton = phase === 'auth' || phase === 'loading';

  const jobTypeLabel = job
    ? (KNOWN_JOB_TYPES.includes(job.job_type) ? t(`job_type.${job.job_type}`) : job.job_type)
    : null;
  const pay = job ? formatPay(job, tPay) : null;
  // MatchScoreBadge removed (decision, WK-T5): the deployed
  // `worker-jobs-detail` handler never returns `match_score` on the detail
  // payload, so the badge this page used to render off it was permanently
  // dead code -- `match_score` still exists on `Job`/`JobDetail` for the
  // list-card surfaces (`WorkerJobCard`) that do receive it.
  //
  // Apply is reachable whenever the job is still active and not already
  // applied to -- unlike the old direct-apply shortcut, `missing_docs`
  // no longer gates the button itself: EVERY apply now goes through the
  // in-page flow's Documents & Certifications step, which is the real doc/
  // cert gate (backed by a live vault fetch), with its own Submit action.
  const canApply = job ? !job.already_applied && (job.status ?? 'active') === 'active' : false;
  const jobStatusBadge = job ? visibleJobStatusBadge(job.status) : null;

  /*
   * The job's facts, as the ONE card body all three job pages render.
   *
   * Every value below is a FINISHED string built by this page's own existing
   * formatters (`lib/pay.ts`, `lib/date.ts`, `lib/job-detail-display.ts`) and
   * this page's own next-intl namespace -- `JobFactsCard` owns the section
   * order and nothing else. A tile whose value the job genuinely does not
   * carry is omitted rather than filled with a dash; `Inicio` is the one
   * exception, always shown, muted, because "we do not know yet" is itself
   * the answer a worker is deciding on.
   */
  const schedule = job ? scheduleSummary(job, locale, tCommonDisplay) : null;
  // ONE Horario tile, not the two rows this page used to render: the days and
  // the hours are one fact to a reader planning a ride. `legacy` is already
  // mutually exclusive with the structured pair (see `scheduleSummary`), so
  // this cannot show both.
  const scheduleText = schedule
    ? (schedule.legacy
      ?? ([schedule.days.length > 0 ? schedule.days.join(', ') : null, schedule.hours]
        .filter(Boolean)
        .join(' · ') || null))
    : null;
  const durationText = job ? durationLabel(job, tCommonDisplay) : null;
  const startText = job?.start_date
    ? (formatStartDate(job.start_date, locale) ?? job.start_date)
    : null;
  const tradeText = job ? tradeLabel(job, tTradeDisplay, tDetailDisplay) : null;
  const experienceText = job ? experienceLabel(job, tCommonDisplay) : null;
  const languageText = job?.language_preference && job.language_preference.length > 0
    ? job.language_preference.map((code) => tPublicJob(`language_${code}`)).join(' / ')
    : null;
  const postedText = job
    // `created_at` is an INSTANT, not a calendar day, so it goes through the
    // reader's-timezone formatter -- `formatStartDate` pins to UTC, which is
    // correct for `start_date` above and a day late for anything posted after
    // 18:00 in Mexico.
    ? (formatLongDate(job.created_at, locale) ?? job.created_at)
    : null;

  const scheduleTiles: JobFactTile[] = [];
  const whereTiles: JobFactTile[] = [];
  const requirementItems: JobFactRequirement[] = [];

  if (job) {
    if (scheduleText) {
      scheduleTiles.push({ key: 'shift', label: t('shift_schedule'), value: scheduleText });
    }
    if (durationText) {
      scheduleTiles.push({ key: 'duration', label: t('expected_duration'), value: durationText });
    }
    scheduleTiles.push({
      key: 'start',
      label: t('start_date'),
      value: startText ? <span className="tabular-nums">{startText}</span> : t('facts.start_unknown'),
      muted: !startText,
    });
    if (job.number_of_workers_needed !== undefined && job.number_of_workers_needed !== null) {
      scheduleTiles.push({
        key: 'openings',
        label: t('openings'),
        value: (
          <span className="tabular-nums">{`${job.open_count ?? 0}/${job.number_of_workers_needed}`}</span>
        ),
      });
    }

    whereTiles.push({ key: 'location', label: t('facts.location'), value: job.location });
    if (tradeText) {
      whereTiles.push({ key: 'trade', label: t('trade'), value: tradeText });
    }
    if (experienceText) {
      whereTiles.push({
        key: 'experience',
        label: t('required_experience'),
        value: <span className="tabular-nums">{experienceText}</span>,
      });
    }
    if (languageText) {
      whereTiles.push({ key: 'language', label: t('language'), value: languageText });
    }

    /*
     * Requirements are chips, and each one carries its state as WORDS
     * (`stateLabel`) rather than only as the dot's colour.
     *
     * Only a requirement that actually applies gets a chip -- this is the one
     * place the card states less than the old flat list did, which stated
     * `transportation_required: false` as "Not required". A chip row is a list
     * of what to bring; "you do not need a truck" does not belong on it.
     *
     * CERTIFICATIONS ARE DELIBERATELY ABSENT (owner ruling, fix round 1). This
     * page renders `WhatYouNeedPanel` a few inches below, which lists every
     * certification with its tier AND whether it is already in the worker's
     * vault -- the half a chip cannot say. Two lists of the same names, one of
     * them less informed, is worse than one.
     */
    const requiredWord = tRequirement('states.required');
    if (job.transportation_required) {
      requirementItems.push({
        key: 'transportation',
        label: t('transportation'),
        state: 'required',
        stateLabel: requiredWord,
      });
    }
    if (job.work_authorization_required) {
      requirementItems.push({
        key: 'work_authorization',
        label: t('facts.work_authorization'),
        state: 'required',
        stateLabel: requiredWord,
      });
    }
  }

  return (
    <AppShell
      role="worker"
      title={job?.title ?? t('page_title')}
      subtitle={job ? [job.company_name, job.location].filter(Boolean).join(' · ') : undefined}
    >
      <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
        {showSkeleton ? (
          /* Same archetype, same geometry, same back-link slot as `loading.tsx`,
             so the handover from the server-rendered route skeleton to this
             client one costs no visible swap. */
          <JobDetailSkeleton variant="worker" withBackLink />
        ) : (
          <div className="anim-fade-in">
            {/* Chrome the worker keeps in every state, including the S5 ones:
                an error must never be a dead end. */}
            <Link
              href={feedReturn.href}
              onClick={handleBackToFeed}
              className="mb-4 inline-block text-xs font-bold uppercase tracking-wide text-[var(--jale-ink-2)] transition-colors hover:text-[var(--jale-ink)]"
            >
              {t('back')}
            </Link>

            {phase === 'error' && errorKind ? (
              <DashboardPanel>{errorPanel(errorKind)}</DashboardPanel>
            ) : !job ? (
              /* Ready with no body at all -- treat it as the job not existing
                 rather than crashing on `job.title`. */
              <DashboardPanel>{errorPanel('not_found')}</DashboardPanel>
            ) : viewMode === 'apply' && idToken ? (
              /* In-page takeover: a view-state boolean, not a route change.
                 `key={job.id}` remounts the whole tree on a job-id change --
                 see `ApplyFlow`'s own doc comment for why that (not a
                 dispatched reset) is what actually clears its internal
                 transient state; the page's OWN lifted reducer state resets
                 separately, via the `appliedJobIdRef` effect above. */
              <ApplyFlow
                key={job.id}
                job={job}
                state={applyState}
                dispatch={applyDispatch}
                onSubmit={doApply}
                submitting={submitting}
                submitError={submitError}
                onBackToDetails={handleBackToDetails}
              />
            ) : (
              <div className="space-y-5">
                {refreshError ? (
                  <InlineFeedback tone="warning">{tCommon('feedback.refresh_failed')}</InlineFeedback>
                ) : null}

                {jobStatusBadge ? (
                  /* tone="info" → role="status": permanent page state, not an
                     event — role="alert" would announce assertively on every
                     load. Status-agnostic sentence, correct for filled too. */
                  <InlineFeedback tone="info">{t('errors.job_closed')}</InlineFeedback>
                ) : null}

                <DashboardPanel>
                  <PanelHeader
                    title={t('page_title')}
                    action={
                      jobTypeLabel || jobStatusBadge || postedText ? (
                        <span className="flex flex-wrap items-center justify-end gap-2">
                          {jobStatusBadge ? (
                            <JobStatusBadge status={jobStatusBadge}>
                              {tApps(`job_status.${jobStatusBadge}`)}
                            </JobStatusBadge>
                          ) : null}
                          {jobTypeLabel ? <Badge tone="info">{jobTypeLabel}</Badge> : null}
                          {/* The posted date lives HERE, not in the About
                              label, so a job with no description still says
                              how old it is (owner ruling, fix round 1). */}
                          {postedText ? <Badge>{`${t('posted')} ${postedText}`}</Badge> : null}
                        </span>
                      ) : undefined
                    }
                  />

                  <JobFactsCard
                    pay={pay ? {
                      label: t('pay_range'),
                      figure: pay,
                      /* Comparison against the job's own trade + city
                         (migration 065's city_key, now in
                         worker-jobs-detail's SELECT). Nullable-safe: an older
                         job / free-typed location with no city_key, or no
                         reference for the trade, and PayReferenceHint's own
                         guard renders nothing. */
                      hint: (
                        <PayReferenceHint
                          trade={job.trade_category ?? ''}
                          cityKey={job.city_key}
                          variant="worker-job"
                        />
                      ),
                    } : null}
                    schedule={{ label: t('facts.schedule'), tiles: scheduleTiles }}
                    where={{
                      label: t('facts.where'),
                      tiles: whereTiles,
                      /* One row here, not the employer's three: this page
                         states the job's policy requirements and leaves
                         certifications and documents to the two surfaces that
                         know the worker's vault -- `WhatYouNeedPanel` and the
                         Documents section below. */
                      chips: [{
                        key: 'policy',
                        label: t('facts.requirements'),
                        items: requirementItems,
                      }],
                    }}
                    /* The vault rows stay EXACTLY as they were, badges and
                       all: the worker page is the only one of the three that
                       knows whether a document is already uploaded, so this
                       section has no employer/public counterpart -- there the
                       job's documents are Requirements chips instead. */
                    documents={
                      job.required_docs.length > 0
                        ? {
                          label: t('facts.documents'),
                          children: (
                            <>
                              <ul className="divide-y divide-[var(--jale-divider)] overflow-hidden rounded-[var(--radius-input)] border border-[var(--jale-divider)]">
                                {job.required_docs.map((doc) => {
                                  const missing = job.missing_docs.includes(doc);
                                  return (
                                    <li key={doc} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                                      <span className="min-w-0 text-sm font-medium text-[var(--jale-ink)]">
                                        {docLabel(doc)}
                                      </span>
                                      <Badge tone={missing ? 'danger' : 'success'}>
                                        {missing ? t('doc_missing') : t('doc_ok')}
                                      </Badge>
                                    </li>
                                  );
                                })}
                              </ul>
                              {job.missing_docs.length > 0 ? (
                                <p className="mt-2 text-xs text-[var(--jale-ink-2)]">
                                  {t('upload_prompt')}{' '}
                                  <Link
                                    href="/worker/profile"
                                    className="font-semibold text-[var(--jale-blue-700)] underline underline-offset-2"
                                  >
                                    {t('upload_link')}
                                  </Link>
                                </p>
                              ) : null}
                            </>
                          ),
                        }
                        : null
                    }
                    about={
                      job.description
                        ? { label: t('facts.about'), text: job.description }
                        : null
                    }
                  />
                </DashboardPanel>

                {/* Pre-apply readiness preview -- questions/docs/certs and
                    what's already in the vault. Only meaningful BEFORE
                    applying; once `already_applied` is true there is nothing
                    left to prepare, so it is skipped rather than shown stale
                    next to the "Already applied" status chip below. */}
                {!job.already_applied ? (
                  <WhatYouNeedPanel job={job} vaultDocs={vaultDocs} />
                ) : null}

                {/* W3d: the same banner the applications list and the home
                    page show, so it does not matter where the worker lands.
                    `application_id` only arrives once they have applied -- the
                    banner needs it for its link, so both are required. */}
                {job.already_applied && job.details_status === 'requested' && job.application_id ? (
                  <DetailsRequestedBanner
                    applicationId={job.application_id}
                    companyName={job.company_name}
                    remainingCount={job.remaining?.counts
                      ? job.remaining.counts.prompts + job.remaining.counts.fields
                        + job.remaining.counts.certifications + job.remaining.counts.docs
                      : undefined}
                  />
                ) : null}

                {job.public_listing_enabled && job.status === 'active' ? (
                  <DashboardPanel>
                    <div className="p-5 md:p-6">
                      <ShareJobPanel jobId={id} />
                    </div>
                  </DashboardPanel>
                ) : null}

                <DashboardPanel>
                  <div className="flex flex-col gap-3 px-5 py-4 md:px-6">
                    {/* Anchored to the control that produced it -- never the
                        page top, where a worker who just tapped Apply would
                        have to go looking for the answer. */}
                    {applyFeedback ? (
                      <InlineFeedback
                        tone={applyFeedback.tone}
                        onDismiss={() => setApplyFeedback(null)}
                      >
                        {applyFeedback.message}
                      </InlineFeedback>
                    ) : null}

                    <div className="flex flex-wrap items-center justify-end gap-3">
                      {job.already_applied ? (
                        <>
                          <span className="text-sm font-medium text-[var(--jale-ink-2)]">
                            {t('already_applied')}
                          </span>
                          <ApplicationStatusChip status={job.application_status ?? 'pending'} short />
                        </>
                      ) : (
                        <Button
                          onClick={handleApplyClick}
                          disabled={!canApply}
                          loading={applying}
                          loadingLabel={tCommon('loading')}
                        >
                          {/* "Continue application" once the worker has left
                              something behind in the flow (an answer, a visit
                              past step 1, a cert claim) -- otherwise the
                              plain "Apply" a first-time visitor sees. */}
                          {flowHasProgress(applyState) ? tFlow('continue_button') : t('apply')}
                        </Button>
                      )}
                    </div>
                  </div>
                </DashboardPanel>
              </div>
            )}

            {/* A modal overlay, not "details content" -- stays reachable
                regardless of `viewMode` rather than living inside the
                details-only branch above. */}
            {job ? (
              <ProfileCompleteModal
                open={modalOpen}
                initial={profilePrefill ?? undefined}
                onClose={() => setModalOpen(false)}
                onSubmit={handleModalSubmit}
              />
            ) : null}
          </div>
        )}
      </main>
    </AppShell>
  );
}
