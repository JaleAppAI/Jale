import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { DashboardSkeleton } from '@/components/ui/page-skeletons';

export default function Loading() {
    return (
        <AppShellSkeleton role="employer">
            <div className="mx-auto max-w-[1380px] px-4 py-6 pb-24 md:px-6">
                <DashboardSkeleton />
            </div>
        </AppShellSkeleton>
    );
}
