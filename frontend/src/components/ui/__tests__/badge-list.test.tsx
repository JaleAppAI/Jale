// @vitest-environment jsdom
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BadgeList } from '../badge-list';

/*
 * `BadgeList` grew an `align` variant when the profile pages moved their chip
 * facts from `KVList` rows into `FactsCard` tiles.
 *
 * In a KV row the chips sat under the right-hand value column, so the row is
 * right-aligned. Inside a tile the label is ABOVE the value and the value
 * starts at the tile's left edge -- right-aligned chips there float away from
 * the label that names them.
 *
 * `'end'` stays the default so the job pages (lane D2) and any other KV-row
 * caller keep their current markup byte-for-byte.
 */

const ITEMS = ['Conduit bending', 'Lockout/tagout'];

/** The chip row is the `items`' parent; the component renders no test id. */
function chipRow(container: HTMLElement): HTMLElement {
    const badge = screen.getByText(ITEMS[0]);
    const row = badge.closest('span.flex');
    if (!row) throw new Error('BadgeList rendered no flex chip row');
    expect(container.contains(row)).toBe(true);
    return row as HTMLElement;
}

describe('BadgeList align variant', () => {
    it('right-aligns by default, so existing KV-row callers are unchanged', () => {
        const { container } = render(<BadgeList items={ITEMS} emptyLabel="none" />);
        expect(chipRow(container).className).toContain('justify-end');
    });

    it('right-aligns on an explicit align="end"', () => {
        const { container } = render(<BadgeList items={ITEMS} emptyLabel="none" align="end" />);
        expect(chipRow(container).className).toContain('justify-end');
    });

    it('does not right-align on align="start"', () => {
        const { container } = render(<BadgeList items={ITEMS} emptyLabel="none" align="start" />);
        const row = chipRow(container);
        expect(row.className).not.toContain('justify-end');
        expect(row.className).toContain('justify-start');
    });

    it('still renders every chip, whichever way it is aligned', () => {
        render(<BadgeList items={ITEMS} emptyLabel="none" align="start" />);
        for (const item of ITEMS) expect(screen.getByText(item)).toBeInTheDocument();
    });

    it('renders the bare empty label with no chip row at all, in both alignments', () => {
        // The empty branch returns a fragment, not a span -- there is no row to
        // align -- which is why a caller has to read `items.length` itself to
        // decide whether its tile is `muted`.
        for (const align of ['start', 'end'] as const) {
            const { container, unmount } = render(
                <BadgeList items={[]} emptyLabel="No skills added" align={align} />,
            );
            expect(container.textContent).toBe('No skills added');
            expect(container.querySelector('span.flex')).toBeNull();
            unmount();
        }
    });
});
