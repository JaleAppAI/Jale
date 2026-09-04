import { ApiError } from './api/errors';
import { getAuthBridge } from './auth-bridge';

export class LegalWallError extends Error {
    constructor() {
        super('legal_required');
        this.name = 'LegalWallError';
        Object.setPrototypeOf(this, LegalWallError.prototype);
    }
}

export function isLegalWallError(err: unknown): err is LegalWallError {
    return err instanceof LegalWallError || (
        err instanceof Error && err.name === 'LegalWallError'
    );
}

// The backend provisions a new user's `users` row from a post-confirmation
// Cognito trigger, which races the frontend's first API call after signup.
// Every handler returns 409 { error: 'user_not_provisioned' } during that
// brief window, so we retry (with backoff) instead of surfacing it as a
// fatal error to the caller.
export const PROVISIONING_RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * Per-attempt request budget. Every attempt (the first request, each
 * provisioning retry, the post-refresh replay) gets its own fresh window --
 * a request that has been retried three times has still only been waited on
 * for 15s at a time, and a hung connection can never wedge a page forever.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

export type ApiFetchOptions = {
    /** Per-attempt timeout in ms. Defaults to `DEFAULT_TIMEOUT_MS`. */
    timeoutMs?: number;
    /**
     * Whether a 401 should trigger the refresh-and-replay path. Defaults to
     * true. Set false for calls that must surface the raw 401 (e.g. probing
     * whether a token is still valid).
     */
    retryOn401?: boolean;
};


/**
 * The app locale, read from the URL's first path segment (`/en/...`, `/es/...`)
 * -- every app route is locale-prefixed by the middleware. Sent as
 * `Accept-Language` on every API call so a handler that stores
 * language-specific text (the worker profile editor's canonical trade label)
 * follows the locale the worker chose, not the browser's OS language, which
 * is what the browser's own Accept-Language header carries. Undefined on the
 * server and on non-locale paths; a caller-supplied header always wins.
 */
function appLocaleHeader(): Record<string, string> {
    if (typeof window === 'undefined') return {};
    const match = /^\/(en|es)(?=\/|$)/.exec(window.location?.pathname ?? '');
    return match ? { 'Accept-Language': match[1] } : {};
}

export async function apiFetch(
    path: string,
    options?: RequestInit,
    token?: string,
    opts?: ApiFetchOptions,
): Promise<Response> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retryOn401 = opts?.retryOn401 !== false;
    const callerSignal = options?.signal ?? null;

    // One network attempt, with its own AbortController so the timeout of one
    // attempt can never abort a later one. A caller-supplied signal is chained
    // in: either source aborts the attempt.
    const attempt = async (authToken?: string): Promise<Response> => {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const forwardAbort = () => controller.abort();
        if (callerSignal) {
            if (callerSignal.aborted) controller.abort();
            else callerSignal.addEventListener('abort', forwardAbort);
        }

        try {
            return await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}${path}`, {
                ...options,
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    ...appLocaleHeader(),
                    ...(authToken ? { Authorization: authToken } : {}),
                    ...options?.headers,
                },
            });
        } catch (err) {
            if (timedOut) throw new ApiError(0, 'timeout');
            // A caller who aborted deliberately (effect cleanup, navigation)
            // gets the standard AbortError back, not a synthetic API error.
            if (callerSignal?.aborted) throw err;
            // `fetch` rejects with a TypeError when the request never reached
            // the server: offline, DNS failure, CORS/network error.
            if (err instanceof TypeError) throw new ApiError(0, 'offline');
            throw err;
        } finally {
            clearTimeout(timer);
            callerSignal?.removeEventListener('abort', forwardAbort);
        }
    };

    const requestWithProvisioningRetry = async (authToken?: string): Promise<Response> => {
        let res = await attempt(authToken);

        for (const delay of PROVISIONING_RETRY_DELAYS_MS) {
            if (res.status !== 409) break;
            // Clone before reading body so the original response remains usable by the caller.
            const body = await res.clone().json().catch(() => null) as { error?: string } | null;
            if (body?.error !== 'user_not_provisioned') break;

            await new Promise(resolve => setTimeout(resolve, delay));
            res = await attempt(authToken);
        }

        return res;
    };

    let res = await requestWithProvisioningRetry(token);

    // Mid-session 401: ask the auth layer for a fresh id token and replay the
    // request ONCE. Only for authenticated calls -- a token-less call (e.g.
    // /auth/refresh itself) must never re-enter the refresh path, or refresh
    // failures would recurse.
    if (res.status === 401 && token && retryOn401) {
        const bridge = getAuthBridge();
        let refreshedToken: string | null = null;
        if (bridge) {
            try {
                refreshedToken = await bridge.refreshIdToken();
            } catch {
                refreshedToken = null;
            }
        }

        if (typeof refreshedToken === 'string' && refreshedToken.length > 0) {
            res = await requestWithProvisioningRetry(refreshedToken);
        }

        // Still 401 after the replay (or no refresh was possible): the session
        // is genuinely gone. Never refresh a second time.
        if (res.status === 401) {
            try {
                bridge?.onSessionExpired();
            } catch {
                // A failing redirect must not mask the error the caller expects.
            }
            throw new ApiError(401, 'session_expired');
        }
    }

    // Checked after the 401 path so a replayed request's legal wall is caught
    // too. A 403 is never a 401, so the ordering is otherwise unobservable.
    if (res.status === 403) {
        // Clone before reading body so the original response remains usable by the caller.
        const body = await res.clone().json().catch(() => null) as { error?: string } | null;
        if (body?.error === 'legal_required') throw new LegalWallError();
    }

    return res;
}
