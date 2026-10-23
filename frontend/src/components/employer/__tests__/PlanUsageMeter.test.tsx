// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { EmployerBilling } from '@/lib/api/employer';

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

import { renderIntl } from './render-intl';
import { PlanUsageMeter } from '../PlanUsageMeter';

const billing: EmployerBilling = {
    planCode: 'employer_pro',
    activeJobLimit: 10,
    templateLimit: 20,
    activeJobUsage: 4,
    subscription: null,
    display_price_minor: 2000,
    currency: 'usd',
    billing_interval: 'month',
};

describe('PlanUsageMeter', () => {
    it('counts the company: the live own count plus the jobs of members the list does not show', () => {
        renderIntl(<PlanUsageMeter activeCount={1} billing={{ ...billing, otherMembersActiveJobs: 3 }} templateCount={null} />);
        expect(screen.getByText('Active jobs 4/10')).toBeInTheDocument();
    });

    it('turns the count to the warning state when only the company figure reaches the limit', () => {
        renderIntl(<PlanUsageMeter activeCount={1} billing={{ ...billing, otherMembersActiveJobs: 9 }} templateCount={null} />);
        // One own job is under the limit of 10; the company's ten are not.
        expect(screen.getByText('Active jobs 10/10')).toHaveClass('text-[var(--jale-warning-text)]');
    });

    it('does not warn while the company is under the limit', () => {
        renderIntl(<PlanUsageMeter activeCount={1} billing={{ ...billing, otherMembersActiveJobs: 2 }} templateCount={null} />);
        expect(screen.getByText('Active jobs 3/10')).not.toHaveClass('text-[var(--jale-warning-text)]');
    });

    describe('with billing unavailable: the plain count', () => {
        it('says one active job, not "1 active jobs"', () => {
            renderIntl(<PlanUsageMeter activeCount={1} billing={null} templateCount={null} />);
            expect(screen.getByText('1 active job')).toBeInTheDocument();
        });

        it('keeps the plural for more than one', () => {
            renderIntl(<PlanUsageMeter activeCount={3} billing={null} templateCount={null} />);
            expect(screen.getByText('3 active jobs')).toBeInTheDocument();
        });

        it('agrees with the count in Spanish', () => {
            const { unmount } = renderIntl(<PlanUsageMeter activeCount={1} billing={null} templateCount={null} />, 'es');
            expect(screen.getByText('1 empleo activo')).toBeInTheDocument();
            unmount();
            renderIntl(<PlanUsageMeter activeCount={3} billing={null} templateCount={null} />, 'es');
            expect(screen.getByText('3 empleos activos')).toBeInTheDocument();
        });
    });

    it('shows the live count alone when the API sends no company figure (the owner, or an older API)', () => {
        renderIntl(<PlanUsageMeter activeCount={2} billing={billing} templateCount={null} />);
        expect(screen.getByText('Active jobs 2/10')).toBeInTheDocument();
    });
});
