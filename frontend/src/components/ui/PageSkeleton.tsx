import { DashboardPanel } from './dashboard-panel';
import { Skeleton, SkeletonLine } from './skeleton';

/**
 * Loading placeholder for the profile-style pages (a `DashboardPanel` with a
 * header bar and a 2-column grid of label/value lines). Used in place of a
 * text "Loading..." string so nothing that reads as an error or empty state
 * flashes during the brief post-signup window where the backend is still
 * provisioning the user's row (see the retry loop in `src/lib/api.ts`) or
 * while a legal-wall redirect is in flight.
 *
 * Rendered output is unchanged from the original hand-rolled version; only the
 * internals now come from the shared skeleton atoms.
 */
export function PageSkeleton({ label }: { label: string }) {
    return (
        <div role="status">
            <span className="sr-only">{label}</span>
            <DashboardPanel>
                <div className="flex items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-8 w-20 rounded-full" />
                </div>
                <div className="p-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <SkeletonField key={i} />
                        ))}
                    </div>
                </div>
            </DashboardPanel>
        </div>
    );
}

function SkeletonField() {
    return (
        <div>
            <Skeleton className="mb-2 h-2.5 w-20" />
            <SkeletonLine width="w-3/4" />
        </div>
    );
}
