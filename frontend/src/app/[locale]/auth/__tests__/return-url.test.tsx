// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

/**
 * The other end of the `?returnUrl=` round trip that `useRequireAuth` now
 * starts: once the visitor is signed in, each auth page has to actually GO
 * there, rather than dropping them on the default home page it would pick for
 * a plain visit.
 *
 * Both pages are covered because they are separate components with separate
 * effects, and the employer one was the likelier to drift — the worker page has
 * referral params to handle first, so its `returnUrl` branch sits behind two
 * earlier returns.
 *
 * `assignReturnPath` is mocked because `window.location.assign` cannot be
 * spied: jsdom marks it non-configurable, which is exactly why that one-line
 * seam exists in `@/lib/login-url`.
 */

const state = {
    isAuthenticated: true,
    isLoading: false,
    userType: 'worker' as 'worker' | 'employer' | null,
    params: '',
};

const { assignReturnPath, replace, push } = vi.hoisted(() => ({
    assignReturnPath: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
}));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'es',
}));
vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(state.params),
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ replace, push }),
    usePathname: () => '/auth/worker',
    Link: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: state.isAuthenticated,
        isLoading: state.isLoading,
        userType: state.userType,
        idToken: 'id-token',
    }),
}));
vi.mock('@/lib/api/worker', () => ({ claimReferral: vi.fn() }));
vi.mock('@/lib/login-url', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/login-url')>()),
    assignReturnPath,
}));

import WorkerAuthPage from '@/app/[locale]/auth/worker/page';
import EmployerAuthPage from '@/app/[locale]/auth/employer/page';

beforeEach(() => {
    vi.clearAllMocks();
    state.isAuthenticated = true;
    state.isLoading = false;
    state.userType = 'worker';
    state.params = '';
    sessionStorage.clear();
});

describe('worker auth page', () => {
    it('goes to the return path once the worker is signed in', () => {
        state.params = 'returnUrl=%2Fes%2Fworker%2Fjobs%2Fabc%3Fref%3Dwa';

        render(<WorkerAuthPage />);

        // Assigned, not routed: the path already carries its locale, so
        // next-intl's router would prefix a second one.
        expect(assignReturnPath).toHaveBeenCalledWith('/es/worker/jobs/abc?ref=wa');
        expect(replace).not.toHaveBeenCalled();
    });

    it('falls back to the worker home when there is no return path', () => {
        render(<WorkerAuthPage />);

        expect(assignReturnPath).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith('/worker/home');
    });

    it('refuses an off-origin return path', () => {
        state.params = 'returnUrl=https%3A%2F%2Fevil.com%2Fen%2Fworker%2Fhome';

        render(<WorkerAuthPage />);

        // `sanitizeReturnPath` is the real implementation here, so this pins
        // that the page actually runs it on the way in.
        expect(assignReturnPath).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith('/worker/home');
    });

    it('does nothing at all while the session is still loading', () => {
        state.isLoading = true;
        state.params = 'returnUrl=%2Fes%2Fworker%2Fhome';

        render(<WorkerAuthPage />);

        expect(assignReturnPath).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });
});

describe('employer auth page', () => {
    it('goes to the return path once the employer is signed in', () => {
        state.userType = 'employer';
        state.params = 'returnUrl=%2Fes%2Femployer%2Fjobs%2F1%3Ftab%3Dcandidates';

        render(<EmployerAuthPage />);

        expect(assignReturnPath).toHaveBeenCalledWith('/es/employer/jobs/1?tab=candidates');
        expect(replace).not.toHaveBeenCalled();
    });

    it('falls back to the dashboard when there is no return path', () => {
        state.userType = 'employer';

        render(<EmployerAuthPage />);

        expect(assignReturnPath).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith('/employer/dashboard');
    });

    it('refuses an off-origin return path', () => {
        state.userType = 'employer';
        state.params = 'returnUrl=%2F%2Fevil.com%2Fes%2Femployer%2Fdashboard';

        render(<EmployerAuthPage />);

        expect(assignReturnPath).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith('/employer/dashboard');
    });
});
