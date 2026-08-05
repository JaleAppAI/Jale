import * as crypto from 'node:crypto';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/google-indexing-secret');

import { handler } from '../../../../lambda/referrals/visibility-outbox-drain';
import { getDbPool } from '../../../../lambda/lib/db';
import { getGoogleIndexingServiceAccountKey } from '../../../../lambda/lib/google-indexing-secret';

const mockGetDbPool = getDbPool as jest.Mock;
const mockGetKey = getGoogleIndexingServiceAccountKey as jest.Mock;

// A real RSA keypair so the RS256 JWT-assertion signing path (node:crypto)
// actually runs end to end, rather than being stubbed out.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const FAKE_KEY = { client_email: 'jale-indexing@test.iam.gserviceaccount.com', private_key: privateKey };

function makeRow(over: Partial<{
  id: string; job_id: string; public_code: string; event_kind: 'published' | 'removed'; attempt_count: number;
}> = {}) {
  return {
    id: 'evt-1',
    job_id: 'job-1',
    public_code: 'JOBCOD1',
    event_kind: 'published' as const,
    attempt_count: 0,
    ...over,
  };
}

function makePool(claimedRows: ReturnType<typeof makeRow>[]) {
  const updateQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  const claimQuery = jest.fn()
    .mockResolvedValueOnce(undefined) // BEGIN
    .mockResolvedValueOnce({ rows: claimedRows }) // the SELECT ... FOR UPDATE SKIP LOCKED
    .mockResolvedValueOnce(undefined); // COMMIT
  const claimRelease = jest.fn();
  const updateRelease = jest.fn();

  let claimed = false;
  const connect = jest.fn(async () => {
    if (!claimed) {
      claimed = true;
      return { query: claimQuery, release: claimRelease };
    }
    return { query: updateQuery, release: updateRelease };
  });

  return { connect, claimQuery, updateQuery, claimRelease, updateRelease };
}

function tokenResponse(ok = true, status = 200) {
  return { ok, status, json: async () => ({ access_token: 'fake-access-token' }) };
}

function indexingResponse(status: number) {
  return { ok: status >= 200 && status < 300, status, text: async () => `error ${status}` };
}

describe('visibility-outbox-drain', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, PUBLIC_SITE_BASE_URL: 'https://jaleapp.ai' };
    mockGetKey.mockResolvedValue(FAKE_KEY);
  });
  afterAll(() => { process.env = env; });

  it('exits cleanly, without touching the DB, when the secret is missing', async () => {
    mockGetKey.mockResolvedValue(null);
    const res = await handler();
    expect(res).toEqual({ sent: 0, pendingRetry: 0, failed: 0, haltedOnQuota: false });
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exits cleanly when PUBLIC_SITE_BASE_URL is unset', async () => {
    delete (process.env as any).PUBLIC_SITE_BASE_URL;
    const res = await handler();
    expect(res).toEqual({ sent: 0, pendingRetry: 0, failed: 0, haltedOnQuota: false });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('happy path: publishes a job and marks it sent', async () => {
    const pool = makePool([makeRow({ event_kind: 'published', public_code: 'ABC123' })]);
    mockGetDbPool.mockResolvedValue(pool);
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(indexingResponse(200));

    const res = await handler();

    expect(res).toEqual({ sent: 1, pendingRetry: 0, failed: 0, haltedOnQuota: false });

    // URL_UPDATED for a 'published' event, built from PUBLIC_SITE_BASE_URL + /en/j/<code>.
    const [, indexingCall] = mockFetch.mock.calls;
    const body = JSON.parse(indexingCall[1].body);
    expect(body).toEqual({ url: 'https://jaleapp.ai/en/j/ABC123', type: 'URL_UPDATED' });
    expect(indexingCall[1].headers.Authorization).toBe('Bearer fake-access-token');

    const updateCall = pool.updateQuery.mock.calls.find((c: any[]) => c[0].includes('UPDATE job_visibility_events'));
    expect(updateCall[0]).toContain("status = 'sent'");
    expect(updateCall[1]).toEqual(['evt-1']);
  });

  it('sends URL_DELETED for a removed event -- including for a deleted job', async () => {
    const pool = makePool([makeRow({ event_kind: 'removed', public_code: 'DEL999' })]);
    mockGetDbPool.mockResolvedValue(pool);
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(indexingResponse(200));

    const res = await handler();
    expect(res.sent).toBe(1);
    const [, indexingCall] = mockFetch.mock.calls;
    const body = JSON.parse(indexingCall[1].body);
    expect(body).toEqual({ url: 'https://jaleapp.ai/en/j/DEL999', type: 'URL_DELETED' });
  });

  it('429 halts the batch, preserves pending, and does not touch later rows', async () => {
    const rows = [makeRow({ id: 'evt-1', attempt_count: 2 }), makeRow({ id: 'evt-2' })];
    const pool = makePool(rows);
    mockGetDbPool.mockResolvedValue(pool);
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(indexingResponse(429));

    const res = await handler();

    expect(res).toEqual({ sent: 0, pendingRetry: 1, failed: 0, haltedOnQuota: true });
    // Only one indexing call made -- the batch stopped after the 429.
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 token exchange + 1 indexing call
    const updateCall = pool.updateQuery.mock.calls.find((c: any[]) => c[0].includes('UPDATE job_visibility_events'));
    expect(updateCall[0]).toContain("status = 'pending'");
    expect(updateCall[0]).toContain('attempt_count = attempt_count + 1');
    expect(updateCall[1][0]).toBe('evt-1');
  });

  it('5xx leaves the row pending and continues to the next row (no batch halt)', async () => {
    const rows = [makeRow({ id: 'evt-1' }), makeRow({ id: 'evt-2', public_code: 'JOBCOD2' })];
    const pool = makePool(rows);
    mockGetDbPool.mockResolvedValue(pool);
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(indexingResponse(503))
      .mockResolvedValueOnce(indexingResponse(200));

    const res = await handler();
    expect(res).toEqual({ sent: 1, pendingRetry: 1, failed: 0, haltedOnQuota: false });
    expect(mockFetch).toHaveBeenCalledTimes(3); // token + 2 indexing calls
  });

  it('other 4xx below MAX_ATTEMPTS stays pending', async () => {
    const pool = makePool([makeRow({ id: 'evt-1', attempt_count: 3 })]);
    mockGetDbPool.mockResolvedValue(pool);
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(indexingResponse(400));

    const res = await handler();
    expect(res).toEqual({ sent: 0, pendingRetry: 1, failed: 0, haltedOnQuota: false });
    const updateCall = pool.updateQuery.mock.calls.find((c: any[]) => c[0].includes('UPDATE job_visibility_events'));
    expect(updateCall[1]).toEqual(['evt-1', 'pending', expect.stringContaining('400')]);
  });

  it('other 4xx at MAX_ATTEMPTS (8) marks the row failed', async () => {
    // attempt_count = 7 -> next attempt is 8 -> hits MAX_ATTEMPTS -> 'failed'.
    const pool = makePool([makeRow({ id: 'evt-1', attempt_count: 7 })]);
    mockGetDbPool.mockResolvedValue(pool);
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(indexingResponse(403));

    const res = await handler();
    expect(res).toEqual({ sent: 0, pendingRetry: 0, failed: 1, haltedOnQuota: false });
    const updateCall = pool.updateQuery.mock.calls.find((c: any[]) => c[0].includes('UPDATE job_visibility_events'));
    expect(updateCall[1]).toEqual(['evt-1', 'failed', expect.stringContaining('403')]);
  });

  it('claims rows with FOR UPDATE SKIP LOCKED, bounded by MAX_ATTEMPTS and a batch size of 25', async () => {
    const pool = makePool([]);
    mockGetDbPool.mockResolvedValue(pool);

    await handler();

    const claimSql = pool.claimQuery.mock.calls[1][0];
    const claimParams = pool.claimQuery.mock.calls[1][1];
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claimSql).toContain("status IN ('pending', 'failed')");
    expect(claimParams).toEqual([8, 25]);
    // No rows claimed -- must not even fetch an OAuth token.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exits cleanly when the OAuth token exchange fails', async () => {
    const pool = makePool([makeRow()]);
    mockGetDbPool.mockResolvedValue(pool);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const res = await handler();
    expect(res).toEqual({ sent: 0, pendingRetry: 0, failed: 0, haltedOnQuota: false });
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the token exchange attempt
  });

  it('never logs the access token or the private key', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const pool = makePool([makeRow()]);
    mockGetDbPool.mockResolvedValue(pool);
    mockFetch
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(indexingResponse(200));

    await handler();

    const allLogged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ');
    expect(allLogged).not.toContain('fake-access-token');
    expect(allLogged).not.toContain(privateKey);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
