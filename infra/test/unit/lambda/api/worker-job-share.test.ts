import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-job-share';
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
    pathParameters: { jobId: 'job-1' },
    body: JSON.stringify({ channel: 'whatsapp' }),
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

describe('worker-job-share', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0', PUBLIC_SITE_BASE_URL: 'https://jale.app' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  function mockHappyPath(code = 'ABCDEFGH') {
    mockQuery.mockImplementation((q: string) => {
      if (typeof q !== 'string') return Promise.resolve({});
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id', user_type: 'worker' }] });
      if (q.includes('SELECT id, public_code FROM jobs')) {
        return Promise.resolve({ rows: [{ id: 'job-1', public_code: 'JOBCOD' }] });
      }
      if (q.includes('INSERT INTO job_share_links')) {
        return Promise.resolve({ rows: [{ code }] });
      }
      return Promise.resolve({});
    });
  }

  it('returns 401 when unauthenticated', async () => {
    const res = await handler(makeEvent({ requestContext: {} as any }));
    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid channel', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ channel: 'email' }) }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects "unknown" as a channel -- server-assigned only', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ channel: 'unknown' }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_channel' });
  });

  it('returns 500 share_url_misconfigured when PUBLIC_SITE_BASE_URL is unset, without minting a row', async () => {
    delete (process.env as any).PUBLIC_SITE_BASE_URL;
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'share_url_misconfigured' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 500 share_url_misconfigured when PUBLIC_SITE_BASE_URL is a relative/invalid value', async () => {
    process.env.PUBLIC_SITE_BASE_URL = '/not-a-host';
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'share_url_misconfigured' });
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

  it('returns 404 for a paused/filled job without leaking which condition failed', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id', user_type: 'worker' }] });
      if (q.includes('SELECT id, public_code FROM jobs')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'job_not_found' });
  });

  it('returns 404 for a job with public_listing_enabled = false, same generic body', async () => {
    // The job lookup uses one combined predicate covering both status and
    // public_listing_enabled, so this exercises the identical branch/response
    // as the paused/filled case above -- proving no distinguishing signal leaks.
    const calls: string[] = [];
    mockQuery.mockImplementation((q: string) => {
      calls.push(typeof q === 'string' ? q : '');
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id', user_type: 'worker' }] });
      if (q.includes('SELECT id, public_code FROM jobs')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'job_not_found' });
    const jobQuery = calls.find((c) => c.includes('SELECT id, public_code FROM jobs')) as string;
    expect(jobQuery).toContain("status = 'active'");
    expect(jobQuery).toContain('public_listing_enabled = true');
  });

  it('is idempotent: two identical requests return the same code via ON CONFLICT DO UPDATE', async () => {
    const calls: string[] = [];
    mockQuery.mockImplementation((q: string) => {
      calls.push(typeof q === 'string' ? q : '');
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id', user_type: 'worker' }] });
      if (q.includes('SELECT id, public_code FROM jobs')) return Promise.resolve({ rows: [{ id: 'job-1', public_code: 'JOBCOD' }] });
      if (q.includes('INSERT INTO job_share_links')) return Promise.resolve({ rows: [{ code: 'SHARE001' }] });
      return Promise.resolve({});
    });

    const res1 = await handler(makeEvent());
    const res2 = await handler(makeEvent());

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    const code1 = JSON.parse(res1.body).code;
    const code2 = JSON.parse(res2.body).code;
    expect(code1).toBe(code2);

    const insertQuery = calls.find((c) => c.includes('INSERT INTO job_share_links')) as string;
    expect(insertQuery).toContain('ON CONFLICT (job_id, referrer_worker_id, channel)');
    expect(insertQuery).toContain('WHERE referrer_worker_id IS NOT NULL');
    expect(insertQuery).toContain('DO UPDATE SET updated_at = now()');
  });

  it('returns a share URL with the job code in the path and the share code in the query', async () => {
    mockHappyPath('SHARECOD');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.share_url).toBe('https://jale.app/j/JOBCOD?r=SHARECOD');
  });
});
