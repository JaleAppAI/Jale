'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { usePageData } from '@/hooks/usePageData';
import { Link } from '@/i18n/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { Badge, JobStatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { ErrorState } from '@/components/ui/error-state';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { KVList, type KVItem } from '@/components/ui/kv-list';
import { DetailPageSkeleton } from '@/components/ui/page-skeletons';
import { PanelHeader } from '@/components/ui/panel-header';
import { ApplicationStatusChip } from '@/components/worker/ApplicationStatusChip';
import { PayReferenceHint } from '@/components/PayReferenceHint';
import { ShareJobPanel } from '@/components/worker/ShareJobPanel';
import { WhatYouNeedPanel } from '@/components/worker/WhatYouNeedPanel';
import { ProfileCompleteModal, type ProfileCompleteValues } from '@/components/worker/ProfileCompleteModal';
import { ApplyFlow, type ApplyFlowSubmitError, type ApplyFlowSubmitPayload } from '@/components/worker/apply-flow/ApplyFlow';
import { apiFetch, isLegalWallError } from '@/lib/api';
import { ApiError, classifyError, parseApiError, type ErrorKind } from '@/lib/api/errors';
import { applyFlowReducer, initialApplyFlowState, flowHasProgress } from '@/lib/apply-flow-view';
import { formatLongDate, formatStartDate } from '@/lib/date';
import { docTypeLabel } from '@/lib/doc-types';
import { durationLabel, scheduleSummary, type Translator } from '@/lib/job-detail-display';
import { formatPay } from '@/lib/pay';
import {
  getJob, applyToJob, updateWorkerProfile, getVaultDocuments, getApplicationDefaults,
  type JobDetail, type WorkerApiError, type WorkerVaultDoc, type ApplicationDefaults,
} from '@/lib/api/worker';
import { visibleJobStatusBadge } from '@/lib/jobStatusDisplay';

export const dynamic = 'force-dynamic';

const KNOWN_JOB_TYPES = ['full-time', 'part-time', 'contract'];

/** Where "back to jobs" goes, and the destination the S5 states offer. */
const JOBS_HREF = '/worker/home';

// 'info' is for the "your progress is saved" note shown when a worker backs
// out of the in-page apply flow with unsubmitted progress -- not an error and
// not a completed action, so neither 'danger' nor 'success' fits.
type ApplyFeedback = { tone: 'danger' | 'success' | 'info'; message: string };

export default function WorkerJobDetailPage() {
  const { id } = useParams<{ id: string; locale: string }>();
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
  const tReq = useTranslations('job_requirements');
  // `public_job.language_*` reused for the same reason `tApps` above avoids
  // `employer_dashboard.jobs.status.*`: that flat Any/English/Spanish
  // vocabulary carries no page-specific framing, and `public_job` is the
  // exact sibling surface this task matches display parity against (which
  // itself borrows `worker_job_detail.what_you_need.proof_needed` the same
  // way) -- reuse over a duplicate `worker_job_detail`-scoped copy.
  const tPublicJob = useTranslations('public_job');
  const tDocTypes = useTranslations('doc_types');
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
  const tCommonDisplay: Translator = (key, values) =>
    (tCommon as unknown as (k: string, v?: Record<string, unknown>) => string)(key, values);

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
  const [applyState, applyDispatch] = useReducer(applyFlowReducer, undefined, () => initialApplyFlowState([]));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApplyFlowSubmitError | null>(null);
  const [defaults, setDefaults] = useState<ApplicationDefaults | null>(null);
  // Guards the once-per-job-id `getApplicationDefaults` fetch ("on first open
  // of the flow") the same way `ApplyFlow`'s own `appliedDefaultsForJobRef`
  // guards its one-time `apply_defaults` dispatch -- both keyed on job.id,
  // not fetched-once-ever, since a worker can navigate this same page
  // instance from one job to another (`usePageData`'s `deps: [id]`).
  const defaultsLoadedForJobRef = useRef<string | null>(null);
  // One shared vault fetch for both `WhatYouNeedPanel` (details view) and
  // `ApplyFlow` (apply view) -- `null` means "failed or not yet loaded",
  // which both components already degrade on independently.
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
    const certNames = (job.certification_requirements ?? []).map((cert) => cert.name);
    applyDispatch({ type: 'reset', certNames });
    setSubmitError(null);
    setDefaults(null);
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
   * Opens the in-page apply flow and, on its first open for THIS job.id,
   * kicks off the best-effort `getApplicationDefaults` prefill fetch
   * (failures swallowed to `null` -- per that call's own doc comment this is
   * a convenience pre-fill, never a blocker to applying). Reused by both the
   * direct Apply tap (profile already complete) and by `handleModalSubmit`
   * (profile just completed) -- the flow always opens next, replacing the
   * old ApplicationAnswersForm modal AND the old direct-`doApply()` shortcut
   * for jobs with nothing to ask: every apply now goes through the flow's
   * own Review step to submit.
   */
  function openApplyFlow() {
    setViewMode('apply');
    if (job && idToken && defaultsLoadedForJobRef.current !== job.id) {
      defaultsLoadedForJobRef.current = job.id;
      void getApplicationDefaults(idToken)
        .then(setDefaults)
        .catch(() => setDefaults(null));
    }
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

  /** `ApplyFlow`'s `onSubmit` -- a straight pass-through onto `applyToJob`'s
   * two trailing params, per `ReviewStep.tsx`'s documented payload contract. */
  async function doApply(payload: ApplyFlowSubmitPayload) {
    if (!idToken || !id) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const application = await applyToJob(idToken, id, payload.answers, payload.certification_claims);
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
      if (fromFlow) setSubmitError({ kind: 'generic', message });
      else showApplyError(message);
    };

    if (isLegalWallError(err)) {
      try { handleLegalWall(err, `/worker/jobs/${id}`); }
      catch { reportProblem(t('errors.legal_required')); }
      return;
    }

    // These two 400 codes can only ever come back from a flow submission
    // (`ApplyFlow`'s Review step already gates locally on the same
    // `certification-claims.ts` rules `worker-jobs-apply` enforces
    // server-side) -- they exist as a stale-gate backstop, mirroring
    // `missing_answers` below. `missing_certification_proof` carries the
    // still-unproven cert names (`lib/api/errors.ts`'s `certs` payload key);
    // `ReviewStep` does the `{certs}` join itself. `missing_certification_claims`
    // carries no payload at all, so it maps to the closest existing generic
    // "some required answers are missing" copy (`errors.required_cert` needs
    // a `{name}` this code's body does not carry).
    if (fromFlow && err instanceof ApiError && err.code === 'missing_certification_proof') {
      setSubmitError({ kind: 'missing_certification_proof', certs: err.payload.certs ?? [] });
      return;
    }
    if (fromFlow && err instanceof ApiError && err.code === 'missing_certification_claims') {
      setSubmitError({ kind: 'generic', message: tReq('errors.missing_answers') });
      return;
    }

    const applyErr = err as WorkerApiError;
    if (applyErr.status === 400 && applyErr.missing_docs?.length) {
      // The one payload-carrying branch: it names the documents that are
      // missing, which is the only thing that makes the message actionable.
      reportProblem(t('errors.missing_docs', {
        docs: applyErr.missing_docs.map(docLabel).join(', '),
      }));
      return;
    }
    if (applyErr.status === 400 && applyErr.code === 'missing_answers') {
      // The gate should have blocked this locally (`canSubmitAnswers`) --
      // this is the backstop for a stale gate (job requirements changed
      // between load and submit) or a client bypassing the gate entirely.
      const missingFields = applyErr.missing_fields;
      reportProblem(
        missingFields?.length
          ? tReq('errors.missing_answers_fields', {
              fields: missingFields.map((key) => tReq(`fields.${key}`)).join(', '),
            })
          : tReq('errors.missing_answers'),
      );
      return;
    }
    if (applyErr.status === 400 && applyErr.code === 'invalid_answers') {
      reportProblem(tReq('errors.invalid_answers'));
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
          backHref={JOBS_HREF}
          title={t('not_found.title')}
          body={t('not_found.body')}
        />
      );
    }
    if (kind === 'gone') {
      return (
        <ErrorState
          kind="gone"
          backHref={JOBS_HREF}
          title={t('closed.title')}
          body={t('closed.body')}
        />
      );
    }
    // Everything else keeps whatever retry `ErrorState` judges honest for the
    // kind. `backHref` is passed for all of them deliberately: a worker stuck
    // on one job's failure should always have the jobs list one tap away, and
    // no kind is relabelled to obtain that button.
    return <ErrorState kind={kind} onRetry={retry} backHref={JOBS_HREF} />;
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

  const facts: KVItem[] = [];
  if (job) {
    if (job.start_date) {
      facts.push({
        label: t('start_date'),
        value: <span className="tabular-nums">{formatStartDate(job.start_date, locale) ?? job.start_date}</span>,
      });
    }

    // Trade: deliberately NOT `job-detail-display.ts`'s `tradeLabel` -- that
    // helper's `tTrade` translator is meant to resolve the slug through a
    // real per-slug catalogue (see its doc comment), and `worker_job_detail`
    // has none (only the flat `trade` row label), exactly the same gap the
    // merged public `/j/[code]` page's own comment documents for itself. This
    // mirrors that page's inline idiom instead: an employer-typed "other"
    // trade renders verbatim via `trade_with_other` (never capitalized -- it
    // is free text, not a taxonomy slug); every other value is the raw
    // `trade_category` slug, title-cased by CSS only (dates/numbers elsewhere
    // on this page must never get that treatment).
    if (job.trade_category) {
      const customTrade = job.trade_category === 'other' ? job.trade_category_other?.trim() : null;
      facts.push({
        label: t('trade'),
        value: customTrade
          ? t('trade_with_other', { other: customTrade })
          : <span className="capitalize">{job.trade_category}</span>,
      });
    }

    // Schedule: structured `work_days`/`shift_start`/`shift_end` (via the
    // shared `scheduleSummary` formatter) win over the legacy free-text
    // `shift_schedule` string whenever ANY structured schedule data exists --
    // same fallback matrix the public page uses, including its documented
    // edge case: a job with only a one-sided `shift_start` (no `work_days`)
    // renders no shift row at all rather than mixing legacy text with a
    // partial structured render (`scheduleSummary`'s own documented intent,
    // not a regression).
    const schedule = scheduleSummary(job, locale, tCommonDisplay);
    if (schedule.legacy) {
      facts.push({ label: t('shift_schedule'), value: schedule.legacy });
    } else {
      if (schedule.days.length > 0) {
        facts.push({
          label: t('work_days_label'),
          value: (
            <span className="flex flex-wrap justify-end gap-1.5">
              {schedule.days.map((day) => (
                <Badge key={day} tone="neutral">{day}</Badge>
              ))}
            </span>
          ),
        });
      }
      if (schedule.hours) {
        facts.push({ label: t('shift_hours'), value: schedule.hours });
      }
    }

    const durationText = durationLabel(job, tCommonDisplay);
    if (durationText) {
      facts.push({ label: t('duration'), value: durationText });
    }

    if (job.number_of_workers_needed !== undefined && job.number_of_workers_needed !== null) {
      facts.push({
        label: t('openings'),
        value: <span className="tabular-nums">{`${job.open_count ?? 0}/${job.number_of_workers_needed}`}</span>,
      });
    }
    if (job.required_experience_years !== undefined && job.required_experience_years !== null) {
      facts.push({
        label: t('required_experience'),
        value: <span className="tabular-nums">{String(job.required_experience_years)}</span>,
      });
    }
    if (job.work_authorization_required) {
      facts.push({
        label: t('work_authorization_required'),
        value: t('work_authorization_required_yes'),
      });
    }
    // Transportation, unlike work-authorization above, shows in BOTH states
    // (dedicated yes/no keys) rather than only when required -- the public
    // page's "what you need" card omits it when false since that card only
    // ever lists applicable requirements, but this page's flat facts list
    // states every known fact plainly either way.
    if (job.transportation_required !== undefined && job.transportation_required !== null) {
      facts.push({
        label: t('transportation'),
        value: job.transportation_required
          ? t('transportation_required_yes')
          : t('transportation_required_no'),
      });
    }
    if (job.language_preference && job.language_preference.length > 0) {
      facts.push({
        label: t('language'),
        value: job.language_preference.map((code) => tPublicJob(`language_${code}`)).join(' / '),
      });
    }
    facts.push({
      label: t('posted'),
      // `created_at` is an INSTANT, not a calendar day, so it goes through the
      // reader's-timezone formatter. It used to reuse `formatStartDate`, which
      // pins to UTC -- correct for `start_date` above, a day late here for
      // anything posted after 18:00 in Mexico.
      value: <span className="tabular-nums">{formatLongDate(job.created_at, locale) ?? job.created_at}</span>,
    });
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
          <DetailPageSkeleton withBackLink />
        ) : (
          <div className="anim-fade-in">
            {/* Chrome the worker keeps in every state, including the S5 ones:
                an error must never be a dead end. */}
            <Link
              href={JOBS_HREF}
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
                token={idToken}
                state={applyState}
                dispatch={applyDispatch}
                vaultDocs={vaultDocs}
                onVaultChanged={fetchVaultDocs}
                defaults={defaults}
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
                      jobTypeLabel || jobStatusBadge ? (
                        <span className="flex items-center gap-2">
                          {jobStatusBadge ? (
                            <JobStatusBadge status={jobStatusBadge}>
                              {tApps(`job_status.${jobStatusBadge}`)}
                            </JobStatusBadge>
                          ) : null}
                          {jobTypeLabel ? <Badge tone="info">{jobTypeLabel}</Badge> : null}
                        </span>
                      ) : undefined
                    }
                  />

                  <div className="space-y-5 p-5 md:p-6">
                    {/* Pay is promoted out of the field list and set as a
                        headline figure: it is the one fact a worker decides on,
                        and as a KV row it read exactly as loud as "Shift". */}
                    {pay ? (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">
                          {t('pay_range')}
                        </p>
                        <p className="mt-1 text-2xl font-extrabold tabular-nums tracking-tight text-[var(--jale-ink)] md:text-3xl">
                          {pay}
                        </p>
                        {/* Comparison against the job's own trade + city
                            (migration 065's city_key, now in
                            worker-jobs-detail's SELECT). Nullable-safe: an
                            older job / free-typed location with no city_key,
                            or no reference for the trade, and
                            PayReferenceHint's own guard renders nothing. */}
                        <div className="mt-2">
                          <PayReferenceHint
                            trade={job.trade_category ?? ''}
                            cityKey={job.city_key}
                            variant="worker-job"
                          />
                        </div>
                      </div>
                    ) : null}

                    {job.description ? (
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--jale-ink)]">
                        {job.description}
                      </p>
                    ) : null}

                    {facts.length > 0 ? <KVList items={facts} /> : null}

                    {job.required_docs.length > 0 ? (
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">
                          {t('required_docs')}
                        </p>
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
                      </div>
                    ) : null}
                  </div>
                </DashboardPanel>

                {/* Pre-apply readiness preview -- questions/docs/certs and
                    what's already in the vault. Only meaningful BEFORE
                    applying; once `already_applied` is true there is nothing
                    left to prepare, so it is skipped rather than shown stale
                    next to the "Already applied" status chip below. */}
                {!job.already_applied ? (
                  <WhatYouNeedPanel job={job} vaultDocs={vaultDocs} />
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
                          <ApplicationStatusChip status={job.application_status ?? 'pending'} />
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
