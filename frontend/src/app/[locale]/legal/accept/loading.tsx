import { CenteredCardSkeleton } from '@/components/ui/page-skeletons';

/**
 * The legal wall keeps the global `Header`, so this only covers the page body.
 * The centering frame is copied from `LegalWall` (which subtracts the 3.5rem
 * header from the viewport height) so the card lands in the same place.
 */
export default function Loading() {
    return (
        <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-6">
            <CenteredCardSkeleton title />
        </main>
    );
}
