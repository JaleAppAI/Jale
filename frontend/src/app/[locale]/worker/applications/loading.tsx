import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { ListPageSkeleton } from '@/components/ui/page-skeletons';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Route-level loading UI for the worker applications list.
 *
 * The metric-row block is new: the page used to render three `MetricCard`s
 * holding a `'-'` while it fetched, so the KPI row occupied its full height
 * from the first paint. Now that the row is a skeleton until real numbers
 * exist, this file has to model it too — otherwise the handover from this
 * server-rendered skeleton to the client one would drop a ~76px band in above
 * the list and shove the whole panel down.
 *
 * Geometry is traced from the minimal `MetricCard` (32px figure over a small
 * label), the same tracing `DashboardSkeleton` uses for its 4-up row.
 */
export default function Loading() {
    return (
        <AppShellSkeleton role="worker">
            <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                <div className="mb-5 grid gap-4 sm:grid-cols-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="min-w-0 py-1">
                            <Skeleton className="h-8 w-16" />
                            <Skeleton className="mt-2 h-2.5 w-24" />
                        </div>
                    ))}
                </div>
                <ListPageSkeleton />
            </main>
        </AppShellSkeleton>
    );
}
