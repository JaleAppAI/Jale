// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { EmployerProfileData } from '@/lib/api/employer';
import type { WorkerProfileData } from '@/lib/api/worker';
import { isMaskedForCapture } from './marks-helpers';

/*
 * The two own-profile pages: the phone and the email are hidden in a report
 * screenshot, the name stays. The harness mirrors the pages' facts-card
 * suites; one fake data hook serves whichever page is rendered. All values
 * are fake.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    redirect: vi.fn(),
    usePathname: () => '/profile',
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: 'test-token' }) }));
vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/employer/DigestSettingsPanel', () => ({ DigestSettingsPanel: () => <div /> }));
vi.mock('@/components/worker/DocumentSlot', () => ({ DocumentSlot: () => <div /> }));
vi.mock('@/components/media-board/MediaBoardGrid', () => ({ MediaBoardGrid: () => <div /> }));
vi.mock('@/components/media-board/PostLightbox', () => ({ PostLightbox: () => null }));
vi.mock('@/components/media-board/NewPostModal', () => ({ NewPostModal: () => null }));
vi.mock('@/components/PayReferenceHint', () => ({ PayReferenceHint: () => <div /> }));

let seed: unknown;
vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready' as const,
        data: seed,
        empty: false,
        errorKind: null,
        refreshing: false,
        refreshError: null,
        retry: vi.fn(),
        refresh: vi.fn(),
        setData: vi.fn(),
    }),
}));

import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import EmployerProfilePage from '@/app/[locale]/employer/profile/page';
import WorkerProfilePage from '@/app/[locale]/worker/profile/page';

const EMPLOYER: EmployerProfileData = {
    id: '9c2f7b41-8e3d-4a56-b107-5d4e9f2a6c38',
    user_type: 'employer',
    email: 'contact@example.invalid',
    phone: '+15555550188',
    full_name: 'Test Company LLC',
    tenant_id: null,
    created_at: '2026-01-14T10:00:00.000Z',
    company_name: 'Test Company LLC',
    contact_name: 'Test Contact',
    city: 'Testville, TX',
    service_area: 'Test area',
    hiring_trades: ['electrician'],
    typical_job_types: ['full-time'],
    company_size: '11-50',
    company_description: 'Fake description.',
};

const WORKER: WorkerProfileData = {
    id: '3f1c9a52-6d2b-4e18-9a44-7c0e5b8d1f23',
    phone: '+15555550143',
    full_name: 'Test Worker',
    skills: ['Conduit bending'],
    availability: 'full_time',
    years_experience: 9,
    location: 'Testville, TX',
    bio: 'Fake bio.',
    certifications: [],
    preferred_cities: [],
    main_trade: 'electrician',
    main_trade_other: null,
};

describe('employer profile: capture marks', () => {
    it('hides the email and the phone, and leaves the contact name', () => {
        seed = EMPLOYER;
        renderIntl(<EmployerProfilePage />);
        expect(isMaskedForCapture(screen.getByText('contact@example.invalid'))).toBe(true);
        expect(isMaskedForCapture(screen.getByText('+15555550188'))).toBe(true);
        expect(isMaskedForCapture(screen.getByText('Test Contact'))).toBe(false);
    });
});

describe('worker profile: capture marks', () => {
    it('hides the phone, and leaves the name', () => {
        seed = { profile: WORKER, docs: [], posts: [], next_before: null, next_before_id: null };
        renderIntl(<WorkerProfilePage />);
        expect(isMaskedForCapture(screen.getByText('+15555550143'))).toBe(true);
        expect(isMaskedForCapture(screen.getAllByText('Test Worker')[0])).toBe(false);
    });
});
