// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { ApiError } from '@/lib/api/errors';
import { MembershipBlockedError } from '@/lib/api';

/*
 * Phase 3 role-based navigation (Task 14).
 *
 * The REAL `useEmployerMembership` runs here, against mocked network calls, so
 * these tests pin the whole path from "what the membership call answered" to
 * "which links the rail and the tab bar draw" -- including the one the plan's
 * review singled out: with the flag off, nothing is asked at all.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    usePathname: () => nav.pathname,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

/** The page the rail is drawn on; one test moves it. */
const nav = vi.hoisted(() => ({ pathname: '/employer/dashboard' }));

const { getMembership, getBilling, handleLegalWall } = vi.hoisted(() => ({
    getMembership: vi.fn(),
    getBilling: vi.fn(),
    handleLegalWall: vi.fn(),
}));

vi.mock('@/lib/api/team', () => ({ getMembership }));
vi.mock('@/lib/api/employer', () => ({ getBilling }));
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({ idToken: 'tok', handleLegalWall }),
}));
vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'tok', sessionCleared: { epoch: 0, role: null } }),
}));

import { renderIntl } from '@/components/employer/__tests__/render-intl';
import { clearEmployerMembershipCache, useEmployerMembership } from '@/hooks/useEmployerMembership';
import { Sidebar } from '../Sidebar';
import { BottomTabBar } from '../BottomTabBar';

const CHIP = { status: 'loaded', name: 'Acme', meta: null, initials: 'A' } as const;

/**
 * Prints the shared membership answer, so a test can wait for it to SETTLE
 * before asserting that something is absent -- an absence asserted while the
 * answer is still `loading` would pass for the wrong reason.
 */
function MembershipProbe() {
    return <output data-testid="membership-status">{useEmployerMembership().status}</output>;
}

function renderNav() {
    return renderIntl(
        <>
            <Sidebar role="employer" homeHref="/employer/dashboard" chip={CHIP} />
            <BottomTabBar role="employer" />
            <MembershipProbe />
        </>,
    );
}

/** Waits until the membership answer is `status` (`ready` or `error`). */
async function settled(status: 'ready' | 'error') {
    await waitFor(() => expect(screen.getByTestId('membership-status')).toHaveTextContent(status));
    await flush();
}

function sidebarKeys(container: HTMLElement): string[] {
    const aside = container.querySelector('aside');
    return Array.from(aside?.querySelectorAll('[data-nav-key]') ?? []).map(
        (node) => node.getAttribute('data-nav-key') ?? '',
    );
}

function tabKeys(container: HTMLElement): string[] {
    const bar = container.querySelector('nav[aria-label] ul');
    return Array.from(bar?.querySelectorAll('[data-nav-key]') ?? []).map(
        (node) => node.getAttribute('data-nav-key') ?? '',
    );
}

const PHASE_2_SIDEBAR = ['dashboard', 'messages', 'applicants', 'templates', 'billing', 'settings'];
const PHASE_2_TABS = ['dashboard', 'messages', 'applicants', 'settings'];

function member(role: 'owner' | 'foreman') {
    return { userId: 'u1', organizationId: 'o1', role, companyName: 'Acme' };
}

async function flush() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    clearEmployerMembershipCache();
    nav.pathname = '/employer/dashboard';
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('role-based employer navigation', () => {
    it('flag off: Phase 2 nav and no membership call, even when the membership call would fail', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        getMembership.mockRejectedValue(new Error('must not be called'));
        getBilling.mockRejectedValue(new Error('must not be called'));

        const { container } = renderNav();
        await flush();

        expect(sidebarKeys(container)).toEqual(PHASE_2_SIDEBAR);
        expect(tabKeys(container)).toEqual(PHASE_2_TABS);
        expect(getMembership).not.toHaveBeenCalled();
        expect(getBilling).not.toHaveBeenCalled();
    });

    it('a foreman sees no Billing and no Team', async () => {
        getMembership.mockResolvedValue(member('foreman'));

        const { container } = renderNav();

        await settled('ready');
        expect(sidebarKeys(container)).toEqual(['dashboard', 'messages', 'applicants', 'templates', 'settings']);
        expect(tabKeys(container)).toEqual(PHASE_2_TABS);
    });

    it('an owner sees Billing, and Team only with the flag on', async () => {
        getMembership.mockResolvedValue(member('owner'));

        const on = renderNav();
        await waitFor(() => expect(sidebarKeys(on.container)).toContain('team'));
        expect(sidebarKeys(on.container)).toEqual([
            'dashboard', 'messages', 'applicants', 'templates', 'team', 'billing', 'settings',
        ]);
        const team = on.container.querySelector('aside [data-nav-key="team"]');
        expect(team?.getAttribute('href')).toBe('/employer/team');
        expect(team?.textContent).toBe('Team');
        // Team never joins the four-tab mobile bar.
        expect(tabKeys(on.container)).toEqual(PHASE_2_TABS);
        on.unmount();

        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        const off = renderNav();
        await flush();
        expect(sidebarKeys(off.container)).toEqual(PHASE_2_SIDEBAR);
    });

    it('while membership loads, owner-only items are hidden', async () => {
        getMembership.mockImplementation(() => new Promise(() => {}));

        const { container } = renderNav();
        await flush();

        expect(sidebarKeys(container)).toEqual(['dashboard', 'messages', 'applicants', 'templates', 'settings']);
        expect(tabKeys(container)).toEqual(PHASE_2_TABS);
    });

    it('a blocked login (removed or suspended) is treated like loading: owner-only items stay hidden', async () => {
        getMembership.mockRejectedValue(new MembershipBlockedError('removed'));

        const { container } = renderNav();
        await waitFor(() => expect(handleLegalWall).toHaveBeenCalled());
        await flush();

        expect(sidebarKeys(container)).toEqual(['dashboard', 'messages', 'applicants', 'templates', 'settings']);
        // Never the billing fallback: a blocked login must not read as an owner.
        expect(getBilling).not.toHaveBeenCalled();
    });

    describe('flag on, membership error: Billing follows billing.role (foreman hides it; owner or unknown shows it)', () => {
        it('billing.role foreman hides Billing', async () => {
            getMembership.mockRejectedValue(new ApiError(500, 'internal_error'));
            getBilling.mockResolvedValue({ role: 'foreman' });

            const { container } = renderNav();
            await settled('error');

            expect(sidebarKeys(container)).toEqual(['dashboard', 'messages', 'applicants', 'templates', 'settings']);
        });

        it('billing.role owner shows Billing (and Team)', async () => {
            getMembership.mockRejectedValue(new ApiError(500, 'internal_error'));
            getBilling.mockResolvedValue({ role: 'owner' });

            const { container } = renderNav();
            await waitFor(() => expect(sidebarKeys(container)).toContain('billing'));
            expect(sidebarKeys(container)).toEqual([
                'dashboard', 'messages', 'applicants', 'templates', 'team', 'billing', 'settings',
            ]);
        });

        it('an unknown role (the billing read failed too) shows Billing: the server enforces', async () => {
            getMembership.mockRejectedValue(new ApiError(500, 'internal_error'));
            getBilling.mockRejectedValue(new ApiError(500, 'internal_error'));

            const { container } = renderNav();
            await waitFor(() => expect(sidebarKeys(container)).toContain('billing'));
        });
    });

    describe('active state', () => {
        it('marks Team active on the team page and Billing active on billing, one at a time', async () => {
            getMembership.mockResolvedValue(member('owner'));
            nav.pathname = '/employer/team';
            const team = renderNav();
            await settled('ready');
            const aside = () => team.container.querySelector('aside') as HTMLElement;
            expect(aside().querySelector('[data-nav-key="team"]')).toHaveAttribute('aria-current', 'page');
            expect(aside().querySelector('[data-nav-key="billing"]')).not.toHaveAttribute('aria-current');
            expect(aside().querySelectorAll('[aria-current="page"]')).toHaveLength(1);
            team.unmount();

            nav.pathname = '/employer/billing';
            const billing = renderNav();
            await settled('ready');
            const rail = billing.container.querySelector('aside') as HTMLElement;
            expect(rail.querySelector('[data-nav-key="billing"]')).toHaveAttribute('aria-current', 'page');
            expect(rail.querySelector('[data-nav-key="team"]')).not.toHaveAttribute('aria-current');
            expect(rail.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
        });
    });
});
