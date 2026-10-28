// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import type { EmployerMembership } from '@/lib/employer-membership-store';

/*
 * Phase 3 (Task 14, fix round 1): a refused template save (403
 * template_limit_reached) speaks to who is saving. A foreman is told to ask
 * the owner and a Pro owner how to free a slot; neither is offered Upgrade.
 * Same stubs as TemplateEditModal.test.tsx, plus a controllable membership.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/lib/location-search', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/location-search')>()),
    queryLocations: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/api/payReference', () => ({
    getPayReference: vi.fn().mockResolvedValue(null),
}));

const { state, membershipCalls } = vi.hoisted(() => ({
    state: { membership: { status: 'loading' } as EmployerMembership },
    membershipCalls: { count: 0 },
}));
vi.mock('@/hooks/useEmployerMembership', () => ({
    useEmployerMembership: () => {
        membershipCalls.count += 1;
        return state.membership;
    },
}));

const saveJobTemplate = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    saveJobTemplate: (...args: unknown[]) => saveJobTemplate(...args),
}));

import { message, renderIntl } from './render-intl';
import { TemplateEditModal } from '../TemplateEditModal';
import { ApiError } from '@/lib/api/employer';
import type { JobTemplate } from '@/lib/api/employer';

const withCity: JobTemplate = {
    id: 'tpl-city',
    name: 'Roofer (El Paso)',
    updated_at: '2026-09-01T00:00:00Z',
    payload: {
        title: 'Roofer',
        location: 'El Paso, TX',
        job_type: 'full-time',
        trade_category: 'concrete',
        city_key: 'el-paso-tx',
        city: 'El Paso',
        state: 'TX',
    },
};

const ready = (role: 'owner' | 'foreman'): EmployerMembership => ({
    status: 'ready', role, companyName: 'Bravo', userId: 'u1', organizationId: 'o1',
});

const limit403 = (planCode: string) => new ApiError(403, 'template_limit_reached', { template_limit: 2, plan_code: planCode });
const upgradeLink = () => screen.queryByRole('link', { name: message('billing.limit_dialog.cta_upgrade') });

function save() {
    fireEvent.click(screen.getByRole('button', { name: message('employer_dashboard.templates.save') }));
}

beforeEach(() => {
    vi.clearAllMocks();
    membershipCalls.count = 0;
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
    state.membership = ready('owner');
    if (!Element.prototype.scrollIntoView) {
        Element.prototype.scrollIntoView = function scrollIntoView() {};
    }
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('TemplateEditModal: the template limit by who is saving', () => {
    it('a foreman is told to ask the owner, with no Upgrade', async () => {
        state.membership = ready('foreman');
        saveJobTemplate.mockRejectedValue(limit403('employer_free'));
        renderIntl(<TemplateEditModal open template={withCity} onClose={vi.fn()} onSaved={vi.fn()} />);

        save();

        await waitFor(() =>
            expect(screen.getByText(message('billing.limit_dialog.foreman_body'), { exact: false })).toBeInTheDocument());
        expect(upgradeLink()).toBeNull();
        expect(screen.getByRole('link', { name: message('billing.limit_dialog.cta_manage_templates') })).toBeInTheDocument();
    });

    it('a Pro owner (plan read off the 403) gets the Pro hint, with no Upgrade', async () => {
        saveJobTemplate.mockRejectedValue(limit403('employer_pro'));
        renderIntl(<TemplateEditModal open template={withCity} onClose={vi.fn()} onSaved={vi.fn()} />);

        save();

        await waitFor(() => expect(screen.getByText(message('billing.limit_dialog.pro_owner_hint'))).toBeInTheDocument());
        expect(upgradeLink()).toBeNull();
    });

    it('a Free owner keeps Upgrade', async () => {
        saveJobTemplate.mockRejectedValue(limit403('employer_free'));
        renderIntl(<TemplateEditModal open template={withCity} onClose={vi.fn()} onSaved={vi.fn()} />);

        save();

        await waitFor(() => expect(upgradeLink()).toBeInTheDocument());
    });

    it('flag off: Phase 2 copy, no membership hook', async () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        state.membership = ready('foreman');
        saveJobTemplate.mockRejectedValue(limit403('employer_free'));
        renderIntl(<TemplateEditModal open template={withCity} onClose={vi.fn()} onSaved={vi.fn()} />);

        save();

        await waitFor(() => expect(upgradeLink()).toBeInTheDocument());
        expect(membershipCalls.count).toBe(0);
    });
});
