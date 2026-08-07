import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/public-job-referrer';
import { getPublicJobsDbPool } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const mockGetPublicJobsDbPool = getPublicJobsDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('public-job-referrer Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockGetPublicJobsDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });

  const makeEvent = (opts: { code?: string; r?: string }): APIGatewayProxyEvent =>
    ({
      pathParameters: opts.code !== undefined ? { code: opts.code } : null,
      queryStringParameters: opts.r !== undefined ? { r: opts.r } : null,
    }) as unknown as APIGatewayProxyEvent;

  it('returns 400 when the path code is invalid', async () => {
    const res = await handler(makeEvent({ code: '!!!', r: 'ABCD1234' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_code');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when the path code is missing', async () => {
    const res = await handler(makeEvent({ r: 'ABCD1234' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing_code');
  });

  it('returns 404 when r is missing (organic visit)', async () => {
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 404 when r fails share-code validation, indistinguishable from unknown', async () => {
    const res = await handler(makeEvent({ code: 'ABC123', r: 'not-a-valid-share-code' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 404 when public_referrer_context resolves zero rows (unknown/revoked/wrong job)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await handler(makeEvent({ code: 'ABC123', r: 'ABCD1234' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
  });

  it('returns 200 with the worker referrer shape and first name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ kind: 'worker', first_name: 'Luis' }] });
    const res = await handler(makeEvent({ code: 'ABC123', r: 'ABCD1234' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ kind: 'worker', first_name: 'Luis' });

    const call = mockQuery.mock.calls[0];
    expect(call[0]).toContain('public_referrer_context');
    expect(call[1]).toEqual(['ABCD1234', 'ABC123']);
  });

  it('returns 200 with the employer referrer shape and a null first name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ kind: 'employer', first_name: null }] });
    const res = await handler(makeEvent({ code: 'ABC123', r: 'ABCD1234' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ kind: 'employer', first_name: null });
  });

  it('returns 500 internal_error and releases the client on unexpected failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db exploded'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await handler(makeEvent({ code: 'ABC123', r: 'ABCD1234' }));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    expect(mockRelease).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
