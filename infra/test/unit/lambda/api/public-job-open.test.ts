import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/public-job-open';
import { getPublicJobsDbPool } from '../../../../lambda/lib/db';
import { getVisitorSalt } from '../../../../lambda/lib/referral-secrets';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/referral-secrets');

const mockGetPublicJobsDbPool = getPublicJobsDbPool as jest.Mock;
const mockGetVisitorSalt = getVisitorSalt as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });

describe('public-job-open Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockGetVisitorSalt.mockResolvedValue(null); // unconfigured by default
    mockGetPublicJobsDbPool.mockResolvedValue({ connect: mockConnect });
  });

  const makeEvent = (opts: {
    code?: string;
    body?: string | null;
    headers?: Record<string, string>;
    ip?: string;
  }): APIGatewayProxyEvent =>
    ({
      pathParameters: opts.code !== undefined ? { code: opts.code } : null,
      body: opts.body ?? null,
      headers: opts.headers ?? {},
      requestContext: { identity: { sourceIp: opts.ip ?? '1.2.3.4' } },
    }) as unknown as APIGatewayProxyEvent;

  it('returns 400 when code is missing', async () => {
    const res = await handler(makeEvent({}));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing_code');
  });

  it('returns 400 when code fails validation', async () => {
    const res = await handler(makeEvent({ code: '!!!' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_code');
  });

  it('does not record an open for a link-preview crawler, and never touches the DB', async () => {
    const res = await handler(makeEvent({
      code: 'ABC123',
      headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
    }));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(mockGetPublicJobsDbPool).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 204 for an unknown job, with no probing distinction from opted-out', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // job lookup
    const res = await handler(makeEvent({ code: 'ZZZZZZ' }));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('records an open with the byte-identical guarded INSERT and bumps the counter on a share match', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid' }] })      // job lookup
      .mockResolvedValueOnce({ rows: [{ code: 'ABCD1234' }] })    // share link match
      .mockResolvedValueOnce({})                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'open-1' }] })        // guarded insert -> recorded
      .mockResolvedValueOnce({})                                  // open_count bump
      .mockResolvedValueOnce({});                                 // COMMIT

    const res = await handler(makeEvent({
      code: 'ABC123',
      body: JSON.stringify({ r: 'ABCD1234' }),
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; like Mac OS X)' },
    }));

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const insertCall = mockQuery.mock.calls[3];
    expect(insertCall[0]).toMatch(/INSERT INTO job_share_opens/i);
    expect(insertCall[1][0]).toBe('ABCD1234');

    const bumpCall = mockQuery.mock.calls[4];
    expect(bumpCall[0]).toContain('UPDATE job_share_links');
    expect(bumpCall[0]).toContain('open_count');

    expect(mockQuery.mock.calls[2][0]).toBe('BEGIN');
    expect(mockQuery.mock.calls[5][0]).toBe('COMMIT');
  });

  // Ported from prod's public-job.test.ts (git history), adapted to this
  // endpoint's own mocking shape (204 responses, no job body in the result).
  it('does not bump the counter when the dedupe guard says this visitor was already counted', async () => {
    mockGetVisitorSalt.mockResolvedValue('test-salt');
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid' }] })      // job lookup
      .mockResolvedValueOnce({ rows: [{ code: 'ABCD1234' }] })    // share link match
      .mockResolvedValueOnce({})                                  // BEGIN
      .mockResolvedValueOnce({ rows: [] })                        // guarded INSERT -> already seen
      .mockResolvedValueOnce({});                                 // COMMIT

    const res = await handler(makeEvent({
      code: 'ABC123',
      body: JSON.stringify({ r: 'ABCD1234' }),
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; like Mac OS X)' },
    }));

    expect(res.statusCode).toBe(204);
    expect(mockQuery.mock.calls.some((c) => /open_count = open_count \+ 1/.test(c[0]))).toBe(false);
    // The dedupe no-op is not an error -- the transaction still commits.
    expect(mockQuery.mock.calls[4][0]).toBe('COMMIT');
  });

  // Ported from prod's public-job.test.ts (git history), adapted to this
  // endpoint's own mocking shape (204 responses, no job body in the result).
  it('rolls back and never commits the open insert when the counter-UPDATE rejects', async () => {
    // Guards the atomicity fix: open_count is surfaced straight to the
    // referring worker, so a partial write (insert lands, update fails) must
    // never be left committed.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid' }] })      // job lookup
      .mockResolvedValueOnce({ rows: [{ code: 'ABCD1234' }] })    // share link match
      .mockResolvedValueOnce({})                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'open-1' }] })        // guarded insert -> recorded
      .mockRejectedValueOnce(new Error('update failed'))          // counter bump rejects
      .mockResolvedValueOnce({});                                 // ROLLBACK

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handler(makeEvent({
      code: 'ABC123',
      body: JSON.stringify({ r: 'ABCD1234' }),
    }));

    // Recording an open must never fail the (fire-and-forget) request.
    expect(res.statusCode).toBe(204);
    // The insert did run, but inside the transaction that was then rolled back.
    expect(mockQuery.mock.calls[3][0]).toContain('INSERT INTO job_share_opens');
    expect(mockQuery.mock.calls[5][0]).toBe('ROLLBACK');
    expect(mockQuery.mock.calls.some((call) => call[0] === 'COMMIT')).toBe(false);
    errorSpy.mockRestore();
  });

  it('records an untagged open (share_code null) when r is malformed', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid' }] }) // job lookup
      .mockResolvedValueOnce({}) // BEGIN (no share lookup query -- r never validated)
      .mockResolvedValueOnce({ rows: [] }) // guarded insert
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent({
      code: 'ABC123',
      body: JSON.stringify({ r: 'not-a-valid-share-code' }),
    }));

    expect(res.statusCode).toBe(204);
    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[0]).toContain('INSERT INTO job_share_opens');
    expect(insertCall[1][0]).toBeNull();
  });

  it('records an untagged open (share_code null) when the body is bad JSON', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid' }] }) // job lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // guarded insert
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent({ code: 'ABC123', body: '{not json' }));

    expect(res.statusCode).toBe(204);
    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[1][0]).toBeNull();
  });

  it('inserts a null visitor_hash when the salt is unset', async () => {
    mockGetVisitorSalt.mockResolvedValue(null);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid' }] })
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'open-1' }] })
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(
      makeEvent({ code: 'ABC123', headers: { 'User-Agent': 'Mozilla/5.0' } }),
    );
    expect(res.statusCode).toBe(204);
    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[1][4]).toBeNull(); // visitor_hash param
  });

  it('still returns 204 and rolls back when the tracking insert throws', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid' }] }) // job lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error('insert failed')) // guarded insert throws
      .mockResolvedValueOnce({}); // ROLLBACK

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handler(makeEvent({ code: 'ABC123' }));

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(mockQuery.mock.calls[3][0]).toBe('ROLLBACK');
    expect(mockQuery.mock.calls.some((call) => call[0] === 'COMMIT')).toBe(false);
    expect(mockRelease).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('public-job-open record error:', expect.any(String));
    errorSpy.mockRestore();
  });

  it('still returns 204 when the pool/connect step itself throws', async () => {
    mockGetPublicJobsDbPool.mockRejectedValueOnce(new Error('pool unavailable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handler(makeEvent({ code: 'ABC123' }));

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    errorSpy.mockRestore();
  });
});
