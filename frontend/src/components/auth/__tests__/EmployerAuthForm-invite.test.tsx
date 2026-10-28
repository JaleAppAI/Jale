// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LegalWallError, MembershipBlockedError } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';

/**
 * Phase 3 (Task 16): the employer auth form in invite mode, and the plain
 * employer page's handling of a stored invite (I4).
 *
 * Rendered through the real next-intl provider against the real catalogues
 * (`renderIntl`), so a copy key that does not exist fails here.
 */

const { replace, push, setTokens, cognito, team, clearCache } = vi.hoisted(() => ({
    replace: vi.fn(),
    push: vi.fn(),
    setTokens: vi.fn(),
    cognito: {
        employerSignIn: vi.fn(),
        employerSignUp: vi.fn(),
        employerConfirmSignUp: vi.fn(),
        employerResendConfirmationCode: vi.fn(),
        employerForgotPassword: vi.fn(),
        employerConfirmNewPassword: vi.fn(),
    },
    team: {
        acceptInvite: vi.fn(),
        getMembership: vi.fn(),
    },
    clearCache: vi.fn(),
}));

vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ replace, push }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ setTokens }) }));
vi.mock('@/lib/cognito', () => cognito);
vi.mock('@/lib/api/team', () => team);
vi.mock('@/lib/employer-membership-store', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/employer-membership-store')>()),
    clearEmployerMembershipCache: clearCache,
}));
vi.mock('@/lib/location-search', () => ({ queryLocations: vi.fn().mockResolvedValue([]) }));

import { interpolate, message, renderIntl } from '@/components/employer/__tests__/render-intl';
import EmployerAuthForm, { type EmployerInvite } from '@/components/auth/EmployerAuthForm';

const TOKENS = { accessToken: 'a', idToken: 'id-tok', refreshToken: 'r' };

const NEW_INVITE: EmployerInvite = {
    token: 'inv-tok-1',
    email: 'ana@example.com',
    companyName: 'Acme Builders',
    contactName: 'Ana Ruiz',
    existingAccount: false,
};
const REJOIN_INVITE: EmployerInvite = { ...NEW_INVITE, existingAccount: true };

function submit(name: string) {
    return screen.getByRole('button', { name: new RegExp(`^${name}`) });
}

function input(container: HTMLElement, selector: string): HTMLInputElement {
    const el = container.querySelector<HTMLInputElement>(selector);
    if (!el) throw new Error(`No input matches ${selector}`);
    return el;
}

beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of [...Object.values(cognito), ...Object.values(team)]) fn.mockReset();
    sessionStorage.clear();
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
});

afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
});

describe('invite mode, new account', () => {
    /** Fills what invite mode asks for (name is pre-filled) and creates the account. */
    async function signUp(user: ReturnType<typeof userEvent.setup>, container: HTMLElement) {
        const [pw, pwConfirm] = Array.from(container.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]'));
        await user.type(pw, 'S3cret!pass');
        await user.type(pwConfirm, 'S3cret!pass');
        await user.type(input(container, 'input[type="tel"]'), '2105550100');
        cognito.employerSignUp.mockResolvedValueOnce(undefined);
        await user.click(submit(message('auth.employer.create_account')));
        expect(await screen.findByText(message('auth.employer.signup_confirm_subtitle'))).toBeInTheDocument();
    }

    it('new account: email locked, company field hidden, confirm sends clientMetadata {inviteToken}', async () => {
        const user = userEvent.setup();
        sessionStorage.setItem('pendingInvite', JSON.stringify({ token: NEW_INVITE.token, email: NEW_INVITE.email }));
        const { container } = renderIntl(<EmployerAuthForm mode="invite" invite={NEW_INVITE} />);

        // Starts on sign-up, with the invite's own heading and copy.
        expect(screen.getByText(interpolate(message('auth.employer.invite.title'), { companyName: 'Acme Builders' }))).toBeInTheDocument();
        expect(screen.getByText(interpolate(message('auth.employer.invite.body'), { companyName: 'Acme Builders', email: 'ana@example.com' }))).toBeInTheDocument();
        const email = input(container, 'input[type="email"]');
        expect(email).toHaveValue('ana@example.com');
        expect(email).toHaveAttribute('readonly');
        expect(input(container, 'input[autocomplete="name"]')).toHaveValue('Ana Ruiz');
        // No company fields: a foreman joins the inviting company's.
        for (const field of ['company_name', 'city', 'service_area', 'hiring_trades', 'typical_job_types', 'company_size', 'company_description']) {
            expect(screen.queryByText(message(`auth.employer.fields.${field}`))).not.toBeInTheDocument();
        }

        await signUp(user, container);
        expect(cognito.employerSignUp).toHaveBeenCalledWith(
            { email: 'ana@example.com', password: 'S3cret!pass', companyName: '', contactName: 'Ana Ruiz', phone: '+12105550100' },
            { invite: true },
        );

        cognito.employerConfirmSignUp.mockResolvedValueOnce(undefined);
        cognito.employerSignIn.mockResolvedValueOnce(TOKENS);
        await user.type(input(container, 'input[autocomplete="one-time-code"]'), '123456');
        await user.click(submit(message('auth.employer.confirm_account')));

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/dashboard'));
        expect(cognito.employerConfirmSignUp).toHaveBeenCalledWith('ana@example.com', '123456', { inviteToken: 'inv-tok-1' });
        expect(setTokens).toHaveBeenCalledWith(TOKENS, 'employer');
        // Post-confirmation accepted by token; the stored token is spent.
        expect(sessionStorage.getItem('pendingInvite')).toBeNull();
        expect(clearCache).toHaveBeenCalled();
        // The pending-profile flush must not 403 for a foreman.
        expect(JSON.parse(sessionStorage.getItem('pendingEmployerProfile') as string)).toEqual({
            contact_name: 'Ana Ruiz',
            phone: '+12105550100',
        });
        expect(team.acceptInvite).not.toHaveBeenCalled();
    });

    it('asks only for the fields invite mode shows', async () => {
        const user = userEvent.setup();
        renderIntl(<EmployerAuthForm mode="invite" invite={{ ...NEW_INVITE, contactName: null }} />);

        await user.click(submit(message('auth.employer.create_account')));

        const summary = await screen.findByText(new RegExp(`^${message('auth.employer.errors.missing_summary').split('{')[0]}`));
        expect(summary.textContent).toContain(message('auth.employer.fields.contact_name'));
        expect(summary.textContent).not.toContain(message('auth.employer.fields.company_name'));
        expect(summary.textContent).not.toContain(message('auth.employer.fields.city'));
        expect(cognito.employerSignUp).not.toHaveBeenCalled();
    });

    it('does not record a signup source for an invite sign-up', () => {
        window.history.replaceState(null, '', '/en/auth/employer/invite?src=partner');
        renderIntl(<EmployerAuthForm mode="invite" invite={NEW_INVITE} />);
        expect(sessionStorage.getItem('jale.signup-source')).toBeNull();
        window.history.replaceState(null, '', '/');
    });
});

/** Signs in on the plain page with an unconfirmed account, which drops onto the recovery confirm step. */
async function plainRecoveryConfirm(user: ReturnType<typeof userEvent.setup>, container: HTMLElement, address: string) {
    cognito.employerSignIn.mockRejectedValueOnce({ code: 'UserNotConfirmedException', name: 'UserNotConfirmedException' });
    cognito.employerResendConfirmationCode.mockResolvedValueOnce(undefined);
    await user.type(input(container, 'input[type="email"]'), address);
    await user.type(screen.getByPlaceholderText(message('auth.employer.password_label')), 'S3cret!pass');
    await user.click(submit(message('auth.employer.sign_in')));
    expect(await screen.findByText(message('auth.employer.recovery_title'))).toBeInTheDocument();

    cognito.employerConfirmSignUp.mockResolvedValueOnce(undefined);
    cognito.employerSignIn.mockResolvedValueOnce(TOKENS);
    await user.type(input(container, 'input[autocomplete="one-time-code"]'), '123456');
    await user.click(submit(message('auth.employer.confirm_account')));
    await waitFor(() => expect(setTokens).toHaveBeenCalled());
}

describe('the plain employer page and a stored invite (I4)', () => {
    it('the plain employer page\'s confirm step forwards a stored token whose email matches', async () => {
        const user = userEvent.setup();
        sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 'inv-tok-1', email: 'ana@example.com' }));
        const { container } = renderIntl(<EmployerAuthForm />);

        // A different case than the stored one (jsdom trims an email input's value).
        await plainRecoveryConfirm(user, container, 'ANA@Example.com');

        expect(cognito.employerConfirmSignUp).toHaveBeenCalledWith('ANA@Example.com', '123456', { inviteToken: 'inv-tok-1' });
        expect(sessionStorage.getItem('pendingInvite')).toBeNull();
        // The plain page still lands the session itself.
        expect(replace).not.toHaveBeenCalled();
    });

    it('the plain page does not forward a stored token whose email differs', async () => {
        const user = userEvent.setup();
        const stored = JSON.stringify({ token: 'inv-tok-1', email: 'ana@example.com' });
        sessionStorage.setItem('pendingInvite', stored);
        const { container } = renderIntl(<EmployerAuthForm />);

        await plainRecoveryConfirm(user, container, 'owner@example.com');

        expect(cognito.employerConfirmSignUp).toHaveBeenCalledWith('owner@example.com', '123456');
        expect(cognito.employerConfirmSignUp.mock.calls[0]).toHaveLength(2);
        // Left alone: it belongs to another address.
        expect(sessionStorage.getItem('pendingInvite')).toBe(stored);
    });

    it('flag off: the plain page never forwards a stored token', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        const user = userEvent.setup();
        sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 'inv-tok-1', email: 'ana@example.com' }));
        const { container } = renderIntl(<EmployerAuthForm />);

        await plainRecoveryConfirm(user, container, 'ana@example.com');

        expect(cognito.employerConfirmSignUp.mock.calls[0]).toEqual(['ana@example.com', '123456']);
    });
});

describe('invite mode, existing account (rejoin)', () => {
    async function signInAndJoin(user: ReturnType<typeof userEvent.setup>, container: HTMLElement) {
        cognito.employerSignIn.mockResolvedValueOnce(TOKENS);
        await user.type(screen.getByPlaceholderText(message('auth.employer.password_label')), 'S3cret!pass');
        await user.click(submit(message('auth.employer.invite.rejoin_submit')));
        void container;
    }

    it('existing account: sign in then acceptInvite; success clears the store and routes to the dashboard', async () => {
        const user = userEvent.setup();
        sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 'inv-tok-1', email: 'ana@example.com' }));
        team.acceptInvite.mockResolvedValueOnce({ outcome: 'rejoined', organizationId: 'org-1' });
        const { container } = renderIntl(<EmployerAuthForm mode="invite" invite={REJOIN_INVITE} />);

        expect(screen.getByText(interpolate(message('auth.employer.invite.rejoin_body'), { companyName: 'Acme Builders', email: 'ana@example.com' }))).toBeInTheDocument();
        const email = input(container, 'input[type="email"]');
        expect(email).toHaveValue('ana@example.com');
        expect(email).toHaveAttribute('readonly');

        await signInAndJoin(user, container);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/dashboard'));
        expect(cognito.employerSignIn).toHaveBeenCalledWith('ana@example.com', 'S3cret!pass');
        expect(team.acceptInvite).toHaveBeenCalledWith('id-tok', 'inv-tok-1');
        expect(sessionStorage.getItem('pendingInvite')).toBeNull();
        expect(clearCache).toHaveBeenCalled();
        expect(setTokens).toHaveBeenCalledWith(TOKENS, 'employer');
        // Accept happens before the session is handed to the app.
        expect(team.acceptInvite.mock.invocationCallOrder[0]).toBeLessThan(setTokens.mock.invocationCallOrder[0]);
    });

    it.each([
        [403, 'invite_email_mismatch', 'auth.employer.invite.email_mismatch'],
        [409, 'already_member', 'auth.employer.invite.already_member'],
        [403, 'employer_required', 'auth.employer.invite.employer_required'],
    ])('email mismatch, already_member and employer_required show their copy (%s %s)', async (status, code, key) => {
        const user = userEvent.setup();
        sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 'inv-tok-1', email: 'ana@example.com' }));
        team.acceptInvite.mockRejectedValueOnce(new ApiError(status, code));
        team.getMembership.mockResolvedValue({ userId: 'u', organizationId: 'org-9', role: 'owner', companyName: 'Other Co' });
        const { container } = renderIntl(<EmployerAuthForm mode="invite" invite={REJOIN_INVITE} />);

        await signInAndJoin(user, container);

        expect(await screen.findByText(message(key))).toBeInTheDocument();
        expect(replace).not.toHaveBeenCalled();
        expect(setTokens).not.toHaveBeenCalled();
        // `already_member` means the invite is live and this login is another
        // company's: its copy, with no membership re-read and no redirect.
        expect(team.getMembership).not.toHaveBeenCalled();
        // The invite is still open: keep it for another try.
        expect(sessionStorage.getItem('pendingInvite')).not.toBeNull();
    });

    it.each([
        ['the inviting company', 'Acme Builders'],
        ['a company with another name', 'Other Co'],
    ])('invite_used with an active membership (%s) is this person\'s own accept: the dashboard', async (_label, companyName) => {
        const user = userEvent.setup();
        sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 'inv-tok-1', email: 'ana@example.com' }));
        team.acceptInvite.mockRejectedValueOnce(new ApiError(410, 'invite_used'));
        team.getMembership.mockResolvedValueOnce({ userId: 'u', organizationId: 'org-1', role: 'foreman', companyName });
        const { container } = renderIntl(<EmployerAuthForm mode="invite" invite={REJOIN_INVITE} />);

        await signInAndJoin(user, container);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/dashboard'));
        expect(team.getMembership).toHaveBeenCalledWith('id-tok');
        expect(sessionStorage.getItem('pendingInvite')).toBeNull();
        expect(clearCache).toHaveBeenCalled();
        expect(screen.queryByText(message('auth.employer.invite.used'))).not.toBeInTheDocument();
    });

    it('invite_used with a blocked membership routes to the access screen', async () => {
        const user = userEvent.setup();
        team.acceptInvite.mockRejectedValueOnce(new ApiError(410, 'invite_used'));
        team.getMembership.mockRejectedValueOnce(new MembershipBlockedError('removed', true));
        const { container } = renderIntl(<EmployerAuthForm mode="invite" invite={REJOIN_INVITE} />);

        await signInAndJoin(user, container);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/access?reason=removed&invite=1'));
        expect(setTokens).toHaveBeenCalledWith(TOKENS, 'employer');
    });

    it('a legal_required accept stores the UNPREFIXED invite path and goes to /legal/accept', async () => {
        const user = userEvent.setup();
        window.history.replaceState(null, '', '/en/auth/employer/invite');
        team.acceptInvite.mockRejectedValueOnce(new LegalWallError());
        const { container } = renderIntl(<EmployerAuthForm mode="invite" invite={REJOIN_INVITE} />);

        await signInAndJoin(user, container);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/legal/accept'));
        // next-intl's router adds the locale; a prefixed path became /en/en/….
        expect(sessionStorage.getItem('legalReturnUrl')).toBe('/auth/employer/invite');
        expect(setTokens).toHaveBeenCalledWith(TOKENS, 'employer');
        window.history.replaceState(null, '', '/');
    });

    it('an invite-mode confirm that finds the account already confirmed, then the rejoin login, joins', async () => {
        const user = userEvent.setup();
        sessionStorage.setItem('pendingInvite', JSON.stringify({ token: 'inv-tok-1', email: 'ana@example.com' }));
        const { container } = renderIntl(<EmployerAuthForm mode="invite" invite={NEW_INVITE} />);
        const [pw, pwConfirm] = Array.from(container.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]'));
        await user.type(pw, 'S3cret!pass');
        await user.type(pwConfirm, 'S3cret!pass');
        await user.type(input(container, 'input[type="tel"]'), '2105550100');
        cognito.employerSignUp.mockResolvedValueOnce(undefined);
        await user.click(submit(message('auth.employer.create_account')));
        await screen.findByText(message('auth.employer.signup_confirm_subtitle'));

        // Confirmed elsewhere (another tab): post-confirmation took the token.
        cognito.employerConfirmSignUp.mockRejectedValueOnce({ code: 'NotAuthorizedException', name: 'NotAuthorizedException' });
        await user.type(input(container, 'input[autocomplete="one-time-code"]'), '123456');
        await user.click(submit(message('auth.employer.confirm_account')));

        expect(await screen.findByText(message('auth.employer.errors.already_confirmed'))).toBeInTheDocument();
        expect(cognito.employerConfirmSignUp).toHaveBeenCalledWith('ana@example.com', '123456', { inviteToken: 'inv-tok-1' });
        expect(JSON.parse(sessionStorage.getItem('pendingEmployerProfile') as string)).toEqual({ contact_name: 'Ana Ruiz', phone: '+12105550100' });

        // The login step is the rejoin one; the accept finds the invite used by
        // this person's own confirmation, and lands.
        cognito.employerSignIn.mockResolvedValueOnce(TOKENS);
        team.acceptInvite.mockRejectedValueOnce(new ApiError(410, 'invite_used'));
        team.getMembership.mockResolvedValueOnce({ userId: 'u', organizationId: 'org-1', role: 'foreman', companyName: 'Acme Builders' });
        await user.click(submit(message('auth.employer.invite.rejoin_submit')));

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/dashboard'));
        expect(cognito.employerSignIn).toHaveBeenCalledWith('ana@example.com', 'S3cret!pass');
        expect(sessionStorage.getItem('pendingInvite')).toBeNull();
    });

    it('does not forward the token when the forgot-password flow changed the confirm email', async () => {
        const user = userEvent.setup();
        const { container } = renderIntl(<EmployerAuthForm mode="invite" invite={REJOIN_INVITE} />);

        await user.click(screen.getByRole('button', { name: message('auth.employer.forgot_link') }));
        const forgotEmail = await screen.findByRole('textbox');
        await user.clear(forgotEmail);
        await user.type(forgotEmail, 'other@example.com');
        cognito.employerResendConfirmationCode.mockResolvedValueOnce(undefined);
        await user.click(screen.getByRole('button', { name: message('auth.employer.never_received_code') }));
        expect(await screen.findByText(message('auth.employer.recovery_title'))).toBeInTheDocument();

        cognito.employerConfirmSignUp.mockResolvedValueOnce(undefined);
        await user.type(input(container, 'input[autocomplete="one-time-code"]'), '123456');
        await user.click(submit(message('auth.employer.confirm_account')));

        await waitFor(() => expect(cognito.employerConfirmSignUp).toHaveBeenCalled());
        expect(cognito.employerConfirmSignUp.mock.calls[0]).toEqual(['other@example.com', '123456']);
    });

    it('a busy accept shows the busy copy', async () => {
        const user = userEvent.setup();
        team.acceptInvite.mockRejectedValueOnce(new ApiError(503, 'busy'));
        const { container } = renderIntl(<EmployerAuthForm mode="invite" invite={REJOIN_INVITE} />);

        await signInAndJoin(user, container);

        expect(await screen.findByText(message('auth.employer.invite.busy'))).toBeInTheDocument();
    });
});

describe('a disabled account', () => {
    const disabled = { code: 'NotAuthorizedException', name: 'NotAuthorizedException', message: 'User is disabled.' };

    it('a disabled account\'s sign-in shows account_disabled', async () => {
        const user = userEvent.setup();
        cognito.employerSignIn.mockRejectedValueOnce(disabled);
        const { container } = renderIntl(<EmployerAuthForm />);

        await user.type(input(container, 'input[type="email"]'), 'ana@example.com');
        await user.type(screen.getByPlaceholderText(message('auth.employer.password_label')), 'S3cret!pass');
        await user.click(submit(message('auth.employer.sign_in')));

        expect(await screen.findByText(message('auth.employer.account_disabled'))).toBeInTheDocument();
        expect(screen.queryByText(message('auth.employer.errors.invalid_credentials'))).not.toBeInTheDocument();
    });

    it('in invite mode too, without calling accept', async () => {
        const user = userEvent.setup();
        cognito.employerSignIn.mockRejectedValueOnce(disabled);
        renderIntl(<EmployerAuthForm mode="invite" invite={REJOIN_INVITE} />);

        await user.type(screen.getByPlaceholderText(message('auth.employer.password_label')), 'S3cret!pass');
        await user.click(submit(message('auth.employer.invite.rejoin_submit')));

        expect(await screen.findByText(message('auth.employer.account_disabled'))).toBeInTheDocument();
        expect(team.acceptInvite).not.toHaveBeenCalled();
    });

    it('flag off: the Phase 2 wrong-credentials copy, unchanged', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        const user = userEvent.setup();
        cognito.employerSignIn.mockRejectedValueOnce(disabled);
        const { container } = renderIntl(<EmployerAuthForm />);

        await user.type(input(container, 'input[type="email"]'), 'ana@example.com');
        await user.type(screen.getByPlaceholderText(message('auth.employer.password_label')), 'S3cret!pass');
        await user.click(submit(message('auth.employer.sign_in')));

        expect(await screen.findByText(message('auth.employer.errors.invalid_credentials'))).toBeInTheDocument();
    });
});
