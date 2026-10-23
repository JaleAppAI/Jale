// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import type { EmployerBilling } from '@/lib/api/employer';

/**
 * Company billing (Phase 2): only the owner pays, so a foreman sees the plan
 * but neither billing action; the owner is told when a downgrade suspended
 * foremen. Same stubs as upgrade-cta.test.tsx.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: 'test-token' }) }));
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({ handleLegalWall: (err: unknown) => { throw err; } }),
}));
vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const state = vi.hoisted(() => ({ billing: null as unknown }));

vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready',
        data: state.billing,
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

const base: EmployerBilling = {
    planCode: 'employer_free',
    activeJobLimit: 1,
    templateLimit: 2,
    activeJobUsage: 1,
    subscription: {
        plan_code: 'employer_pro',
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

describe('employer billing page: the company', () => {
    beforeEach(() => {
        state.billing = base;
    });

    it('a foreman sees the plan but no billing action, and is told the owner manages billing', () => {
        state.billing = { ...base, role: 'foreman', seats: null };
        renderIntl(<EmployerBillingPage />);
        expect(screen.queryByRole('button', { name: message('billing.actions.upgrade') })).toBeNull();
        expect(screen.queryByRole('button', { name: message('billing.actions.manage') })).toBeNull();
        expect(screen.getByText(message('billing.company.owner_only'))).toBeInTheDocument();
        // The Upgrade panel itself, not just its button.
        expect(screen.queryByText(message('billing.upgrade_panel.title'))).toBeNull();
        expect(screen.queryByText(message('billing.upgrade_panel.body'))).toBeNull();
    });

    it('a foreman is never shown the owner\'s suspended banner, even if the body carries seats', () => {
        state.billing = { ...base, role: 'foreman', seats: { used: 0, limit: 0, suspended: 2 } };
        renderIntl(<EmployerBillingPage />);
        expect(screen.queryByText(message('billing.company.suspended_title'))).toBeNull();
        expect(screen.getByText(message('billing.company.owner_only'))).toBeInTheDocument();
    });

    it('the suspended banner uses the singular for one foreman', () => {
        state.billing = { ...base, role: 'owner', seats: { used: 0, limit: 0, suspended: 1 } };
        renderIntl(<EmployerBillingPage />);
        expect(screen.getByText(/1 foreman is suspended/)).toBeInTheDocument();
        expect(screen.queryByText(/foremen/)).toBeNull();
    });

    it('the owner keeps both actions and sees how many foremen a downgrade suspended', () => {
        state.billing = { ...base, role: 'owner', seats: { used: 0, limit: 0, suspended: 2 } };
        renderIntl(<EmployerBillingPage />);
        expect(screen.getByRole('button', { name: message('billing.actions.upgrade') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('billing.actions.manage') })).toBeInTheDocument();
        expect(screen.getByText(message('billing.company.suspended_title'))).toBeInTheDocument();
        expect(screen.getByText(/2 foremen are suspended/)).toBeInTheDocument();
        expect(screen.queryByText(message('billing.company.owner_only'))).toBeNull();
    });

    it('shows no suspended banner when nobody is suspended, and treats an API without a role as the owner', () => {
        renderIntl(<EmployerBillingPage />);
        expect(screen.queryByText(message('billing.company.suspended_title'))).toBeNull();
        expect(screen.getByRole('button', { name: message('billing.actions.upgrade') })).toBeInTheDocument();
    });
});
