import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { TemplateTableSkeleton } from '@/components/ui/page-skeletons';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Route-level loading UI for the employer templates manager.
 *
 * Geometry traces the real page: the meter + "New template" action row (text
 * line left, default-size button pill right) above the table panel. The
 * client page's own loading branch renders the same `TemplateTableSkeleton`,
 * so the route→client handover costs no layout shift.
 */
export default function Loading() {
    return (
        <AppShellSkeleton role="employer">
            <main className="mx-auto max-w-4xl px-4 py-6 md:px-6">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                    <Skeleton className="h-3.5 w-36" />
                    <Skeleton className="h-11 w-36 rounded-full" />
                </div>
                <TemplateTableSkeleton />
            </main>
        </AppShellSkeleton>
    );
}
