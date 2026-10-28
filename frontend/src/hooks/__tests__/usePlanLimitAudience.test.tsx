// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EmployerMembership } from '@/lib/employer-membership-store';

const { state } = vi.hoisted(() => ({
    state: { membership: { status: 'loading' } as EmployerMembership },
}));
vi.mock('@/hooks/useEmployerMembership', () => ({
    useEmployerMembership: () => state.membership,
}));

import { planLimitAudienceFor, usePlanLimitAudience, type AudienceBilling } from '@/hooks/usePlanLimitAudience';
import { upgradeOffered } from '@/lib/plan-limit';

const ready = (role: 'owner' | 'foreman'): EmployerMembership => ({
    status: 'ready', role, companyName: 'Bravo', userId: 'u', organizationId: 'o',
});

beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
    state.membership = { status: 'loading' };
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('planLimitAudienceFor', () => {
    it('is undefined with the flag off, whatever the membership says', () => {
        expect(planLimitAudienceFor({ status: 'disabled' }, { role: 'foreman', planCode: 'employer_pro' })).toBeUndefined();
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        expect(planLimitAudienceFor(ready('foreman'))).toBeUndefined();
    });

    it('takes the role from a ready membership, over billing', () => {
        expect(planLimitAudienceFor(ready('foreman'), { role: 'owner', planCode: 'employer_free' }))
            .toEqual({ role: 'foreman', planCode: 'employer_free' });
        expect(planLimitAudienceFor(ready('owner'), { role: 'foreman', planCode: 'employer_pro' }))
            .toEqual({ role: 'owner', planCode: 'employer_pro' });
    });

    it('takes an error\'s billing role', () => {
        expect(planLimitAudienceFor({ status: 'error', billingRole: 'foreman' })).toEqual({ role: 'foreman', planCode: null });
    });

    it('falls back to billing\'s role while membership is unknown, else null', () => {
        expect(planLimitAudienceFor({ status: 'loading' }, { role: 'foreman' })).toEqual({ role: 'foreman', planCode: null });
        expect(planLimitAudienceFor({ status: 'error', billingRole: null }, null)).toEqual({ role: null, planCode: null });
    });

    it('a blocked membership is never read as the owner: no upgrade offered, with or without billing (M1)', () => {
        for (const reason of ['removed', 'suspended', 'no_organization'] as const) {
            const blocked: EmployerMembership = { status: 'blocked', reason, hasInvite: false };
            for (const billing of [undefined, null, { planCode: 'employer_free' }, { role: 'owner' as const, planCode: 'employer_free' }]) {
                const audience = planLimitAudienceFor(blocked, billing);
                expect(audience?.role).toBe('foreman');
                expect(upgradeOffered(audience)).toBe(false);
            }
        }
        expect(planLimitAudienceFor({ status: 'blocked', reason: 'removed', hasInvite: false }, { planCode: 'employer_pro' }))
            .toEqual({ role: 'foreman', planCode: 'employer_pro' });
    });
});

function Probe({ billing }: { billing?: AudienceBilling }) {
    const audience = usePlanLimitAudience(billing);
    return <pre data-testid="a">{JSON.stringify(audience ?? 'undefined')}</pre>;
}

describe('usePlanLimitAudience', () => {
    it('answers from the membership hook and the billing handed in', () => {
        state.membership = ready('foreman');
        render(<Probe billing={{ planCode: 'employer_pro', role: 'owner' }} />);
        expect(JSON.parse(screen.getByTestId('a').textContent ?? '')).toEqual({ role: 'foreman', planCode: 'employer_pro' });
    });

    it('is undefined with the flag off', () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        state.membership = { status: 'disabled' };
        render(<Probe billing={{ planCode: 'employer_pro', role: 'foreman' }} />);
        expect(screen.getByTestId('a').textContent).toBe('"undefined"');
    });
});
