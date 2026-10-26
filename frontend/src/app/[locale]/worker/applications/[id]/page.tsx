'use client';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { usePageData } from '@/hooks/usePageData';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { ErrorState } from '@/components/ui/error-state';
import { DetailPageSkeleton } from '@/components/ui/page-skeletons';
import { HiredCard } from '@/components/worker/HiredCard';
import { ApplicationRequirementsFlow } from '@/components/worker/application-requirements/ApplicationRequirementsFlow';
import { realCompanyName } from '@/lib/employer-name';
import { terminalScreen } from '@/lib/application-requirements-flow';
import { useTutorial } from '@/lib/tutorials/use-tutorial';
import {
  getApplicationRequirements,
  getApplications,
  type ApplicationRequirementsState,
} from '@/lib/api/worker';

export const dynamic = 'force-dynamic';

const APPLICATIONS_HREF = '/worker/applications';

/**
 * `/worker/applications/[id]` -- the stage-2 door on the web.
 *
 * THE PAGE OWNS THE FIRST LOAD ONLY. `usePageData` fetches the state document
 * once, and `ApplicationRequirementsFlow` owns everything after that: it holds
 * the reducer, makes every write, and re-reads on its own. The `key={id}`
 * remount is what resets that reducer when the worker navigates from one
 * application to another on this same page instance -- the flow deliberately
 * has no reset-on-prop-change effect, which is the anti-pattern the sprint-22
 * flows document at length.
 *
 * THE NAV NEEDS NO CHANGE. `workerPrimaryNav`'s "My applications" entry is not
 * `exact`, so `isNavItemActive` prefix-matches `/worker/applications/` and this
 * page lights it up already (verified against `nav-config.ts`, not assumed).
 *
 * A FOREIGN OR MISSING ID IS A 404 from the door, which `usePageData`
 * classifies as `not_found` -- rendered as a terminal `ErrorState` with the way
 * back, not as a retry the worker could never win. `notFound()` is deliberately
 * not called, for the same reason the job detail page avoids it: throwing to
 * the route-level 404 drops the nav chrome the worker needs to get anywhere.
 */
export default function WorkerApplicationDetailsPage() {
  const { id } = useParams<{ id: string; locale: string }>();
  const { idToken } = useAuth();
  const t = useTranslations('worker_application_details');

  const { phase, data, errorKind, retry } = usePageData<ApplicationRequirementsState>({
    fetcher: ({ token, signal }) => getApplicationRequirements(token, id, signal),
    legalReturnUrl: `/worker/applications/${id}`,
    // The application id is the whole identity of this page.
    deps: [id],
  });

  // 'auth' means the token gate has not opened yet: nothing has been asked
  // for, so the page owes the reader the same skeleton `loading.tsx` painted.
  const showSkeleton = phase === 'auth' || phase === 'loading';

  /*
   * W3, the details tutorial, played as its step-by-step guide
   * (`components/tutorials/guides/worker-details.ts`); Help's Play still
   * shows its slides. It walks the stepper (and the employer's questions left
   * from applying, ahead of it), so it is asked for only when that is what
   * this page shows: not over the hired card, and not over a terminal panel
   * (the same `terminalScreen` check the flow makes on this same first
   * state). Its K1.5 signal -- any application with
   * its details completed -- is read from the worker's applications (the 100
   * the list serves at most; past that the answer covers the newest 100) and
   * only in that case. `done` stays `undefined` until the read answers, and on
   * a failure: no signal, no auto-open on this page view.
   */
  const showsStepper = Boolean(
    phase === 'ready'
    && data
    && idToken
    && !(data.application.status === 'hired' && data.hire)
    && terminalScreen(data) === null,
  );
  const [detailsDoneBefore, setDetailsDoneBefore] = useState<boolean | undefined>(undefined);
  const readApplications = useEffectEvent((signal: AbortSignal) => (
    idToken ? getApplications(idToken, signal, { limit: 100 }) : null
  ));
  useEffect(() => {
    if (!showsStepper) return;
    const controller = new AbortController();
    readApplications(controller.signal)
      ?.then((page) => setDetailsDoneBefore(page.applications.some((a) => Boolean(a.details_completed_at))))
      .catch(() => { /* no signal, no auto-open: `done` stays undefined */ });
    return () => controller.abort();
  }, [showsStepper]);
  const detailsTutorial = useTutorial('worker_details', { done: detailsDoneBefore, walkthrough: true });

  // Asked ONCE per page view, once the signal is known; whether it opens is
  // the tutorial's decision (a record, the signal, another overlay).
  const detailsTutorialAskedRef = useRef(false);
  const askDetailsTutorial = useEffectEvent(() => detailsTutorial.maybeAutoOpen());
  useEffect(() => {
    if (detailsTutorialAskedRef.current) return;
    if (!showsStepper || detailsDoneBefore === undefined) return;
    detailsTutorialAskedRef.current = true;
    askDetailsTutorial();
  }, [showsStepper, detailsDoneBefore]);

  return (
    <AppShell role="worker" title={t('title')}>
      <main className="mx-auto max-w-3xl px-4 py-6 md:px-6">
        {showSkeleton ? (
          <DetailPageSkeleton withBackLink />
        ) : phase === 'error' && errorKind ? (
          <DashboardPanel>
            {errorKind === 'not_found' ? (
              <ErrorState kind="not_found" backHref={APPLICATIONS_HREF} />
            ) : (
              <ErrorState kind={errorKind} onRetry={retry} backHref={APPLICATIONS_HREF} />
            )}
          </DashboardPanel>
        ) : !data || !idToken ? (
          /* Ready with no body, or a token that vanished mid-render. Treat it
             as the application not existing rather than crashing on `.job`. */
          <DashboardPanel>
            <ErrorState kind="not_found" backHref={APPLICATIONS_HREF} />
          </DashboardPanel>
        ) : data.application.status === 'hired' && data.hire ? (
          /* A hire with its hire block: details, Remind and the message box
             (F19). Without the block -- a backend that predates it -- the
             flow below still shows today's "You got this job!" panel. */
          <div className="anim-fade-in">
            <HiredCard
              key={id}
              applicationId={id}
              jobTitle={data.job.title}
              companyName={realCompanyName(data.job.company_name)}
              hire={data.hire}
              sentMessages={data.sent_messages ?? []}
            />
          </div>
        ) : (
          <div className="anim-fade-in">
            <ApplicationRequirementsFlow key={id} token={idToken} initialState={data} />
          </div>
        )}
      </main>
    </AppShell>
  );
}
