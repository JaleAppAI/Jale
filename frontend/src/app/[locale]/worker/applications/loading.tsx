import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { ListPageSkeleton } from '@/components/ui/page-skeletons';

export default function Loading() {
    return (
        <AppShellSkeleton role="worker">
            <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                <ListPageSkeleton />
            </main>
        </AppShellSkeleton>
    );
}
