import { Children, type ReactNode } from 'react';

/**
 * The ONE detail-card body.
 *
 * It replaces `KVList` on the six detail surfaces (the three job detail pages —
 * worker, employer, public — and the profile detail pages): instead of a long
 * dashed label/value list where "Pay" reads exactly as loud as "Shift", the
 * same data becomes a pay headline, label-over-value tiles two per row, yes/no
 * requirements as chips, and the description as a paragraph, with thin rules
 * between the groups.
 *
 * WHAT IT DOES NOT DO:
 *  - no data formatting. Callers pass finished strings ("$22 - $26 / hr",
 *    "Mon-Fri, 7am"); this file owns no currency, date or plural logic.
 *  - no copy. Every label, value and requirement state word arrives already
 *    translated from the caller's own next-intl namespace, which is why
 *    `Requirement` takes a `stateLabel` instead of printing "required".
 *  - no fetching, no data shaping, no card frame. The page supplies the frame
 *    (`DashboardPanel` + `PanelHeader` with the status badges in its action
 *    slot); this is only what goes inside it.
 *
 * FIELD ORDER — the three job pages stay identical only because it is written
 * down once, here:
 *   pay, schedule, start, duration, location, openings, experience, language,
 *   requirements, description.
 * Pay is the `Headline`; schedule through language are `Tiles` in that order;
 * requirements are chips; description is `Text`.
 *
 * COMPOSITION: children of `FactsCard` are the sections, and they must be
 * DIRECT children — the container counts them to draw the dividers, so a group
 * wrapped in a fragment collapses into one section and loses its rule. A
 * conditional section (`{job.description ? <FactsCard.Text/> : null}`) is fine:
 * `Children.toArray` drops the `null` before anything is counted.
 *
 * There are no boolean mode props. The one state flag is `Tile`'s `muted`, and
 * it is allowed because it changes colour ONLY (see its own note).
 */

/* ===== Shared label ===================================================== */

/**
 * The small uppercase label, from `KVList`'s `dt`. Used verbatim for section
 * headings and tile labels so a tile label and a section label are the same
 * typographic object at two nesting levels.
 */
const labelClasses = 'text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]';

/**
 * Section labels are `h3`.
 *
 * `PanelHeader` renders the panel title as an `h2`, and this card is always
 * inside a panel, so its section labels sit exactly one level below it and the
 * page outline stays continuous. The tile labels are NOT headings (they are
 * `dt`), and the headline's label is not either (it labels a single value, so
 * it is a `p`, like `MetricCard`'s) — only the real groupings get into the
 * outline.
 */
function SectionLabel({ children }: { children: ReactNode }) {
    return <h3 className={labelClasses}>{children}</h3>;
}

/* ===== Container ======================================================== */

function FactsCardBody({
    children,
    className = '',
}: {
    children: ReactNode;
    className?: string;
}) {
    // `toArray` is what makes `{cond ? <Section/> : null}` safe: it drops
    // null/undefined/boolean children, so an absent section cannot claim a
    // divider and leave a rule hanging under nothing.
    const sections = Children.toArray(children);

    return (
        <div className={['p-5 md:p-6', className].filter(Boolean).join(' ')}>
            {sections.map((section, index) => (
                // A wrapper per section rather than a `divide-y` on the
                // container: the divider then lives on a real element with a
                // stable `data-divider`, which is what lets a test assert the
                // n-sections/n-1-dividers invariant instead of trusting a class
                // string. Spacing is border-top + padding-top, never a pair of
                // facing margins that could collapse.
                <div
                    // Sections are a positional list with no identity of their
                    // own and are never reordered in place.
                    key={index}
                    data-section={index}
                    data-divider={index > 0 ? 'true' : undefined}
                    className={index > 0 ? 'mt-5 border-t border-[var(--jale-divider)] pt-5' : ''}
                >
                    {section}
                </div>
            ))}
        </div>
    );
}

/* ===== Sections ========================================================= */

/**
 * The pay block: the one fact a worker decides on, set as a figure instead of a
 * row. Traced from the worker job page's inline pay block — small uppercase
 * label, extrabold tabular figure, optional hint under it (that is where
 * `PayReferenceHint` goes).
 */
function Headline({
    label,
    children,
    hint,
}: {
    label: ReactNode;
    children: ReactNode;
    /** Rendered under the figure; a node, not a string (it is a component). */
    hint?: ReactNode;
}) {
    return (
        <>
            <p className={labelClasses}>{label}</p>
            <p className="mt-1 text-2xl font-extrabold tracking-tight tabular-nums text-[var(--jale-ink)] md:text-3xl">
                {children}
            </p>
            {hint ? <div className="mt-2">{hint}</div> : null}
        </>
    );
}

/** A labelled (or unlabelled) group of content. */
function Section({ label, children }: { label?: ReactNode; children: ReactNode }) {
    return (
        <>
            {label ? <SectionLabel>{label}</SectionLabel> : null}
            <div className={label ? 'mt-3' : ''}>{children}</div>
        </>
    );
}

/**
 * The facts grid.
 *
 * `grid-cols-1 min-[360px]:grid-cols-2` and not
 * `repeat(auto-fit, minmax(9.5rem, 1fr))`: auto-fit would keep adding columns
 * as the card grows and put four tiles on one row on a desktop job page, which
 * is not the locked design — the design is exactly two per row, dropping to one
 * on a very narrow phone. The arbitrary breakpoint matches the precedent in
 * `worker/onboarding/AboutYouStep.tsx` (`min-[400px]:grid-cols-2`), and the
 * card is always full-width in the page's main column, so a viewport query and
 * a container query would resolve the same way here.
 */
function Tiles({ children }: { children: ReactNode }) {
    return <dl className="grid grid-cols-1 gap-x-5 gap-y-3 min-[360px]:grid-cols-2">{children}</dl>;
}

function Tile({
    label,
    children,
    muted = false,
}: {
    label: ReactNode;
    children: ReactNode;
    /**
     * The ONE state flag in this file. It is allowed because it changes colour
     * and nothing else: it drops a placeholder value ("Por confirmar", "Not
     * set") to ink-2 so a card full of real facts is not shouting the missing
     * ones. It is never colour-ONLY state — the caller's own words are what say
     * the value is unset; this just stops them competing with the facts.
     */
    muted?: boolean;
}) {
    return (
        <div className="min-w-0">
            <dt className={labelClasses}>{label}</dt>
            <dd
                className={[
                    'mt-0.5 min-w-0 text-sm font-medium [overflow-wrap:anywhere]',
                    muted ? 'text-[var(--jale-ink-2)]' : 'text-[var(--jale-ink)]',
                ].join(' ')}
            >
                {children}
            </dd>
        </div>
    );
}

export type RequirementState = 'required' | 'optional';

/**
 * Dot colour per state. Literal classes (not built at runtime) so the Tailwind
 * JIT can see them; the values behind them are tokens. Same dot geometry as
 * `Badge`, because a requirement chip and a status badge are the same idea.
 */
const requirementDotClasses: Record<RequirementState, string> = {
    required: 'bg-[var(--jale-success)]',
    optional: 'bg-[var(--jale-ink-2)]',
};

/** The chip row. Its own optional label makes it usable as a whole section. */
function Requirements({ label, children }: { label?: ReactNode; children: ReactNode }) {
    return (
        <>
            {label ? <SectionLabel>{label}</SectionLabel> : null}
            <ul className={['flex flex-wrap gap-2', label ? 'mt-3' : ''].filter(Boolean).join(' ')}>
                {children}
            </ul>
        </>
    );
}

function Requirement({
    state,
    stateLabel,
    children,
}: {
    state: RequirementState;
    /**
     * The state word, already translated ("Required" / "Requerido"). Rendered
     * as a visually hidden suffix, so a screen reader hears "Driver's license,
     * required" while sighted users read the dot.
     *
     * REQUIRED, not optional-with-a-default: a default would either hardcode
     * English in a bilingual app or, if left empty, silently reduce the chip to
     * colour-only state. Making the caller pass it is the enforcement.
     */
    stateLabel: string;
    children: ReactNode;
}) {
    return (
        <li className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-[var(--jale-divider)] bg-[var(--jale-input)] px-2.5 py-1 text-xs font-semibold text-[var(--jale-ink)]">
            <span
                aria-hidden
                className={`size-[7px] shrink-0 rounded-full ${requirementDotClasses[state]}`}
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
            <span className="sr-only">{stateLabel}</span>
        </li>
    );
}

/**
 * Free text (the job description). `whitespace-pre-wrap` is load-bearing:
 * employers write these with line breaks and a bullet per line.
 */
function Text({ children }: { children: ReactNode }) {
    return (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--jale-ink)]">
            {children}
        </p>
    );
}

/* ===== Compound export ================================================== */

export const FactsCard = Object.assign(FactsCardBody, {
    Headline,
    Section,
    Tiles,
    Tile,
    Requirements,
    Requirement,
    Text,
});
