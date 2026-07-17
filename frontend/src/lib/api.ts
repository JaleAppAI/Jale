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

export async function apiFetch(
    path: string,
    options?: RequestInit,
    token?: string
): Promise<Response> {
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: token } : {}),
            ...options?.headers,
        },
    });

    if (res.status === 403) {
        // Clone before reading body so the original response remains usable by the caller.
        const body = await res.clone().json().catch(() => null) as { error?: string } | null;
        if (body?.error === 'legal_required') throw new LegalWallError();
    }

    return res;
}
