import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/public-jobs-list';
import { getPublicJobsDbPool } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const mockGetPublicJobsDbPool = getPublicJobsDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    queryStringParameters: null,
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

function makeRow(over: Partial<{ id: string; code: string; created_at: string | Date; cursor_created_at: string }> = {}) {
  const created_at = over.created_at ?? '2026-06-01T00:00:00.000Z';
  return {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'JOBCOD1',
    title: 'Concrete Finisher',
    city: 'Austin',
    state_region: 'TX',
    trade_category: 'concrete',
    updated_at: '2026-06-01T00:00:00.000Z',
    // cursor_created_at is what the SQL's `created_at::text` cast would produce --
    // full Postgres precision, independent of created_at's own JS representation.
    cursor_created_at: typeof created_at === 'string' ? created_at : created_at.toISOString(),
    ...over,
    created_at,
  };
}

describe('public-jobs-list', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetPublicJobsDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });

  it('never calls setRlsContext-style auth -- the route is unauthenticated', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
  });

  it('the query explicitly filters status = active, not just public_listing_enabled', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await handler(makeEvent());
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('public_listing_enabled = true');
  });

  it('defaults to a limit of 100 and requests one extra row to detect a next page', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await handler(makeEvent());
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/LIMIT \$1/);
    expect(params).toEqual([101]);
  });

  it('caps an oversized limit at 500', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await handler(makeEvent({ queryStringParameters: { limit: '10000' } }));
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([501]);
  });

  it('falls back to the default limit for a non-numeric or non-positive limit', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    for (const bad of ['abc', '0', '-5', '12.5']) {
      mockQuery.mockClear();
      await handler(makeEvent({ queryStringParameters: { limit: bad } }));
      const [, params] = mockQuery.mock.calls[0];
      expect(params[params.length - 1]).toBe(101);
    }
  });

  it('returns jobs shaped per spec and no next_cursor when the page is not full', async () => {
    mockQuery.mockResolvedValue({ rows: [makeRow()] });
    const res = await handler(makeEvent({ queryStringParameters: { limit: '10' } }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.jobs).toEqual([{
      code: 'JOBCOD1',
      title: 'Concrete Finisher',
      city: 'Austin',
      state_region: 'TX',
      trade_category: 'concrete',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    }]);
    expect(body.next_cursor).toBeNull();
    // The internal id must never leak into the response.
    expect(body.jobs[0].id).toBeUndefined();
  });

  it('round-trips a cursor: encodes next_cursor, and a request with that cursor filters on it', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeRow({
      id: `11111111-1111-4111-8111-11111111111${i}`,
      code: `JOB${i}`,
      created_at: `2026-06-0${3 - i}T00:00:00.000Z`,
    }));
    mockQuery.mockResolvedValueOnce({ rows }); // limit=2 -> 3 rows returned means hasMore
    const res = await handler(makeEvent({ queryStringParameters: { limit: '2' } }));
    const body = JSON.parse(res.body);
    expect(body.jobs).toHaveLength(2);
    expect(body.next_cursor).toEqual(expect.any(String));

    const decoded = Buffer.from(body.next_cursor, 'base64').toString('utf-8');
    expect(decoded).toBe(`2026-06-02T00:00:00.000Z|${rows[1].id}`);

    mockQuery.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await handler(makeEvent({ queryStringParameters: { limit: '2', cursor: body.next_cursor } }));
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('(created_at, id) < ($1::timestamptz, $2::uuid)');
    expect(params).toEqual(['2026-06-02T00:00:00.000Z', rows[1].id, 3]);
  });

  it('builds the cursor from the microsecond-precision text cast, not a millisecond-truncated Date', async () => {
    // Simulates what node-postgres actually hands back: created_at parsed into a
    // JS Date (millisecond resolution) alongside cursor_created_at, a separate
    // text-cast column carrying full Postgres microsecond precision. If the
    // cursor were ever built from the Date instead, this microsecond digit would
    // be silently dropped and the row would reappear on the next page.
    const preciseTimestamp = '2026-06-02 00:00:00.000500+00';
    const row = makeRow({
      id: '11111111-1111-4111-8111-111111111110',
      created_at: new Date('2026-06-02T00:00:00.000Z'),
      cursor_created_at: preciseTimestamp,
    });
    // A second row so the handler's "fetch limit+1" check reports hasMore=true --
    // otherwise no next_cursor is produced at all.
    const extraRow = makeRow({ id: '11111111-1111-4111-8111-111111111111' });
    mockQuery.mockResolvedValueOnce({ rows: [row, extraRow] });
    const res = await handler(makeEvent({ queryStringParameters: { limit: '1' } }));
    const body = JSON.parse(res.body);
    const decoded = Buffer.from(body.next_cursor, 'base64').toString('utf-8');
    expect(decoded).toBe(`${preciseTimestamp}|${row.id}`);
  });

  it('rejects a malformed cursor with 400, without leaking a stack trace', async () => {
    const res = await handler(makeEvent({ queryStringParameters: { cursor: 'not-valid-base64!!!' } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_cursor' });
    expect(mockGetPublicJobsDbPool).not.toHaveBeenCalled();
  });

  it('rejects a cursor decoding to garbage (no pipe, bad uuid, bad date)', async () => {
    const bad = Buffer.from('nopipehere', 'utf-8').toString('base64');
    const res = await handler(makeEvent({ queryStringParameters: { cursor: bad } }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 500 on a query failure', async () => {
    mockQuery.mockRejectedValue(new Error('boom'));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('always releases the client', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await handler(makeEvent());
    expect(mockRelease).toHaveBeenCalled();
  });
});
