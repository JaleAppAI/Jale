// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

/**
 * The sign-in redirect used to throw away where the user was going.
 *
 * A worker taps a job link in WhatsApp, the tab has no session yet, this hook
 * bounces them to `/es/auth/worker` — and after signing in they land on their
 * home page with no idea what the link was for. `buildLoginUrl` and both auth
 * pages already spoke `?returnUrl=`; only the session-expiry path in
 * `AuthContext` was passing it. This is the other half.
 *
 * Two details are load-bearing and are what these tests pin:
 *   - the return path comes from `window.location`, not from next-intl's
 *     `usePathname`, because that one STRIPS the locale — a return URL without
 *     it sends a Spanish-speaking worker back into the English tree;
 *   - the login URL therefore already carries the locale, so it is handed to
 *     Next's own router. next-intl's router would prefix a second one
 *     (`/es/es/auth/worker`).
 */

const state = {
    isAuthenticated: false,
    isLoading: false,
    userType: null as 'worker' | 'employer' | null,
    pathname: '/worker/jobs/abc',
    locale: 'es',
};

const { replace, i18nReplace } = vi.hoisted(() => ({
    replace: vi.fn(),
    i18nReplace: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ replace: i18nReplace }),
    usePathname: () => state.pathname,
}));
vi.mock('next-intl', () => ({ useLocale: () => state.locale }));
vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: state.isAuthenticated,
        isLoading: state.isLoading,
        userType: state.userType,
    }),
}));
vi.mock('@/lib/api', () => ({ isLegalWallError: () => false }));

import { useRequireAuth } from '@/hooks/useRequireAuth';

function Probe({ enabled }: { enabled?: boolean }) {
    useRequireAuth(enabled === undefined ? undefined : { enabled });
    return null;
}

beforeEach(() => {
    vi.clearAllMocks();
    state.isAuthenticated = false;
    state.isLoading = false;
    state.userType = null;
    state.pathname = '/worker/jobs/abc';
    state.locale = 'es';
    window.history.replaceState(null, '', '/');
});

describe('useRequireAuth', () => {
    it('sends an anonymous visitor to login with the page they wanted', () => {
        window.history.replaceState(null, '', '/es/worker/jobs/abc?ref=wa');

        render(<Probe />);

        // The locale-prefixed path AND its query, encoded once.
        expect(replace).toHaveBeenCalledWith(
            '/es/auth/worker?returnUrl=%2Fes%2Fworker%2Fjobs%2Fabc%3Fref%3Dwa',
        );
        // Never through the locale-prefixing router: that would produce
        // /es/es/auth/worker and 404.
        expect(i18nReplace).not.toHaveBeenCalled();
    });

    it('keeps the employer door for an employer path', () => {
        state.pathname = '/employer/jobs/1';
        state.locale = 'en';
        window.history.replaceState(null, '', '/en/employer/jobs/1');

        render(<Probe />);

        expect(replace).toHaveBeenCalledWith('/en/auth/employer?returnUrl=%2Fen%2Femployer%2Fjobs%2F1');
    });

    it('carries a bare path with no query', () => {
        state.pathname = '/worker/home';
        window.history.replaceState(null, '', '/en/worker/home');
        state.locale = 'en';

        render(<Probe />);

        expect(replace).toHaveBeenCalledWith('/en/auth/worker?returnUrl=%2Fen%2Fworker%2Fhome');
    });

    it('does not redirect while the session is still being restored', () => {
        state.isLoading = true;

        render(<Probe />);

        // The whole WhatsApp case is a tab that has a session it has not read
        // yet; redirecting here would log that user out on arrival.
        expect(replace).not.toHaveBeenCalled();
    });

    it('does not redirect an authenticated visitor', () => {
        state.isAuthenticated = true;

        render(<Probe />);

        expect(replace).not.toHaveBeenCalled();
    });

    it('does not redirect when the gate is disabled', () => {
        render(<Probe enabled={false} />);

        expect(replace).not.toHaveBeenCalled();
    });
});
