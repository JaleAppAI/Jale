// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

/*
 * The unread badge, on the two nav surfaces that carry it.
 *
 * Sprint 26 (B3). "Messages" was a link like any other, so the only way to
 * discover that a worker had replied was to open the page and look. The badge
 * is what makes the count visible from wherever the employer already is.
 *
 * Both components take the count as a PROP -- `AppShell` reads it from
 * `UnreadMessagesContext` once and hands it down, exactly as it already does
 * with the sidebar profile chip -- which is what lets this suite assert the
 * three interesting counts without standing up a session.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    usePathname: () => '/employer/dashboard',
}));

import { interpolate, message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { Sidebar } from '../Sidebar';
import { BottomTabBar } from '../BottomTabBar';

const chip = { status: 'loaded', name: 'RM Construction', meta: 'Austin', initials: 'RC' } as const;

function unreadLabel(count: number): string {
    // The catalogue entry is an ICU plural; `interpolate` only does `{name}`,
    // so the two forms are spelled out here rather than half-substituted.
    const raw = message('employer_dashboard.nav.unread_badge');
    const form = count === 1 ? /one \{([^}]*)\}/ : /other \{([^}]*)\}/;
    const body = raw.match(form)?.[1] ?? '';
    return interpolate(body.replace(/#/g, '{count}'), { count });
}

describe('the sidebar Messages badge', () => {
    it('renders no pill at all when nothing is unread', () => {
        renderIntl(<Sidebar role="employer" homeHref="/employer/dashboard" chip={chip} unreadCount={0} />);

        // Not a "0" pill: an employer with nothing waiting should see a plain
        // nav item, and a zero badge reads as a badge.
        expect(screen.queryByText('0')).not.toBeInTheDocument();
        expect(screen.queryByText(unreadLabel(0))).not.toBeInTheDocument();
    });

    it('shows the count next to the label, and names it for a screen reader', () => {
        renderIntl(<Sidebar role="employer" homeHref="/employer/dashboard" chip={chip} unreadCount={3} />);

        expect(screen.getByText('3')).toBeInTheDocument();
        expect(screen.getByText(unreadLabel(3))).toBeInTheDocument();
    });

    it('caps the printed count at 99+ while still announcing the true number', () => {
        renderIntl(<Sidebar role="employer" homeHref="/employer/dashboard" chip={chip} unreadCount={120} />);

        expect(screen.getByText('99+')).toBeInTheDocument();
        // "99+ unread messages" would be a second, worse lie on top of the
        // display cap -- the cap is a width constraint, not a fact.
        expect(screen.getByText(unreadLabel(120))).toBeInTheDocument();
    });

    it('puts the badge on Messages and nowhere else', () => {
        renderIntl(<Sidebar role="employer" homeHref="/employer/dashboard" chip={chip} unreadCount={3} />);

        const messagesLink = screen.getByRole('link', {
            name: new RegExp(message('employer_dashboard.nav.messages')),
        });
        expect(messagesLink.textContent).toContain('3');
        const applicants = screen.getByRole('link', {
            name: new RegExp(message('employer_dashboard.nav.applicants')),
        });
        expect(applicants.textContent).not.toContain('3');
    });

    it('never badges a worker rail', () => {
        renderIntl(<Sidebar role="worker" homeHref="/worker/home" chip={chip} unreadCount={3} />);

        expect(screen.queryByText('3')).not.toBeInTheDocument();
    });
});

describe('the mobile Messages tab badge', () => {
    it('shows the count on the messages tab only', () => {
        renderIntl(<BottomTabBar role="employer" unreadCount={2} />);

        expect(screen.getByText('2')).toBeInTheDocument();
        expect(screen.getByText(unreadLabel(2))).toBeInTheDocument();
    });

    it('renders nothing when the inbox is clear', () => {
        renderIntl(<BottomTabBar role="employer" unreadCount={0} />);

        expect(screen.queryByText('0')).not.toBeInTheDocument();
    });

    it('caps at 99+ like the sidebar', () => {
        renderIntl(<BottomTabBar role="employer" unreadCount={100} />);

        expect(screen.getByText('99+')).toBeInTheDocument();
    });
});
