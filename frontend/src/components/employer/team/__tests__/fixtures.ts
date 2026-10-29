import type { TeamInvite, TeamList, TeamMember } from '@/lib/api/team';

/** Team fixtures shared by the component and page suites. Not a `.test.` file. */

export function member(overrides: Partial<TeamMember> & Pick<TeamMember, 'userId' | 'name'>): TeamMember {
    return {
        email: `${overrides.userId}@example.com`,
        role: 'foreman',
        status: 'active',
        billingSuspended: false,
        joinedAt: '2026-09-01T12:00:00.000Z',
        activeJobs: 0,
        openJobs: 0,
        ...overrides,
    };
}

export const OWNER = member({ userId: 'owner-1', name: 'Olga Owner', role: 'owner', joinedAt: '2026-01-01T12:00:00.000Z' });
export const ANA = member({ userId: 'fm-ana', name: 'Ana Foreman', joinedAt: '2026-09-10T12:00:00.000Z', openJobs: 2 });
export const BETO = member({ userId: 'fm-beto', name: 'Beto Foreman', joinedAt: '2026-09-02T12:00:00.000Z', openJobs: 1 });
export const CARLA = member({
    userId: 'fm-carla',
    name: 'Carla Suspended',
    status: 'suspended',
    billingSuspended: true,
    joinedAt: '2026-09-05T12:00:00.000Z',
});
/** Active by status but billing-suspended: cannot take over jobs either. */
export const DIEGO = member({
    userId: 'fm-diego',
    name: 'Diego BillingSuspended',
    status: 'active',
    billingSuspended: true,
    joinedAt: '2026-09-07T12:00:00.000Z',
});

export function invite(overrides: Partial<TeamInvite> & Pick<TeamInvite, 'inviteId' | 'email'>): TeamInvite {
    return {
        contactName: null,
        createdAt: '2026-10-20T12:00:00.000Z',
        expiresAt: '2026-11-03T12:00:00.000Z',
        lastSentAt: '2026-10-20T12:00:00.000Z',
        expired: false,
        ...overrides,
    };
}

export const INVITE_LIVE = invite({ inviteId: 'inv-live', email: 'dana@example.com', contactName: 'Dana Díaz' });
export const INVITE_EXPIRED = invite({
    inviteId: 'inv-old',
    email: 'eli@example.com',
    expiresAt: '2026-10-01T12:00:00.000Z',
    expired: true,
});

export function teamList(overrides: Partial<TeamList> = {}): TeamList {
    return {
        seats: { limit: 5, active: 2, pending: 1, suspended: 1 },
        members: [ANA, OWNER, CARLA, BETO, DIEGO],
        invites: [INVITE_LIVE],
        ...overrides,
    };
}
