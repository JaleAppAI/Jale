// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import type { EmployerBilling } from '@/lib/api/employer';

/**
 * Phase 3 (Task 14): the owner's foreman seats, counting live invites (each
 * holds a seat), and the Pro owner's suspended banner, whose remedy is
 * removing members -- there is no bigger plan to change to. Same stubs as
 * company-role.test.tsx.
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
    subscription: null,
    display_price_minor: 2000,
    currency: 'usd',
    billing_interval: 'month',
    role: 'owner',
};

const pro: EmployerBilling = {
    ...base,
    planCode: 'employer_pro',
    activeJobLimit: 10,
    subscription: {
        plan_code: 'employer_pro',
        status: 'active',
        current_period_start: null,
        current_period_end: null,
        cancel_at_period_end: false,
        grace_ends_at: null,
    },
};

describe('employer billing page: Phase 3 seats and the Pro remedy', () => {
    beforeEach(() => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
        state.billing = base;
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('owner seats line counts pending invites', () => {
        state.billing = { ...pro, seats: { used: 1, limit: 3, suspended: 0, pending: 1 } };
        renderIntl(<EmployerBillingPage />);
        expect(screen.getByText('Foreman seats: 2 of 3 used')).toBeInTheDocument();
        expect(screen.getByText('1 pending invite')).toBeInTheDocument();
    });

    it('owner seats line without pending invites names none, and an API without `pending` counts 0', () => {
        state.billing = { ...pro, seats: { used: 2, limit: 3, suspended: 0 } };
        renderIntl(<EmployerBillingPage />);
        expect(screen.getByText('Foreman seats: 2 of 3 used')).toBeInTheDocument();
        expect(screen.queryByText(/pending invite/)).toBeNull();
    });

    it('in Spanish too', () => {
        state.billing = { ...pro, seats: { used: 1, limit: 3, suspended: 0, pending: 2 } };
        renderIntl(<EmployerBillingPage />, 'es');
        expect(screen.getByText('Puestos de capataz: 3 de 3 en uso')).toBeInTheDocument();
        expect(screen.getByText('2 invitaciones pendientes')).toBeInTheDocument();
    });

    it('a plan with no seats and nobody on them states no "0 of 0"', () => {
        state.billing = { ...base, seats: { used: 0, limit: 0, suspended: 0, pending: 0 } };
        renderIntl(<EmployerBillingPage />);
        expect(screen.queryByText(/Foreman seats/)).toBeNull();
    });

    it('a foreman gets no seats line (seats is null for them)', () => {
        state.billing = { ...pro, role: 'foreman', seats: null };
        renderIntl(<EmployerBillingPage />);
        expect(screen.queryByText(/Foreman seats/)).toBeNull();
        expect(screen.getByText(message('billing.company.owner_only'))).toBeInTheDocument();
    });

    it('Pro owner suspended banner uses suspended_body_pro', () => {
        state.billing = { ...pro, seats: { used: 3, limit: 3, suspended: 2, pending: 0 } };
        renderIntl(<EmployerBillingPage />);
        expect(screen.getByText(message('billing.company.suspended_title'))).toBeInTheDocument();
        expect(screen.getByText(/2 foremen are suspended and can't use your company's account because every seat is taken/)).toBeInTheDocument();
        expect(screen.getByText(/Remove them on the Team page/)).toBeInTheDocument();
        expect(screen.queryByText(/Change your plan/)).toBeNull();
    });

    it('a Free owner\'s suspended banner still says to change the plan', () => {
        state.billing = { ...base, seats: { used: 0, limit: 0, suspended: 1, pending: 0 } };
        renderIntl(<EmployerBillingPage />);
        expect(screen.getByText(/Change your plan to bring them back/)).toBeInTheDocument();
    });

    it('flag off: exactly Phase 2 -- no seats line, and the Pro banner keeps suspended_body', () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        state.billing = { ...pro, seats: { used: 1, limit: 3, suspended: 2, pending: 1 } };
        renderIntl(<EmployerBillingPage />);
        expect(screen.queryByText(/Foreman seats/)).toBeNull();
        expect(screen.queryByText(/pending invite/)).toBeNull();
        expect(screen.getByText(/Change your plan to bring them back/)).toBeInTheDocument();
        expect(screen.queryByText(/Remove them on the Team page/)).toBeNull();
    });
});
