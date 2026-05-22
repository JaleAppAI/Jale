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

  it('returns 401 if token is missing from the database', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await handler(makeEvent({ token: 'bad' }));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('invalid_token');
  });

  it('returns 401 if token is expired', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ used: false, unexpired: false, has_confirmed_documents: false }],
    });

    const res = await handler(makeEvent({ token: 'expired-token' }));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('invalid_token');
  });

  it('returns 409 confirm_required for a live token that confirm has not consumed', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ used: false, unexpired: true, has_confirmed_documents: false }],
    });

    const res = await handler(makeEvent({ token: 'valid-token' }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('confirm_required');
  });

  it('returns 200 for a token already consumed by confirm with a confirmed slot', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ used: true, unexpired: true, has_confirmed_documents: true }],
    });

    const res = await handler(makeEvent({ token: 'valid-token' }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(mockRelease).toHaveBeenCalled();
  });

  it('never marks a token used from the legacy submit endpoint', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ used: false, unexpired: true, has_confirmed_documents: false }],
    });

    await handler(makeEvent({ token: 'valid-token' }));

    const executedSql = mockQuery.mock.calls
      .map(([sql]) => String(sql))
      .join('\n');
    expect(executedSql).not.toContain('SET used = true');
    expect(executedSql).not.toContain('used_at = now()');
    expect(mockQuery).not.toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });
});
