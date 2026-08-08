import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shareJob } from '../worker';
import { ApiError } from '../errors';
import type { ShareChannel } from '../worker';

// No jsdom/testing-library in this repo (vitest.config.ts runs the 'node'
// environment only), so ShareJobPanel itself (a client component that reads
// navigator.share / navigator.clipboard / window.location) is not covered by
// an automated render test here. This file covers the one thing that is
// pure logic and the most safety-critical to get right: that each channel
// button calls the share endpoint with ITS OWN channel, on its own request --
// never a shared/reused call.

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('shareJob', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const channels: ShareChannel[] = ['whatsapp', 'sms', 'facebook', 'copy_link', 'device_share'];

  it.each(channels)('calls the share endpoint with channel=%s and an auth header', async (channel) => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: 'SHARE001', channel, share_url: `https://jaleapp.ai/j/ABC123?r=SHARE001` }),
    );

    const result = await shareJob('id-token-abc', 'job-1', channel);

    expect(result.channel).toBe(channel);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/worker/jobs/job-1/share');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('id-token-abc');
    expect(JSON.parse(init.body)).toEqual({ channel });
  });

  it('a separate call for a second channel does not reuse the first channel share_url', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 'CODEWA01', channel: 'whatsapp', share_url: 'https://jaleapp.ai/j/ABC123?r=CODEWA01' }))
      .mockResolvedValueOnce(jsonResponse({ code: 'CODESMS1', channel: 'sms', share_url: 'https://jaleapp.ai/j/ABC123?r=CODESMS1' }));

    const wa = await shareJob('id-token-abc', 'job-1', 'whatsapp');
    const sms = await shareJob('id-token-abc', 'job-1', 'sms');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wa.share_url).not.toBe(sms.share_url);
  });

  it('surfaces share_url_misconfigured as a distinguishable error code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'share_url_misconfigured' }, 500));
    const err = await shareJob('id-token-abc', 'job-1', 'whatsapp').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    // ShareJobPanel reads `.code`; other call sites read `.message`. Both are
    // the backend's code -- that equality is the compatibility invariant.
    expect(err).toMatchObject({
      code: 'share_url_misconfigured',
      status: 500,
      message: 'share_url_misconfigured',
    });
  });

  it('falls back to the share_failed code when the body carries none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 502));
    const err = await shareJob('id-token-abc', 'job-1', 'whatsapp').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'share_failed', status: 502, message: 'share_failed' });
  });
});
