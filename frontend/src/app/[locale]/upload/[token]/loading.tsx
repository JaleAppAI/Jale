import { CenteredCardSkeleton } from '@/components/ui/page-skeletons';

/**
 * Frame copied from the upload page (`FRAME` / `COLUMN` there) so the card does
 * not move on swap. The height subtracts the 3.5rem global `Header`, which this
 * route keeps — `min-h-screen` would leave the page permanently 3.5rem taller
 * than the viewport.
 *
 * The page draws its heading INSIDE the card, which is why this uses `title`
 * with the default `card` wrapper rather than `card={false}`.
 */
export default function Loading() {
    return (
        <main className="min-h-[calc(100vh-3.5rem)] bg-[var(--jale-paper)] px-4 py-8">
            <div className="mx-auto w-full max-w-md">
                <CenteredCardSkeleton title />
            </div>
        </main>
    );
}
