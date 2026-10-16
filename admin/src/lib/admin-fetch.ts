// The one way the admin's client code calls an admin API route (K1.3).
//  - The body is JSON.stringify'd once; the same string is hashed for
//    x-amz-content-sha256 (CloudFront's origin access control signs the
//    payload) and sent. No body hashes the empty string.
//  - A 401 means the session ended: one navigation to the sign-in page with
//    `next` set to where the admin was and `reason=expired`. Sign-in and
//    sign-out pass redirectOn401: false, because their 401s mean something else.
//  - Nothing throws to the caller: every result is an outcome to render.

export type AdminFetchOutcome<T> =
  | { kind: 'ok'; status: number; data: T | null }
  | { kind: 'error'; status: number; data: T | null }
  | { kind: 'redirecting' }
  | { kind: 'network' };

type AdminFetchInit = {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  redirectOn401?: boolean;
};

/** Lowercase hex SHA-256 of the UTF-8 bytes of `value`. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** '/login?next=<path+query>&reason=expired' for the page the admin is on. */
export function expiredLoginHref(loc: { pathname: string; search: string }): string {
  return `/login?next=${encodeURIComponent(loc.pathname + loc.search)}&reason=expired`;
}

async function readJson<T>(response: Response): Promise<T | null> {
  if (response.status === 204) return null;
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function adminFetchJson<T>(url: string, init: AdminFetchInit): Promise<AdminFetchOutcome<T>> {
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  let response: Response;
  try {
    // Hashing sits inside the try: without crypto.subtle (an insecure
    // origin) the request cannot be signed, which reads as a network failure.
    const headers: Record<string, string> = { 'x-amz-content-sha256': await sha256Hex(body ?? '') };
    if (body !== undefined) headers['content-type'] = 'application/json';
    response = await fetch(url, { method: init.method, headers, body, signal: init.signal, credentials: 'same-origin' });
  } catch {
    return { kind: 'network' };
  }

  if (response.status === 401 && (init.redirectOn401 ?? true)) {
    window.location.assign(expiredLoginHref(window.location));
    return { kind: 'redirecting' };
  }

  const data = await readJson<T>(response);
  return response.ok ? { kind: 'ok', status: response.status, data } : { kind: 'error', status: response.status, data };
}
