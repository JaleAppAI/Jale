import { CenteredCardSkeleton } from '@/components/ui/page-skeletons';

/** Frame copied from the upload page so the card does not move on swap. */
export default function Loading() {
    return (
        <div className="min-h-screen bg-[var(--jale-paper)] px-4 py-8">
            <div className="mx-auto max-w-md">
                <CenteredCardSkeleton title />
            </div>
        </div>
    );
}
