import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const { recordJobView } = await import('@/lib/api/worker');

beforeEach(() => { apiFetch.mockReset(); });

describe('recordJobView (K3.6 #17)', () => {
  it('posts the source, without renewal or redirect on a 401', () => {
    apiFetch.mockResolvedValue({ ok: true, status: 204 });
    recordJobView('tok', 'job-1', 'feed');
    expect(apiFetch).toHaveBeenCalledWith(
      '/worker/jobs/job-1/view',
      { method: 'POST', body: JSON.stringify({ source: 'feed' }) },
      'tok',
      { retryOn401: false },
    );
  });

  it('swallows every failure and returns nothing', async () => {
    apiFetch.mockRejectedValue(new Error('offline'));
    expect(recordJobView('tok', 'job-1', 'direct')).toBeUndefined();
    // Let the rejection settle: an unhandled one fails the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
