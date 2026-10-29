// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import type { JobDetail } from '@/lib/api/worker';
import { renderIntl, message, expectNoRawMessageKeys } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * Phase 4: a worker who applied sees which person at the company is
 * responsible for the job, as one "Contact: {name}" line under the job's header
 * block. The API only sends the name to an applicant; the page additionally
 * hides it when it is empty or just the company's name again, and never shows
 * a phone. Rendered against the real catalogues so the copy is pinned in en
 * and es.
 */

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: 'job-1', locale: 'en' }),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    useRouter: () => ({ back: vi.fn() }),
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => {
            throw err;
        },
    }),
}));

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/PayReferenceHint', () => ({
    PayReferenceHint: () => null,
}));

vi.mock('@/components/worker/ShareJobPanel', () => ({
    ShareJobPanel: () => <div data-testid="share-job" />,
}));

vi.mock('@/components/worker/ProfileCompleteModal', () => ({
    ProfileCompleteModal: () => null,
}));

vi.mock('@/components/worker/apply-flow/ApplyFlow', () => ({
    ApplyFlow: () => <div data-testid="apply-flow" />,
}));

vi.mock('@/lib/api/worker', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/worker')>()),
    getJob: vi.fn(),
    applyToJob: vi.fn(),
    updateWorkerProfile: vi.fn(),
    getVaultDocuments: vi.fn(async () => []),
    recordJobView: vi.fn(),
    getApplications: vi.fn(async () => ({
        applications: [],
        next_cursor: null,
        attention: { details_requested: [], unacknowledged_hires: [] },
    })),
}));

/** Assigned by each test before rendering; the fake hook serves it. */
let seed: JobDetail;

vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready' as const,
        data: seed,
        errorKind: null,
        refreshing: false,
        refreshError: false,
        retry: vi.fn(),
        refresh: vi.fn(),
        setData: vi.fn(),
    }),
}));

import WorkerJobDetailPage from '../page';

function job(over: Partial<JobDetail> = {}): JobDetail {
    return {
        id: 'job-1',
        title: 'Helper',
        location: 'Austin, TX',
        job_type: 'full-time',
        company_name: 'NB Construction',
        required_docs: [],
        missing_docs: [],
        created_at: '2026-06-01T15:00:00.000Z',
        description: null,
        status: 'active',
        already_applied: true,
        application_status: 'pending',
        ...over,
    };
}

describe('worker job detail -- the contact line', () => {
    it('shows "Contact: {name}" to an applicant', () => {
        seed = job({ contact_name: 'Fer Gómez' });
        renderIntl(<WorkerJobDetailPage />);

        expect(screen.getByText('Contact: Fer Gómez')).toBeInTheDocument();
        expect(screen.getByText(message('worker_job_detail.contact').replace('{name}', 'Fer Gómez'))).toBeInTheDocument();
        expectNoRawMessageKeys();
    });

    it('says it in Spanish', () => {
        seed = job({ contact_name: 'Fer Gómez' });
        renderIntl(<WorkerJobDetailPage />, 'es');

        expect(screen.getByText('Contacto: Fer Gómez')).toBeInTheDocument();
        expect(screen.queryByText('Contact: Fer Gómez')).toBeNull();
    });

    it('renders nothing when the name is null', () => {
        seed = job({ contact_name: null });
        renderIntl(<WorkerJobDetailPage />);
        expect(screen.queryByText(/Contact:/)).toBeNull();
    });

    it('renders nothing when the key is absent (an older payload) or the name is blank', () => {
        seed = job();
        const first = renderIntl(<WorkerJobDetailPage />);
        expect(screen.queryByText(/Contact:/)).toBeNull();
        first.unmount();

        seed = job({ contact_name: '   ' });
        renderIntl(<WorkerJobDetailPage />);
        expect(screen.queryByText(/Contact:/)).toBeNull();
    });

    it('renders nothing when the name is just the company, whatever its case or padding', () => {
        seed = job({ contact_name: '  nb construction ' });
        renderIntl(<WorkerJobDetailPage />);
        expect(screen.queryByText(/Contact:/)).toBeNull();
    });

    it('compares on whitespace-collapsed values on both sides', () => {
        seed = job({ company_name: 'NB  Construction', contact_name: ' nb \n construction' });
        const first = renderIntl(<WorkerJobDetailPage />);
        expect(screen.queryByText(/Contact:/)).toBeNull();
        first.unmount();

        seed = job({ company_name: 'NB Construction', contact_name: 'NB  Construction' });
        renderIntl(<WorkerJobDetailPage />);
        expect(screen.queryByText(/Contact:/)).toBeNull();
    });

    it('wraps a long name instead of overflowing', () => {
        seed = job({ contact_name: 'A'.repeat(80) });
        renderIntl(<WorkerJobDetailPage />);
        expect(screen.getByText(`Contact: ${'A'.repeat(80)}`)).toHaveClass('break-words');
    });

    it('shows the name only: no phone, no email', () => {
        seed = job({ contact_name: 'Fer Gómez' });
        const { container } = renderIntl(<WorkerJobDetailPage />);

        const line = screen.getByText('Contact: Fer Gómez');
        expect(line.textContent).toBe('Contact: Fer Gómez');
        expect(container.querySelector('a[href^="tel:"]')).toBeNull();
        expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    });
});
