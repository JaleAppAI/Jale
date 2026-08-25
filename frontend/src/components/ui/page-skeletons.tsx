'use client';

import type { CSSProperties, ReactNode } from 'react';
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
 *  - ListPageSkeleton      <- WorkerJobCard rows inside a DashboardPanel
 *  - DetailPageSkeleton    <- the `Field` grid on worker/employer profile pages
 *  - DashboardSkeleton     <- the employer dashboard, in source order: the navy
 *                            hero <section>, the 4-up KPI band, then the
 *                            `1.7fr/.8fr` board — jobs panel + quick-post on the
 *                            left, four status panels on the right
 *  - ThreadSkeleton        <- the employer conversations 3-pane board
 *  - CenteredCardSkeleton  <- the narrow auth/legal single-card pages
 *  - TemplateTableSkeleton <- the employer templates table rows
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
    // Two-up on phones, `count`-up from `md` — the same responsive shape the
    // metric bands themselves use. A fixed N-column grid drew four cramped
    // columns on a 390px screen while the real band showed two, so the band
    // changed height once on every mobile load.
    return (
        <section
            className="grid grid-cols-2 gap-3 md:[grid-template-columns:repeat(var(--metric-cols),minmax(0,1fr))]"
            style={{ '--metric-cols': count } as CSSProperties}
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

/**
 * Dashboard archetype: a 1:1 tracing of the employer dashboard's ready state.
 *
 * The old version opened with the KPI band, but the real page opens with a navy
 * hero roughly 400px tall at 390px and 307px at 1440px. Every block below it
 * therefore landed that much lower once the data arrived — the single largest
 * layout shift in the app, and the reason this rewrite exists. Both the route's
 * `loading.tsx` and the page's own in-flight branch render this component, so
 * the hero has to live here rather than in either call site.
 *
 * Where a real block's height is set by TEXT rather than by a box, the tracing
 * reserves line BOXES (`flex h-[line-height] items-center` around a shorter
 * bar) instead of guessing with a bar height: the box owns the layout and the
 * bar only has to look like a word. Line counts come from the real `en`
 * strings measured against the real available widths, which is why several
 * blocks carry `md:hidden` rows — the copy wraps to more lines on a phone.
 */
export function DashboardSkeleton() {
    return (
        <SkeletonRegion>
            {/* Hero. `rail` tone throughout: this is the one navy surface in the
                app and both paper tones are invisible on it. */}
            <section className="mb-5 overflow-hidden rounded-[var(--radius-card)] bg-[var(--jale-blue-900)] p-5 shadow-[var(--shadow-card)] md:p-7">
                {/* Eyebrow pill: `py-1` over an 11px line box. `text-[11px]` sets
                    only the font size, so the line height is the inherited 1.5
                    -> 16.5 + 8 = 24.5px, not the 20px an `h-5` would reserve. */}
                <Skeleton tone="rail" className="mb-3 h-[24.5px] w-24 rounded-full" />

                {/* h2 `text-3xl md:text-4xl leading-tight` -> 37.5px and 45px
                    line boxes. The title wraps to 4 lines inside the 318px hero
                    at 390px and to 2 inside its own `max-w-3xl` from `md` up. */}
                <div className="max-w-3xl">
                    <div className="flex h-[37.5px] items-center md:h-[45px]">
                        <Skeleton tone="rail" className="h-5 w-[92%] md:h-6 md:w-full" />
                    </div>
                    <div className="flex h-[37.5px] items-center md:h-[45px]">
                        <Skeleton tone="rail" className="h-5 w-[78%] md:h-6 md:w-[52%]" />
                    </div>
                    <div className="flex h-[37.5px] items-center md:hidden">
                        <Skeleton tone="rail" className="h-5 w-[95%]" />
                    </div>
                    <div className="flex h-[37.5px] items-center md:hidden">
                        <Skeleton tone="rail" className="h-5 w-[45%]" />
                    </div>
                </div>

                {/* Body `mt-3 text-sm leading-6` -> 24px line boxes; 4 lines at
                    390px, 2 inside its `max-w-2xl` from `md` up. */}
                <div className="mt-3 max-w-2xl">
                    <div className="flex h-6 items-center">
                        <Skeleton tone="rail" className="h-3.5 w-full" />
                    </div>
                    <div className="flex h-6 items-center">
                        <Skeleton tone="rail" className="h-3.5 w-[93%] md:w-[52%]" />
                    </div>
                    <div className="flex h-6 items-center md:hidden">
                        <Skeleton tone="rail" className="h-3.5 w-[88%]" />
                    </div>
                    <div className="flex h-6 items-center md:hidden">
                        <Skeleton tone="rail" className="h-3.5 w-[62%]" />
                    </div>
                </div>

                {/* Two `h-11` CTAs. They fit one row in `en` at 390px with ~5px
                    to spare; `flex-wrap` matches the real row so a longer
                    locale wraps here exactly as it does there. */}
                <div className="mt-5 flex flex-wrap items-center gap-2">
                    <Skeleton tone="rail" className="h-11 w-32 rounded-full" />
                    <Skeleton tone="rail" className="h-11 w-40 rounded-full" />
                </div>
            </section>

            <div className="mb-5">
                <MetricRowSkeleton count={4} />
            </div>

            {/* `min-w-0` on both columns for the same reason the real board
                carries it: without it the panels' min-content width becomes the
                column floor and the grid overflows a 390px screen. */}
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(340px,.8fr)]">
                <div className="min-w-0 space-y-5">
                    <DashboardPanel className="overflow-hidden">
                        <SkeletonPanelHead action="button" />

                        <div className="border-b border-[var(--jale-divider)] p-4 md:p-5">
                            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                                <Skeleton className="h-11 w-full rounded-[var(--radius-input)]" />
                                {/* Five status chips at their real 30px
                                    (`border` + `py-1.5` + a 16px line box) and
                                    roughly their real label widths, so they
                                    wrap to two rows at 390px and sit on one
                                    beside the input from `md` up — same as the
                                    real group. */}
                                <div className="flex flex-wrap gap-2">
                                    {['w-12', 'w-[70px]', 'w-[70px]', 'w-14', 'w-16'].map((w, i) => (
                                        <Skeleton key={i} className={`h-[30px] rounded-full ${w}`} />
                                    ))}
                                </div>
                            </div>

                            {/* Exactly two children, matching the real row: the
                                showing-count and the ghost Refresh button. */}
                            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                                <div className="flex h-4 items-center">
                                    <Skeleton className="h-3.5 w-28" />
                                </div>
                                <Skeleton className="h-9 w-20 rounded-full" />
                            </div>
                        </div>

                        <ul className="divide-y divide-[var(--jale-divider)]">
                            {Array.from({ length: 3 }).map((_, row) => (
                                <SkeletonJobRow key={row} />
                            ))}
                        </ul>
                    </DashboardPanel>

                    <DashboardPanel>
                        <SkeletonPanelHead />
                        {/* Quick post. The CTA sits BESIDE the copy from `md`
                            up, so the block is ~68px there and ~148px stacked
                            on a phone; a stacked-only tracing would be 60px out
                            on every desktop load. */}
                        <div className="grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                            <div className="min-w-0">
                                {/* body `text-sm` -> 20px boxes, 2 lines at 390px */}
                                <div className="flex h-5 items-center">
                                    <Skeleton className="h-3.5 w-full md:w-3/4" />
                                </div>
                                <div className="flex h-5 items-center md:hidden">
                                    <Skeleton className="h-3.5 w-2/5" />
                                </div>
                                {/* hint `mt-2 text-xs leading-5` -> 20px boxes */}
                                <div className="mt-2 flex h-5 items-center">
                                    <Skeleton tone="paper" className="h-3 w-full" />
                                </div>
                                <div className="flex h-5 items-center">
                                    <Skeleton tone="paper" className="h-3 w-3/5" />
                                </div>
                            </div>
                            <Skeleton className="h-11 w-32 rounded-full" />
                        </div>
                    </DashboardPanel>
                </div>

                <div className="min-w-0 space-y-5">
                    {/* WhatsApp thread */}
                    <DashboardPanel>
                        <SkeletonPanelHead action="link" />
                        <div className="p-5">
                            <div className="flex h-5 items-center">
                                <Skeleton className="h-3.5 w-3/5" />
                            </div>
                            {/* body `mt-2 text-xs leading-5`, 3 lines at the
                                ~309px this column gives it */}
                            <div className="mt-2">
                                {['w-full', 'w-full', 'w-2/3'].map((w, i) => (
                                    <div key={i} className="flex h-5 items-center">
                                        <Skeleton tone="paper" className={`h-3 ${w}`} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    </DashboardPanel>

                    {/* Job progress */}
                    <DashboardPanel>
                        <SkeletonPanelHead />
                        <div className="p-5">
                            <div className="flex min-w-0 items-end justify-between gap-4">
                                <div className="min-w-0">
                                    <div className="flex h-[16.5px] items-center">
                                        <Skeleton className="h-2.5 w-24" />
                                    </div>
                                    {/* `text-3xl leading-none` -> a flat 30px */}
                                    <Skeleton className="mt-2 h-[30px] w-20" />
                                </div>
                                <Skeleton className="h-6 w-20 shrink-0 rounded-full" />
                            </div>
                            <div className="mt-4">
                                <Skeleton className="h-2 w-full rounded-full" />
                            </div>
                        </div>
                    </DashboardPanel>

                    {/* Time to fill — a real MetricCard, hint included */}
                    <DashboardPanel>
                        <SkeletonPanelHead />
                        <div className="p-5">
                            <div className="min-w-0 py-1">
                                <Skeleton className="h-[30px] w-16" />
                                <div className="mt-2 flex h-[16.5px] items-center">
                                    <Skeleton className="h-2.5 w-24" />
                                </div>
                                <div className="mt-1">
                                    {['w-full', 'w-1/2'].map((w, i) => (
                                        <div key={i} className="flex h-4 items-center">
                                            <Skeleton tone="paper" className={`h-3 ${w}`} />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </DashboardPanel>

                    {/* Hiring status — four ProgressRows */}
                    <DashboardPanel>
                        <SkeletonPanelHead />
                        <div className="space-y-4 p-5">
                            {Array.from({ length: 4 }).map((_, i) => (
                                <div key={i}>
                                    <div className="mb-2 flex h-4 items-center justify-between gap-3">
                                        <Skeleton className="h-3 w-16" />
                                        <Skeleton className="h-3 w-6" />
                                    </div>
                                    <Skeleton className="h-2 w-full rounded-full" />
                                </div>
                            ))}
                        </div>
                    </DashboardPanel>
                </div>
            </div>
        </SkeletonRegion>
    );
}

/**
 * `PanelHeader`'s row, to the pixel. The title is wrapped in a 24px box because
 * the real title is `text-base` (a 24px line box) — a bare `h-4` bar would make
 * every actionless panel header 8px short, and there are four of them stacked
 * in the dashboard's right column.
 */
function SkeletonPanelHead({ action }: { action?: 'button' | 'link' }) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
            <div className="flex h-6 items-center">
                <Skeleton className="h-4 w-36" />
            </div>
            {action === 'button' ? <Skeleton className="h-9 w-24 rounded-full" /> : null}
            {action === 'link' ? (
                <div className="flex h-4 items-center">
                    <Skeleton className="h-3 w-24" />
                </div>
            ) : null}
        </div>
    );
}

/**
 * One `JobPostingCard` row. The `@container` lives on the `<li>` and the grid on
 * the child, exactly as in the real card, so the row switches to its four-column
 * form on the panel's OWN width (~741px at a 1440px viewport) rather than the
 * viewport's — which is the whole reason that card uses a container query.
 */
function SkeletonJobRow() {
    return (
        <li className="@container">
            <div className="grid grid-cols-1 items-start gap-2 px-4 py-4 md:px-5 @[600px]:grid-cols-[minmax(0,1fr)_auto_auto_auto] @[600px]:items-center @[600px]:gap-4">
                <div className="min-w-0">
                    {/* title `text-sm leading-snug` -> 19.25px */}
                    <div className="flex h-[19.25px] items-center">
                        <Skeleton className="h-3.5 w-2/5" />
                    </div>
                    <div className="mt-0.5 flex h-4 items-center">
                        <Skeleton tone="paper" className="h-3 w-1/4" />
                    </div>
                </div>

                <div className="flex h-4 items-center">
                    <Skeleton className="h-3 w-24" />
                </div>

                {/* Badge: a 7px dot beside an 11px `leading-tight` label */}
                <div className="flex h-[13.75px] items-center gap-1.5">
                    <SkeletonCircle size={7} />
                    <Skeleton className="h-3 w-12" />
                </div>

                <div className="flex items-center gap-1.5">
                    <Skeleton className="h-9 w-20 rounded-full" />
                    <Skeleton className="h-9 w-9 rounded-full" />
                </div>
            </div>
        </li>
    );
}

/**
 * Template-table archetype: the employer templates manager. A panel with a
 * header bar, the `md`-only column-header row, and name/details/date/actions
 * rows on the same `[1.4fr_2fr_1fr_auto]` grid the real table renders —
 * stacking on phones exactly as the real rows do. Action pills trace
 * `Button size="sm"` (h-9).
 */
export function TemplateTableSkeleton({ rows = 4 }: { rows?: number }) {
    return (
        <SkeletonRegion>
            <DashboardPanel>
                <div className="border-b border-[var(--jale-divider)] px-5 py-4">
                    <Skeleton className="h-4 w-40" />
                </div>
                <div className="hidden grid-cols-[1.4fr_2fr_1fr_auto] gap-3 border-b border-[var(--jale-divider)] px-5 py-3 md:grid">
                    <Skeleton className="h-2.5 w-16" />
                    <Skeleton className="h-2.5 w-20" />
                    <Skeleton className="h-2.5 w-16" />
                    <span />
                </div>
                <div className="divide-y divide-[var(--jale-divider)]">
                    {Array.from({ length: rows }).map((_, i) => (
                        <div
                            key={i}
                            className="grid gap-2 px-5 py-4 md:grid-cols-[1.4fr_2fr_1fr_auto] md:items-center md:gap-3"
                        >
                            <SkeletonLine width="w-1/2" />
                            <SkeletonLine width="w-3/4" tone="paper" />
                            <SkeletonLine width="w-1/2" tone="paper" />
                            <div className="flex gap-2">
                                <Skeleton className="h-9 w-16 rounded-full" />
                                <Skeleton className="h-9 w-20 rounded-full" />
                            </div>
                        </div>
                    ))}
                </div>
            </DashboardPanel>
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
