import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import {
    JobDetailSkeleton,
    ListPageSkeleton,
    MetricRowSkeleton,
} from '@/components/ui/page-skeletons';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Route-level skeleton for the employer job page.
 *
 * The page paints four bands (back link, metric row, job detail panel,
 * applicant list), so a single detail skeleton would describe a layout that
 * does not exist and cost a visible jump at handover. The geometry below is
 * identical to the page's own `JobPageSkeleton` and must stay that way; a route
 * file cannot import from a `'use client'` page module, which is exactly why
 * these archetypes are exported from `ui/page-skeletons`.
 *
 * `JobDetailSkeleton`, not `DetailPageSkeleton`: the job panel's body is now
 * `FactsCard` (a pay headline, tiles, chips, a paragraph), not a `KVList`.
 */
export default function Loading() {
    return (
        <AppShellSkeleton role="employer">
            <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                <Skeleton className="mb-4 h-3.5 w-24" />
                <div className="mb-5">
                    <MetricRowSkeleton count={3} />
                </div>
                <JobDetailSkeleton />
                <div className="mt-5">
                    <ListPageSkeleton rows={4} />
                </div>
            </main>
        </AppShellSkeleton>
    );
}
