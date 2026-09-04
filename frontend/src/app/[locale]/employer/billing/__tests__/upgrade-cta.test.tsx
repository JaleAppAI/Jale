// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import type { EmployerBilling } from '@/lib/api/employer';

/**
 * The billing page offered TWO buttons that started the same Stripe checkout:
 * a ghost "Upgrade plan" in the current-plan panel and the filled one in the
 * Upgrade panel below it. They shared `checkoutBusy`, so pressing either put
 * both into a loading state -- which reads as a fault, not as one action in
 * flight. Owner report, 2026-09-03 release.
 *
 * The assertion is a COUNT, not the absence of one particular node: whichever
 * of the two a future edit removes, "exactly one way to start checkout" is the
 * rule that has to hold.
 */

// next-intl's navigation factory reaches into `next/navigation` internals that
// vitest+jsdom can't resolve outside a real Next app -- same stub as the other
// employer suites.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => {
            throw err;
        },
    }),
}));

// The page's own chrome is not what this suite is about, and AppShell drags in
// the whole nav config + next/navigation.
vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const billing: EmployerBilling = {
    planCode: 'employer_free',
    activeJobLimit: 1,
    templateLimit: 1,
    activeJobUsage: 1,
    // Present, so `canManage` is true too: the panel then holds Manage beside
    // whatever upgrade control survives, which is the crowded real-world case.
    subscription: {
        plan_code: 'employer_free',
        status: 'canceled',
        current_period_start: null,
        current_period_end: null,
        cancel_at_period_end: false,
        grace_ends_at: null,
    },
    display_price_minor: 2000,
    currency: 'usd',
    billing_interval: 'month',
};

vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready',
        data: billing,
        empty: false,
        errorKind: null,
        refreshing: false,
        refreshError: null,
        retry: vi.fn(),
        refresh: vi.fn(),
        setData: vi.fn(),
    }),
}));

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import EmployerBillingPage from '../page';

describe('employer billing page upgrade CTA', () => {
    it('renders exactly one checkout button', () => {
        renderIntl(<EmployerBillingPage />);
        const upgradeButtons = screen.getAllByRole('button', {
            name: message('billing.actions.upgrade'),
        });
        expect(upgradeButtons).toHaveLength(1);
    });

    it('keeps the Upgrade panel as the surviving one', () => {
        renderIntl(<EmployerBillingPage />);
        expect(screen.getByText(message('billing.upgrade_panel.title'))).toBeInTheDocument();
        // And Manage billing is untouched -- it is a different action.
        expect(
            screen.getByRole('button', { name: message('billing.actions.manage') }),
        ).toBeInTheDocument();
    });
});
