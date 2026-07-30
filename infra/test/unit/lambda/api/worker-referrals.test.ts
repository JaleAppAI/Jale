import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-referrals';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const ev = {
  requestContext: { authorizer: { claims: { sub: 'w-sub' } } },
} as unknown as APIGatewayProxyEvent;

describe('worker-referrals', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0', PUBLIC_SITE_BASE_URL: 'https://jale.app' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('returns 401 when unauthenticated', async () => {
    const res = await handler({ requestContext: {} } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 500 share_url_misconfigured when PUBLIC_SITE_BASE_URL is unset, never emitting a relative URL', async () => {
    delete (process.env as any).PUBLIC_SITE_BASE_URL;
    const res = await handler(ev);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'share_url_misconfigured' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('flags truncated:true when the row count hits the list cap', async () => {
    const manyRows = Array.from({ length: 201 }, (_, i) => ({
      job_id: `job-${i}`,
      channel: 'whatsapp',
      code: `CODE${i}`,
      open_count: 0,
      last_opened_at: null,
      created_at: 'ts0',
      job_public_code: 'JOBCOD',
      job_title: 'Some Job',
    }));
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM job_share_links')) return Promise.resolve({ rows: manyRows });
      return Promise.resolve({});
    });
    const res = await handler(ev);
    const body = JSON.parse(res.body);
    expect(body.truncated).toBe(true);
    expect(body.referrals).toHaveLength(200);
  });

  it('flags truncated:false when under the cap', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM job_share_links')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(ev);
    const body = JSON.parse(res.body);
    expect(body.truncated).toBe(false);
    expect(body.referrals).toHaveLength(0);
  });

  it('returns the caller\'s share links with job info, joined via LEFT JOIN', async () => {
    const calls: string[] = [];
    mockQuery.mockImplementation((q: string) => {
      calls.push(typeof q === 'string' ? q : '');
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM job_share_links')) {
        return Promise.resolve({
          rows: [
            {
              job_id: 'job-1',
              channel: 'whatsapp',
              code: 'SHARECOD',
              open_count: 3,
              last_opened_at: 'ts',
              created_at: 'ts0',
              job_public_code: 'JOBCOD',
              job_title: 'Warehouse Associate',
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    const res = await handler(ev);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.referrals).toHaveLength(1);
    expect(body.referrals[0]).toMatchObject({
      job_id: 'job-1',
      job_public_code: 'JOBCOD',
      job_title: 'Warehouse Associate',
      channel: 'whatsapp',
      open_count: 3,
      last_opened_at: 'ts',
      created_at: 'ts0',
      share_url: 'https://jale.app/j/JOBCOD?r=SHARECOD',
    });

    const listQuery = calls.find((c) => c.includes('FROM job_share_links')) as string;
    expect(listQuery).toContain('LEFT JOIN jobs');
    expect(listQuery).toContain('l.referrer_worker_id = $1');

    // Does not compute/return a per-link signup count from worker_attribution
    // -- that table's RLS only exposes the caller's own row, so a cross-worker
    // count would be silently wrong (always zero).
    expect(calls.some((c) => c.includes('worker_attribution'))).toBe(false);
    expect(body.referrals[0]).not.toHaveProperty('signup_count');
  });

  it('shows history for a job that is no longer active without dropping the row', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM job_share_links')) {
        return Promise.resolve({
          rows: [
            {
              job_id: 'job-2',
              channel: 'sms',
              code: 'OLDCODE1',
              open_count: 0,
              last_opened_at: null,
              created_at: 'ts0',
              // RLS on jobs filtered the joined row out (job no longer active).
              job_public_code: null,
              job_title: null,
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    const res = await handler(ev);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.referrals[0].job_public_code).toBeNull();
    expect(body.referrals[0].job_title).toBeNull();
    expect(body.referrals[0].share_url).toBeNull();
  });
});
