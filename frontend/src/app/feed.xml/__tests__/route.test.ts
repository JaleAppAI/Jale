import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../route';
import type { PublicJobListItem } from '@/lib/api/publicJob';

// Exercises the real GET handler end to end -- `getPublicJobsList`,
// `escapeXml`/`toRfc822` and the XML assembly are all real; only the
// underlying `fetch` to the public jobs API is mocked, same approach as
// `lib/api/__tests__/publicJob.test.ts`.

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const item = (code: string, overrides: Partial<PublicJobListItem> = {}): PublicJobListItem => ({
  code,
  title: `Job ${code}`,
  city: 'Austin',
  state_region: 'TX',
  trade_category: 'electrician',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

describe('GET /feed.xml', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://jaleapp.ai';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  it('serves RSS 2.0 with the correct content type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [], next_cursor: null }));
    const res = await GET();
    expect(res.headers.get('Content-Type')).toBe('application/rss+xml; charset=utf-8');
  });

  it('declares the atom namespace and a self-referencing atom:link', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [], next_cursor: null }));
    const xml = await (await GET()).text();
    expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
    expect(xml).toContain(
      '<atom:link href="https://jaleapp.ai/feed.xml" rel="self" type="application/rss+xml" />',
    );
  });

  it('declares <language>en-us</language> -- the feed only links /en/ URLs', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [], next_cursor: null }));
    const xml = await (await GET()).text();
    expect(xml).toContain('<language>en-us</language>');
  });

  it('derives <lastBuildDate> from the newest (first) item\'s created_at', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jobs: [
          item('NEWEST', { created_at: '2026-03-01T08:00:00.000Z' }),
          item('OLDER', { created_at: '2026-01-01T00:00:00.000Z' }),
        ],
        next_cursor: null,
      }),
    );
    const xml = await (await GET()).text();
    expect(xml).toContain('<lastBuildDate>Sun, 01 Mar 2026 08:00:00 GMT</lastBuildDate>');
  });

  it('falls back to the current time for <lastBuildDate> when there are no items', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T12:00:00.000Z'));
    fetchMock.mockResolvedValue(jsonResponse({ jobs: [], next_cursor: null }));
    const xml = await (await GET()).text();
    expect(xml).toContain('<lastBuildDate>Fri, 15 May 2026 12:00:00 GMT</lastBuildDate>');
    vi.useRealTimers();
  });

  it('caps the feed at 50 items and never asks the API for more than 50 per page', async () => {
    const fiftyJobs = Array.from({ length: 50 }, (_, i) => item(`J${i}`));
    fetchMock.mockResolvedValueOnce(jsonResponse({ jobs: fiftyJobs, next_cursor: 'more' }));
    const xml = await (await GET()).text();
    expect(xml.match(/<item>/g)?.length).toBe(50);
    // A single page was enough -- the cap must stop pagination, not just trim after the fact.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/public/jobs?limit=50',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('trims to exactly 50 when a single page returns more than the cap', async () => {
    const overflow = Array.from({ length: 60 }, (_, i) => item(`J${i}`));
    fetchMock.mockResolvedValueOnce(jsonResponse({ jobs: overflow, next_cursor: null }));
    const xml = await (await GET()).text();
    expect(xml.match(/<item>/g)?.length).toBe(50);
  });

  it('does not cap the underlying getPublicJobsList default used by sitemap.ts', async () => {
    // Sanity check on the shared helper's contract, guarded here since a
    // regression would silently starve sitemap.ts of jobs. The sitemap
    // itself is out of scope for this file.
    const { getPublicJobsList } = await import('@/lib/api/publicJob');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ jobs: Array.from({ length: 3 }, (_, i) => item(`S${i}`)), next_cursor: null }),
    );
    const jobs = await getPublicJobsList();
    expect(jobs).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/public/jobs?limit=500',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('XML-escapes untrusted employer text (title) in items', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        jobs: [item('X1', { title: 'Roofer</title><script>alert(1)</script>' })],
        next_cursor: null,
      }),
    );
    const xml = await (await GET()).text();
    expect(xml).not.toContain('<script>');
    expect(xml).toContain('Roofer&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('never 500s -- an underlying fetch failure still returns a valid, empty channel', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const res = await GET();
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<channel>');
    expect(xml.match(/<item>/g)).toBeNull();
  });
});
