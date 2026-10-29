// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { EmployerMembership } from '@/hooks/useEmployerMembership';
import type { TeamList, TeamMember } from '@/lib/api/team';

/*
 * Phase 3, Task 17: the owner moves one job to another member of the company
 * from the job's own page. Only an owner with the team flag on ever sees it;
 * a foreman, a blocked login and a flag-off build see the page as before.
 */

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: 'test-token' }) }));

const legalWall = vi.hoisted(() => ({
    // Rethrows anything that is not a wall, as the real one does.
    handle: vi.fn((err: unknown): void => {
        throw err;
    }),
}));
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({ handleLegalWall: legalWall.handle }),
}));

const membership = vi.hoisted(() => ({ value: { status: 'disabled' } as EmployerMembership }));
vi.mock('@/hooks/useEmployerMembership', () => ({
    useEmployerMembership: () => membership.value,
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toast }));

const getTeam = vi.fn();
const reassignJob = vi.fn();
vi.mock('@/lib/api/team', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/team')>()),
    getTeam: (...args: unknown[]) => getTeam(...args),
    reassignJob: (...args: unknown[]) => reassignJob(...args),
}));

// Below the mocks (they hoist).
import { message, renderIntl, interpolate } from '@/components/employer/__tests__/render-intl';
import { ApiError } from '@/lib/api/errors';
import { JobAssigneeControl } from '../JobAssigneeControl';

const JOB_ID = '11111111-2222-4333-8444-555555555555';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';
const BEN = 'aaaaaaaa-0000-4000-8000-000000000002';
const CY = 'aaaaaaaa-0000-4000-8000-000000000003';

function member(overrides: Partial<TeamMember> & { userId: string; name: string }): TeamMember {
    return {
        email: `${overrides.name.toLowerCase()}@example.com`,
        role: 'foreman',
        status: 'active',
        billingSuspended: false,
        joinedAt: '2026-10-01T00:00:00Z',
        activeJobs: 0,
        openJobs: 0,
        ...overrides,
    };
}

const team: TeamList = {
    seats: { limit: 3, active: 2, pending: 0, suspended: 1 },
    members: [
        member({ userId: BEN, name: 'Ben' }),
        member({ userId: OWNER, name: 'Ana', role: 'owner' }),
        member({ userId: CY, name: 'Cy', status: 'suspended', billingSuspended: true }),
    ],
    invites: [],
};

const owner: EmployerMembership = {
    status: 'ready',
    role: 'owner',
    companyName: 'Acme',
    userId: OWNER,
    organizationId: 'org-1',
};

const onJobChanged = vi.fn();

function renderControl(assigneeUserId: string | null = BEN, locale: 'en' | 'es' = 'en') {
    return renderIntl(
        <JobAssigneeControl
            jobId={JOB_ID}
            assigneeUserId={assigneeUserId}
            onJobChanged={onJobChanged}
            returnUrl={`/employer/jobs/${JOB_ID}`}
        />,
        locale,
    );
}

function select(): HTMLSelectElement {
    return screen.getByLabelText(message('employer_team.reassign.label')) as HTMLSelectElement;
}

function saveButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: message('employer_team.reassign.save') }) as HTMLButtonElement;
}

beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
    membership.value = owner;
    getTeam.mockReset();
    getTeam.mockResolvedValue(team);
    reassignJob.mockReset();
    onJobChanged.mockReset();
    toast.success.mockReset();
    legalWall.handle.mockClear();
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('JobAssigneeControl', () => {
    it('hidden for a foreman and with the flag off', async () => {
        // Flag off: the hook answers `disabled` and nothing is asked for.
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        membership.value = { status: 'disabled' };
        const off = renderControl();
        expect(off.container).toBeEmptyDOMElement();
        off.unmount();

        // Flag off wins even over an owner answer.
        membership.value = owner;
        const offOwner = renderControl();
        expect(offOwner.container).toBeEmptyDOMElement();
        offOwner.unmount();

        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
        for (const value of [
            { status: 'ready', role: 'foreman', companyName: 'Acme', userId: BEN, organizationId: 'org-1' },
            { status: 'loading' },
            { status: 'blocked', reason: 'removed', hasInvite: false },
            // A failed membership read is never taken for an owner here.
            { status: 'error', billingRole: 'owner' },
        ] as EmployerMembership[]) {
            membership.value = value;
            const view = renderControl();
            expect(view.container).toBeEmptyDOMElement();
            view.unmount();
        }

        // Let any stray effect run before asserting nothing was fetched.
        await act(async () => {});
        expect(getTeam).not.toHaveBeenCalled();
        expect(reassignJob).not.toHaveBeenCalled();
    });

    it('lists the owner and active foremen, preselects the current one', async () => {
        renderControl(BEN);

        await waitFor(() => expect(select().value).toBe(BEN));
        expect(getTeam).toHaveBeenCalledWith('test-token', expect.anything());

        const options = Array.from(select().options).map((o) => ({ value: o.value, text: o.textContent }));
        // The owner first, then the active foremen; a suspended one is not offered.
        expect(options).toEqual([
            { value: OWNER, text: `Ana (${message('employer_team.members.owner')})` },
            { value: BEN, text: 'Ben' },
        ]);
        // Nothing to save until the choice differs from the current one.
        expect(saveButton()).toBeDisabled();
    });

    it('preselects nothing when the job read names no responsible person', async () => {
        renderControl(null);

        await waitFor(() => expect(screen.getByRole('option', { name: 'Ben' })).toBeInTheDocument());
        expect(select().value).toBe('');
        expect(saveButton()).toBeDisabled();
    });

    it('save calls reassignJob and toasts the new name', async () => {
        const user = userEvent.setup();
        reassignJob.mockResolvedValue({ jobId: JOB_ID, assigneeUserId: OWNER, changed: true });
        renderControl(BEN);
        await waitFor(() => expect(select().value).toBe(BEN));

        await user.selectOptions(select(), OWNER);
        expect(saveButton()).toBeEnabled();
        await user.click(saveButton());

        await waitFor(() => expect(reassignJob).toHaveBeenCalledWith('test-token', JOB_ID, OWNER));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
            interpolate(message('employer_team.reassign.done'), { name: 'Ana' }),
        ));
        // The job is read again, so the page's responsible person follows.
        expect(onJobChanged).toHaveBeenCalledTimes(1);
        // The control already shows the new person, even before that read lands.
        expect(select().value).toBe(OWNER);
        expect(saveButton()).toBeDisabled();
    });

    it('invalid_assignee refetches the team', async () => {
        const user = userEvent.setup();
        reassignJob.mockRejectedValue(new ApiError(409, 'invalid_assignee'));
        renderControl(OWNER);
        await waitFor(() => expect(select().value).toBe(OWNER));
        expect(getTeam).toHaveBeenCalledTimes(1);

        await user.selectOptions(select(), BEN);
        await user.click(saveButton());

        expect(await screen.findByText(message('employer_team.errors.invalid_assignee'))).toBeInTheDocument();
        await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2));
        // Back on the current person: the one chosen may no longer be offered.
        await waitFor(() => expect(select().value).toBe(OWNER));
        expect(onJobChanged).not.toHaveBeenCalled();
        expect(toast.success).not.toHaveBeenCalled();
    });

    it('job_not_found reads the job again and says so', async () => {
        const user = userEvent.setup();
        reassignJob.mockRejectedValue(new ApiError(404, 'job_not_found'));
        renderControl(BEN);
        await waitFor(() => expect(select().value).toBe(BEN));

        await user.selectOptions(select(), OWNER);
        await user.click(saveButton());

        expect(await screen.findByText(message('employer_team.errors.job_not_found'))).toBeInTheDocument();
        expect(onJobChanged).toHaveBeenCalledTimes(1);
        expect(toast.success).not.toHaveBeenCalled();
    });

    it('a busy answer (after the built-in retry) shows the busy copy', async () => {
        const user = userEvent.setup();
        reassignJob.mockRejectedValue(new ApiError(503, 'busy'));
        renderControl(BEN);
        await waitFor(() => expect(select().value).toBe(BEN));

        await user.selectOptions(select(), OWNER);
        await user.click(saveButton());

        expect(await screen.findByText(message('employer_team.errors.busy'))).toBeInTheDocument();
        expect(onJobChanged).not.toHaveBeenCalled();
        // The choice is kept, so the owner can simply press Change again.
        expect(select().value).toBe(OWNER);
        expect(saveButton()).toBeEnabled();
    });

    it('hands a legal wall or a blocked login to handleLegalWall instead of showing an error', async () => {
        const user = userEvent.setup();
        legalWall.handle.mockImplementationOnce(() => {});
        reassignJob.mockRejectedValue(new ApiError(403, 'legal_required'));
        renderControl(BEN);
        await waitFor(() => expect(select().value).toBe(BEN));

        await user.selectOptions(select(), OWNER);
        await user.click(saveButton());

        await waitFor(() => expect(legalWall.handle).toHaveBeenCalledWith(
            expect.any(ApiError), `/employer/jobs/${JOB_ID}`,
        ));
        expect(screen.queryByText(message('employer_team.errors.generic'))).not.toBeInTheDocument();
    });

    it('says the team could not be read, and offers nothing to save', async () => {
        getTeam.mockRejectedValue(new ApiError(500, 'internal_error'));
        renderControl(BEN);

        expect(await screen.findByText(message('employer_team.errors.generic'))).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: message('employer_team.reassign.save') })).not.toBeInTheDocument();
    });

    it('a busy team read (after the built-in retry) shows the busy copy', async () => {
        getTeam.mockRejectedValue(new ApiError(503, 'busy'));
        renderControl(BEN);

        expect(await screen.findByText(message('employer_team.errors.busy'))).toBeInTheDocument();
    });

    it('changed: false says nothing and reads nothing again', async () => {
        const user = userEvent.setup();
        // The job already was Ana's (a move from another tab landed first).
        reassignJob.mockResolvedValue({ jobId: JOB_ID, assigneeUserId: OWNER, changed: false });
        renderControl(BEN);
        await waitFor(() => expect(select().value).toBe(BEN));

        await user.selectOptions(select(), OWNER);
        await user.click(saveButton());

        await waitFor(() => expect(reassignJob).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(saveButton()).toBeDisabled());
        expect(select().value).toBe(OWNER);
        expect(toast.success).not.toHaveBeenCalled();
        expect(onJobChanged).not.toHaveBeenCalled();
    });

    it('shows a current person who can no longer take jobs, without offering them', async () => {
        renderControl(CY);

        await waitFor(() => expect(select().value).toBe(CY));
        const cy = screen.getByRole('option', { name: `Cy (${message('employer_team.members.suspended')})` }) as HTMLOptionElement;
        expect(cy.disabled).toBe(true);
        expect(Array.from(select().options).map((o) => o.value)).toEqual([CY, OWNER, BEN]);
        expect(saveButton()).toBeDisabled();
    });

    it('keeps the list and says so when the re-read after invalid_assignee fails', async () => {
        const user = userEvent.setup();
        reassignJob.mockRejectedValue(new ApiError(409, 'invalid_assignee'));
        renderControl(OWNER);
        await waitFor(() => expect(select().value).toBe(OWNER));
        getTeam.mockRejectedValue(new ApiError(503, 'busy'));

        await user.selectOptions(select(), BEN);
        await user.click(saveButton());

        expect(await screen.findByText(message('employer_team.errors.busy'))).toBeInTheDocument();
        expect(screen.getByText(message('employer_team.errors.invalid_assignee'))).toBeInTheDocument();
        expect(select().value).toBe(OWNER);
    });

    it('sends one request for a double click while saving', async () => {
        let resolve: (value: unknown) => void = () => {};
        reassignJob.mockImplementation(() => new Promise((r) => { resolve = r; }));
        const user = userEvent.setup();
        renderControl(BEN);
        await waitFor(() => expect(select().value).toBe(BEN));
        await user.selectOptions(select(), OWNER);

        // Both clicks before React re-renders: only the ref guard can stop the second.
        act(() => {
            saveButton().click();
            saveButton().click();
        });
        await act(async () => {
            resolve({ jobId: JOB_ID, assigneeUserId: OWNER, changed: true });
        });

        expect(reassignJob).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(onJobChanged).toHaveBeenCalledTimes(1));
    });

    it('gives keyboard focus back after a save that dropped it', async () => {
        let reject: (err: unknown) => void = () => {};
        reassignJob.mockImplementation(() => new Promise((_, r) => { reject = r; }));
        const user = userEvent.setup();
        renderControl(BEN);
        await waitFor(() => expect(select().value).toBe(BEN));
        await user.selectOptions(select(), OWNER);

        saveButton().focus();
        await user.keyboard('{Enter}');
        await waitFor(() => expect(reassignJob).toHaveBeenCalled());
        // What a browser does to a focused button that becomes disabled: focus
        // falls to <body>. (jsdom does neither that nor `blur()` on a disabled
        // button, so focus is parked on a throwaway element that is removed.)
        const parking = document.createElement('input');
        document.body.appendChild(parking);
        parking.focus();
        parking.remove();
        expect(document.activeElement).toBe(document.body);

        await act(async () => {
            reject(new ApiError(503, 'busy'));
        });

        // The save can be retried, so focus returns to Change itself.
        await waitFor(() => expect(document.activeElement).toBe(saveButton()));
    });

    it('reads in Spanish', async () => {
        renderControl(BEN, 'es');

        expect(await screen.findByLabelText(message('employer_team.reassign.label', 'es'))).toBeInTheDocument();
        expect(screen.getByRole('option', {
            name: `Ana (${message('employer_team.members.owner', 'es')})`,
        })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('employer_team.reassign.save', 'es') })).toBeInTheDocument();
    });
});
