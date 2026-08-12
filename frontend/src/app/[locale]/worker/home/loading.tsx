import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { ListPageSkeleton } from '@/components/ui/page-skeletons';

/**
 * Route-level loading UI for the worker job feed. The `<main>` wrapper is
 * copied from the page so the skeleton occupies the same column and the
 * skeleton-to-content swap costs no layout shift.
 */
export default function Loading() {
    return (
        <AppShellSkeleton role="worker">
            <main className="mx-auto max-w-2xl px-4 py-6 md:px-6">
                <ListPageSkeleton withSearch />
            </main>
        </AppShellSkeleton>
    );
}
