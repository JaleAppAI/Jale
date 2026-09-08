import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { JobDetailSkeleton } from '@/components/ui/page-skeletons';

export default function Loading() {
    return (
        <AppShellSkeleton role="worker">
            <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                {/* The page opens with a "back to jobs" link above the panel.
                    Identical to the page's own `showSkeleton` branch, so the
                    handover from this route skeleton to the client one costs no
                    visible swap. */}
                <JobDetailSkeleton withBackLink />
            </main>
        </AppShellSkeleton>
    );
}
