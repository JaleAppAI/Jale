import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { ListPageSkeleton } from '@/components/ui/page-skeletons';

export default function Loading() {
    return (
        <AppShellSkeleton role="employer">
            <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
                {/* The same archetype the page paints while membership and the team load. */}
                <ListPageSkeleton rows={3} />
            </div>
        </AppShellSkeleton>
    );
}
