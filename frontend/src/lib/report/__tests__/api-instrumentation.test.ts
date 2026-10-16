// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, LegalWallError, PROVISIONING_RETRY_DELAYS_MS } from '../../api';
import { registerAuthBridge } from '../../auth-bridge';
import { clearReportBuffers, collectReportContext, type ReportContextV1 } from '../context';

const REQUEST_ID = '0000aaaa-1111-4222-8333-444455556666';

type Stub = { status: number; body?: unknown; headers?: Record<string, string>; afterMs?: number };

/** A Response-like stub, as the existing api tests use, plus headers. */
function stubResponse({ status, body = {}, headers = {} }: Stub): Response {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    clone() { return res; },
    json: async () => body,
  };
  return res as unknown as Response;
}

/** A fetch that answers each call in turn, after that answer's own delay. */
function answers(...stubs: Stub[]) {
  let call = 0;
  return vi.fn((_url: string, init: RequestInit) => {
    const stub = stubs[Math.min(call++, stubs.length - 1)];
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(stubResponse(stub)), stub.afterMs ?? 0);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
}

function context(): Required<ReportContextV1> {
  return collectReportContext({ includeTechnical: true, capture: { outcome: 'none', ms: 0 } }) as Required<ReportContextV1>;
}

/** Lets the fire-and-forget read of a failed response's code finish. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  clearReportBuffers();
  vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://app.example.test/api');
});

afterEach(() => {
  registerAuthBridge(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('apiFetch records every underlying request', () => {
  it('records each attempt of a 409 retry with its own status and duration', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', answers(
      { status: 409, body: { error: 'user_not_provisioned' }, afterMs: 100 },
      { status: 409, body: { error: 'user_not_provisioned' }, afterMs: 200 },
      { status: 200, afterMs: 50 },
    ));

    const pending = apiFetch('/worker/profile', {}, 'tok');
    await vi.advanceTimersByTimeAsync(100 + PROVISIONING_RETRY_DELAYS_MS[0] + 200 + PROVISIONING_RETRY_DELAYS_MS[1] + 50);
    expect((await pending).status).toBe(200);

    expect(context().requests).toEqual([
      { m: 'GET', p: '/worker/profile', s: 409, ms: 100 },
      { m: 'GET', p: '/worker/profile', s: 409, ms: 200 },
      { m: 'GET', p: '/worker/profile', s: 200, ms: 50 },
    ]);
    // It ended well, so it is not an error.
    expect(context().errors).toEqual([]);
  });

  it('records both requests of a 401 replay', async () => {
    registerAuthBridge({ refreshIdToken: async () => ({ status: 'ok' as const, token: 'tok-2' }), onSessionExpired: () => {} });
    vi.stubGlobal('fetch', answers({ status: 401, body: { error: 'unauthorized' } }, { status: 200 }));

    const res = await apiFetch('/worker/profile', { method: 'PATCH', body: '{}' }, 'tok-1');

    expect(res.status).toBe(200);
    expect(context().requests.map(({ m, p, s }) => ({ m, p, s }))).toEqual([
      { m: 'PATCH', p: '/worker/profile', s: 401 },
      { m: 'PATCH', p: '/worker/profile', s: 200 },
    ]);
    expect(context().errors).toEqual([]);
  });

  it('reads the request id from the x-amzn-requestid header', async () => {
    vi.stubGlobal('fetch', answers({ status: 200, headers: { 'x-amzn-RequestId': REQUEST_ID } }));
    await apiFetch('/worker/home', undefined, 'tok');
    expect(context().requests[0].rid).toBe(REQUEST_ID);
  });

  it('records the API path as a pattern, never the full URL or its query', async () => {
    const fetchMock = answers({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/worker/jobs?search=welder&job_type=full_time', undefined, 'tok');
    await apiFetch('/employer/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/applicants?stage=new', undefined, 'tok');
    expect(fetchMock.mock.calls[0][0]).toBe('https://app.example.test/api/worker/jobs?search=welder&job_type=full_time');
    expect(context().requests.map((r) => r.p)).toEqual(['/worker/jobs', '/employer/jobs/:id/applicants']);
  });
});

describe('apiFetch records API failures as errors', () => {
  it('records "<status> <code>" and never the payload', async () => {
    vi.stubGlobal('fetch', answers({
      status: 422,
      body: {
        error: 'invalid_input',
        message: 'someone@example.test is not valid',
        details: { phone: '555-010-0199', note: 'private words' },
      },
    }));

    const res = await apiFetch('/worker/profile', { method: 'PATCH', body: '{"phone":"555-010-0199"}' }, 'tok');
    await settle();

    // The caller still gets the untouched response, body included.
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_input' });

    const ctx = context();
    expect(ctx.requests).toEqual([{ m: 'PATCH', p: '/worker/profile', s: 422, ms: expect.any(Number) }]);
    expect(ctx.errors.map(({ k, msg }) => ({ k, msg }))).toEqual([{ k: 'api', msg: '422 invalid_input' }]);
    const sent = JSON.stringify(ctx);
    for (const leak of ['someone', 'example.test', '555', 'private words', 'details', 'phone']) {
      expect(sent).not.toContain(leak);
    }
  });

  it('keeps only a code-shaped error field', async () => {
    vi.stubGlobal('fetch', answers({ status: 500, body: { error: 'Something about 5550100199 happened' } }));
    await apiFetch('/worker/profile', undefined, 'tok');
    await settle();
    expect(context().errors.map((e) => e.msg)).toEqual(['500']);
  });

  it('records the status alone when the body is not JSON or cannot be cloned', async () => {
    const notJson = { ok: false, status: 502, headers: new Headers(), clone() { return notJson; }, json: async () => { throw new SyntaxError('bad json'); } };
    const noClone = { ok: false, status: 503 };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(notJson as unknown as Response)
      .mockResolvedValueOnce(noClone as unknown as Response));

    await expect(apiFetch('/worker/profile', undefined, 'tok')).resolves.toBe(notJson);
    await expect(apiFetch('/worker/profile', undefined, 'tok')).resolves.toBe(noClone);
    await settle();

    expect(context().errors.map((e) => e.msg).sort()).toEqual(['502', '503']);
  });

  it('records a request that never reached the server as status 0, and "0 offline"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(apiFetch('/worker/profile', undefined, 'tok')).rejects.toMatchObject({ status: 0, code: 'offline' });
    expect(context().requests).toEqual([{ m: 'GET', p: '/worker/profile', s: 0, ms: expect.any(Number) }]);
    expect(context().errors.map((e) => e.msg)).toEqual(['0 offline']);
  });

  it('records a timeout as status 0, and "0 timeout"', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', answers({ status: 200, afterMs: 60_000 }));
    const pending = apiFetch('/worker/profile', undefined, 'tok', { timeoutMs: 500 });
    const outcome = expect(pending).rejects.toMatchObject({ status: 0, code: 'timeout' });
    await vi.advanceTimersByTimeAsync(500);
    await outcome;
    expect(context().requests).toEqual([{ m: 'GET', p: '/worker/profile', s: 0, ms: 500 }]);
    expect(context().errors.map((e) => e.msg)).toEqual(['0 timeout']);
  });

  it('records an expired session as "401 session_expired"', async () => {
    registerAuthBridge({ refreshIdToken: async () => ({ status: 'refused' as const }), onSessionExpired: () => {} });
    vi.stubGlobal('fetch', answers({ status: 401, body: { error: 'unauthorized' } }));
    await expect(apiFetch('/worker/profile', undefined, 'tok')).rejects.toMatchObject({ code: 'session_expired' });
    expect(context().errors.map((e) => e.msg)).toEqual(['401 session_expired']);
  });

  it('records a refresh outage as "503 session_refresh_unavailable"', async () => {
    registerAuthBridge({ refreshIdToken: async () => ({ status: 'unavailable' as const }), onSessionExpired: () => {} });
    vi.stubGlobal('fetch', answers({ status: 401, body: { error: 'unauthorized' } }));
    await expect(apiFetch('/worker/profile', undefined, 'tok')).rejects.toMatchObject({ code: 'session_refresh_unavailable' });
    expect(context().errors.map((e) => e.msg)).toEqual(['503 session_refresh_unavailable']);
  });

  it('records the legal wall as "403 legal_required"', async () => {
    vi.stubGlobal('fetch', answers({ status: 403, body: { error: 'legal_required' } }));
    await expect(apiFetch('/worker/profile', undefined, 'tok')).rejects.toBeInstanceOf(LegalWallError);
    expect(context().errors.map((e) => e.msg)).toEqual(['403 legal_required']);
  });

  it('does not count a deliberate abort as a failure', async () => {
    vi.stubGlobal('fetch', answers({ status: 200, afterMs: 60_000 }));
    const controller = new AbortController();
    const pending = apiFetch('/worker/jobs', { signal: controller.signal }, 'tok');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(context().requests.map((r) => r.s)).toEqual([0]);
    expect(context().errors).toEqual([]);
  });
});
