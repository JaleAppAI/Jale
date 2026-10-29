import { CenteredCardSkeleton } from '@/components/ui/page-skeletons';

/**
 * The access screen keeps the global `Header` and no app shell, like the legal
 * wall, so this is the same centred card. It is also the route's Suspense
 * boundary for the page's `useSearchParams`.
 */
export default function Loading() {
    return (
        <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-6 py-10">
            <CenteredCardSkeleton title />
        </main>
    );
}
