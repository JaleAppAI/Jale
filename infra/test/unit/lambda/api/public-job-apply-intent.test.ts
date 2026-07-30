import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/public-job-apply-intent';
import { getPublicJobsDbPool } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const mockGetPublicJobsDbPool = getPublicJobsDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('public-job-apply-intent Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    process.env.WHATSAPP_BUSINESS_NUMBER = '15551234567';
    mockGetPublicJobsDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });

  const makeEvent = (opts: { code?: string; r?: string; headers?: Record<string, string> }) =>
    ({
      pathParameters: opts.code !== undefined ? { code: opts.code } : null,
      queryStringParameters: opts.r !== undefined ? { r: opts.r } : null,
      headers: opts.headers ?? {},
    }) as unknown as APIGatewayProxyEvent;

  it('returns 400 when code is missing', async () => {
    const res = await handler(makeEvent({}));
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown code', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
  });

  it('returns 409 when the job is not active', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'job-uuid', status: 'filled' }] });
    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('job_not_active');
  });

  it('mints a token and returns a wa.me link on success, without logging the raw token', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid', status: 'active' }] }) // job lookup
      .mockResolvedValueOnce({ rows: [] }); // token insert

    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.token).toMatch(/^JALE-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(body.whatsappUrl).toContain('https://wa.me/15551234567?text=');
    expect(decodeURIComponent(body.whatsappUrl.split('text=')[1])).toBe(
      `I want to apply for this job: ${body.token}`,
    );

    const rawToken = body.token.replace('JALE-', '');
    const allLoggedText = [...consoleSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((v) => String(v))
      .join(' ');
    expect(allLoggedText).not.toContain(rawToken);
    expect(mockRelease).toHaveBeenCalled();

    consoleSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('stores only the token hash, never the raw token', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await handler(makeEvent({ code: 'ABC123' }));
    const body = JSON.parse(res.body);
    const rawToken = body.token.replace('JALE-', '');

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain('INSERT INTO referral_apply_tokens');
    const [tokenHash] = insertCall[1];
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(rawToken);
  });

  it('retries once on a unique_violation and succeeds on the second attempt', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid', status: 'active' }] }) // job lookup
      .mockRejectedValueOnce(uniqueViolation) // first insert attempt collides
      .mockResolvedValueOnce({ rows: [] }); // second insert attempt succeeds

    const res = await handler(makeEvent({ code: 'ABC123' }));
    expect(res.statusCode).toBe(201);
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('resolves and stores a validated share code', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid', status: 'active' }] }) // job lookup
      .mockResolvedValueOnce({ rows: [{ code: 'ABCD1234' }] }) // share link match
      .mockResolvedValueOnce({ rows: [] }); // token insert

    const res = await handler(makeEvent({ code: 'ABC123', r: 'ABCD1234' }));
    expect(res.statusCode).toBe(201);
    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[1][1]).toBe('ABCD1234'); // share_code param
  });
});
