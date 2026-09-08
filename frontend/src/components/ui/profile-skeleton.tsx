'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { DashboardPanel } from './dashboard-panel';
import { Skeleton, SkeletonCircle } from './skeleton';
import { FactsCardSkeleton } from './page-skeletons';

/**
 * The loading picture for the three PROFILE-style detail pages: the worker's own
 * profile, the employer's own profile, and the employer's view of an applicant.
 *
 * All three used to render `DetailPageSkeleton`, which traces `KVList` -- a
 * single column of dashed label/value rows. Those pages now render a
 * `FactsCard` (label-over-value tiles two per row, chip facts, a paragraph), so
 * the old archetype is a picture of a layout that no longer exists, and the
 * skeleton -> content swap costs exactly the layout shift these archetypes
 * exist to prevent.
 *
 * It lives HERE rather than as one more export of `page-skeletons.tsx` because
 * that file is being appended to by the job-pages lane in parallel; a new file
 * is the one place two lanes cannot collide.
 *
 * WHY A COMPONENT AND NOT A COPY PER PAGE: each of these pages renders its
 * skeleton TWICE -- once in the page's own `showSkeleton` branch (the client
 * fetch) and once in the route's `loading.tsx` (the server render). A route
 * `loading.tsx` cannot import from a `'use client'` page module, so without a
 * shared component every page hand-traces the same geometry twice and the two
 * drift the first time a tile count changes.
 */

/*
 * `page-skeletons.tsx`' `SkeletonRegion` and `SkeletonPanelHead` are module-
 * private and that file must not be edited by this lane, so both are
 * re-implemented below. Behaviour is deliberately kept identical to the
 * originals -- if either is ever exported, delete the local copy and import it.
 */

/** One `role="status"` live region per skeleton, labelled from `common.loading`. */
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
 * The two panel heads these three pages actually have, as one enumerated
 * variant rather than an avatar size plus two booleans:
 *
 *  - `'edit-button'`  the two own-profile pages. `PanelHeader` with a 36px
 *                     `InitialsAvatar` in its leading slot and a `size="sm"`
 *                     (`h-9`) Edit button in its action slot.
 *  - `'status-badge'` the applicant card. A 44px avatar, and an
 *                     `ApplicationStatusBadge` on its own line under the
 *                     title instead of any action.
 *
 * The title sits in a 24px box in both because the real title is `text-base`
 * (a 24px line box) -- a bare `h-4` bar would leave the header 8px short.
 */
export type ProfileHeadShape = 'edit-button' | 'status-badge';

function SkeletonProfileHead({ shape }: { shape: ProfileHeadShape }) {
    const withBadge = shape === 'status-badge';

    return (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--jale-divider)] px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
                <SkeletonCircle size={withBadge ? 44 : 36} />
                <div className="min-w-0">
                    <div className="flex h-6 items-center">
                        <Skeleton className="h-4 w-40" />
                    </div>
                    {/* `text-[11px] leading-tight` badge on an `mt-1`, so a short
                        `h-3.5` bar and NOT a pill: `Badge` draws no chip border. */}
                    {withBadge ? (
                        <Skeleton tone="divider" className="mt-1 h-3.5 w-28" />
                    ) : null}
                </div>
            </div>
            {withBadge ? null : <Skeleton className="h-9 w-20 rounded-full" />}
        </div>
    );
}

export function ProfileSkeleton({
    tiles = 5,
    chips = 2,
    text = 3,
    head = 'edit-button',
    withBackLink = false,
}: {
    /** Label-over-value tiles. The three pages differ: 5, 7 and 6. */
    tiles?: number;
    /**
     * Chip-valued facts (skills, certifications, hiring trades). `0` for the
     * applicant card, which has none -- see the KNOWN DEVIATION note below for
     * what `0` can and cannot suppress.
     */
    chips?: number;
    /**
     * Lines of the free-text section (a bio, a company description). `0` for
     * the applicant card, which has none.
     */
    text?: number;
    /** Which of the two real panel heads to draw. */
    head?: ProfileHeadShape;
    /**
     * Reserve the applicant card's "Back to applicants" link above the panel.
     * `DetailPageSkeleton` carries the same prop for the same page.
     */
    withBackLink?: boolean;
}) {
    /*
     * KNOWN DEVIATION, recorded rather than worked around:
     * `FactsCardSkeleton` traces the JOB detail card, so it always draws a pay
     * `Headline` block (label + figure + hint, ~75px) that no profile page has,
     * and at a count of `0` it still draws the chip section's rule and label bar
     * and the text section's rule. None of that can be suppressed from here --
     * the fix is an optional-section prop on `FactsCardSkeleton` itself, which
     * lives in the file this lane must not touch.
     *
     * Re-tracing the tile and chip geometry locally instead would remove the
     * overshoot at the cost of a second copy of a grid its own docstring warns
     * against duplicating, and it would drift the first time `Tile` moves. One
     * shared tracing with a known constant offset is the better trade.
     */
    return (
        <SkeletonRegion>
            {withBackLink ? <Skeleton className="mb-4 h-3.5 w-24" /> : null}

            <DashboardPanel>
                <SkeletonProfileHead shape={head} />
                <FactsCardSkeleton tiles={tiles} requirements={chips} text={text} />
            </DashboardPanel>
        </SkeletonRegion>
    );
}
