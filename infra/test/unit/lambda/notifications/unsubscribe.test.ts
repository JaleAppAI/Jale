import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockVerify = jest.fn();

jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({
    connect: jest.fn(() => Promise.resolve({ query: mockQuery, release: mockRelease })),
  })),
}));
jest.mock('../../../../lambda/lib/unsubscribe-token', () => ({
  verifyUnsubscribeToken: (...args: unknown[]) => mockVerify(...args),
}));

import { handler } from '../../../../lambda/notifications/unsubscribe';

const EMPLOYER_ID = '11111111-2222-4333-8444-555555555555';

function makeEvent(body: unknown, raw?: string): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    body: raw !== undefined ? raw : JSON.stringify(body),
    requestContext: {},
  } as unknown as APIGatewayProxyEvent;
}

describe('digest unsubscribe endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [{ unsubscribed: true }], rowCount: 1 });
  });

  // ── Unauthenticated by design ─────────────────────────────────────────────

  it('needs no Cognito claims — the signed token IS the credential', async () => {
    mockVerify.mockResolvedValue({ employerId: EMPLOYER_ID, version: 1 });
    const res = await handler(makeEvent({ token: 'good.token' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'unsubscribed' });
  });

  it('calls the SECURITY DEFINER function with the verified employer id and version', async () => {
    mockVerify.mockResolvedValue({ employerId: EMPLOYER_ID, version: 3 });
    await handler(makeEvent({ token: 'good.token' }));
    const call = mockQuery.mock.calls.find((c) => String(c[0]).includes('unsubscribe_employer'));
    expect(call).toBeDefined();
    expect(String(call![0])).toContain('jale_digest_internal.unsubscribe_employer');
    expect(call![1]).toEqual([EMPLOYER_ID, 3]);
    // Never a direct UPDATE: the definer function is the only write path.
    expect(mockQuery.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/UPDATE\s+employer_digest_settings/);
  });

  it('returns 200 when the function returns false — a version-bumped link is an idempotent no-op', async () => {
    mockVerify.mockResolvedValue({ employerId: EMPLOYER_ID, version: 1 });
    mockQuery.mockResolvedValue({ rows: [{ unsubscribed: false }], rowCount: 1 });
    const res = await handler(makeEvent({ token: 'stale.token' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'unsubscribed' });
  });

  it('releases the connection on the success path', async () => {
    mockVerify.mockResolvedValue({ employerId: EMPLOYER_ID, version: 1 });
    await handler(makeEvent({ token: 'good.token' }));
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  // ── Invalid tokens all collapse to one response ───────────────────────────

  it('returns a uniform 400 invalid_token when verification fails, and never touches the DB', async () => {
    mockVerify.mockResolvedValue(null);
    const res = await handler(makeEvent({ token: 'bad-hmac' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_token' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['missing token field', {}],
    ['null token', { token: null }],
    ['non-string token', { token: 42 }],
    ['empty token', { token: '' }],
  ])('returns the same 400 invalid_token for a %s', async (_label, body) => {
    mockVerify.mockResolvedValue(null);
    const res = await handler(makeEvent(body));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_token' });
  });

  it('returns 400 invalid_token for malformed JSON — the same body, leaking nothing', async () => {
    const res = await handler(makeEvent(undefined, '{not json'));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_token' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_token for a null body', async () => {
    const res = await handler({ httpMethod: 'POST', body: null, requestContext: {} } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_token' });
  });

  // ── Failures ─────────────────────────────────────────────────────────────

  it('returns 500 when the database call fails, and still releases the connection', async () => {
    mockVerify.mockResolvedValue({ employerId: EMPLOYER_ID, version: 1 });
    mockQuery.mockRejectedValue(new Error('connection reset'));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await handler(makeEvent({ token: 'good.token' }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('internal_error');
    expect(mockRelease).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });

  it('returns 500 — not 400 — when the signing secret is unreadable', async () => {
    // getUnsubscribeSecret() is fail-closed and throws. A 400 here would tell
    // a caller "your token is wrong" when in fact the service is broken.
    mockVerify.mockRejectedValue(new Error('UNSUBSCRIBE_SECRET_ARN env var not set'));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await handler(makeEvent({ token: 'good.token' }));
    expect(res.statusCode).toBe(500);
    expect(mockQuery).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  // ── CORS ─────────────────────────────────────────────────────────────────

  it('returns the shared CORS headers on every path', async () => {
    mockVerify.mockResolvedValue({ employerId: EMPLOYER_ID, version: 1 });
    const good = await handler(makeEvent({ token: 'good.token' }));
    mockVerify.mockResolvedValue(null);
    const bad = await handler(makeEvent({ token: 'bad' }));
    for (const res of [good, bad]) {
      expect(res.headers).toHaveProperty('Access-Control-Allow-Origin');
      expect(res.headers!['Content-Type']).toBe('application/json');
    }
  });
});
