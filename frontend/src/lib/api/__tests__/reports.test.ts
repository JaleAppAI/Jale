import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The report API client, driven through the REAL `apiFetch` against a mocked
 * `fetch`: the properties that matter here -- no refresh, no retry and no
 * navigation on a 401; the exact bodies; the multipart order an S3 POST policy
 * requires -- are all things a mocked `apiFetch` would hide.
 */

const { recordRequest } = vi.hoisted(() => ({ recordRequest: vi.fn() }));
vi.mock('@/components/report/seams/report-context', () => ({ recordRequest }));

import { registerAuthBridge } from '@/lib/auth-bridge';
import {
    REPORT_CONFIG_TTL_MS,
    clearReportConfigCache,
    createSignedInReport,
    createSignedOutReport,
    deliverReportImage,
    failureFromStatus,
    getReportConfig,
    postImageToStorage,
    reportFailureMessageKey,
    type ReportDraft,
    type ReportFailure,
    type UploadGrant,
} from '../reports';

const BASE = 'https://example.test/api';
const fetchMock = vi.fn();

beforeAll(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = BASE;
});

beforeEach(() => {
    fetchMock.mockReset();
    recordRequest.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    clearReportConfigCache();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    registerAuthBridge(null);
});

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });
}

function empty(status: number): Response {
    return new Response(null, { status });
}

/** The `[url, init]` of every fetch call, in order. */
function calls(): Array<{ url: string; init: RequestInit }> {
    return fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: (init ?? {}) as RequestInit }));
}

function headersOf(init: RequestInit): Record<string, string> {
    return Object.fromEntries(new Headers(init.headers).entries());
}

const DRAFT: ReportDraft = {
    client_key: '00000000-0000-4000-8000-000000000001',
    category: 'applying',
    description: 'Tapped Apply and the screen kept loading.',
    stops_work: null,
    locale: 'es',
    include_technical: true,
    context: { v: 1, screen: { pattern: '/worker/jobs/:id' } },
    image: { content_type: 'image/jpeg', byte_size: 2048 },
};

const GRANT: UploadGrant = {
    url: 'https://uploads.example.test/',
    fields: {
        key: 'incoming/00000000-0000-4000-8000-0000000000aa',
        'Content-Type': 'image/jpeg',
        'x-amz-server-side-encryption': 'aws:kms',
        Policy: 'fake-policy',
        'X-Amz-Signature': 'fake-signature',
    },
    expires_at: '2026-10-02T12:10:00Z',
};

const CREATED = {
    number: 'JR-1042',
    report_id: '00000000-0000-4000-8000-0000000000bb',
    attach_token: 'fake-attach-token',
    upload: GRANT,
    replayed: false,
};

describe('createSignedInReport', () => {
    it('posts the draft to the signed-in route with the token, and nothing that names the reporter', async () => {
        fetchMock.mockResolvedValueOnce(json(201, CREATED));

        const result = await createSignedInReport('fake-id-token', DRAFT);

        expect(result).toEqual({
            ok: true,
            report: {
                number: 'JR-1042',
                reportId: CREATED.report_id,
                attachToken: 'fake-attach-token',
                upload: GRANT,
                replayed: false,
            },
        });
        const [call] = calls();
        expect(call.url).toBe(`${BASE}/reports/create`);
        expect(call.init.method).toBe('POST');
        expect(headersOf(call.init).authorization).toBe('fake-id-token');
        expect(JSON.parse(String(call.init.body))).toEqual(DRAFT);
    });

    it('never refreshes, retries or navigates on a 401', async () => {
        const bridge = { refreshIdToken: vi.fn(async () => ({ status: 'ok' as const, token: 'fresh-token' })), onSessionExpired: vi.fn() };
        registerAuthBridge(bridge);
        fetchMock.mockResolvedValue(json(401, { message: 'Unauthorized' }));

        const result = await createSignedInReport('expired-id-token', DRAFT);

        expect(result).toEqual({ ok: false, failure: 'session_expired' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(bridge.refreshIdToken).not.toHaveBeenCalled();
        expect(bridge.onSessionExpired).not.toHaveBeenCalled();
    });

    it('reports a request that never reached the server as offline', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('network down'));
        expect(await createSignedInReport('fake-id-token', DRAFT)).toEqual({ ok: false, failure: 'offline' });
    });

    it('treats a success it cannot read as a server failure, so a retry replays the same key', async () => {
        fetchMock.mockResolvedValueOnce(json(201, { number: 'not-a-number' }));
        expect(await createSignedInReport('fake-id-token', DRAFT)).toEqual({ ok: false, failure: 'server' });
    });
});

describe('createSignedOutReport', () => {
    it('posts to the public route without credentials, with the claimed role and the typed contact', async () => {
        fetchMock.mockResolvedValueOnce(json(201, { ...CREATED, upload: null }, { 'x-amzn-requestid': 'req-fake-1' }));

        const result = await createSignedOutReport({ ...DRAFT, role_claimed: 'worker', contact: 'fake contact' });

        expect(result.ok).toBe(true);
        const [call] = calls();
        expect(call.url).toBe(`${BASE}/public/reports/create`);
        expect(call.init.method).toBe('POST');
        expect(headersOf(call.init).authorization).toBeUndefined();
        expect(JSON.parse(String(call.init.body))).toEqual({ ...DRAFT, role_claimed: 'worker', contact: 'fake contact' });
        expect(recordRequest).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'POST', url: '/public/reports/create', status: 201, requestId: 'req-fake-1' }),
        );
    });

    it('gives up after 15 seconds and says so', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));

        const pending = createSignedOutReport({ ...DRAFT, role_claimed: 'unknown', contact: null });
        await vi.advanceTimersByTimeAsync(15_000);

        expect(await pending).toEqual({ ok: false, failure: 'timeout' });
        expect(recordRequest).toHaveBeenCalledWith(expect.objectContaining({ url: '/public/reports/create', status: 0 }));
    });
});

describe('status-to-message mapping', () => {
    const TABLE: Array<[number, string | undefined, ReportFailure]> = [
        [401, undefined, 'session_expired'],
        [429, 'rate_limited', 'rate_limited'],
        [503, 'reporting_paused', 'reporting_paused'],
        [503, 'signed_out_paused', 'signed_out_paused'],
        [503, undefined, 'server'],
        [400, 'invalid_request', 'invalid_request'],
        [413, 'payload_too_large', 'too_large'],
        [500, 'internal', 'server'],
        [502, undefined, 'server'],
        [404, undefined, 'server'],
    ];

    it.each(TABLE)('%i %s -> %s', (status, code, failure) => {
        expect(failureFromStatus(status, code)).toBe(failure);
    });

    it('names a message for every failure', () => {
        const failures: ReportFailure[] = [
            'rate_limited', 'reporting_paused', 'signed_out_paused', 'invalid_request',
            'too_large', 'offline', 'timeout', 'server',
        ];
        for (const failure of failures) {
            expect(reportFailureMessageKey(failure)).toBe(`errors.${failure}`);
        }
        // Not an error to show: the form switches to its signed-out version.
        expect(reportFailureMessageKey('session_expired')).toBe('session_switched');
    });

    it('maps a failed create end to end', async () => {
        fetchMock.mockResolvedValueOnce(json(429, { error: 'rate_limited' }));
        expect(await createSignedOutReport({ ...DRAFT, role_claimed: 'worker', contact: null }))
            .toEqual({ ok: false, failure: 'rate_limited' });

        fetchMock.mockResolvedValueOnce(json(503, { error: 'signed_out_paused' }));
        expect(await createSignedOutReport({ ...DRAFT, role_claimed: 'worker', contact: null }))
            .toEqual({ ok: false, failure: 'signed_out_paused' });

        fetchMock.mockResolvedValueOnce(json(503, { error: 'reporting_paused' }));
        expect(await createSignedInReport('fake-id-token', DRAFT)).toEqual({ ok: false, failure: 'reporting_paused' });
    });
});

describe('image delivery', () => {
    const image = new Blob([new Uint8Array(2048)], { type: 'image/jpeg' });
    const ids = { reportId: CREATED.report_id, attachToken: 'fake-attach-token' };

    it('sends the policy fields in order and the file last, and records the upload without its URL', async () => {
        fetchMock.mockResolvedValueOnce(empty(204));

        expect(await postImageToStorage(GRANT, image)).toBe(true);

        const [call] = calls();
        expect(call.url).toBe(GRANT.url);
        expect(call.init.method).toBe('POST');
        const form = call.init.body as FormData;
        expect(Array.from(form.keys())).toEqual([...Object.keys(GRANT.fields), 'file']);
        expect(form.get('key')).toBe(GRANT.fields.key);
        expect((form.get('file') as Blob).size).toBe(image.size);
        // A multipart body: the browser must write the boundary itself.
        expect(headersOf(call.init)['content-type']).toBeUndefined();

        expect(recordRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', url: 's3:upload', status: 204 }));
        for (const [entry] of recordRequest.mock.calls) {
            expect(JSON.stringify(entry)).not.toContain('uploads.example.test');
        }
    });

    it('uses the grant from create, then attaches (signed out)', async () => {
        fetchMock.mockResolvedValueOnce(empty(204)).mockResolvedValueOnce(json(200, { attached: true }));

        const result = await deliverReportImage({ auth: { kind: 'signed_out' }, ...ids, image, grant: GRANT });

        expect(result).toEqual({ status: 'sent' });
        const [upload, attach] = calls();
        expect(upload.url).toBe(GRANT.url);
        expect(attach.url).toBe(`${BASE}/public/reports/attach`);
        expect(headersOf(attach.init).authorization).toBeUndefined();
        expect(JSON.parse(String(attach.init.body))).toEqual({ report_id: ids.reportId, attach_token: ids.attachToken });
    });

    it('asks for a new grant when it has none, on the signed-in routes with the token', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, { upload: GRANT }))
            .mockResolvedValueOnce(empty(204))
            .mockResolvedValueOnce(json(200, { attached: true }));

        const result = await deliverReportImage({
            auth: { kind: 'signed_in', idToken: 'fake-id-token' },
            ...ids,
            image,
            grant: null,
        });

        expect(result).toEqual({ status: 'sent' });
        const [grant, upload, attach] = calls();
        expect(grant.url).toBe(`${BASE}/reports/upload`);
        expect(headersOf(grant.init).authorization).toBe('fake-id-token');
        expect(JSON.parse(String(grant.init.body))).toEqual({
            report_id: ids.reportId,
            attach_token: ids.attachToken,
            image: { content_type: 'image/jpeg', byte_size: 2048 },
        });
        expect(upload.url).toBe(GRANT.url);
        expect(attach.url).toBe(`${BASE}/reports/attach`);
        expect(headersOf(attach.init).authorization).toBe('fake-id-token');
    });

    it('counts an image that is already attached as sent', async () => {
        fetchMock.mockResolvedValueOnce(json(409, { error: 'already_attached' }));
        expect(await deliverReportImage({ auth: { kind: 'signed_out' }, ...ids, image, grant: null }))
            .toEqual({ status: 'sent' });

        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(empty(204)).mockResolvedValueOnce(json(409, { error: 'already_attached' }));
        expect(await deliverReportImage({ auth: { kind: 'signed_out' }, ...ids, image, grant: GRANT }))
            .toEqual({ status: 'sent' });
    });

    it('keeps the report when storage refuses the file, and offers a retry', async () => {
        fetchMock.mockResolvedValueOnce(empty(403));
        const result = await deliverReportImage({ auth: { kind: 'signed_out' }, ...ids, image, grant: GRANT });
        expect(result).toEqual({ status: 'failed', retryable: true });
        // No attach for a file that never arrived.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('offers a retry when the file fails its check or the upload went stale', async () => {
        fetchMock.mockResolvedValueOnce(empty(204)).mockResolvedValueOnce(json(422, { error: 'invalid_image' }));
        expect(await deliverReportImage({ auth: { kind: 'signed_out' }, ...ids, image, grant: GRANT }))
            .toEqual({ status: 'failed', retryable: true });

        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(empty(204)).mockResolvedValueOnce(json(410, { error: 'upload_expired' }));
        expect(await deliverReportImage({ auth: { kind: 'signed_out' }, ...ids, image, grant: GRANT }))
            .toEqual({ status: 'failed', retryable: true });
    });

    it('stops offering a retry that cannot work', async () => {
        fetchMock.mockResolvedValueOnce(json(404, { error: 'not_found' }));
        expect(await deliverReportImage({ auth: { kind: 'signed_out' }, ...ids, image, grant: null }))
            .toEqual({ status: 'failed', retryable: false });

        // The report is past the window in which a new upload is issued.
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(json(410, { error: 'upload_expired' }));
        expect(await deliverReportImage({ auth: { kind: 'signed_out' }, ...ids, image, grant: null }))
            .toEqual({ status: 'failed', retryable: false });
    });

    it('says when screenshots are paused', async () => {
        fetchMock.mockResolvedValueOnce(json(503, { error: 'screenshots_paused' }));
        expect(await deliverReportImage({ auth: { kind: 'signed_out' }, ...ids, image, grant: null }))
            .toEqual({ status: 'paused' });
    });
});

describe('getReportConfig', () => {
    it('reads the switches at most once a minute, and records the read', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation(async () => json(200, { reporting: true, signed_out: false, screenshots: true }));

        expect(await getReportConfig()).toEqual({ reporting: true, signed_out: false, screenshots: true });
        expect(await getReportConfig()).toEqual({ reporting: true, signed_out: false, screenshots: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(calls()[0].url).toBe(`${BASE}/public/reports/config`);
        expect(calls()[0].init.method).toBe('GET');
        expect(recordRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: '/public/reports/config', status: 200 }));

        await vi.advanceTimersByTimeAsync(REPORT_CONFIG_TTL_MS + 1);
        await getReportConfig();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('shares one request between callers that ask at the same time', async () => {
        fetchMock.mockImplementation(async () => json(200, { reporting: false, signed_out: false, screenshots: false }));
        const [a, b] = await Promise.all([getReportConfig(), getReportConfig()]);
        expect(a).toEqual(b);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails open, and does not remember the failure', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('network down'));
        expect(await getReportConfig()).toEqual({ reporting: true, signed_out: true, screenshots: true });

        fetchMock.mockResolvedValueOnce(json(200, { reporting: false, signed_out: false, screenshots: false }));
        expect(await getReportConfig()).toEqual({ reporting: false, signed_out: false, screenshots: false });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

/**
 * A request's deadline covers its answer's body, not only its headers. The
 * headers can arrive and the body stall: before this, a read of such a body
 * never ended, the form stayed on "Sending…", and the config read stayed in
 * flight for every later sheet. Bodies are read only where the answer needs
 * one, so an attach that succeeded is still a success.
 */
describe('the deadline covers the answer body', () => {
    /** Headers at once, then a body that never ends. */
    function stalled(status: number): Response {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    /** Settles `work` against the fake clock: pending until `ms`, then its outcome. */
    async function outcomeAfter<T>(work: Promise<T>, ms: number): Promise<T | 'pending'> {
        let outcome: T | 'pending' = 'pending';
        void work.then((value) => {
            outcome = value;
        });
        await vi.advanceTimersByTimeAsync(ms - 1);
        expect(outcome).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        return outcome;
    }

    const image = new Blob([new Uint8Array(2048)], { type: 'image/jpeg' });
    const ids = { reportId: CREATED.report_id, attachToken: 'fake-attach-token' };

    it('gives up on a signed-out create whose body never ends, after 15 seconds', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValueOnce(stalled(201));
        const outcome = await outcomeAfter(createSignedOutReport({ ...DRAFT, role_claimed: 'worker', contact: null }), 15_000);
        expect(outcome).toEqual({ ok: false, failure: 'timeout' });
    });

    it('gives up on a signed-in create whose body never ends, after 15 seconds', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValueOnce(stalled(201));
        const outcome = await outcomeAfter(createSignedInReport('fake-id-token', DRAFT), 15_000);
        expect(outcome).toEqual({ ok: false, failure: 'timeout' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('lets the status decide a refusal whose body never ends, without its code', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValueOnce(stalled(503));
        const outcome = await outcomeAfter(createSignedOutReport({ ...DRAFT, role_claimed: 'worker', contact: null }), 15_000);
        expect(outcome).toEqual({ ok: false, failure: 'server' });
    });

    it('reads a 401 on a signed-in create as a session that ended, even when its body never ends', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValueOnce(stalled(401));
        const outcome = await outcomeAfter(createSignedInReport('fake-id-token', DRAFT), 15_000);
        expect(outcome).toEqual({ ok: false, failure: 'session_expired' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([404, 410])('reads a %i on a new upload grant as final, even when its body never ends', async (status) => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValueOnce(stalled(status));
        const outcome = await outcomeAfter(
            deliverReportImage({ auth: { kind: 'signed_out' }, ...ids, image, grant: null }),
            15_000,
        );
        expect(outcome).toEqual({ status: 'failed', retryable: false });
    });

    it('fails a new upload grant whose body never ends, so the image can be tried again', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValueOnce(stalled(200));
        const outcome = await outcomeAfter(
            deliverReportImage({ auth: { kind: 'signed_out' }, ...ids, image, grant: null }),
            15_000,
        );
        expect(outcome).toEqual({ status: 'failed', retryable: true });
    });

    it('reads the switches as open when their body never ends, and does not stay in flight', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValueOnce(stalled(200));
        const outcome = await outcomeAfter(getReportConfig(), 15_000);
        expect(outcome).toEqual({ reporting: true, signed_out: true, screenshots: true });

        fetchMock.mockResolvedValueOnce(json(200, { reporting: false, signed_out: false, screenshots: false }));
        expect(await getReportConfig()).toEqual({ reporting: false, signed_out: false, screenshots: false });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('counts an attach that answered success as sent without waiting for its body', async () => {
        fetchMock.mockResolvedValueOnce(empty(204)).mockResolvedValueOnce(stalled(200));
        expect(await deliverReportImage({ auth: { kind: 'signed_out' }, ...ids, image, grant: GRANT }))
            .toEqual({ status: 'sent' });
    });
});
