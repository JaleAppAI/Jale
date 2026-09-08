import type { ReactNode } from 'react';
import { FactsCard, type RequirementState } from '@/components/ui/facts-card';

/**
 * The job's facts, as ONE card body — shared verbatim by all three job pages
 * (`worker/jobs/[id]`, `employer/jobs/[id]`, the public `j/[code]`).
 *
 * WHY IT EXISTS: `FactsCard` (`ui/facts-card.tsx`) is a compound primitive — it
 * will compose any order of sections you hand it, which is exactly what let the
 * three job pages drift into three different fact lists before this lane. This
 * component removes that freedom for jobs specifically: the section order below
 * is the locked one, written once, so a posting reads identically to the worker
 * who is deciding, the employer who wrote it and a stranger who was sent the
 * link.
 *
 * LOCKED SECTION ORDER (owner decision, 2026-09-08):
 *   1. pay headline (+ the page's own pay-reference hint)
 *   2. "Schedule and dates"  -> shift, duration, start, openings
 *   3. "Where and what's needed" -> location, trade, experience, language
 *   4. "Requirements" -> chips, each carrying its state as words
 *   5. "Documents" -> worker page only; the vault rows, passed in as children
 *   6. "About the job · posted {date}" -> the description
 *
 * NOTE the deliberate divergence from `facts-card.tsx`'s own doc comment, which
 * declares the canonical field order as `pay, schedule, start, duration,
 * location, openings, experience, language, requirements, description`. The
 * owner's locked order groups the four time facts together and the four
 * place/person facts together instead, and adds `trade`, which that list never
 * had. THIS file is the source of truth for the three job pages; that comment
 * describes the primitive's original intent and could not be updated in this
 * lane (`ui/*` is owned elsewhere).
 *
 * WHAT IT DOES NOT DO — the same three refusals `FactsCard` makes, one level up:
 *  - no formatting. Every value arrives as a finished string or node. Pay goes
 *    through each page's existing `lib/pay.ts` call, dates through `lib/date.ts`,
 *    schedule/duration/trade through `lib/job-detail-display.ts`. Nothing here
 *    knows a currency, a timezone or a plural rule.
 *  - no copy. Every label, and every requirement's state word, arrives already
 *    translated from the calling page's own next-intl namespace.
 *  - no hooks, and deliberately NO `'use client'`. The public job page is a
 *    server component; a directive here would open a client boundary on the one
 *    page in the app that is rendered for search engines. The two signed-in
 *    pages are already `'use client'`, so they pull this into their bundle
 *    either way.
 */

/** One label-over-value tile. `value` is a node so a page can keep `tabular-nums`. */
export type JobFactTile = {
    /** Stable per fact (`'start'`, `'openings'`), never an array index: the
     *  tiles a job carries change with its data, so a positional key would
     *  re-associate `Duración`'s DOM node with `Inicio`'s value. */
    key: string;
    label: string;
    value: ReactNode;
    /**
     * Drops the value to ink-2 for a placeholder ("To be confirmed"). Colour
     * ONLY — the caller's own words are what say the value is unset.
     */
    muted?: boolean;
};

/** One requirement chip. `stateLabel` is required, not defaulted — see `FactsCard.Requirement`. */
export type JobFactRequirement = {
    key: string;
    label: string;
    state: RequirementState;
    /** The localized state word ("Required" / "Requerido"), read out after the label. */
    stateLabel: string;
};

export type JobFactSection = {
    label: string;
    tiles: readonly JobFactTile[];
};

export type JobFactsCardProps = {
    /** `null` for a job with no stated rate — the headline is omitted, not blanked. */
    pay: { label: string; figure: string; hint?: ReactNode } | null;
    schedule: JobFactSection;
    where: JobFactSection;
    /** `null` when the job asks for nothing — an empty chip row is worse than none. */
    requirements: { label: string; items: readonly JobFactRequirement[] } | null;
    /**
     * The worker page's vault document rows, passed as finished markup: their
     * Uploaded/Missing badges depend on the worker's own vault, which neither
     * the employer nor a public visitor has. `null` on those two pages, where
     * the job's documents are Requirements chips instead.
     */
    documents: { label: string; children: ReactNode } | null;
    /** `null` when the employer wrote no description. */
    about: { label: string; text: string } | null;
};

/** A tile grid, or nothing at all — never a labelled section wrapping an empty `dl`. */
function TileSection({ section }: { section: JobFactSection }) {
    return (
        <FactsCard.Section label={section.label}>
            <FactsCard.Tiles>
                {section.tiles.map((tile) => (
                    <FactsCard.Tile key={tile.key} label={tile.label} muted={tile.muted}>
                        {tile.value}
                    </FactsCard.Tile>
                ))}
            </FactsCard.Tiles>
        </FactsCard.Section>
    );
}

export function JobFactsCard({
    pay,
    schedule,
    where,
    requirements,
    documents,
    about,
}: JobFactsCardProps) {
    // Each section is `cond ? <X/> : null` rather than `cond && <X/>`: `&&` on a
    // number or an empty string renders it, and `FactsCard` counts its children
    // to draw the dividers, so a falsy leak would claim a rule of its own.
    return (
        <FactsCard>
            {pay ? (
                <FactsCard.Headline label={pay.label} hint={pay.hint}>
                    {pay.figure}
                </FactsCard.Headline>
            ) : null}

            {schedule.tiles.length > 0 ? <TileSection section={schedule} /> : null}
            {where.tiles.length > 0 ? <TileSection section={where} /> : null}

            {requirements && requirements.items.length > 0 ? (
                <FactsCard.Requirements label={requirements.label}>
                    {requirements.items.map((item) => (
                        <FactsCard.Requirement
                            key={item.key}
                            state={item.state}
                            stateLabel={item.stateLabel}
                        >
                            {item.label}
                        </FactsCard.Requirement>
                    ))}
                </FactsCard.Requirements>
            ) : null}

            {documents ? (
                <FactsCard.Section label={documents.label}>{documents.children}</FactsCard.Section>
            ) : null}

            {about ? (
                <FactsCard.Section label={about.label}>
                    <FactsCard.Text>{about.text}</FactsCard.Text>
                </FactsCard.Section>
            ) : null}
        </FactsCard>
    );
}
