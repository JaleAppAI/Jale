// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILD_ID,
  clearReportBuffers,
  collectReportContext,
  fitContextToBudget,
  installErrorCapture,
  MAX_CONTEXT_BYTES,
  recordError,
  recordFetch,
  recordRequest,
  recordScreen,
  routePattern,
  type CaptureSummary,
  type ReportContextV1,
} from '../context';

const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_ID = '0000aaaa-1111-4222-8333-444455556666';
const CAPTURE: CaptureSummary = { outcome: 'ok', ms: 820 };

function full(): Required<ReportContextV1> {
  return collectReportContext({ includeTechnical: true, capture: CAPTURE }) as Required<ReportContextV1>;
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

beforeEach(() => {
  clearReportBuffers();
  window.history.replaceState(null, '', '/es/worker/home');
  document.documentElement.lang = 'es';
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the request buffer', () => {
  it('keeps the last 20 requests, oldest first', () => {
    for (let i = 0; i < 25; i++) {
      recordRequest({ method: 'get', url: `/worker/jobs?page=${i}`, status: 200 + i, ms: i });
    }
    const { requests } = full();
    expect(requests).toHaveLength(20);
    expect(requests.map((r) => r.s)).toEqual(Array.from({ length: 20 }, (_, i) => 205 + i));
    expect(requests[0]).toEqual({ m: 'GET', p: '/worker/jobs', s: 205, ms: 5 });
  });

  it('keeps a well-formed request id, and drops anything else in that field', () => {
    recordRequest({ method: 'POST', url: `/worker/jobs/${JOB_ID}/apply`, status: 500, ms: 2100.4, requestId: REQUEST_ID });
    recordRequest({ method: 'GET', url: '/worker/home', status: 200, ms: -3, requestId: 'not a request id <x>' });
    const { requests } = full();
    expect(requests[0]).toEqual({ m: 'POST', p: '/worker/jobs/:id/apply', s: 500, ms: 2100, rid: REQUEST_ID });
    expect(requests[1]).toEqual({ m: 'GET', p: '/worker/home', s: 200, ms: 0 });
  });

  it('truncates an over-long field rather than dropping the request (caps truncate, never reject)', () => {
    const longId = 'a1-'.repeat(30);
    recordRequest({ method: 'propfindextended', url: `/${'segment/'.repeat(40)}`, status: 200, ms: 1, requestId: longId });
    const [entry] = full().requests;
    expect(entry.m).toBe('PROPFINDEX');
    expect(entry.p).toHaveLength(200);
    expect(entry.p.startsWith('/segment/segment/')).toBe(true);
    expect(entry.rid).toBe(longId.slice(0, 64));
  });

  it('records the literal s3:upload pattern verbatim', () => {
    recordRequest({ method: 'PUT', url: 's3:upload', status: 200, ms: 640 });
    expect(full().requests).toEqual([{ m: 'PUT', p: 's3:upload', s: 200, ms: 640 }]);
  });

  it('normalises an absolute API URL to the route form', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://app.example.test/api');
    recordRequest({ method: 'POST', url: 'https://app.example.test/api/public/reports/create', status: 201, ms: 300 });
    recordRequest({ method: 'POST', url: '/public/reports/create', status: 201, ms: 280 });
    expect(full().requests.map((r) => r.p)).toEqual(['/public/reports/create', '/public/reports/create']);
  });
});

describe('the error buffer', () => {
  it('keeps the last 10 errors, oldest first, scrubbed and timestamped', () => {
    for (let i = 0; i < 12; i++) recordError({ kind: 'error', message: `failure ${i}` });
    const { errors } = full();
    expect(errors).toHaveLength(10);
    expect(errors.map((e) => e.msg)).toEqual(Array.from({ length: 10 }, (_, i) => `failure ${i + 2}`));
    expect(errors[0].k).toBe('error');
    expect(Number.isNaN(Date.parse(errors[0].at))).toBe(false);
  });

  it('scrubs phones, emails and URLs, and shortens to 200 characters', () => {
    recordError({ kind: 'api', message: `call 555-010-0199 or someone@example.test via https://example.test/x ${'z'.repeat(300)}` });
    const [entry] = full().errors;
    expect(entry.msg).toMatch(/^call \[phone\] or \[email\] via \[url\] z+…$/);
    expect(entry.msg).toHaveLength(200);
  });
});

describe('the screen buffer', () => {
  it('keeps the last 5 screens as patterns, with the current screen and its refs', () => {
    const visits = ['/worker/home', '/worker/jobs', `/worker/jobs/${JOB_ID}`, '/worker/applications', '/worker/profile', `/worker/jobs/${JOB_ID}`];
    for (const path of visits) recordScreen(path, path.includes(JOB_ID) ? { id: JOB_ID } : {});
    const ctx = full();
    expect(ctx.screens).toEqual(['/worker/jobs', '/worker/jobs/:id', '/worker/applications', '/worker/profile', '/worker/jobs/:id']);
    expect(ctx.screen).toEqual({ pattern: '/worker/jobs/:id', refs: { id: JOB_ID } });
  });

  it('takes the locale-stripped pathname and the params without locale', () => {
    recordScreen(`/employer/jobs/${JOB_ID}`, { id: JOB_ID });
    expect(full().screen).toEqual({ pattern: '/employer/jobs/:id', refs: { id: JOB_ID } });
    expect(routePattern(`/employer/jobs/${JOB_ID}`, { id: JOB_ID }).pattern).toBe('/employer/jobs/:id');
  });

  it('does not repeat a screen recorded twice in a row', () => {
    recordScreen('/worker/home', {});
    recordScreen('/worker/home', {});
    expect(full().screens).toEqual(['/worker/home']);
  });
});

describe('clearReportBuffers', () => {
  it('empties all three buffers and forgets the current screen', () => {
    recordRequest({ method: 'GET', url: '/worker/home', status: 200, ms: 5 });
    recordError({ kind: 'error', message: 'boom' });
    recordScreen(`/worker/jobs/${JOB_ID}`, { id: JOB_ID });
    clearReportBuffers();
    const ctx = full();
    expect(ctx.requests).toEqual([]);
    expect(ctx.errors).toEqual([]);
    expect(ctx.screens).toEqual([]);
    // Back to the address bar, with no refs carried over.
    expect(ctx.screen).toEqual({ pattern: '/worker/home', refs: {} });
  });
});

describe('nothing is persisted', () => {
  it('never touches localStorage, sessionStorage or cookies', async () => {
    const spies = [
      vi.spyOn(Storage.prototype, 'getItem'),
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
      vi.spyOn(Storage.prototype, 'clear'),
      vi.spyOn(Storage.prototype, 'key'),
    ];
    const cookieSet = vi.spyOn(document, 'cookie', 'set');

    const uninstall = installErrorCapture();
    recordRequest({ method: 'GET', url: '/worker/home', status: 200, ms: 5 });
    await recordFetch({ method: 'GET', url: '/worker/home' }, async () => new Response(null, { status: 204 }));
    recordError({ kind: 'error', message: 'boom' });
    recordScreen('/worker/home', {});
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: boom' }));
    collectReportContext({ includeTechnical: true, capture: CAPTURE });
    collectReportContext({ includeTechnical: false, capture: CAPTURE });
    clearReportBuffers();
    uninstall();

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it('records nothing where there is no window (the server)', () => {
    vi.stubGlobal('window', undefined);
    recordRequest({ method: 'GET', url: '/public/jobs', status: 200, ms: 5 });
    recordError({ kind: 'error', message: 'boom' });
    recordScreen('/worker/home', {});
    vi.unstubAllGlobals();
    const ctx = full();
    expect(ctx.requests).toEqual([]);
    expect(ctx.errors).toEqual([]);
    expect(ctx.screens).toEqual([]);
  });
});

describe('recordFetch', () => {
  it('records the status, the duration and the request id of the response', async () => {
    vi.useFakeTimers();
    try {
      const pending = recordFetch({ method: 'POST', url: '/worker/documents/confirm' }, () => new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response('{}', { status: 201, headers: { 'x-amzn-RequestId': REQUEST_ID } })), 250);
      }));
      await vi.advanceTimersByTimeAsync(250);
      const res = await pending;
      expect(res.status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
    expect(full().requests).toEqual([{ m: 'POST', p: '/worker/documents/confirm', s: 201, ms: 250, rid: REQUEST_ID }]);
  });

  it('records status 0 when the request never got a response, and rethrows the same error', async () => {
    const failure = new TypeError('Failed to fetch');
    await expect(recordFetch({ method: 'PUT', url: 's3:upload' }, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(full().requests).toEqual([{ m: 'PUT', p: 's3:upload', s: 0, ms: expect.any(Number) }]);
  });

  it('copes with a response that has no headers', async () => {
    const bare = { ok: true, status: 200 } as Response;
    await expect(recordFetch({ method: 'GET', url: '/worker/home' }, async () => bare)).resolves.toBe(bare);
    expect(full().requests).toEqual([{ m: 'GET', p: '/worker/home', s: 200, ms: expect.any(Number) }]);
  });
});

describe('installErrorCapture', () => {
  it('records uncaught errors and unhandled rejections until it is uninstalled', () => {
    const uninstall = installErrorCapture();
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught TypeError: x is undefined for 555-010-0199' }));
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new RangeError('bad range for someone@example.test') });
    window.dispatchEvent(rejection);
    uninstall();
    window.dispatchEvent(new ErrorEvent('error', { message: 'after uninstall' }));

    expect(full().errors.map(({ k, msg }) => ({ k, msg }))).toEqual([
      { k: 'error', msg: 'Uncaught TypeError: x is undefined for [phone]' },
      { k: 'rejection', msg: 'RangeError: bad range for [email]' },
    ]);
  });

  it('never stringifies a rejection reason that is not an Error', () => {
    const uninstall = installErrorCapture();
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: { payload: { secret: 'do-not-send' } } });
    window.dispatchEvent(rejection);
    uninstall();
    const [entry] = full().errors;
    expect(entry.k).toBe('rejection');
    expect(entry.msg).not.toContain('do-not-send');
    expect(entry.msg).not.toContain('payload');
  });

  it('installs its listeners once however many times it is called, and keeps them until the last uninstall', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const first = installErrorCapture();
    const second = installErrorCapture();
    expect(add.mock.calls.filter(([type]) => type === 'error')).toHaveLength(1);
    first();
    first();
    window.dispatchEvent(new ErrorEvent('error', { message: 'still listening' }));
    second();
    window.dispatchEvent(new ErrorEvent('error', { message: 'not listening' }));
    expect(full().errors.map((e) => e.msg)).toEqual(['still listening']);
  });
});

describe('collectReportContext', () => {
  beforeEach(() => {
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    recordScreen('/worker/home', {});
    recordScreen(`/worker/jobs/${JOB_ID}`, { id: JOB_ID });
    recordRequest({ method: 'POST', url: `/worker/jobs/${JOB_ID}/apply`, status: 500, ms: 2100, requestId: REQUEST_ID });
    recordError({ kind: 'api', message: '500 internal_error' });
  });

  it('returns schema v1 with everything when technical details are included', () => {
    document.documentElement.classList.add('dark');
    const ctx = full();
    expect(Object.keys(ctx).sort()).toEqual(['app', 'capture', 'device', 'errors', 'requests', 'screen', 'screens', 'v']);
    expect(ctx.v).toBe(1);
    expect(ctx.screen).toEqual({ pattern: '/worker/jobs/:id', refs: { id: JOB_ID } });
    expect(ctx.screens).toEqual(['/worker/home', '/worker/jobs/:id']);
    expect(ctx.app).toEqual({ build: BUILD_ID, locale: 'es', theme: 'dark' });
    expect(ctx.requests).toEqual([{ m: 'POST', p: '/worker/jobs/:id/apply', s: 500, ms: 2100, rid: REQUEST_ID }]);
    expect(ctx.errors.map((e) => e.msg)).toEqual(['500 internal_error']);
    expect(ctx.capture).toEqual(CAPTURE);
    expect(ctx.device).toEqual({
      kind: 'phone',
      browser: expect.any(String),
      os: expect.any(String),
      viewport: [390, 844],
      online: true,
      tz: expect.any(String),
      local_time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/),
    });
  });

  it('returns only the screen pattern, the build and the locale without technical details', () => {
    const ctx = collectReportContext({ includeTechnical: false, capture: CAPTURE });
    expect(ctx).toEqual({ v: 1, screen: { pattern: '/worker/jobs/:id' }, app: { build: BUILD_ID, locale: 'es' } });
  });

  it('reads the theme from the dark class and the locale from the address', () => {
    window.history.replaceState(null, '', '/en/worker/home');
    expect(full().app).toEqual({ build: BUILD_ID, locale: 'en', theme: 'light' });
  });

  it('hands out copies, so a sent context cannot change the buffers', () => {
    const ctx = full();
    ctx.requests.length = 0;
    ctx.screen.refs!.id = 'changed';
    const again = full();
    expect(again.requests).toHaveLength(1);
    expect(again.screen.refs).toEqual({ id: JOB_ID });
  });

  it('stays within 32 KB with every buffer full', () => {
    for (let i = 0; i < 30; i++) {
      recordRequest({ method: 'GET', url: `/${'word/'.repeat(60)}${i}`, status: 503, ms: 15000, requestId: REQUEST_ID });
      recordError({ kind: 'error', message: 'e'.repeat(1000) });
      recordScreen(`/${'deep/'.repeat(60)}${'x'.repeat(i + 1)}`, {});
    }
    expect(bytes(full())).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
    expect(MAX_CONTEXT_BYTES).toBe(32 * 1024);
  });
});

describe('fitContextToBudget', () => {
  function bigContext(): Required<ReportContextV1> {
    for (let i = 0; i < 20; i++) {
      recordRequest({ method: 'GET', url: `/worker/jobs?page=${i}`, status: 200, ms: i, requestId: REQUEST_ID });
    }
    for (let i = 0; i < 10; i++) recordError({ kind: 'error', message: `error number ${i} ${'e'.repeat(150)}` });
    return full();
  }

  it('drops the oldest requests and errors first, until the context fits', () => {
    const ctx = bigContext();
    const budget = bytes(ctx) - 1500;
    const fitted = fitContextToBudget(ctx, budget) as Required<ReportContextV1>;
    expect(bytes(fitted)).toBeLessThanOrEqual(budget);
    // The newest entries survive; only the oldest go.
    expect(fitted.requests.at(-1)).toEqual(ctx.requests.at(-1));
    expect(fitted.errors.at(-1)).toEqual(ctx.errors.at(-1));
    expect(fitted.requests).toEqual(ctx.requests.slice(ctx.requests.length - fitted.requests.length));
    expect(fitted.errors).toEqual(ctx.errors.slice(ctx.errors.length - fitted.errors.length));
    expect(fitted.requests.length + fitted.errors.length).toBeLessThan(30);
    // Everything else is untouched.
    expect(fitted.screen).toEqual(ctx.screen);
    expect(fitted.device).toEqual(ctx.device);
    expect(fitted.capture).toEqual(ctx.capture);
  });

  it('leaves a context that already fits alone', () => {
    const ctx = bigContext();
    expect(fitContextToBudget(ctx, MAX_CONTEXT_BYTES)).toEqual(ctx);
  });
});
