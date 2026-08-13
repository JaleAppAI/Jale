import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyIntent,
  getPublicJob,
  getPublicJobsList,
  getReferrerContext,
  isClosedJob,
  PublicJobNotFoundError,
  sendOpenBeacon,
} from '../publicJob';
import type { PublicJobActive, PublicJobClosed, PublicJobListItem } from '../publicJob';

// No jsdom/testing-library in this repo (vitest.config.ts runs the 'node'
// environment only) -- these are pure fetch-logic tests, not component
// tests. See the ShareJobPanel/public-job-page notes in the PR description
// for what a real component-test suite would additionally need to cover.

const ACTIVE_JOB: PublicJobActive = {
  code: 'ABC123',
  title: 'Warehouse Associate',
  company: 'Acme Co',
  location: 'Austin, TX',
  job_type: 'full-time',
  description: 'Lift boxes',
  required_docs: [],
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
};

const CLOSED_JOB: PublicJobClosed = {
  code: 'ABC123',
  title: 'Warehouse Associate',
  company: 'Acme Co',
  location: 'Austin, TX',
  status: 'closed',
  applications_closed: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('getPublicJob', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the job by code with no ?r querystring and no side-effect option', async () => {
    fetchMock.mockResolvedValue(jsonResponse(ACTIVE_JOB));
    const job = await getPublicJob('ABC123');
    expect(job).toEqual(ACTIVE_JOB);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/public/jobs/ABC123',
      expect.objectContaining({ next: { revalidate: 60 } }),
    );
  });

  it('throws PublicJobNotFoundError on 404', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'not_found' }, 404));
    await expect(getPublicJob('ZZZZZZ')).rejects.toBeInstanceOf(PublicJobNotFoundError);
  });

  it('throws a generic error on other non-ok statuses', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'internal_error' }, 500));
    await expect(getPublicJob('ABC123')).rejects.toThrow('public_job_fetch_failed');
  });

  it('returns the closed-job projection as-is', async () => {
    fetchMock.mockResolvedValue(jsonResponse(CLOSED_JOB));
    const job = await getPublicJob('ABC123');
    expect(isClosedJob(job)).toBe(true);
  });
});

describe('isClosedJob', () => {
  it('is true only for the closed-job shape', () => {
    expect(isClosedJob(CLOSED_JOB)).toBe(true);
    expect(isClosedJob(ACTIVE_JOB)).toBe(false);
  });
});

describe('getReferrerContext', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the referrer endpoint with ?r= and returns kind/first_name on 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ kind: 'worker', first_name: 'Maria' }));
    const ctx = await getReferrerContext('ABC123', 'SHARE001');
    expect(ctx).toEqual({ kind: 'worker', first_name: 'Maria' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/public/jobs/ABC123/referrer?r=SHARE001',
    );
  });

  it('normalizes a missing first_name to null', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ kind: 'employer' }));
    const ctx = await getReferrerContext('ABC123', 'SHARE001');
    expect(ctx).toEqual({ kind: 'employer', first_name: null });
  });

  it('resolves to null on 404', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'not_found' }, 404));
    await expect(getReferrerContext('ABC123', 'BAD')).resolves.toBeNull();
  });

  it('resolves to null on an unrecognized kind', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ kind: 'admin', first_name: 'X' }));
    await expect(getReferrerContext('ABC123', 'SHARE001')).resolves.toBeNull();
  });

  it('resolves to null (never throws) on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(getReferrerContext('ABC123', 'SHARE001')).resolves.toBeNull();
  });

  it('resolves to null (never throws) on a JSON parse failure', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    } as unknown as Response);
    await expect(getReferrerContext('ABC123', 'SHARE001')).resolves.toBeNull();
  });
});

describe('sendOpenBeacon', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  it('POSTs to the open endpoint with {r: shareCode} when a share code is present', () => {
    const send = vi.fn();
    sendOpenBeacon('ABC123', 'SHARE001', send);
    expect(send).toHaveBeenCalledWith(
      'https://api.example.test/public/jobs/ABC123/open',
      JSON.stringify({ r: 'SHARE001' }),
    );
  });

  it('omits r from the body when shareCode is null', () => {
    const send = vi.fn();
    sendOpenBeacon('ABC123', null, send);
    expect(send).toHaveBeenCalledWith(
      'https://api.example.test/public/jobs/ABC123/open',
      JSON.stringify({}),
    );
  });

  it('never throws, even when the injected sender throws synchronously', () => {
    const send = vi.fn(() => {
      throw new Error('boom');
    });
    expect(() => sendOpenBeacon('ABC123', null, send)).not.toThrow();
  });

  it('uses navigator.sendBeacon by default when available', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });
    sendOpenBeacon('ABC123', 'SHARE001');
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe('https://api.example.test/public/jobs/ABC123/open');
    expect(blob).toBeInstanceOf(Blob);
    vi.unstubAllGlobals();
  });

  it('falls back to keepalive fetch when navigator.sendBeacon is unavailable', () => {
    vi.stubGlobal('navigator', {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    sendOpenBeacon('ABC123', null);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/public/jobs/ABC123/open',
      expect.objectContaining({ method: 'POST', keepalive: true, body: JSON.stringify({}) }),
    );
    vi.unstubAllGlobals();
  });
});

describe('applyIntent', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to the apply-intent endpoint and forwards the share code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token: 'JALE-ABCD1234', whatsappUrl: 'https://wa.me/1?text=x' }));
    const result = await applyIntent('ABC123', 'SHARE001');
    expect(result.whatsappUrl).toBe('https://wa.me/1?text=x');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/public/jobs/ABC123/apply-intent?r=SHARE001',
      expect.objectContaining({ method: 'POST', cache: 'no-store' }),
    );
  });

  it('throws on a non-ok response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'job_not_active' }, 409));
    await expect(applyIntent('ABC123')).rejects.toThrow('apply_intent_failed');
  });
});

describe('getPublicJobsList', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const item = (code: string): PublicJobListItem => ({
    code,
    title: `Job ${code}`,
    city: 'Austin',
    state_region: 'TX',
    trade_category: 'electrician',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty array immediately when NEXT_PUBLIC_API_BASE_URL is unset', async () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    const jobs = await getPublicJobsList();
    expect(jobs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches a single page when next_cursor is null', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [item('A'), item('B')], next_cursor: null }));
    const jobs = await getPublicJobsList();
    expect(jobs.map((j) => j.code)).toEqual(['A', 'B']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/public/jobs?limit=500',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('follows next_cursor across pages until it goes null', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobs: [item('A')], next_cursor: 'page2' }))
      .mockResolvedValueOnce(jsonResponse({ jobs: [item('B')], next_cursor: null }));
    const jobs = await getPublicJobsList();
    expect(jobs.map((j) => j.code)).toEqual(['A', 'B']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.example.test/public/jobs?limit=500&cursor=page2',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('tolerates a fetch rejection and returns whatever was already accumulated', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobs: [item('A')], next_cursor: 'page2' }))
      .mockRejectedValueOnce(new Error('network down'));
    const jobs = await getPublicJobsList();
    expect(jobs.map((j) => j.code)).toEqual(['A']);
  });

  it('tolerates a non-ok response by stopping and returning what it has', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobs: [item('A')], next_cursor: 'page2' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'internal_error' }, 500));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const jobs = await getPublicJobsList();
    expect(jobs.map((j) => j.code)).toEqual(['A']);
    // Truncation is observable, not silent.
    expect(errorSpy).toHaveBeenCalledWith(JSON.stringify({ metric: 'PublicJobsListTruncated', status: 500 }));
  });

  it('never throws, even on a completely broken first call', async () => {
    fetchMock.mockRejectedValue(new Error('dns failure'));
    await expect(getPublicJobsList()).resolves.toEqual([]);
  });

  it('retries a 429 in place (same page) up to 2 times with a delay, then succeeds on the 3rd attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429))
      .mockResolvedValueOnce(jsonResponse({ jobs: [item('A')], next_cursor: null }));
    const delayFn = vi.fn().mockResolvedValue(undefined);

    const jobs = await getPublicJobsList(delayFn);

    expect(jobs.map((j) => j.code)).toEqual(['A']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delayFn).toHaveBeenCalledTimes(2);
    expect(delayFn).toHaveBeenCalledWith(500);
    // Every retry hit the exact same page (no cursor advanced between them).
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('https://api.example.test/public/jobs?limit=500');
    }
  });

  it('gives up after MAX_PAGE_RETRIES consecutive 429s and logs the truncation with status 429', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'rate_limited' }, 429));
    const delayFn = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const jobs = await getPublicJobsList(delayFn);

    expect(jobs).toEqual([]);
    // Initial attempt + 2 retries = 3 fetches total, 2 delays.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delayFn).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(JSON.stringify({ metric: 'PublicJobsListTruncated', status: 429 }));
  });

  it('a 429 retry that recovers on a later page does not log truncation at all', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429))
      .mockResolvedValueOnce(jsonResponse({ jobs: [item('A')], next_cursor: null }));
    const delayFn = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const jobs = await getPublicJobsList(delayFn);

    expect(jobs.map((j) => j.code)).toEqual(['A']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  describe('maxItems option (used by the RSS feed, never by the sitemap)', () => {
    it('requests a page limit capped to maxItems instead of the default 500', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ jobs: [item('A'), item('B')], next_cursor: null }));
      await getPublicJobsList(undefined, { maxItems: 50 });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.test/public/jobs?limit=50',
        expect.objectContaining({ cache: 'no-store' }),
      );
    });

    it('stops paginating and trims to maxItems once enough items have accumulated', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ jobs: [item('A'), item('B'), item('C')], next_cursor: 'page2' }));
      const jobs = await getPublicJobsList(undefined, { maxItems: 2 });
      expect(jobs.map((j) => j.code)).toEqual(['A', 'B']);
      // A second page must never be fetched: the first page already had enough.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still follows next_cursor across pages when the first page has fewer than maxItems', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ jobs: [item('A')], next_cursor: 'page2' }))
        .mockResolvedValueOnce(jsonResponse({ jobs: [item('B'), item('C')], next_cursor: 'page3' }));
      const jobs = await getPublicJobsList(undefined, { maxItems: 3 });
      expect(jobs.map((j) => j.code)).toEqual(['A', 'B', 'C']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns fewer than maxItems when the list itself has fewer active jobs, without hanging', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ jobs: [item('A')], next_cursor: null }));
      const jobs = await getPublicJobsList(undefined, { maxItems: 50 });
      expect(jobs.map((j) => j.code)).toEqual(['A']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('leaves the default (sitemap) call path completely unaffected', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ jobs: [item('A'), item('B')], next_cursor: null }));
      const jobs = await getPublicJobsList();
      expect(jobs.map((j) => j.code)).toEqual(['A', 'B']);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.test/public/jobs?limit=500',
        expect.objectContaining({ cache: 'no-store' }),
      );
    });
  });
});
