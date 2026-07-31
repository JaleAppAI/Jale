import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyIntent, getPublicJob, isClosedJob, PublicJobNotFoundError } from '../publicJob';
import type { PublicJobActive, PublicJobClosed } from '../publicJob';

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

  it('fetches the job by code with no ?r when shareCode is absent', async () => {
    fetchMock.mockResolvedValue(jsonResponse(ACTIVE_JOB));
    const job = await getPublicJob('ABC123');
    expect(job).toEqual(ACTIVE_JOB);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/public/jobs/ABC123',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('passes a present ?r through untouched (aside from URI-encoding)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(ACTIVE_JOB));
    await getPublicJob('ABC123', 'SHARE001');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/public/jobs/ABC123?r=SHARE001',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('renders normally (no throw) on a malformed/garbage share code -- the API is responsible for ignoring it', async () => {
    fetchMock.mockResolvedValue(jsonResponse(ACTIVE_JOB));
    await expect(getPublicJob('ABC123', 'not-a-real-code!!')).resolves.toEqual(ACTIVE_JOB);
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
