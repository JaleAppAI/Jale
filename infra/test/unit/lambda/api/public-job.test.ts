import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/public-job';
import { getPublicJobsDbPool } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const mockGetPublicJobsDbPool = getPublicJobsDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const ACTIVE_JOB_ROW = {
  id: 'job-uuid',
  code: 'ABC123',
  title: 'Warehouse Associate',
  company: 'Acme Co',
  location: 'Miami, FL',
  job_type: 'full_time',
  description: 'Lift boxes',
  pay: 20,
  pay_min: 18,
  pay_max: 22,
  pay_interval: 'hourly',
  start_date: null,
  expected_duration: null,
  shift_schedule: null,
  trade_category: null,
  required_experience_years: null,
  required_experience_months: null,
  certifications: null,
  language_preference: null,
  transportation_required: false,
  work_authorization_required: false,
  number_of_workers_needed: 2,
  required_docs: [],
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('public-job Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    delete process.env.REFERRAL_VISITOR_SALT;
    mockGetPublicJobsDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });

  const makeEvent = (opts: {
    code?: string;
    r?: string;
    headers?: Record<string, string>;
    ip?: string;
  }): APIGatewayProxyEvent =>
    ({
      pathParameters: opts.code !== undefined ? { code: opts.code } : null,
      queryStringParameters: opts.r !== undefined ? { r: opts.r } : null,
      headers: opts.headers ?? {},
      requestContext: { identity: { sourceIp: opts.ip ?? '1.2.3.4' } },
    }) as unknown as APIGatewayProxyEvent;

  it('does not record an open for a link-preview crawler, but still returns the job', async () => {
    // Pasting a link into WhatsApp triggers Meta's crawler immediately: without
    // this guard, open_count reads 1 before any human clicks, and that number
    // is shown straight to the referring worker.
    mockQuery.mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] }); // job lookup only
    const res = await handler(makeEvent({
      code: 'ABC123',
      headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).title).toBe('Warehouse Associate');
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO job_share_opens/i.test(c[0]))).toBe(false);
  });

  it('does not bump the counter when the dedupe guard says this visitor was already counted', async () => {
    process.env.REFERRAL_VISITOR_SALT = 'test-salt';
    mockQuery
      .mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] })          // job lookup
      .mockResolvedValueOnce({ rows: [{ code: 'ABCD1234' }] })    // share link match
      .mockResolvedValueOnce({})                                  // BEGIN
      .mockResolvedValueOnce({ rows: [] })                        // guarded INSERT -> already seen
      .mockResolvedValueOnce({});                                 // COMMIT
    const res = await handler(makeEvent({
      code: 'ABC123', r: 'ABCD1234',
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; like Mac OS X)' },
    }));
    expect(res.statusCode).toBe(200);
    expect(mockQuery.mock.calls.some((c) => /open_count = open_count \+ 1/.test(c[0]))).toBe(false);
  });

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

  it('returns 404 for an unknown code', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // job lookup
    const res = await handler(makeEvent({ code: 'ZZZZZZ' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
  });

  it('is indistinguishable from unknown when the employer opted out (RLS hides the row)', async () => {
    // The RLS policy jobs_public_read filters on public_listing_enabled, so an
    // opted-out job simply never appears in the result set -- same zero-row
    // path as a code that never existed.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
  });

  it('returns the full public projection for an active job', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] }) // job lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // open insert
      .mockResolvedValueOnce({}); // COMMIT
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('ABC123');
    expect(body.title).toBe('Warehouse Associate');
    expect(body.status).toBe('active');
    expect(body.id).toBeUndefined();
    expect(body.employer_id).toBeUndefined();
  });

  it('returns the minimal closed view for a non-active job, not a 404', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...ACTIVE_JOB_ROW, status: 'filled' }] })
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // open insert
      .mockResolvedValueOnce({}); // COMMIT
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      code: 'ABC123',
      title: 'Warehouse Associate',
      company: 'Acme Co',
      location: 'Miami, FL',
      status: 'closed',
      applications_closed: true,
    });
  });

  it('records an untagged open when r is malformed', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] }) // job lookup
      .mockResolvedValueOnce({}) // BEGIN (no share lookup query, since r is invalid shape)
      .mockResolvedValueOnce({}) // open insert
      .mockResolvedValueOnce({}); // COMMIT
    const res = await handler(makeEvent({ code: 'ABC123', r: 'not-a-valid-share-code' }));
    expect(res.statusCode).toBe(200);
    const openInsertCall = mockQuery.mock.calls[2];
    expect(openInsertCall[0]).toContain('INSERT INTO job_share_opens');
    expect(openInsertCall[1][0]).toBeNull();
  });

  it('records an untagged open when r points at a different job', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] }) // job lookup
      .mockResolvedValueOnce({ rows: [] }) // share link lookup -- no match for this job
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // open insert
      .mockResolvedValueOnce({}); // COMMIT
    const res = await handler(makeEvent({ code: 'ABC123', r: 'ABCD1234' }));
    expect(res.statusCode).toBe(200);
    const openInsertCall = mockQuery.mock.calls[3];
    expect(openInsertCall[0]).toContain('INSERT INTO job_share_opens');
    expect(openInsertCall[1][0]).toBeNull();
  });

  it('tags the open and bumps open_count when r matches a live share link', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] }) // job lookup
      .mockResolvedValueOnce({ rows: [{ code: 'ABCD1234' }] }) // share link lookup -- match
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'open-1' }] }) // guarded insert -> recorded
      .mockResolvedValueOnce({}) // open_count bump
      .mockResolvedValueOnce({}); // COMMIT
    const res = await handler(makeEvent({ code: 'ABC123', r: 'ABCD1234' }));
    expect(res.statusCode).toBe(200);
    const openInsertCall = mockQuery.mock.calls[3];
    expect(openInsertCall[1][0]).toBe('ABCD1234');
    const bumpCall = mockQuery.mock.calls[4];
    expect(bumpCall[0]).toContain('UPDATE job_share_links');
    expect(bumpCall[0]).toContain('open_count');
    // Both statements landed inside the same transaction, then committed once.
    expect(mockQuery.mock.calls[2][0]).toBe('BEGIN');
    expect(mockQuery.mock.calls[5][0]).toBe('COMMIT');
  });

  it('does not throw and inserts a null visitor_hash when the salt is unset', async () => {
    delete process.env.REFERRAL_VISITOR_SALT;
    mockQuery
      .mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] })
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'open-1' }] }) // guarded insert -> recorded
      .mockResolvedValueOnce({}); // COMMIT
    const res = await handler(
      makeEvent({ code: 'ABC123', headers: { 'User-Agent': 'Mozilla/5.0' } }),
    );
    expect(res.statusCode).toBe(200);
    const openInsertCall = mockQuery.mock.calls[2];
    expect(openInsertCall[1][4]).toBeNull(); // visitor_hash param
  });

  it('still returns the job when recording the open throws', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] }) // job lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error('insert failed')) // open insert throws
      .mockResolvedValueOnce({}); // ROLLBACK
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe('ABC123');
    expect(mockQuery.mock.calls[3][0]).toBe('ROLLBACK');
    expect(mockQuery.mock.calls.some((call) => call[0] === 'COMMIT')).toBe(false);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('rolls back and never commits the open insert when the counter update rejects', async () => {
    // Guards the atomicity fix: open_count is surfaced straight to the
    // referring worker, so a partial write (insert lands, update fails) must
    // never be left committed.
    mockQuery
      .mockResolvedValueOnce({ rows: [ACTIVE_JOB_ROW] }) // job lookup
      .mockResolvedValueOnce({ rows: [{ code: 'ABCD1234' }] }) // share link lookup -- match
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'open-1' }] }) // guarded insert -> recorded
      .mockRejectedValueOnce(new Error('update failed')) // counter bump rejects
      .mockResolvedValueOnce({}); // ROLLBACK
    const res = await handler(makeEvent({ code: 'ABC123', r: 'ABCD1234' }));
    // The request still succeeds -- recording an open must never fail it.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe('ABC123');
    // The insert did run, but inside the transaction that was then rolled back.
    expect(mockQuery.mock.calls[3][0]).toContain('INSERT INTO job_share_opens');
    expect(mockQuery.mock.calls[5][0]).toBe('ROLLBACK');
    expect(mockQuery.mock.calls.some((call) => call[0] === 'COMMIT')).toBe(false);
  });
});
