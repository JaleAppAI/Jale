import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { DetailPageSkeleton } from '@/components/ui/page-skeletons';

export default function Loading() {
    return (
        <AppShellSkeleton role="worker">
            <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                {/* The page opens with a "back to jobs" link above the panel. */}
                <DetailPageSkeleton withBackLink />
            </main>
        </AppShellSkeleton>
    );
}
