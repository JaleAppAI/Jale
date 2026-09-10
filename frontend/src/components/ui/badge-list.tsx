import { Badge } from '@/components/ui/badge';

/**
 * A row whose value is a set of chips, wrapping onto more lines at 390px
 * rather than squeezing the label beside it.
 */

export type BadgeListAlign = 'start' | 'end';

/**
 * Which edge the chips sit against, and the ONLY thing this prop changes.
 *
 * Literal class strings in a map rather than a template built at runtime, for
 * the same reason `FactsCard`'s requirement dots are: the Tailwind JIT scans
 * source text, and a class it cannot see in the file is never emitted.
 *
 * `'end'` is the default because that is where this component started: in a
 * `KVList` row the label is on the LEFT and the value column is right-aligned,
 * so the chips have to hug the right edge to line up with the plain-text values
 * above and below them. Inside a `FactsCard.Tile` the label sits ABOVE its
 * value and the value starts at the tile's left edge -- right-aligned chips
 * there float away from the label that names them, which is what `'start'` is
 * for.
 */
const alignClasses: Record<BadgeListAlign, string> = {
    start: 'justify-start',
    end: 'justify-end',
};

/**
 * `emptyLabel` is required, not defaulted: an empty list is a real answer
 * ("no certifications", "no trades selected"), and every caller knows which
 * field it is talking about. A shared default would be a bare dash again, one
 * indirection further away.
 */
export function BadgeList({
    items,
    emptyLabel,
    tone = 'neutral',
    align = 'end',
}: {
    items: string[];
    emptyLabel: string;
    tone?: 'neutral' | 'info';
    /**
     * An enumerated variant, not an `alignStart` boolean: two named edges read
     * the same at the call site as they do here, and a third ("center") would
     * be an addition rather than a second flag contradicting the first.
     */
    align?: BadgeListAlign;
}) {
    // Plain text, so an empty list reads in the same ink as every other "not
    // set" value in the list rather than as a differently-styled special case.
    // NOTE for callers: this branch renders no element, so it carries no
    // alignment and no muted styling -- a caller that wants an empty list to
    // read as unset has to test `items.length` itself.
    if (items.length === 0) return <>{emptyLabel}</>;

    return (
        <span className={`flex flex-wrap items-center ${alignClasses[align]} gap-x-3 gap-y-1.5`}>
            {items.map((item) => (
                <Badge key={item} tone={tone}>
                    {item}
                </Badge>
            ))}
        </span>
    );
}
