// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { Applicant, EmployerJobDetail } from '@/lib/api/employer';
import { isMaskedForCapture } from './marks-helpers';

/*
 * The employer's job page with its applicants: an applicant's answers to the
 * job's questions and to its requirement fields (date of birth, home
 * address, pay, work authorization...) are hidden in a report screenshot. The
 * harness mirrors the page's facts-card suite. All values are fake.
 */

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
const auth = { idToken: 'test-token' };
const requireAuth = {
    handleLegalWall: (err: unknown) => {
        throw err;
    },
};

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: '11111111-2222-4333-8444-555555555555', locale: 'en' }),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => router,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useRequireAuth', () => ({ useRequireAuth: () => requireAuth }));
vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/employer/EditJobModal', () => ({ EditJobModal: () => null }));
vi.mock('@/components/employer/PublicListingCard', () => ({ PublicListingCard: () => <div /> }));
vi.mock('@/components/employer/ApplicantFilterPanel', () => ({
    ApplicantFilterPanel: () => <div />,
    EMPTY_APPLICANT_FILTERS: {},
    hasActiveApplicantFilters: () => false,
}));
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getJob: vi.fn(),
    getJobApplicants: vi.fn(async () => ({ applicants: [] })),
    getJobCandidates: vi.fn(async () => []),
    getJobs: vi.fn(async () => []),
    deleteJob: vi.fn(),
    startConversation: vi.fn(),
    updateApplicantStatus: vi.fn(),
    updateJobStatus: vi.fn(),
}));

let pageData: { job: EmployerJobDetail; applicants: Applicant[]; appliedFilters: object };
// One stable function: the page's effects depend on these, and a fresh one per
// render would re-run them forever.
const noop = vi.fn();
vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready' as const,
        data: pageData,
        errorKind: null,
        refreshing: false,
        refreshError: false,
        retry: noop,
        refresh: noop,
        setData: noop,
    }),
}));

import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import EmployerJobDetailPage from '@/app/[locale]/employer/jobs/[id]/page';

const JOB = {
    id: '11111111-2222-4333-8444-555555555555',
    title: 'Test Job',
    location: 'Testville, TX',
    pay: null,
    job_type: 'full-time',
    status: 'active',
    applicant_count: 1,
    hired_count: 0,
    open_count: 1,
    hire_details_needed_count: 0,
    pay_min: null,
    pay_max: null,
    pay_interval: null,
    start_date: null,
    expected_duration: null,
    shift_schedule: null,
    transportation_required: false,
    work_authorization_required: true,
    language_preference: [],
    number_of_workers_needed: 1,
    trade_category: null,
    required_experience_years: null,
    required_experience_months: null,
    certifications: [],
    created_at: '2026-06-01T15:00:00.000Z',
    description: null,
    required_docs: [],
    public_code: 'ABC123',
    public_listing_enabled: false,
} as EmployerJobDetail;

const APPLICANT = {
    application_id: 'a1',
    worker_id: 'w1',
    full_name: 'Test Applicant',
    phone: null,
    status: 'applied',
    applied_at: '2026-06-02T15:00:00.000Z',
    skills: [],
    availability: null,
    years_experience: null,
    location: null,
    application_answers: {
        date_of_birth: '1990-01-01',
        home_address: { street: '123 Example Street', city: 'Testville', state: 'TX', zip: '00000' },
        desired_pay: { amount: 99, interval: 'hourly' },
    },
    prompt_answers: [{ prompt_id: 'p1', question: 'Fake question for applicants?', text: 'Fake applicant answer words' }],
    hire_details: null,
    hire_details_needed: false,
} as unknown as Applicant;

describe('employer job page applicants: capture marks', () => {
    it('hides the answers to the job questions and to the requirement fields', () => {
        pageData = { job: JOB, applicants: [APPLICANT], appliedFilters: {} };
        renderIntl(<EmployerJobDetailPage />);
        expect(isMaskedForCapture(screen.getByText('Fake applicant answer words'))).toBe(true);
        expect(isMaskedForCapture(screen.getByText('1990-01-01'))).toBe(true);
        expect(isMaskedForCapture(screen.getByText(/123 Example Street/))).toBe(true);
        expect(isMaskedForCapture(screen.getByText(/\$99/))).toBe(true);
    });

    it('leaves the applicant name and the question visible', () => {
        pageData = { job: JOB, applicants: [APPLICANT], appliedFilters: {} };
        renderIntl(<EmployerJobDetailPage />);
        expect(isMaskedForCapture(screen.getByText('Fake question for applicants?'))).toBe(false);
        expect(isMaskedForCapture(screen.getAllByText('Test Applicant')[0])).toBe(false);
    });
});
