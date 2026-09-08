// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { JobFactsCard, type JobFactsCardProps } from '@/components/jobs/JobFactsCard';

/**
 * The shared body of the three job pages' one detail card.
 *
 * `JobFactsCard` owns the LOCKED section order and nothing else: it formats no
 * date, resolves no message key, reads no job object. Every string below is
 * test copy handed in as a prop, which is exactly the contract -- the three
 * pages each translate out of their own next-intl namespace and pass finished
 * strings in, so a job reads identically to the worker, the employer and a
 * stranger on the public page.
 *
 * What these tests defend is the part the page tests cannot see: that an
 * omitted section really is omitted (and does not leave a `FactsCard` divider
 * hanging under nothing), and that the section ORDER is the locked one rather
 * than whatever order a page happened to pass its props in.
 */

const pay = { label: 'Pay range', figure: '$22–$26/hr' };

const base: JobFactsCardProps = {
    pay,
    schedule: {
        label: 'Schedule and dates',
        tiles: [
            { key: 'shift', label: 'Shift', value: 'Mon, Tue · 7:00 AM – 4:00 PM' },
            { key: 'duration', label: 'Duration', value: '1–3 months' },
            { key: 'start', label: 'Start date', value: 'June 15, 2026' },
            { key: 'openings', label: 'Openings', value: '1/3' },
        ],
    },
    where: {
        label: "Where and what's needed",
        tiles: [
            { key: 'location', label: 'Location', value: 'Austin, TX' },
            { key: 'trade', label: 'Trade', value: 'Drywall' },
            { key: 'experience', label: 'Experience', value: '3' },
            { key: 'language', label: 'Language', value: 'Spanish' },
        ],
        chips: [
            {
                key: 'policy',
                label: 'Requirements',
                items: [
                    { key: 'transportation', label: 'Transportation', state: 'required', stateLabel: 'Required' },
                ],
            },
            {
                key: 'certifications',
                label: 'Certifications',
                items: [{ key: 'osha', label: 'OSHA 10', state: 'optional', stateLabel: 'Optional' }],
            },
            // Empty on this job, and therefore never drawn -- a labelled row
            // with no chips under it is the failure this pins.
            { key: 'documents', label: 'Required documents', items: [] },
        ],
    },
    documents: null,
    about: { label: 'About the job', text: 'Framing and drywall on a new build.' },
};

/** Every tile in the card, in DOM order, as `[label, value]`. */
function tiles(container: HTMLElement): [string, string][] {
    return Array.from(container.querySelectorAll('dl > div')).map((tile) => [
        tile.querySelector('dt')?.textContent ?? '',
        tile.querySelector('dd')?.textContent ?? '',
    ]);
}

/** The card's section outline: `FactsCard` renders every section label as an `h3`. */
function sectionLabels(container: HTMLElement): (string | null)[] {
    return Array.from(container.querySelectorAll('h3')).map((h) => h.textContent);
}

describe('JobFactsCard', () => {
    it('renders the locked section order, chip rows nested under the where section', () => {
        const { container } = render(<JobFactsCard {...base} />);

        // The `h3` outline IS the section order -- `FactsCard.Section` and
        // `.Requirements` both render their label as one, and the pay headline
        // deliberately does not (it labels a single figure, not a group).
        // The chip rows sit INSIDE "Where and what's needed" rather than being
        // sections of their own, so the card stays three groups deep instead
        // of six (owner ruling, fix round 1); an empty row draws nothing.
        expect(sectionLabels(container)).toEqual([
            'Schedule and dates',
            "Where and what's needed",
            'Requirements',
            'Certifications',
            'About the job',
        ]);
    });

    it('keeps each chip row inside the where section, not as a section of its own', () => {
        const { container } = render(<JobFactsCard {...base} />);

        // Four top-level sections (the pay headline, schedule, where, about)
        // and therefore three rules. The two chip rows are inside the `where`
        // section and must not have claimed dividers of their own -- if they
        // had, this would read 6 and 5.
        expect(container.querySelectorAll('[data-section]')).toHaveLength(4);
        expect(container.querySelectorAll('[data-divider]')).toHaveLength(3);
    });

    it('sets pay as the headline figure, not a tile', () => {
        const { container } = render(<JobFactsCard {...base} />);

        expect(screen.getAllByText('$22–$26/hr')).toHaveLength(1);
        // If pay leaked into a tile it would show up as a dt/dd pair.
        expect(tiles(container).map(([label]) => label)).not.toContain('Pay range');
    });

    it('renders the eight tiles as dt/dd pairs in the locked order', () => {
        const { container } = render(<JobFactsCard {...base} />);

        expect(tiles(container)).toEqual([
            ['Shift', 'Mon, Tue · 7:00 AM – 4:00 PM'],
            ['Duration', '1–3 months'],
            ['Start date', 'June 15, 2026'],
            ['Openings', '1/3'],
            ['Location', 'Austin, TX'],
            ['Trade', 'Drywall'],
            ['Experience', '3'],
            ['Language', 'Spanish'],
        ]);
    });

    it('gives every requirement chip a readable state, not just a coloured dot', () => {
        render(<JobFactsCard {...base} />);

        const chips = screen.getAllByRole('listitem');
        expect(chips).toHaveLength(2);
        expect(chips[0].textContent).toBe('Transportation, Required');
        expect(chips[1].textContent).toBe('OSHA 10, Optional');
    });

    it('drops a chip row with no chips rather than labelling an empty list', () => {
        render(<JobFactsCard {...base} />);
        expect(screen.queryByRole('heading', { level: 3, name: 'Required documents' })).toBeNull();
    });

    it('renders the pay hint under the figure when the page supplies one', () => {
        render(<JobFactsCard {...base} pay={{ ...pay, hint: <p>For comparison: $20–$28/hr</p> }} />);
        expect(screen.getByText('For comparison: $20–$28/hr')).toBeInTheDocument();
    });

    it('renders the worker-only documents section between requirements and about', () => {
        const { container } = render(
            <JobFactsCard
                {...base}
                documents={{
                    label: 'Documents',
                    children: (
                        <ul>
                            <li>Resume — Uploaded</li>
                        </ul>
                    ),
                }}
            />,
        );

        expect(sectionLabels(container)).toEqual([
            'Schedule and dates',
            "Where and what's needed",
            'Requirements',
            'Certifications',
            'Documents',
            'About the job',
        ]);
    });

    it('omits pay, requirements, documents and about entirely when the job has none', () => {
        const { container } = render(
            <JobFactsCard
                pay={null}
                schedule={{
                    label: 'Schedule and dates',
                    tiles: [{ key: 'start', label: 'Start date', value: 'To be confirmed', muted: true }],
                }}
                where={{
                    label: "Where and what's needed",
                    tiles: [{ key: 'location', label: 'Location', value: 'Austin, TX' }],
                }}
                documents={null}
                about={null}
            />,
        );

        expect(sectionLabels(container)).toEqual(['Schedule and dates', "Where and what's needed"]);
        expect(screen.queryAllByRole('listitem')).toHaveLength(0);
        // Two sections, so exactly one rule -- an omitted section that still
        // claimed its divider would leave a hairline under nothing.
        expect(container.querySelectorAll('[data-section]')).toHaveLength(2);
        expect(container.querySelectorAll('[data-divider]')).toHaveLength(1);
    });

    it('drops a section whose tiles are all absent rather than drawing an empty grid', () => {
        // Defensive: `Inicio` and `Ubicación` are always passed, so this cannot
        // happen from the three pages today -- but an empty `dl` carrying its
        // own divider is the failure it would produce, and it is free to forbid.
        const { container } = render(
            <JobFactsCard {...base} where={{ label: "Where and what's needed", tiles: [], chips: [] }} />,
        );

        expect(sectionLabels(container)).not.toContain("Where and what's needed");
        expect(container.querySelectorAll('dl')).toHaveLength(1);
    });

    it('mutes the About text when the page passes a placeholder instead of a description', () => {
        const { container } = render(
            <JobFactsCard {...base} about={{ label: 'About the job', text: 'No description was added.', muted: true }} />,
        );

        const paragraph = within(container).getByText('No description was added.');
        expect(paragraph.className).toContain('--jale-ink-2');
    });

    it('mutes a placeholder tile value without making colour the only signal', () => {
        const { container } = render(
            <JobFactsCard
                {...base}
                schedule={{
                    label: 'Schedule and dates',
                    tiles: [{ key: 'start', label: 'Start date', value: 'To be confirmed', muted: true }],
                }}
            />,
        );

        const dd = container.querySelector('dl > div dd');
        expect(dd?.className).toContain('--jale-ink-2');
        // The words, not the colour, are what say the value is unset.
        expect(within(container).getByText('To be confirmed')).toBeInTheDocument();
    });
});
