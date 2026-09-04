import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, DEFAULT_TIMEOUT_MS, LegalWallError, PROVISIONING_RETRY_DELAYS_MS } from '../api';
import { ApiError } from '../api/errors';
import { registerAuthBridge, type AuthBridge } from '../auth-bridge';

// vitest.config.ts runs this suite in the 'node' environment (no jsdom), so
// we build a minimal Response-like stub -- apiFetch only touches
// status/clone/json on what fetch returns.
function mockResponse(status: number, body: unknown): Response {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    clone() { return res; },
    json: async () => body,
  };
  return res as unknown as Response;
}

/** What a real `fetch` rejects with once its signal aborts. */
function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * A fetch implementation that answers after `ms` of (fake) time and honours
 * the AbortSignal it is handed -- the behaviour the timeout path relies on.
 */
function respondAfter(ms: number, status: number, body: unknown = { ok: true }) {
  return (_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    // A real fetch rejects straight away when handed an already-aborted signal.
    if (init.signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => resolve(mockResponse(status, body)), ms);
    init.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    });
  });
}

/** A fetch that never answers on its own; only an abort ends it. */
function neverResponds() {
  return (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init.signal?.aborted) return reject(abortError());
    init.signal?.addEventListener('abort', () => reject(abortError()));
  });
}

function authHeaderOfCall(fetchMock: ReturnType<typeof vi.fn>, index: number): string | undefined {
  return (fetchMock.mock.calls[index][1] as RequestInit & { headers: Record<string, string> })
    .headers.Authorization;
}

describe('apiFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test');
    vi.useFakeTimers();
  });

  afterEach(() => {
    registerAuthBridge(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('retries a user_not_provisioned 409 twice, then resolves with the eventual 200', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(409, { error: 'user_not_provisioned' }))
      .mockResolvedValueOnce(mockResponse(409, { error: 'user_not_provisioned' }))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    const promise = apiFetch('/worker/profile', {}, 'tok');

    // First fetch happens synchronously (before any timer fires).
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // First retry waits PROVISIONING_RETRY_DELAYS_MS[0].
    await vi.advanceTimersByTimeAsync(PROVISIONING_RETRY_DELAYS_MS[0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second retry waits PROVISIONING_RETRY_DELAYS_MS[1].
    await vi.advanceTimersByTimeAsync(PROVISIONING_RETRY_DELAYS_MS[1]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const res = await promise;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns the final 409 after exhausting all retries when the 409 never clears', async () => {
    for (let i = 0; i < 4; i++) {
      fetchMock.mockResolvedValueOnce(mockResponse(409, { error: 'user_not_provisioned' }));
    }

    const promise = apiFetch('/worker/profile', {}, 'tok');

    await vi.advanceTimersByTimeAsync(
      PROVISIONING_RETRY_DELAYS_MS.reduce((sum, d) => sum + d, 0),
    );

    const res = await promise;
    expect(res.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1 + PROVISIONING_RETRY_DELAYS_MS.length);
  });

  it('throws LegalWallError immediately on a 403 legal_required, without retrying', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(403, { error: 'legal_required' }));

    await expect(apiFetch('/worker/profile', {}, 'tok')).rejects.toThrow(LegalWallError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a 500 immediately without retrying', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(500, { error: 'internal_error' }));

    const res = await apiFetch('/worker/profile', {}, 'tok');

    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a 409 with a different error code immediately without retrying', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(409, { error: 'job_not_found' }));

    const res = await apiFetch('/worker/profile', {}, 'tok');

    expect(res.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('apiFetch timeouts and transport failures', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test');
    vi.useFakeTimers();
  });

  afterEach(() => {
    registerAuthBridge(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('rejects with ApiError(0, "timeout") when an attempt outlives the default window', async () => {
    fetchMock.mockImplementation(neverResponds());

    const promise = apiFetch('/worker/profile', {}, 'tok');
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      code: 'timeout',
      message: 'timeout',
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    await assertion;
    await expect(promise.catch((e) => e)).resolves.toBeInstanceOf(ApiError);
  });

  it('does not time out before the window elapses', async () => {
    fetchMock.mockImplementation(respondAfter(DEFAULT_TIMEOUT_MS - 1, 200));

    const promise = apiFetch('/worker/profile', {}, 'tok');
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);

    await expect(promise).resolves.toMatchObject({ status: 200 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours a caller-supplied timeoutMs', async () => {
    fetchMock.mockImplementation(neverResponds());

    const promise = apiFetch('/worker/profile', {}, 'tok', { timeoutMs: 500 });
    const assertion = expect(promise).rejects.toMatchObject({ status: 0, code: 'timeout' });

    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('gives every provisioning retry its own timeout window', async () => {
    const slow = DEFAULT_TIMEOUT_MS - 5_000; // 10s per attempt, 20s+ in total
    fetchMock
      .mockImplementationOnce(respondAfter(slow, 409, { error: 'user_not_provisioned' }))
      .mockImplementationOnce(respondAfter(slow, 200));

    const promise = apiFetch('/worker/profile', {}, 'tok');
    await vi.advanceTimersByTimeAsync(slow * 2 + PROVISIONING_RETRY_DELAYS_MS[0]);

    // A single shared 15s budget would have aborted the second attempt.
    await expect(promise).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with ApiError(0, "offline") when fetch rejects with a TypeError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const err = await apiFetch('/worker/profile', {}, 'tok').catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'offline', message: 'offline' });
    // The timeout timer must not outlive the attempt that armed it.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes non-TypeError, non-timeout rejections through untouched', async () => {
    const boom = new RangeError('exotic failure');
    fetchMock.mockRejectedValueOnce(boom);

    await expect(apiFetch('/worker/profile', {}, 'tok')).rejects.toBe(boom);
  });

  it('rethrows the abort when the caller aborts through their own signal', async () => {
    fetchMock.mockImplementation(neverResponds());
    const controller = new AbortController();

    const promise = apiFetch('/worker/profile', { signal: controller.signal }, 'tok');
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts immediately when the caller signal is already aborted', async () => {
    fetchMock.mockImplementation(neverResponds());

    const promise = apiFetch('/worker/profile', { signal: AbortSignal.abort() }, 'tok');
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });
});

describe('apiFetch 401 refresh-and-retry', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let refreshIdToken: ReturnType<typeof vi.fn>;
  let onSessionExpired: ReturnType<typeof vi.fn>;

  function installBridge(overrides?: Partial<AuthBridge>): AuthBridge {
    const bridge: AuthBridge = {
      refreshIdToken: refreshIdToken as unknown as AuthBridge['refreshIdToken'],
      onSessionExpired: onSessionExpired as unknown as AuthBridge['onSessionExpired'],
      ...overrides,
    };
    registerAuthBridge(bridge);
    return bridge;
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    refreshIdToken = vi.fn(async () => 'tok-2');
    onSessionExpired = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test');
    vi.useFakeTimers();
  });

  afterEach(() => {
    registerAuthBridge(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('refreshes once and replays the request with the new token', async () => {
    installBridge();
    fetchMock
      .mockResolvedValueOnce(mockResponse(401, { error: 'unauthorized' }))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    const res = await apiFetch('/worker/profile', {}, 'tok-1');

    expect(res.status).toBe(200);
    expect(refreshIdToken).toHaveBeenCalledTimes(1);
    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authHeaderOfCall(fetchMock, 0)).toBe('tok-1');
    expect(authHeaderOfCall(fetchMock, 1)).toBe('tok-2');
  });

  it('runs exactly one refresh for N concurrent 401s and replays each request exactly once', async () => {
    // The bridge owns single-flight (AuthContext dedupes via a ref), so the
    // contract under test is: apiFetch asks once per 401'd request, waits for
    // the shared answer, and replays that request a single time.
    let refreshRuns = 0;
    let inFlight: Promise<string | null> | null = null;
    let releaseRefresh!: (token: string) => void;
    const refreshGate = new Promise<string>((resolve) => { releaseRefresh = resolve; });

    const singleFlightRefresh = vi.fn((): Promise<string | null> => {
      if (inFlight) return inFlight;
      const run = (async (): Promise<string | null> => {
        refreshRuns++;
        return await refreshGate;
      })();
      inFlight = run;
      return run.finally(() => { inFlight = null; });
    });
    installBridge({ refreshIdToken: singleFlightRefresh });

    fetchMock.mockImplementation(async (_url: string, init: RequestInit & { headers: Record<string, string> }) =>
      init.headers.Authorization === 'tok-2'
        ? mockResponse(200, { ok: true })
        : mockResponse(401, { error: 'unauthorized' }),
    );

    const paths = ['/worker/profile', '/worker/jobs', '/worker/applications'];
    const promises = paths.map((path) => apiFetch(path, {}, 'tok-1'));

    // Let all three reach the 401 and queue behind the one in-flight refresh.
    await vi.advanceTimersByTimeAsync(0);
    expect(singleFlightRefresh).toHaveBeenCalledTimes(paths.length);
    expect(refreshRuns).toBe(1);

    releaseRefresh('tok-2');
    const results = await Promise.all(promises);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(refreshRuns).toBe(1);
    expect(onSessionExpired).not.toHaveBeenCalled();
    // Exactly one original + one replay per request -- never two replays.
    expect(fetchMock).toHaveBeenCalledTimes(paths.length * 2);
    const replayed = fetchMock.mock.calls.filter((_call, i) => authHeaderOfCall(fetchMock, i) === 'tok-2');
    expect(replayed).toHaveLength(paths.length);
  });

  it('gives up after a replay that also 401s: one refresh, one onSessionExpired, session_expired', async () => {
    installBridge();
    fetchMock.mockResolvedValue(mockResponse(401, { error: 'unauthorized' }));

    const err = await apiFetch('/worker/profile', {}, 'tok-1').catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'session_expired', message: 'session_expired' });
    expect(refreshIdToken).toHaveBeenCalledTimes(1);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('expires the session without replaying when the refresh resolves null', async () => {
    installBridge({ refreshIdToken: vi.fn(async () => null) });
    fetchMock.mockResolvedValue(mockResponse(401, { error: 'unauthorized' }));

    await expect(apiFetch('/worker/profile', {}, 'tok-1')).rejects.toMatchObject({
      status: 401,
      code: 'session_expired',
    });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('expires the session when the refresh itself throws', async () => {
    installBridge({ refreshIdToken: vi.fn(async () => { throw new Error('network down'); }) });
    fetchMock.mockResolvedValue(mockResponse(401, { error: 'unauthorized' }));

    await expect(apiFetch('/worker/profile', {}, 'tok-1')).rejects.toMatchObject({
      status: 401,
      code: 'session_expired',
    });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still throws session_expired when no bridge is registered', async () => {
    registerAuthBridge(null);
    fetchMock.mockResolvedValue(mockResponse(401, { error: 'unauthorized' }));

    await expect(apiFetch('/worker/profile', {}, 'tok-1')).rejects.toMatchObject({
      status: 401,
      code: 'session_expired',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never touches the bridge for a token-less request (e.g. /auth/refresh itself)', async () => {
    installBridge();
    fetchMock.mockResolvedValue(mockResponse(401, { error: 'invalid_refresh_token' }));

    const res = await apiFetch('/auth/refresh', { method: 'POST', body: '{}' });

    expect(res.status).toBe(401);
    expect(refreshIdToken).not.toHaveBeenCalled();
    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the raw 401 when retryOn401 is false', async () => {
    installBridge();
    fetchMock.mockResolvedValue(mockResponse(401, { error: 'unauthorized' }));

    const res = await apiFetch('/worker/profile', {}, 'tok-1', { retryOn401: false });

    expect(res.status).toBe(401);
    expect(refreshIdToken).not.toHaveBeenCalled();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('leaves non-401 failures alone', async () => {
    installBridge();
    fetchMock.mockResolvedValue(mockResponse(403, { error: 'employer_required' }));

    const res = await apiFetch('/employer/jobs', {}, 'tok-1');

    expect(res.status).toBe(403);
    expect(refreshIdToken).not.toHaveBeenCalled();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('still raises the legal wall when the replayed request hits it', async () => {
    installBridge();
    fetchMock
      .mockResolvedValueOnce(mockResponse(401, { error: 'unauthorized' }))
      .mockResolvedValueOnce(mockResponse(403, { error: 'legal_required' }));

    await expect(apiFetch('/worker/profile', {}, 'tok-1')).rejects.toThrow(LegalWallError);
    expect(refreshIdToken).toHaveBeenCalledTimes(1);
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('keeps retrying provisioning 409s on the replayed request', async () => {
    installBridge();
    fetchMock
      .mockResolvedValueOnce(mockResponse(401, { error: 'unauthorized' }))
      .mockResolvedValueOnce(mockResponse(409, { error: 'user_not_provisioned' }))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    const promise = apiFetch('/worker/profile', {}, 'tok-1');
    await vi.advanceTimersByTimeAsync(PROVISIONING_RETRY_DELAYS_MS[0]);

    await expect(promise).resolves.toMatchObject({ status: 200 });
    expect(refreshIdToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('apiFetch Accept-Language', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function acceptLanguageOfCall(index: number): string | undefined {
    return (fetchMock.mock.calls[index][1] as RequestInit & { headers: Record<string, string> })
      .headers['Accept-Language'];
  }

  beforeEach(() => {
    fetchMock = vi.fn(async () => mockResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the app locale from the URL prefix so the API can localise stored text', async () => {
    // The worker profile editor stores a canonical trade label in the
    // worker's language; the API reads Accept-Language when the body carries
    // no explicit lang. The browser's own header follows the OS language,
    // not the app locale the worker chose, so the app must say it.
    vi.stubGlobal('window', { location: { pathname: '/es/worker/profile' } });
    await apiFetch('/worker/profile', { method: 'PATCH', body: '{}' }, 'tok');
    expect(acceptLanguageOfCall(0)).toBe('es');
  });

  it('recognises the locale only as the first path segment', async () => {
    vi.stubGlobal('window', { location: { pathname: '/en' } });
    await apiFetch('/worker/profile', undefined, 'tok');
    expect(acceptLanguageOfCall(0)).toBe('en');

    vi.stubGlobal('window', { location: { pathname: '/legal/es/terms' } });
    await apiFetch('/worker/profile', undefined, 'tok');
    expect(acceptLanguageOfCall(1)).toBeUndefined();
  });

  it('sends nothing when there is no window (server-side) and never overrides a caller header', async () => {
    await apiFetch('/worker/profile', undefined, 'tok');
    expect(acceptLanguageOfCall(0)).toBeUndefined();

    vi.stubGlobal('window', { location: { pathname: '/es/worker/profile' } });
    await apiFetch('/worker/profile', { headers: { 'Accept-Language': 'en' } }, 'tok');
    expect(acceptLanguageOfCall(1)).toBe('en');
  });
});
