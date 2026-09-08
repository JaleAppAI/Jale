import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeHire } from '../worker';
import { ApiError } from '../errors';

/**
 * `POST /worker/applications/{id}/hire-ack` -- the two-step receipt behind the
 * hire celebration. `seen` is written when the modal closes, `dismissed` when
 * the banner's × is pressed, and the server (not the browser) is what
 * remembers both, so this call is the ONLY thing standing between a worker and
 * a modal that greets them on every visit forever.
 *
 * Covered here rather than only through the pages because the pages fire it
 * FIRE-AND-FORGET: nothing on screen changes if the URL, the method or the
 * body is wrong, so a mistake in any of the three would be invisible to a
 * render test and permanent in production.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const APPLICATION_ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'id-token-abc';

describe('acknowledgeHire', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['seen', 'dismissed'] as const)('posts step=%s to this application\'s hire-ack', async (step) => {
    fetchMock.mockResolvedValue(jsonResponse({
      seen_at: '2026-09-04T12:00:00.000Z',
      acknowledged_at: step === 'dismissed' ? '2026-09-04T12:05:00.000Z' : null,
    }));

    const result = await acknowledgeHire(TOKEN, APPLICATION_ID, step);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.example.test/worker/applications/${APPLICATION_ID}/hire-ack`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(TOKEN);
    expect(JSON.parse(init.body)).toEqual({ step });
    expect(result.seen_at).toBe('2026-09-04T12:00:00.000Z');
    expect(result.acknowledged_at).toBe(step === 'dismissed' ? '2026-09-04T12:05:00.000Z' : null);
  });

  it('carries no AbortSignal -- a receipt the server already took must be reported, not discarded', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ seen_at: null, acknowledged_at: null }));
    await acknowledgeHire(TOKEN, APPLICATION_ID, 'seen');
    // `apiFetch` always attaches its own timeout controller, so the assertion
    // is about the OPTIONS the helper hands it, not the final request.
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(JSON.stringify({ step: 'seen' }));
  });

  it('maps a 404 to not_found', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'not_found' }, 404));
    const err = await acknowledgeHire(TOKEN, APPLICATION_ID, 'seen').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
    // `message === code` is the app-wide invariant pages branch on.
    expect(err.message).toBe('not_found');
  });

  it('maps a 400 to invalid_step', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_step' }, 400));
    const err = await acknowledgeHire(TOKEN, APPLICATION_ID, 'seen').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_step');
  });

  it('falls back to a code of its own when the body names none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const err = await acknowledgeHire(TOKEN, APPLICATION_ID, 'dismissed').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.code).toBe('hire_ack_failed');
  });
});
