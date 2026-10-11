import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

/*
 * The report flow end to end, through the provider, the real API client and
 * the real `apiFetch`, against a mocked `fetch`. The capture and the context
 * come in through their seams, mocked here, so each test decides what the
 * screenshot did.
 */

const { auth, route, capture, ctx } = vi.hoisted(() => ({
    auth: {
        state: {
            isAuthenticated: false,
            userType: null as 'worker' | 'employer' | null,
            getValidIdTokenOrNull: vi.fn(async (): Promise<string | null> => 'fake-id-token'),
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
        collectReportContext: vi.fn(),
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

import { interpolate, message, renderIntl, type TestLocale } from '@/components/employer/__tests__/render-intl';
import { ReportProblemProvider, useReportProblem, type OpenReportOptions } from '@/contexts/ReportProblemContext';
import { clearReportConfigCache } from '@/lib/api/reports';
import { SUPPORT_CONTACT } from '@/lib/support-contact';
import { mountedEditors, PAINTED_IMAGE_SIZE } from './fakes';

const BASE = 'https://example.test/api';
const STORAGE_URL = 'https://uploads.example.test/';
const GRANT = { url: STORAGE_URL, fields: { key: 'incoming/fake-key', Policy: 'fake-policy' }, expires_at: '2026-10-02T12:10:00Z' };
const CONTEXT = {
    v: 1,
    screen: { pattern: '/worker/home' },
    app: { build: 'fake-build', locale: 'en' },
    device: {
        kind: 'phone', browser: 'safari', os: 'ios', viewport: [390, 844], online: true,
        tz: 'America/Chicago', local_time: '2026-10-02T09:00:00-05:00',
    },
    requests: [{ m: 'POST', p: '/worker/jobs/:id/apply', s: 500, ms: 2100 }],
    errors: [{ k: 'api', msg: '500 internal', at: '2026-10-02T14:00:00Z' }],
};

// ---------------------------------------------------------------------------
// fetch, routed by method and URL; the config read answers "all on" unless a
// test queues something else.
// ---------------------------------------------------------------------------

type Reply = Response | ((init: RequestInit) => Response | Promise<Response>);
const fetchMock = vi.fn();
let queues: Record<string, Reply[]> = {};

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function queue(method: string, url: string, ...replies: Reply[]) {
    const key = `${method} ${url.startsWith('http') ? url : BASE + url}`;
    (queues[key] ??= []).push(...replies);
}

function created(extra: Record<string, unknown> = {}): Response {
    return json(201, {
        number: 'JR-1042',
        report_id: 'fake-report-id',
        attach_token: 'fake-attach-token',
        upload: null,
        replayed: false,
        ...extra,
    });
}

function callsTo(method: string, url: string): Array<{ init: RequestInit; body: unknown }> {
    const target = url.startsWith('http') ? url : BASE + url;
    return fetchMock.mock.calls
        .filter(([input, init]) => String(input) === target && ((init as RequestInit | undefined)?.method ?? 'GET') === method)
        .map(([, init]) => {
            const body = (init as RequestInit).body;
            return { init: init as RequestInit, body: typeof body === 'string' ? JSON.parse(body) : body };
        });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function Opener(props: OpenReportOptions) {
    const { openReport } = useReportProblem();
    return (
        <button type="button" onClick={() => openReport(props)}>
            open report
        </button>
    );
}

function setup({ locale = 'en', open = {} }: { locale?: TestLocale; open?: OpenReportOptions } = {}) {
    const user = userEvent.setup();
    renderIntl(
        <ReportProblemProvider>
            <Opener {...open} />
        </ReportProblemProvider>,
        locale,
    );
    const t = (path: string, values?: Record<string, string | number>) =>
        values ? interpolate(message(path, locale), values) : message(path, locale);
    return { user, t };
}

type User = ReturnType<typeof userEvent.setup>;

async function openToDetails(user: User, t: (path: string) => string) {
    await user.click(screen.getByRole('button', { name: 'open report' }));
    await screen.findByRole('radio', { checked: true });
    await user.click(screen.getByRole('button', { name: t('report_common.next') }));
    return screen.findByRole('textbox', { name: new RegExp(t('report_common.description_label').replace(/[?¿]/g, '.')) });
}

function signIn(role: 'worker' | 'employer') {
    auth.state.isAuthenticated = true;
    auth.state.userType = role;
}

beforeAll(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = BASE;
});

beforeEach(() => {
    vi.clearAllMocks();
    clearReportConfigCache();
    mountedEditors.length = 0;
    queues = {};
    auth.state.isAuthenticated = false;
    auth.state.userType = null;
    auth.state.getValidIdTokenOrNull.mockResolvedValue('fake-id-token');
    route.pathname = '/worker/home';
    route.params = {};
    ctx.installErrorCapture.mockReturnValue(ctx.uninstall);
    ctx.collectReportContext.mockReturnValue(CONTEXT);
    capture.captureViewport.mockResolvedValue({ ok: false, reason: 'unsupported', ms: 0 });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const key = `${init.method ?? 'GET'} ${String(input)}`;
        const replies = queues[key];
        if (!replies || replies.length === 0) {
            if (key === `GET ${BASE}/public/reports/config`) {
                return json(200, { reporting: true, signed_out: true, screenshots: true });
            }
            throw new Error(`unexpected request: ${key}`);
        }
        const reply = replies.length > 1 ? replies.shift()! : replies[0];
        return typeof reply === 'function' ? reply(init) : reply.clone();
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('step 1: the category', () => {
    it("starts on the category for the screen, from the role's list", async () => {
        signIn('worker');
        route.pathname = '/worker/applications';
        const { user, t } = setup();
        await user.click(screen.getByRole('button', { name: 'open report' }));

        const group = await screen.findByRole('group', { name: t('report_common.category_legend') });
        const radios = within(group).getAllByRole('radio');
        expect(radios.map((radio) => radio.getAttribute('value'))).toEqual([
            'sign_in', 'finding_jobs', 'applying', 'uploads', 'profile', 'whatsapp', 'other',
        ]);
        expect(within(group).getByRole('radio', { name: t('report_worker.categories.applying') })).toBeChecked();
        expect(screen.getByText(t('report_worker.category_hint'))).toBeInTheDocument();

        // Choosing another drops the "chosen for you" line: it is no longer true.
        await user.click(within(group).getByRole('radio', { name: t('report_worker.categories.other') }));
        expect(screen.queryByText(t('report_worker.category_hint'))).toBeNull();
    });

    it("gives employers the employer list", async () => {
        signIn('employer');
        route.pathname = '/employer/conversations';
        const { user, t } = setup();
        await user.click(screen.getByRole('button', { name: 'open report' }));
        expect(await screen.findByRole('radio', { name: t('report_employer.categories.messages') })).toBeChecked();
        expect(screen.getAllByRole('radio')).toHaveLength(8);
    });
});

describe('step 2: what happened', () => {
    it('requires a description and says how to fix it, without sending', async () => {
        signIn('worker');
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        expect(description).toHaveFocus();
        expect(description).toBeRequired();
        expect(description).toHaveAttribute('maxlength', '2000');

        await user.click(screen.getByRole('button', { name: t('report_common.send') }));

        expect(await screen.findByText(t('report_worker.description_error'))).toBeInTheDocument();
        expect(description).toHaveAttribute('aria-invalid', 'true');
        expect(description).toHaveFocus();
        expect(callsTo('POST', '/reports/create')).toHaveLength(0);
    });

    it('shows the hint and a live character count', async () => {
        signIn('worker');
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        expect(screen.getByText(t('report_worker.description_hint'))).toBeInTheDocument();
        await user.type(description, 'Fake text');
        expect(screen.getByText(t('report_common.character_count', { count: 9, max: 2000 }))).toBeInTheDocument();
    });

    it('asks employers whether it stops their work, and nobody else', async () => {
        signIn('employer');
        queue('POST', '/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        const question = screen.getByRole('group', { name: t('report_employer.stops_work.legend') });
        await user.click(within(question).getByRole('radio', { name: t('report_employer.stops_work.yes') }));
        await user.type(description, 'Fake: the applicant list stays empty.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));

        await screen.findByText('JR-1042');
        expect(callsTo('POST', '/reports/create')[0].body).toMatchObject({ stops_work: true, category: 'other' });
    });

    it('does not ask workers', async () => {
        signIn('worker');
        const { user, t } = setup();
        await openToDetails(user, t);
        expect(screen.queryByRole('group', { name: message('report_employer.stops_work.legend') })).toBeNull();
    });

    it('signed out: says the report is unverified and offers the contact field', async () => {
        route.pathname = '/auth/worker';
        queue('POST', '/public/reports/create', created());
        const { user, t } = setup({ open: { role: 'worker' } });
        const description = await openToDetails(user, t);

        expect(screen.getByText(t('report_worker.unverified'))).toBeInTheDocument();
        const contact = screen.getByRole('textbox', { name: t('report_worker.contact_label') });
        expect(contact).toHaveAttribute('maxlength', '200');
        expect(contact).not.toBeRequired();

        await user.type(description, 'Fake: the code never arrives.');
        await user.type(contact, 'fake contact');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));

        await screen.findByText('JR-1042');
        const [call] = callsTo('POST', '/public/reports/create');
        expect(new Headers(call.init.headers).get('authorization')).toBeNull();
        expect(call.body).toEqual({
            client_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
            category: 'sign_in',
            description: 'Fake: the code never arrives.',
            stops_work: null,
            locale: 'en',
            include_technical: true,
            context: CONTEXT,
            image: null,
            role_claimed: 'worker',
            contact: 'fake contact',
        });
    });

    it('signed in: has no contact field and no unverified line', async () => {
        signIn('worker');
        const { user, t } = setup();
        await openToDetails(user, t);
        expect(screen.queryByRole('textbox', { name: t('report_worker.contact_label') })).toBeNull();
        expect(screen.queryByText(t('report_worker.unverified'))).toBeNull();
    });

    it('keeps the privacy notice on the form, with a link that opens a new tab', async () => {
        signIn('worker');
        const { user, t } = setup();
        await openToDetails(user, t);
        expect(screen.getByText(t('report_worker.notice'))).toBeInTheDocument();
        const link = screen.getByRole('link', { name: new RegExp(t('report_common.privacy_link')) });
        expect(link).toHaveAttribute('href', '/legal/privacy');
        expect(link).toHaveAttribute('target', '_blank');
    });
});

describe('the screenshot', () => {
    it('shows the editor once the capture lands, and blocks Send while it repaints', async () => {
        signIn('worker');
        capture.captureViewport.mockResolvedValue({
            ok: true, image: new Blob([new Uint8Array(500)], { type: 'image/jpeg' }), width: 390, height: 844, ms: 640,
        });
        queue('POST', '/reports/create', created({ upload: GRANT }));
        queue('POST', STORAGE_URL, new Response(null, { status: 204 }));
        queue('POST', '/reports/attach', json(200, { attached: true }));
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');

        const editor = await screen.findByTestId('fake-editor');
        expect(editor).toHaveAttribute('data-image-size', '500');
        expect(screen.getByText(t('report_worker.masked_note'))).toBeInTheDocument();
        // The editor fills `{n}` in itself.
        expect(screen.getByTestId('fake-editor-box-label')).toHaveTextContent('{n}');

        const send = screen.getByRole('button', { name: t('report_common.send') });
        await user.click(within(editor).getByRole('button', { name: 'fake: start painting' }));
        expect(send).toBeDisabled();
        await user.click(within(editor).getByRole('button', { name: 'fake: finish painting' }));
        expect(send).toBeEnabled();

        await user.click(send);
        await screen.findByText('JR-1042');
        expect(callsTo('POST', '/reports/create')[0].body).toMatchObject({
            image: { content_type: 'image/jpeg', byte_size: PAINTED_IMAGE_SIZE },
        });
        expect(ctx.collectReportContext).toHaveBeenCalledWith({ includeTechnical: true, capture: { outcome: 'ok', ms: 640 } });
        // The painted image, not the original, is what went to storage.
        await waitFor(() => expect(callsTo('POST', STORAGE_URL)).toHaveLength(1));
        const form = callsTo('POST', STORAGE_URL)[0].body as FormData;
        expect((form.get('file') as Blob).size).toBe(PAINTED_IMAGE_SIZE);
        expect(await screen.findByText(t('report_common.image_sent'))).toBeInTheDocument();
    });

    it('waits for a capture still in progress before it can send', async () => {
        signIn('worker');
        const pending = deferred<unknown>();
        capture.captureViewport.mockReturnValue(pending.promise);
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');

        expect(screen.getByText(t('report_common.capture_pending'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: t('report_common.send') })).toBeDisabled();

        pending.resolve({ ok: false, reason: 'timeout', ms: 3000 });
        await waitFor(() => expect(screen.getByRole('button', { name: t('report_common.send') })).toBeEnabled());
    });

    it('offers a photo or no image when the capture fails, and sends without one', async () => {
        signIn('worker');
        capture.captureViewport.mockResolvedValue({ ok: false, reason: 'timeout', ms: 3000 });
        queue('POST', '/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);

        expect(await screen.findByText(t('report_common.capture_failed_title'))).toBeInTheDocument();
        expect(screen.getByText(t('report_worker.capture_failed_body'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: t('report_common.attach_photo') })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: t('report_common.continue_without_image') }));
        expect(screen.getByText(t('report_common.no_image'))).toBeInTheDocument();

        await user.type(description, 'Fake description.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');
        expect(callsTo('POST', '/reports/create')[0].body).toMatchObject({ image: null });
        expect(ctx.collectReportContext).toHaveBeenCalledWith({ includeTechnical: true, capture: { outcome: 'timeout', ms: 3000 } });
    });

    it('redraws an attached photo before the editor sees it', async () => {
        signIn('worker');
        const redrawn = new Blob([new Uint8Array(321)], { type: 'image/jpeg' });
        capture.redrawImage.mockResolvedValue(redrawn);
        const { user, t } = setup();
        await openToDetails(user, t);

        const input = await screen.findByTestId('report-photo-input');
        expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
        expect(input).not.toHaveAttribute('capture');
        const photo = new File([new Uint8Array(900)], 'fake-photo.png', { type: 'image/png' });
        await user.upload(input as HTMLInputElement, photo);

        expect(capture.redrawImage).toHaveBeenCalledWith(photo);
        expect(await screen.findByTestId('fake-editor')).toHaveAttribute('data-image-size', '321');
    });

    it('ignores an editor that calls back after a photo replaced its image', async () => {
        signIn('worker');
        capture.captureViewport.mockResolvedValue({
            ok: true, image: new Blob([new Uint8Array(500)], { type: 'image/jpeg' }), width: 390, height: 844, ms: 640,
        });
        capture.redrawImage.mockResolvedValue(new Blob([new Uint8Array(321)], { type: 'image/jpeg' }));
        queue('POST', '/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await screen.findByTestId('fake-editor');
        const replaced = mountedEditors.find((editor) => editor.size === 500)!;
        await user.upload(
            (await screen.findByTestId('report-photo-input')) as HTMLInputElement,
            new File([new Uint8Array(900)], 'fake-photo.png', { type: 'image/png' }),
        );
        await waitFor(() => expect(screen.getByTestId('fake-editor')).toHaveAttribute('data-image-size', '321'));

        // A repaint of the old image finishing late: neither its busy flag
        // nor its picture may count any more.
        act(() => {
            replaced.onBusyChange(true);
            replaced.onChange(new Blob([new Uint8Array(999)], { type: 'image/jpeg' }));
        });
        await user.type(description, 'Fake description.');
        const send = screen.getByRole('button', { name: t('report_common.send') });
        expect(send).toBeEnabled();

        // Nor can it release Send while the current editor is repainting.
        const current = screen.getByTestId('fake-editor');
        await user.click(within(current).getByRole('button', { name: 'fake: start painting' }));
        act(() => replaced.onBusyChange(false));
        expect(send).toBeDisabled();
        await user.click(within(current).getByRole('button', { name: 'fake: finish painting' }));
        expect(send).toBeEnabled();

        await user.click(send);
        await screen.findByText('JR-1042');
        expect(callsTo('POST', '/reports/create')[0].body).toMatchObject({ image: { byte_size: PAINTED_IMAGE_SIZE } });
        expect(ctx.collectReportContext).toHaveBeenCalledWith({ includeTechnical: true, capture: { outcome: 'attached', ms: 640 } });
    });

    it('ignores a removed editor that calls back late', async () => {
        signIn('worker');
        capture.captureViewport.mockResolvedValue({
            ok: true, image: new Blob([new Uint8Array(500)], { type: 'image/jpeg' }), width: 390, height: 844, ms: 640,
        });
        queue('POST', '/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        const editor = await screen.findByTestId('fake-editor');
        const removed = mountedEditors.find((entry) => entry.size === 500)!;
        await user.click(within(editor).getByRole('button', { name: t('report_common.editor.remove') }));
        expect(screen.getByText(t('report_common.no_image'))).toBeInTheDocument();

        act(() => {
            removed.onBusyChange(true);
            removed.onChange(new Blob([new Uint8Array(999)], { type: 'image/jpeg' }));
        });
        await user.type(description, 'Fake description.');
        expect(screen.getByRole('button', { name: t('report_common.send') })).toBeEnabled();
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');
        expect(callsTo('POST', '/reports/create')[0].body).toMatchObject({ image: null });
        expect(ctx.collectReportContext).toHaveBeenCalledWith({ includeTechnical: true, capture: { outcome: 'removed', ms: 640 } });
    });

    it('drops the image when the editor fails a repaint, rather than sending an earlier one', async () => {
        signIn('worker');
        capture.captureViewport.mockResolvedValue({
            ok: true, image: new Blob([new Uint8Array(500)], { type: 'image/jpeg' }), width: 390, height: 844, ms: 640,
        });
        queue('POST', '/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        const editor = await screen.findByTestId('fake-editor');
        const current = mountedEditors.find((entry) => entry.size === 500)!;
        await user.click(within(editor).getByRole('button', { name: 'fake: start painting' }));

        // The repaint fails: the editor fails closed with null, and never
        // reports that it stopped being busy.
        act(() => current.onChange(null));
        expect(screen.queryByTestId('fake-editor')).toBeNull();
        expect(screen.getByText(t('report_common.no_image'))).toBeInTheDocument();

        await user.type(description, 'Fake description.');
        const send = screen.getByRole('button', { name: t('report_common.send') });
        expect(send).toBeEnabled();
        await user.click(send);
        await screen.findByText('JR-1042');
        expect(callsTo('POST', '/reports/create')[0].body).toMatchObject({ image: null });
        expect(callsTo('POST', STORAGE_URL)).toHaveLength(0);
    });

    it('keeps a photo out when the image is removed while that photo is still being prepared', async () => {
        signIn('worker');
        capture.captureViewport.mockResolvedValue({
            ok: true, image: new Blob([new Uint8Array(500)], { type: 'image/jpeg' }), width: 390, height: 844, ms: 640,
        });
        const redraw = deferred<Blob>();
        capture.redrawImage.mockReturnValue(redraw.promise);
        queue('POST', '/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        const editor = await screen.findByTestId('fake-editor');
        await user.upload(
            (await screen.findByTestId('report-photo-input')) as HTMLInputElement,
            new File([new Uint8Array(900)], 'fake-photo.png', { type: 'image/png' }),
        );
        expect(screen.getByText(t('report_common.photo_preparing'))).toBeInTheDocument();

        // Remove while the photo is still being prepared: no image, and no
        // longer waiting for one.
        await user.click(within(editor).getByRole('button', { name: t('report_common.editor.remove') }));
        expect(screen.getByText(t('report_common.no_image'))).toBeInTheDocument();
        expect(screen.queryByText(t('report_common.photo_preparing'))).toBeNull();

        // The redraw finishing afterwards brings nothing back.
        await act(async () => {
            redraw.resolve(new Blob([new Uint8Array(321)], { type: 'image/jpeg' }));
        });
        expect(screen.queryByTestId('fake-editor')).toBeNull();
        expect(screen.getByText(t('report_common.no_image'))).toBeInTheDocument();

        await user.type(description, 'Fake description.');
        const send = screen.getByRole('button', { name: t('report_common.send') });
        expect(send).toBeEnabled();
        await user.click(send);
        await screen.findByText('JR-1042');
        expect(callsTo('POST', '/reports/create')[0].body).toMatchObject({ image: null });
        expect(callsTo('POST', STORAGE_URL)).toHaveLength(0);
        expect(ctx.collectReportContext).toHaveBeenCalledWith({ includeTechnical: true, capture: { outcome: 'removed', ms: 640 } });
    });

    it('uses a photo chosen again after an earlier one was dropped by Remove', async () => {
        signIn('worker');
        capture.captureViewport.mockResolvedValue({
            ok: true, image: new Blob([new Uint8Array(500)], { type: 'image/jpeg' }), width: 390, height: 844, ms: 640,
        });
        const first = deferred<Blob>();
        capture.redrawImage.mockReturnValueOnce(first.promise);
        const { user, t } = setup();
        await openToDetails(user, t);
        const editor = await screen.findByTestId('fake-editor');
        await user.upload(
            (await screen.findByTestId('report-photo-input')) as HTMLInputElement,
            new File([new Uint8Array(900)], 'fake-photo.png', { type: 'image/png' }),
        );
        await user.click(within(editor).getByRole('button', { name: t('report_common.editor.remove') }));
        await act(async () => {
            first.resolve(new Blob([new Uint8Array(321)], { type: 'image/jpeg' }));
        });
        expect(screen.queryByTestId('fake-editor')).toBeNull();

        capture.redrawImage.mockResolvedValueOnce(new Blob([new Uint8Array(456)], { type: 'image/jpeg' }));
        await user.upload(
            (await screen.findByTestId('report-photo-input')) as HTMLInputElement,
            new File([new Uint8Array(800)], 'fake-photo-2.png', { type: 'image/png' }),
        );
        expect(await screen.findByTestId('fake-editor')).toHaveAttribute('data-image-size', '456');
    });

    it('says so when a photo cannot be used', async () => {
        signIn('worker');
        capture.redrawImage.mockRejectedValue(new Error('not an image'));
        const { user, t } = setup();
        await openToDetails(user, t);
        await user.upload(
            (await screen.findByTestId('report-photo-input')) as HTMLInputElement,
            new File([new Uint8Array(10)], 'fake.png', { type: 'image/png' }),
        );
        expect(await screen.findByText(t('report_worker.photo_error'))).toBeInTheDocument();
    });

    it('leaves the image out entirely when screenshots are paused', async () => {
        signIn('worker');
        capture.captureViewport.mockResolvedValue({
            ok: true, image: new Blob([new Uint8Array(500)], { type: 'image/jpeg' }), width: 1, height: 1, ms: 10,
        });
        queue('GET', '/public/reports/config', json(200, { reporting: true, signed_out: true, screenshots: false }));
        queue('POST', '/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await waitFor(() => expect(screen.queryByText(t('report_common.capture_pending'))).toBeNull());

        expect(screen.queryByTestId('fake-editor')).toBeNull();
        expect(screen.queryByRole('heading', { name: t('report_common.screenshot_heading') })).toBeNull();
        expect(screen.queryByRole('button', { name: t('report_common.attach_photo') })).toBeNull();

        await user.type(description, 'Fake description.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');
        expect(callsTo('POST', '/reports/create')[0].body).toMatchObject({ image: null });
        expect(ctx.collectReportContext).toHaveBeenCalledWith({ includeTechnical: true, capture: { outcome: 'none', ms: 0 } });
    });
});

describe('what we send', () => {
    it('lists what goes with the report, and the technical details can be turned off', async () => {
        signIn('worker');
        queue('POST', '/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);

        const toggle = screen.getByRole('button', { name: t('report_common.what_we_send.toggle') });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await user.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByText(t('report_worker.what_we_send.account'))).toBeInTheDocument();
        expect(screen.getByText(t('report_common.what_we_send.never_codes'))).toBeInTheDocument();

        const technical = screen.getByRole('switch', { name: t('report_common.what_we_send.technical_label') });
        expect(technical).toBeChecked();
        await user.click(technical);
        expect(technical).not.toBeChecked();

        await user.type(description, 'Fake description.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');
        expect(callsTo('POST', '/reports/create')[0].body).toMatchObject({ include_technical: false });
        expect(ctx.collectReportContext).toHaveBeenCalledWith(expect.objectContaining({ includeTechnical: false }));
    });
});

describe('sending', () => {
    it('a double tap sends one report, and a retry reuses its key', async () => {
        signIn('worker');
        const gate = deferred<Response>();
        queue('POST', '/reports/create', () => gate.promise, json(500, { error: 'internal' }), created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');

        const send = screen.getByRole('button', { name: t('report_common.send') });
        await user.dblClick(send);
        gate.resolve(json(500, { error: 'internal' }));

        expect(await screen.findByText(t('report_worker.errors.server'))).toBeInTheDocument();
        expect(callsTo('POST', '/reports/create')).toHaveLength(1);
        // The text survives the failure.
        expect(description).toHaveValue('Fake description.');

        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText(t('report_worker.errors.server'));
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');

        const keys = callsTo('POST', '/reports/create').map((call) => (call.body as { client_key: string }).client_key);
        expect(keys).toHaveLength(3);
        expect(new Set(keys).size).toBe(1);
    });

    it('stops "Sending…" at the deadline when the answer never finishes, and a retry replays the same report', async () => {
        // The headers arrive and the body stalls. The report may be saved, so
        // the retry carries the same key: the server answers it as a replay.
        signIn('worker');
        const stalled = () =>
            new Response(new ReadableStream<Uint8Array>({ start() {} }), {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
            });
        queue('POST', '/reports/create', stalled, created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');

        // Only the wait runs on the fake clock; the typing above was real input.
        vi.useFakeTimers();
        try {
            fireEvent.click(screen.getByRole('button', { name: t('report_common.send') }));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(1_000);
            });
            expect(screen.getByRole('button', { name: t('report_common.sending') })).toBeInTheDocument();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(15_000);
            });
        } finally {
            vi.useRealTimers();
        }

        expect(await screen.findByText(t('report_worker.errors.timeout'))).toBeInTheDocument();
        expect(callsTo('POST', '/reports/create')).toHaveLength(1);
        expect(description).toHaveValue('Fake description.');

        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');
        const keys = callsTo('POST', '/reports/create').map((call) => (call.body as { client_key: string }).client_key);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(1);
    });

    it('switches to the signed-out form when the sign-in has expired, and waits for another tap', async () => {
        signIn('employer');
        route.pathname = '/employer/billing';
        auth.state.getValidIdTokenOrNull.mockResolvedValue(null);
        queue('POST', '/public/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');

        await user.click(screen.getByRole('button', { name: t('report_common.send') }));

        expect(await screen.findByText(t('report_employer.session_switched'))).toBeInTheDocument();
        expect(screen.getByText(t('report_employer.unverified'))).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: t('report_employer.contact_label') })).toBeInTheDocument();
        expect(callsTo('POST', '/reports/create')).toHaveLength(0);
        expect(callsTo('POST', '/public/reports/create')).toHaveLength(0);
        expect(description).toHaveValue('Fake description.');

        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');
        // Still the employer's report, in the employer's category.
        expect(callsTo('POST', '/public/reports/create')[0].body).toMatchObject({
            role_claimed: 'employer',
            category: 'billing',
        });
        expect(screen.getByText(t('report_employer.sent.title_unverified'))).toBeInTheDocument();
    });

    it('reads the context before checking the sign-in, and keeps it through the switch', async () => {
        // Ending a session empties the context buffers. A renewal refused
        // during the check ends it, so the context must already be read --
        // and that reading is what the signed-out send carries.
        signIn('worker');
        let buffersCleared = false;
        const EMPTY = { v: 1, screen: { pattern: '/worker/home' }, app: { build: 'fake-build', locale: 'en' } };
        ctx.collectReportContext.mockImplementation(() => (buffersCleared ? EMPTY : CONTEXT));
        auth.state.getValidIdTokenOrNull.mockImplementation(async () => {
            buffersCleared = true;
            return null;
        });
        queue('POST', '/public/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');

        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText(t('report_worker.session_switched'));
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');

        const [first] = ctx.collectReportContext.mock.invocationCallOrder;
        const [check] = auth.state.getValidIdTokenOrNull.mock.invocationCallOrder;
        expect(first).toBeLessThan(check);
        expect(callsTo('POST', '/public/reports/create')[0].body).toMatchObject({
            include_technical: true,
            context: { requests: CONTEXT.requests, errors: CONTEXT.errors, capture: { outcome: 'failed', ms: 0 } },
        });
    });

    it('keeps only the screen, the build and the language of that reading when technical details go off', async () => {
        signIn('worker');
        let buffersCleared = false;
        ctx.collectReportContext.mockImplementation(() =>
            buffersCleared ? { v: 1, screen: { pattern: '/' }, app: { build: 'fake-build', locale: 'en' } } : CONTEXT,
        );
        auth.state.getValidIdTokenOrNull.mockImplementation(async () => {
            buffersCleared = true;
            return null;
        });
        queue('POST', '/public/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText(t('report_worker.session_switched'));

        await user.click(screen.getByRole('button', { name: t('report_common.what_we_send.toggle') }));
        await user.click(screen.getByRole('switch', { name: t('report_common.what_we_send.technical_label') }));
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');

        expect(callsTo('POST', '/public/reports/create')[0].body).toMatchObject({
            include_technical: false,
            context: { v: 1, screen: { pattern: '/worker/home' }, app: { build: 'fake-build', locale: 'en' } },
        });
        expect((callsTo('POST', '/public/reports/create')[0].body as { context: object }).context).toEqual({
            v: 1,
            screen: { pattern: '/worker/home' },
            app: { build: 'fake-build', locale: 'en' },
        });
    });

    it('uses a new key on the signed-out door when the signed-in send may have been saved', async () => {
        // The signed-in create left the phone and never answered: it may be
        // saved under its key, which the signed-out door would then refuse.
        signIn('worker');
        auth.state.getValidIdTokenOrNull.mockResolvedValueOnce('fake-id-token').mockResolvedValue(null);
        queue('POST', '/reports/create', () => {
            throw new TypeError('fake: network down');
        });
        queue('POST', '/public/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');

        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText(t('report_worker.errors.offline'));
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText(t('report_worker.session_switched'));
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');

        const signedInKey = (callsTo('POST', '/reports/create')[0].body as { client_key: string }).client_key;
        const signedOutKey = (callsTo('POST', '/public/reports/create')[0].body as { client_key: string }).client_key;
        expect(signedOutKey).toMatch(/^[0-9a-f-]{36}$/);
        expect(signedOutKey).not.toBe(signedInKey);
    });

    it('keeps the key when the sign-in was refused before anything was saved', async () => {
        signIn('worker');
        queue('POST', '/reports/create', json(401, { message: 'Unauthorized' }));
        queue('POST', '/public/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');

        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText(t('report_worker.session_switched'));
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');

        const signedInKey = (callsTo('POST', '/reports/create')[0].body as { client_key: string }).client_key;
        const signedOutKey = (callsTo('POST', '/public/reports/create')[0].body as { client_key: string }).client_key;
        expect(signedOutKey).toBe(signedInKey);
    });

    it('treats a refused sign-in on send the same way', async () => {
        signIn('worker');
        queue('POST', '/reports/create', json(401, { message: 'Unauthorized' }));
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));

        expect(await screen.findByText(t('report_worker.session_switched'))).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: t('report_worker.contact_label') })).toBeInTheDocument();
    });

    it('says when there have been too many reports, with the other ways to reach us', async () => {
        queue('POST', '/public/reports/create', json(429, { error: 'rate_limited' }));
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));

        const alert = await screen.findByText(t('report_worker.errors.rate_limited'));
        const box = alert.closest('[role="alert"]') as HTMLElement;
        expect(within(box).getByRole('link', { name: SUPPORT_CONTACT.email })).toHaveAttribute(
            'href',
            `mailto:${SUPPORT_CONTACT.email}`,
        );
        expect(box).toHaveTextContent(SUPPORT_CONTACT.whatsappKeyword);
        expect(description).toHaveValue('Fake description.');
    });

    it('says when reporting was paused after the form opened', async () => {
        signIn('worker');
        queue('POST', '/reports/create', json(503, { error: 'reporting_paused' }));
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        expect(await screen.findByText(t('report_worker.errors.reporting_paused'))).toBeInTheDocument();
    });
});

describe('the reading held through a sign-in switch', () => {
    /** A session whose renewal is refused on every check, emptying the buffers. */
    function endingSession() {
        signIn('worker');
        let buffersCleared = false;
        ctx.collectReportContext.mockImplementation(() =>
            buffersCleared ? { v: 1, screen: { pattern: '/worker/home' }, app: { build: 'fake-build', locale: 'en' } } : CONTEXT,
        );
        auth.state.getValidIdTokenOrNull.mockImplementation(async () => {
            buffersCleared = true;
            return null;
        });
    }

    async function writeAndSwitch(user: User, t: (path: string) => string) {
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText(t('report_worker.session_switched'));
    }

    const sentContexts = () =>
        callsTo('POST', '/public/reports/create').map((call) => (call.body as { context: Record<string, unknown> }).context);

    it('lives in the open sheet: every retry in it sends the same reading', async () => {
        endingSession();
        queue('POST', '/public/reports/create', json(500, { error: 'internal' }), created());
        const { user, t } = setup();
        await writeAndSwitch(user, t);

        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText(t('report_worker.errors.server'));
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');

        expect(sentContexts()).toHaveLength(2);
        for (const context of sentContexts()) expect(context.requests).toEqual(CONTEXT.requests);
    });

    it('is dropped when the sheet closes: the next sheet reads afresh', async () => {
        endingSession();
        queue('POST', '/public/reports/create', created());
        const { user, t } = setup();
        await writeAndSwitch(user, t);
        await user.click(screen.getByRole('button', { name: t('report_common.close') }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await writeAndSwitch(user, t);
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');

        expect(sentContexts()).toHaveLength(1);
        expect(sentContexts()[0]).not.toHaveProperty('requests');
        expect(sentContexts()[0]).not.toHaveProperty('errors');
    });

    it('is dropped after a successful send: a later sheet never reuses it', async () => {
        endingSession();
        queue('POST', '/public/reports/create', created());
        const { user, t } = setup();
        await writeAndSwitch(user, t);
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');
        await user.click(screen.getByRole('button', { name: t('report_common.back') }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await writeAndSwitch(user, t);
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        await screen.findByText('JR-1042');

        expect(sentContexts()).toHaveLength(2);
        expect(sentContexts()[0].requests).toEqual(CONTEXT.requests);
        expect(sentContexts()[1]).not.toHaveProperty('requests');
    });
});

describe('step 3: sent', () => {
    it('shows the number and promises no reply (signed in)', async () => {
        signIn('worker');
        queue('POST', '/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));

        expect(await screen.findByText('JR-1042')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: t('report_worker.sent.title') })).toHaveFocus();
        expect(screen.getByText(t('report_worker.sent.number_label'))).toBeInTheDocument();
        expect(screen.getByText(t('report_worker.sent.body'))).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: t('report_common.done') }));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('uses the signed-out wording, with the WhatsApp line', async () => {
        queue('POST', '/public/reports/create', created());
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await user.type(description, 'Fake description.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));

        expect(await screen.findByText('JR-1042')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: t('report_worker.sent.title_unverified') })).toBeInTheDocument();
        expect(screen.getByText(t('report_worker.sent.body_unverified'))).toBeInTheDocument();
        expect(screen.getByText(t('report_worker.sent.whatsapp', { keyword: SUPPORT_CONTACT.whatsappKeyword })))
            .toBeInTheDocument();
        expect(screen.getByRole('button', { name: t('report_common.back') })).toBeInTheDocument();
    });

    it('keeps the report sent when the image does not make it, and retries with a new upload', async () => {
        signIn('worker');
        capture.captureViewport.mockResolvedValue({
            ok: true, image: new Blob([new Uint8Array(500)], { type: 'image/jpeg' }), width: 390, height: 844, ms: 640,
        });
        queue('POST', '/reports/create', created({ upload: GRANT }));
        queue('POST', STORAGE_URL, new Response(null, { status: 403 }), new Response(null, { status: 204 }));
        queue('POST', '/reports/upload', json(200, { upload: GRANT }));
        queue('POST', '/reports/attach', json(200, { attached: true }));
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await screen.findByTestId('fake-editor');
        await user.type(description, 'Fake description.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));

        expect(await screen.findByText('JR-1042')).toBeInTheDocument();
        expect(await screen.findByText(t('report_worker.sent.image_failed'))).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: t('report_common.try_again') }));
        expect(await screen.findByText(t('report_common.image_sent'))).toBeInTheDocument();
        expect(callsTo('POST', '/reports/upload')).toHaveLength(1);
        expect(callsTo('POST', '/reports/attach')).toHaveLength(1);
        expect(screen.getByText('JR-1042')).toBeInTheDocument();
    });

    it('counts an image that is already attached as sent', async () => {
        signIn('worker');
        capture.captureViewport.mockResolvedValue({
            ok: true, image: new Blob([new Uint8Array(500)], { type: 'image/jpeg' }), width: 390, height: 844, ms: 640,
        });
        queue('POST', '/reports/create', created({ upload: GRANT }));
        queue('POST', STORAGE_URL, new Response(null, { status: 204 }));
        queue('POST', '/reports/attach', json(409, { error: 'already_attached' }));
        const { user, t } = setup();
        const description = await openToDetails(user, t);
        await screen.findByTestId('fake-editor');
        await user.type(description, 'Fake description.');
        await user.click(screen.getByRole('button', { name: t('report_common.send') }));
        expect(await screen.findByText(t('report_common.image_sent'))).toBeInTheDocument();
    });
});

describe('paused reporting', () => {
    it('shows the support address and the keyword instead of the form', async () => {
        signIn('worker');
        queue('GET', '/public/reports/config', json(200, { reporting: false, signed_out: false, screenshots: false }));
        const { user, t } = setup();
        await user.click(screen.getByRole('button', { name: 'open report' }));

        expect(await screen.findByText(t('report_common.paused_title'))).toBeInTheDocument();
        expect(screen.getByRole('link', { name: SUPPORT_CONTACT.email })).toHaveAttribute('href', `mailto:${SUPPORT_CONTACT.email}`);
        expect(screen.getByText(t('report_worker.fallback.whatsapp', { keyword: SUPPORT_CONTACT.whatsappKeyword })))
            .toBeInTheDocument();
        expect(screen.queryByRole('radio')).toBeNull();
    });

    it('signed out with signed-out reporting paused: the signed-out fallback', async () => {
        queue('GET', '/public/reports/config', json(200, { reporting: true, signed_out: false, screenshots: true }));
        const { user, t } = setup();
        await user.click(screen.getByRole('button', { name: 'open report' }));
        expect(await screen.findByText(t('report_common.signed_out_paused_title'))).toBeInTheDocument();
        expect(screen.getByText(t('report_worker.fallback.sign_in'))).toBeInTheDocument();
    });

    it('signed in with signed-out reporting paused: the form, as usual', async () => {
        signIn('worker');
        queue('GET', '/public/reports/config', json(200, { reporting: true, signed_out: false, screenshots: true }));
        const { user, t } = setup();
        await openToDetails(user, t);
        expect(screen.queryByText(t('report_common.signed_out_paused_title'))).toBeNull();
    });
});

describe('Spanish', () => {
    it('speaks usted to an employer', async () => {
        signIn('employer');
        route.pathname = '/employer/billing';
        const { user, t } = setup({ locale: 'es' });
        await user.click(screen.getByRole('button', { name: 'open report' }));
        expect(await screen.findByRole('radio', { name: t('report_employer.categories.billing') })).toBeChecked();
        expect(screen.getByText(t('report_employer.category_hint'))).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: t('report_common.next') }));
        expect(await screen.findByText('¿Qué intentaba hacer y qué pasó?')).toBeInTheDocument();
        expect(screen.getByRole('group', { name: '¿Esto le impide trabajar?' })).toBeInTheDocument();
    });
});
