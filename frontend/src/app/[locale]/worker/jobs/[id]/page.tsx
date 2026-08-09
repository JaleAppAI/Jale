'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { usePageData } from '@/hooks/usePageData';
import { Link } from '@/i18n/navigation';
import { AppShell } from '@/components/layout/AppShell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { ErrorState } from '@/components/ui/error-state';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { KVList, type KVItem } from '@/components/ui/kv-list';
import { MatchScoreBadge } from '@/components/ui/match-signals';
import { DetailPageSkeleton } from '@/components/ui/page-skeletons';
import { PanelHeader } from '@/components/ui/panel-header';
import { ApplicationStatusChip } from '@/components/worker/ApplicationStatusChip';
import { ShareJobPanel } from '@/components/worker/ShareJobPanel';
import { ProfileCompleteModal, type ProfileCompleteValues } from '@/components/worker/ProfileCompleteModal';
import { apiFetch, isLegalWallError } from '@/lib/api';
import { ApiError, classifyError, parseApiError, type ErrorKind } from '@/lib/api/errors';
import { formatStartDate } from '@/lib/date';
import { normalizeMatchScore, scoreBandForScore } from '@/lib/match';
import { getJob, applyToJob, updateWorkerProfile } from '@/lib/api/worker';
import type { JobDetail, WorkerApiError } from '@/lib/api/worker';

export const dynamic = 'force-dynamic';

const KNOWN_DOC_TYPES = ['resume', 'driver_license', 'ssn'];
const KNOWN_JOB_TYPES = ['full-time', 'part-time', 'contract'];

/** Where "back to jobs" goes, and the destination the S5 states offer. */
const JOBS_HREF = '/worker/home';

/** The API's sentinel for "the employer did not state a rate". Not a figure. */
const PAY_UNSPECIFIED = 'Pay not specified';

type ApplyFeedback = { tone: 'danger' | 'success'; message: string };

export default function WorkerJobDetailPage() {
  const { id } = useParams<{ id: string; locale: string }>();
  const { idToken } = useAuth();
  const { handleLegalWall } = useRequireAuth();
  const t = useTranslations('worker_job_detail');
  const tCommon = useTranslations('common');
  const tMatch = useTranslations('match');
  const locale = useLocale();

  const [applying, setApplying] = useState(false);
  const [applyFeedback, setApplyFeedback] = useState<ApplyFeedback | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [profilePrefill, setProfilePrefill] = useState<Partial<ProfileCompleteValues> | null>(null);

  const {
    phase,
    data: job,
    errorKind,
    refreshError,
    retry,
    refresh,
    setData,
  } = usePageData<JobDetail>({
    fetcher: ({ token }) => getJob(token, id),
    legalReturnUrl: `/worker/jobs/${id}`,
    // The job id is the whole identity of this page: navigating between two
    // job details must drop the previous job rather than briefly render it
    // under the new title.
    deps: [id],
  });

  function showApplyError(message: string) {
    setApplyFeedback({ tone: 'danger', message });
  }

  function docLabel(doc: string): string {
    return KNOWN_DOC_TYPES.includes(doc) ? t(`doc_labels.${doc}`) : doc;
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
      await doApply();
    } catch (err) {
      await handleApplyError(err);
    } finally {
      setApplying(false);
    }
  }

  async function doApply() {
    if (!idToken || !id) return;
    setApplying(true);
    try {
      const application = await applyToJob(idToken, id);
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
      await refresh();
    } catch (err) {
      await handleApplyError(err);
    } finally {
      setApplying(false);
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
    await doApply();
  }

  /**
   * The apply-error taxonomy.
   *
   * Every branch below is a distinct thing that can go wrong when a worker taps
   * Apply, and each one gets its own translated sentence -- "you already
   * applied" is not "this job closed" is not "we are broken". Only the
   * PRESENTATION changed in the refresh: the message is anchored to the apply
   * control as `InlineFeedback tone="danger"` instead of drifting to the page
   * bottom, and `err.message` (an untranslated backend code) is never rendered.
   *
   * The three branches that reload do it through `refresh()`, not a full
   * reload: the worker keeps reading the job while the truth catches up, and a
   * refresh that itself fails cannot blank the page.
   */
  async function handleApplyError(err: unknown) {
    if (isLegalWallError(err)) {
      try { handleLegalWall(err, `/worker/jobs/${id}`); }
      catch { showApplyError(t('errors.legal_required')); }
      return;
    }

    const applyErr = err as WorkerApiError;
    if (applyErr.status === 400 && applyErr.missing_docs?.length) {
      // The one payload-carrying branch: it names the documents that are
      // missing, which is the only thing that makes the message actionable.
      showApplyError(t('errors.missing_docs', {
        docs: applyErr.missing_docs.map(docLabel).join(', '),
      }));
      return;
    }
    if (applyErr.status === 400) {
      showApplyError(t('errors.profile_invalid'));
      return;
    }
    if (applyErr.status === 401) {
      showApplyError(t('errors.not_signed_in'));
      return;
    }
    if (applyErr.status === 403 || applyErr.code === 'legal_required') {
      showApplyError(t('errors.legal_required'));
      return;
    }
    if (applyErr.status === 409) {
      if (applyErr.code === 'user_not_provisioned') showApplyError(t('errors.account_not_ready'));
      else showApplyError(t('errors.already_applied'));
      await refresh();
      return;
    }
    if (applyErr.status === 410 || applyErr.status === 404) {
      showApplyError(t('errors.job_closed'));
      await refresh();
      return;
    }
    if (applyErr.status && applyErr.status >= 500) {
      showApplyError(t('errors.server_error'));
      return;
    }
    // A dead connection is not a profile problem. Without this, both fall
    // through to `apply_failed` ("check your profile and documents"), which
    // sends the worker off to fix something that is not broken. The shared
    // connectivity copy already says the right thing in both locales.
    const { kind } = classifyError(err);
    if (kind === 'offline' || kind === 'timeout') {
      showApplyError(tCommon(`errors.${kind}`));
      return;
    }
    showApplyError(t('errors.apply_failed'));
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
  const pay = job?.pay && job.pay !== PAY_UNSPECIFIED ? job.pay : null;
  const matchScore = normalizeMatchScore(job?.match_score);
  const matchBand = matchScore === null ? null : scoreBandForScore(matchScore);
  const canApply = job ? !job.already_applied && job.missing_docs.length === 0 : false;

  const facts: KVItem[] = [];
  if (job) {
    if (job.start_date) {
      facts.push({
        label: t('start_date'),
        value: <span className="tabular-nums">{formatStartDate(job.start_date, locale) ?? job.start_date}</span>,
      });
    }
    if (job.expected_duration) {
      facts.push({ label: t('expected_duration'), value: job.expected_duration });
    }
    if (job.shift_schedule) {
      facts.push({ label: t('shift_schedule'), value: job.shift_schedule });
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
    facts.push({
      label: t('posted'),
      value: <span className="tabular-nums">{formatStartDate(job.created_at, locale) ?? job.created_at}</span>,
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
            ) : (
              <div className="space-y-5">
                {refreshError ? (
                  <InlineFeedback tone="warning">{tCommon('feedback.refresh_failed')}</InlineFeedback>
                ) : null}

                <DashboardPanel>
                  <PanelHeader
                    title={t('page_title')}
                    action={jobTypeLabel ? <Badge tone="info">{jobTypeLabel}</Badge> : undefined}
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
                      </div>
                    ) : null}

                    {matchBand && matchScore !== null ? (
                      <MatchScoreBadge
                        score={matchScore}
                        band={matchBand}
                        label={tMatch(`score_bands.${matchBand}`)}
                      />
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

                <DashboardPanel>
                  <div className="p-5 md:p-6">
                    <ShareJobPanel jobId={id} />
                  </div>
                </DashboardPanel>

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
                          {t('apply')}
                        </Button>
                      )}
                    </div>
                  </div>
                </DashboardPanel>

                <ProfileCompleteModal
                  open={modalOpen}
                  initial={profilePrefill ?? undefined}
                  onClose={() => setModalOpen(false)}
                  onSubmit={handleModalSubmit}
                />
              </div>
            )}
          </div>
        )}
      </main>
    </AppShell>
  );
}
