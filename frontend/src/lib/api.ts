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

export async function apiFetch(
    path: string,
    options?: RequestInit,
    token?: string
): Promise<Response> {
    const doFetch = () => fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: token } : {}),
            ...options?.headers,
        },
    });

    let res = await doFetch();

    for (const delay of PROVISIONING_RETRY_DELAYS_MS) {
        if (res.status !== 409) break;
        // Clone before reading body so the original response remains usable by the caller.
        const body = await res.clone().json().catch(() => null) as { error?: string } | null;
        if (body?.error !== 'user_not_provisioned') break;

        await new Promise(resolve => setTimeout(resolve, delay));
        res = await doFetch();
    }

    if (res.status === 403) {
        // Clone before reading body so the original response remains usable by the caller.
        const body = await res.clone().json().catch(() => null) as { error?: string } | null;
        if (body?.error === 'legal_required') throw new LegalWallError();
    }

    return res;
}
