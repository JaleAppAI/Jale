/**
 * What a Team page action hands back to the component that started it.
 *
 * The page owns every API call (and the refetch, toast and legal-wall routing
 * around it); the components own only the in-flight and error display.
 *
 * - `ok: true`: done. The page has already toasted and refetched.
 * - `ok: false` with a `message`: show it next to the control.
 * - `ok: false` with `message: null`: nothing to show (the error was routed
 *   away, e.g. to the legal wall or `/employer/access`).
 * - `retryAfterSeconds`: a rate limit; the control stays disabled that long.
 * - `code`: the backend's error code, so a form can mark the field it is about.
 */
export type TeamActionResult =
    | { ok: true }
    | { ok: false; message: string | null; retryAfterSeconds?: number; code?: string };
