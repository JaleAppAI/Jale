export class LegalWallError extends Error { }

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
        const body = await res.json();
        if (body.code === 'legal_required') throw new LegalWallError();
    }

    return res;
}
