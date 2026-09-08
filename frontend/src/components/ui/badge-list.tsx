import { Badge } from '@/components/ui/badge';

/**
 * A KV row whose value is a set of chips. Right-aligned to sit under the
 * column the dashed rows establish, wrapping onto more lines at 390px rather
 * than squeezing the label.
 */
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
}: {
    items: string[];
    emptyLabel: string;
    tone?: 'neutral' | 'info';
}) {
    // Plain text, so an empty list reads in the same ink as every other "not
    // set" value in the list rather than as a differently-styled special case.
    if (items.length === 0) return <>{emptyLabel}</>;

    return (
        <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
            {items.map((item) => (
                <Badge key={item} tone={tone}>
                    {item}
                </Badge>
            ))}
        </span>
    );
}
