import type { CSSProperties, ReactNode } from 'react';
import { DashboardPanel } from './dashboard-panel';
import { Skeleton, SkeletonCircle, SkeletonLine } from './skeleton';

/**
 * Page skeletons (copied from the Jale app: the list, detail and metric-row
 * archetypes). Geometric copies of the real components, so the swap to
 * content costs no layout shift. Each region is `role="status"` with an
 * sr-only label, so a screen reader hears "Loading" once per region.
 */

function SkeletonRegion({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div role="status" className={className}>
            <span className="sr-only">Loading</span>
            {children}
        </div>
    );
}

/** List archetype: a panel of avatar + two-line rows. */
export function ListPageSkeleton({ rows = 5, withSearch = false }: { rows?: number; withSearch?: boolean }) {
    return (
        <SkeletonRegion>
            {withSearch ? (
                <div className="mb-4 flex gap-2">
                    <Skeleton className="h-11 flex-1 rounded-[var(--radius-input)]" />
                    <Skeleton className="h-11 w-24 rounded-full" />
                </div>
            ) : null}

            <DashboardPanel>
                <ul className="divide-y divide-[var(--jale-divider)]">
                    {Array.from({ length: rows }).map((_, i) => (
                        <li key={i} className="flex items-start gap-3 p-4">
                            <SkeletonCircle size={36} />
                            <div className="min-w-0 flex-1 space-y-2">
                                <SkeletonLine width="w-1/2" />
                                <SkeletonLine width="w-1/3" tone="paper" />
                            </div>
                            <Skeleton className="h-6 w-16 rounded-full" />
                        </li>
                    ))}
                </ul>
            </DashboardPanel>
        </SkeletonRegion>
    );
}

/** Detail archetype: a header bar, a KVList-shaped list and an action row. */
export function DetailPageSkeleton({ fields = 6, withBackLink = false }: { fields?: number; withBackLink?: boolean }) {
    return (
        <SkeletonRegion>
            {withBackLink ? <Skeleton className="mb-4 h-3.5 w-24" /> : null}

            <DashboardPanel>
                <div className="flex items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-8 w-20 rounded-full" />
                </div>

                <div className="p-6">
                    <dl className="w-full">
                        {Array.from({ length: fields }).map((_, i) => (
                            <div
                                key={i}
                                className={[
                                    'flex items-baseline justify-between gap-4 py-2.5',
                                    i < fields - 1 ? 'border-b border-dashed border-[var(--jale-divider)]' : '',
                                ]
                                    .filter(Boolean)
                                    .join(' ')}
                            >
                                <Skeleton className="h-2.5 w-24" />
                                <SkeletonLine width="w-32" />
                            </div>
                        ))}
                    </dl>

                    <div className="mt-6 flex flex-wrap gap-2 border-t border-[var(--jale-divider)] pt-4">
                        <Skeleton className="h-11 w-32 rounded-full" />
                        <Skeleton className="h-11 w-24 rounded-full" />
                    </div>
                </div>
            </DashboardPanel>
        </SkeletonRegion>
    );
}

/** A row of KPI figures: two-up on phones, `count`-up from `md`. */
export function MetricRowSkeleton({
    count = 4,
    hint = false,
    gap = 'gap-3',
}: {
    count?: number;
    /** Reserve the hint line under every label. */
    hint?: boolean;
    gap?: 'gap-3' | 'gap-4';
}) {
    return (
        <section
            className={`grid grid-cols-2 ${gap} md:[grid-template-columns:repeat(var(--metric-cols),minmax(0,1fr))]`}
            style={{ '--metric-cols': count } as CSSProperties}
        >
            {Array.from({ length: count }).map((_, i) => (
                <div key={i} className="min-w-0 py-1">
                    <Skeleton className="h-8 w-16" />
                    <Skeleton className="mt-2 h-2.5 w-24" />
                    {hint ? (
                        <div className="mt-1 flex h-4 items-center">
                            <Skeleton tone="paper" className="h-3 w-32" />
                        </div>
                    ) : null}
                </div>
            ))}
        </section>
    );
}
