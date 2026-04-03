export class LegalWallError extends Error {}

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
        // Clone before reading body so the original response remains usable by the caller
        try {
            const body = await res.clone().json();
            if (body.error === 'legal_required') throw new LegalWallError();
        } catch (e) {
            if (e instanceof LegalWallError) throw e;
            // Non-JSON 403 or different error code — fall through and return response as-is
        }
    }

    return res;
}
