import { describe, expect, it, vi } from 'vitest';
import {
    ACCESS_PAGE_PATH,
    MEMBERSHIP_DISABLED,
    clearEmployerMembershipCache,
    membershipAccessPath,
    membershipCacheGeneration,
    membershipRole,
    subscribeMembershipCache,
    type EmployerMembership,
} from '@/lib/employer-membership-store';

describe('membershipRole (M2: the one membership-to-role rule)', () => {
    it('ready gives its role; error its billing role; every other state null', () => {
        const ready = (role: 'owner' | 'foreman'): EmployerMembership => ({
            status: 'ready', role, companyName: 'Acme', userId: 'u', organizationId: 'o',
        });
        expect(membershipRole(ready('owner'))).toBe('owner');
        expect(membershipRole(ready('foreman'))).toBe('foreman');
        expect(membershipRole({ status: 'error', billingRole: 'owner' })).toBe('owner');
        expect(membershipRole({ status: 'error', billingRole: 'foreman' })).toBe('foreman');
        expect(membershipRole({ status: 'error', billingRole: null })).toBeNull();
        expect(membershipRole({ status: 'loading' })).toBeNull();
        expect(membershipRole({ status: 'disabled' })).toBeNull();
        for (const reason of ['removed', 'suspended', 'no_organization'] as const) {
            expect(membershipRole({ status: 'blocked', reason, hasInvite: true })).toBeNull();
        }
    });

    it('MEMBERSHIP_DISABLED is the flag-off answer', () => {
        expect(MEMBERSHIP_DISABLED).toEqual({ status: 'disabled' });
    });
});

describe('membershipAccessPath', () => {
    it('names the reason, adds invite=1 when a re-invite waits, and sends no reason for an unknown status', () => {
        expect(ACCESS_PAGE_PATH).toBe('/employer/access');
        expect(membershipAccessPath({ reason: 'suspended', hasInvite: false, statusKnown: true })).toBe('/employer/access?reason=suspended');
        expect(membershipAccessPath({ reason: 'removed', hasInvite: true, statusKnown: true })).toBe('/employer/access?reason=removed&invite=1');
        expect(membershipAccessPath({ reason: 'no_organization', hasInvite: false, statusKnown: true })).toBe('/employer/access?reason=no_organization');
        expect(membershipAccessPath({ reason: 'suspended', hasInvite: false, statusKnown: false })).toBe('/employer/access');
    });
});

describe('cache generation', () => {
    it('every clear bumps the generation and tells subscribers; unsubscribe stops that', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeMembershipCache(listener);
        const before = membershipCacheGeneration();

        clearEmployerMembershipCache();
        expect(membershipCacheGeneration()).toBe(before + 1);
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        clearEmployerMembershipCache();
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
