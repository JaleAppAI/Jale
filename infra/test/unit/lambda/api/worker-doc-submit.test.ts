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

  it('returns 401 if token is invalid or already used', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // token state
      .mockResolvedValueOnce({}); // ROLLBACK
    const res = await handler(makeEvent({ token: 'bad' }));
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 if token has no confirmed documents', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [{ used: false, unexpired: true }] }) // token state
      .mockResolvedValueOnce({}); // ROLLBACK

    const res = await handler(makeEvent({ token: 'valid-token' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('no_confirmed_documents');
  });

  it('returns 200 and marks token used on valid token with confirmed slots', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ token_hash: 'hash' }] }) // UPDATE used = true
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent({ token: 'valid-token' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('returns success idempotently if token is already complete', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [{ used: true, unexpired: true }] }) // token state
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent({ token: 'valid-token' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });
});
