'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { DashboardPanel } from './dashboard-panel';
import { Skeleton, SkeletonCircle, SkeletonLine } from './skeleton';

/**
 * Archetype skeletons — one per page shape the app actually has.
 *
 * These are deliberately geometric copies of the real components rather than
 * generic grey boxes: the whole point is that the skeleton→content swap costs
 * no layout shift. Each archetype's geometry is traced from a specific source:
 *
 *  - ListPageSkeleton     <- WorkerJobCard rows inside a DashboardPanel
 *  - DetailPageSkeleton   <- the `Field` grid on worker/employer profile pages
 *  - DashboardSkeleton    <- MetricCard row + DashboardPanel sections
 *  - ThreadSkeleton       <- the employer conversations 3-pane board
 *  - CenteredCardSkeleton <- the narrow auth/legal single-card pages
 *
 * All of them are `role="status"` with an sr-only label, so a screen reader
 * hears "Loading..." once per region instead of nothing at all.
 */

/** Shared status wrapper: one live region per skeleton, labelled from `common.loading`. */
function SkeletonRegion({ children, className }: { children: ReactNode; className?: string }) {
    const t = useTranslations('common');
    return (
        <div role="status" className={className}>
            <span className="sr-only">{t('loading')}</span>
            {children}
        </div>
    );
}

/**
 * List archetype: a panel of avatar + two-line rows. Matches `WorkerJobCard`'s
 * 44px tile / title / meta rhythm closely enough that rows do not jump.
 */
export function ListPageSkeleton({
    rows = 5,
    withSearch = false,
}: {
    rows?: number;
    withSearch?: boolean;
}) {
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

/**
 * Detail archetype: panel header bar + a stacked label/value list + an action
 * row.
 *
 * Traces `KVList`, which is what every detail surface now renders: one row per
 * field, label left and value right on a shared baseline, separated by dashed
 * hairlines with none after the last. It deliberately does NOT trace the old
 * two-column `Field` grid — that layout is retired, and a skeleton shaped like
 * the previous design costs exactly the layout shift these archetypes exist to
 * prevent.
 */
export function DetailPageSkeleton({
    fields = 6,
    withBackLink = false,
}: {
    fields?: number;
    withBackLink?: boolean;
}) {
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
                                    i < fields - 1
                                        ? 'border-b border-dashed border-[var(--jale-divider)]'
                                        : '',
                                ]
                                    .filter(Boolean)
                                    .join(' ')}
                            >
                                {/* label (xs uppercase, left) and value (sm, right) */}
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

/**
 * A row of minimal KPI figures — the dashboard/applications metric band.
 *
 * Exported because a route `loading.tsx` cannot import from a `'use client'`
 * page module, so without it every surface with a metric band hand-traces the
 * same geometry twice (once in the page, once in its route skeleton). Three
 * copies of one tracing drift the first time `MetricCard`'s type scale moves.
 */
export function MetricRowSkeleton({ count = 4 }: { count?: number }) {
    return (
        <section
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
        >
            {Array.from({ length: count }).map((_, i) => (
                <div key={i} className="min-w-0 py-1">
                    <Skeleton className="h-8 w-16" />
                    <Skeleton className="mt-2 h-2.5 w-24" />
                </div>
            ))}
        </section>
    );
}

/** Dashboard archetype: a 4-up metric row over two content panels. */
export function DashboardSkeleton() {
    return (
        <SkeletonRegion>
            <div className="mb-5">
                <MetricRowSkeleton count={4} />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                {Array.from({ length: 2 }).map((_, panel) => (
                    <DashboardPanel key={panel}>
                        <div className="flex items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
                            <Skeleton className="h-4 w-36" />
                            <Skeleton className="h-3.5 w-16" />
                        </div>
                        <ul className="divide-y divide-[var(--jale-divider)]">
                            {Array.from({ length: 3 }).map((_, row) => (
                                <li key={row} className="flex items-center gap-3 px-5 py-3.5">
                                    <SkeletonCircle size={32} />
                                    <div className="min-w-0 flex-1 space-y-2">
                                        <SkeletonLine width="w-2/5" />
                                        <SkeletonLine width="w-1/4" tone="paper" />
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </DashboardPanel>
                ))}
            </div>
        </SkeletonRegion>
    );
}

/**
 * Thread archetype: the employer conversations board — thread list, message
 * transcript, status rail. Collapses to a single column below `xl`, exactly as
 * the real board does.
 */
export function ThreadSkeleton() {
    return (
        <SkeletonRegion>
            <section className="grid min-h-[680px] overflow-hidden rounded-lg border border-[var(--jale-divider)] bg-[var(--jale-card)] xl:grid-cols-[320px_minmax(0,1fr)_280px]">
                {/* Pane 1 — thread list */}
                <aside className="border-b border-[var(--jale-divider)] xl:border-b-0 xl:border-r">
                    <div className="border-b border-[var(--jale-divider)] px-4 py-3">
                        <Skeleton className="h-8 w-full rounded-md" />
                    </div>
                    <ul className="divide-y divide-[var(--jale-divider)]">
                        {Array.from({ length: 5 }).map((_, i) => (
                            <li key={i} className="flex items-start gap-3 px-4 py-3">
                                <SkeletonCircle size={36} />
                                <div className="min-w-0 flex-1 space-y-2">
                                    <SkeletonLine width="w-2/3" />
                                    <SkeletonLine width="w-1/2" tone="paper" />
                                </div>
                            </li>
                        ))}
                    </ul>
                </aside>

                {/* Pane 2 — transcript. Alternating sides read as a conversation. */}
                <div className="flex min-w-0 flex-col border-b border-[var(--jale-divider)] xl:border-b-0 xl:border-r">
                    <div className="border-b border-[var(--jale-divider)] px-4 py-3">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="mt-2 h-2.5 w-24" />
                    </div>
                    <div className="flex-1 space-y-3 p-4">
                        {Array.from({ length: 6 }).map((_, i) => {
                            const inbound = i % 2 === 0;
                            return (
                                <div key={i} className={inbound ? 'flex justify-start' : 'flex justify-end'}>
                                    <Skeleton
                                        tone={inbound ? 'paper' : 'divider'}
                                        className={`h-12 rounded-[var(--radius-input)] ${inbound ? 'w-3/5' : 'w-1/2'}`}
                                    />
                                </div>
                            );
                        })}
                    </div>
                    <div className="border-t border-[var(--jale-divider)] p-4">
                        <Skeleton className="h-11 w-full rounded-[var(--radius-input)]" />
                    </div>
                </div>

                {/* Pane 3 — status rail */}
                <aside className="p-4">
                    <Skeleton className="h-2.5 w-20" />
                    <div className="mt-4 space-y-4">
                        {Array.from({ length: 4 }).map((_, i) => (
                            <div key={i} className="space-y-2">
                                <Skeleton className="h-2.5 w-16" />
                                <SkeletonLine width="w-3/4" />
                            </div>
                        ))}
                    </div>
                </aside>
            </section>
        </SkeletonRegion>
    );
}

/**
 * Centered-card archetype: the narrow single-card pages (auth, legal accept,
 * token upload). `title` adds the heading block those pages render above the
 * body copy.
 *
 * `card={false}` drops the card wrapper and renders only its contents. That is
 * for the surfaces whose SHELL already draws the card -- `AuthShell` does, and
 * nesting a second one would put a card inside a card and cost exactly the
 * layout shift these skeletons exist to prevent.
 */
export function CenteredCardSkeleton({
    title = false,
    card = true,
}: {
    title?: boolean;
    card?: boolean;
}) {
    const body = (
        <>
            {title ? (
                <div className="mb-6 space-y-2">
                    <Skeleton className="h-5 w-2/3" />
                    <SkeletonLine width="w-1/2" tone="paper" />
                </div>
            ) : null}

            <div className="space-y-4">
                {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="space-y-2">
                        <Skeleton className="h-2.5 w-20" />
                        <Skeleton className="h-11 w-full rounded-[var(--radius-input)]" />
                    </div>
                ))}
            </div>

            <Skeleton className="mt-6 h-11 w-full rounded-full" />
        </>
    );

    return (
        <SkeletonRegion className="mx-auto w-full max-w-md">
            {card ? (
                <div className="rounded-[var(--radius-card)] bg-[var(--jale-card)] p-6 shadow-[var(--shadow-card)]">
                    {body}
                </div>
            ) : (
                body
            )}
        </SkeletonRegion>
    );
}
