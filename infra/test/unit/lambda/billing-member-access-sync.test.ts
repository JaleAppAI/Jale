/**
 * Tests for infra/lambda/billing/member-access-sync.ts — the 15-minute
 * catch-up that makes the employer pool match the database (Phase 3).
 *
 * As jale_billing: one short transaction reads the foremen whose desired
 * access changed in the last 7 days (at most 500); after COMMIT, with the
 * client released, the access is applied to Cognito; then a second short
 * transaction purges sent invite mail, so a purge failure cannot hold up
 * convergence.
 */
import type { Context, ScheduledEvent } from 'aws-lambda';
import { handler } from '../../../lambda/billing/member-access-sync';

jest.mock('../../../lambda/lib/db');
jest.mock('../../../lambda/lib/member-access');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockGetDbPool: jest.Mock = require('../../../lambda/lib/db').getDbPool;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockApplyMemberAccess: jest.Mock = require('../../../lambda/lib/member-access').applyMemberAccess;

const DAY_MS = 24 * 60 * 60 * 1000;
const READ_SQL = 'SELECT cognito_sub, enabled FROM jale_cap.org_member_access(NULL, $1, 500)';
const TX_SETUP = ['BEGIN', "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '30s'"];

function dbError(code: string, message = 'canceling statement due to lock timeout') {
  return Object.assign(new Error(message), { code });
}

function makeDb(opts: { accessRows?: unknown[]; purged?: number; failOn?: string } = {}) {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (opts.failOn && String(sql).includes(opts.failOn)) return Promise.reject(dbError('55P03'));
    if (String(sql).includes('org_member_access')) return Promise.resolve({ rows: opts.accessRows ?? [] });
    if (String(sql).includes('org_team_invite_mail_purge')) return Promise.resolve({ rows: [{ purged: opts.purged ?? 0 }] });
    return Promise.resolve({ rows: [] });
  });
  const release = jest.fn();
  const connect = jest.fn().mockResolvedValue({ query, release });
  mockGetDbPool.mockResolvedValue({ connect });
  return { query, release, connect };
}

function invoke(remainingMs = 60_000): Promise<unknown> {
  const context = { getRemainingTimeInMillis: () => remainingMs } as unknown as Context;
  return Promise.resolve(handler({} as ScheduledEvent, context, () => undefined));
}

function logged(spy: jest.SpyInstance, event: string): Record<string, unknown>[] {
  return spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes(`"event":"${event}"`))
    .map((line) => JSON.parse(line));
}

function sqlTexts(query: jest.Mock): string[] {
  return query.mock.calls.map(([sql]) => String(sql));
}

describe('member-access sync', () => {
  let info: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockApplyMemberAccess.mockResolvedValue({ converged: 0, failed: [] });
  });

  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it('reads members changed in the last 7 days, at most 500, and applies them after COMMIT with the client released', async () => {
    const { query, release } = makeDb({
      accessRows: [
        { cognito_sub: 'sub-a', enabled: true },
        { cognito_sub: 'sub-b', enabled: false },
      ],
    });
    mockApplyMemberAccess.mockResolvedValue({ converged: 2, failed: [] });

    const before = Date.now();
    await expect(invoke(60_000)).resolves.toBeUndefined();
    const after = Date.now();

    const sqls = sqlTexts(query);
    const readAt = sqls.indexOf(READ_SQL);
    expect(readAt).toBeGreaterThan(-1);
    const since = new Date(query.mock.calls[readAt][1][0] as string).getTime();
    expect(since).toBeGreaterThanOrEqual(before - 7 * DAY_MS);
    expect(since).toBeLessThanOrEqual(after - 7 * DAY_MS);

    expect(mockApplyMemberAccess).toHaveBeenCalledTimes(1);
    const [changes, deps] = mockApplyMemberAccess.mock.calls[0];
    expect(changes).toEqual([
      { cognitoSub: 'sub-a', enabled: true },
      { cognitoSub: 'sub-b', enabled: false },
    ]);
    // Deadline: the remaining time less 5 s.
    expect(deps.deadlineAt).toBeGreaterThanOrEqual(before + 55_000);
    expect(deps.deadlineAt).toBeLessThanOrEqual(after + 55_000);

    // The read's COMMIT and release both come before the Cognito calls.
    const applyAt = mockApplyMemberAccess.mock.invocationCallOrder[0];
    expect(sqls[readAt + 1]).toBe('COMMIT');
    expect(query.mock.invocationCallOrder[readAt + 1]).toBeLessThan(applyAt);
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(applyAt);
    expect(logged(warn, 'member_access_sync_saturated')).toEqual([]);
  });

  it('runs two short transactions, each with a 5 s lock timeout and a 30 s statement timeout', async () => {
    const { query, release, connect } = makeDb({ accessRows: [{ cognito_sub: 'sub-a', enabled: false }] });

    await invoke();

    expect(sqlTexts(query)).toEqual([
      ...TX_SETUP, READ_SQL, 'COMMIT',
      ...TX_SETUP, 'SELECT jale_cap.org_team_invite_mail_purge(500) AS purged', 'COMMIT',
    ]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('purges sent invite mail with a batch of 500, in its own transaction after Cognito converged', async () => {
    const { query } = makeDb({ accessRows: [{ cognito_sub: 'sub-a', enabled: true }], purged: 7 });

    await invoke();

    const sqls = sqlTexts(query);
    const purgeAt = sqls.findIndex((sql) => sql.includes('org_team_invite_mail_purge'));
    expect(sqls[purgeAt]).toContain('jale_cap.org_team_invite_mail_purge(500)');
    expect(query.mock.invocationCallOrder[purgeAt]).toBeGreaterThan(mockApplyMemberAccess.mock.invocationCallOrder[0]);
    expect(sqls.slice(purgeAt - 3, purgeAt)).toEqual(TX_SETUP);
    expect(sqls[purgeAt + 1]).toBe('COMMIT');
  });

  it('logs member_access_sync with read, converged, failed and purged counts', async () => {
    makeDb({
      accessRows: [
        { cognito_sub: 'sub-a', enabled: true },
        { cognito_sub: 'sub-b', enabled: false },
        { cognito_sub: 'sub-c', enabled: false },
      ],
      purged: 4,
    });
    mockApplyMemberAccess.mockResolvedValue({ converged: 2, failed: ['sub-c'] });

    await invoke();

    expect(logged(info, 'member_access_sync')).toEqual([
      { event: 'member_access_sync', read: 3, converged: 2, failed: 1, purged: 4 },
    ]);
  });

  it('logs member_access_sync_saturated when the read returns its 500-row cap', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ cognito_sub: `sub-${i}`, enabled: false }));
    makeDb({ accessRows: rows });
    mockApplyMemberAccess.mockResolvedValue({ converged: 500, failed: [] });

    await invoke();

    expect(logged(warn, 'member_access_sync_saturated')).toEqual([
      { event: 'member_access_sync_saturated', read: 500, limit: 500 },
    ]);
  });

  it('a DB failure on the read is logged and rethrown, with no Cognito call and no purge', async () => {
    const { query, release } = makeDb({ failOn: 'org_member_access' });

    await expect(invoke()).rejects.toThrow('canceling statement due to lock timeout');

    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(sqlTexts(query).some((sql) => sql.includes('org_team_invite_mail_purge'))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
    expect(logged(error, 'member_access_sync_failed')).toEqual([
      { event: 'member_access_sync_failed', code: '55P03' },
    ]);
  });

  it.each([
    ['the pool cannot be built', () => mockGetDbPool.mockRejectedValue(Object.assign(new Error('secret'), { name: 'ResourceNotFoundException' })), 'ResourceNotFoundException'],
    ['no connection can be had', () => mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockRejectedValue(dbError('57P03', 'the database system is starting up')) }), '57P03'],
  ])('a failure before the read (%s) is logged and rethrown', async (_label, arrange, code) => {
    arrange();

    await expect(invoke()).rejects.toThrow();

    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
    expect(logged(error, 'member_access_sync_failed')).toEqual([{ event: 'member_access_sync_failed', code }]);
  });

  it('a purge failure is logged on its own after Cognito converged, and rethrown', async () => {
    const { query, release } = makeDb({ accessRows: [{ cognito_sub: 'sub-a', enabled: false }], failOn: 'org_team_invite_mail_purge' });
    mockApplyMemberAccess.mockResolvedValue({ converged: 1, failed: [] });

    await expect(invoke()).rejects.toThrow('canceling statement due to lock timeout');

    expect(mockApplyMemberAccess).toHaveBeenCalledTimes(1);
    expect(sqlTexts(query).filter((sql) => sql === 'COMMIT')).toHaveLength(1);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(2);
    expect(logged(error, 'member_access_purge_failed')).toEqual([{ event: 'member_access_purge_failed', code: '55P03' }]);
    expect(logged(error, 'member_access_sync_failed')).toEqual([]);
    expect(logged(info, 'member_access_sync')).toEqual([
      { event: 'member_access_sync', read: 1, converged: 1, failed: 0, purged: null },
    ]);
  });

  it('makes no Cognito call when nothing changed, and still purges', async () => {
    const { query } = makeDb({ purged: 2 });

    await invoke();

    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
    expect(sqlTexts(query).some((sql) => sql.includes('org_team_invite_mail_purge'))).toBe(true);
    expect(logged(info, 'member_access_sync')).toEqual([
      { event: 'member_access_sync', read: 0, converged: 0, failed: 0, purged: 2 },
    ]);
  });
});
