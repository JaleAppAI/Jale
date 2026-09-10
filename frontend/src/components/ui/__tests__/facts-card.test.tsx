// @vitest-environment jsdom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { FactsCard } from '@/components/ui/facts-card';
import { FactsCardSkeleton } from '@/components/ui/page-skeletons';

/**
 * `FactsCard` is the body of the ONE job/profile detail card: a pay headline,
 * label-over-value tiles, requirement chips and a description paragraph,
 * separated by hairline section rules.
 *
 * What these tests defend is the part a reviewer cannot see by eye:
 *
 *  - the tiles are a real `dl`/`dt`/`dd`, not a grid of divs, because that is
 *    what makes a label/value pair a pair to a screen reader;
 *  - N sections produce exactly N-1 dividers, including when a page renders a
 *    section as `{cond ? <Section/> : null}` -- every detail page does, and a
 *    dropped `null` that still claimed its divider would leave a rule hanging
 *    under nothing;
 *  - a requirement's state ("required"/"optional") is readable, not just
 *    coloured. The chip's dot carries it visually; the caller-supplied
 *    `stateLabel` carries it to assistive tech.
 *
 * The state words below are plain English on purpose: they are TEST copy. The
 * component never owns a translated string -- callers pass both the chip text
 * and its state label out of their own next-intl namespace.
 */

describe('FactsCard.Tiles', () => {
    it('renders a dl with a dt/dd pair per tile', () => {
        const { container } = render(
            <FactsCard>
                <FactsCard.Tiles>
                    <FactsCard.Tile label="Schedule">Mon-Fri, 7am start</FactsCard.Tile>
                    <FactsCard.Tile label="Openings">3</FactsCard.Tile>
                </FactsCard.Tiles>
            </FactsCard>,
        );

        expect(container.querySelectorAll('dl')).toHaveLength(1);
        expect(container.querySelectorAll('dl dt')).toHaveLength(2);
        expect(container.querySelectorAll('dl dd')).toHaveLength(2);

        expect(screen.getByText('Schedule').tagName).toBe('DT');
        expect(screen.getByText('Mon-Fri, 7am start').tagName).toBe('DD');
        expect(screen.getByText('Openings').tagName).toBe('DT');
        expect(screen.getByText('3').tagName).toBe('DD');
    });

    it('paints a muted tile value in ink-2 and a normal one in ink', () => {
        render(
            <FactsCard>
                <FactsCard.Tiles>
                    <FactsCard.Tile label="Location">Austin, TX</FactsCard.Tile>
                    <FactsCard.Tile label="Duration" muted>
                        To be confirmed
                    </FactsCard.Tile>
                </FactsCard.Tiles>
            </FactsCard>,
        );

        expect(screen.getByText('To be confirmed').className).toContain('text-[var(--jale-ink-2)]');
        expect(screen.getByText('Austin, TX').className).toContain('text-[var(--jale-ink)]');
        expect(screen.getByText('Austin, TX').className).not.toContain('text-[var(--jale-ink-2)]');
    });

    it('lets a long value break rather than widen the card', () => {
        render(
            <FactsCard>
                <FactsCard.Tiles>
                    <FactsCard.Tile label="Location">
                        1234-unbroken-address-string-that-cannot-wrap
                    </FactsCard.Tile>
                </FactsCard.Tiles>
            </FactsCard>,
        );

        const value = screen.getByText('1234-unbroken-address-string-that-cannot-wrap');
        expect(value.className).toContain('[overflow-wrap:anywhere]');
        expect(value.className).toContain('min-w-0');
    });
});

describe('FactsCard section dividers', () => {
    it('puts exactly one divider between two consecutive sections', () => {
        const { container } = render(
            <FactsCard>
                <FactsCard.Section label="Facts">
                    <FactsCard.Text>First</FactsCard.Text>
                </FactsCard.Section>
                <FactsCard.Section label="Description">
                    <FactsCard.Text>Second</FactsCard.Text>
                </FactsCard.Section>
            </FactsCard>,
        );

        const sections = Array.from(container.querySelectorAll('[data-section]'));
        expect(sections).toHaveLength(2);
        expect(container.querySelectorAll('[data-divider]')).toHaveLength(1);
        expect(sections[0].hasAttribute('data-divider')).toBe(false);
        expect(sections[1].hasAttribute('data-divider')).toBe(true);
    });

    it('never draws a divider above the first section', () => {
        const { container } = render(
            <FactsCard>
                <FactsCard.Section>
                    <FactsCard.Text>Only</FactsCard.Text>
                </FactsCard.Section>
            </FactsCard>,
        );

        expect(container.querySelectorAll('[data-section]')).toHaveLength(1);
        expect(container.querySelectorAll('[data-divider]')).toHaveLength(0);
    });

    it('ignores a section a page conditionally rendered away', () => {
        // Every detail page writes `{job.description ? <Section/> : null}`.
        const { container } = render(
            <FactsCard>
                <FactsCard.Section label="Facts">
                    <FactsCard.Text>First</FactsCard.Text>
                </FactsCard.Section>
                {null}
                <FactsCard.Section label="Description">
                    <FactsCard.Text>Second</FactsCard.Text>
                </FactsCard.Section>
            </FactsCard>,
        );

        expect(container.querySelectorAll('[data-section]')).toHaveLength(2);
        expect(container.querySelectorAll('[data-divider]')).toHaveLength(1);
    });

    it('renders a section label as an h3, one level under the panel title', () => {
        render(
            <FactsCard>
                <FactsCard.Section label="Requirements">
                    <FactsCard.Text>Body</FactsCard.Text>
                </FactsCard.Section>
            </FactsCard>,
        );

        // `PanelHeader` renders the panel title as an h2, so the card's own
        // section labels are h3 and the page outline stays continuous.
        expect(screen.getByRole('heading', { level: 3, name: 'Requirements' })).toBeInTheDocument();
    });

    it('passes className through on the container only', () => {
        const { container } = render(
            <FactsCard className="test-passthrough">
                <FactsCard.Section>
                    <FactsCard.Text>Body</FactsCard.Text>
                </FactsCard.Section>
            </FactsCard>,
        );

        expect(container.querySelectorAll('.test-passthrough')).toHaveLength(1);
    });
});

describe('FactsCard.Headline', () => {
    it('renders the label, the figure and the hint slot', () => {
        render(
            <FactsCard>
                <FactsCard.Headline label="Pay range" hint={<span>Above average for Austin</span>}>
                    $22 - $26 / hr
                </FactsCard.Headline>
            </FactsCard>,
        );

        expect(screen.getByText('Pay range')).toBeInTheDocument();
        const figure = screen.getByText('$22 - $26 / hr');
        expect(figure.className).toContain('tabular-nums');
        expect(screen.getByText('Above average for Austin')).toBeInTheDocument();
    });

    it('renders nothing extra when there is no hint', () => {
        render(
            <FactsCard>
                <FactsCard.Headline label="Pay range">$22 - $26 / hr</FactsCard.Headline>
            </FactsCard>,
        );

        expect(screen.getByText('$22 - $26 / hr')).toBeInTheDocument();
        expect(screen.queryByText('Above average for Austin')).toBeNull();
    });
});

describe('FactsCard.Requirements', () => {
    it('renders one list item per requirement', () => {
        render(
            <FactsCard>
                <FactsCard.Requirements label="What you need">
                    <FactsCard.Requirement state="required" stateLabel="Required">
                        Driver&apos;s license
                    </FactsCard.Requirement>
                    <FactsCard.Requirement state="optional" stateLabel="Optional">
                        Own tools
                    </FactsCard.Requirement>
                </FactsCard.Requirements>
            </FactsCard>,
        );

        const items = screen.getAllByRole('listitem');
        expect(items).toHaveLength(2);
        expect(within(items[0]).getByText("Driver's license")).toBeInTheDocument();
        expect(within(items[1]).getByText('Own tools')).toBeInTheDocument();
    });

    it('keeps list semantics that Tailwind preflight would otherwise strip', () => {
        // `list-style: none` makes Safari/VoiceOver drop the list role, so the
        // explicit `role="list"` is what keeps "list, 2 items" being announced.
        //
        // The attribute is asserted as well as the role: jsdom applies no CSS,
        // so `getByRole('list')` resolves off the `ul` tag alone and would pass
        // on a `ul` that Safari silently un-lists. The attribute is the fix.
        render(
            <FactsCard>
                <FactsCard.Requirements label="What you need">
                    <FactsCard.Requirement state="required" stateLabel="Required">
                        Driver&apos;s license
                    </FactsCard.Requirement>
                    <FactsCard.Requirement state="optional" stateLabel="Optional">
                        Own tools
                    </FactsCard.Requirement>
                </FactsCard.Requirements>
            </FactsCard>,
        );

        const list = screen.getByRole('list');
        expect(list.tagName).toBe('UL');
        expect(list).toHaveAttribute('role', 'list');
        expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    });

    it('exposes the state to assistive tech, not only as a dot colour', () => {
        render(
            <FactsCard>
                <FactsCard.Requirements>
                    <FactsCard.Requirement state="required" stateLabel="Required">
                        Driver&apos;s license
                    </FactsCard.Requirement>
                    <FactsCard.Requirement state="optional" stateLabel="Optional">
                        Own tools
                    </FactsCard.Requirement>
                </FactsCard.Requirements>
            </FactsCard>,
        );

        const items = screen.getAllByRole('listitem');

        // The WHOLE accessible text, not a substring: JSX drops the newline
        // between the chip's two spans, so a state label without its own
        // leading separator would be announced as "Driver's licenseRequired".
        expect(items[0]).toHaveTextContent(/^Driver's license, Required$/);
        expect(items[1]).toHaveTextContent(/^Own tools, Optional$/);

        // Visually hidden, but in the accessibility tree: the dot is the only
        // visual carrier and it is `aria-hidden`, so this span is what a screen
        // reader hears after the requirement's name.
        expect(within(items[0]).getByText(', Required')).toHaveClass('sr-only');
        expect(within(items[1]).getByText(', Optional')).toHaveClass('sr-only');
    });

    it('colours the dot by state and hides it from the accessibility tree', () => {
        const { container } = render(
            <FactsCard>
                <FactsCard.Requirements>
                    <FactsCard.Requirement state="required" stateLabel="Required">
                        Driver&apos;s license
                    </FactsCard.Requirement>
                    <FactsCard.Requirement state="optional" stateLabel="Optional">
                        Own tools
                    </FactsCard.Requirement>
                </FactsCard.Requirements>
            </FactsCard>,
        );

        const dots = Array.from(container.querySelectorAll('li > [aria-hidden]'));
        expect(dots).toHaveLength(2);
        expect(dots[0].className).toContain('bg-[var(--jale-success)]');
        expect(dots[1].className).toContain('bg-[var(--jale-ink-2)]');
    });
});

describe('FactsCard.Text', () => {
    it('keeps the newlines a job description was written with', () => {
        render(
            <FactsCard>
                <FactsCard.Text>{'Line one\nLine two'}</FactsCard.Text>
            </FactsCard>,
        );

        const paragraph = screen.getByText(/Line one/);
        expect(paragraph.tagName).toBe('P');
        expect(paragraph.className).toContain('whitespace-pre-wrap');
        expect(paragraph.textContent).toBe('Line one\nLine two');
    });
});

describe('FactsCardSkeleton', () => {
    it('renders the requested tile sections, chip rows and text lines', () => {
        const { container } = render(
            <FactsCardSkeleton sections={[4, { tiles: 3, chips: [3] }]} text={2} />,
        );

        const grids = container.querySelectorAll('[data-skeleton="tiles"]');
        expect(grids).toHaveLength(2);
        expect(grids[0].children).toHaveLength(4);
        expect(grids[1].children).toHaveLength(3);
        expect(container.querySelector('[data-skeleton="requirements"]')?.children).toHaveLength(3);
        expect(container.querySelector('[data-skeleton="text"]')?.children).toHaveLength(2);
        expect(container.querySelector('[data-skeleton="headline"]')).not.toBeNull();
    });

    it('defaults to a headline, two four-tile sections and a paragraph -- no chip rows, no document rows', () => {
        const { container } = render(<FactsCardSkeleton />);

        expect(container.querySelector('[data-skeleton="headline"]')).not.toBeNull();
        const grids = container.querySelectorAll('[data-skeleton="tiles"]');
        expect(grids).toHaveLength(2);
        expect(grids[0].children).toHaveLength(4);
        expect(grids[1].children).toHaveLength(4);
        expect(container.querySelector('[data-skeleton="text"]')?.children).toHaveLength(3);
        // Neither is something a card gets by default: chip rows belong to the
        // section that asks for them, and document rows exist on one page.
        expect(container.querySelector('[data-skeleton="requirements"]')).toBeNull();
        expect(container.querySelector('[data-skeleton="documents"]')).toBeNull();
        expect(container.querySelectorAll('[data-skeleton-section]')).toHaveLength(4);
    });

    it('nests each chip row inside its tile section instead of drawing a block of its own', () => {
        // The real card (`JobFactsCard`) puts the requirement rows UNDER the
        // "where" tiles, inside that section; a skeleton that drew them as a
        // fifth block moved the description down on the swap.
        const { container } = render(
            <FactsCardSkeleton sections={[4, { tiles: 4, chips: [2, 3] }]} text={0} />,
        );

        const blocks = container.querySelectorAll('[data-skeleton-section]');
        expect(blocks).toHaveLength(3);
        expect(blocks[1].querySelectorAll('[data-skeleton="requirements"]')).toHaveLength(0);
        const rows = blocks[2].querySelectorAll('[data-skeleton="requirements"]');
        expect(rows).toHaveLength(2);
        expect(rows[0].children).toHaveLength(2);
        expect(rows[1].children).toHaveLength(3);
        // Under the tiles, with the gap the real rows use.
        expect(blocks[2].querySelector('[data-skeleton="tiles"]')).not.toBeNull();
        expect(rows[0].parentElement?.className).toContain('mt-4');
    });

    it('draws the document rows as their own block, after the tiles and before the text', () => {
        const { container } = render(<FactsCardSkeleton sections={[4, 4]} documents={2} text={3} />);

        const blocks = container.querySelectorAll('[data-skeleton-section]');
        expect(blocks).toHaveLength(5);
        const rows = container.querySelector('[data-skeleton="documents"]');
        expect(rows?.children).toHaveLength(2);
        expect(blocks[3].contains(rows)).toBe(true);
        expect(blocks[4].querySelector('[data-skeleton="text"]')).not.toBeNull();
    });

    it('draws a rule above every block after the first, and none above the first', () => {
        const { container } = render(<FactsCardSkeleton sections={[5, 3]} text={3} />);

        const blocks = container.querySelectorAll('[data-skeleton-section]');
        // Default headline + two tile sections + text = four blocks.
        expect(blocks).toHaveLength(4);
        expect(blocks[0].className).not.toContain('border-t');
        for (const block of Array.from(blocks).slice(1)) {
            expect(block.className).toContain('border-t');
        }
    });

    it('omits the headline, the text, and any section with nothing in it', () => {
        const { container } = render(
            <FactsCardSkeleton headline="none" sections={[6, 0, { tiles: 0, chips: [0] }]} text={0} />,
        );

        expect(container.querySelector('[data-skeleton="headline"]')).toBeNull();
        expect(container.querySelector('[data-skeleton="requirements"]')).toBeNull();
        expect(container.querySelector('[data-skeleton="text"]')).toBeNull();
        const blocks = container.querySelectorAll('[data-skeleton-section]');
        expect(blocks).toHaveLength(1);
        expect(blocks[0].className).not.toContain('border-t');
        expect(container.querySelector('[data-skeleton="tiles"]')?.children).toHaveLength(6);
    });

    it('gives the hint bar one height, not a losing override', () => {
        // `SkeletonLine` bakes in `h-3.5`; a `className="h-3"` on it cannot win
        // (same-property utilities resolve by stylesheet order), so the hint bar
        // must not be one. Token-exact checks: 'h-3.5' contains 'h-3'.
        const { container } = render(<FactsCardSkeleton />);

        const headline = container.querySelector('[data-skeleton="headline"]');
        const hint = headline?.children[2];
        expect(hint?.classList.contains('h-3')).toBe(true);
        expect(hint?.classList.contains('h-3.5')).toBe(false);
    });
});

describe('facts-card.tsx source', () => {
    const source = fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../facts-card.tsx'),
        'utf8',
    );

    it('uses design tokens, never a raw colour literal', () => {
        // The same guard the rest of the presentation kit lives under: a hex or
        // rgb() literal here would not re-tint in dark mode.
        expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(source).not.toMatch(/\brgba?\(/);
    });

    it('documents the field order the detail pages share', () => {
        // The three job pages stay identical only because the order is written
        // down in one place.
        expect(source).toContain(
            'pay; schedule, duration, start, openings; location, trade, experience,',
        );
    });
});
