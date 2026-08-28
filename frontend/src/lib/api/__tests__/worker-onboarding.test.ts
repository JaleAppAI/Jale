import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../errors';
import {
    getWorkerOnboarding,
    patchOnboardingLanguage,
    postOnboardingAnswers,
    postOnboardingBack,
    type OnboardingState,
} from '../worker';

/**
 * The onboarding endpoints, driven through REAL `Response` objects.
 *
 * That matters more here than in most API tests. `postOnboardingAnswers` is
 * the one helper in the module that returns a union instead of throwing, and
 * it decides which member to return by reading a body that `apiFetch` has
 * ALREADY read once on the way past (its provisioning retry clones and
 * inspects every 409). A hand-rolled stub with a `clone()` that returns
 * `this` cannot catch a double-read of the same stream; a real `Response`
 * throws the moment we get it wrong.
 *
 * Runs in the 'node' environment, where `Response` is undici's.
 */

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

const STATE = {
    lifecycle: 'onboarding',
    run: {
        id: 'run-1',
        stepKey: 'profile.name',
        lockVersion: 3,
        preferredLanguage: 'en',
        workflowVersion: 1,
    },
    profile: {
        fullName: null, location: null, trade: null,
        yearsExperience: null, hasTransportation: null, availability: null,
    },
    trust: { questions: [], answers: [] },
    pendingLocationConfirm: null,
    extraction: null,
} as unknown as OnboardingState;

const TOKEN = 'id-token';
const BODY = { lockVersion: 3, answers: [{ stepKey: 'profile.name', value: 'David C' }] };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('getWorkerOnboarding', () => {
    it('returns the run on 200', async () => {
        fetchMock.mockResolvedValue(json(200, STATE));
        await expect(getWorkerOnboarding(TOKEN)).resolves.toEqual(STATE);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/worker/onboarding');
        expect(init.headers.Authorization).toBe(TOKEN);
    });

    it('throws the backend code on a 404 rather than a generic failure', async () => {
        fetchMock.mockResolvedValue(json(404, { error: 'worker_not_found' }));
        await expect(getWorkerOnboarding(TOKEN)).rejects.toMatchObject({
            status: 404,
            code: 'worker_not_found',
        });
    });
});

describe('postOnboardingAnswers — the union', () => {
    it('saves on 200', async () => {
        fetchMock.mockResolvedValue(json(200, STATE));
        await expect(postOnboardingAnswers(TOKEN, BODY)).resolves.toEqual({ kind: 'saved', state: STATE });
    });

    it('reads the fresh run out of a 409 lock_conflict', async () => {
        // The body carries the run as it now stands, so the caller can retry
        // without a second GET. Note this is the same 409 status apiFetch's
        // provisioning retry inspects on the way past.
        fetchMock.mockResolvedValue(json(409, { error: 'lock_conflict', state: STATE }));
        await expect(postOnboardingAnswers(TOKEN, BODY)).resolves.toEqual({
            kind: 'lock_conflict',
            state: STATE,
        });
        // Inspected, not retried: `user_not_provisioned` is the only 409 that
        // gets replayed.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still reports the conflict when the 409 carries no state', async () => {
        fetchMock.mockResolvedValue(json(409, { error: 'lock_conflict' }));
        await expect(postOnboardingAnswers(TOKEN, BODY)).resolves.toEqual({ kind: 'lock_conflict', state: undefined });
    });

    it('carries the rejected step and its reason out of a 422', async () => {
        fetchMock.mockResolvedValue(json(422, {
            error: 'step_rejected',
            rejectedStepKey: 'profile.location',
            reason: 'unknown_city',
            state: STATE,
        }));
        await expect(postOnboardingAnswers(TOKEN, BODY)).resolves.toEqual({
            kind: 'step_rejected',
            rejectedStepKey: 'profile.location',
            reason: 'unknown_city',
            state: STATE,
        });
    });

    it('reports a step_mismatch with nothing attached — the caller must re-read', async () => {
        fetchMock.mockResolvedValue(json(422, { error: 'step_mismatch' }));
        await expect(postOnboardingAnswers(TOKEN, BODY)).resolves.toEqual({ kind: 'step_mismatch' });
    });

    it('reports both blocked reasons', async () => {
        fetchMock.mockImplementation(async () => json(409, { error: 'suspended' }));
        await expect(postOnboardingAnswers(TOKEN, BODY)).resolves.toEqual({ kind: 'blocked', reason: 'suspended' });

        fetchMock.mockImplementation(async () => json(409, { error: 'not_onboardable' }));
        await expect(postOnboardingAnswers(TOKEN, BODY)).resolves.toEqual({ kind: 'blocked', reason: 'not_onboardable' });
    });

    it('THROWS on unknown_step — a client bug is not a union member', async () => {
        // Nothing a worker can do about it, and no screen should try to
        // render it: it takes the same path as a 500.
        //
        // A fresh Response per call, deliberately: a body is a stream that can
        // be consumed once, so handing the same object to two calls would fail
        // on the plumbing rather than on the behaviour under test.
        fetchMock.mockImplementation(async () => json(422, { error: 'unknown_step' }));
        await expect(postOnboardingAnswers(TOKEN, BODY)).rejects.toBeInstanceOf(ApiError);
        await expect(postOnboardingAnswers(TOKEN, BODY)).rejects.toMatchObject({ code: 'unknown_step', status: 422 });
    });

    it('throws on a 404 worker_not_found', async () => {
        fetchMock.mockResolvedValue(json(404, { error: 'worker_not_found' }));
        await expect(postOnboardingAnswers(TOKEN, BODY)).rejects.toMatchObject({
            status: 404,
            code: 'worker_not_found',
        });
    });

    it('degrades a 409 with an unreadable body to a thrown error, not a half-built union', async () => {
        // A proxy or a WAF can return a 409 with an HTML page in it. Reading
        // it must not produce `{ kind: 'lock_conflict' }` and send the flow
        // into a retry it was never told to do.
        fetchMock.mockResolvedValue(new Response('<html>nope</html>', { status: 409 }));
        await expect(postOnboardingAnswers(TOKEN, BODY)).rejects.toBeInstanceOf(ApiError);
    });

    it('throws on a 500', async () => {
        fetchMock.mockResolvedValue(json(500, { error: 'internal_error' }));
        await expect(postOnboardingAnswers(TOKEN, BODY)).rejects.toBeInstanceOf(ApiError);
    });
});

describe('postOnboardingBack and patchOnboardingLanguage', () => {
    it('return the run they moved', async () => {
        fetchMock.mockImplementation(async () => json(200, STATE));
        await expect(postOnboardingBack(TOKEN, { lockVersion: 3 })).resolves.toEqual(STATE);
        await expect(patchOnboardingLanguage(TOKEN, { preferredLanguage: 'es' })).resolves.toEqual(STATE);

        const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(init.body)).toEqual({ preferredLanguage: 'es' });
    });

    it('throw rather than returning a union — only `answers` has expected rejections', async () => {
        fetchMock.mockImplementation(async () => json(409, { error: 'lock_conflict' }));
        await expect(postOnboardingBack(TOKEN, { lockVersion: 3 })).rejects.toBeInstanceOf(ApiError);
        await expect(patchOnboardingLanguage(TOKEN, { preferredLanguage: 'es' })).rejects.toBeInstanceOf(ApiError);
    });

    it('forward an abort signal like the read does', async () => {
        const controller = new AbortController();
        fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
                const err = new Error('The operation was aborted.');
                err.name = 'AbortError';
                reject(err);
            });
        }));

        const pending = postOnboardingBack(TOKEN, { lockVersion: 3 }, controller.signal);
        controller.abort();
        await expect(pending).rejects.toThrow(/aborted/i);
    });
});
