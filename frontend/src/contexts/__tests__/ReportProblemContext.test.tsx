import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

/*
 * The provider: one verb (`openReport`), the sheet it mounts, the capture and
 * the config read it starts on the tap, the screens it records, and the
 * category hints components register while mounted.
 */

const { auth, route, capture, ctx } = vi.hoisted(() => ({
    auth: {
        state: {
            isAuthenticated: false,
            userType: null as 'worker' | 'employer' | null,
            getValidIdTokenOrNull: async () => 'fake-id-token' as string | null,
        },
    },
    route: { pathname: '/worker/home', params: {} as Record<string, string | string[]> },
    capture: { captureViewport: vi.fn(), redrawImage: vi.fn() },
    ctx: {
        recordScreen: vi.fn(),
        recordError: vi.fn(),
        recordRequest: vi.fn(),
        uninstall: vi.fn(),
        installErrorCapture: vi.fn(),
        collectReportContext: vi.fn(() => ({ v: 1 })),
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
    const { FakeScreenshotEditor } = await import('@/components/report/__tests__/fakes');
    return {
        captureViewport: (...args: unknown[]) => capture.captureViewport(...args),
        redrawImage: (...args: unknown[]) => capture.redrawImage(...args),
        ScreenshotEditor: FakeScreenshotEditor,
    };
});
vi.mock('@/components/report/seams/report-context', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/report/seams/report-context')>()),
    recordScreen: ctx.recordScreen,
    recordError: ctx.recordError,
    recordRequest: ctx.recordRequest,
    installErrorCapture: ctx.installErrorCapture,
    collectReportContext: ctx.collectReportContext,
}));

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import {
    ReportProblemProvider,
    useReportCategoryHint,
    useReportProblem,
    type OpenReportOptions,
} from '@/contexts/ReportProblemContext';
import { clearReportConfigCache } from '@/lib/api/reports';
import type { ReportCategory } from '@/lib/report/categories';

const BASE = 'https://example.test/api';
const fetchMock = vi.fn();

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

function Opener(props: OpenReportOptions) {
    const { openReport } = useReportProblem();
    return (
        <button type="button" onClick={() => openReport(props)}>
            open report
        </button>
    );
}

function Hint({ category }: { category: ReportCategory | null }) {
    useReportCategoryHint(category);
    return null;
}

function renderProvider(children: ReactNode = <Opener />) {
    const user = userEvent.setup();
    const view = renderIntl(<ReportProblemProvider>{children}</ReportProblemProvider>);
    return { user, ...view };
}

async function openAndReadCategory(user: ReturnType<typeof userEvent.setup>): Promise<string> {
    await user.click(screen.getByRole('button', { name: 'open report' }));
    const checked = await screen.findByRole('radio', { checked: true });
    return checked.getAttribute('value') ?? '';
}

beforeAll(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = BASE;
});

beforeEach(() => {
    vi.clearAllMocks();
    clearReportConfigCache();
    auth.state.isAuthenticated = false;
    auth.state.userType = null;
    route.pathname = '/worker/home';
    route.params = {};
    ctx.installErrorCapture.mockReturnValue(ctx.uninstall);
    capture.captureViewport.mockResolvedValue({ ok: false, reason: 'unsupported', ms: 0 });
    fetchMock.mockImplementation(async () =>
        new Response(JSON.stringify({ reporting: true, signed_out: true, screenshots: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('ReportProblemProvider', () => {
    it('opens the sheet at once, before the capture resolves, kept out of the capture', async () => {
        const pending = deferred<unknown>();
        capture.captureViewport.mockReturnValue(pending.promise);
        const { user } = renderProvider();

        await user.click(screen.getByRole('button', { name: 'open report' }));

        const dialog = screen.getByRole('dialog', { name: message('report_common.title') });
        expect(dialog.closest('[data-capture-exclude]')).not.toBeNull();
        // Both start on the tap: the picture of the screen and the switches.
        await waitFor(() => expect(capture.captureViewport).toHaveBeenCalledTimes(1));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(`${BASE}/public/reports/config`, expect.objectContaining({ method: 'GET' })),
        );
        // Still capturing, and the sheet is already usable.
        expect(await screen.findByRole('radio', { checked: true })).toBeInTheDocument();
        pending.resolve({ ok: false, reason: 'timeout', ms: 3000 });
    });

    it('does not replace a sheet that is already open', async () => {
        const { user } = renderProvider();
        await user.click(screen.getByRole('button', { name: 'open report' }));
        await screen.findByRole('radio', { checked: true });

        act(() => {
            // A second open while the first is up (the scrim covers the page,
            // so only code can do this) is ignored rather than restarting.
            screen.getByRole('button', { name: 'open report', hidden: true }).click();
        });
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        expect(capture.captureViewport).toHaveBeenCalledTimes(1);
    });

    it('installs the error capture while mounted, and removes it after', () => {
        const { unmount } = renderProvider();
        expect(ctx.installErrorCapture).toHaveBeenCalledTimes(1);
        unmount();
        expect(ctx.uninstall).toHaveBeenCalledTimes(1);
    });

    it('records each screen, as the locale-free path and its params without the locale', () => {
        route.pathname = '/worker/jobs/00000000-0000-4000-8000-00000000000a';
        route.params = { locale: 'es', id: '00000000-0000-4000-8000-00000000000a' };
        const { rerender } = renderProvider();
        expect(ctx.recordScreen).toHaveBeenLastCalledWith(
            '/worker/jobs/00000000-0000-4000-8000-00000000000a',
            { id: '00000000-0000-4000-8000-00000000000a' },
        );

        route.pathname = '/worker/applications';
        route.params = { locale: 'es' };
        rerender(<ReportProblemProvider><Opener /></ReportProblemProvider>);
        expect(ctx.recordScreen).toHaveBeenLastCalledWith('/worker/applications', {});
        expect(ctx.recordScreen).toHaveBeenCalledTimes(2);
    });

    it('records an error that a screen reports with', async () => {
        const { user } = renderProvider(<Opener error={{ kind: 'server', status: 503, code: 'internal' }} />);
        await user.click(screen.getByRole('button', { name: 'open report' }));
        expect(ctx.recordError).toHaveBeenCalledWith({ kind: 'api', message: expect.stringContaining('server 503 internal') });
    });
});

describe('the role and the starting category', () => {
    it('uses the signed-in role', async () => {
        auth.state.isAuthenticated = true;
        auth.state.userType = 'employer';
        route.pathname = '/employer/billing';
        const { user } = renderProvider();
        expect(await openAndReadCategory(user)).toBe('billing');
    });

    it('uses the sign-in screen the entry sits on when signed out', async () => {
        route.pathname = '/auth/employer';
        const { user } = renderProvider(<Opener role="employer" />);
        expect(await openAndReadCategory(user)).toBe('account');
    });

    it('falls back to the role the route implies, then to the worker list', async () => {
        route.pathname = '/digest-unsubscribe';
        const first = renderProvider();
        expect(await openAndReadCategory(first.user)).toBe('emails');
        first.unmount();

        route.pathname = '/upload/' + 'ab'.repeat(32);
        route.params = { token: 'ab'.repeat(32) };
        const second = renderProvider();
        expect(await openAndReadCategory(second.user)).toBe('uploads');
    });

    it('prefers the latest mounted hint over the route, and forgets it when unmounted', async () => {
        auth.state.isAuthenticated = true;
        auth.state.userType = 'worker';
        route.pathname = '/worker/profile';

        const withHints = renderProvider(
            <>
                <Hint category="applying" />
                <Hint category="uploads" />
                <Opener />
            </>,
        );
        expect(await openAndReadCategory(withHints.user)).toBe('uploads');
        withHints.unmount();

        const withoutHints = renderProvider(
            <>
                <Hint category={null} />
                <Opener />
            </>,
        );
        expect(await openAndReadCategory(withoutHints.user)).toBe('profile');
    });

    it('lets an explicit category win over hints and the route', async () => {
        auth.state.isAuthenticated = true;
        auth.state.userType = 'worker';
        route.pathname = '/worker/profile';
        const { user } = renderProvider(
            <>
                <Hint category="uploads" />
                <Opener category="sign_in" />
            </>,
        );
        expect(await openAndReadCategory(user)).toBe('sign_in');
    });
});
