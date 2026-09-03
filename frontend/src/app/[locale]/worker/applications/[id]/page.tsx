'use client';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { usePageData } from '@/hooks/usePageData';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardPanel } from '@/components/ui/dashboard-panel';
import { ErrorState } from '@/components/ui/error-state';
import { DetailPageSkeleton } from '@/components/ui/page-skeletons';
import { ApplicationRequirementsFlow } from '@/components/worker/application-requirements/ApplicationRequirementsFlow';
import { getApplicationRequirements, type ApplicationRequirementsState } from '@/lib/api/worker';

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
        ) : (
          <div className="anim-fade-in">
            <ApplicationRequirementsFlow key={id} token={idToken} initialState={data} />
          </div>
        )}
      </main>
    </AppShell>
  );
}
