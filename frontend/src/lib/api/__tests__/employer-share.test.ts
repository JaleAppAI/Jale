import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, shareEmployerJob } from '../employer';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('shareEmployerJob', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to the share endpoint with the copy_link channel and an auth header', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'SHARE001', share_url: 'https://jaleapp.ai/j/ABC123?r=SHARE001' }),
    );

    const result = await shareEmployerJob('id-token-abc', 'job-1');

    expect(result.share_url).toBe('https://jaleapp.ai/j/ABC123?r=SHARE001');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/employer/jobs/job-1/share');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('id-token-abc');
    expect(JSON.parse(init.body)).toEqual({ channel: 'copy_link' });
  });

  it('surfaces job_not_found as a typed ApiError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'job_not_found' }, 404));
    const err = await shareEmployerJob('id-token-abc', 'job-1').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'job_not_found', status: 404, message: 'job_not_found' });
  });

  it('surfaces share_url_misconfigured as a typed ApiError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'share_url_misconfigured' }, 500));
    const err = await shareEmployerJob('id-token-abc', 'job-1').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'share_url_misconfigured',
      status: 500,
      message: 'share_url_misconfigured',
    });
  });

  it('falls back to the share_failed code when the body carries none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const err = await shareEmployerJob('id-token-abc', 'job-1').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'share_failed', status: 500 });
  });
});
