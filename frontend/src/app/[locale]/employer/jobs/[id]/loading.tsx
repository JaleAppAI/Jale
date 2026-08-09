import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import {
    DetailPageSkeleton,
    ListPageSkeleton,
    MetricRowSkeleton,
} from '@/components/ui/page-skeletons';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Route-level skeleton for the employer job page.
 *
 * The page now paints four bands (back link, metric row, job detail panel,
 * applicant list), so the single `DetailPageSkeleton` this used to render
 * described a layout that no longer exists and cost a visible jump at handover.
 * The geometry below is identical to the page's own `JobPageSkeleton`; a route
 * file cannot import from a `'use client'` page module, which is exactly why
 * these archetypes are exported from `ui/page-skeletons`.
 */
export default function Loading() {
    return (
        <AppShellSkeleton role="employer">
            <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                <Skeleton className="mb-4 h-3.5 w-24" />
                <div className="mb-5">
                    <MetricRowSkeleton count={3} />
                </div>
                <DetailPageSkeleton fields={8} />
                <div className="mt-5">
                    <ListPageSkeleton rows={4} />
                </div>
            </main>
        </AppShellSkeleton>
    );
}
