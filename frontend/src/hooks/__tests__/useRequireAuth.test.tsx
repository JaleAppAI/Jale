// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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
    idToken: null as string | null,
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
        idToken: state.idToken,
    }),
}));
vi.mock('@/lib/api', () => ({ isLegalWallError: () => false }));

import { useRequireAuth } from '@/hooks/useRequireAuth';

function Probe({ enabled, role }: { enabled?: boolean; role?: 'worker' | 'employer' }) {
    const { idToken } = useRequireAuth(
        enabled === undefined && role === undefined ? undefined : { enabled, role },
    );
    return <span data-testid="token">{idToken ?? 'none'}</span>;
}

beforeEach(() => {
    vi.clearAllMocks();
    state.isAuthenticated = false;
    state.isLoading = false;
    state.userType = null;
    state.idToken = null;
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

/**
 * The other half of the two-sessions-in-one-browser problem.
 *
 * `AuthContext` keeps a slot per role and masks the one the current route is
 * not about; this hook is what every authenticated page actually asks. A page
 * that took `useAuth().idToken` directly would, on the render a worker ->
 * employer navigation lands on, fetch with the token it was leaving and get a
 * 401/403 until the visitor reloaded by hand. So the token a page is handed is
 * the one for ITS role, or none.
 */
describe('useRequireAuth — the route\'s role', () => {
    it('hands the page the token when the session is that role', () => {
        state.isAuthenticated = true;
        state.userType = 'worker';
        state.idToken = 'id-worker';
        state.pathname = '/worker/home';

        render(<Probe />);

        expect(screen.getByTestId('token')).toHaveTextContent('id-worker');
        expect(replace).not.toHaveBeenCalled();
    });

    it('withholds it, and goes to this role\'s door, when the session is the other role', () => {
        state.isAuthenticated = true;
        state.userType = 'employer';
        state.idToken = 'id-employer';
        state.pathname = '/worker/home';
        state.locale = 'en';
        window.history.replaceState(null, '', '/en/worker/home');

        render(<Probe />);

        // Never the employer's token on a worker page -- no request is worth
        // the 401 it would earn.
        expect(screen.getByTestId('token')).toHaveTextContent('none');
        // ...and the worker door, not the employer one the session belongs to.
        expect(replace).toHaveBeenCalledWith('/en/auth/worker?returnUrl=%2Fen%2Fworker%2Fhome');
    });

    it('lets a page name its own role rather than reading the path', () => {
        state.isAuthenticated = true;
        state.userType = 'worker';
        state.idToken = 'id-worker';
        // A path that names no role at all: only the page knows what it is.
        state.pathname = '/legal/accept';
        state.locale = 'en';
        window.history.replaceState(null, '', '/en/legal/accept');

        render(<Probe role="employer" />);

        expect(screen.getByTestId('token')).toHaveTextContent('none');
        expect(replace).toHaveBeenCalledWith('/en/auth/employer?returnUrl=%2Fen%2Flegal%2Faccept');
    });

    it('still waits while the session is being restored', () => {
        // The mid-navigation render: AuthContext has dropped the old role's
        // tokens and is fetching the new role's. Redirecting here would sign
        // out a visitor who is signed in.
        state.isLoading = true;
        state.userType = 'employer';
        state.pathname = '/worker/home';

        render(<Probe />);

        expect(replace).not.toHaveBeenCalled();
    });
});
