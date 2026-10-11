import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

/*
 * Screens a URL cannot describe tell the report where to start, through
 * `useReportCategoryHint`, while they are in that state:
 * - a document upload hints "uploads" only while it runs or after it failed --
 *   the profile page at rest still starts on "profile";
 * - the work-photo composer hints "uploads" while it is open;
 * - the apply flow hints "applying" inside a job page (whose route says
 *   "finding jobs").
 * Real provider, real components; the API calls they make are faked.
 */

const { auth, route, workerApi } = vi.hoisted(() => ({
    auth: {
        state: {
            isAuthenticated: true,
            userType: 'worker' as 'worker' | 'employer' | null,
            getValidIdTokenOrNull: async () => 'fake-id-token' as string | null,
        },
    },
    route: { pathname: '/worker/profile', params: {} as Record<string, string | string[]> },
    workerApi: {
        getAuthUploadUrl: vi.fn(),
        confirmAuthUpload: vi.fn(),
        deleteVaultDocument: vi.fn(),
        uploadFileToS3: vi.fn(),
        getPostUploadUrls: vi.fn(),
        createPost: vi.fn(),
    },
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.state }));
vi.mock('@/i18n/navigation', () => ({
    usePathname: () => route.pathname,
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));
vi.mock('next/navigation', async (importOriginal) => ({
    ...(await importOriginal<typeof import('next/navigation')>()),
    useParams: () => route.params,
}));
vi.mock('@/components/report/seams/report-capture', async () => {
    const { FakeScreenshotEditor } = await import('./fakes');
    return {
        captureViewport: async () => ({ ok: false, reason: 'unsupported', ms: 0 }),
        redrawImage: async () => {
            throw new Error('fake: no redraw');
        },
        ScreenshotEditor: FakeScreenshotEditor,
    };
});
vi.mock('@/lib/api/worker', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/worker')>()),
    ...workerApi,
}));

import { renderIntl } from '@/components/employer/__tests__/render-intl';
import { ReportProblemProvider, useReportProblem } from '@/contexts/ReportProblemContext';
import { ToastProvider } from '@/components/ui/toast';
import { clearReportConfigCache } from '@/lib/api/reports';
import { DocumentSlot } from '@/components/worker/DocumentSlot';
import { NewPostModal } from '@/components/media-board/NewPostModal';
import { ApplyFlow } from '@/components/worker/apply-flow/ApplyFlow';
import { initialApplyFlowState } from '@/lib/apply-flow-view';
import type { JobDetail } from '@/lib/api/worker';

function Opener() {
    const { openReport } = useReportProblem();
    return (
        <button type="button" onClick={() => openReport()}>
            open report
        </button>
    );
}

function renderWithReport(ui: ReactNode) {
    return renderIntl(
        <ReportProblemProvider>
            <ToastProvider>
                {ui}
                <Opener />
            </ToastProvider>
        </ReportProblemProvider>,
    );
}

/** Opens the report the way code would (a modal may cover the page) and reads the starting category. */
async function startingCategory(): Promise<string> {
    act(() => {
        screen.getByRole('button', { name: 'open report', hidden: true }).click();
    });
    const checked = await screen.findByRole('radio', { checked: true });
    return checked.getAttribute('value') ?? '';
}

function chooseDocument(container: HTMLElement) {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('no file input');
    fireEvent.change(input, { target: { files: [new File(['x'], 'fake.pdf', { type: 'application/pdf' })] } });
}

beforeAll(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://example.test/api';
});

beforeEach(() => {
    vi.clearAllMocks();
    clearReportConfigCache();
    route.pathname = '/worker/profile';
    route.params = {};
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ reporting: true, signed_out: true, screenshots: true }), { status: 200 })),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('category hints', () => {
    it('the profile page at rest starts on "profile"', async () => {
        renderWithReport(<DocumentSlot token="fake-token" doc_type="resume" onChange={() => {}} />);
        expect(await startingCategory()).toBe('profile');
    });

    it('a document upload in progress starts on "uploads"', async () => {
        workerApi.getAuthUploadUrl.mockReturnValue(new Promise(() => {}));
        const { container } = renderWithReport(<DocumentSlot token="fake-token" doc_type="resume" onChange={() => {}} />);
        chooseDocument(container);
        expect(await startingCategory()).toBe('uploads');
    });

    it('a document upload that failed starts on "uploads"', async () => {
        workerApi.getAuthUploadUrl.mockRejectedValue(new Error('fake upload failure'));
        const { container } = renderWithReport(<DocumentSlot token="fake-token" doc_type="resume" onChange={() => {}} />);
        chooseDocument(container);
        await screen.findByRole('alert');
        expect(await startingCategory()).toBe('uploads');
    });

    it('the work-photo composer, while open, starts on "uploads"', async () => {
        renderWithReport(<NewPostModal token="fake-token" onClose={() => {}} onCreated={() => {}} />);
        expect(await startingCategory()).toBe('uploads');
    });

    it('the apply flow inside a job page starts on "applying"', async () => {
        route.pathname = '/worker/jobs/00000000-0000-4000-8000-00000000000a';
        route.params = { id: '00000000-0000-4000-8000-00000000000a' };
        const job = {
            id: '00000000-0000-4000-8000-00000000000a',
            title: 'Fake job',
            company_name: 'Fake company',
            location: 'Fake city',
            job_type: 'full-time',
            required_docs: [],
            created_at: '2026-08-28T00:00:00Z',
            description: null,
            already_applied: false,
            application_status: null,
            missing_docs: [],
            pre_application_prompts: [],
        } as unknown as JobDetail;
        renderWithReport(
            <ApplyFlow
                job={job}
                state={initialApplyFlowState()}
                dispatch={() => {}}
                onSubmit={() => {}}
                submitting={false}
                submitError={null}
                onBackToDetails={() => {}}
            />,
        );
        expect(await startingCategory()).toBe('applying');
    });

    it('a job page without the apply flow still starts on "finding jobs"', async () => {
        const user = userEvent.setup();
        route.pathname = '/worker/jobs/00000000-0000-4000-8000-00000000000a';
        route.params = { id: '00000000-0000-4000-8000-00000000000a' };
        renderWithReport(null);
        await user.click(screen.getByRole('button', { name: 'open report' }));
        expect((await screen.findByRole('radio', { checked: true })).getAttribute('value')).toBe('finding_jobs');
    });
});
