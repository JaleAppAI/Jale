import { apiFetch } from '../api';
import { ApiError } from './errors';
import { recordRequest } from '@/components/report/seams/report-context';
import type { ReportCategory, ReportRole } from '@/lib/report/categories';

/**
 * "Report a problem": the API client.
 *
 * Two doors, one shape. A signed-in report goes through `apiFetch` with
 * `retryOn401: false`; a signed-out one through a plain `fetch` to the public
 * route. Neither may ever move the page: the person is in the middle of
 * telling us what broke, and `apiFetch`'s default 401 path ends in a redirect
 * to the sign-in screen. A 401 here is returned as `session_expired`, and the
 * form switches to its signed-out version instead.
 *
 * Every function answers with a result value rather than throwing, so the form
 * can keep what the person wrote and say exactly what went wrong.
 *
 * Every plain `fetch` here records itself for the report context. The storage
 * upload records the pattern `s3:upload`, never its URL, which carries a
 * signed policy.
 *
 * A request's deadline covers its answer's body as well as its headers: the
 * headers can arrive and the body stall, and a read that never ends would
 * leave the form on "Sending…". A body is read only where the answer needs
 * one.
 */

const TIMEOUT_MS = 15_000;
/** An image is a few hundred KB, but phones upload slowly. */
const UPLOAD_TIMEOUT_MS = 60_000;
export const REPORT_CONFIG_TTL_MS = 60_000;

export type ReportConfig = { reporting: boolean; signed_out: boolean; screenshots: boolean };

export type ReportImageMeta = { content_type: 'image/jpeg' | 'image/png' | 'image/webp'; byte_size: number };

export type UploadGrant = { url: string; fields: Record<string, string>; expires_at: string };

export type ReportDraft = {
    client_key: string;
    category: ReportCategory;
    description: string;
    stops_work: boolean | null;
    locale: 'es' | 'en';
    include_technical: boolean;
    context: unknown;
    image: ReportImageMeta | null;
};

export type SignedOutReportDraft = ReportDraft & { role_claimed: ReportRole; contact: string | null };

export type CreatedReport = {
    number: string;
    reportId: string;
    attachToken: string;
    upload: UploadGrant | null;
    replayed: boolean;
};

export type ReportFailure =
    | 'session_expired'
    | 'rate_limited'
    | 'reporting_paused'
    | 'signed_out_paused'
    | 'invalid_request'
    | 'too_large'
    | 'offline'
    | 'timeout'
    | 'server';

export type CreateResult = { ok: true; report: CreatedReport } | { ok: false; failure: ReportFailure };

export type ReportAuth = { kind: 'signed_in'; idToken: string } | { kind: 'signed_out' };

export type ImageDelivery = { status: 'sent' } | { status: 'paused' } | { status: 'failed'; retryable: boolean };

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** A request that never got an answer. */
class TransportFailure extends Error {
    constructor(readonly kind: 'offline' | 'timeout') {
        super(kind);
        this.name = 'TransportFailure';
    }
}

function elapsedSince(start: number): number {
    return Math.round(performance.now() - start);
}

/**
 * An answer: its status at once, its body on request. `text()` reads the body
 * within what is left of the request's deadline, rejects with a timeout once
 * that has passed, and gives null for a body that cannot be read otherwise.
 */
interface Answer {
    status: number;
    ok: boolean;
    text(): Promise<string | null>;
}

/** Reads `res`'s body before `deadlineAt` (a `performance.now()` time); `onTimeout` runs on a miss. */
async function readBefore(res: Response, deadlineAt: number, onTimeout?: () => void): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            onTimeout?.();
            reject(new TransportFailure('timeout'));
        }, Math.max(0, deadlineAt - performance.now()));
    });
    try {
        return await Promise.race([res.text(), late]);
    } catch (err) {
        if (err instanceof TransportFailure) throw err;
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** A plain `fetch` with a deadline over the whole answer, recorded for the report context. */
async function recordedFetch(
    url: string,
    init: RequestInit,
    record: { method: string; url: string },
    timeoutMs: number,
): Promise<Answer> {
    const controller = new AbortController();
    let timedOut = false;
    const start = performance.now();
    const deadlineAt = start + timeoutMs;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    let res: Response;
    try {
        res = await fetch(url, { ...init, signal: controller.signal });
        recordRequest({
            ...record,
            status: res.status,
            ms: elapsedSince(start),
            requestId: res.headers.get('x-amzn-requestid') ?? undefined,
        });
    } catch {
        recordRequest({ ...record, status: 0, ms: elapsedSince(start) });
        throw new TransportFailure(timedOut ? 'timeout' : 'offline');
    } finally {
        clearTimeout(timer);
    }
    return { status: res.status, ok: res.ok, text: () => readBefore(res, deadlineAt, () => controller.abort()) };
}

function apiUrl(path: string): string {
    return `${process.env.NEXT_PUBLIC_API_BASE_URL}${path}`;
}

/**
 * POST a JSON body through the door `auth` names. The signed-in door's
 * `apiFetch` keeps its own deadline up to the headers, and the body is read
 * within what is left of the same budget.
 */
async function postJson(auth: ReportAuth, path: string, body: unknown): Promise<Answer> {
    if (auth.kind === 'signed_in') {
        const deadlineAt = performance.now() + TIMEOUT_MS;
        try {
            const res = await apiFetch(
                path,
                { method: 'POST', body: JSON.stringify(body) },
                auth.idToken,
                { retryOn401: false },
            );
            return { status: res.status, ok: res.ok, text: () => readBefore(res, deadlineAt) };
        } catch (err) {
            if (err instanceof ApiError && err.status === 0) {
                throw new TransportFailure(err.code === 'timeout' ? 'timeout' : 'offline');
            }
            // Anything else (a legal-wall 403, which these routes never send)
            // is an answer we cannot use: let the caller treat it as a failure.
            throw err;
        }
    }
    const publicPath = `/public${path}`;
    return recordedFetch(
        apiUrl(publicPath),
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        { method: 'POST', url: publicPath },
        TIMEOUT_MS,
    );
}

/** The body parsed as JSON, or undefined when there is none to parse. */
function parseJson(text: string | null): unknown {
    if (text === null) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * The `error` code of a refusal, or undefined when there is none: then the
 * status alone decides. A refusal's status is already definite, so a body that
 * cannot be read in time counts as one without a code; it never turns the
 * refusal into a timeout.
 */
async function errorCode(answer: Answer): Promise<string | undefined> {
    let text: string | null;
    try {
        text = await answer.text();
    } catch {
        return undefined;
    }
    const body = parseJson(text);
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
        return (body as { error: string }).error;
    }
    return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseGrant(value: unknown): UploadGrant | null {
    if (!isRecord(value)) return null;
    const { url, fields, expires_at: expiresAt } = value;
    if (typeof url !== 'string' || !isRecord(fields) || typeof expiresAt !== 'string') return null;
    if (!Object.values(fields).every((field) => typeof field === 'string')) return null;
    return { url, fields: fields as Record<string, string>, expires_at: expiresAt };
}

function parseCreated(value: unknown): CreatedReport | null {
    if (!isRecord(value)) return null;
    const { number, report_id: reportId, attach_token: attachToken, upload, replayed } = value;
    if (typeof number !== 'string' || !/^JR-\d+$/.test(number)) return null;
    if (typeof reportId !== 'string' || typeof attachToken !== 'string') return null;
    // A malformed grant is dropped rather than failing the report: the image
    // path asks for a fresh one.
    return { number, reportId, attachToken, upload: parseGrant(upload), replayed: replayed === true };
}

// ---------------------------------------------------------------------------
// Status -> failure -> message
// ---------------------------------------------------------------------------

export function failureFromStatus(status: number, code: string | undefined): ReportFailure {
    if (status === 401) return 'session_expired';
    if (status === 429) return 'rate_limited';
    if (status === 503 && code === 'reporting_paused') return 'reporting_paused';
    if (status === 503 && code === 'signed_out_paused') return 'signed_out_paused';
    if (status === 400) return 'invalid_request';
    if (status === 413) return 'too_large';
    return 'server';
}

/** Message key, relative to the role's report namespace. */
export function reportFailureMessageKey(failure: ReportFailure): string {
    return failure === 'session_expired' ? 'session_switched' : `errors.${failure}`;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

async function create(auth: ReportAuth, body: ReportDraft | SignedOutReportDraft): Promise<CreateResult> {
    try {
        const answer = await postJson(auth, '/reports/create', body);
        if (!answer.ok) return { ok: false, failure: failureFromStatus(answer.status, await errorCode(answer)) };
        // Saved, but if we cannot read the number, sending again replays the
        // same client key, which answers with the same report rather than a
        // second one.
        const parsed = parseCreated(parseJson(await answer.text()));
        return parsed ? { ok: true, report: parsed } : { ok: false, failure: 'server' };
    } catch (err) {
        return { ok: false, failure: err instanceof TransportFailure ? err.kind : 'server' };
    }
}

export function createSignedInReport(idToken: string, draft: ReportDraft): Promise<CreateResult> {
    return create({ kind: 'signed_in', idToken }, draft);
}

export function createSignedOutReport(draft: SignedOutReportDraft): Promise<CreateResult> {
    return create({ kind: 'signed_out' }, draft);
}

// ---------------------------------------------------------------------------
// Image: grant -> storage -> attach
// ---------------------------------------------------------------------------

export function imageMetaFor(image: Blob): ReportImageMeta {
    const type = image.type === 'image/png' || image.type === 'image/webp' ? image.type : 'image/jpeg';
    return { content_type: type, byte_size: image.size };
}

/**
 * POSTs the image to storage with the grant's policy fields, in the order the
 * grant lists them, and the file LAST: S3 ignores anything after the file
 * field, and every field it does read must be one the policy signed.
 */
export async function postImageToStorage(grant: UploadGrant, image: Blob): Promise<boolean> {
    const form = new FormData();
    for (const [name, value] of Object.entries(grant.fields)) form.append(name, value);
    form.append('file', image, 'report-image');
    try {
        const answer = await recordedFetch(
            grant.url,
            { method: 'POST', body: form },
            { method: 'POST', url: 's3:upload' },
            UPLOAD_TIMEOUT_MS,
        );
        return answer.ok;
    } catch {
        return false;
    }
}

type Step = { ok: true; answer: Answer } | { ok: false; delivery: ImageDelivery };

/**
 * What an upload or attach answer means for the image. `already_attached` is
 * success: an earlier attempt landed. `not_found` cannot get better by
 * retrying, and neither can a 410 on a NEW grant (the report is past the window
 * in which uploads are issued). A 410 on attach only means this upload went
 * stale, so a fresh grant can still work.
 */
async function imageStep(auth: ReportAuth, path: '/reports/upload' | '/reports/attach', body: unknown): Promise<Step> {
    let answer: Answer;
    let code: string | undefined;
    try {
        answer = await postJson(auth, path, body);
        if (answer.ok) return { ok: true, answer };
        code = await errorCode(answer);
    } catch {
        return { ok: false, delivery: { status: 'failed', retryable: true } };
    }

    if (answer.status === 409 && code === 'already_attached') return { ok: false, delivery: { status: 'sent' } };
    if (answer.status === 503 && code === 'screenshots_paused') return { ok: false, delivery: { status: 'paused' } };
    if (answer.status === 404) return { ok: false, delivery: { status: 'failed', retryable: false } };
    if (answer.status === 410 && path === '/reports/upload') {
        return { ok: false, delivery: { status: 'failed', retryable: false } };
    }
    return { ok: false, delivery: { status: 'failed', retryable: true } };
}

/**
 * Sends a saved report's image: the grant from create, or a new one when there
 * is none (a retry), then the storage POST, then attach. The report itself is
 * already saved whatever this answers.
 */
export async function deliverReportImage({
    auth,
    reportId,
    attachToken,
    image,
    grant,
}: {
    auth: ReportAuth;
    reportId: string;
    attachToken: string;
    image: Blob;
    grant: UploadGrant | null;
}): Promise<ImageDelivery> {
    let upload = grant;
    if (!upload) {
        const step = await imageStep(auth, '/reports/upload', {
            report_id: reportId,
            attach_token: attachToken,
            image: imageMetaFor(image),
        });
        if (!step.ok) return step.delivery;
        let parsed: UploadGrant | null = null;
        try {
            const body = parseJson(await step.answer.text());
            parsed = isRecord(body) ? parseGrant(body.upload) : null;
        } catch {
            parsed = null;
        }
        if (!parsed) return { status: 'failed', retryable: true };
        upload = parsed;
    }

    if (!(await postImageToStorage(upload, image))) return { status: 'failed', retryable: true };

    const attached = await imageStep(auth, '/reports/attach', { report_id: reportId, attach_token: attachToken });
    return attached.ok ? { status: 'sent' } : attached.delivery;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** What the form assumes when it cannot read the switches: the server still enforces them. */
const OPEN_CONFIG: ReportConfig = { reporting: true, signed_out: true, screenshots: true };

let cachedConfig: { value: ReportConfig; at: number } | null = null;
let configInFlight: Promise<ReportConfig> | null = null;

export function clearReportConfigCache(): void {
    cachedConfig = null;
    configInFlight = null;
}

async function fetchConfig(): Promise<ReportConfig> {
    try {
        const answer = await recordedFetch(
            apiUrl('/public/reports/config'),
            { method: 'GET' },
            { method: 'GET', url: '/public/reports/config' },
            TIMEOUT_MS,
        );
        if (!answer.ok) return OPEN_CONFIG;
        const body = parseJson(await answer.text());
        if (!isRecord(body)) return OPEN_CONFIG;
        const value: ReportConfig = {
            reporting: body.reporting !== false,
            signed_out: body.signed_out !== false,
            screenshots: body.screenshots !== false,
        };
        cachedConfig = { value, at: Date.now() };
        return value;
    } catch {
        return OPEN_CONFIG;
    }
}

/**
 * The report switches, read at most once a minute (the route's own cache
 * lifetime). Concurrent callers share one request. A failed read is not
 * remembered, so the next open tries again.
 */
export function getReportConfig(): Promise<ReportConfig> {
    if (cachedConfig && Date.now() - cachedConfig.at < REPORT_CONFIG_TTL_MS) {
        return Promise.resolve(cachedConfig.value);
    }
    if (!configInFlight) {
        configInFlight = fetchConfig().finally(() => {
            configInFlight = null;
        });
    }
    return configInFlight;
}
