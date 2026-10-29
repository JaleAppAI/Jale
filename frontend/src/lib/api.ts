import { ApiError, SESSION_REFRESH_UNAVAILABLE } from './api/errors';
import { getAuthBridge, type RefreshOutcome } from './auth-bridge';
import { isTeamManagementEnabled } from './feature-flags';
import { recordApiError, recordApiErrorResponse, recordFetch } from './report/context';

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

/** Why an employer login cannot use the company's account (Phase 3). */
export type MembershipBlockedReason = 'suspended' | 'removed' | 'no_organization';

/**
 * An employer login the backend refuses because of its company membership,
 * raised by `apiFetch` (team management flag on only) for:
 *   - 403 `no_organization`: the login belongs to no company (an invite that
 *     expired before it was accepted). The access screen offers "start my own
 *     company".
 *   - 403 `membership_inactive`: `membershipStatus` `removed` gives `removed`;
 *     `suspended`, or no status at all, gives `suspended`. Only the membership
 *     route itself (GET `/employer/team/membership`) always names the status
 *     and says whether a re-invite is waiting (`hasInvite`); elsewhere the
 *     status can be absent (`statusKnown: false`) and `hasInvite` is unknown,
 *     so the access screen re-reads membership on arrival.
 *
 * `useRequireAuth().handleLegalWall` routes it to `/employer/access`. Like
 * `LegalWallError`, it carries a `name` marker so `lib/api/errors` can
 * recognise it without importing this module back.
 */
export class MembershipBlockedError extends Error {
    readonly reason: MembershipBlockedReason;
    readonly hasInvite: boolean;
    /**
     * False when a 403 `membership_inactive` named no status and `reason` is
     * the `suspended` default: `handleLegalWall` then sends no reason, and the
     * access screen shows its loading card until membership answers.
     */
    readonly statusKnown: boolean;

    constructor(reason: MembershipBlockedReason, hasInvite = false, statusKnown = true) {
        super('membership_blocked');
        this.name = 'MembershipBlockedError';
        this.reason = reason;
        this.hasInvite = hasInvite;
        this.statusKnown = statusKnown;
        Object.setPrototypeOf(this, MembershipBlockedError.prototype);
    }
}

export function isMembershipBlockedError(err: unknown): err is MembershipBlockedError {
    return err instanceof MembershipBlockedError || (
        err instanceof Error && err.name === 'MembershipBlockedError'
    );
}

/** The `MembershipBlockedError` for a 403 body, or null for any other 403. */
function membershipBlockedFromBody(body: unknown): MembershipBlockedError | null {
    if (body === null || typeof body !== 'object') return null;
    const { error, membershipStatus, hasInvite } = body as Record<string, unknown>;
    if (error === 'no_organization') return new MembershipBlockedError('no_organization');
    if (error !== 'membership_inactive') return null;
    const statusKnown = membershipStatus === 'removed' || membershipStatus === 'suspended';
    return new MembershipBlockedError(
        membershipStatus === 'removed' ? 'removed' : 'suspended',
        hasInvite === true,
        statusKnown,
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

/**
 * Every API call. Each underlying request, retries and the replay after a
 * refresh included, is recorded for problem reports as a path pattern with
 * its status and duration, and a call that ends in failure is recorded as
 * "<status> <code>". Recording only observes: the caller gets exactly the
 * response or the error that `sendApiRequest` produced.
 */
export async function apiFetch(
    path: string,
    options?: RequestInit,
    token?: string,
    opts?: ApiFetchOptions,
): Promise<Response> {
    let res: Response;
    try {
        res = await sendApiRequest(path, options, token, opts);
    } catch (err) {
        if (err instanceof ApiError) recordApiError(err.status, err.code);
        else if (isLegalWallError(err)) recordApiError(403, 'legal_required');
        else if (isMembershipBlockedError(err)) {
            recordApiError(403, err.reason === 'no_organization' ? 'no_organization' : 'membership_inactive');
        }
        // A caller that aborted on purpose has not met a failure.
        else if (!options?.signal?.aborted) recordApiError(0);
        throw err;
    }
    if (res.status >= 400) recordApiErrorResponse(res);
    return res;
}

async function sendApiRequest(
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

        const url = `${process.env.NEXT_PUBLIC_API_BASE_URL}${path}`;
        try {
            return await recordFetch({ method: options?.method ?? 'GET', url }, () => fetch(url, {
                ...options,
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    ...appLocaleHeader(),
                    ...(authToken ? { Authorization: authToken } : {}),
                    ...options?.headers,
                },
            }));
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
        // No bridge means there is no way to renew: a plain expiry, which is
        // the pre-bridge behaviour.
        let outcome: RefreshOutcome | null = { status: 'refused' };
        if (bridge) {
            try {
                outcome = await bridge.refreshIdToken();
            } catch {
                // The renewal got no answer (offline, timeout). Whether the
                // session is still good is unknown, so it is kept, and the
                // caller gets the ordinary retryable transport error.
                throw new ApiError(0, 'offline');
            }
        }

        // The refresh endpoint answered without a verdict on the token (5xx,
        // unreadable body). Same rule: keep the session and let the page show
        // its retry state.
        if (outcome?.status === 'unavailable') {
            throw new ApiError(503, SESSION_REFRESH_UNAVAILABLE);
        }

        if (outcome?.status === 'ok' && typeof outcome.token === 'string' && outcome.token.length > 0) {
            res = await requestWithProvisioningRetry(outcome.token);
        }

        // Refused, an answer this layer cannot read, or still 401 after the
        // replay: the session is genuinely gone. Never refresh a second time.
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
        // Phase 3. With the flag off the 403 reaches the caller exactly as in
        // Phase 2: an orgless login is never sent to /employer/access.
        if (isTeamManagementEnabled()) {
            const blocked = membershipBlockedFromBody(body);
            if (blocked) throw blocked;
        }
    }

    return res;
}
