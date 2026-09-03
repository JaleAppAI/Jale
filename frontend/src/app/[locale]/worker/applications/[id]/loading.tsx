import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { DetailPageSkeleton } from '@/components/ui/page-skeletons';

/**
 * Route-level loading UI for the stage-2 details page.
 *
 * Same archetype, same `max-w-3xl` column and same back-link slot as the page
 * itself renders while `usePageData` is in its 'auth'/'loading' phase, so the
 * handover from this server-rendered skeleton to the client one costs no
 * visible swap.
 */
export default function Loading() {
    return (
        <AppShellSkeleton role="worker">
            <main className="mx-auto max-w-3xl px-4 py-6 md:px-6">
                <DetailPageSkeleton withBackLink />
            </main>
        </AppShellSkeleton>
    );
}
