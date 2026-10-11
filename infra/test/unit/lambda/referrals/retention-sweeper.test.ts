import { handler } from '../../../../lambda/referrals/retention-sweeper';
import { getDbPool } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const PURGE_SQL = 'SELECT tokens_deleted, claims_deleted, opens_deleted FROM jale_cap.retention_purge($1)';

function batch(tokens: number, claims: number, opens: number) {
  return { rows: [{ tokens_deleted: tokens, claims_deleted: claims, opens_deleted: opens }], rowCount: 1 };
}

function statements(): string[] {
  return mockQuery.mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' ').trim());
}

describe('referral retention sweeper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });

  it('purges through jale_cap.retention_purge in batches of 5000, and reports what it removed', async () => {
    // Every count below the batch size: one call is the whole run.
    mockQuery.mockResolvedValueOnce(batch(4, 7, 9));
    const res = await handler();
    expect(res).toEqual({ tokensDeleted: 4, claimsDeleted: 7, opensDeleted: 9 });
    expect(statements()).toEqual([PURGE_SQL]);
    expect(mockQuery.mock.calls[0][1]).toEqual([5000]);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('keeps calling until every count comes back below the batch size, and sums them', async () => {
    mockQuery
      .mockResolvedValueOnce(batch(5000, 0, 0))     // tokens full
      .mockResolvedValueOnce(batch(5000, 10, 5000)) // tokens and opens full
      .mockResolvedValueOnce(batch(123, 0, 4));     // all short -> stop
    const res = await handler();
    expect(res).toEqual({ tokensDeleted: 10123, claimsDeleted: 10, opensDeleted: 5004 });
    expect(statements()).toEqual([PURGE_SQL, PURGE_SQL, PURGE_SQL]);
  });

  it('a full batch of any one table is enough to call again', async () => {
    mockQuery
      .mockResolvedValueOnce(batch(0, 5000, 0))
      .mockResolvedValueOnce(batch(0, 0, 0));
    const res = await handler();
    expect(res.claimsDeleted).toBe(5000);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('logs today\'s counts, and counts only -- no token, hash or IP shapes anywhere', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockQuery.mockResolvedValueOnce(batch(4, 7, 9));
    await handler();
    expect(logSpy.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
      { metric: 'ReferralRetentionSweep', tokensDeleted: 4, claimsDeleted: 7, opensDeleted: 9 },
    ]);
    for (const call of logSpy.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toMatch(/[0-9a-f]{64}/); // no 64-hex hashes
      expect(line).not.toMatch(/JALE-/);        // no apply tokens
      expect(line).not.toMatch(/\d+\.\d+\.\d+\.\d+/); // no IPs
    }
    logSpy.mockRestore();
  });

  it('releases the client even when the purge throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await expect(handler()).rejects.toThrow('db down');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('throws when the purge returns no row, rather than looping or reporting zero', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(handler()).rejects.toThrow('retention_purge_missing');
    expect(mockRelease).toHaveBeenCalled();
  });

  // job_visibility_events (062) is deliberately not pruned here; pruning it
  // needs its own migration (a delete right, a delete rule and an index for
  // the predicate). This pins that decision.
  it('never touches job_visibility_events, and issues no table statement of its own', async () => {
    mockQuery.mockResolvedValueOnce(batch(0, 0, 0));
    await handler();
    for (const sql of statements()) {
      expect(sql).not.toContain('job_visibility_events');
      expect(sql).not.toMatch(/\bDELETE\b/);
    }
  });
});
