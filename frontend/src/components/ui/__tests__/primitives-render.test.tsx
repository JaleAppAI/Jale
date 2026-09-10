import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DashboardPanel } from '../dashboard-panel';
import { PanelHeader } from '../panel-header';

/**
 * Render coverage for the two slots this lane added. Kept in a `.tsx` sibling
 * of `primitives-guard.test.ts` because that file is `.ts` (pure fs reads) and
 * JSX needs the jsdom environment `environmentMatchGlobs` gives `*.test.tsx`.
 * Neither primitive touches next-intl, so no `NextIntlClientProvider` wrapper.
 */

describe('DashboardPanel', () => {
    it('renders a <section> by default', () => {
        const { container } = render(<DashboardPanel>body</DashboardPanel>);
        expect(container.querySelector('section')).not.toBeNull();
        expect(container.querySelector('article')).toBeNull();
    });

    it('renders an <article> when asked, keeping the card recipe and className', () => {
        const { container } = render(
            <DashboardPanel as="article" className="overflow-hidden">
                body
            </DashboardPanel>,
        );

        const article = container.querySelector('article');
        expect(article).not.toBeNull();
        expect(container.querySelector('section')).toBeNull();
        // The caller's class must survive the merge, and the recipe must still
        // be there -- `j/[code]` dropped a hand-copied twin of it to get here.
        expect(article!.className).toContain('overflow-hidden');
        expect(article!.className).toContain('rounded-[var(--radius-card)]');
        expect(article!.className).toContain('border-[var(--jale-divider)]');
    });
});

describe('PanelHeader', () => {
    it('renders leading, then the title, then the subtitle, in that order', () => {
        const { container } = render(
            <PanelHeader
                leading={<span data-testid="avatar">AV</span>}
                title="Ada Lovelace"
                subtitle="Concrete Finisher"
                action={<button type="button">Edit</button>}
            />,
        );

        expect(screen.getByRole('heading', { level: 2, name: 'Ada Lovelace' })).toBeTruthy();
        expect(screen.getByTestId('avatar')).toBeTruthy();
        expect(screen.getByText('Concrete Finisher')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();

        // Document order, not just presence: the avatar precedes the name and
        // the subtitle sits under it. `compareDocumentPosition`'s
        // DOCUMENT_POSITION_FOLLOWING bit is 4.
        const avatar = screen.getByTestId('avatar');
        const heading = screen.getByRole('heading', { level: 2 });
        const subtitle = screen.getByText('Concrete Finisher');
        expect(avatar.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(4);
        expect(heading.compareDocumentPosition(subtitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(4);

        expect(subtitle.className).toContain('text-[var(--jale-ink-2)]');
        // The divider row is what makes this a panel header rather than a bare
        // flex row; every caller relies on it instead of drawing its own.
        expect(container.firstElementChild!.className).toContain('border-b');
    });

    it('lets an unbroken user-supplied name wrap rather than overflow the row', () => {
        // Both callers feed raw user text (`company_name`, `full_name`). A long
        // space-less name has no break opportunity, so without an explicit wrap
        // rule it pushes the header wider than a 375px viewport -- the same
        // horizontal-scroll failure `flex-wrap` was added to fix, arriving by a
        // different route. Asserting the class is the honest test: the effect is
        // CSS-only, and jsdom does no layout.
        const unbrokenTitle = 'A'.repeat(60);
        render(
            <PanelHeader
                leading={<span data-testid="avatar">AV</span>}
                title={unbrokenTitle}
                action={<button type="button">Edit</button>}
            />,
        );

        const heading = screen.getByRole('heading', { level: 2, name: unbrokenTitle });
        expect(heading.className).toContain('[overflow-wrap:anywhere]');
        // `min-w-0` has to survive alongside it, or the flex child cannot
        // shrink below its content width and the wrap rule never applies.
        expect(heading.className).toContain('min-w-0');
        // Clipping a person's or company's name is the one outcome worse than
        // two lines, so `truncate` must NOT come back.
        expect(heading.className).not.toContain('truncate');
    });

    it('renders neither slot when they are omitted', () => {
        const { container } = render(<PanelHeader title="Documents" />);

        expect(screen.getByRole('heading', { level: 2, name: 'Documents' })).toBeTruthy();
        expect(container.textContent).toBe('Documents');
    });
});
