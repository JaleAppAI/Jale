import { DetailPageSkeleton } from '@/components/ui/page-skeletons';

/**
 * The public job page is standalone -- no AppShell, no global header. It opens
 * with a navy brand band that the card overlaps by `-mt-10`, so the loading
 * state reproduces that band (real wordmark, it needs no data) and drops the
 * detail skeleton into the same overlapping column.
 */
export default function Loading() {
    return (
        <div className="min-h-screen bg-[var(--jale-paper)]">
            <header className="bg-[var(--jale-blue-900)] px-4 pb-16 pt-7">
                <div className="mx-auto max-w-md md:max-w-2xl">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/brand/wordmark-white.png" alt="Jale" className="h-7 w-auto" />
                </div>
            </header>

            <main className="-mt-10 px-4 pb-10">
                <div className="mx-auto max-w-md md:max-w-2xl">
                    <DetailPageSkeleton />
                </div>
            </main>
        </div>
    );
}
