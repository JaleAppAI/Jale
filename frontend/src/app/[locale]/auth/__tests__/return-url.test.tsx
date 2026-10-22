// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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

const { assignReturnPath, replace, push, claimReferral } = vi.hoisted(() => ({
    assignReturnPath: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
    claimReferral: vi.fn(),
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
    // A real anchor, so the language toggle's href can be read back. `locale`
    // is next-intl's own prop; it is surfaced as a data attribute rather than
    // passed to the DOM.
    Link: ({ children, href, locale, ...rest }: { children?: React.ReactNode; href: string; locale?: string }) => (
        <a href={href} data-locale={locale} {...rest}>{children}</a>
    ),
}));
vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: state.isAuthenticated,
        isLoading: state.isLoading,
        userType: state.userType,
        idToken: 'id-token',
    }),
}));
vi.mock('@/lib/api/worker', () => ({ claimReferral }));
vi.mock('@/lib/login-url', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/login-url')>()),
    assignReturnPath,
}));
// The forms themselves are out of scope here; a stub per door lets the tests
// below assert WHICH door rendered its form (or none at all).
vi.mock('@/components/auth/WorkerAuthForm', () => ({
    default: () => <div data-testid="worker-form" />,
}));
vi.mock('@/components/auth/EmployerAuthForm', () => ({
    default: () => <div data-testid="employer-form" />,
    EmployerBrandPanel: () => null,
}));

import WorkerAuthPage from '@/app/[locale]/auth/worker/page';
import EmployerAuthPage from '@/app/[locale]/auth/employer/page';

const JOB_ID = '8f3a2c1d-4b5e-4f60-9a71-2c3d4e5f6071';

beforeEach(() => {
    vi.clearAllMocks();
    state.isAuthenticated = true;
    state.isLoading = false;
    state.userType = 'worker';
    state.params = '';
    sessionStorage.clear();
    // A real promise: the page chains `.catch` onto it.
    claimReferral.mockResolvedValue({ claimed: false, recorded: [] });
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

    it('shows the worker form when the only session is an employer one', () => {
        // Clicking "worker login" with an employer signed in must offer the
        // worker sign-in, not bounce to the employer dashboard: both roles are
        // meant to coexist in one browser.
        state.userType = 'employer';

        render(<WorkerAuthPage />);

        expect(screen.getByTestId('worker-form')).toBeInTheDocument();
        expect(replace).not.toHaveBeenCalled();
        expect(assignReturnPath).not.toHaveBeenCalled();
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

    // The page is the ONE place that lands a fresh sign-in (the form makes no
    // navigation of its own): signed out, then signed in, is exactly one move.
    it('lands a fresh sign-in on the dashboard exactly once', () => {
        state.isAuthenticated = false;
        state.userType = null;
        const { rerender } = render(<EmployerAuthPage />);
        expect(screen.getByTestId('employer-form')).toBeInTheDocument();

        state.isAuthenticated = true;
        state.userType = 'employer';
        rerender(<EmployerAuthPage />);

        expect(replace).toHaveBeenCalledTimes(1);
        expect(replace).toHaveBeenCalledWith('/employer/dashboard');
        expect(push).not.toHaveBeenCalled();
        expect(assignReturnPath).not.toHaveBeenCalled();
    });

    it('lands a fresh sign-in on the return path instead, once', () => {
        state.isAuthenticated = false;
        state.userType = null;
        state.params = 'returnUrl=%2Fen%2Femployer%2Fconversations';
        const { rerender } = render(<EmployerAuthPage />);

        state.isAuthenticated = true;
        state.userType = 'employer';
        rerender(<EmployerAuthPage />);

        expect(assignReturnPath).toHaveBeenCalledTimes(1);
        expect(assignReturnPath).toHaveBeenCalledWith('/en/employer/conversations');
        expect(replace).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
    });

    it('refuses an off-origin return path', () => {
        state.userType = 'employer';
        state.params = 'returnUrl=%2F%2Fevil.com%2Fes%2Femployer%2Fdashboard';

        render(<EmployerAuthPage />);

        expect(assignReturnPath).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith('/employer/dashboard');
    });

    it('shows the employer form when the only session is a worker one', () => {
        // The reported bug: a worker signed in, "employer login" clicked, and
        // the page bounced to /worker/home instead of offering the employer
        // sign-in.
        state.userType = 'worker';

        render(<EmployerAuthPage />);

        expect(screen.getByTestId('employer-form')).toBeInTheDocument();
        expect(replace).not.toHaveBeenCalled();
        expect(assignReturnPath).not.toHaveBeenCalled();
    });
});

/**
 * "A signed-in worker opening a job link" is one of the doors that fills
 * the referred-jobs list. That worker never mounts `WorkerAuthForm`, so this
 * page's effect is the only place that can tell the server -- and it used to
 * do so only when the link carried a share code.
 */
describe('worker auth page — a signed-in worker opening a job link', () => {
    it('records the job even when the link has no share code', () => {
        state.params = `job=${JOB_ID}`;

        render(<WorkerAuthPage />);

        expect(claimReferral).toHaveBeenCalledWith('id-token', { jobId: JOB_ID, shareCode: null });
        expect(replace).toHaveBeenCalledWith(`/worker/jobs/${JOB_ID}`);
    });

    it('sends the share code the way the backend will read it', () => {
        state.params = `job=${JOB_ID}&share=jale-7k3m-9qx2`;

        render(<WorkerAuthPage />);

        expect(claimReferral).toHaveBeenCalledWith('id-token', { jobId: JOB_ID, shareCode: '7K3M9QX2' });
    });

    it('records nothing for a visit that names no job and no code', () => {
        state.params = 'returnUrl=%2Fes%2Fworker%2Fhome';

        render(<WorkerAuthPage />);

        expect(claimReferral).not.toHaveBeenCalled();
        expect(assignReturnPath).toHaveBeenCalledWith('/es/worker/home');
    });

    it('stands down while the form is finishing its own sign-in', () => {
        // The form owns the claim and the redirect for a sign-in it is in the
        // middle of; doing either here would do them twice.
        sessionStorage.setItem('authFlowCompleting', '1');
        state.params = `job=${JOB_ID}`;

        render(<WorkerAuthPage />);

        expect(claimReferral).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });
});

/**
 * The toggle used to link to the bare path, so switching language dropped
 * `job`, `share`, `step` and `returnUrl` -- and with them the stash, the
 * sign-up step and the way back. `lib/locale-switch.ts` is the rule the public
 * job page's toggle already follows.
 */
describe('auth shell — the language toggle', () => {
    it('keeps the whole query string when it switches language', () => {
        state.isAuthenticated = false;
        state.userType = null;
        state.params = `step=signup&job=${JOB_ID}&share=7K3M9QX2&returnUrl=%2Fes%2Fworker%2Fhome`;

        render(<WorkerAuthPage />);

        const toggle = screen.getByRole('link', { name: 'language_toggle' });
        expect(toggle).toHaveAttribute(
            'href',
            `/auth/worker?step=signup&job=${JOB_ID}&share=7K3M9QX2&returnUrl=%2Fes%2Fworker%2Fhome`,
        );
        // `useLocale` says `es` here, so the toggle offers English.
        expect(toggle).toHaveAttribute('data-locale', 'en');
    });

    it('links to the bare path when there is no query to keep', () => {
        state.isAuthenticated = false;
        state.userType = null;

        render(<WorkerAuthPage />);

        expect(screen.getByRole('link', { name: 'language_toggle' })).toHaveAttribute('href', '/auth/worker');
    });

    it('keeps the query on the employer door too', () => {
        state.isAuthenticated = false;
        state.userType = null;
        state.params = 'returnUrl=%2Fes%2Femployer%2Fdashboard';

        render(<EmployerAuthPage />);

        // The employer variant draws the shell actions twice (desktop aside and
        // phone band); both must carry it.
        for (const toggle of screen.getAllByRole('link', { name: 'language_toggle' })) {
            expect(toggle).toHaveAttribute('href', '/auth/worker?returnUrl=%2Fes%2Femployer%2Fdashboard');
        }
    });
});
