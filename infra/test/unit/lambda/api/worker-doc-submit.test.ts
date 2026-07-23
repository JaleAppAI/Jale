import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-doc-submit';
import { getDbPool } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('worker-doc-submit Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });

  const makeEvent = (body: object) =>
    ({ body: JSON.stringify(body) }) as unknown as APIGatewayProxyEvent;

  it('returns 400 if token is missing', async () => {
    const res = await handler(makeEvent({}));
    expect(res.statusCode).toBe(400);
  });

  it('marks the token used and returns 200 when at least one document slot is confirmed', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ used: true }] }); // UPDATE ... RETURNING token.used

    const res = await handler(makeEvent({ token: 'valid-token' }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    const updateSql = mockQuery.mock.calls[0][0] as string;
    expect(updateSql).toContain('UPDATE document_upload_tokens');
    expect(updateSql).toContain('SET used = true');
    expect(updateSql).toContain('used_at = COALESCE(used_at, now())');
    expect(updateSql).toContain('slots.confirmed_at IS NOT NULL');
    expect(mockRelease).toHaveBeenCalled();
    // Only the single UPDATE query was needed -- no fallback existence check.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second submit on an already-used token still returns 200', async () => {
    // The token is already `used = true` from the first submit, but it
    // remains unexpired and still has a confirmed slot, so the UPDATE's
    // WHERE clause matches again and re-affirms success.
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ used: true }] });

    const res = await handler(makeEvent({ token: 'valid-token' }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
  });

  it('returns 409 confirm_required when the token is live but has no confirmed slots', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // UPDATE matches nothing (no confirmed slot)
      .mockResolvedValueOnce({ rows: [{ unexpired: true }] }); // existence/expiry check

    const res = await handler(makeEvent({ token: 'valid-token' }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('confirm_required');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('returns 401 if the token is missing from the database', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // UPDATE matches nothing
      .mockResolvedValueOnce({ rows: [] }); // existence/expiry check finds nothing

    const res = await handler(makeEvent({ token: 'bad' }));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('invalid_token');
  });

  it('returns 401 if the token is expired', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // UPDATE matches nothing (expired)
      .mockResolvedValueOnce({ rows: [{ unexpired: false }] }); // existence/expiry check

    const res = await handler(makeEvent({ token: 'expired-token' }));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('invalid_token');
  });
});
