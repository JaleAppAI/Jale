// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import type { EmployerProfileData } from '@/lib/api/employer';
import type { EmployerMembership } from '@/lib/employer-membership-store';

/*
 * Phase 3 (Task 14): a foreman's settings. The company's details are the
 * owner's (the API answers 403 owner_required to a foreman PATCH naming any of
 * them), so a foreman sees the company's name read-only, none of the other
 * company fields, and edits only their own contact name and phone.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    redirect: vi.fn(),
    usePathname: () => '/employer/profile',
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/employer/DigestSettingsPanel', () => ({
    DigestSettingsPanel: () => <div data-digest-panel="stub" />,
}));

const { state, useEmployerMembership, updateEmployerProfile } = vi.hoisted(() => ({
    state: { membership: { status: 'loading' } as EmployerMembership },
    useEmployerMembership: vi.fn(),
    updateEmployerProfile: vi.fn(),
}));

vi.mock('@/hooks/useEmployerMembership', () => ({
    useEmployerMembership: () => {
        useEmployerMembership();
        return state.membership;
    },
}));

vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    updateEmployerProfile: (...args: unknown[]) => updateEmployerProfile(...args),
}));

type Profile = EmployerProfileData & { role?: 'owner' | 'foreman'; companyName?: string | null };

/** Assigned by each test before rendering; the fake hook keeps what `setData` writes. */
let seed: Profile;

vi.mock('@/hooks/usePageData', async () => {
    const react = await import('react');
    return {
        usePageData: () => {
            const [data, setState] = react.useState<Profile>(() => seed);
            return {
                phase: 'ready' as const,
                data,
                empty: false,
                errorKind: null,
                refreshing: false,
                refreshError: null,
                retry: vi.fn(),
                refresh: vi.fn(),
                setData: (next: Profile) => setState(next),
            };
        },
    };
});

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import EmployerProfilePage from '../page';

/*
 * A foreman's own row carries no company fields; what is shown as the company
 * comes from the membership (`companyName`). The row here does carry some, to
 * prove the page never shows a foreman's stale copy of them.
 */
const FOREMAN_ROW: Profile = {
    id: '1b0c7a52-4d4e-4f0a-9a57-0c8a3e7f2d11',
    user_type: 'employer',
    email: 'luis@bravo-construccion.com',
    phone: '+15125550100',
    full_name: 'Luis Ortega',
    tenant_id: null,
    created_at: '2026-10-20T10:00:00.000Z',
    company_name: 'Stale Row Name',
    contact_name: 'Luis Ortega',
    city: 'Austin, TX',
    service_area: 'Greater Austin',
    hiring_trades: ['concrete'],
    typical_job_types: ['contract'],
    company_size: '11-50',
    company_description: 'Not the foreman\'s to show.',
    role: 'foreman',
    companyName: 'Bravo Construccion LLC',
};

const OWNER_ROW: Profile = { ...FOREMAN_ROW, role: 'owner', company_name: 'Bravo Construccion LLC' };

const FOREMAN: EmployerMembership = {
    status: 'ready',
    role: 'foreman',
    companyName: 'Bravo Construccion LLC',
    userId: 'u2',
    organizationId: 'o1',
};

const K = {
    company: message('employer.profile.field_company'),
    size: message('employer.profile.field_company_size'),
    city: message('employer.profile.field_city'),
    serviceArea: message('employer.profile.field_service_area'),
    contact: message('employer.profile.field_contact'),
    phone: message('employer.profile.field_phone'),
    trades: message('employer.profile.field_hiring_trades'),
    jobTypes: message('employer.profile.field_job_types'),
    description: message('employer.profile.field_description'),
    hint: message('employer.profile.foreman_company_hint'),
    edit: message('employer.profile.edit_button'),
    save: message('employer.profile.save'),
};

function startEditing() {
    fireEvent.click(screen.getByRole('button', { name: K.edit }));
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
    state.membership = FOREMAN;
    seed = FOREMAN_ROW;
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('employer profile -- a foreman', () => {
    it('a foreman edits only contact name and phone; company fields are read-only', () => {
        renderIntl(<EmployerProfilePage />);

        // Read-only view: the company's name (from the membership), the hint,
        // and none of the other company fields.
        expect(screen.getAllByText('Bravo Construccion LLC').length).toBeGreaterThan(0);
        expect(screen.queryByText('Stale Row Name')).toBeNull();
        expect(screen.getByText(K.hint)).toBeInTheDocument();
        for (const label of [K.size, K.city, K.serviceArea, K.trades, K.jobTypes, K.description]) {
            expect(screen.queryByText(label), label).toBeNull();
        }
        expect(screen.getByText(K.contact, { selector: 'dt' })).toBeInTheDocument();

        startEditing();

        expect(screen.getByLabelText(K.contact)).toBeInTheDocument();
        expect(screen.getByLabelText(K.phone)).toBeInTheDocument();
        expect(screen.queryByLabelText(K.company)).toBeNull();
        expect(screen.queryByLabelText(K.serviceArea)).toBeNull();
        expect(screen.queryByLabelText(K.size)).toBeNull();
        expect(screen.queryByLabelText(K.description)).toBeNull();
        expect(screen.queryByText(K.city)).toBeNull();
        expect(screen.queryByText(K.trades)).toBeNull();
        // The company still reads as read-only text, with who can change it.
        expect(screen.getAllByText('Bravo Construccion LLC').length).toBeGreaterThan(0);
        expect(screen.getByText(K.hint)).toBeInTheDocument();
        expect(screen.getAllByRole('textbox')).toHaveLength(2);
    });

    it('the foreman\'s submit body has only contact_name and phone', async () => {
        updateEmployerProfile.mockResolvedValue({ ...FOREMAN_ROW, contact_name: 'Luis O.' });
        renderIntl(<EmployerProfilePage />);
        startEditing();

        fireEvent.change(screen.getByLabelText(K.contact), { target: { value: '  Luis O.  ' } });
        fireEvent.click(screen.getByRole('button', { name: K.save }));

        await waitFor(() => expect(updateEmployerProfile).toHaveBeenCalledTimes(1));
        expect(updateEmployerProfile.mock.calls[0][0]).toBe('test-token');
        expect(updateEmployerProfile.mock.calls[0][1]).toEqual({ contact_name: 'Luis O.', phone: '+15125550100' });
    });

    it('validates only the two fields a foreman can edit', async () => {
        renderIntl(<EmployerProfilePage />);
        startEditing();

        fireEvent.change(screen.getByLabelText(K.contact), { target: { value: ' ' } });
        fireEvent.click(screen.getByRole('button', { name: K.save }));

        await waitFor(() => expect(screen.getByText(message('employer.profile.errors.required'))).toBeInTheDocument());
        expect(screen.getAllByText(message('employer.profile.errors.required'))).toHaveLength(1);
        expect(updateEmployerProfile).not.toHaveBeenCalled();
    });

    it('keeps role and companyName after a save (the PATCH response carries both)', async () => {
        // The membership has not answered: the page reads the role off the profile.
        state.membership = { status: 'loading' };
        updateEmployerProfile.mockResolvedValue({ ...FOREMAN_ROW, contact_name: 'Luis O.' });
        renderIntl(<EmployerProfilePage />);
        startEditing();

        fireEvent.change(screen.getByLabelText(K.contact), { target: { value: 'Luis O.' } });
        fireEvent.click(screen.getByRole('button', { name: K.save }));

        await waitFor(() => expect(screen.getByText(message('common.feedback.saved'))).toBeInTheDocument());
        expect(screen.getByText('Luis O.')).toBeInTheDocument();
        // Still the foreman's view, still the company's name.
        expect(screen.getAllByText('Bravo Construccion LLC').length).toBeGreaterThan(0);
        expect(screen.getByText(K.hint)).toBeInTheDocument();
        expect(screen.queryByText(K.city)).toBeNull();
    });

    it('a blocked login is read-only, even on a row that says owner', () => {
        state.membership = { status: 'blocked', reason: 'suspended', hasInvite: false };
        seed = OWNER_ROW;
        renderIntl(<EmployerProfilePage />);

        expect(screen.getByText(K.hint)).toBeInTheDocument();
        expect(screen.queryByText(K.city)).toBeNull();
        startEditing();
        expect(screen.queryByLabelText(K.company)).toBeNull();
        expect(screen.getAllByRole('textbox')).toHaveLength(2);
    });

    it('a membership error naming billing role foreman is read-only (a profile without a role)', () => {
        state.membership = { status: 'error', billingRole: 'foreman' };
        seed = { ...FOREMAN_ROW, role: undefined };
        renderIntl(<EmployerProfilePage />);

        expect(screen.getByText(K.hint)).toBeInTheDocument();
        expect(screen.queryByText(K.city)).toBeNull();
        startEditing();
        expect(screen.queryByLabelText(K.company)).toBeNull();
        expect(screen.getAllByRole('textbox')).toHaveLength(2);
    });

    it('a membership error with an unknown billing role (and no profile role) is the owner\'s view', () => {
        state.membership = { status: 'error', billingRole: null };
        seed = { ...OWNER_ROW, role: undefined };
        renderIntl(<EmployerProfilePage />);

        expect(screen.queryByText(K.hint)).toBeNull();
        expect(screen.getByText(K.city, { selector: 'dt' })).toBeInTheDocument();
    });

    it('the owner\'s view is unchanged', () => {
        state.membership = { ...FOREMAN, role: 'owner' } as EmployerMembership;
        seed = OWNER_ROW;
        renderIntl(<EmployerProfilePage />);

        expect(screen.queryByText(K.hint)).toBeNull();
        expect(screen.getByText(K.city, { selector: 'dt' })).toBeInTheDocument();
        expect(screen.getByText(K.trades, { selector: 'dt' })).toBeInTheDocument();
        startEditing();
        expect(screen.getByLabelText(K.company)).toBeInTheDocument();
        expect(screen.getByLabelText(K.serviceArea)).toBeInTheDocument();
    });

    it('flag off: exactly Phase 2, and no membership hook', () => {
        vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
        renderIntl(<EmployerProfilePage />);

        expect(useEmployerMembership).not.toHaveBeenCalled();
        expect(screen.queryByText(K.hint)).toBeNull();
        expect(screen.getByText(K.city, { selector: 'dt' })).toBeInTheDocument();
        startEditing();
        expect(screen.getByLabelText(K.company)).toBeInTheDocument();
    });
});
