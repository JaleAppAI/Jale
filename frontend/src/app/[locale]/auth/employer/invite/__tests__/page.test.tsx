// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@/lib/api/errors';

/**
 * Phase 3 (Task 16): `/{locale}/auth/employer/invite?token=…`.
 *
 * The page reads the token, takes it out of the address bar, looks the invite
 * up, stores `{ token, email }` and renders the employer form in invite mode
 * (or the error copy). The real form is rendered; Cognito and the team API are
 * mocked.
 */

const { replace, push, setTokens, notFound, cognito, team } = vi.hoisted(() => ({
    replace: vi.fn(),
    push: vi.fn(),
    setTokens: vi.fn(),
    notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
    cognito: {
        employerSignIn: vi.fn(),
        employerSignUp: vi.fn(),
        employerConfirmSignUp: vi.fn(),
        employerResendConfirmationCode: vi.fn(),
        employerForgotPassword: vi.fn(),
        employerConfirmNewPassword: vi.fn(),
    },
    team: {
        lookupInvite: vi.fn(),
        acceptInvite: vi.fn(),
        getMembership: vi.fn(),
    },
}));

vi.mock('next/navigation', () => ({ notFound, useSearchParams: () => new URLSearchParams() }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ replace, push }),
    Link: ({ children, href }: { children?: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
const session = vi.hoisted(() => ({
    isAuthenticated: false,
    userType: null as 'worker' | 'employer' | null,
    getValidIdTokenOrNull: vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({
        setTokens,
        isAuthenticated: session.isAuthenticated,
        isLoading: false,
        userType: session.userType,
        getValidIdTokenOrNull: session.getValidIdTokenOrNull,
    }),
}));
vi.mock('@/lib/cognito', () => cognito);
vi.mock('@/lib/api/team', () => team);
vi.mock('@/lib/location-search', () => ({ queryLocations: vi.fn().mockResolvedValue([]) }));
// The shell's chrome (locale switch, report link) is not what this suite is about.
vi.mock('@/components/auth/AuthShell', () => ({
    AuthShell: ({ children }: { children: ReactNode }) => <div data-testid="shell">{children}</div>,
}));

import { interpolate, message, renderIntl } from '@/components/employer/__tests__/render-intl';
import EmployerInvitePage from '../page';
import { metadata } from '../layout';

const PATH = '/en/auth/employer/invite';

const LOOKUP_NEW = {
    companyName: 'Acme Builders',
    email: 'Ana@Example.com',
    contactName: 'Ana Ruiz',
    existingAccount: false,
    expiresAt: '2026-11-03T00:00:00.000Z',
};

function arriveAt(url: string) {
    window.history.replaceState(null, '', url);
}

beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of [...Object.values(cognito), ...Object.values(team)]) fn.mockReset();
    sessionStorage.clear();
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
    arriveAt('/');
    session.isAuthenticated = false;
    session.userType = null;
    session.getValidIdTokenOrNull.mockReset();
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    arriveAt('/');
});

describe('invite lookup failures', () => {
    it('unknown token: not_found copy; expired: the exact expired copy', async () => {
        arriveAt(`${PATH}?token=nope`);
        team.lookupInvite.mockRejectedValueOnce(new ApiError(404, 'invite_not_found'));
        const first = renderIntl(<EmployerInvitePage />);
        expect(await screen.findByText(message('auth.employer.invite.not_found'))).toBeInTheDocument();
        first.unmount();

        arriveAt(`${PATH}?token=old`);
        team.lookupInvite.mockRejectedValueOnce(new ApiError(410, 'invite_expired'));
        renderIntl(<EmployerInvitePage />);
        expect(await screen.findByText('Your invite expired, ask your company to resend it.')).toBeInTheDocument();
    });

    it.each([
        ['invite_revoked', 'auth.employer.invite.revoked'],
        ['invite_used', 'auth.employer.invite.used'],
    ])('410 %s shows its copy and clears the stored invite', async (code, key) => {
        sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 'tok', email: 'ana@example.com' }));
        arriveAt(`${PATH}?token=tok`);
        team.lookupInvite.mockRejectedValueOnce(new ApiError(410, code));
        renderIntl(<EmployerInvitePage />);

        expect(await screen.findByText(message(key))).toBeInTheDocument();
        expect(sessionStorage.getItem('pendingInvite')).toBeNull();
        // A way on: the ordinary sign-in.
        expect(screen.getByRole('link', { name: message('auth.employer.sign_in') })).toHaveAttribute('href', '/auth/employer');
    });

    it('a busy lookup shows the busy copy and keeps the stored invite for a retry', async () => {
        sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 'tok', email: 'ana@example.com' }));
        arriveAt(PATH);
        team.lookupInvite.mockRejectedValueOnce(new ApiError(503, 'busy'));
        renderIntl(<EmployerInvitePage />);

        expect(await screen.findByText(message('auth.employer.invite.busy'))).toBeInTheDocument();
        expect(sessionStorage.getItem('pendingInvite')).not.toBeNull();
    });

    it('no token at all: not_found copy, no lookup', async () => {
        arriveAt(PATH);
        renderIntl(<EmployerInvitePage />);

        expect(await screen.findByText(message('auth.employer.invite.not_found'))).toBeInTheDocument();
        expect(team.lookupInvite).not.toHaveBeenCalled();
    });
});

describe('the token in the address bar', () => {
    it('the token leaves the address bar (replaceState) and the layout sets referrer no-referrer', async () => {
        arriveAt(`${PATH}?token=secret-tok`);
        const replaceState = vi.spyOn(window.history, 'replaceState');
        team.lookupInvite.mockResolvedValueOnce(LOOKUP_NEW);
        renderIntl(<EmployerInvitePage />);

        await screen.findByText(interpolate(message('auth.employer.invite.title'), { companyName: 'Acme Builders' }));
        expect(replaceState).toHaveBeenCalledWith(null, '', PATH);
        expect(window.location.href).not.toContain('secret-tok');
        // The URL was cleaned before the lookup went out.
        expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(team.lookupInvite.mock.invocationCallOrder[0]);
        expect(team.lookupInvite).toHaveBeenCalledWith('secret-tok', expect.anything());
        expect(document.body.textContent).not.toContain('secret-tok');

        expect(metadata).toEqual({ referrer: 'no-referrer' });
    });

    it('a valid lookup stores { token, email } with the email normalised', async () => {
        arriveAt(`${PATH}?token=tok-1`);
        team.lookupInvite.mockResolvedValueOnce(LOOKUP_NEW);
        const { container } = renderIntl(<EmployerInvitePage />);

        await screen.findByText(interpolate(message('auth.employer.invite.title'), { companyName: 'Acme Builders' }));
        expect(JSON.parse(sessionStorage.getItem('pendingInvite') as string)).toEqual({ token: 'tok-1', email: 'ana@example.com' });
        const email = container.querySelector('input[type="email"]') as HTMLInputElement;
        expect(email).toHaveValue('ana@example.com');
        expect(email).toHaveAttribute('readonly');
        expect(screen.queryByText(message('auth.employer.fields.company_name'))).not.toBeInTheDocument();
    });

    it('a URL token replaces an older stored invite', async () => {
        sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 'old-tok', email: 'old@example.com' }));
        arriveAt(`${PATH}?token=new-tok`);
        team.lookupInvite.mockResolvedValueOnce(LOOKUP_NEW);
        renderIntl(<EmployerInvitePage />);

        await screen.findByText(interpolate(message('auth.employer.invite.title'), { companyName: 'Acme Builders' }));
        expect(team.lookupInvite).toHaveBeenCalledWith('new-tok', expect.anything());
        expect(JSON.parse(sessionStorage.getItem('pendingInvite') as string)).toEqual({ token: 'new-tok', email: 'ana@example.com' });
    });
});

describe('after a reload', () => {
    it('confirm sends the stored invite token as clientMetadata after a reload', async () => {
        // The address bar no longer has the token; only sessionStorage does.
        sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 'stored-tok', email: 'ana@example.com' }));
        arriveAt(PATH);
        team.lookupInvite.mockResolvedValueOnce(LOOKUP_NEW);
        const user = userEvent.setup();
        const { container } = renderIntl(<EmployerInvitePage />);

        await screen.findByText(interpolate(message('auth.employer.invite.title'), { companyName: 'Acme Builders' }));
        expect(team.lookupInvite).toHaveBeenCalledWith('stored-tok', expect.anything());

        const [pw, pwConfirm] = Array.from(container.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]'));
        await user.type(pw, 'S3cret!pass');
        await user.type(pwConfirm, 'S3cret!pass');
        await user.type(container.querySelector('input[type="tel"]') as HTMLInputElement, '2105550100');
        cognito.employerSignUp.mockResolvedValueOnce(undefined);
        await user.click(screen.getByRole('button', { name: new RegExp(`^${message('auth.employer.create_account')}`) }));

        const code = await waitFor(() => {
            const el = container.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]');
            if (!el) throw new Error('confirm step not reached');
            return el;
        });
        cognito.employerConfirmSignUp.mockResolvedValueOnce(undefined);
        cognito.employerSignIn.mockResolvedValueOnce({ accessToken: 'a', idToken: 'i', refreshToken: 'r' });
        await user.type(code, '123456');
        await user.click(screen.getByRole('button', { name: new RegExp(`^${message('auth.employer.confirm_account')}`) }));

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/dashboard'));
        expect(cognito.employerSignUp).toHaveBeenCalledWith(expect.objectContaining({ email: 'ana@example.com', contactName: 'Ana Ruiz' }), { invite: true });
        expect(cognito.employerConfirmSignUp).toHaveBeenCalledWith('ana@example.com', '123456', { inviteToken: 'stored-tok' });
        expect(sessionStorage.getItem('pendingInvite')).toBeNull();
    });
});

describe('an existing account', () => {
    it('shows sign-in-then-accept with the email locked', async () => {
        arriveAt(`${PATH}?token=tok-1`);
        team.lookupInvite.mockResolvedValueOnce({ ...LOOKUP_NEW, existingAccount: true });
        const { container } = renderIntl(<EmployerInvitePage />);

        expect(await screen.findByText(interpolate(message('auth.employer.invite.rejoin_body'), { companyName: 'Acme Builders', email: 'ana@example.com' }))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: new RegExp(`^${message('auth.employer.invite.rejoin_submit')}`) })).toBeInTheDocument();
        expect(container.querySelector('input[type="email"]')).toHaveAttribute('readonly');
    });
});

describe('an employer already signed in on this browser', () => {
    const JOIN = () => screen.getByRole('button', { name: new RegExp(`^${message('legal.accept_cta')}`) });
    const USE_ANOTHER = () => screen.getByRole('button', { name: message('auth.employer.signin_link') });

    beforeEach(() => {
        session.isAuthenticated = true;
        session.userType = 'employer';
        session.getValidIdTokenOrNull.mockResolvedValue('sess-id-tok');
        arriveAt(`${PATH}?token=tok-1`);
        sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 'tok-1', email: 'ana@example.com' }));
    });

    it('existing account: one click accepts with the current session, no sign-in and no setTokens', async () => {
        team.lookupInvite.mockResolvedValueOnce({ ...LOOKUP_NEW, existingAccount: true });
        team.acceptInvite.mockResolvedValueOnce({ outcome: 'rejoined', organizationId: 'org-1' });
        const user = userEvent.setup();
        renderIntl(<EmployerInvitePage />);

        await screen.findByText(interpolate(message('auth.employer.invite.title'), { companyName: 'Acme Builders' }));
        // No password field: this is not the sign-in form.
        expect(screen.queryByPlaceholderText(message('auth.employer.password_label'))).not.toBeInTheDocument();
        await user.click(JOIN());

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/dashboard'));
        expect(team.acceptInvite).toHaveBeenCalledWith('sess-id-tok', 'tok-1');
        expect(cognito.employerSignIn).not.toHaveBeenCalled();
        expect(setTokens).not.toHaveBeenCalled();
        expect(sessionStorage.getItem('pendingInvite')).toBeNull();
    });

    it('a different account: email_mismatch copy, and "use another account" shows the sign-in form', async () => {
        team.lookupInvite.mockResolvedValueOnce({ ...LOOKUP_NEW, existingAccount: true });
        team.acceptInvite.mockRejectedValueOnce(new ApiError(403, 'invite_email_mismatch'));
        const user = userEvent.setup();
        renderIntl(<EmployerInvitePage />);

        await screen.findByText(interpolate(message('auth.employer.invite.title'), { companyName: 'Acme Builders' }));
        await user.click(JOIN());

        expect(await screen.findByText(message('auth.employer.invite.email_mismatch'))).toBeInTheDocument();
        expect(replace).not.toHaveBeenCalled();
        expect(sessionStorage.getItem('pendingInvite')).not.toBeNull();

        await user.click(USE_ANOTHER());
        expect(screen.getByRole('button', { name: new RegExp(`^${message('auth.employer.invite.rejoin_submit')}`) })).toBeInTheDocument();
        expect(screen.getByPlaceholderText(message('auth.employer.password_label'))).toBeInTheDocument();
    });

    it('invite_used for a session login that may not be the invitee: the used copy, no redirect', async () => {
        team.lookupInvite.mockResolvedValueOnce({ ...LOOKUP_NEW, existingAccount: true });
        team.acceptInvite.mockRejectedValueOnce(new ApiError(410, 'invite_used'));
        const user = userEvent.setup();
        renderIntl(<EmployerInvitePage />);

        await screen.findByText(interpolate(message('auth.employer.invite.title'), { companyName: 'Acme Builders' }));
        await user.click(JOIN());

        expect(await screen.findByText(message('auth.employer.invite.used'))).toBeInTheDocument();
        expect(replace).not.toHaveBeenCalled();
    });

    it('a new-account invite still shows the sign-up form, signed in or not', async () => {
        team.lookupInvite.mockResolvedValueOnce(LOOKUP_NEW);
        renderIntl(<EmployerInvitePage />);

        expect(await screen.findByRole('button', { name: new RegExp(`^${message('auth.employer.create_account')}`) })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: new RegExp(`^${message('legal.accept_cta')}`) })).not.toBeInTheDocument();
    });
});

describe('flag off', () => {
    it('the invite page is not found, makes no request and leaves the address alone', () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        arriveAt(`${PATH}?token=tok-1`);
        const replaceState = vi.spyOn(window.history, 'replaceState');

        expect(() => renderIntl(<EmployerInvitePage />)).toThrow('NEXT_NOT_FOUND');
        expect(notFound).toHaveBeenCalled();
        expect(team.lookupInvite).not.toHaveBeenCalled();
        expect(sessionStorage.getItem('pendingInvite')).toBeNull();
        expect(replaceState).not.toHaveBeenCalled();
        expect(`${window.location.pathname}${window.location.search}`).toBe(`${PATH}?token=tok-1`);
    });
});
