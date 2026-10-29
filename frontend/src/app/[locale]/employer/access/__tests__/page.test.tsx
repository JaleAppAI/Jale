// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { MembershipBlockedError } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import {
    readMembershipCache,
    resetAccessRedirectGuard,
    writeMembershipCache,
    type MembershipLoadResult,
} from '@/lib/employer-membership-store';

const state = vi.hoisted(() => ({ search: '', idToken: 'tok' as string | null }));

const { replace, logout, startCompany, getMembership, handleLegalWall, notFound } = vi.hoisted(() => ({
    replace: vi.fn(),
    logout: vi.fn(),
    startCompany: vi.fn(),
    getMembership: vi.fn(),
    handleLegalWall: vi.fn(),
    notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
}));

vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(state.search),
    notFound,
}));
// Stable, like next-intl's memoised router: the arrival re-read depends on it.
const router = vi.hoisted(() => ({ current: null as null | { replace: (href: string) => void } }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => (router.current ??= { replace: (href: string) => replace(href) }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ logout }) }));
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({ idToken: state.idToken, isAuthenticated: state.idToken !== null, isLoading: false, handleLegalWall }),
}));
vi.mock('@/lib/api/team', () => ({ startCompany, getMembership }));

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import EmployerAccessPage from '../page';

/** The membership re-read the page does on arrival: still blocked with the URL's reason. */
function stillBlocked(reason: 'suspended' | 'removed' | 'no_organization', hasInvite = false) {
    getMembership.mockRejectedValue(new MembershipBlockedError(reason, hasInvite));
}

const ACTIVE = { userId: 'u', organizationId: 'o', role: 'foreman', companyName: 'Acme' };

/** Puts a settled entry in the shared membership cache. */
function seedCache() {
    const value = { status: 'ready', role: 'owner', companyName: 'Acme', userId: 'u', organizationId: 'o' } as const;
    writeMembershipCache({
        epoch: 0,
        promise: Promise.resolve<MembershipLoadResult>({ value, blockedError: null }),
        value,
        blockedRouted: false,
    });
}

async function settle() {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function nameInput(): HTMLInputElement {
    return screen.getByLabelText(message('employer_access.no_organization.start_name'));
}

function submitButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: message('employer_access.no_organization.start_submit') });
}

beforeEach(() => {
    vi.clearAllMocks();
    state.search = '';
    state.idToken = 'tok';
    resetAccessRedirectGuard();
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
    logout.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('employer access page', () => {
    it('renders each reason\'s title and body; the no_organization body is exactly "Your invite expired, ask your company to resend it."', async () => {
        for (const reason of ['suspended', 'removed', 'no_organization'] as const) {
            state.search = `?reason=${reason}`;
            stillBlocked(reason);
            const view = renderIntl(<EmployerAccessPage />);
            await settle();
            expect(screen.getByRole('heading', { level: 1, name: message(`employer_access.${reason}.title`) })).toBeInTheDocument();
            expect(screen.getByText(message(`employer_access.${reason}.body`))).toBeInTheDocument();
            // Every reason can sign out.
            expect(screen.getByRole('button', { name: message('employer_access.sign_out') })).toBeInTheDocument();
            // The start-company form is only for a login with no company.
            const form = screen.queryByRole('button', { name: message('employer_access.no_organization.start_submit') });
            expect(form !== null).toBe(reason === 'no_organization');
            view.unmount();
        }
        expect(message('employer_access.no_organization.body')).toBe('Your invite expired, ask your company to resend it.');
    });

    it('renders the Spanish copy', async () => {
        state.search = '?reason=no_organization';
        stillBlocked('no_organization');
        renderIntl(<EmployerAccessPage />, 'es');
        await settle();
        expect(screen.getByText('Su invitación venció; pida a su empresa que se la reenvíe.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Crear mi empresa' })).toBeInTheDocument();
    });

    it('removed with invite=1 shows has_invite', async () => {
        state.search = '?reason=removed&invite=1';
        stillBlocked('removed', true);
        renderIntl(<EmployerAccessPage />);
        await settle();
        expect(screen.getByText(message('employer_access.removed.has_invite'))).toBeInTheDocument();
    });

    it('removed without invite=1 has no pointer until membership says a re-invite is waiting', async () => {
        state.search = '?reason=removed';
        let reject: (err: unknown) => void = () => {};
        getMembership.mockReturnValue(new Promise((_resolve, r) => { reject = r; }));
        renderIntl(<EmployerAccessPage />);
        expect(screen.queryByText(message('employer_access.removed.has_invite'))).toBeNull();

        await act(async () => { reject(new MembershipBlockedError('removed', true)); });
        expect(screen.getByText(message('employer_access.removed.has_invite'))).toBeInTheDocument();
        expect(getMembership).toHaveBeenCalledWith('tok');
    });

    it('no reason in the URL (the 403 named no status): the loading card until membership answers', async () => {
        state.search = '';
        let reject: (err: unknown) => void = () => {};
        getMembership.mockReturnValue(new Promise((_resolve, r) => { reject = r; }));
        renderIntl(<EmployerAccessPage />);

        expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
        expect(screen.queryByRole('button', { name: message('employer_access.sign_out') })).toBeNull();

        await act(async () => { reject(new MembershipBlockedError('removed', false)); });
        expect(screen.getByRole('heading', { level: 1, name: message('employer_access.removed.title') })).toBeInTheDocument();
    });

    it('no reason and a failing membership read: an error card with Retry and sign-out, never "paused" and never blank (M4)', async () => {
        getMembership.mockRejectedValue(new ApiError(500, 'internal_error'));
        renderIntl(<EmployerAccessPage />);

        expect(await screen.findByRole('button', { name: message('common.retry') })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1, name: message('common.error_state.title') })).toBeInTheDocument();
        expect(screen.getByText(message('common.errors.server'))).toBeInTheDocument();
        expect(screen.queryByText(message('employer_access.suspended.title'))).toBeNull();
        expect(screen.getByRole('button', { name: message('employer_access.sign_out') })).toBeInTheDocument();
        expect(replace).not.toHaveBeenCalled();
    });

    it('Retry re-reads the membership: a blocked answer paints its reason (M4)', async () => {
        getMembership.mockRejectedValueOnce(new ApiError(0, 'offline'));
        renderIntl(<EmployerAccessPage />);
        const retry = await screen.findByRole('button', { name: message('common.retry') });

        getMembership.mockRejectedValueOnce(new MembershipBlockedError('removed', true));
        fireEvent.click(retry);

        expect(await screen.findByRole('heading', { level: 1, name: message('employer_access.removed.title') })).toBeInTheDocument();
        expect(screen.getByText(message('employer_access.removed.has_invite'))).toBeInTheDocument();
        expect(getMembership).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole('button', { name: message('common.retry') })).toBeNull();
    });

    it('Retry re-reads the membership: an active answer goes to the dashboard (M4)', async () => {
        getMembership.mockRejectedValueOnce(new ApiError(503, 'busy'));
        renderIntl(<EmployerAccessPage />);
        const retry = await screen.findByRole('button', { name: message('common.retry') });

        getMembership.mockResolvedValueOnce(ACTIVE);
        fireEvent.click(retry);

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/dashboard'));
        expect(getMembership).toHaveBeenCalledTimes(2);
    });

    it('arrival drops the cached membership, whatever the answer', async () => {
        for (const answer of ['blocked', 'active', 'error'] as const) {
            resetAccessRedirectGuard();
            seedCache();
            expect(readMembershipCache(0)).not.toBeNull();
            if (answer === 'blocked') stillBlocked('suspended');
            else if (answer === 'active') getMembership.mockResolvedValue(ACTIVE);
            else getMembership.mockRejectedValue(new ApiError(500, 'internal_error'));
            state.search = '?reason=suspended';
            const view = renderIntl(<EmployerAccessPage />);
            await settle();
            expect(readMembershipCache(0)).toBeNull();
            view.unmount();
        }
    });

    it('an active membership on arrival goes to the dashboard', async () => {
        state.search = '?reason=suspended';
        getMembership.mockResolvedValue(ACTIVE);
        renderIntl(<EmployerAccessPage />);
        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/dashboard'));
    });

    it('redirects to the dashboard at most once per page load (no access↔dashboard loop)', async () => {
        state.search = '?reason=suspended';
        getMembership.mockResolvedValue(ACTIVE);

        const first = renderIntl(<EmployerAccessPage />);
        await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
        first.unmount();

        // The dashboard's own request 403s again and sends the login back.
        renderIntl(<EmployerAccessPage />);
        await settle();
        expect(replace).toHaveBeenCalledTimes(1);
        // It stays, with a way out.
        expect(screen.getByRole('button', { name: message('employer_access.sign_out') })).toBeInTheDocument();
    });

    it('a blocked arrival re-arms the redirect for a later recovery', async () => {
        state.search = '?reason=suspended';
        getMembership.mockResolvedValueOnce(ACTIVE);
        const first = renderIntl(<EmployerAccessPage />);
        await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
        first.unmount();

        stillBlocked('suspended');
        const second = renderIntl(<EmployerAccessPage />);
        await settle();
        second.unmount();

        getMembership.mockResolvedValue(ACTIVE);
        renderIntl(<EmployerAccessPage />);
        await waitFor(() => expect(replace).toHaveBeenCalledTimes(2));
    });

    it('a failing membership re-read keeps the URL\'s reason', async () => {
        state.search = '?reason=suspended';
        getMembership.mockRejectedValue(new ApiError(500, 'internal_error'));
        renderIntl(<EmployerAccessPage />);
        await settle();
        expect(screen.getByText(message('employer_access.suspended.title'))).toBeInTheDocument();
        expect(replace).not.toHaveBeenCalled();
    });

    it('start my company calls startCompany with the trimmed name and routes to the profile', async () => {
        state.search = '?reason=no_organization';
        stillBlocked('no_organization');
        startCompany.mockResolvedValue({ organizationId: 'org-1', role: 'owner' });
        renderIntl(<EmployerAccessPage />);
        await settle();
        seedCache();

        fireEvent.change(nameInput(), { target: { value: '  Acme Roofing  ' } });
        fireEvent.click(submitButton());

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/profile'));
        expect(startCompany).toHaveBeenCalledWith('tok', 'Acme Roofing');
        expect(readMembershipCache(0)).toBeNull();
    });

    it('after a successful start the button stays disabled until the navigation', async () => {
        state.search = '?reason=no_organization';
        stillBlocked('no_organization');
        startCompany.mockResolvedValue({ organizationId: 'org-1', role: 'owner' });
        renderIntl(<EmployerAccessPage />);
        await settle();

        fireEvent.change(nameInput(), { target: { value: 'Acme' } });
        fireEvent.click(submitButton());

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/profile'));
        await settle();
        // Still in its loading state (named by the loading label), so disabled.
        const button = document.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute('aria-busy', 'true');
        fireEvent.submit(button.form!);
        expect(startCompany).toHaveBeenCalledTimes(1);
    });

    it('a blank company name is refused without a request, described on the input, which takes focus', async () => {
        state.search = '?reason=no_organization';
        stillBlocked('no_organization');
        renderIntl(<EmployerAccessPage />);
        await settle();

        fireEvent.change(nameInput(), { target: { value: '   ' } });
        fireEvent.click(submitButton());

        const error = await screen.findByText(message('employer_access.errors.invalid_company_name'));
        expect(startCompany).not.toHaveBeenCalled();
        const input = nameInput();
        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(input.getAttribute('aria-describedby')).toBe(error.id);
        expect(error.id).not.toBe('');
        expect(document.activeElement).toBe(input);
    });

    it('409 already_member from start-company: refetch membership and go to the dashboard, no error', async () => {
        state.search = '?reason=no_organization';
        stillBlocked('no_organization');
        startCompany.mockRejectedValue(new ApiError(409, 'already_member'));
        renderIntl(<EmployerAccessPage />);
        await settle();

        getMembership.mockResolvedValue(ACTIVE);
        fireEvent.change(nameInput(), { target: { value: 'Acme' } });
        fireEvent.click(submitButton());

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/dashboard'));
        expect(getMembership).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('409 already_member and a re-read that fails for another reason: still the dashboard', async () => {
        state.search = '?reason=no_organization';
        stillBlocked('no_organization');
        startCompany.mockRejectedValue(new ApiError(409, 'already_member'));
        renderIntl(<EmployerAccessPage />);
        await settle();

        getMembership.mockRejectedValue(new ApiError(500, 'internal_error'));
        fireEvent.change(nameInput(), { target: { value: 'Acme' } });
        fireEvent.click(submitButton());

        await waitFor(() => expect(replace).toHaveBeenCalledWith('/employer/dashboard'));
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('409 already_member and a re-read that says blocked: that screen, no redirect', async () => {
        state.search = '?reason=no_organization';
        stillBlocked('no_organization');
        startCompany.mockRejectedValue(new ApiError(409, 'already_member'));
        renderIntl(<EmployerAccessPage />);
        await settle();

        getMembership.mockRejectedValue(new MembershipBlockedError('suspended'));
        fireEvent.change(nameInput(), { target: { value: 'Acme' } });
        fireEvent.click(submitButton());

        await waitFor(() => expect(screen.getByText(message('employer_access.suspended.title'))).toBeInTheDocument());
        expect(replace).not.toHaveBeenCalled();
    });

    it('start-company errors show their copy and re-enable the button', async () => {
        state.search = '?reason=no_organization';
        stillBlocked('no_organization');
        renderIntl(<EmployerAccessPage />);
        await settle();
        fireEvent.change(nameInput(), { target: { value: 'Acme' } });

        startCompany.mockRejectedValueOnce(new ApiError(400, 'invalid_company_name'));
        fireEvent.click(submitButton());
        expect(await screen.findByText(message('employer_access.errors.invalid_company_name'))).toBeInTheDocument();
        await waitFor(() => expect(submitButton()).not.toBeDisabled());

        startCompany.mockRejectedValueOnce(new ApiError(503, 'busy'));
        fireEvent.click(submitButton());
        expect(await screen.findByText(message('employer_access.errors.busy'))).toBeInTheDocument();
        await waitFor(() => expect(submitButton()).not.toBeDisabled());

        startCompany.mockRejectedValueOnce(new ApiError(500, 'internal_error'));
        fireEvent.click(submitButton());
        expect(await screen.findByText(message('employer_access.errors.generic'))).toBeInTheDocument();
        expect(replace).not.toHaveBeenCalled();
    });

    it('a legal wall from start-company goes to the legal wall handling', async () => {
        state.search = '?reason=no_organization';
        stillBlocked('no_organization');
        const wall = Object.assign(new Error('legal_required'), { name: 'LegalWallError' });
        startCompany.mockRejectedValue(wall);
        renderIntl(<EmployerAccessPage />);
        await settle();

        fireEvent.change(nameInput(), { target: { value: 'Acme' } });
        fireEvent.click(submitButton());

        await waitFor(() => expect(handleLegalWall).toHaveBeenCalledWith(wall, expect.any(String)));
    });

    it('the legal-wall return URL has no locale: next-intl adds it (I1, never /en/en/…)', async () => {
        window.history.replaceState(null, '', '/en/employer/access?reason=no_organization');
        state.search = '?reason=no_organization';
        stillBlocked('no_organization');
        const wall = Object.assign(new Error('legal_required'), { name: 'LegalWallError' });
        startCompany.mockRejectedValue(wall);
        renderIntl(<EmployerAccessPage />);
        await settle();

        fireEvent.change(nameInput(), { target: { value: 'Acme' } });
        fireEvent.click(submitButton());

        await waitFor(() => expect(handleLegalWall).toHaveBeenCalledWith(wall, '/employer/access?reason=no_organization'));
        window.history.replaceState(null, '', '/');
    });

    it('sign out clears the employer session', async () => {
        state.search = '?reason=removed';
        stillBlocked('removed');
        renderIntl(<EmployerAccessPage />);
        await settle();
        seedCache();

        fireEvent.click(screen.getByRole('button', { name: message('employer_access.sign_out') }));

        await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
        expect(readMembershipCache(0)).toBeNull();
    });

    it('flag off: the route does not exist and nothing is asked (Phase 2)', () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        state.search = '?reason=no_organization';
        expect(() => renderIntl(<EmployerAccessPage />)).toThrow('NEXT_NOT_FOUND');
        expect(notFound).toHaveBeenCalled();
        expect(getMembership).not.toHaveBeenCalled();
        expect(startCompany).not.toHaveBeenCalled();
    });
});
