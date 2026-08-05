import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-job-share';
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
    requestContext: { authorizer: { claims: { sub: 'e-sub' } } },
    pathParameters: { jobId: 'job-1' },
    body: JSON.stringify({ channel: 'copy_link' }),
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

describe('employer-job-share', () => {
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
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'employer-id', user_type: 'employer' }] });
      if (q.includes('SELECT j.id, j.public_code FROM jobs')) {
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

  it('returns 400 missing_job_id when jobId is absent', async () => {
    const res = await handler(makeEvent({ pathParameters: {} }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'missing_job_id' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_json for a malformed body', async () => {
    const res = await handler(makeEvent({ body: '{not json' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 for an invalid channel', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ channel: 'email' }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_channel' });
  });

  it('rejects "unknown" as a channel -- server-assigned only', async () => {
    const res = await handler(makeEvent({ body: JSON.stringify({ channel: 'unknown' }) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_channel' });
  });

  it('defaults the channel to copy_link when the body omits it -- the frontend always sends it explicitly, but the endpoint does not require it', async () => {
    mockHappyPath('DEFAULTCH');
    const res = await handler(makeEvent({ body: JSON.stringify({}) }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).channel).toBe('copy_link');
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

  it('returns 403 employer_only when the caller is a worker', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id', user_type: 'worker' }] });
      return Promise.resolve({});
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'employer_only' });
  });

  it('returns 409 user_not_provisioned when no users row exists for the sub', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'user_not_provisioned' });
  });

  it('returns 403 legal_required when the employer has not accepted the current ToS', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true, currentVersion: 'v0.9' });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'legal_required',
      requiredVersion: 'v1.0',
      currentVersion: 'v0.9',
    });
    expect(mockGetDbPool).toHaveBeenCalled();
  });

  it('returns 404 for a job owned by a different employer, same generic body as every other combined-predicate failure', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'employer-id', user_type: 'employer' }] });
      if (q.includes('SELECT j.id, j.public_code FROM jobs')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'job_not_found' });
  });

  it('returns 404 for a paused/filled/closed job, identical body to the wrong-owner case', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'employer-id', user_type: 'employer' }] });
      if (q.includes('SELECT j.id, j.public_code FROM jobs')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'job_not_found' });
  });

  it('returns 404 for a job with public_listing_enabled = false, identical body, and the ownership query is the single combined predicate', async () => {
    const calls: string[] = [];
    mockQuery.mockImplementation((q: string) => {
      calls.push(typeof q === 'string' ? q : '');
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'employer-id', user_type: 'employer' }] });
      if (q.includes('SELECT j.id, j.public_code FROM jobs')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'job_not_found' });
    const jobQuery = calls.find((c) => c.includes('SELECT j.id, j.public_code FROM jobs')) as string;
    expect(jobQuery).toContain('JOIN users u ON u.id = j.employer_id');
    expect(jobQuery).toContain('u.cognito_sub = $2');
    expect(jobQuery).toContain("status = 'active'");
    expect(jobQuery).toContain('public_listing_enabled = true');
  });

  it('is idempotent: two identical requests return the same code via ON CONFLICT DO UPDATE, with the employer arbiter', async () => {
    const calls: string[] = [];
    mockQuery.mockImplementation((q: string) => {
      calls.push(typeof q === 'string' ? q : '');
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'employer-id', user_type: 'employer' }] });
      if (q.includes('SELECT j.id, j.public_code FROM jobs')) return Promise.resolve({ rows: [{ id: 'job-1', public_code: 'JOBCOD' }] });
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
    expect(insertQuery).toContain('referrer_employer_id');
    expect(insertQuery).not.toContain('referrer_worker_id');
    expect(insertQuery).toContain('ON CONFLICT (job_id, referrer_employer_id, channel)');
    expect(insertQuery).toContain('WHERE referrer_employer_id IS NOT NULL');
    expect(insertQuery).toContain('DO UPDATE SET updated_at = now()');
  });

  it('retries on a unique_violation (23505) using a savepoint, and succeeds on the next attempt', async () => {
    let insertAttempts = 0;
    mockQuery.mockImplementation((q: string) => {
      if (typeof q !== 'string') return Promise.resolve({});
      if (q.includes('SELECT id, user_type FROM users')) return Promise.resolve({ rows: [{ id: 'employer-id', user_type: 'employer' }] });
      if (q.includes('SELECT j.id, j.public_code FROM jobs')) return Promise.resolve({ rows: [{ id: 'job-1', public_code: 'JOBCOD' }] });
      if (q === 'SAVEPOINT share_code_attempt') return Promise.resolve({});
      if (q === 'ROLLBACK TO SAVEPOINT share_code_attempt') return Promise.resolve({});
      if (q === 'RELEASE SAVEPOINT share_code_attempt') return Promise.resolve({});
      if (q.includes('INSERT INTO job_share_links')) {
        insertAttempts += 1;
        if (insertAttempts === 1) {
          const err: any = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          return Promise.reject(err);
        }
        return Promise.resolve({ rows: [{ code: 'RETRYCOD' }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe('RETRYCOD');
    expect(insertAttempts).toBe(2);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT share_code_attempt');
  });

  it('returns a share URL with the job code in the path and the share code in the query', async () => {
    mockHappyPath('SHARECOD');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.share_url).toBe('https://jale.app/j/JOBCOD?r=SHARECOD');
    expect(body).toEqual({ code: 'SHARECOD', channel: 'copy_link', share_url: 'https://jale.app/j/JOBCOD?r=SHARECOD' });
  });
});
