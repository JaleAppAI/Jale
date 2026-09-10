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
 * LOCKED SECTION ORDER (owner decision 2026-09-08, revised in fix round 1):
 *   1. pay headline (+ the page's own pay-reference hint)
 *   2. "Schedule and dates"  -> shift, duration, start, openings
 *   3. "Where and what's needed" -> location, trade, experience, language,
 *      then the requirement chip ROWS (see `chips` below)
 *   4. "Documents" -> worker page only; the vault rows, passed in as children
 *   5. "About the job" -> the description
 * `facts-card.tsx`'s own doc comment states the same order and names this file
 * as what realises it; the two are meant to be read together.
 *
 * The posted date is NOT in here. It is a `PanelHeader` badge on all three
 * pages, because when it was part of the About label a job with no description
 * lost the date with it -- and how stale a posting is decides whether a worker
 * walks to it (owner ruling, fix round 1).
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

/**
 * One labelled row of chips.
 *
 * There are up to three, and they are labelled rather than pooled into one flat
 * strip because the three kinds are not interchangeable (owner ruling, fix
 * round 1): a policy the job sets ("Transportation"), a credential the worker
 * must hold ("OSHA 10") and a file the worker must upload ("Resume") each cost
 * something different to satisfy, and an employer proofreading their own posting
 * has to be able to tell which is which.
 *
 * A legacy `certifications: string[]` job — the pre-tier shape, still in the
 * table — is chipped as `required`, a tier those rows do not actually carry. It
 * is the honest reading of a bare "we need this" list and it is what the two
 * pages that show those rows displayed before this lane.
 */
export type JobFactChipGroup = {
    key: string;
    label: string;
    items: readonly JobFactRequirement[];
};

export type JobFactSection = {
    label: string;
    tiles: readonly JobFactTile[];
    /**
     * Chip rows rendered INSIDE this section, under its tiles. Only the "where
     * and what's needed" section uses them; an empty row is dropped, and a
     * section with no tiles and no chips is dropped whole.
     */
    chips?: readonly JobFactChipGroup[];
};

export type JobFactsCardProps = {
    /** `null` for a job with no stated rate — the headline is omitted, not blanked. */
    pay: { label: string; figure: string; hint?: ReactNode } | null;
    schedule: JobFactSection;
    /** Carries the requirement chip rows in its `chips`, under its tiles. */
    where: JobFactSection;
    /**
     * The worker page's vault document rows, passed as finished markup: their
     * Uploaded/Missing badges depend on the worker's own vault, which neither
     * the employer nor a public visitor has. `null` on those two pages, where
     * the job's documents are Requirements chips instead.
     */
    documents: { label: string; children: ReactNode } | null;
    /**
     * `null` to omit the section entirely — the two pages a stranger or a
     * candidate reads do that, because "no description" is not information they
     * can act on. The employer's own page passes `muted: true` copy instead: on
     * the page where you can fix it, the gap is the prompt.
     */
    about: { label: string; text: string; muted?: boolean } | null;
};

/** A tile grid plus its chip rows, or nothing — never a labelled section wrapping nothing. */
function TileSection({ section }: { section: JobFactSection }) {
    const chipGroups = (section.chips ?? []).filter((group) => group.items.length > 0);

    return (
        <FactsCard.Section label={section.label}>
            {section.tiles.length > 0 ? (
                <FactsCard.Tiles>
                    {section.tiles.map((tile) => (
                        <FactsCard.Tile key={tile.key} label={tile.label} muted={tile.muted}>
                            {tile.value}
                        </FactsCard.Tile>
                    ))}
                </FactsCard.Tiles>
            ) : null}

            {chipGroups.map((group) => (
                // `mt-4` rather than a `space-y` on a wrapper: the rows are a
                // flat list of siblings after the `dl`, and the first one needs
                // the same gap from the tiles as it does from the row above it.
                <div key={group.key} className="mt-4">
                    <FactsCard.Requirements label={group.label}>
                        {group.items.map((item) => (
                            <FactsCard.Requirement
                                key={item.key}
                                state={item.state}
                                stateLabel={item.stateLabel}
                            >
                                {item.label}
                            </FactsCard.Requirement>
                        ))}
                    </FactsCard.Requirements>
                </div>
            ))}
        </FactsCard.Section>
    );
}

/** Does this section have anything at all to draw? */
function hasContent(section: JobFactSection): boolean {
    return (
        section.tiles.length > 0 ||
        (section.chips ?? []).some((group) => group.items.length > 0)
    );
}

export function JobFactsCard({ pay, schedule, where, documents, about }: JobFactsCardProps) {
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

            {hasContent(schedule) ? <TileSection section={schedule} /> : null}
            {hasContent(where) ? <TileSection section={where} /> : null}

            {documents ? (
                <FactsCard.Section label={documents.label}>{documents.children}</FactsCard.Section>
            ) : null}

            {about ? (
                <FactsCard.Section label={about.label}>
                    <FactsCard.Text muted={about.muted}>{about.text}</FactsCard.Text>
                </FactsCard.Section>
            ) : null}
        </FactsCard>
    );
}
