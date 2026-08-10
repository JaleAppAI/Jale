import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { ThreadSkeleton } from '@/components/ui/page-skeletons';

export default function Loading() {
    return (
        <AppShellSkeleton role="employer">
            <div className="mx-auto max-w-7xl px-4 py-6">
                <ThreadSkeleton />
            </div>
        </AppShellSkeleton>
    );
}
