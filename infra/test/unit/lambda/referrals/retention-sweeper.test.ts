import { handler } from '../../../../lambda/referrals/retention-sweeper';
import { getDbPool } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const PURGE_SQL = 'SELECT tokens_deleted, claims_deleted, opens_deleted FROM jale_cap.retention_purge($1)';
const SNAPSHOT_SQL = 'SELECT days_covered, rows_written FROM jale_cap.referral_funnel_snapshot()';

function batch(tokens: number, claims: number, opens: number) {
  return { rows: [{ tokens_deleted: tokens, claims_deleted: claims, opens_deleted: opens }], rowCount: 1 };
}

function statements(): string[] {
  return mockQuery.mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' ').trim());
}

// Sprint 28 (analytics item 21): every run first takes the referral funnel's
// daily snapshot, then purges. The fake database answers the snapshot from
// `snapshot` and each purge call from the `purges` queue, in order.
let snapshot: () => Promise<unknown>;
let purges: Array<() => Promise<unknown>>;
const purge = (...results: Array<ReturnType<typeof batch> | Error | { rows: never[]; rowCount: number }>) => {
  purges.push(...results.map((r) => () => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r))));
};
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('referral retention sweeper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    snapshot = () => Promise.resolve({ rows: [{ days_covered: 3, rows_written: 5 }], rowCount: 1 });
    purges = [];
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('referral_funnel_snapshot')) return snapshot();
      const next = purges.shift();
      return next ? next() : Promise.reject(new Error('unexpected purge call'));
    });
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });

  it('purges through jale_cap.retention_purge in batches of 5000, and reports what it removed', async () => {
    // Every count below the batch size: one call is the whole run.
    purge(batch(4, 7, 9));
    const res = await handler();
    expect(res).toEqual({ tokensDeleted: 4, claimsDeleted: 7, opensDeleted: 9 });
    expect(statements()).toEqual([SNAPSHOT_SQL, PURGE_SQL]);
    expect(mockQuery.mock.calls[1][1]).toEqual([5000]);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('keeps calling until every count comes back below the batch size, and sums them', async () => {
    purge(
      batch(5000, 0, 0),     // tokens full
      batch(5000, 10, 5000), // tokens and opens full
      batch(123, 0, 4),      // all short -> stop
    );
    const res = await handler();
    expect(res).toEqual({ tokensDeleted: 10123, claimsDeleted: 10, opensDeleted: 5004 });
    expect(statements()).toEqual([SNAPSHOT_SQL, PURGE_SQL, PURGE_SQL, PURGE_SQL]);
  });

  it('a full batch of any one table is enough to call again', async () => {
    purge(batch(0, 5000, 0), batch(0, 0, 0));
    const res = await handler();
    expect(res.claimsDeleted).toBe(5000);
    expect(statements().filter((sql) => sql === PURGE_SQL)).toHaveLength(2);
  });

  it('takes the referral funnel snapshot once, before the first purge, so it still sees what the purge removes', async () => {
    purge(batch(5000, 0, 0), batch(1, 0, 0));
    await handler();
    expect(statements()).toEqual([SNAPSHOT_SQL, PURGE_SQL, PURGE_SQL]);
    expect(mockQuery.mock.calls[0][1]).toBeUndefined();
  });

  it('a failed snapshot is logged as one static line and the purge still runs', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    snapshot = () => Promise.reject(pgError('42501', 'permission denied for function referral_funnel_snapshot'));
    purge(batch(4, 7, 9));
    const res = await handler();
    expect(res).toEqual({ tokensDeleted: 4, claimsDeleted: 7, opensDeleted: 9 });
    expect(statements()).toEqual([SNAPSHOT_SQL, PURGE_SQL]);
    expect(warnSpy.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
      { metric: 'ReferralFunnelSnapshotSkipped', code: '42501' },
    ]);
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('logs today\'s counts, and counts only -- no token, hash or IP shapes anywhere', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    purge(batch(4, 7, 9));
    await handler();
    expect(logSpy.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
      { metric: 'ReferralFunnelSnapshot', daysCovered: 3, rowsWritten: 5 },
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
    purge(new Error('db down'));
    await expect(handler()).rejects.toThrow('db down');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('throws when the purge returns no row, rather than looping or reporting zero', async () => {
    purge({ rows: [], rowCount: 0 });
    await expect(handler()).rejects.toThrow('retention_purge_missing');
    expect(mockRelease).toHaveBeenCalled();
  });

  // job_visibility_events (062) is deliberately not pruned here; pruning it
  // needs its own migration (a delete right, a delete rule and an index for
  // the predicate). This pins that decision.
  it('never touches job_visibility_events, and issues no table statement of its own', async () => {
    purge(batch(0, 0, 0));
    await handler();
    for (const sql of statements()) {
      expect(sql).not.toContain('job_visibility_events');
      expect(sql).not.toMatch(/\bDELETE\b/);
    }
  });
});
