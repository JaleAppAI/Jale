import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, LegalWallError, PROVISIONING_RETRY_DELAYS_MS } from '../api';

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

describe('apiFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test');
    vi.useFakeTimers();
  });

  afterEach(() => {
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
