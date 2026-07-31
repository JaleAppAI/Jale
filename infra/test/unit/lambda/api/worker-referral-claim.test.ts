import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-referral-claim';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { sub: 'w-sub' } } },
    body: JSON.stringify({ shareCode: 'ABCDEFGH' }),
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

describe('worker-referral-claim', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockResolvedValue({});
  });
  afterAll(() => { process.env = env; });

  function mockHappyPath(linkRow: { job_id: string; channel: string; referrer_worker_id: string | null } | null) {
    mockQuery.mockImplementation((q: string) => {
      if (typeof q !== 'string') return Promise.resolve({});
      if (q.includes('SELECT id, user_type FROM users')) {
        return Promise.resolve({ rows: [{ id: 'worker-id', user_type: 'worker' }] });
      }
      if (q.includes('FROM job_share_links')) {
        return Promise.resolve({ rows: linkRow ? [linkRow] : [] });
      }
      if (q.includes('INSERT INTO worker_attribution')) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({});
    });
  }

  it('returns 401 when unauthenticated', async () => {
    const res = await handler(makeEvent({ requestContext: {} as any }));
    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_json for malformed body', async () => {
    const res = await handler(makeEvent({ body: '{not json' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_json' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_share_code when shareCode is missing', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({}) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_share_code' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_share_code when shareCode is not a string', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ shareCode: 12345678 }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_share_code' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_share_code for a malformed code', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ shareCode: '!!!' }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_share_code' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does NOT gate on ToS compliance -- a fresh post-OTP signup with no tos_version can claim', async () => {
    // Review finding: this endpoint fires seconds after OTP, BEFORE the legal
    // wall has ever been shown; a compliance gate here 403'd every brand-new
    // signup and silently lost the referral. The gate was removed on purpose;
    // this test pins that checkCompliance is never even consulted.
    mockHappyPath({ job_id: 'job-1', channel: 'copy_link', referrer_worker_id: 'referrer-1' });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ claimed: true });
    expect(mockCheckCompliance).not.toHaveBeenCalled();
  });

  it('returns 409 user_not_provisioned when no users row exists for the sub', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (typeof q === 'string' && q.includes('SELECT id, user_type FROM users')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'user_not_provisioned' });
  });

  it('returns 403 worker_only when the caller is an employer', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'employer-id', user_type: 'employer' }] });
      return Promise.resolve({});
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'worker_only' });
  });

  it('happy path: setRlsContext is called with the caller sub before the attribution write, returns { claimed: true }', async () => {
    mockHappyPath({ job_id: 'job-1', channel: 'whatsapp', referrer_worker_id: 'referrer-1' });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ claimed: true });

    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'w-sub');

    // Jest's invocationCallOrder is a single global counter shared across all
    // mocks, so comparing setRlsContext's order against the INSERT's order
    // directly proves the RLS context was set before the attribution write.
    const rlsCallOrder = mockSetRlsContext.mock.invocationCallOrder[0];
    const insertCallIndex = mockQuery.mock.calls.findIndex(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO worker_attribution'),
    );
    expect(insertCallIndex).toBeGreaterThanOrEqual(0);
    const insertCallOrder = mockQuery.mock.invocationCallOrder[insertCallIndex];
    expect(rlsCallOrder).toBeLessThan(insertCallOrder);
  });

  it('returns { claimed: false } with a 200 status for an unknown share code -- not an error', async () => {
    mockHappyPath(null);
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ claimed: false });
  });

  it('never logs the share code in any log line', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockHappyPath({ job_id: 'job-1', channel: 'facebook', referrer_worker_id: 'referrer-1' });
    await handler(makeEvent({ body: JSON.stringify({ shareCode: 'ABCDEFGH' }) }));

    const allLoggedText = [...consoleErrorSpy.mock.calls, ...consoleLogSpy.mock.calls]
      .flat()
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n');
    expect(allLoggedText).not.toContain('ABCDEFGH');

    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('never logs the share code even when the write is silently filtered (rowCount 0)', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockQuery.mockImplementation((q: string) => {
      if (typeof q !== 'string') return Promise.resolve({});
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id', user_type: 'worker' }] });
      if (q.includes('FROM job_share_links')) {
        return Promise.resolve({ rows: [{ job_id: 'job-1', channel: 'sms', referrer_worker_id: 'referrer-1' }] });
      }
      if (q.includes('INSERT INTO worker_attribution')) return Promise.resolve({ rowCount: 0 });
      return Promise.resolve({});
    });

    const res = await handler(makeEvent({ body: JSON.stringify({ shareCode: 'ZYXWVTS9' }) }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ claimed: false });

    const loggedText = consoleErrorSpy.mock.calls
      .flat()
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n');
    expect(loggedText).not.toContain('ZYXWVTS9');
    expect(loggedText).toContain('WebAttributionNotPersisted');

    consoleErrorSpy.mockRestore();
  });
});
