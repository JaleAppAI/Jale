import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { DetailPageSkeleton } from '@/components/ui/page-skeletons';

export default function Loading() {
    return (
        <AppShellSkeleton role="employer">
            <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                <DetailPageSkeleton />
            </div>
        </AppShellSkeleton>
    );
}
