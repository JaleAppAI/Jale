import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApplications, getJob as getWorkerJob, getJobs as getWorkerJobs } from '../worker';
import {
    getBilling,
    getConversation,
    getEmployerDigestSettings,
    getInbox,
    getJob as getEmployerJob,
    getJobApplicants,
    getJobCandidates,
    getJobs as getEmployerJobs,
    getWorkerDocuments,
    getWorkerProfile,
} from '../employer';

/**
 * The contract these tests defend: a read helper handed an `AbortSignal`
 * forwards it all the way to `fetch`, so aborting REJECTS the call instead of
 * letting it resolve later. Before this, `usePageData` could only discard the
 * answer to an abandoned request -- the request itself ran to completion.
 *
 * vitest.config.mts runs this suite in the 'node' environment (no jsdom), so
 * responses are minimal stubs: apiFetch only touches status/clone/json.
 */

function mockResponse(status: number, body: unknown): Response {
    const res = {
        ok: status >= 200 && status < 300,
        status,
        clone() { return res; },
        json: async () => body,
    };
    return res as unknown as Response;
}

/** What a real `fetch` rejects with once its signal aborts. */
function abortError(): Error {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    return err;
}

/**
 * A fetch that only ever ends by abort. If the helper failed to forward the
 * signal, the returned promise would hang forever and the test would time out
 * -- which is exactly the bug being tested for.
 */
function abortOnly() {
    return (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        if (init.signal?.aborted) return reject(abortError());
        init.signal?.addEventListener('abort', () => reject(abortError()));
    });
}

describe('AbortSignal forwarding in the API modules', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe('an aborted request rejects rather than resolving', () => {
        it('rejects a worker feed request when the caller aborts mid-flight', async () => {
            fetchMock.mockImplementation(abortOnly());
            const controller = new AbortController();

            const pending = getWorkerJobs('token', { search: 'welder' }, controller.signal);
            // Nothing has settled yet; the abort is what ends it.
            controller.abort();

            await expect(pending).rejects.toThrow(/aborted/i);
        });

        it('rejects immediately when handed an already-aborted signal', async () => {
            fetchMock.mockImplementation(abortOnly());
            const controller = new AbortController();
            controller.abort();

            await expect(getEmployerJobs('token', controller.signal)).rejects.toThrow(/aborted/i);
        });

        it('does not resolve the abandoned request afterwards', async () => {
            fetchMock.mockImplementation(abortOnly());
            const controller = new AbortController();

            const settled: string[] = [];
            const pending = getBilling('token', controller.signal)
                .then(() => settled.push('resolved'))
                .catch(() => settled.push('rejected'));

            controller.abort();
            await pending;

            expect(settled).toEqual(['rejected']);
        });

        it('surfaces the AbortError itself, not a synthetic transport error', async () => {
            fetchMock.mockImplementation(abortOnly());
            const controller = new AbortController();

            const pending = getInbox('token', controller.signal);
            controller.abort();

            // apiFetch deliberately rethrows the caller's abort untouched, so a
            // deliberate cancellation stays distinguishable from a timeout
            // (ApiError 'timeout') or a network failure (ApiError 'offline').
            await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        });
    });

    describe('the signal reaches fetch', () => {
        const cases: Array<[string, (signal: AbortSignal) => Promise<unknown>]> = [
            ['worker getJobs', (s) => getWorkerJobs('t', undefined, s)],
            ['worker getJob', (s) => getWorkerJob('t', 'job-1', s)],
            ['worker getApplications', (s) => getApplications('t', s)],
            ['employer getJobs', (s) => getEmployerJobs('t', s)],
            ['employer getJob', (s) => getEmployerJob('t', 'job-1', s)],
            ['employer getJobApplicants', (s) => getJobApplicants('t', 'job-1', {}, s)],
            ['employer getJobCandidates', (s) => getJobCandidates('t', 'job-1', 100, s)],
            ['employer getInbox', (s) => getInbox('t', s)],
            ['employer getConversation', (s) => getConversation('t', 'c-1', s)],
            ['employer getWorkerProfile', (s) => getWorkerProfile('t', 'w-1', 'job-1', s)],
            ['employer getWorkerDocuments', (s) => getWorkerDocuments('t', 'w-1', 'job-1', s)],
            ['employer getBilling', (s) => getBilling('t', s)],
            ['employer getEmployerDigestSettings', (s) => getEmployerDigestSettings('t', s)],
        ];

        it.each(cases)('%s aborts when the caller does', async (_name, call) => {
            fetchMock.mockImplementation(abortOnly());
            const controller = new AbortController();

            const pending = call(controller.signal);
            controller.abort();

            await expect(pending).rejects.toThrow(/aborted/i);
        });
    });

    describe('the signal stays optional', () => {
        it('resolves normally when no signal is passed', async () => {
            fetchMock.mockResolvedValue(mockResponse(200, { jobs: [{ id: 'j1' }] }));

            await expect(getWorkerJobs('token')).resolves.toEqual({ jobs: [{ id: 'j1' }] });
        });

        it('resolves normally when a signal is passed but never aborted', async () => {
            fetchMock.mockResolvedValue(mockResponse(200, { conversations: [] }));
            const controller = new AbortController();

            await expect(getInbox('token', controller.signal)).resolves.toEqual({ conversations: [] });
        });

        it('still raises the module error shape on a non-ok response', async () => {
            fetchMock.mockResolvedValue(mockResponse(500, { error: 'boom' }));
            const controller = new AbortController();

            await expect(getBilling('token', controller.signal)).rejects.toMatchObject({
                status: 500,
                code: 'boom',
            });
        });
    });
});
