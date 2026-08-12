// ---------------------------------------------------------------------------
// Typed API errors
//
// One error shape for every API call in the app. `ApiError` preserves the HTTP
// status, a provider-safe error code (the backend's `error` field -- a stable
// string, never a raw provider/exception message), and an allowlisted set of
// extra payload fields the backend is known to attach to specific error codes
// (e.g. job_limit_reached's plan/limit info). Anything outside the allowlist is
// dropped so we never leak unexpected server detail into the UI.
//
// This module deliberately imports nothing: `../api` imports it (apiFetch
// raises `ApiError` for transport failures), so importing `../api` back would
// create a cycle.
// ---------------------------------------------------------------------------

export type ApiErrorPayload = {
  plan_code?: string;
  active_job_limit?: number;
  active_jobs?: number;
  template_limit?: number;
  requiredVersion?: string;
  currentVersion?: string;
  required?: string[];
  /** Doc types a worker still has to upload before an application is accepted. */
  missing_docs?: string[];
};

const ALLOWED_PAYLOAD_KEYS = [
  'plan_code',
  'active_job_limit',
  'active_jobs',
  'template_limit',
  'requiredVersion',
  'currentVersion',
  'required',
  'missing_docs',
] as const;

/**
 * A failed API call.
 *
 * Invariants the rest of the app relies on:
 * - `message === code` ALWAYS. Pages branch on `err.message === '<code>'`
 *   (employer job detail, employer conversations) as well as on `err.code`;
 *   both must keep working off the same value.
 * - `status === 0` means no HTTP response was ever received -- a network
 *   failure (`code: 'offline'`) or a client-side timeout (`code: 'timeout'`).
 * - `missing_docs` mirrors `payload.missing_docs` so existing reads
 *   (`applyErr.missing_docs`) keep working without reaching into `payload`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly payload: ApiErrorPayload;
  readonly missing_docs?: string[];

  constructor(status: number, code: string, payload: ApiErrorPayload = {}) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
    if (payload.missing_docs !== undefined) this.missing_docs = payload.missing_docs;
    // Keeps `instanceof` working if this ever gets transpiled down to ES5,
    // where subclassing a built-in loses the prototype link.
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/**
 * Reads an error response body without ever throwing: an empty body, a
 * non-JSON body (HTML error page, S3 XML) and a JSON scalar/array all collapse
 * to `{}`, which means the caller's `fallbackCode` is used.
 */
async function readErrorBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json();
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Empty or non-JSON body -- fall through to the empty object.
  }
  return {};
}

function pickAllowedPayload(body: Record<string, unknown>): ApiErrorPayload {
  const payload: ApiErrorPayload = {};
  for (const key of ALLOWED_PAYLOAD_KEYS) {
    const value = body[key];
    if (value === undefined) continue;
    // `missing_docs` is the one payload field the UI iterates over (it renders
    // one label per entry), so a malformed value would crash the page rather
    // than degrade it. Everything else is passed through as the backend sent it.
    if (key === 'missing_docs' && !isStringArray(value)) continue;
    (payload as Record<string, unknown>)[key] = value;
  }
  return payload;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Builds an `ApiError` from a non-OK response. The code is the backend's
 * `error` field when present, otherwise `fallbackCode`.
 */
export async function parseApiError(res: Response, fallbackCode: string): Promise<ApiError> {
  const body = await readErrorBody(res);
  const rawCode = body.error;
  const code = typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : fallbackCode;
  return new ApiError(res.status, code, pickAllowedPayload(body));
}

// ---------------------------------------------------------------------------
// Classification
//
// Turns any thrown value -- typed or legacy, ours or the platform's -- into one
// of a small closed set of kinds the UI can render and decide retries from.
// ---------------------------------------------------------------------------

export type ErrorKind =
  | 'offline'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'gone'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'server'
  | 'legal_wall'
  | 'unknown';

export type ClassifiedError = {
  kind: ErrorKind;
  status?: number;
  code?: string;
  payload?: ApiErrorPayload;
  /** Whether retrying the identical request could plausibly succeed. */
  retryable: boolean;
};

const RETRYABLE_KINDS: readonly ErrorKind[] = ['offline', 'timeout', 'rate_limited', 'server'];

export function isRetryableKind(kind: ErrorKind): boolean {
  return RETRYABLE_KINDS.includes(kind);
}

function kindForStatus(status: number): ErrorKind {
  if (status === 0) return 'offline';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 410) return 'gone';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * `LegalWallError` lives in `../api` (it is part of apiFetch's contract) and
 * that module imports this one, so we identify it by the `name` marker its
 * constructor stamps -- exactly what `isLegalWallError()` checks -- instead of
 * importing it back and creating a cycle.
 */
function isLegalWallShape(err: unknown): boolean {
  return err instanceof Error && err.name === 'LegalWallError';
}

/**
 * Pre-`ApiError` call sites built errors as `new Error(code)` with `status`
 * (and sometimes `code`) tacked on. Nothing in `src/lib/api/*` throws that
 * shape any more, but page-local fetches still do, so classification has to
 * understand it.
 */
function asLegacyHttpError(err: unknown): { status: number; code?: string } | null {
  if (!(err instanceof Error)) return null;
  const candidate = err as Error & { status?: unknown; code?: unknown };
  if (typeof candidate.status !== 'number' || !Number.isFinite(candidate.status)) return null;
  const code = typeof candidate.code === 'string' && candidate.code.length > 0
    ? candidate.code
    : (err.message.length > 0 ? err.message : undefined);
  return { status: candidate.status, code };
}

export function classifyError(err: unknown): ClassifiedError {
  if (isLegalWallShape(err)) {
    // apiFetch only raises this for a 403 { error: 'legal_required' }.
    return { kind: 'legal_wall', status: 403, code: 'legal_required', retryable: false };
  }

  if (err instanceof ApiError) {
    const kind: ErrorKind = err.status === 0 && err.code === 'timeout'
      ? 'timeout'
      : kindForStatus(err.status);
    return {
      kind,
      status: err.status,
      code: err.code,
      payload: err.payload,
      retryable: isRetryableKind(kind),
    };
  }

  if (err instanceof TypeError) {
    // `fetch` rejects with a TypeError when the request never reached the
    // server at all (offline, DNS failure, CORS/network error).
    return { kind: 'offline', retryable: true };
  }

  const legacy = asLegacyHttpError(err);
  if (legacy) {
    const kind = kindForStatus(legacy.status);
    return { kind, status: legacy.status, code: legacy.code, retryable: isRetryableKind(kind) };
  }

  return { kind: 'unknown', retryable: false };
}

/**
 * i18n key for an error kind, within the `common` namespace.
 *
 * `legal_wall` maps to the generic key on purpose: it is a redirect, not a
 * message, so anything still rendering it has already missed the redirect and
 * the honest thing to show is the generic failure copy.
 */
export function errorMessageKey(kind: ErrorKind): string {
  return kind === 'legal_wall' ? 'errors.unknown' : `errors.${kind}`;
}
