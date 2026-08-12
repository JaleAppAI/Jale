import { handler } from '../../../../lambda/referrals/retention-sweeper';
import { getDbPool } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('referral retention sweeper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });

  it('deletes expired tokens, aged claims and aged opens, and reports what it removed', async () => {
    // Each table's first batch deletes fewer rows than the batch size, so the
    // loop terminates after one pass per table.
    mockQuery
      .mockResolvedValueOnce({ rowCount: 4 })   // tokens
      .mockResolvedValueOnce({ rowCount: 7 })   // claims
      .mockResolvedValueOnce({ rowCount: 9 });  // opens
    const res = await handler();
    expect(res).toEqual({ tokensDeleted: 4, claimsDeleted: 7, opensDeleted: 9 });
    const statements = mockQuery.mock.calls.map((c) => c[0]);
    expect(statements[0]).toContain('DELETE FROM referral_apply_tokens');
    expect(statements[1]).toContain('DELETE FROM referral_pending_claims');
    expect(statements[2]).toContain('DELETE FROM job_share_opens');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('keeps deleting in batches until a batch comes back short', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 5000 })  // tokens batch 1 (full)
      .mockResolvedValueOnce({ rowCount: 5000 })  // tokens batch 2 (full)
      .mockResolvedValueOnce({ rowCount: 123 })   // tokens batch 3 (short -> stop)
      .mockResolvedValueOnce({ rowCount: 0 })     // claims
      .mockResolvedValueOnce({ rowCount: 0 });    // opens
    const res = await handler();
    expect(res.tokensDeleted).toBe(10123);
    // Batching is the lock-safety mechanism: every DELETE must be ctid-bounded.
    for (const call of mockQuery.mock.calls) {
      expect(call[0]).toContain('ctid IN');
      expect(call[0]).toContain('LIMIT 5000');
    }
  });

  it('unclaimed claims are only removed after their expiry grace, not while live', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });
    await handler();
    const claimsDelete = mockQuery.mock.calls.map((c) => c[0]).find((q: string) => q.includes('referral_pending_claims'));
    // A live parked claim (claimed_at IS NULL, not yet expired) must never match.
    expect(claimsDelete).toContain('claimed_at IS NULL AND expires_at <');
    expect(claimsDelete).toContain("interval '30 days'");
  });

  it('logs counts only — no token, hash or IP shapes anywhere', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockQuery.mockResolvedValue({ rowCount: 0 });
    await handler();
    for (const call of logSpy.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toMatch(/[0-9a-f]{64}/); // no 64-hex hashes
      expect(line).not.toMatch(/JALE-/);        // no apply tokens
      expect(line).not.toMatch(/\d+\.\d+\.\d+\.\d+/); // no IPs
    }
    logSpy.mockRestore();
  });

  it('releases the client even when a delete throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await expect(handler()).rejects.toThrow('db down');
    expect(mockRelease).toHaveBeenCalled();
  });

  // job_visibility_events (062) grants jale_admin only SELECT/UPDATE under
  // FORCE RLS -- no DELETE grant, no FOR DELETE policy. A DELETE from this
  // sweeper would hard-fail with "permission denied for table
  // job_visibility_events" every run, not silently no-op. This pins the
  // decision to skip it until a migration adds the grant + policy.
  it('never issues a DELETE against job_visibility_events (no DELETE grant/policy exists — migration 062)', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });
    await handler();
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).not.toContain('job_visibility_events');
    }
  });
});
