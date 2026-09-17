// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

/*
 * The hero is an introduction. An introduction is worth a screenful once and is
 * furniture every time after -- and this one was pushing the job list, the
 * reason a returning employer opens the page, a third of the way down the
 * viewport on every single visit.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

/** Mutable: two employers sharing one browser is the case under test. */
const authState = { idToken: null as string | null };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authState }));

// The button is the post-a-job context's, tested with that context.
vi.mock('@/components/employer/PostJobButton', () => ({
    PostJobButton: ({ children }: { children?: ReactNode }) => (
        <button type="button">{children ?? 'Post Job'}</button>
    ),
}));

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { DashboardHero } from '../DashboardHero';

const SEEN_KEY = 'jale.employer.hero_seen';
const FIRST = 'employer-one';
const SECOND = 'employer-two';
const seenKeyFor = (account: string) => `${SEEN_KEY}.${account}`;

/** A token whose payload carries `sub` -- the only claim the key derives from. */
function idTokenFor(sub: string): string {
    const body = btoa(JSON.stringify({ sub }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return `header.${body}.signature`;
}

beforeEach(() => {
    localStorage.clear();
    authState.idToken = idTokenFor(FIRST);
});

describe('dashboard hero', () => {
    it('introduces the board in full on the first visit', () => {
        renderIntl(<DashboardHero />);

        expect(screen.getByText(message('employer_dashboard.hero.title'))).toBeInTheDocument();
        expect(screen.getByText(message('employer_dashboard.hero.body'))).toBeInTheDocument();
        // Written by the render that showed it: seeing it once is what "seen"
        // means, so a visit that never returns still counts.
        // Against THIS account, never against the browser.
        expect(localStorage.getItem(seenKeyFor(FIRST))).toBe('1');
        expect(localStorage.getItem(SEEN_KEY)).toBeNull();
    });

    it('collapses to a one-line bar on later visits', () => {
        localStorage.setItem(seenKeyFor(FIRST), '1');
        renderIntl(<DashboardHero />);

        expect(screen.queryByText(message('employer_dashboard.hero.title'))).not.toBeInTheDocument();
        expect(screen.getByText(message('employer_dashboard.hero.slim_title'))).toBeInTheDocument();
        // The one control worth keeping survives the collapse.
        expect(screen.getByRole('button', { name: 'Post Job' })).toBeInTheDocument();
    });

    it('collapses on demand without waiting for the next visit', () => {
        renderIntl(<DashboardHero />);

        fireEvent.click(
            screen.getByRole('button', { name: message('employer_dashboard.hero.dismiss_aria') }),
        );

        expect(screen.queryByText(message('employer_dashboard.hero.title'))).not.toBeInTheDocument();
        expect(screen.getByText(message('employer_dashboard.hero.slim_title'))).toBeInTheDocument();
    });

    it('introduces the board to the colleague sharing the laptop', () => {
        // The first employer has read it and collapsed their hero.
        renderIntl(<DashboardHero />);
        expect(localStorage.getItem(seenKeyFor(FIRST))).toBe('1');
        cleanup();

        // A different account signs in on the same browser. Storage is per
        // browser, so without the account in the key this employer would never
        // be introduced to their own board.
        authState.idToken = idTokenFor(SECOND);
        renderIntl(<DashboardHero />);

        expect(screen.getByText(message('employer_dashboard.hero.title'))).toBeInTheDocument();
    });

    it('shows the full hero, and remembers nothing, with no session to attribute it to', () => {
        // The restore window on a reload: no token, so no account, so the flag
        // has nobody to belong to. An extra showing of an introduction is the
        // right side to fail on; writing an unscoped one is not.
        authState.idToken = null;
        renderIntl(<DashboardHero />);

        expect(screen.getByText(message('employer_dashboard.hero.title'))).toBeInTheDocument();
        expect(localStorage.getItem(SEEN_KEY)).toBeNull();
        expect(localStorage.length).toBe(0);
    });

    it('shows the full hero when storage cannot be read at all', () => {
        const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });

        renderIntl(<DashboardHero />);

        expect(screen.getByText(message('employer_dashboard.hero.title'))).toBeInTheDocument();
        getItem.mockRestore();
        setItem.mockRestore();
    });
});
