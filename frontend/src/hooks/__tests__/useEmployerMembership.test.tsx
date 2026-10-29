// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MembershipBlockedError } from '@/lib/api';

const state = {
    idToken: 'tok' as string | null,
    epoch: 0,
};

const { getMembership, getBilling, handleLegalWall } = vi.hoisted(() => ({
    getMembership: vi.fn(),
    getBilling: vi.fn(),
    handleLegalWall: vi.fn(),
}));

vi.mock('@/lib/api/team', () => ({ getMembership }));
vi.mock('@/lib/api/employer', () => ({ getBilling }));
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({ idToken: state.idToken, handleLegalWall }),
}));
vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ sessionCleared: { epoch: state.epoch, role: null } }),
}));

import { clearEmployerMembershipCache, useEmployerMembership } from '@/hooks/useEmployerMembership';

function Probe({ id = 'm' }: { id?: string }) {
    const membership = useEmployerMembership();
    return <pre data-testid={id}>{JSON.stringify(membership)}</pre>;
}

function read(id = 'm'): Record<string, unknown> {
    return JSON.parse(screen.getByTestId(id).textContent ?? 'null');
}

beforeEach(() => {
    vi.clearAllMocks();
    clearEmployerMembershipCache();
    state.idToken = 'tok';
    state.epoch = 0;
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('useEmployerMembership', () => {
    it('flag off: disabled and no request', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        getMembership.mockRejectedValue(new Error('must not be called'));

        render(<Probe />);
        await act(async () => { await Promise.resolve(); });

        expect(read()).toEqual({ status: 'disabled' });
        expect(getMembership).not.toHaveBeenCalled();
        expect(getBilling).not.toHaveBeenCalled();
    });

    it('fetches once and caches', async () => {
        getMembership.mockResolvedValue({ userId: 'u1', organizationId: 'o1', role: 'foreman', companyName: 'Acme' });

        const first = render(<><Probe id="a" /><Probe id="b" /></>);
        expect(read('a')).toEqual({ status: 'loading' });
        await waitFor(() => expect(read('a')).toMatchObject({ status: 'ready', role: 'foreman', companyName: 'Acme', userId: 'u1' }));
        expect(read('b')).toMatchObject({ status: 'ready', role: 'foreman' });
        expect(getMembership).toHaveBeenCalledTimes(1);
        expect(getMembership).toHaveBeenCalledWith('tok');
        first.unmount();

        // A later page reads the cached answer straight away, with no request.
        render(<Probe id="c" />);
        expect(read('c')).toMatchObject({ status: 'ready', role: 'foreman' });
        expect(getMembership).toHaveBeenCalledTimes(1);
    });

    it('a new session (a sign-out) or a cleared cache fetches again', async () => {
        getMembership.mockResolvedValue({ userId: 'u1', organizationId: 'o1', role: 'owner', companyName: 'Acme' });
        const view = render(<Probe />);
        await waitFor(() => expect(read()).toMatchObject({ status: 'ready' }));
        view.unmount();

        state.epoch = 1;
        const next = render(<Probe />);
        await waitFor(() => expect(getMembership).toHaveBeenCalledTimes(2));
        next.unmount();

        clearEmployerMembershipCache();
        render(<Probe />);
        await waitFor(() => expect(getMembership).toHaveBeenCalledTimes(3));
    });

    it('waits for a token before asking', async () => {
        state.idToken = null;
        render(<Probe />);
        await act(async () => { await Promise.resolve(); });
        expect(read()).toEqual({ status: 'loading' });
        expect(getMembership).not.toHaveBeenCalled();
    });

    it('on failure: error with billingRole from getBilling', async () => {
        getMembership.mockRejectedValue(new Error('boom'));
        getBilling.mockResolvedValue({ role: 'foreman' });

        render(<Probe />);

        await waitFor(() => expect(read()).toEqual({ status: 'error', billingRole: 'foreman' }));
        expect(getBilling).toHaveBeenCalledTimes(1);
        expect(getBilling).toHaveBeenCalledWith('tok');
        expect(handleLegalWall).not.toHaveBeenCalled();
    });

    it('on failure of both: error with billingRole null', async () => {
        getMembership.mockRejectedValue(new Error('boom'));
        getBilling.mockRejectedValue(new Error('also boom'));

        render(<Probe />);

        await waitFor(() => expect(read()).toEqual({ status: 'error', billingRole: null }));
    });

    it('a billing answer without a role gives billingRole null', async () => {
        getMembership.mockRejectedValue(new Error('boom'));
        getBilling.mockResolvedValue({});

        render(<Probe />);

        await waitFor(() => expect(read()).toEqual({ status: 'error', billingRole: null }));
    });

    it('an error is not cached: the next mount asks again', async () => {
        getMembership.mockRejectedValueOnce(new Error('boom'));
        getBilling.mockResolvedValue({ role: 'owner' });
        const view = render(<Probe />);
        await waitFor(() => expect(read()).toMatchObject({ status: 'error' }));
        view.unmount();

        getMembership.mockResolvedValueOnce({ userId: 'u1', organizationId: 'o1', role: 'owner', companyName: 'Acme' });
        render(<Probe />);
        await waitFor(() => expect(read()).toMatchObject({ status: 'ready', role: 'owner' }));
        expect(getMembership).toHaveBeenCalledTimes(2);
    });

    it('a blocked login is never an owner: blocked state, the access redirect, and no billing fallback', async () => {
        const err = new MembershipBlockedError('removed', true);
        getMembership.mockRejectedValue(err);
        getBilling.mockResolvedValue({ role: 'owner' });

        render(<Probe />);

        await waitFor(() => expect(read()).toEqual({ status: 'blocked', reason: 'removed', hasInvite: true }));
        expect(getBilling).not.toHaveBeenCalled();
        expect(handleLegalWall).toHaveBeenCalledTimes(1);
        expect(handleLegalWall.mock.calls[0][0]).toBe(err);
    });

    it('a generic membership failure whose billing fallback says blocked is blocked, never billingRole null', async () => {
        getMembership.mockRejectedValue(new Error('boom'));
        const err = new MembershipBlockedError('suspended', false);
        getBilling.mockRejectedValue(err);

        render(<Probe />);

        await waitFor(() => expect(read()).toEqual({ status: 'blocked', reason: 'suspended', hasInvite: false }));
        expect(handleLegalWall).toHaveBeenCalledTimes(1);
        expect(handleLegalWall.mock.calls[0][0]).toBe(err);
    });

    it('a blocked answer is routed once, however many callers are mounted (sidebar, tab bar, page)', async () => {
        getMembership.mockRejectedValue(new MembershipBlockedError('removed', false));

        render(<><Probe id="a" /><Probe id="b" /><Probe id="c" /></>);

        await waitFor(() => expect(read('c')).toMatchObject({ status: 'blocked' }));
        expect(read('a')).toMatchObject({ status: 'blocked' });
        expect(getMembership).toHaveBeenCalledTimes(1);
        expect(handleLegalWall).toHaveBeenCalledTimes(1);
    });

    it('a suspended login is blocked too', async () => {
        getMembership.mockRejectedValue(new MembershipBlockedError('suspended', false));

        render(<Probe />);

        await waitFor(() => expect(read()).toEqual({ status: 'blocked', reason: 'suspended', hasInvite: false }));
        expect(getBilling).not.toHaveBeenCalled();
    });
});
